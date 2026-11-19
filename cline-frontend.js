const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');

const VERSION = 1;
const FRONTEND_VERSION = 1;
const STATUSES = ['todo', 'doing', 'done', 'blocked'];

function handoffPath(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'cline-handoff.json');
}

function frontendPath(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'frontend.json');
}

function handoffStatePath(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'cline-handoff-state.json');
}

function requestId(request) {
    return 'req-' + createHash('sha256').update(String(request ?? '')).digest('hex').slice(0, 16);
}

function readHandoffState(repo) {
    const file = handoffStatePath(repo);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        return {
            version: 1,
            assignments: parsed && typeof parsed.assignments === 'object' ? parsed.assignments : {},
            requests: parsed && typeof parsed.requests === 'object' ? parsed.requests : {}
        };
    } catch (error) {
        if (error.code === 'ENOENT') return { version: 1, assignments: {}, requests: {} };
        throw new Error('读取 Cline 交接状态失败：' + file + '：' + error.message);
    }
}

function writeHandoffState(repo, value) {
    const file = handoffStatePath(repo);
    const normalized = {
        version: 1,
        assignments: value && typeof value.assignments === 'object' ? value.assignments : {},
        requests: value && typeof value.requests === 'object' ? value.requests : {},
        updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(temporary, file);
    return normalized;
}

function markHandoffRequests(repo, ids, at = new Date().toISOString()) {
    if (!Array.isArray(ids) || !ids.length) return false;
    const state = readHandoffState(repo);
    let changed = false;
    for (const id of ids) {
        if (!id) continue;
        const previous = state.requests[id] || {};
        if (previous.handedOff) continue;
        state.requests[id] = { ...previous, id, handedOff: true, handedOffAt: at };
        changed = true;
    }
    if (changed) writeHandoffState(repo, state);
    return changed;
}

function resolveHandoffQueue(repo, handoff, { persist = true } = {}) {
    const state = readHandoffState(repo);
    const seen = new Map();
    let changed = false;
    const queue = (handoff?.queue || []).map(entry => {
        let id = entry.id;
        if (!id) {
            const fingerprint = requestId(entry.request);
            const occurrence = (seen.get(fingerprint) || 0) + 1;
            seen.set(fingerprint, occurrence);
            const key = fingerprint + ':' + occurrence;
            id = state.assignments[key];
            if (!id) {
                id = 'req-' + randomUUID();
                state.assignments[key] = id;
                changed = true;
            }
        }
        return {
            ...entry,
            id,
            handedOff: Boolean(entry.handedOff || state.requests[id]?.handedOff)
        };
    });
    if (persist && changed) writeHandoffState(repo, state);
    return { queue, state };
}

function readFrontend(repo) {
    const file = frontendPath(repo);
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        if (!value || typeof value !== 'object' || !['codex', 'cline'].includes(value.mode)) {
            throw new Error('frontend.json 的 mode 必须是 codex 或 cline');
        }
        return { version: FRONTEND_VERSION, mode: value.mode, clineSessionId: value.clineSessionId || null,
            updatedAt: value.updatedAt || null };
    } catch (error) {
        if (error.code === 'ENOENT') return { version: FRONTEND_VERSION, mode: 'codex', clineSessionId: null, updatedAt: null };
        throw new Error('读取前端模式失败：' + file + '：' + error.message);
    }
}

function writeFrontend(repo, value) {
    if (!value || !['codex', 'cline'].includes(value.mode)) throw new Error('前端模式必须是 codex 或 cline');
    const file = frontendPath(repo);
    const normalized = {
        version: FRONTEND_VERSION,
        mode: value.mode,
        clineSessionId: value.clineSessionId || null,
        updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(temporary, file);
    return normalized;
}

function emptyHandoff({ repo, request = '', stage = null } = {}) {
    return {
        version: VERSION,
        mode: 'cline',
        repo: path.resolve(repo || '.'),
        request,
        stage: stage ? { id: stage.id || randomUUID().slice(0, 12), title: stage.title || request } : null,
        plan: '',
        tasks: [],
        queue: [],
        implemented: [],
        updatedAt: new Date().toISOString()
    };
}

function validateHandoff(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('交接文件必须是 JSON 对象');
    if (value.version !== VERSION) throw new Error('交接文件版本不支持：' + value.version);
    if (value.mode !== 'cline') throw new Error('交接文件 mode 必须是 cline');
    if (typeof value.repo !== 'string' || !value.repo.trim()) throw new Error('交接文件缺少 repo');
    if (!Array.isArray(value.tasks) || !Array.isArray(value.queue) || !Array.isArray(value.implemented)) {
        throw new Error('交接文件 tasks/queue/implemented 必须是数组');
    }
    if (typeof value.plan !== 'string') throw new Error('交接文件 plan 必须是字符串');
    for (const task of value.tasks) {
        if (!task || typeof task !== 'object') throw new Error('交接文件 task 必须是对象');
        if (typeof task.id !== 'string' || !task.id) throw new Error('交接文件 task 缺少 id');
        if (typeof task.title !== 'string' || !task.title) throw new Error('交接文件 task 缺少 title');
        if (!STATUSES.includes(task.status)) throw new Error('交接文件 task 状态无效：' + task.status);
        if (!Array.isArray(task.paths)) throw new Error('交接文件 task.paths 必须是数组');
    }
    for (const item of value.queue) {
        if (!item || typeof item !== 'object' || typeof item.request !== 'string' || !item.request.trim()) {
            throw new Error('交接文件 queue 项缺少 request');
        }
    }
    return value;
}

function readHandoff(repo) {
    const file = handoffPath(repo);
    try {
        return validateHandoff(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('读取 Cline 交接文件失败：' + file + '：' + error.message);
    }
}

function writeHandoff(repo, value) {
    const normalized = validateHandoff({ ...value, version: VERSION, mode: 'cline', repo: path.resolve(repo),
        updatedAt: new Date().toISOString() });
    const file = handoffPath(repo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(temporary, file);
    return normalized;
}

function bootstrapPrompt({ repo, request, handoff = handoffPath(repo) }) {
    return [
        '你是「本地开发工作流」的 Cline 前端会话。用户会手动在 Plan 和 Act 之间切换。',
        '仓库：' + path.resolve(repo),
        request ? '当前请求：' + request : '',
        '你不调用 Codex，也不等待本地工作流的审查；Codex 额度恢复后会把本会话的交接文件交给它同步。',
        '',
        '请始终维护交接文件：' + handoff,
        '文件是 JSON，结构：',
        JSON.stringify(emptyHandoff({ repo, request }), null, 2),
        '',
        '规则：',
        '1. 计划变化时更新 plan；拆分出的任务写入 tasks（id/title/status/paths/notes），status 用 todo/doing/done/blocked。',
        '2. 每次实现后更新 implemented（taskId/files/tests/note），并把任务状态改为 done；不要重复实现已完成任务。',
        '3. 等待下一个请求时写入 queue；不要执行 queue 里的请求，除非用户在当前会话明确要求。',
        '4. 每次更新后保持 JSON 合法；不要删除 version/mode/repo 字段。',
        '5. 不要修改本交接文件之外的、与当前任务无关的项目文件。'
    ].filter(Boolean).join('\n');
}

function handoffDigest(handoff) {
    if (!handoff) return 'Cline 前端没有交接文件。';
    const tasks = handoff.tasks.map(task => '- [' + task.status + '] ' + task.id + ' ' + task.title +
        (task.paths?.length ? '（' + task.paths.join('、') + '）' : '')).join('\n') || '- 暂无任务';
    const implemented = handoff.implemented.map(item => '- ' + item.taskId + '：' + (item.note || '已实施') +
        (item.tests ? '；测试：' + item.tests : '')).join('\n') || '- 暂无实施记录';
    const queue = handoff.queue.map(item => '- ' + item.request).join('\n') || '- 暂无排队请求';
    return [
        'Cline 前端交接摘要',
        '阶段：' + (handoff.stage?.title || handoff.request || '未命名'),
        '计划：' + (handoff.plan ? handoff.plan.slice(0, 4000) : '未填写'),
        '任务：',
        tasks,
        '实施：',
        implemented,
        '排队：',
        queue,
        '交接文件：' + handoffPath(handoff.repo)
    ].join('\n');
}

function watchHandoff(repo, onChange, { intervalMs = 2000 } = {}) {
    let last = null;
    let stopped = false;
    const tick = () => {
        if (stopped) return;
        try {
            const value = readHandoff(repo);
            const signature = value ? JSON.stringify(value) : null;
            if (signature !== last) {
                last = signature;
                onChange(value);
            }
        } catch (error) {
            onChange(null, error);
        }
    };
    tick();
    const timer = setInterval(tick, Math.max(250, intervalMs));
    timer.unref?.();
    return () => { stopped = true; clearInterval(timer); };
}

module.exports = {
    VERSION, FRONTEND_VERSION, STATUSES, handoffPath, frontendPath, handoffStatePath, requestId,
    emptyHandoff, validateHandoff, readHandoff, writeHandoff, readFrontend, writeFrontend,
    readHandoffState, writeHandoffState, markHandoffRequests, resolveHandoffQueue, bootstrapPrompt, handoffDigest, watchHandoff
};
