const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Outbox } = require('../transport');

class AckBridge {
    constructor() { this.messages = []; }
    async connect() {}
    async hasMarker(threadId, marker) { return this.messages.some(item => item.marker === marker); }
    async sendMessage(threadId, prompt) { this.messages.push({ threadId, marker: prompt.split('\n')[0] }); }
    async waitForMarker() { return true; }
    close() {}
}

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-ack-retry-'));
    const file = path.join(dir, 'outbox.json');
    const bridge = new AckBridge();
    const first = new Outbox(file, bridge, { log: () => {} });
    first.onAck = async () => { throw new Error('handoff write failed'); };
    const entry = await first.enqueue('thread', 'handoff', {
        kind: 'handoff', meta: { handoffIds: ['req-1'] }
    });
    assert.equal(first.entries[entry.id].status, 'acked');
    assert.equal(first.entries[entry.id].meta.handoffAcked, undefined);
    assert.equal(bridge.messages.length, 1);

    let acked = 0;
    const second = new Outbox(file, bridge, { log: () => {} });
    second.onAck = async item => { acked += item.meta.handoffIds.length; };
    await second.load();
    await second.retryAcks();
    assert.equal(acked, 1);
    assert.equal(second.entries[entry.id].meta.handoffAcked, true);

    const again = await second.enqueue('thread', 'handoff duplicate', {
        kind: 'handoff', meta: { handoffIds: ['req-1'] }
    });
    assert.equal(again.id, entry.id);
    assert.equal(bridge.messages.length, 1, 'same handoff request must not be sent twice');

    first.stop();
    second.stop();
    await fs.rm(dir, { recursive: true, force: true });
    console.log('outbox ack retry smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
