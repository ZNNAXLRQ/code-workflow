'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const sessionInfo = require('./dsh-session-info');

function repositoryRoot(repo) {
    if (typeof repo !== 'string' || !repo.trim()) throw new Error('repo 必须是非空字符串路径');
    return path.resolve(repo.trim());
}

function dshBindingPath(repo) {
    return path.join(repositoryRoot(repo), '.local-workflow', 'dsh-binding.json');
}

function validateDshBinding(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DSH 绑定必须是普通对象');
    if (value.mode !== 'dsh') throw new Error("DSH 绑定的 mode 必须是 'dsh'");
    if (!sessionInfo.validSessionId(value.dshSessionId)) throw new Error('DSH 会话 ID 格式无效：' + value.dshSessionId);
    if (typeof value.title !== 'string') throw new Error('DSH 绑定缺少 title');
    if (typeof value.workingDirectory !== 'string') throw new Error('DSH 绑定缺少 workingDirectory');
    for (const key of ['boundAt', 'updatedAt']) {
        if (typeof value[key] !== 'string' || Number.isNaN(Date.parse(value[key]))) {
            throw new Error('DSH 绑定字段 ' + key + ' 不是合法时间戳');
        }
    }
    return value;
}

function readDshBinding(repo) {
    const file = dshBindingPath(repo);
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return validateDshBinding(parsed);
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        if (error instanceof SyntaxError) throw new Error('DSH 绑定文件已损坏：' + file);
        throw error;
    }
}

function writeDshBinding(repo, value) {
    const file = dshBindingPath(repo);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(temporary, file);
    return value;
}

function bindDsh(repo, dshSessionId, { replace = false } = {}) {
    if (!sessionInfo.validSessionId(dshSessionId)) throw new Error('DSH 会话 ID 格式无效：' + dshSessionId);
    const existing = readDshBinding(repo);
    if (existing && existing.dshSessionId !== dshSessionId && !replace) {
        const error = new Error('仓库已绑定 DSH 会话 ' + existing.dshSessionId + '，需要明确覆盖');
        error.code = 'EBOUND';
        error.binding = existing;
        throw error;
    }
    const info = sessionInfo.readDshSessionInfo(dshSessionId);
    const now = new Date().toISOString();
    const value = {
        version: 1,
        mode: 'dsh',
        repo: repositoryRoot(repo),
        dshSessionId,
        title: info?.title || '',
        workingDirectory: info?.workingDirectory || '',
        boundAt: existing?.boundAt || now,
        updatedAt: now
    };
    validateDshBinding(value);
    return writeDshBinding(repo, value);
}

function unbindDsh(repo) {
    const existing = readDshBinding(repo);
    if (!existing) return null;
    const file = dshBindingPath(repo);
    fs.rmSync(file, { force: true });
    return existing;
}

module.exports = { dshBindingPath, validateDshBinding, readDshBinding, bindDsh, unbindDsh };
