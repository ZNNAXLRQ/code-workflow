const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const frontend = require('../dsh-frontend');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-frontend-'));
assert.deepEqual(frontend.readFrontend(repo), { version: 1, mode: 'codex', dshSessionId: '', updatedAt: null });
const dsh = frontend.writeFrontend(repo, { mode: 'dsh', dshSessionId: 'session-123' });
assert.equal(dsh.mode, 'dsh');
assert.equal(frontend.readFrontend(repo).dshSessionId, 'session-123');
frontend.writeFrontend(repo, { mode: 'codex' });
assert.equal(frontend.readFrontend(repo).mode, 'codex');

const handoff = frontend.writeHandoff(repo, {
    mode: 'dsh', dshSessionId: 'session-123', repo,
    stage: { id: 'stage-1', display: '审查中' },
    stages: [{ id: 'stage-1', request: '实现登录', phase: '运行中' }],
    pendingReviews: 1
});
assert.equal(handoff.mode, 'dsh');
assert.match(frontend.handoffDigest(handoff), /DSH 会话 ID：session-123/);
assert.equal(frontend.readHandoff(repo).stages.length, 1);
assert.throws(() => {
    fs.writeFileSync(frontend.frontendPath(repo), '{bad');
    frontend.readFrontend(repo);
}, /读取前端模式失败/);

fs.rmSync(repo, { recursive: true, force: true });
console.log('dsh-frontend smoke passed');
