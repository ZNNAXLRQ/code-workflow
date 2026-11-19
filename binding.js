'use strict';

/**
 * 仓库 ↔ 前端会话绑定。
 *
 * 纯 CommonJS，不 require('vscode')，可直接在 Node 里做冒烟测试。
 * 落盘位置：
 * - <repo>/.local-workflow/binding.json  —— 一个仓库只绑定一个前端会话；
 * - <repo>/.local-workflow/.lock        —— 跨进程互斥用的独占文件。
 *
 * 约定：
 * - 绑定结构：{ repo, mode, frontendSessionId, codexThreadId, createdAt, updatedAt }；
 * - mode='codex' 时 frontendSessionId 必须等于 codexThreadId（Codex 会话本身就是前端会话）；
 * - mode='cline' 时两者不同：前端是 Cline 会话，Codex 线程另行指定；
 * - 读改写（bind / unbind）本身不再嵌套取锁，调用方要做跨进程互斥时用
 *   withRepoLock(repo, () => bind(...)) 包一层，避免 read-check-write 竞态；
 * - 写盘走同目录 tmp 文件 + rename；不使用 flock，只用 'wx' 独占创建 + 轮询，
 *   在 Windows / macOS / Linux 上行为一致。
 */

const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

const MODES = Object.freeze(['codex', 'cline']);
const MODE_SET = new Set(MODES);

/** 锁文件轮询间隔（毫秒）。 */
const LOCK_POLL_MS = 40;
/** 锁文件 + 目录名。 */
const LOCK_FILE = '.lock';

/**
 * 当前异步上下文是否已在某个仓库的临界区里。
 * 用来精确识别“嵌套取同一把锁”（会自锁）；同进程的兄弟协程（并发 worker）
 * 没有这个上下文，应当正常排队等待，不能误判。
 */
const criticalSection = new AsyncLocalStorage();

function describe(value) {
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return JSON.stringify(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** 校验 repo 参数：必须是非空字符串路径；返回规范化后的绝对路径。 */
function repositoryRoot(repo) {
    if (typeof repo !== 'string' || !repo.trim()) {
        throw new Error('repo 必须是非空字符串路径');
    }
    return path.resolve(repo.trim());
}

/** <repo>/.local-workflow。 */
function stateDir(repo) {
    return path.join(repositoryRoot(repo), '.local-workflow');
}

/** <repo>/.local-workflow/binding.json。 */
function bindingPath(repo) {
    return path.join(stateDir(repo), 'binding.json');
}

/** <repo>/.local-workflow/.lock（互斥文件，内容 {pid, createdAt, reason}）。 */
function lockPath(repo) {
    return path.join(stateDir(repo), LOCK_FILE);
}

/** 必填字符串字段校验。 */
function requireText(value, name) {
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error('绑定缺少必填字段 ' + name);
    }
    return value;
}

/** 必填时间戳字段校验：非空且能被 Date 解析。 */
function requireTimestamp(value, name) {
    requireText(value, name);
    if (Number.isNaN(Date.parse(value))) {
        throw new Error('绑定字段 ' + name + ' 不是合法时间戳，收到 ' + describe(value));
    }
    return value;
}

/**
 * 校验绑定结构。
 * 合法时原样返回 value，非法时抛中文错误（与 validateSettings 保持一致）。
 *
 * @param {object} value
 */
function validateBinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('绑定必须是普通对象，收到 ' + describe(value));
    }
    requireText(value.repo, 'repo');
    if (!MODE_SET.has(value.mode)) {
        throw new Error('绑定 mode 只能是 codex 或 cline，收到 ' + describe(value.mode));
    }
    requireText(value.frontendSessionId, 'frontendSessionId');
    requireText(value.codexThreadId, 'codexThreadId');
    if (value.mode === 'codex' && value.frontendSessionId !== value.codexThreadId) {
        throw new Error('codex 模式下 frontendSessionId 必须等于 codexThreadId，收到 ' +
            describe(value.frontendSessionId) + ' 与 ' + describe(value.codexThreadId));
    }
    requireTimestamp(value.createdAt, 'createdAt');
    requireTimestamp(value.updatedAt, 'updatedAt');
    return value;
}

/**
 * 读取绑定。
 * 文件不存在返回 null；JSON 解析失败 / 非对象抛错（损坏的绑定不能当成“未绑定”）。
 *
 * @param {string} repo
 * @returns {object|null}
 */
function readBinding(repo) {
    const file = bindingPath(repo);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('读取绑定文件失败：' + file + '（' + error.message + '）');
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error('绑定文件已损坏，无法解析：' + file + '（' + error.message + '）');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('绑定文件格式无效（应为 JSON 对象）：' + file);
    }
    return data;
}

/** 同目录 tmp + rename 原子写入。 */
function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
        fs.renameSync(temporary, file);
    } catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        } catch {
            /* 残留 .tmp 不影响正式文件。 */
        }
        throw new Error('写入绑定文件失败：' + file + '（' + error.message + '）');
    }
}

/**
 * 绑定前端会话。
 *
 * - 已有绑定且 replace !== true：抛错，并把现有绑定挂在 error.binding 上；
 * - replace=true：保留原 createdAt，刷新 updatedAt；
 * - mode='codex' 允许省略 frontendSessionId（默认取 codexThreadId），两者不一致则抛错。
 *
 * 不取锁：需要跨进程 read-check-write 时请包一层 withRepoLock。
 *
 * @param {string} repo
 * @param {{mode: 'codex'|'cline', frontendSessionId?: string, codexThreadId?: string}} options
 * @param {{replace?: boolean}} [options2]
 * @returns {object} 新绑定
 */
function bind(repo, options = {}, { replace = false } = {}) {
    const root = repositoryRoot(repo);
    const { mode, codexThreadId } = options || {};
    let { frontendSessionId } = options || {};
    if (!MODE_SET.has(mode)) {
        throw new Error("mode 只能是 'codex' 或 'cline'，收到 " + describe(mode));
    }
    const thread = typeof codexThreadId === 'string' ? codexThreadId.trim() : codexThreadId;
    let frontend = typeof frontendSessionId === 'string' ? frontendSessionId.trim() : frontendSessionId;
    // codex 模式下前端会话就是 Codex 线程，允许只传 codexThreadId。
    if (mode === 'codex' && (frontend === undefined || frontend === null || frontend === '')) {
        frontend = thread;
    }

    const file = bindingPath(root);
    const existing = readBinding(root);
    if (existing && replace !== true) {
        const error = new Error('仓库已存在绑定（mode=' + describe(existing.mode) + '，会话 ' +
            describe(existing.frontendSessionId) + '），需要 replace=true 才能覆盖：' + file);
        error.code = 'EBOUND';
        error.binding = existing;
        throw error;
    }

    const now = new Date().toISOString();
    const binding = {
        repo: root,
        mode,
        frontendSessionId: frontend,
        codexThreadId: thread,
        createdAt: existing && typeof existing.createdAt === 'string' && existing.createdAt
            ? existing.createdAt
            : now,
        updatedAt: now
    };
    validateBinding(binding);
    writeJsonAtomic(file, binding);
    return binding;
}

/**
 * 解除绑定。
 * 不存在返回 null；expectedSessionId 与当前 frontendSessionId 不一致时抛错且不动文件。
 *
 * @param {string} repo
 * @param {{expectedSessionId?: string}} [options]
 * @returns {object|null} 被删除的旧绑定
 */
function unbind(repo, { expectedSessionId } = {}) {
    const root = repositoryRoot(repo);
    const existing = readBinding(root);
    if (!existing) return null;
    if (expectedSessionId !== undefined && expectedSessionId !== null) {
        const expected = String(expectedSessionId).trim();
        if (existing.frontendSessionId !== expected) {
            const error = new Error('当前绑定属于会话 ' + describe(existing.frontendSessionId) +
                '，不是 ' + describe(expected) + '，拒绝解绑');
            error.code = 'ESESSION';
            error.binding = existing;
            throw error;
        }
    }
    const file = bindingPath(root);
    try {
        fs.unlinkSync(file);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            throw new Error('删除绑定文件失败：' + file + '（' + error.message + '）');
        }
    }
    return existing;
}

/** 'wx' 独占创建锁文件并写入 {pid, createdAt, reason}；已存在返回 false。 */
function tryCreateLock(file, token) {
    let handle;
    try {
        handle = fs.openSync(file, 'wx');
    } catch (error) {
        if (error.code === 'EEXIST') return false;
        throw new Error('创建仓库锁失败：' + file + '（' + error.message + '）');
    }
    try {
        fs.writeSync(handle, JSON.stringify(token) + '\n', null, 'utf8');
        return true;
    } catch (error) {
        // 写失败就立刻清掉，避免留下空锁文件卡住别人。
        try {
            fs.rmSync(file, { force: true });
        } catch {
            /* 交给 staleMs 回收。 */
        }
        throw new Error('写入仓库锁失败：' + file + '（' + error.message + '）');
    } finally {
        fs.closeSync(handle);
    }
}

/** 读取锁文件现状：{exists, ageMs, owner}；owner 解析失败为 null。 */
function inspectLock(file) {
    let stat;
    try {
        stat = fs.statSync(file);
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false, ageMs: 0, owner: null };
        throw new Error('读取仓库锁失败：' + file + '（' + error.message + '）');
    }
    let owner = null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) owner = parsed;
    } catch {
        /* 空文件 / 半截内容：按“刚创建”处理，靠 mtime 老化回收。 */
    }
    let ageMs = Date.now() - stat.mtimeMs;
    if (owner && typeof owner.createdAt === 'string') {
        const created = Date.parse(owner.createdAt);
        if (!Number.isNaN(created)) ageMs = Math.max(ageMs, Date.now() - created);
    }
    return { exists: true, ageMs, owner };
}

/**
 * 抢占过期锁：把锁文件 rename 到随机旁路名再删除。
 * rename 在 Windows/macOS/Linux 上同卷原子，只有一个抢锁者能成功改名，
 * 比先 unlink 再创建少一个“删掉别人新锁”的窗口。
 * 返回 true 表示可以立刻重试创建。
 */
function stealStaleLock(file) {
    const aside = file + '.stale.' + randomUUID();
    try {
        fs.renameSync(file, aside);
    } catch (error) {
        // ENOENT：别人先抢走了；EBUSY/EPERM：保守放弃本轮，下一轮再看。
        if (error.code === 'ENOENT') return true;
        return false;
    }
    try {
        fs.rmSync(aside, { force: true });
    } catch {
        /* 旁路文件清理失败不影响互斥。 */
    }
    return true;
}

/** 释放锁：只在锁仍属于自己时删除，避免误删被别人抢占后的新锁。 */
function releaseLock(file, token) {
    let owner;
    try {
        owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return;
        // 内容损坏时无法确认归属，保守不删，交给 staleMs 回收。
        return;
    }
    if (!owner || owner.pid !== token.pid || owner.createdAt !== token.createdAt) return;
    try {
        fs.unlinkSync(file);
    } catch {
        /* 已被别人清理：忽略。 */
    }
}

/** 超时错误：带上锁路径与持有者信息，便于排障。 */
function lockTimeoutError(file, reason, inspected, timeoutMs) {
    const owner = inspected.owner
        ? '持有者 pid=' + describe(inspected.owner.pid) + '，开始于 ' +
            describe(inspected.owner.createdAt) + '，reason=' + describe(inspected.owner.reason)
        : '锁文件内容不可解析（可能是进程崩溃残留）';
    const error = new Error('等待仓库锁超时（' + timeoutMs + 'ms）：' + file + '，' + owner +
        '；本次 reason=' + describe(reason));
    error.code = 'ELOCKTIMEOUT';
    error.lockFile = file;
    return error;
}

/**
 * 用 <repo>/.local-workflow/.lock 独占文件做互斥（跨平台，不用 flock）。
 *
 * - 已存在且未超时：按 LOCK_POLL_MS 轮询等待；
 * - 超过 staleMs 视为崩溃残留，抢占后重试；
 * - 超过 timeoutMs 抛错；
 * - fn 支持 async，返回值透传；无论成功失败都在 finally 释放；
 * - 同一进程重复嵌套取同一把锁会立刻抛 EDEADLOCK，而不是白等一个超时。
 *
 * @param {string} repo
 * @param {() => any} fn 临界区（可为 async）
 * @param {{timeoutMs?: number, staleMs?: number, reason?: string}} [options]
 */
async function withRepoLock(repo, fn, { timeoutMs = 10000, staleMs = 60000, reason } = {}) {
    if (typeof fn !== 'function') {
        throw new Error('withRepoLock 的第二个参数必须是函数');
    }
    // 非法数值会让 deadline 变成 NaN 从而死等，这里统一夹到安全默认值。
    const wait = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 10000;
    const stale = Number.isFinite(staleMs) && staleMs > 0 ? staleMs : 60000;
    const root = repositoryRoot(repo);
    const file = lockPath(root);
    fs.mkdirSync(stateDir(root), { recursive: true });

    const label = reason === undefined || reason === null || reason === ''
        ? 'local-workflow:' + (fn.name || 'lock')
        : String(reason);
    const token = { pid: process.pid, createdAt: new Date().toISOString(), reason: label };
    const deadline = Date.now() + wait;
    const scope = { root, file, token };

    for (;;) {
        // 已经在同一个仓库的临界区里还来取锁：必然自锁，立刻报错而不是白等一个超时。
        const enclosing = criticalSection.getStore();
        if (enclosing && enclosing.root === root) {
            const error = new Error('同一临界区里嵌套获取仓库锁会自锁：' + file +
                '（请把两次操作合并到同一个 withRepoLock 里）');
            error.code = 'EDEADLOCK';
            error.lockFile = file;
            throw error;
        }
        if (tryCreateLock(file, token)) break;
        const inspected = inspectLock(file);
        if (!inspected.exists) continue;
        if (inspected.ageMs > stale && stealStaleLock(file)) continue;
        const now = Date.now();
        if (now >= deadline) throw lockTimeoutError(file, label, inspected, wait);
        await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - now)));
    }

    try {
        return await criticalSection.run(scope, fn);
    } finally {
        releaseLock(file, token);
    }
}

/**
 * 断言当前绑定与调用方身份一致。
 * 未绑定、字段损坏、mode 不符、会话不符都抛中文错误。
 *
 * @param {string} repo
 * @param {string} sessionId 前端会话 id（codex 模式下等于 codexThreadId）
 * @param {'codex'|'cline'} mode
 * @returns {object} 通过校验的绑定
 */
function assertBinding(repo, sessionId, mode) {
    const root = repositoryRoot(repo);
    const file = bindingPath(root);
    const binding = readBinding(root);
    if (!binding) {
        const error = new Error('仓库尚未绑定前端会话：' + file);
        error.code = 'ENOBINDING';
        throw error;
    }
    // 损坏/缺字段要报错，不能当成“未绑定”放过。
    validateBinding(binding);
    if (mode !== undefined && mode !== null) {
        if (binding.mode !== mode) {
            const error = new Error('当前绑定是 ' + describe(binding.mode) + ' 模式，不是 ' +
                describe(mode) + '：' + file);
            error.code = 'EMODE';
            error.binding = binding;
            throw error;
        }
    }
    if (sessionId !== undefined && sessionId !== null) {
        const expected = String(sessionId).trim();
        if (binding.frontendSessionId !== expected) {
            const error = new Error('当前绑定属于会话 ' + describe(binding.frontendSessionId) +
                '，不是 ' + describe(expected) + '：' + file);
            error.code = 'ESESSION';
            error.binding = binding;
            throw error;
        }
    }
    return binding;
}

module.exports = {
    MODES,
    bindingPath,
    lockPath,
    validateBinding,
    readBinding,
    bind,
    unbind,
    withRepoLock,
    assertBinding
};
