const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHub, writeDiscovery, readDiscovery, removeDiscovery } = require('../hub');

function request(url, { method = 'GET', token, body } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        const request = http.request(url, {
            method,
            headers: {
                ...(token ? { Authorization: 'Bearer ' + token } : {}),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {})
            }
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const text = Buffer.concat(chunks).toString('utf8');
                let value;
                try { value = JSON.parse(text); } catch { value = text; }
                resolve({ status: response.statusCode, value });
            });
        });
        request.on('error', reject);
        if (payload) request.write(payload);
        request.end();
    });
}

(async () => {
    const calls = [];
    const hub = createHub({
        token: 'secret',
        handlers: {
            plan: async payload => { calls.push(['plan', payload]); return { accepted: true, repo: payload.repo }; },
            status: async payload => ({ phase: '运行中', repo: payload.repo }),
            review: async () => { throw Object.assign(new Error('冲突'), { statusCode: 409, code: 'CONFLICT' }); }
        }
    });
    const { port, url } = await hub.start();
    assert.ok(port > 0);
    console.log('hub', url);

    let result = await request(url + '/plan', { method: 'POST', token: 'secret', body: { repo: 'D:/x', tasks: [] } });
    assert.equal(result.status, 200);
    assert.equal(result.value.ok, true);
    assert.equal(result.value.result.accepted, true);
    assert.equal(calls[0][1].repo, 'D:/x');

    result = await request(url + '/status?repo=D%3A%2Fx', { token: 'secret' });
    assert.equal(result.status, 200);
    assert.equal(result.value.result.repo, 'D:/x');

    result = await request(url + '/plan', { method: 'POST', token: 'wrong', body: {} });
    assert.equal(result.status, 401);

    result = await request(url + '/nope', { token: 'secret' });
    assert.equal(result.status, 404);

    result = await request(url + '/plan', { token: 'secret' });
    assert.equal(result.status, 405);

    result = await request(url + '/plan', { method: 'POST', token: 'secret', body: '{bad' });
    assert.equal(result.status, 400);

    result = await request(url + '/review', { method: 'POST', token: 'secret', body: {} });
    assert.equal(result.status, 409);
    assert.equal(result.value.error.code, 'CONFLICT');

    await hub.close();
    await assert.rejects(request(url + '/status', { token: 'secret' }));

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-discovery-'));
    const value = { port, token: 'secret', pid: process.pid, repo };
    const file = writeDiscovery(repo, value);
    assert.ok(fs.existsSync(file));
    assert.equal(readDiscovery(repo).token, 'secret');
    assert.equal(removeDiscovery(repo, 'wrong'), false);
    assert.equal(removeDiscovery(repo, 'secret'), true);
    assert.equal(readDiscovery(repo), null);
    fs.rmSync(repo, { recursive: true, force: true });

    console.log('hub smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
