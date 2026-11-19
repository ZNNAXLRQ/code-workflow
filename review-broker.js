'use strict';

/**
 * 审查代理：把短窗口内就绪的候选提交合成一批交给 Codex，再按批返回逐条结论。
 *
 * 与「每个任务单独叫一次 Codex」不同，这里分两段：
 *   1. request(entry) 收集候选；flush() 生成 batch = { id, entries } 并调用 send(batch)。
 *      send 只负责把人类可读的审查请求送进 Codex（渠道由宿主决定），送完立即返回。
 *   2. Codex 给出结论后，宿主调用 resolve(batchId, results) 逐条校验并 settle 对应 request。
 *
 * 纯 CommonJS，不依赖 vscode、网络、模型或 Git，可在 node 中单独测试。
 */

const { randomUUID } = require('node:crypto');

const VERDICTS = Object.freeze(['pass', 'changes_requested', 'blocked']);
const SETTLED_HISTORY = 128;

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
}

function checkDelay(value, name, fallback) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(name + ' 必须是非负数');
    }
    return value;
}

function checkPositive(value, name, fallback, integer = false) {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 ||
        (integer && !Number.isInteger(value))) {
        throw new TypeError(name + ' 必须是正' + (integer ? '整数' : '数'));
    }
    return value;
}

/** 规范化审查项，保留宿主附加的字段（如 where/data），但固定本模块用到的字段类型。 */
function normalizeEntry(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw fail('INVALID_ENTRY', '审查项必须是对象');
    }
    if (typeof raw.taskId !== 'string' || !raw.taskId.trim()) {
        throw fail('INVALID_ENTRY', '审查项缺少非空 taskId');
    }
    if (raw.id !== undefined && (typeof raw.id !== 'string' || !raw.id.trim())) {
        throw fail('INVALID_ENTRY', '审查项 id 必须是非空字符串');
    }
    if (raw.prompt !== undefined && typeof raw.prompt !== 'string') {
        throw fail('INVALID_ENTRY', '审查项 prompt 必须是字符串');
    }
    if (raw.criteria !== undefined && !Array.isArray(raw.criteria)) {
        throw fail('INVALID_ENTRY', '审查项 criteria 必须是数组');
    }
    if (raw.candidate !== undefined && raw.candidate !== null && typeof raw.candidate !== 'string') {
        throw fail('INVALID_ENTRY', '审查项 candidate 必须是字符串');
    }
    if (raw.base !== undefined && raw.base !== null && typeof raw.base !== 'string') {
        throw fail('INVALID_ENTRY', '审查项 base 必须是字符串');
    }
    const id = raw.id === undefined ? randomUUID() : raw.id;
    const entry = { ...raw, id, taskId: raw.taskId };
    entry.label = typeof raw.label === 'string' && raw.label ? raw.label : id;
    entry.prompt = typeof raw.prompt === 'string' ? raw.prompt : '';
    entry.criteria = Array.isArray(raw.criteria) ? raw.criteria.slice() : [];
    entry.candidate = raw.candidate === undefined ? null : raw.candidate;
    entry.base = raw.base === undefined ? null : raw.base;
    entry.testSummary = raw.testSummary === undefined ? '' : raw.testSummary;
    return entry;
}

function validateFinding(label, finding, index) {
    const where = label + ' 的第 ' + (index + 1) + ' 条 finding';
    if (!finding || typeof finding !== 'object' || Array.isArray(finding)) {
        throw fail('INVALID_FINDING', where + ' 必须是对象');
    }
    if (typeof finding.path !== 'string' || !finding.path.trim()) {
        throw fail('INVALID_FINDING', where + ' 缺少 path');
    }
    if (typeof finding.blocking !== 'boolean') {
        throw fail('INVALID_FINDING', where + ' 缺少 blocking 布尔值');
    }
    if (typeof finding.problem !== 'string' || !finding.problem.trim()) {
        throw fail('INVALID_FINDING', where + ' 缺少 problem');
    }
    if (typeof finding.correction !== 'string') {
        throw fail('INVALID_FINDING', where + ' 缺少 correction');
    }
}

/** 单条结果校验：verdict、candidate、criteria 数量、findings 基本字段、summary。 */
function validateResult(entry, result) {
    const label = '审查项 ' + entry.id;
    if (!VERDICTS.includes(result.verdict)) {
        throw fail('INVALID_VERDICT',
            label + ' 的 verdict 非法：' + String(result.verdict) + '（应为 ' + VERDICTS.join(' / ') + '）');
    }
    if (entry.candidate !== null && entry.candidate !== undefined && result.candidate !== entry.candidate) {
        throw fail('CANDIDATE_MISMATCH',
            label + ' 的 candidate 与候选提交不一致：期望 ' + entry.candidate + '，实际 ' + String(result.candidate));
    }
    if (!Array.isArray(result.criteria)) {
        throw fail('INVALID_CRITERIA', label + ' 的 criteria 必须是数组');
    }
    if (result.criteria.length !== entry.criteria.length) {
        throw fail('CRITERIA_COUNT',
            label + ' 的验收项数量不一致：期望 ' + entry.criteria.length + '，实际 ' + result.criteria.length);
    }
    if (!Array.isArray(result.findings)) {
        throw fail('INVALID_FINDINGS', label + ' 的 findings 必须是数组');
    }
    result.findings.forEach((finding, index) => validateFinding(label, finding, index));
    if (typeof result.summary !== 'string') {
        throw fail('INVALID_SUMMARY', label + ' 缺少 summary 文本');
    }
}

/**
 * createReviewBroker({ send, batchDelayMs, maxEntries, maxChars, timeoutMs, log })
 *
 * send(batch) 为 async 回调，batch = { id, entries }。
 * 返回的 broker 暴露 request / flush / resolve / pending / pendingCount / cancel / cancelAll / stats。
 */
function createReviewBroker({
    send,
    batchDelayMs = 1500,
    maxEntries = 8,
    maxChars = 120000,
    timeoutMs = 10 * 60 * 1000,
    log = () => {}
} = {}) {
    if (typeof send !== 'function') throw new TypeError('createReviewBroker 需要 send(batch) 回调');
    if (typeof log !== 'function') throw new TypeError('log 必须是函数');
    batchDelayMs = checkDelay(batchDelayMs, 'batchDelayMs', 1500);
    maxEntries = checkPositive(maxEntries, 'maxEntries', 8, true);
    maxChars = checkPositive(maxChars, 'maxChars', 120000);
    timeoutMs = checkPositive(timeoutMs, 'timeoutMs', 10 * 60 * 1000);

    const queue = [];                    // 尚未 flush 的待审项
    const pendingById = new Map();       // 未结束的待审项（含已发送、等待结论的）
    const pendingByTaskId = new Map();
    const batches = new Map();           // 已 flush、等待 resolve 的批次
    const settledBatches = new Map();    // batchId -> 'resolved' | 'rejected'，用于识别重复 resolve
    let timer;

    const stats = {
        flushes: 0,          // 实际生成批次的次数
        batches: 0,          // 同 flushes，便于按语义读取
        sizes: [],           // 每批条数
        entries: 0,          // 累计送入批次的候选数
        resolved: 0,
        rejected: 0,         // 含发送失败、超时、校验失败
        cancelled: 0,
        timeouts: 0,
        sendFailures: 0
    };

    function clearTimer() {
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    }

    function queuedChars() {
        return queue.reduce((sum, record) => sum + record.entry.prompt.length, 0);
    }

    function createRecord(entry) {
        let resolvePromise, rejectPromise;
        const promise = new Promise((resolve, reject) => {
            resolvePromise = resolve;
            rejectPromise = reject;
        });
        return {
            id: entry.id,
            taskId: entry.taskId,
            entry,
            promise,
            resolve: resolvePromise,
            reject: rejectPromise,
            batchId: null,
            settled: false
        };
    }

    function fulfill(record, result) {
        if (record.settled) return false;
        record.settled = true;
        pendingById.delete(record.id);
        pendingByTaskId.delete(record.taskId);
        stats.resolved++;
        record.resolve(result);
        return true;
    }

    function rejectRecord(record, error, kind) {
        if (record.settled) return false;
        record.settled = true;
        pendingById.delete(record.id);
        pendingByTaskId.delete(record.taskId);
        if (kind === 'cancelled') stats.cancelled++;
        else stats.rejected++;
        record.reject(error);
        return true;
    }

    function closeBatch(state, outcome) {
        if (state.settled) return;
        state.settled = true;
        if (state.timer !== undefined) {
            clearTimeout(state.timer);
            state.timer = undefined;
        }
        batches.delete(state.id);
        settledBatches.set(state.id, outcome);
        while (settledBatches.size > SETTLED_HISTORY) {
            settledBatches.delete(settledBatches.keys().next().value);
        }
    }

    function rejectBatch(state, error) {
        if (state.settled) return 0;
        closeBatch(state, 'rejected');
        let count = 0;
        for (const record of state.records) {
            if (rejectRecord(record, error)) count++;
        }
        return count;
    }

    /** 校验整批结果；任何一条不合法都抛错，由 resolve 负责整批 reject。 */
    function validateResults(state, results) {
        if (!Array.isArray(results)) throw fail('INVALID_RESULTS', 'resolve 的 results 必须是数组');
        const records = new Map(state.records.map(record => [record.id, record]));
        const seen = new Map();
        for (const result of results) {
            if (!result || typeof result !== 'object' || Array.isArray(result)) {
                throw fail('INVALID_RESULTS', '审查结果必须是对象');
            }
            if (typeof result.id !== 'string' || !result.id) {
                throw fail('INVALID_RESULTS', '审查结果缺少非空 id');
            }
            if (seen.has(result.id)) {
                throw fail('INVALID_RESULTS', '审查结果中 ID 重复：' + result.id);
            }
            const record = records.get(result.id);
            if (!record) {
                throw fail('INVALID_RESULTS', '审查结果包含批次内不存在的审查 ID：' + result.id);
            }
            seen.set(result.id, result);
        }
        const items = [];
        for (const [id, record] of records) {
            if (record.settled) continue; // 已单独取消的条目不再要求结果
            const result = seen.get(id);
            if (!result) throw fail('INVALID_RESULTS', '审查结果缺少审查 ID：' + id);
            validateResult(record.entry, result);
            items.push({ record, result });
        }
        return items;
    }

    function cancelRecord(record, reason) {
        if (!record || record.settled) return false;
        const error = reason instanceof Error ? reason
            : fail('CANCELLED', typeof reason === 'string' && reason ? reason : '审查已取消');
        if (!error.code) error.code = 'CANCELLED';
        const index = queue.indexOf(record);
        if (index >= 0) {
            queue.splice(index, 1);
            if (!queue.length) clearTimer();
        }
        if (record.batchId) {
            const state = batches.get(record.batchId);
            if (state) {
                state.live.delete(record.id);
                state.cancelled.add(record.id);
            }
        }
        rejectRecord(record, error, 'cancelled');
        if (record.batchId) {
            const state = batches.get(record.batchId);
            if (state && state.live.size === 0) closeBatch(state, 'rejected');
        }
        return true;
    }

    /**
     * 把 entry 放进待审队列。返回 Promise，在 resolve / cancel / 超时 / 发送失败后 settle。
     * 同一个 taskId 仍在队列或等待结论时重复 request 会同步抛错。
     */
    function request(raw) {
        const entry = normalizeEntry(raw);
        if (pendingByTaskId.has(entry.taskId)) {
            throw fail('DUPLICATE_TASK', '同一 taskId 已有待审候选：' + entry.taskId);
        }
        if (pendingById.has(entry.id)) {
            throw fail('DUPLICATE_ENTRY_ID', '审查项 id 重复：' + entry.id);
        }
        const record = createRecord(entry);
        queue.push(record);
        pendingById.set(record.id, record);
        pendingByTaskId.set(record.taskId, record);
        log('收到审查候选 ' + entry.id + '（' + entry.taskId + '），待审 ' + pendingById.size + ' 项');
        if (queue.length >= maxEntries || queuedChars() >= maxChars) {
            void flush().catch(error => log('审查批次 flush 异常：' + (error?.message ?? error)));
        } else if (timer === undefined) {
            timer = setTimeout(() => {
                timer = undefined;
                void flush().catch(error => log('审查批次 flush 异常：' + (error?.message ?? error)));
            }, batchDelayMs);
        }
        return record.promise;
    }

    /**
     * 取当前队列生成批次并调用 send。
     * send 失败时 reject 该批全部 pending；成功则保留 pending 等待 resolve。
     * 返回批次 id（无待审项时返回 null）。
     */
    async function flush() {
        clearTimer();
        const records = queue.splice(0, queue.length);
        if (!records.length) return null;
        const id = randomUUID();
        const state = {
            id,
            records,
            live: new Set(records.map(record => record.id)),
            cancelled: new Set(),
            settled: false,
            timer: undefined
        };
        for (const record of records) record.batchId = id;
        batches.set(id, state);
        stats.flushes++;
        stats.batches++;
        stats.sizes.push(records.length);
        stats.entries += records.length;
        log('flush 审查批次 ' + id + '：' + records.length + ' 项');
        // 超时从批次生成起算：即使 send 一直不返回，也不会让 request 永久挂起。
        state.timer = setTimeout(() => {
            const error = fail('TIMEOUT', '审查批次 ' + id + ' 在 ' + timeoutMs + 'ms 内没有返回结论');
            stats.timeouts++;
            log(error.message);
            rejectBatch(state, error);
        }, timeoutMs);
        try {
            await send({ id, entries: records.map(record => record.entry) });
        } catch (error) {
            if (state.settled) return id; // 已超时或被取消，不再重复计数
            const failure = error instanceof Error ? error : fail('SEND_FAILED', '审查发送失败：' + String(error));
            if (!failure.code) failure.code = 'SEND_FAILED';
            stats.sendFailures++;
            log('审查批次 ' + id + ' 发送失败：' + failure.message);
            rejectBatch(state, failure);
            return id;
        }
        return id;
    }

    /**
     * 用 Codex 的逐条结论 settle 一批 pending。
     * 校验失败会 reject 整批并同步抛错；同一批次只能成功处理一次。
     * 返回成功 resolve 的条数。
     */
    function resolve(batchId, results) {
        if (typeof batchId !== 'string' || !batchId) {
            throw fail('UNKNOWN_BATCH', 'resolve 需要批次 id');
        }
        const state = batches.get(batchId);
        if (!state || state.settled) {
            const outcome = settledBatches.get(batchId);
            if (outcome) throw fail('BATCH_SETTLED', '批次 ' + batchId + ' 已处理（' + outcome + '），不能重复 resolve');
            throw fail('UNKNOWN_BATCH', '未找到待 resolve 的审查批次：' + batchId);
        }
        let items;
        try {
            items = validateResults(state, results);
        } catch (error) {
            log('审查批次 ' + batchId + ' 结果校验失败：' + error.message);
            rejectBatch(state, error);
            throw error;
        }
        closeBatch(state, 'resolved');
        let count = 0;
        for (const { record, result } of items) {
            if (fulfill(record, result)) count++;
        }
        log('审查批次 ' + batchId + ' 已返回 ' + count + ' 条结论');
        return count;
    }

    function pending() {
        return [...pendingById.values()].map(record => ({ id: record.id, entry: record.entry }));
    }

    function pendingCount() {
        return pendingById.size;
    }

    /** 取消单个待审项（按 entry id）或整批（按 batch id），reject 并清除。返回取消条数。 */
    function cancel(id, reason) {
        if (typeof id !== 'string' || !id) return 0;
        const record = pendingById.get(id);
        if (record) return cancelRecord(record, reason) ? 1 : 0;
        const state = batches.get(id);
        if (!state) return 0;
        let count = 0;
        for (const item of state.records) {
            if (cancelRecord(item, reason)) count++;
        }
        return count;
    }

    /** 阶段取消：reject 并清除所有待审项（队列内与等待结论的）。返回取消条数。 */
    function cancelAll(reason) {
        const error = reason instanceof Error ? reason
            : fail('CANCELLED', typeof reason === 'string' && reason ? reason : '审查已取消');
        if (!error.code) error.code = 'CANCELLED';
        clearTimer();
        const records = [...pendingById.values()];
        for (const record of records) {
            if (record.batchId) {
                const state = batches.get(record.batchId);
                if (state) {
                    state.live.delete(record.id);
                    state.cancelled.add(record.id);
                }
            }
            rejectRecord(record, error, 'cancelled');
        }
        queue.length = 0;
        for (const state of [...batches.values()]) closeBatch(state, 'rejected');
        if (records.length) log('已取消 ' + records.length + ' 项审查：' + error.message);
        return records.length;
    }

    function openBatches() {
        return [...batches.values()]
            .filter(state => !state.settled && state.records.some(record => state.live.has(record.id)))
            .map(state => ({
                id: state.id,
                entries: state.records
                    .filter(record => state.live.has(record.id) && !state.cancelled.has(record.id))
                    .map(record => record.entry)
            }));
    }

    return {
        request,
        flush,
        resolve,
        pending,
        pendingCount,
        openBatches,
        cancel,
        cancelAll,
        stats,
        batchDelayMs,
        maxEntries,
        maxChars,
        timeoutMs
    };
}

module.exports = { createReviewBroker, VERDICTS };
