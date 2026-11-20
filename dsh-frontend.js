'use strict';

/**
 * DSH / Codex 前端元数据与交接文件。
 *
 * 这里不驱动任何前端聊天，只保存“当前选择哪个前端 + DSH 会话 ID”，
 * 以及一份供两个前端共同读取的进度快照。实际规划、审查、验收仍通过
 * 工作流 hub 的 MCP 工具完成。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const FRONTEND_VERSION = 1;
const MODES = ['codex', 'dsh'];

function frontendPath(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'frontend.json');
}

function handoffPath(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'frontend-handoff.json');
}

function emptyFrontend() {
    return { version: FRONTEND_VERSION, mode: 'codex', dshSessionId: '', updatedAt: null };
}

function readFrontend(repo) {
    const file = frontendPath(repo);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        const mode = parsed && parsed.mode === 'dsh' ? 'dsh' : 'codex';
        return {
            version: FRONTEND_VERSION,
            mode,
            dshSessionId: typeof parsed?.dshSessionId === 'string' ? parsed.dshSessionId : '',
            updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : null
        };
    } catch (error) {
        if (error.code === 'ENOENT') return emptyFrontend();
        throw new Error('读取前端模式失败：' + file + '：' + error.message);
    }
}

function writeFrontend(repo, value) {
    const file = frontendPath(repo);
    const mode = value?.mode === 'dsh' ? 'dsh' : 'codex';
    const normalized = {
        version: FRONTEND_VERSION,
        mode,
        dshSessionId: typeof value?.dshSessionId === 'string' ? value.dshSessionId : '',
        updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(temporary, file);
    return normalized;
}

function emptyHandoff() {
    return {
        version: VERSION,
        mode: 'codex',
        dshSessionId: '',
        repo: '',
        stage: null,
        stages: [],
        pendingReviews: 0,
        updatedAt: null
    };
}

function readHandoff(repo) {
    const file = handoffPath(repo);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
        return { ...emptyHandoff(), ...parsed };
    } catch (error) {
        if (error.code === 'ENOENT') return emptyHandoff();
        throw new Error('读取前端交接文件失败：' + file + '：' + error.message);
    }
}

function writeHandoff(repo, value) {
    const file = handoffPath(repo);
    const normalized = {
        version: VERSION,
        mode: value?.mode === 'dsh' ? 'dsh' : 'codex',
        dshSessionId: typeof value?.dshSessionId === 'string' ? value.dshSessionId : '',
        repo: typeof value?.repo === 'string' ? value.repo : path.resolve(repo),
        stage: value?.stage ?? null,
        stages: Array.isArray(value?.stages) ? value.stages : [],
        pendingReviews: Number(value?.pendingReviews || 0),
        updatedAt: new Date().toISOString()
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(normalized, null, 2), 'utf8');
    fs.renameSync(temporary, file);
    return normalized;
}

function handoffDigest(value) {
    const stages = Array.isArray(value?.stages) ? value.stages : [];
    const lines = [
        '前端：' + (value?.mode === 'dsh' ? 'DSH' : 'Codex'),
        'DSH 会话 ID：' + (value?.dshSessionId || '未绑定'),
        '阶段数：' + stages.length,
        '待处理审查：' + Number(value?.pendingReviews || 0)
    ];
    for (const stage of stages.slice(0, 8)) {
        lines.push('- ' + (stage.id || '?') + ' · ' + (stage.display || stage.phase || '') +
            ' · ' + (stage.request || '').slice(0, 120));
    }
    if (value?.stage) lines.push('当前阶段：' + (value.stage.id || '') + ' · ' + (value.stage.display || ''));
    return lines.join('\n');
}

module.exports = {
    VERSION, FRONTEND_VERSION, MODES, frontendPath, handoffPath, emptyFrontend, readFrontend, writeFrontend,
    emptyHandoff, readHandoff, writeHandoff, handoffDigest
};
