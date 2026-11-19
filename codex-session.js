const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createInterface } = require('node:readline');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const workflowPrefix = '[本地工作流 · ';
const discussionSuffix = '\n\n[本地工作流 · 对话设置]\n';
const routeMarker = '[本地工作流 · 建议派发]';
const locks = new Map();

function parseThread(value) {
    const input = value.trim();
    if (!input) return '';
    const match = /^(?:codex:\/\/threads\/)?([\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12})\/?$/i.exec(input);
    if (!match) throw new Error('请粘贴本机 Codex 会话 ID 或 codex://threads/ 链接。');
    return match[1].toLowerCase();
}

async function exclusive(key, signal, work) {
    const previous = locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
        signal?.removeEventListener('abort', abort);
        signal?.throwIfAborted();
        return work();
    }).finally(() => {
        if (locks.get(key) === next) locks.delete(key);
    });
    let abort;
    let waiting;
    if (signal) {
        waiting = new Promise((_, reject) => {
            abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
        });
    }
    locks.set(key, next);
    return waiting ? Promise.race([next, waiting]) : next;
}

class Connection {
    constructor(command, cwd) {
        this.child = spawn(command, ['app-server', '--stdio'], { cwd, windowsHide: true, stdio: 'pipe' });
        this.pending = new Map();
        this.id = 0;
        this.stderr = '';
        this.child.stderr.setEncoding('utf8').on('data', value => { this.stderr = (this.stderr + value).slice(-1400); });
        this.child.stdin.on('error', error => this.fail(error));
        this.child.on('error', error => this.fail(error));
        this.child.on('exit', code => this.fail(new Error('Codex 会话服务退出（' + code + '）\n' + this.stderr)));
        this.lines = createInterface({ input: this.child.stdout });
        this.lines.on('line', line => {
            let frame;
            try { frame = JSON.parse(line); } catch { return; }
            if (!frame.method) {
                this.pending.get(frame.id)?.(frame.error ? new Error(frame.error.message) : null, frame.result);
            } else if (frame.id !== undefined) {
                const isQuestion = frame.method === 'item/tool/requestUserInput';
                Promise.resolve().then(() => isQuestion ? this.question?.(frame.params) : undefined).then(result => {
                    if (result) this.write({ id: frame.id, result });
                    else this.write({ id: frame.id, error: { code: -32601, message: '当前工作流不授权此客户端操作' } });
                }, () => this.write({ id: frame.id, error: { code: -32800, message: '用户输入已取消' } })).catch(() => {});
            } else {
                this.notification?.(frame.method, frame.params);
            }
        });
    }

    fail(error) {
        this.error ||= error;
        for (const done of this.pending.values()) done(this.error);
        this.connectionLost?.(this.error);
    }

    write(frame) {
        if (this.error || this.child.stdin.destroyed) return;
        this.child.stdin.write(JSON.stringify(frame) + '\n');
    }

    request(method, params = {}) {
        if (this.error) return Promise.reject(this.error);
        const id = ++this.id;
        return new Promise((resolve, reject) => {
            const done = (error, result) => {
                clearTimeout(timer);
                this.pending.delete(id);
                if (error) reject(error);
                else resolve(result);
            };
            const timer = setTimeout(() => done(new Error('Codex 会话服务响应超时 · ' + method)), 30000);
            this.pending.set(id, done);
            this.write({ id, method, params });
        });
    }

    async initialize() {
        await this.request('initialize', {
            clientInfo: { name: 'local_workflow', title: '本地开发工作流', version: require('./package.json').version },
            capabilities: { experimentalApi: true }
        });
        this.write({ method: 'initialized' });
    }

    async turn(threadId, cwd, prompt, schema, { signal, onQuestion, onControls, onStarted }) {
        signal?.throwIfAborted();
        let turnId;
        let stopping = false;
        const messages = new Map();
        const input = value => [{ type: 'text', text: value, text_elements: [] }];
        const stop = () => {
            if (turnId && !stopping) {
                stopping = true;
                this.request('turn/interrupt', { threadId, turnId }).catch(error => this.connectionLost?.(error));
            }
        };
        let timer;
        const completed = new Promise(resolve => {
            this.connectionLost = error => resolve({ error });
            this.notification = (method, params) => {
                if (params?.threadId !== threadId) return;
                if (method === 'item/completed' && params.item.type === 'agentMessage') {
                    if (!turnId || params.turnId === turnId) messages.set(params.item.id, params.item.text);
                }
                if (method === 'turn/completed' && (!turnId || turnId === params.turn.id)) resolve({ turn: params.turn });
            };
            timer = setTimeout(() => {
                stop();
                resolve({ error: new Error('Codex 回复超时，请检查网络或 VPN 后重试。') });
            }, 900000);
        });
        const questions = new AbortController();
        this.question = params => onQuestion?.(params, questions.signal);
        signal?.addEventListener('abort', stop, { once: true });
        try {
            const { turn } = await this.request('turn/start', {
                threadId, cwd, input: input(prompt), outputSchema: schema,
                approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' }
            });
            turnId = turn.id;
            if (signal?.aborted) stop();
            await onStarted?.();
            onControls?.(value => this.request('turn/steer', { threadId, input: input(value), expectedTurnId: turnId }));
            const result = await completed;
            if (result.error) throw result.error;
            if (result.turn.status === 'interrupted') throw new Error('Codex 对话已中断。');
            if (result.turn.status !== 'completed') throw new Error(result.turn.error?.message || 'Codex 未完成此次回复。');
            for (const item of result.turn.items || []) if (item.type === 'agentMessage') messages.set(item.id, item.text);
            const replies = [...messages.values()].filter(Boolean);
            if (!replies.length) throw new Error('Codex 没有返回文本。');
            return schema ? JSON.parse(replies.at(-1)) : replies.at(-1);
        } finally {
            questions.abort();
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            onControls?.(undefined);
            this.question = undefined;
            this.connectionLost = undefined;
            this.notification = undefined;
        }
    }

    async close() {
        this.lines.close();
        if (this.child.exitCode !== null || this.child.signalCode !== null) return;
        const closed = new Promise(resolve => {
            const timer = setTimeout(() => {
                this.child.kill();
                resolve();
            }, 2000);
            this.child.once('close', () => { clearTimeout(timer); resolve(); });
        });
        this.child.stdin.end();
        await closed;
    }
}

function discussionText(text) {
    return text.split(discussionSuffix)[0];
}

function routing(text) {
    const lines = text.trimEnd().split('\n');
    const propose = lines.at(-1)?.trim() === routeMarker;
    return { text: propose ? lines.slice(0, -1).join('\n').trim() : text, propose };
}

async function openConnection(command, cwd, work) {
    const connection = new Connection(command, cwd);
    try {
        await connection.initialize();
        return await work(connection);
    } finally { await connection.close(); }
}

async function desktopExecutable(cwd) {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const query = "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
        "Get-AppxPackage -Name 'OpenAI.Codex' | ForEach-Object { Join-Path $_.InstallLocation 'app\\resources\\codex.exe' }";
    const { stdout } = await promisify(execFile)(powershell,
        ['-NoProfile', '-NonInteractive', '-Command', query], { cwd, windowsHide: true, timeout: 12000 });
    for (const candidate of stdout.split(/\r?\n/).map(line => line.trim())) {
        if (!path.isAbsolute(candidate)) continue;
        const stat = await fs.stat(candidate).catch(() => null);
        if (stat?.isFile()) return candidate;
    }
}

async function connect(command, cwd, work) {
    try {
        return await openConnection(command || 'codex', cwd, work);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!(await fs.stat(cwd).catch(() => null))?.isDirectory()) throw new Error('当前工作区文件夹已经不存在。');
        if (command) throw new Error('无法启动设置中的 Codex 可执行文件，请检查路径或清空覆盖项。');
        const desktop = process.platform === 'win32' ? await desktopExecutable(cwd).catch(() => undefined) : undefined;
        if (!desktop) throw new Error('找不到 Codex。请安装 Codex Desktop 或在 VS Code 的「Codex Executable」设置中填写可执行文件路径。');
        return openConnection(desktop, cwd, work);
    }
}

async function readTurns({ command, cwd, threadId, limit = 10 }) {
    return connect(command, cwd, rpc => rpc.request('thread/turns/list', { threadId, limit, sortDirection: 'desc', itemsView: 'full' }));
}

function createSession({ command, cwd, thread, save }) {
    async function run(where, prompt, schema, options = {}) {
        return exclusive(cwd, options.signal, async () => {
            let threadId = thread();
            const execute = () => connect(command(), cwd, async rpc => {
                const settings = { cwd, approvalPolicy: 'never', sandbox: 'danger-full-access' };
                if (threadId) {
                    const { thread: stored } = await rpc.request('thread/read', { threadId });
                    if (stored.status?.type === 'active') {
                        throw Object.assign(new Error('该 Codex 会话正在回复，请等本轮结束后重试。'), { code: 'CODEX_TURN_ACTIVE' });
                    }
                    await rpc.request('thread/resume', { ...settings, threadId, excludeTurns: true });
                } else {
                    const result = await rpc.request('thread/start', { ...settings, ephemeral: false });
                    threadId = parseThread(result.thread.id);
                    return rpc.turn(threadId, where, prompt, schema, { ...options, onStarted: () => save(threadId) });
                }
                return rpc.turn(threadId, where, prompt, schema, options);
            });
            if (!threadId) return execute();
            return exclusive(threadId, options.signal, async () => {
                for (const wait of [0, 650, 1800]) {
                    if (wait) await delay(wait, undefined, { signal: options.signal });
                    try { return await execute(); }
                    catch (error) {
                        if (!/already has an active writer/i.test(error.message) && error.code !== 'CODEX_TURN_ACTIVE') throw error;
                        if (wait !== 1800) continue;
                        if (error.code === 'CODEX_TURN_ACTIVE') throw error;
                        throw new Error('这条 Codex 会话的写入连接仍被其他客户端持有。即使桌面端已经切到别的会话，也可能保留此连接。请从系统托盘完全退出 Codex Desktop 后再试。其他绑定不同会话的项目可以继续。');
                    }
                }
            });
        });
    }

    async function describe(value) {
        const threadId = parseThread(value);
        if (!threadId) return { id: '', title: '' };
        const { thread: stored } = await connect(command(), cwd, rpc => rpc.request('thread/read', { threadId }));
        const title = stored.name?.trim();
        const preview = discussionText(stored.preview || '').trim();
        return { id: threadId, title: title || '', preview: preview.startsWith(workflowPrefix) ? '' : preview.split(/\r?\n/)[0].slice(0, 100) };
    }

    async function validate(value) {
        return (await describe(value)).id;
    }

    async function history() {
        const threadId = thread();
        if (!threadId) return [];
        return connect(command(), cwd, async rpc => {
            const { data } = await rpc.request('thread/turns/list', { threadId, limit: 20, sortDirection: 'desc', itemsView: 'full' });
            return data.reverse().flatMap(turn => {
                const first = turn.items.find(item => item.type === 'userMessage');
                const text = first?.content.find(part => part.type === 'text')?.text || '';
                if (text.startsWith(workflowPrefix)) return [];
                return turn.items.flatMap(item => {
                    if (item.type === 'userMessage') return [{ role: 'user', text: discussionText(item.content.filter(part => part.type === 'text').map(part => part.text).join('\n')) }];
                    if (item.type === 'agentMessage' && item.phase !== 'commentary') return [{ role: 'assistant', text: routing(item.text).text }];
                    return [];
                }).filter(item => item.text);
            });
        });
    }

    async function hasHandoff(marker, receipt) {
        const threadId = thread();
        if (!threadId) return false;
        return connect(command(), cwd, async rpc => {
            const { data } = await rpc.request('thread/turns/list', { threadId, limit: 30, sortDirection: 'desc', itemsView: 'full' });
            return data.some(turn => turn.status === 'completed' &&
                turn.items.some(item => item.type === 'userMessage' && item.content.some(part =>
                    part.type === 'text' && part.text.startsWith(marker + '\n'))) &&
                turn.items.some(item => item.type === 'agentMessage' && item.text.trim() === receipt));
        });
    }

    async function rateLimits() {
        return connect(command(), cwd, async rpc => {
            const { rateLimits } = await rpc.request('account/rateLimits/read');
            return [rateLimits.primary, rateLimits.secondary].filter(Boolean).map(window => ({
                used: window.usedPercent, minutes: window.windowDurationMins, reset: window.resetsAt
            }));
        });
    }

    return { run, validate, describe, history, hasHandoff, rateLimits };
}

module.exports = { createSession, readTurns, workflowPrefix, discussionSuffix, routeMarker, routing };
