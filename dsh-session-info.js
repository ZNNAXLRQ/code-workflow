'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function dshHome() {
    return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function validSessionId(id) {
    return typeof id === 'string' && /^session-[A-Za-z0-9-]+$/.test(id);
}

function projectionPath(id) {
    return path.join(dshHome(), 'storages', 'session_projcache', 'sessions', id + '.json');
}

function readDshSessionInfo(id) {
    if (!validSessionId(id)) return null;
    const file = projectionPath(id);
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('读取 DSH 会话缓存失败：' + file + '：' + error.message);
    }
    const rows = parsed?.record?.rows;
    const title = typeof rows?.title?.val === 'string' ? rows.title.val.trim() : '';
    const workingDirectory = typeof rows?.workingDirectory?.val === 'string' ? rows.workingDirectory.val : '';
    return { id, title: title || '', workingDirectory };
}

module.exports = { dshHome, validSessionId, projectionPath, readDshSessionInfo };
