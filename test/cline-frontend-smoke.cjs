const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const frontend = require('../cline-frontend');

(async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-frontend-'));
    assert.deepEqual(frontend.readFrontend(repo), { version: 1, mode: 'codex', clineSessionId: null, updatedAt: null });
    const clineMode = frontend.writeFrontend(repo, { mode: 'cline', clineSessionId: 'cline:1' });
    assert.equal(clineMode.mode, 'cline');
    assert.equal(frontend.readFrontend(repo).clineSessionId, 'cline:1');
    frontend.writeFrontend(repo, { mode: 'codex' });
    assert.equal(frontend.readFrontend(repo).mode, 'codex');
    assert.equal(frontend.readHandoff(repo), null);
    const empty = frontend.emptyHandoff({ repo, request: '实现登录' });
    assert.equal(empty.version, 1);
    assert.equal(empty.mode, 'cline');
    assert.equal(frontend.readHandoff(repo), null);

    const written = frontend.writeHandoff(repo, {
        ...empty,
        stage: { id: 'stage-1', title: '登录' },
        plan: '拆分登录任务',
        tasks: [
            { id: 't1', title: '登录接口', status: 'doing', paths: ['src/login.js'], notes: '' },
            { id: 't2', title: '登录测试', status: 'todo', paths: ['test/login.test.js'], notes: '依赖 t1' }
        ],
        queue: [{ id: 'q1', request: '登出' }],
        implemented: [{ taskId: 't0', files: ['src/session.js'], tests: 'passed', note: '会话' }]
    });
    assert.equal(written.updatedAt.length > 0, true);
    const read = frontend.readHandoff(repo);
    assert.equal(read.stage.id, 'stage-1');
    assert.equal(read.tasks[0].status, 'doing');
    assert.equal(read.queue[0].request, '登出');

    assert.throws(() => frontend.validateHandoff({ ...read, mode: 'codex' }), /mode/);
    assert.throws(() => frontend.validateHandoff({ ...read, tasks: [{ id: 'x', title: 'x', status: 'bad', paths: [] }] }), /状态/);
    assert.throws(() => frontend.validateHandoff({ ...read, queue: [{}] }), /request/);

    const prompt = frontend.bootstrapPrompt({ repo, request: '实现登录' });
    assert.match(prompt, /Cline 前端会话/);
    assert.match(prompt, new RegExp(frontend.handoffPath(repo).replace(/\\/g, '\\\\')));
    assert.match(prompt, /todo\/doing\/done\/blocked/);

    const digest = frontend.handoffDigest(read);
    assert.match(digest, /登录/);
    assert.match(digest, /t1/);
    assert.match(digest, /登出/);

    let changes = 0;
    const stop = frontend.watchHandoff(repo, value => { if (value) changes++; }, { intervalMs: 100 });
    await sleep(120);
    frontend.writeHandoff(repo, { ...read, plan: '更新计划' });
    await sleep(220);
    stop();
    assert.ok(changes >= 2, 'watch should see initial and updated handoff');

    fs.rmSync(repo, { recursive: true, force: true });
    console.log('cline-frontend smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
