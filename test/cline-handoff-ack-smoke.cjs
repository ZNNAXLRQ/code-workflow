const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Outbox } = require('../transport');
const frontend = require('../cline-frontend');

class DelayedBridge {
    constructor() { this.messages = []; this.ack = false; }
    async connect() {}
    async hasMarker(threadId, marker) {
        return this.ack && this.messages.some(item => item.marker === marker);
    }
    async sendMessage(threadId, prompt) {
        this.messages.push({ threadId, marker: prompt.split('\n')[0] });
    }
    async waitForMarker() { return this.ack; }
    close() {}
}

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-handoff-ack-'));
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo);
    const initial = frontend.emptyHandoff({ repo, request: '同步' });
    initial.queue = [{ id: 'request-a', request: '修复 A' }];
    frontend.writeHandoff(repo, initial);
    const id = 'request-a';
    assert.equal(frontend.readHandoff(repo).queue[0].id, id);

    const bridge = new DelayedBridge();
    const file = path.join(dir, 'outbox.json');
    const outbox = new Outbox(file, bridge, { graceMs: 0, checkTimeoutMs: 1000, log: () => {} });
    outbox.onAck = async entry => {
        frontend.markHandoffRequests(repo, entry.meta?.handoffIds || []);
    };
    const receipt = await outbox.enqueue('thread', 'handoff queue', {
        kind: 'handoff', meta: { handoffIds: [id] }
    });
    assert.equal(outbox.entries[receipt.id].status, 'sent');
    assert.equal(frontend.readHandoffState(repo).requests[id], undefined);

    // Cline 在等待期间追加了一条新请求；调度器没有整份写回交接文件。
    const latest = frontend.readHandoff(repo);
    latest.queue.push({ id: 'request-b', request: '修复 B' });
    frontend.writeHandoff(repo, latest);

    bridge.ack = true;
    await outbox.flush();
    assert.equal(outbox.entries[receipt.id].status, 'acked');
    assert.equal(frontend.readHandoffState(repo).requests[id].handedOff, true);
    const queue = frontend.readHandoff(repo).queue;
    assert.deepEqual(queue.map(item => item.request), ['修复 A', '修复 B']);
    assert.equal(queue[0].id, id, 'scheduler should persist a stable request id');
    const pending = queue.filter(item => {
        const key = item.id || frontend.requestId(item.request);
        return !frontend.readHandoffState(repo).requests[key]?.handedOff;
    });
    assert.deepEqual(pending.map(item => item.request), ['修复 B']);

    outbox.stop();
    await fs.rm(dir, { recursive: true, force: true });
    console.log('cline handoff delayed ack smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
