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
        const marker = prompt.split('\n')[0];
        this.messages.push({ threadId, marker });
    }
    async waitForMarker() { return this.ack; }
    close() {}
}

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cline-handoff-ack-'));
    const repo = path.join(dir, 'repo');
    await fs.mkdir(repo);
    const handoff = frontend.emptyHandoff({ repo, request: '同步' });
    handoff.queue = [{ request: '修复 A' }];
    frontend.writeHandoff(repo, handoff);

    const current = frontend.readHandoff(repo);
    current.queue = current.queue.map((entry, index) => ({ ...entry, id: 'req-' + (index + 1) }));
    frontend.writeHandoff(repo, current);
    assert.equal(frontend.readHandoff(repo).queue[0].id, 'req-1');

    const bridge = new DelayedBridge();
    const file = path.join(dir, 'outbox.json');
    const outbox = new Outbox(file, bridge, { graceMs: 0, checkTimeoutMs: 1000, log: () => {} });
    outbox.onAck = async entry => {
        if (!entry.meta?.handoffIds?.length) return;
        const latest = frontend.readHandoff(repo);
        const wanted = new Set(entry.meta.handoffIds);
        latest.queue = latest.queue.map(item => wanted.has(item.id)
            ? { ...item, handedOff: true, handedOffAt: new Date().toISOString() } : item);
        frontend.writeHandoff(repo, latest);
    };
    const receipt = await outbox.enqueue('thread', 'handoff queue', {
        kind: 'handoff', meta: { handoffIds: ['req-1'] }
    });
    assert.equal(outbox.entries[receipt.id].status, 'sent');
    assert.equal(frontend.readHandoff(repo).queue[0].handedOff, undefined);

    bridge.ack = true;
    await outbox.flush();
    assert.equal(outbox.entries[receipt.id].status, 'acked');
    const afterAck = frontend.readHandoff(repo);
    assert.equal(afterAck.queue[0].handedOff, true);
    assert.equal(afterAck.queue.filter(item => !item.handedOff).length, 0);

    outbox.stop();
    await fs.rm(dir, { recursive: true, force: true });
    console.log('cline handoff delayed ack smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
