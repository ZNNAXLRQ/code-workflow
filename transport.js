const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

function encodeFrame(value) {
    const payload = Buffer.from(JSON.stringify(value), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32LE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

function listHostPipes() {
    try {
        return fsSync.readdirSync('\\\\.\\pipe\\')
            .filter(name => name.startsWith('codex-app-tools-'))
            .map(name => '\\\\.\\pipe\\' + name);
    } catch {
        return [];
    }
}

class HostBridge {
    constructor({ log = () => {}, readTurns = null } = {}) {
        this.log = log;
        this.readTurns = readTurns;
        this.socket = null;
        this.pipePath = null;
        this.buffer = Buffer.alloc(0);
        this.nextId = 1;
        this.pending = new Map();
        this.tools = null;
    }

    async connect() {
        if (this.socket && !this.socket.destroyed) return this;
        const pipes = listHostPipes();
        if (!pipes.length) throw new Error('Codex 桌面端没有提供 app-tools 管道');
        let lastError;
        for (const pipePath of pipes) {
            try {
                await this.open(pipePath);
                return this;
            } catch (error) {
                lastError = error;
                this.close();
            }
        }
        throw lastError || new Error('Codex 宿主管道连接失败');
    }

    open(pipePath) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection(pipePath);
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error('连接 Codex 宿主管道超时'));
            }, 4000);
            socket.once('error', error => { clearTimeout(timer); reject(error); });
            socket.once('connect', async () => {
                clearTimeout(timer);
                this.socket = socket;
                this.pipePath = pipePath;
                this.buffer = Buffer.alloc(0);
                socket.on('data', chunk => this.onData(chunk));
                socket.on('error', error => this.fail(error));
                socket.on('close', () => this.fail(new Error('Codex 宿主管道已关闭')));
                try {
                    const result = await this.request('tools/list', { threadStartKind: 'all' }, 8000);
                    this.tools = result.tools || [];
                    if (!this.tools.some(tool => tool.name === 'send_message_to_thread')) {
                        throw new Error('Codex 宿主管道没有 send_message_to_thread');
                    }
                    resolve();
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    onData(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32LE(0);
            if (length > MAX_FRAME_BYTES) {
                this.fail(new Error('Codex 宿主管道响应过大'));
                return;
            }
            if (this.buffer.length < 4 + length) return;
            const text = this.buffer.subarray(4, 4 + length).toString('utf8');
            this.buffer = this.buffer.subarray(4 + length);
            let frame;
            try { frame = JSON.parse(text); } catch { continue; }
            const entry = this.pending.get(frame.id);
            if (!entry) continue;
            this.pending.delete(frame.id);
            clearTimeout(entry.timer);
            if (frame.error) entry.reject(new Error(frame.error.message));
            else entry.resolve(frame.result);
        }
    }

    request(method, params = {}, timeoutMs = 30000) {
        if (!this.socket || this.socket.destroyed) return Promise.reject(new Error('Codex 宿主管道未连接'));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('Codex 宿主请求超时：' + method));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket.write(encodeFrame({ id, jsonrpc: '2.0', method, params }));
        });
    }

    async callTool(name, args, threadId, timeoutMs = 60000) {
        await this.connect();
        const tool = this.tools.find(item => item.name === name);
        if (!tool) throw new Error('Codex 宿主没有工具：' + name);
        return this.request('tools/call', {
            arguments: args,
            callerSource: 'codex',
            callId: 'wf-' + randomUUID(),
            namespace: tool.namespace || 'codex_app',
            threadId,
            tool: name,
            turnId: 'wf-turn-' + randomUUID()
        }, timeoutMs);
    }

    async sendMessage(threadId, prompt) {
        return this.callTool('send_message_to_thread', { threadId, prompt }, threadId, 60000);
    }

    async readThread(threadId) {
        if (!this.readTurns) throw new Error('没有配置 Codex 线程读取器');
        return this.readTurns(threadId);
    }

    async hasMarker(threadId, marker) {
        const result = await this.readThread(threadId);
        return JSON.stringify(result).includes(marker);
    }

    async waitForMarker(threadId, marker, timeoutMs = 20000) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (await this.hasMarker(threadId, marker)) return true;
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return false;
    }

    fail(error) {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
        for (const entry of this.pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(error);
        }
        this.pending.clear();
        this.tools = null;
    }

    close() {
        if (this.socket) this.socket.destroy();
        this.socket = null;
        this.tools = null;
    }
}

class Outbox {
    constructor(file, bridge, { log = () => {}, graceMs = 120000, checkTimeoutMs = 20000, intervalMs = 30000 } = {}) {
        this.file = file;
        this.bridge = bridge;
        this.log = log;
        this.graceMs = graceMs;
        this.checkTimeoutMs = checkTimeoutMs;
        this.intervalMs = intervalMs;
        this.entries = {};
        this.flushing = false;
        this.again = false;
        this.timer = null;
        this.lock = Promise.resolve();
    }

    async withLock(operation) {
        const previous = this.lock;
        let release;
        this.lock = new Promise(resolve => { release = resolve; });
        await previous;
        try {
            return await operation();
        } finally {
            release();
        }
    }

    async load() {
        try {
            const text = (await fs.readFile(this.file, 'utf8')).replace(/^\uFEFF/, '');
            const parsed = JSON.parse(text);
            const entries = parsed && typeof parsed === 'object' && parsed.entries &&
                typeof parsed.entries === 'object' ? parsed.entries : {};
            this.entries = entries;
        } catch (error) {
            if (error.code !== 'ENOENT') this.log('[outbox] 读取失败：' + error.message);
            this.entries = {};
        }
        return this;
    }

    async save() {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        await fs.writeFile(temporary, JSON.stringify({ entries: this.entries }, null, 2));
        await fs.rename(temporary, this.file);
    }

    pending() {
        return Object.values(this.entries).filter(entry => entry.status !== 'acked');
    }

    async enqueue(threadId, text, { marker, kind = 'message' } = {}) {
        const id = randomUUID();
        marker = marker || `[wf:${id}]`;
        const entry = {
            id, kind, threadId, marker,
            prompt: marker + '\n' + text,
            status: 'pending',
            createdAt: new Date().toISOString(),
            sentAt: null,
            ackedAt: null,
            attempts: 0
        };
        await this.withLock(async () => {
            await this.load();
            this.entries[id] = entry;
            await this.save();
        });
        try {
            await this.flush();
        } catch (error) {
            this.log('[outbox] 发送失败：' + error.message);
        }
        return entry;
    }

    async flush() {
        if (this.flushing) {
            this.again = true;
            return;
        }
        this.flushing = true;
        try {
            await this.withLock(async () => {
                await this.load();
                const entries = this.pending().sort((left, right) => left.createdAt.localeCompare(right.createdAt));
                if (!entries.length) return;
                for (const entry of entries) {
                    if (entry.status === 'acked') continue;
                    let found;
                    try {
                        found = await this.bridge.hasMarker(entry.threadId, entry.marker);
                    } catch (error) {
                        this.log('[outbox] 检查目标会话失败，保留待发送：' + error.message);
                        return;
                    }
                    if (found) {
                        entry.status = 'acked';
                        entry.ackedAt = new Date().toISOString();
                        await this.save();
                        continue;
                    }
                    const due = entry.status === 'pending' ||
                        (entry.status === 'sent' && Date.now() - Date.parse(entry.sentAt || 0) > this.graceMs);
                    if (!due) continue;
                    try {
                        await this.bridge.sendMessage(entry.threadId, entry.prompt);
                    } catch (error) {
                        this.log('[outbox] 发送失败，保留待发送：' + error.message);
                        return;
                    }
                    entry.status = 'sent';
                    entry.sentAt = new Date().toISOString();
                    entry.attempts += 1;
                    await this.save();
                    if (await this.bridge.waitForMarker(entry.threadId, entry.marker, this.checkTimeoutMs)) {
                        entry.status = 'acked';
                        entry.ackedAt = new Date().toISOString();
                        await this.save();
                    }
                }
            });
        } finally {
            this.flushing = false;
            if (this.again) {
                this.again = false;
                setImmediate(() => this.flush().catch(error => this.log('[outbox] 重试失败：' + error.message)));
            }
        }
    }

    start() {
        this.flush().catch(error => this.log('[outbox] 启动发送失败：' + error.message));
        if (!this.timer) {
            this.timer = setInterval(() => {
                this.flush().catch(error => this.log('[outbox] 定时发送失败：' + error.message));
            }, this.intervalMs);
            this.timer.unref?.();
        }
        return this;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
    }
}

module.exports = { HostBridge, Outbox, listHostPipes };
