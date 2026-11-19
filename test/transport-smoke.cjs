const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Outbox } = require('../transport');

class FakeBridge {
    constructor() { this.messages = []; }
    async connect() {}
    async hasMarker(threadId, marker) { return this.messages.some(item => item.marker === marker); }
    async sendMessage(threadId, prompt) {
        const marker = prompt.split('\n')[0];
        this.messages.push({ threadId, marker, prompt });
    }
    async waitForMarker(threadId, marker) { return this.messages.some(item => item.marker === marker); }
    close() {}
}

(async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-smoke-'));
    const file = path.join(dir, 'outbox.json');
    const bridge = new FakeBridge();
    const outbox = new Outbox(file, bridge, { graceMs: 1000, checkTimeoutMs: 1000, log: () => {} });

    const entry = await outbox.enqueue('thread-smoke', 'Transport smoke ' + Date.now() + '.');
    assert.equal(entry.status, 'pending');
    assert.equal(await bridge.hasMarker('thread-smoke', entry.marker), true);
    assert.equal(outbox.entries[entry.id].status, 'acked');
    assert.equal(bridge.messages.length, 1);
    console.log('ENQUEUED_AND_ACKED', entry.id);

    const reload = new Outbox(file, bridge, { graceMs: 1000, checkTimeoutMs: 1000, log: () => {} });
    await reload.load();
    assert.equal(reload.pending().length, 0);
    assert.equal(reload.entries[entry.id].status, 'acked');
    console.log('RELOAD_ACKED', reload.entries[entry.id].status);

    const crashMarker = '[wf:crash-' + Date.now() + ']';
    const crashEntry = {
        id: 'crash-' + Date.now(), kind: 'message', threadId: 'thread-smoke',
        marker: crashMarker, prompt: crashMarker + '\nCrash recovery smoke.',
        status: 'sent', createdAt: new Date().toISOString(), sentAt: new Date().toISOString(),
        ackedAt: null, attempts: 1
    };
    await bridge.sendMessage('thread-smoke', crashEntry.prompt);
    const crashed = new Outbox(file, bridge, { graceMs: 60000, checkTimeoutMs: 1000, log: () => {} });
    await crashed.load();
    crashed.entries[crashEntry.id] = crashEntry;
    await crashed.save();
    await crashed.flush();
    assert.equal(crashed.entries[crashEntry.id].status, 'acked');
    console.log('CRASH_RECOVERY', crashed.entries[crashEntry.id].status);

    outbox.stop();
    reload.stop();
    crashed.stop();
    await fs.rm(dir, { recursive: true, force: true });
})().catch(error => { console.error('FAILED', error); process.exitCode = 1; });
