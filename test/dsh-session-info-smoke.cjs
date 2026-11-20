const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const info = require('../dsh-session-info');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-info-'));
const old = process.env.DSH_HOME;
process.env.DSH_HOME = root;
try {
    const id = 'session-11111111-2222-3333-4444-555555555555';
    const dir = path.join(root, 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify({
        record: { rows: {
            title: { ver: 1, seq: 1, val: '实现登录功能' },
            workingDirectory: { ver: 1, seq: 1, val: 'D:\\repo' }
        } }
    }));
    assert.deepEqual(info.readDshSessionInfo(id), {
        id, title: '实现登录功能', workingDirectory: 'D:\\repo'
    });
    assert.equal(info.readDshSessionInfo('session-missing'), null);
    assert.equal(info.readDshSessionInfo('bad-id'), null);
    console.log('dsh session info smoke passed');
} finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
}
