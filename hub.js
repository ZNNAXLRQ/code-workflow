const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BODY_BYTES = 1024 * 1024;

const ROUTES = {
    '/plan': { method: 'POST', handler: 'plan' },
    '/confirm': { method: 'POST', handler: 'confirm' },
    '/discard': { method: 'POST', handler: 'discard' },
    '/review': { method: 'POST', handler: 'review' },
    '/answer': { method: 'POST', handler: 'answer' },
    '/status': { method: 'GET', handler: 'status' },
    '/reviews': { method: 'GET', handler: 'reviews' },
    '/settings': { method: 'POST', handler: 'settings' },
    '/accept': { method: 'POST', handler: 'accept' },
    '/cancel': { method: 'POST', handler: 'cancel' },
    '/pause': { method: 'POST', handler: 'pause' },
    '/resume': { method: 'POST', handler: 'resume' },
    '/steer': { method: 'POST', handler: 'steer' }
};

function discoveryPath(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'hub.json');
}

function writeDiscovery(repo, value) {
    const file = discoveryPath(repo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    return file;
}

function readDiscovery(repo) {
    const file = discoveryPath(repo);
    let value;
    try {
        value = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('工作流 hub 发现文件损坏：' + file);
    }
    if (!value || typeof value !== 'object' || !Number.isInteger(value.port) ||
        typeof value.token !== 'string' || !value.token) {
        throw new Error('工作流 hub 发现文件缺少 port/token：' + file);
    }
    return { ...value, file };
}

function removeDiscovery(repo, token) {
    const file = discoveryPath(repo);
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (token && value.token !== token) return false;
        fs.unlinkSync(file);
        return true;
    } catch (error) {
        if (error.code === 'ENOENT') return false;
        throw error;
    }
}

function readBody(request) {
    return new Promise((resolve, reject) => {
        let length = 0;
        const chunks = [];
        request.on('data', chunk => {
            length += chunk.length;
            if (length > MAX_BODY_BYTES) {
                reject(Object.assign(new Error('请求体过大'), { statusCode: 413 }));
                request.destroy();
                return;
            }
            chunks.push(chunk);
        });
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (!text) return resolve({});
            try {
                const value = JSON.parse(text);
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    reject(Object.assign(new Error('请求体必须是 JSON 对象'), { statusCode: 400 }));
                    return;
                }
                resolve(value);
            } catch {
                reject(Object.assign(new Error('请求体不是合法 JSON'), { statusCode: 400 }));
            }
        });
        request.on('error', reject);
    });
}

function send(response, status, value) {
    const body = JSON.stringify(value);
    response.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    response.end(body);
}

function createHub({ token, handlers, log = () => {}, host = '127.0.0.1' } = {}) {
    if (!token || typeof token !== 'string') throw new Error('hub 需要 token');
    if (!handlers || typeof handlers !== 'object') throw new Error('hub 需要 handlers');
    let server = null;
    let port = null;

    async function handle(request, response) {
        try {
            const address = request.socket.remoteAddress || '';
            if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
                return send(response, 403, { error: { code: 'FORBIDDEN', message: '只接受本机请求' } });
            }
            if (request.headers.authorization !== 'Bearer ' + token) {
                return send(response, 401, { error: { code: 'UNAUTHORIZED', message: 'token 不匹配' } });
            }
            const url = new URL(request.url, 'http://127.0.0.1');
            const route = ROUTES[url.pathname];
            if (!route) return send(response, 404, { error: { code: 'NOT_FOUND', message: '未知接口 ' + url.pathname } });
            if (request.method !== route.method) {
                return send(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '需要 ' + route.method } });
            }
            const payload = route.method === 'GET'
                ? Object.fromEntries(url.searchParams.entries())
                : await readBody(request);
            const handler = handlers[route.handler];
            if (typeof handler !== 'function') {
                return send(response, 501, { error: { code: 'NOT_IMPLEMENTED', message: '接口尚未接线：' + route.handler } });
            }
            const result = await handler(payload);
            return send(response, 200, { ok: true, result: result === undefined ? null : result });
        } catch (error) {
            const status = error.statusCode || 500;
            log('[hub] ' + (error.stack || error.message));
            return send(response, status, { error: { code: error.code || 'INTERNAL', message: error.message } });
        }
    }

    async function start() {
        if (server) return { port, url: 'http://' + host + ':' + port, token, close };
        server = http.createServer((request, response) => { handle(request, response); });
        server.requestTimeout = 30000;
        server.headersTimeout = 10000;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, host, () => resolve());
        });
        port = server.address().port;
        return { port, url: 'http://' + host + ':' + port, token, close };
    }

    async function close() {
        if (!server) return;
        const current = server;
        server = null;
        port = null;
        await new Promise(resolve => current.close(() => resolve()));
    }

    return { start, close, get port() { return port; } };
}

module.exports = { createHub, discoveryPath, writeDiscovery, readDiscovery, removeDiscovery, ROUTES };
