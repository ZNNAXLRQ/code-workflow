const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HostBridge, Outbox } = require('../transport');
const { readTurns } = require('../codex-session');

const threadId = process.argv[2] || '01a1f581-7b0b-7bb1-9b5a-37116598ebce';
const file = path.join(os.tmpdir(), 'local-workflow-outbox-smoke.json');

(async () => {
    await fs.rm(file, { force: true });
    const bridge = new HostBridge({
        log: message => console.log(message),
        readTurns: threadId => readTurns({ cwd: process.cwd(), threadId, limit: 10 })
    });
    await bridge.connect();
    console.log('PIPE', bridge.pipePath, 'TOOLS', bridge.tools?.length);

    const outbox = new Outbox(file, bridge, { log: message => console.log(message), graceMs: 5000, checkTimeoutMs: 20000 });
    const entry = await outbox.enqueue(threadId, 'Transport smoke ' + new Date().toISOString() + '. Reply with exactly: ok.');
    console.log('ENQUEUED', entry.id, entry.marker);
    await outbox.flush();
    const visible = await bridge.hasMarker(threadId, entry.marker);
    console.log('AFTER_FLUSH', JSON.stringify({ visible, status: outbox.entries[entry.id]?.status, attempts: outbox.entries[entry.id]?.attempts }));

    const reload = new Outbox(file, bridge, { log: message => console.log(message), graceMs: 5000, checkTimeoutMs: 20000 });
    await reload.load();
    console.log('RELOAD_PENDING', reload.pending().length, 'STATUS', reload.entries[entry.id]?.status);
    await reload.flush();
    console.log('RELOAD_AFTER_FLUSH', reload.entries[entry.id]?.status);

    // Simulate a crash after sending but before ack: write a sent entry and let a new outbox recover it.
    const crashMarker = '[wf:crash-' + Date.now() + ']';
    const crashEntry = {
        id: 'crash-' + Date.now(),
        kind: 'message',
        threadId,
        marker: crashMarker,
        prompt: crashMarker + '\nCrash recovery smoke. Reply with exactly: ok.',
        status: 'pending',
        createdAt: new Date().toISOString(),
        sentAt: null,
        ackedAt: null,
        attempts: 0
    };
    const reloaded = new Outbox(file, bridge, { log: message => console.log(message), graceMs: 5000, checkTimeoutMs: 20000 });
    await reloaded.load();
    reloaded.entries[crashEntry.id] = crashEntry;
    await reloaded.save();
    await bridge.sendMessage(threadId, crashEntry.prompt);
    crashEntry.status = 'sent';
    crashEntry.sentAt = new Date().toISOString();
    crashEntry.attempts = 1;
    await reloaded.save();
    const afterCrash = new Outbox(file, bridge, { log: message => console.log(message), graceMs: 60000, checkTimeoutMs: 20000 });
    await afterCrash.load();
    await afterCrash.flush();
    console.log('CRASH_RECOVERY', JSON.stringify({ status: afterCrash.entries[crashEntry.id]?.status, attempts: afterCrash.entries[crashEntry.id]?.attempts }));

    bridge.close();
    outbox.stop();
    reload.stop();
    reloaded.stop();
    afterCrash.stop();
})().catch(error => { console.error('FAILED', error.message); process.exitCode = 1; });
