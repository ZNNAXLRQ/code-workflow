const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const bridge = require('../dsh-self-review');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-self-review-'));
    try {
        const pending = bridge.runMainReview({
            repo: root, where: root, label: 'task', data: { title: 'demo' }, timeoutMs: 5000, pollMs: 20
        });
        let request;
        for (let index = 0; index < 100 && !request; index++) {
            const files = fs.existsSync(bridge.requestsDir(root))
                ? fs.readdirSync(bridge.requestsDir(root)).filter(name => name.endsWith('.json')) : [];
            if (files.length) request = JSON.parse(fs.readFileSync(path.join(bridge.requestsDir(root), files[0]), 'utf8'));
            else await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(request && request.id, '应写出主会话自审请求');
        assert.equal(request.data.title, 'demo');
        await fsp.mkdir(bridge.resultsDir(root), { recursive: true });
        await fsp.writeFile(path.join(bridge.resultsDir(root), request.id + '.json'), JSON.stringify({
            id: request.id, verdict: 'pass', summary: '通过', findings: []
        }));
        const result = await pending;
        assert.equal(result.verdict, 'pass');
        assert.equal(result.summary, '通过');
        assert.equal(fs.readdirSync(bridge.requestsDir(root)).length, 0, '结果写入后 request 应清理');
        console.log('dsh self-review bridge smoke passed');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
