'use strict';
/* Temporary audit harness: loads the real extension.js with a stubbed vscode,
   activates it on a temp git repo, then drives the real hub over HTTP.
   No source edits; all files under os.tmpdir(). */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');

const EXT = 'D:\\Programs\\Others\\workflow-extension';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-hub-drive-'));
const repo = path.join(root, 'repo');
const store = path.join(root, 'store');
fs.mkdirSync(repo);
const git = (...args) => {
    const r = spawnSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b.c', ...args], { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stdout;
};
git('init', '-q');
fs.writeFileSync(path.join(repo, 'base.txt'), 'base');
git('add', '.');
git('commit', '-qm', 'base');

const configValues = {
    useClinePlan: false, useClineAct: false, clineEntry: '', codexExecutable: '',
    maxParallel: '2', maxRepairs: 3, initialCommit: false
};
const vscodeStub = {
    workspace: {
        workspaceFolders: [{ uri: { scheme: 'file', fsPath: repo }, name: 'repo', index: 0 }],
        isTrusted: true,
        getWorkspaceFolder: () => vscodeStub.workspace.workspaceFolders[0],
        getConfiguration: () => ({ get: key => configValues[key], update: async () => {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidChangeConfiguration: () => ({ dispose() {} }),
        openTextDocument: async () => ({})
    },
    window: {
        createOutputChannel: () => ({ appendLine() {}, show() {} }),
        registerWebviewViewProvider: () => ({ dispose() {} }),
        onDidChangeActiveTextEditor: () => ({ dispose() {} }),
        showWarningMessage: async () => undefined,
        showInformationMessage: async () => undefined,
        showTextDocument: async () => ({}),
        setStatusBarMessage: () => {},
        activeTextEditor: undefined
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
    env: { openExternal: async () => true, clipboard: { writeText: async () => {} } },
    extensions: { getExtension: () => undefined },
    Uri: { file: p => ({ fsPath: p, scheme: 'file' }), parse: u => ({ href: u }) },
    Range: class {},
    ConfigurationTarget: { Global: 1, Workspace: 2 }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscodeStub;
    return originalLoad.call(this, request, parent, isMain);
};

function httpJson(port, token, method, pathname, body) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
            headers: { Authorization: 'Bearer ' + token,
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) } },
        res => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', c => { text += c; });
            res.on('end', () => {
                let value;
                try { value = JSON.parse(text); } catch { value = text; }
                resolve({ status: res.statusCode, value });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
    const extension = require(path.join(EXT, 'extension.js'));
    const context = { globalStorageUri: { fsPath: store }, subscriptions: [] };
    await extension.activate(context);
    const hubFile = path.join(repo, '.local-workflow', 'hub.json');
    for (let i = 0; i < 100 && !fs.existsSync(hubFile); i++) await sleep(100);
    assert.ok(fs.existsSync(hubFile), 'hub.json was not written');
    const disc = JSON.parse(fs.readFileSync(hubFile, 'utf8'));
    const call = (method, p, body) => httpJson(disc.port, disc.token, method, p, body);
    console.log('=== hub started ===');

    const validTask = () => [{ id: 'task-1', title: '做点事', requirements: '完成', criteria: ['可验证'], paths: ['a.txt'], dependsOn: [] }];

    // 1. plan A then plan B supersedes it
    let r = await call('POST', '/plan', { request: 'A', testCommand: 'node --test', stage: 'A',
        tasks: [{ id: 'task-1', title: 'A1', files: ['a.txt'], acceptance: ['a'] }] });
    const planA = r.value.result.planId;
    console.log('plan A:', r.status, 'planId', planA);
    r = await call('POST', '/plan', { request: 'B', testCommand: 'node --test', stage: 'B', tasks: [] });
    const planB = r.value.result.planId;
    console.log('plan B:', r.status, 'planId', planB, 'tasks', r.value.result.taskCount);

    // 2. stale confirm A
    r = await call('POST', '/confirm', { planId: planA });
    console.log('confirm stale A:', r.status, r.value.error?.message);

    // 3. discard without planId clears latest B
    r = await call('POST', '/discard', {});
    console.log('discard(no planId):', r.status, JSON.stringify(r.value.result));
    r = await call('POST', '/confirm', { planId: planB });
    console.log('confirm after discard:', r.status, r.value.error?.message);

    // 4. plan C, concurrent confirms
    r = await call('POST', '/plan', { request: 'C', testCommand: 'node --test', stage: 'C', tasks: [] });
    const planC = r.value.result.planId;
    const [c1, c2] = await Promise.all([
        call('POST', '/confirm', { planId: planC }),
        call('POST', '/confirm', { planId: planC })
    ]);
    console.log('concurrent confirm:', c1.status, c2.status,
        c1.value.result?.phase, c2.value.error?.message);

    // 5. plan with tasks that would fail validatePlan at confirm time
    r = await call('POST', '/plan', { request: 'D', testCommand: 'node --test', stage: 'D',
        tasks: [{ title: '无验收标准' }] });
    const planD = r.value.result.planId;
    console.log('plan D accepted:', r.status, 'taskCount', r.value.result.taskCount);
    r = await call('POST', '/confirm', { planId: planD });
    console.log('confirm D:', r.status, r.value.error?.message);
    r = await call('POST', '/confirm', { planId: planD });
    console.log('confirm D again:', r.status, r.value.error?.message);

    // 6. status / reviews / answer / settings
    r = await call('GET', '/status', undefined);
    console.log('status:', r.status, JSON.stringify({ frontend: r.value.result.frontend, phase: r.value.result.phase,
        selectedStage: r.value.result.selectedStage, stages: r.value.result.stages.map(s => [s.id, s.phase, s.tasks.length]) }));
    r = await call('GET', '/reviews', undefined);
    console.log('reviews:', r.status, JSON.stringify(r.value.result));
    r = await call('POST', '/answer', { taskId: 'task-1', answer: 'x' });
    console.log('answer (no stageId):', r.status, r.value.error?.message);
    r = await call('POST', '/answer', { taskId: 'task-1', stageId: 'nope', answer: 'x' });
    console.log('answer (bad stageId):', r.status, r.value.error?.message);
    r = await call('POST', '/settings', { patch: { maxParallel: '4' } });
    console.log('settings patch:', r.status, JSON.stringify(r.value.result));
    console.log('settings file:', fs.readFileSync(path.join(repo, '.local-workflow', 'settings.json'), 'utf8').replace(/\s+/g, ' '));

    // 7. accept a stage not waiting for acceptance
    const stages = (await call('GET', '/status', undefined)).value.result.stages;
    const target = stages.find(s => s.phase === '无可推进任务') || stages[0];
    r = await call('POST', '/accept', { stageId: target?.id });
    console.log('accept non-accepting stage:', r.status, r.value.error?.message);
    r = await call('POST', '/pause', { stageId: target?.id });
    console.log('pause:', r.status, JSON.stringify(r.value.result));
    r = await call('POST', '/resume', {});
    console.log('resume:', r.status, JSON.stringify(r.value.result));

    // 8. state on disk after reload
    extension.deactivate && await extension.deactivate().catch(error => console.log('deactivate error:', error.message));
    const state = JSON.parse(fs.readFileSync(path.join(repo, '.local-workflow', 'state.json'), 'utf8'));
    console.log('state phases:', state.phase, (state.parallelStages || []).map(s => [s.id, s.phase]));
    console.log('hub.json exists after deactivate:', fs.existsSync(hubFile));
    console.log('DONE');
})().catch(error => { console.error('HARNESS ERROR', error); process.exitCode = 1; })
    .finally(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} });
