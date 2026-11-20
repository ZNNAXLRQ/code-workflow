'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveCline, runTask } = require('../cline-cli.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-cli-smoke-'));

function script(name, lines) {
    const file = path.join(root, name);
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
    return file;
}

function jsonLine(value) {
    return 'process.stdout.write(' + JSON.stringify(JSON.stringify(value)) + " + '\\n');";
}

function alive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
    }
}

const successArgs = path.join(root, 'success-args.json');
const success = script('fake-success.cjs', [
    "'use strict';",
    "const fs = require('node:fs');",
    'fs.writeFileSync(' + JSON.stringify(successArgs) + ', JSON.stringify(process.argv.slice(2)));',
    jsonLine({ type: 'task_started', taskId: 'conv_not_a_session' }),
    jsonLine({ type: 'run_result', finishReason: 'completed', text: 'done', session_id: 'sess-success' })
]);

const failed = script('fake-failed.cjs', [
    "'use strict';",
    jsonLine({ type: 'error', message: 'boom-from-error' }),
    jsonLine({ type: 'run_result', finishReason: 'error', text: 'partial answer' }),
    "process.stderr.write('stderr-tail\\n');",
    'process.exitCode = 3;'
]);

const nonzero = script('fake-nonzero.cjs', [
    "'use strict';",
    jsonLine({ type: 'run_result', finishReason: 'completed', text: 'done-but-nonzero' }),
    'process.exitCode = 2;'
]);

const question = script('fake-question.cjs', [
    "'use strict';",
    jsonLine({
        type: 'run_result',
        finishReason: 'completed',
        text: 'Submission recorded (unverified): [需要澄清] 请提供测试命令'
    })
]);

const noSession = script('fake-nosession.cjs', [
    "'use strict';",
    jsonLine({ type: 'task_started', taskId: 'conv_only_task' }),
    jsonLine({ type: 'run_result', finishReason: 'completed', text: 'done-without-session' })
]);

const unverified = script('fake-unverified.cjs', [
    "'use strict';",
    jsonLine({
        type: 'run_result',
        finishReason: 'completed',
        text: 'Submission recorded (unverified): 已提交但未验证'
    }),
    'process.exitCode = 1;'
]);

const pidFile = path.join(root, 'slow.pid');
const slow = script('fake-slow.cjs', [
    "'use strict';",
    "const fs = require('node:fs');",
    'fs.writeFileSync(' + JSON.stringify(pidFile) + ', String(process.pid));',
    jsonLine({ type: 'progress', text: 'started' }),
    'setInterval(() => {}, 1000);'
]);

function testResolve() {
    const configured = resolveCline({ clineEntry: success });
    assert.equal(configured.command, process.execPath);
    assert.deepEqual(configured.baseArgs, [success]);
    assert.deepEqual(configured.env, { ELECTRON_RUN_AS_NODE: '1' });

    const appData = path.join(root, 'appdata');
    const exe = path.join(appData, 'npm', 'node_modules', 'cline', 'node_modules', '@cline',
        'cli-windows-' + process.arch, 'bin', 'cline.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    const found = resolveCline({ platform: 'win32', appData });
    assert.equal(found.command, exe);
    assert.deepEqual(found.baseArgs, []);
    assert.deepEqual(found.env, {});

    assert.throws(
        () => resolveCline({ platform: 'win32', appData: path.join(root, 'missing-appdata') }),
        /找不到 Cline CLI/
    );
    assert.deepEqual(resolveCline({ platform: 'linux' }), { command: 'cline', baseArgs: [], env: {} });
    console.log('PASS resolveCline');
}

async function testSuccess() {
    const result = await runTask({ cwd: root, prompt: 'smoke task', clineEntry: success });
    assert.equal(result.finalText, 'done');
    assert.equal(result.exitCode, 0);
    assert.equal(result.sessionId, 'sess-success');
    assert.equal(result.question, undefined);
    assert.equal(result.events.length, 2);
    assert.deepEqual(
        JSON.parse(fs.readFileSync(successArgs, 'utf8')),
        ['--json', '--auto-approve=true', '--', 'smoke task']
    );
    console.log('PASS 成功解析与参数');
}

async function testPreparedRuntime() {
    const result = await runTask({
        cwd: root,
        prompt: 'prepared task',
        runtime: { command: process.execPath, baseArgs: [success, '--data-dir', 'private-data'], env: {} },
        extraArgs: ['--provider', 'ollama', '--model', 'local-model']
    });
    assert.equal(result.finalText, 'done');
    assert.deepEqual(JSON.parse(fs.readFileSync(successArgs, 'utf8')), [
        '--data-dir', 'private-data', '--json', '--auto-approve=true',
        '--provider', 'ollama', '--model', 'local-model',
        '--', 'prepared task'
    ]);
    console.log('PASS 复用 Cline 原生 provider/data-dir');
}

async function testFailure() {
    await assert.rejects(
        runTask({ cwd: root, prompt: 'fail', clineEntry: failed }),
        error => {
            assert.match(error.message, /Cline 运行失败（error）：/);
            assert.match(error.message, /boom-from-error/);
            assert.match(error.message, /partial answer/);
            assert.match(error.message, /stderr-tail/);
            return true;
        }
    );
    console.log('PASS 非 completed 抛错');
}

async function testNonzeroExit() {
    await assert.rejects(
        runTask({ cwd: root, prompt: 'nonzero', clineEntry: nonzero }),
        /Cline 运行失败（completed）：/
    );
    console.log('PASS 退出码非 0 抛错');
}

async function testQuestion() {
    const result = await runTask({ cwd: root, prompt: 'question', clineEntry: question });
    assert.equal(result.finalText, '[需要澄清] 请提供测试命令');
    assert.equal(result.question, '请提供测试命令');
    assert.equal(result.exitCode, 0);
    console.log('PASS [需要澄清] 返回 question');
}

async function testNoSession() {
    const result = await runTask({ cwd: root, prompt: 'no-session', clineEntry: noSession });
    assert.equal(result.sessionId, null);
    assert.equal(result.finalText, 'done-without-session');
    console.log('PASS 无明确 session_id 时不猜测');
}

async function testUnverified() {
    const result = await runTask({ cwd: root, prompt: 'unverified', clineEntry: unverified });
    assert.equal(result.exitCode, 1);
    assert.equal(result.finalText, '已提交但未验证');
    console.log('PASS Submission recorded (unverified) 例外');
}

async function testAbort() {
    const controller = new AbortController();
    let started = false;
    const task = runTask({
        cwd: root,
        prompt: 'slow',
        clineEntry: slow,
        signal: controller.signal,
        onLog(chunk) {
            if (!started && chunk.includes('started')) {
                started = true;
                controller.abort();
            }
        }
    });
    await assert.rejects(task, error => error === controller.signal.reason);
    assert.equal(started, true);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(Number.isInteger(pid) && pid > 0);
    for (let attempt = 0; attempt < 50 && alive(pid); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(alive(pid), false, 'abort 后子进程仍然存在');
    console.log('PASS abort 杀进程树');
}

(async () => {
    try {
        testResolve();
        await testSuccess();
        await testPreparedRuntime();
        await testFailure();
        await testNonzeroExit();
        await testQuestion();
        await testNoSession();
        await testUnverified();
        await testAbort();
        console.log('cline-cli-smoke: 全部通过（9 项）');
    } catch (error) {
        console.error('cline-cli-smoke: 失败');
        console.error(error);
        process.exitCode = 1;
    } finally {
        try {
            fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        } catch {
            // Best-effort cleanup of the temporary fixture directory.
        }
    }
})();
