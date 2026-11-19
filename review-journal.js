const fs = require('node:fs');
const path = require('node:path');

/**
 * 审查批次的磁盘日志。
 * 正常的 broker 仍在内存里等待 Promise；这里只负责两件事：
 * 1. 发出批次后落盘，VS Code 重载后仍知道 batchId 对应哪些提交；
 * 2. 重载后 Codex 用旧 batchId 提交结果时，校验后把结论暂存，
 *    等任务恢复执行时通过 take() 取走。
 */
class ReviewJournal {
    constructor(file) {
        this.file = file;
        this.data = { batches: {}, results: {} };
        this.load();
    }

    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''));
            this.data = {
                batches: parsed && typeof parsed.batches === 'object' ? parsed.batches : {},
                results: parsed && typeof parsed.results === 'object' ? parsed.results : {}
            };
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error('读取审查日志失败：' + error.message);
            this.data = { batches: {}, results: {} };
        }
        return this.data;
    }

    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const temporary = this.file + '.' + process.pid + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(this.data, null, 2), 'utf8');
        fs.renameSync(temporary, this.file);
    }

    recordBatch(batch) {
        this.load();
        this.data.batches[batch.id] = {
            id: batch.id,
            entries: batch.entries.map(entry => ({
                id: entry.id, stageId: entry.stageId, taskId: entry.taskId,
                label: entry.label, candidate: entry.candidate, base: entry.base,
                criteria: entry.criteria || [], requirements: entry.requirements
            })),
            createdAt: new Date().toISOString()
        };
        this.save();
    }

    clearBatch(batchId) {
        this.load();
        if (!this.data.batches[batchId]) return;
        delete this.data.batches[batchId];
        this.save();
    }

    openBatches() {
        this.load();
        return Object.values(this.data.batches);
    }

    accept(batchId, results) {
        this.load();
        const batch = this.data.batches[batchId];
        if (!batch) {
            const error = new Error('未找到待恢复的审查批次：' + batchId);
            error.code = 'UNKNOWN_BATCH';
            throw error;
        }
        if (!Array.isArray(results)) throw new Error('审查结果必须是数组');
        const byId = new Map();
        for (const result of results) {
            if (!result || typeof result !== 'object' || typeof result.id !== 'string' || !result.id) {
                throw new Error('审查结果缺少 id');
            }
            if (byId.has(result.id)) throw new Error('审查结果 id 重复：' + result.id);
            byId.set(result.id, result);
        }
        if (byId.size !== batch.entries.length) throw new Error('审查结果数量与批次不一致');
        for (const entry of batch.entries) {
            const result = byId.get(entry.id);
            if (!result) throw new Error('缺少审查结果：' + entry.id);
            if (!['pass', 'changes_requested', 'blocked'].includes(result.verdict)) {
                throw new Error('审查结论无效：' + entry.id);
            }
            if (entry.candidate && result.candidate !== entry.candidate) {
                throw new Error('审查候选提交与请求不一致：' + entry.id);
            }
            if (!Array.isArray(result.criteria) || result.criteria.length !== (entry.criteria || []).length) {
                throw new Error('审查验收项数量不一致：' + entry.id);
            }
            if (!Array.isArray(result.findings) || result.findings.some(finding =>
                !finding || typeof finding.path !== 'string' || !finding.path ||
                typeof finding.blocking !== 'boolean' || typeof finding.problem !== 'string' || !finding.problem ||
                typeof finding.correction !== 'string')) {
                throw new Error('审查发现的问题字段不完整：' + entry.id);
            }
            if (typeof result.summary !== 'string') throw new Error('审查摘要缺失：' + entry.id);
            const key = entry.stageId + '\u0000' + entry.label + '\u0000' + entry.candidate;
            this.data.results[key] = {
                stageId: entry.stageId, taskId: entry.label, candidate: entry.candidate,
                review: result, recoveredAt: new Date().toISOString()
            };
        }
        delete this.data.batches[batchId];
        this.save();
        return batch.entries.length;
    }

    take({ stageId, taskId, candidate }) {
        this.load();
        const key = stageId + '\u0000' + taskId + '\u0000' + candidate;
        const record = this.data.results[key];
        if (!record) return null;
        return record.review;
    }

    commit({ stageId, taskId, candidate }) {
        this.load();
        const key = stageId + '\u0000' + taskId + '\u0000' + candidate;
        if (!this.data.results[key]) return false;
        delete this.data.results[key];
        this.save();
        return true;
    }
}

module.exports = { ReviewJournal };
