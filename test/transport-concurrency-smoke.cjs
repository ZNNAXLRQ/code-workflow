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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'outbox-concurrency-'));
    const file = path.join(dir, 'outbox.json');
    const bridge = new FakeBridge();
    const outbox = new Outbox(file, bridge, { graceMs: 0, checkTimeoutMs: 1000, log: () => {} });
    await Promise.all(Array.from({ length: 12 }, (_, index) =>
        outbox.enqueue('thread-smoke', 'concurrent message ' + index)));
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const entries = Object.values(raw.entries);
    assert.equal(entries.length, 12, 'all concurrent enqueues must persist');
    assert.equal(bridge.messages.length, 12, 'all concurrent entries must be sent');
    assert.equal(entries.every(entry => entry.status === 'acked'), true, 'all entries should be acked');
    assert.equal(new Set(entries.map(entry => entry.id)).size, 12);
    outbox.stop();
    await fs.rm(dir, { recursive: true, force: true });
    console.log('transport concurrency smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
