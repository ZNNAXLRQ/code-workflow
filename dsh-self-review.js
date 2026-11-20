'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: sleep } = require('node:timers/promises');

function reviewDir(repo) {
    return path.join(path.resolve(repo), '.local-workflow', 'dsh-self-review');
}

function requestsDir(repo) {
    return path.join(reviewDir(repo), 'requests');
}

function resultsDir(repo) {
    return path.join(reviewDir(repo), 'results');
}

function validateResult(result) {
    if (!result || !['pass', 'changes_requested', 'blocked'].includes(result.verdict)) {
        throw new Error('主会话自审结果缺少合法 verdict');
    }
    if (typeof result.summary !== 'string') throw new Error('主会话自审结果缺少 summary');
    if (result.findings === undefined) result.findings = [];
    if (!Array.isArray(result.findings)) throw new Error('主会话自审结果 findings 必须是数组');
    return result;
}

/**
 * 把自审请求写到主仓库 .local-workflow，等待 DSH 主会话用 subagent 审完后
 * 把结果写到 results/<id>.json。主会话能直接看到请求，进度也在主会话里。
 */
async function runMainReview({ repo, where, data, label, signal, timeoutMs = 30 * 60 * 1000, pollMs = 2000, log = () => {} }) {
    const root = reviewDir(repo);
    const id = randomUUID();
    const requestFile = path.join(requestsDir(repo), id + '.json');
    const resultFile = path.join(resultsDir(repo), id + '.json');
    await fs.mkdir(requestsDir(repo), { recursive: true });
    await fs.mkdir(resultsDir(repo), { recursive: true });
    await fs.writeFile(requestFile, JSON.stringify({
        id, repo: path.resolve(repo), where, label, data, createdAt: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');
    log('[dsh-self-review] 等待主会话子智能体：' + id);
    const started = Date.now();
    try {
        while (true) {
            if (signal?.aborted) throw signal.reason || new Error('DSH 自审已取消');
            try {
                const result = JSON.parse(await fs.readFile(resultFile, 'utf8'));
                if (result.id === id) {
                    const validated = validateResult(result);
                    await fs.rm(resultFile, { force: true });
                    log('[dsh-self-review] 主会话结果：' + validated.verdict);
                    return validated;
                }
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
            if (Date.now() - started > timeoutMs) {
                throw new Error('等待主会话自审超时（' + Math.round(timeoutMs / 60000) + ' 分钟）');
            }
            try { await sleep(pollMs, undefined, { signal }); }
            catch (error) { if (signal?.aborted) throw signal.reason || error; throw error; }
        }
    } finally {
        await fs.rm(requestFile, { force: true }).catch(() => {});
    }
}

module.exports = { reviewDir, requestsDir, resultsDir, validateResult, runMainReview };
