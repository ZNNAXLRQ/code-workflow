const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const binding = require('../dsh-binding');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-binding-'));
const old = process.env.DSH_HOME;
process.env.DSH_HOME = root;
try {
    const id = 'session-11111111-2222-3333-4444-555555555555';
    const cache = path.join(root, 'storages', 'session_projcache', 'sessions');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, id + '.json'), JSON.stringify({
        record: { rows: {
            title: { val: '实现登录功能' },
            workingDirectory: { val: 'D:\\repo' }
        } }
    }));
    assert.equal(binding.readDshBinding(root), null);
    const created = binding.bindDsh(root, id);
    assert.equal(created.dshSessionId, id);
    assert.equal(created.title, '实现登录功能');
    assert.equal(binding.readDshBinding(root).title, '实现登录功能');
    assert.throws(() => binding.bindDsh(root, 'session-22222222-2222-3333-4444-555555555555'), /已绑定/);
    assert.equal(binding.unbindDsh(root).dshSessionId, id);
    assert.equal(binding.readDshBinding(root), null);
    console.log('dsh binding smoke passed');
} finally {
    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
}
