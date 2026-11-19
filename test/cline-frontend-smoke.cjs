const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const frontend = require('../cline-frontend');

(async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-frontend-'));
    const stableId = frontend.requestId('同一条请求');
    assert.equal(frontend.requestId('同一条请求'), stableId);
    assert.notEqual(frontend.requestId('另一条请求'), stableId);
    assert.deepEqual(frontend.readHandoffState(repo), { version: 1, assignments: {}, requests: {} });
    assert.equal(frontend.markHandoffRequests(repo, [stableId]), true);
    assert.equal(frontend.readHandoffState(repo).requests[stableId].handedOff, true);
    assert.equal(frontend.markHandoffRequests(repo, [stableId]), false);
    const duplicate = frontend.emptyHandoff({ repo, request: '重复' });
    duplicate.queue = [
        { id: 'request-a', request: '跑一下项目测试' },
        { id: 'request-b', request: '跑一下项目测试' }
    ];
    frontend.writeHandoff(repo, duplicate);
    const resolved = frontend.resolveHandoffQueue(repo, frontend.readHandoff(repo));
    assert.deepEqual(resolved.queue.map(entry => entry.id), ['request-a', 'request-b']);
    frontend.markHandoffRequests(repo, ['request-a']);
    const latest = frontend.readHandoff(repo);
    frontend.writeHandoff(repo, { ...latest, queue: [latest.queue[1]] });
    const resolvedAgain = frontend.resolveHandoffQueue(repo, frontend.readHandoff(repo));
    assert.equal(resolvedAgain.queue.length, 1);
    assert.equal(resolvedAgain.queue[0].id, 'request-b');
    assert.equal(resolvedAgain.queue[0].handedOff, false);
    assert.throws(() => frontend.resolveHandoffQueue(repo, {
        queue: [{ request: '没有 id 的请求' }]
    }), /唯一 id/);

    const legacyText = '旧版已交接';
    const legacyId = frontend.requestId(legacyText);
    frontend.writeHandoffState(repo, {
        version: 1, assignments: {},
        requests: { [legacyId]: { id: legacyId, handedOff: true, handedOffAt: new Date().toISOString() } }
    });
    const legacy = frontend.emptyHandoff({ repo, request: legacyText });
    legacy.queue = [{ request: legacyText }];
    frontend.writeHandoff(repo, legacy);
    const migrated = frontend.resolveHandoffQueue(repo, frontend.readHandoff(repo));
    assert.equal(migrated.queue[0].id, legacyId);
    assert.equal(migrated.queue[0].handedOff, true);

    frontend.writeHandoffState(repo, { version: 1, assignments: {}, requests: {} });
    const outboxOnlyText = '仅旧发件箱';
    const outboxOnlyId = frontend.requestId(outboxOnlyText);
    const outboxOnly = frontend.emptyHandoff({ repo, request: outboxOnlyText });
    outboxOnly.queue = [{ request: outboxOnlyText }];
    frontend.writeHandoff(repo, outboxOnly);
    const migratedOutbox = frontend.resolveHandoffQueue(repo, frontend.readHandoff(repo), {
        knownIds: new Set([outboxOnlyId])
    });
    assert.equal(migratedOutbox.queue[0].id, outboxOnlyId);
    assert.deepEqual(frontend.readFrontend(repo), { version: 1, mode: 'codex', clineSessionId: null, updatedAt: null });
    const clineMode = frontend.writeFrontend(repo, { mode: 'cline', clineSessionId: 'cline:1' });
    assert.equal(clineMode.mode, 'cline');
    assert.equal(frontend.readFrontend(repo).clineSessionId, 'cline:1');
    frontend.writeFrontend(repo, { mode: 'codex' });
    assert.equal(frontend.readFrontend(repo).mode, 'codex');
    assert.equal(frontend.readHandoff(repo).queue.length, 1);
    const empty = frontend.emptyHandoff({ repo, request: '实现登录' });
    assert.equal(empty.version, 1);
    assert.equal(empty.mode, 'cline');

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
