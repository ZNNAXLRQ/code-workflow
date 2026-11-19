'use strict';

/**
 * review-broker 冒烟测试：node test/review-broker-smoke.cjs
 * 不访问网络、不启动模型，只用可控的 send 回调驱动合批与结论回落。
 */

const assert = require('node:assert/strict');
const { createReviewBroker } = require('../review-broker');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeout = 2000) {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeout) throw new Error('等待超时：' + label);
        await delay(5);
    }
}

let sequence = 0;

function makeEntry(overrides = {}) {
    sequence += 1;
    const taskId = 'task-' + sequence;
    const candidate = String(sequence).padStart(40, '0');
    return {
        id: 'entry-' + sequence,
        repo: 'D:/example/repo',
        stageId: 'stage-1',
        taskId,
        label: '任务 ' + taskId,
        candidate,
        base: 'b'.repeat(40),
        prompt: '审查候选提交 · ' + taskId,
        criteria: [{ id: taskId + '/A1', description: '验收项 1' }],
        testSummary: '测试通过',
        ...overrides
    };
}

function makeResult(entry, overrides = {}) {
    return {
        id: entry.id,
        verdict: 'pass',
        candidate: entry.candidate,
        criteria: entry.criteria.map((item, index) => ({
            id: item && typeof item === 'object' && item.id ? item.id : entry.taskId + '/A' + (index + 1),
            status: 'met',
            evidence: '差异与测试结果可见'
        })),
        findings: [],
        summary: '结论：通过',
        ...overrides
    };
}

function collector() {
    const batches = [];
    return {
        batches,
        send: async batch => { batches.push(batch); }
    };
}

async function openBatch(options, ...entries) {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5, ...options });
    const promises = entries.map(entry => broker.request(entry));
    await waitFor(() => sink.batches.length === 1, '批次生成');
    return { broker, sink, batch: sink.batches[0], promises };
}

/** 一次非法 resolve：整批 reject、同步抛错、批次只能处理一次。 */
async function expectInvalidResolve(buildResults, pattern) {
    const a = makeEntry();
    const b = makeEntry();
    const { broker, batch, promises } = await openBatch({}, a, b);
    const settled = Promise.allSettled(promises);
    assert.throws(() => broker.resolve(batch.id, buildResults(a, b)), pattern);
    const outcomes = await settled;
    assert.equal(outcomes.length, 2);
    assert.ok(outcomes.every(item => item.status === 'rejected'), '校验失败应 reject 整批 pending');
    assert.equal(broker.pendingCount(), 0);
    assert.throws(() => broker.resolve(batch.id, []), /已处理/, '失败批次再次 resolve 应抛错');
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('构造参数校验与空 flush', async () => {
    assert.throws(() => createReviewBroker(), /send/);
    assert.throws(() => createReviewBroker({ send: 1 }), /send/);
    assert.throws(() => createReviewBroker({ send: async () => {}, maxEntries: 0 }), /maxEntries/);
    assert.throws(() => createReviewBroker({ send: async () => {}, batchDelayMs: -1 }), /batchDelayMs/);
    assert.throws(() => createReviewBroker({ send: async () => {}, maxChars: 0 }), /maxChars/);
    assert.throws(() => createReviewBroker({ send: async () => {}, timeoutMs: 0 }), /timeoutMs/);

    const broker = createReviewBroker({ send: async () => {} });
    assert.equal(await broker.flush(), null, '无待审项时 flush 返回 null');
    assert.equal(broker.pendingCount(), 0);
    assert.deepEqual(broker.pending(), []);
    assert.equal(broker.stats.flushes, 0);
});

test('审查项校验缺 taskId / 类型错误时同步抛错', async () => {
    const broker = createReviewBroker({ send: async () => {} });
    assert.throws(() => broker.request(null), /审查项/);
    assert.throws(() => broker.request({ prompt: 'x' }), /taskId/);
    assert.throws(() => broker.request({ taskId: 't', criteria: 'bad' }), /criteria/);
    assert.throws(() => broker.request({ taskId: 't', prompt: 5 }), /prompt/);
    assert.throws(() => broker.request({ taskId: 't', candidate: 7 }), /candidate/);
    broker.cancelAll('清理');
    assert.equal(broker.pendingCount(), 0);
});

test('单条 request 在 batchDelayMs 后 flush，send 后保留 pending 等待 resolve', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 30 });
    const entry = makeEntry();
    const promise = broker.request(entry);

    assert.equal(sink.batches.length, 0, '请求后不应立刻 flush');
    assert.equal(broker.pendingCount(), 1);
    assert.equal(broker.pending()[0].id, entry.id);
    assert.equal(broker.pending()[0].entry.taskId, entry.taskId);
    assert.equal(broker.stats.flushes, 0);

    await waitFor(() => sink.batches.length === 1, '延迟 flush');
    const batch = sink.batches[0];
    assert.equal(batch.entries.length, 1);
    assert.equal(batch.entries[0].id, entry.id);
    assert.equal(typeof batch.id, 'string');
    assert.ok(batch.id.length > 0);
    assert.equal(broker.pendingCount(), 1, 'send 成功后仍保留 pending');
    assert.equal(broker.stats.flushes, 1);
    assert.deepEqual(broker.stats.sizes, [1]);

    const result = makeResult(entry);
    assert.equal(broker.resolve(batch.id, [result]), 1);
    assert.deepEqual(await promise, result);
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.resolved, 1);

    assert.throws(() => broker.resolve(batch.id, [result]), /已处理/, '同一批次只能 resolve 一次');
});

test('窗口内的两条 request 合成一批', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 50 });
    const a = makeEntry();
    const b = makeEntry();
    const pa = broker.request(a);
    await delay(10);
    const pb = broker.request(b);
    assert.equal(sink.batches.length, 0, '第二条不应立即 flush');
    assert.equal(broker.pendingCount(), 2);

    await waitFor(() => sink.batches.length === 1, '合批');
    assert.equal(sink.batches[0].entries.length, 2);
    assert.deepEqual(sink.batches[0].entries.map(entry => entry.id), [a.id, b.id]);
    assert.deepEqual(broker.stats.sizes, [2]);

    // 结论顺序与请求顺序无关
    assert.equal(broker.resolve(sink.batches[0].id, [makeResult(b), makeResult(a)]), 2);
    assert.equal((await pa).id, a.id);
    assert.equal((await pb).id, b.id);
    assert.equal(broker.pendingCount(), 0);
});

test('达到 maxEntries 立即 flush', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5000, maxEntries: 2 });
    const a = makeEntry();
    const b = makeEntry();
    const pa = broker.request(a);
    assert.equal(sink.batches.length, 0, '一条时仍等待窗口');
    const pb = broker.request(b);
    assert.equal(sink.batches.length, 1, '达到 maxEntries 应立即 flush');
    assert.equal(sink.batches[0].entries.length, 2);

    broker.resolve(sink.batches[0].id, [makeResult(a), makeResult(b)]);
    await Promise.all([pa, pb]);
    assert.equal(broker.pendingCount(), 0);
});

test('累计 prompt 字符达到 maxChars 立即 flush，单条超限也立即 flush', async () => {
    const sink = collector();
    const prompt = 'p'.repeat(30);
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5000, maxChars: 60 });
    const a = makeEntry({ prompt });
    const b = makeEntry({ prompt });
    const pa = broker.request(a);
    assert.equal(sink.batches.length, 0, '30 字符不足 60');
    const pb = broker.request(b);
    assert.equal(sink.batches.length, 1, '累计 60 字符应立即 flush');
    assert.equal(sink.batches[0].entries.length, 2);
    broker.resolve(sink.batches[0].id, [makeResult(a), makeResult(b)]);
    await Promise.all([pa, pb]);

    const lone = collector();
    const broker2 = createReviewBroker({ send: lone.send, batchDelayMs: 5000, maxChars: 10 });
    const entry = makeEntry({ prompt: 'x'.repeat(10) });
    const promise = broker2.request(entry);
    assert.equal(lone.batches.length, 1, '单条达到 maxChars 应立即 flush');
    assert.equal(lone.batches[0].entries.length, 1);
    broker2.resolve(lone.batches[0].id, [makeResult(entry)]);
    await promise;
});

test('send 失败时该批所有 request 都 reject', async () => {
    const batches = [];
    const failure = new Error('Codex 会话不可用');
    const broker = createReviewBroker({
        send: async batch => {
            batches.push(batch);
            throw failure;
        },
        batchDelayMs: 5
    });
    const a = makeEntry();
    const b = makeEntry();
    const guarded = Promise.all([
        assert.rejects(broker.request(a), /Codex 会话不可用/),
        assert.rejects(broker.request(b), /Codex 会话不可用/)
    ]);
    await waitFor(() => batches.length === 1, '批次生成');
    assert.equal(batches[0].entries.length, 2);
    await guarded;
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.sendFailures, 1);
    assert.equal(broker.stats.rejected, 2);
    assert.throws(() => broker.resolve(batches[0].id, []), /已处理/, '发送失败的批次不能补 resolve');
});

test('resolve 成功时逐条 resolve 并清除', async () => {
    const a = makeEntry();
    const b = makeEntry();
    const { broker, batch, promises } = await openBatch({}, a, b);
    const results = [makeResult(a), makeResult(b)];
    assert.equal(broker.resolve(batch.id, results), 2);
    const values = await Promise.all(promises);
    assert.deepEqual(values, results);
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.resolved, 2);
    assert.equal(broker.stats.sizes.length, 1);
});

test('缺项：results 少一条时整批抛错并 reject', async () => {
    await expectInvalidResolve(a => [makeResult(a)], /缺少审查 ID/);
});

test('多项：results 含批次外 ID 时整批抛错并 reject', async () => {
    await expectInvalidResolve((a, b) => [makeResult(a), makeResult(b), makeResult(makeEntry())], /不存在的审查 ID/);
});

test('重复 ID：results 同一 ID 出现两次时整批抛错并 reject', async () => {
    await expectInvalidResolve((a, b) => [makeResult(a), makeResult(b), makeResult(a)], /ID 重复/);
});

test('candidate 与候选提交不一致时整批抛错并 reject', async () => {
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { candidate: 'd'.repeat(40) }), makeResult(b)],
        /candidate 与候选提交不一致/
    );
});

test('非法 verdict 时整批抛错并 reject', async () => {
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { verdict: 'approve' }), makeResult(b)],
        /verdict 非法/
    );
});

test('criteria 数量与 entry.criteria 不一致时整批抛错并 reject', async () => {
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { criteria: [] }), makeResult(b)],
        /验收项数量不一致/
    );
});

test('findings 缺少基本字段或不是数组时整批抛错并 reject', async () => {
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { findings: [{ path: 'x.js', blocking: true, problem: '缺少修正' }] }), makeResult(b)],
        /correction/
    );
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { findings: 'none' }), makeResult(b)],
        /findings 必须是数组/
    );
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { findings: [{ path: '', blocking: true, problem: 'p', correction: 'c' }] }), makeResult(b)],
        /缺少 path/
    );
    await expectInvalidResolve(
        (a, b) => [makeResult(a, { findings: [{ path: 'x.js', blocking: 'yes', problem: 'p', correction: 'c' }] }), makeResult(b)],
        /blocking/
    );
});

test('entry 无 candidate 时不要求结果 candidate；缺 id 时自动生成', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5 });
    const entry = { taskId: 'task-no-candidate', prompt: '审查无候选 SHA 的项', criteria: [] };
    const promise = broker.request(entry);
    await waitFor(() => sink.batches.length === 1, '批次生成');
    const sent = sink.batches[0].entries[0];
    assert.equal(typeof sent.id, 'string');
    assert.ok(sent.id.length > 0, '缺 id 时应生成');
    assert.equal(sent.candidate, null);
    assert.equal(sent.label, sent.id, '缺 label 时回落到 id');
    assert.equal(broker.resolve(sink.batches[0].id, [
        { id: sent.id, verdict: 'blocked', criteria: [], findings: [], summary: '缺少候选 SHA' }
    ]), 1);
    assert.equal((await promise).verdict, 'blocked');
});

test('同一 taskId 重复 request 抛错，结算后可再次使用', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 20 });
    const entry = makeEntry({ taskId: 'dup-task' });
    const promise = broker.request(entry);
    const guarded = assert.rejects(promise, /清理/);
    assert.throws(() => broker.request(makeEntry({ taskId: 'dup-task' })), /已有待审候选/);
    broker.cancelAll('清理');
    await guarded;
    assert.equal(broker.pendingCount(), 0);

    // 同一 taskId 在新一轮可以重新提交
    const again = makeEntry({ taskId: 'dup-task' });
    const retry = broker.request(again);
    await waitFor(() => sink.batches.length === 1, '第二批生成');
    broker.resolve(sink.batches[0].id, [makeResult(again)]);
    await retry;
});

test('cancel 队列内条目与已发送批次；未知 id 返回 0', async () => {
    // 队列内：尚未 flush
    const queued = createReviewBroker({ send: async () => {}, batchDelayMs: 5000 });
    const entry = makeEntry();
    const guarded = assert.rejects(queued.request(entry), /阶段取消/);
    assert.equal(queued.cancel(entry.id, '阶段取消'), 1);
    await guarded;
    assert.equal(queued.pendingCount(), 0);
    assert.equal(queued.stats.cancelled, 1);
    assert.equal(queued.cancel(entry.id, '重复取消'), 0);
    assert.equal(queued.cancel('missing-id', '无此项'), 0);
    assert.equal(await queued.flush(), null, '取消后队列为空，flush 返回 null');

    // 已发送、等待结论
    const opened = await openBatch({}, makeEntry());
    const pending = assert.rejects(opened.promises[0], /阶段取消/);
    assert.equal(opened.broker.cancel(opened.batch.id, '阶段取消'), 1);
    await pending;
    assert.equal(opened.broker.pendingCount(), 0);
    assert.throws(() => opened.broker.resolve(opened.batch.id, []), /已处理|未找到/);
});

test('cancelAll 清空队列与多个未完成批次', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5, maxEntries: 1 });
    const entries = [makeEntry(), makeEntry(), makeEntry()];
    const promises = entries.map(entry => broker.request(entry));
    await waitFor(() => sink.batches.length === 3, '三个批次');
    assert.equal(broker.pendingCount(), 3);
    const guarded = Promise.all(promises.map(promise => assert.rejects(promise, /阶段取消/)));
    assert.equal(broker.cancelAll('阶段取消'), 3);
    await guarded;
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.cancelled, 3);

    // 队列内条目同样被 cancelAll 清除，且无需等待窗口
    const waiting = createReviewBroker({ send: async () => {}, batchDelayMs: 5000 });
    const a = makeEntry();
    const b = makeEntry();
    const waitingGuarded = Promise.all([
        assert.rejects(waiting.request(a), /停止执行/),
        assert.rejects(waiting.request(b), /停止执行/)
    ]);
    assert.equal(waiting.cancelAll('停止执行'), 2);
    await waitingGuarded;
    assert.equal(waiting.pendingCount(), 0);
});

test('超时后 reject 并清除，避免永久挂起', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5, timeoutMs: 40 });
    const entry = makeEntry();
    const promise = broker.request(entry);
    await waitFor(() => sink.batches.length === 1, '批次生成');
    const start = Date.now();
    await assert.rejects(promise, /没有返回结论/);
    assert.ok(Date.now() - start >= 30, '应等待 timeoutMs 后才超时');
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.timeouts, 1);
    assert.throws(() => broker.resolve(sink.batches[0].id, [makeResult(entry)]), /已处理|未找到/);
});

test('send 迟迟不返回时也会在超时后 reject', async () => {
    const broker = createReviewBroker({
        send: () => new Promise(() => {}),
        batchDelayMs: 5,
        timeoutMs: 40
    });
    const promise = broker.request(makeEntry());
    await assert.rejects(promise, /没有返回结论/);
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.timeouts, 1);
});

test('send 内同步 resolve 也受支持（宿主一次调用内完成送审与回落）', async () => {
    const broker = createReviewBroker({
        send: async batch => {
            const entry = batch.entries[0];
            assert.equal(broker.resolve(batch.id, [makeResult(entry)]), 1);
        },
        batchDelayMs: 5
    });
    const entry = makeEntry();
    const review = await broker.request(entry);
    assert.equal(review.id, entry.id);
    assert.equal(review.verdict, 'pass');
    assert.equal(broker.pendingCount(), 0);
    assert.equal(broker.stats.flushes, 1);
});

test('统计 flush 次数与每批大小', async () => {
    const sink = collector();
    const broker = createReviewBroker({ send: sink.send, batchDelayMs: 5, maxEntries: 2 });
    const a = makeEntry();
    const b = makeEntry();
    const c = makeEntry();
    const pa = broker.request(a);
    const pb = broker.request(b);
    const pc = broker.request(c);
    await waitFor(() => sink.batches.length === 2, '两批生成');
    assert.deepEqual(broker.stats.sizes, [2, 1]);
    assert.equal(broker.stats.flushes, 2);
    assert.equal(broker.stats.batches, 2);
    assert.equal(broker.stats.entries, 3);
    broker.resolve(sink.batches[0].id, [makeResult(a), makeResult(b)]);
    broker.resolve(sink.batches[1].id, [makeResult(c)]);
    await Promise.all([pa, pb, pc]);
    assert.equal(broker.stats.resolved, 3);
    assert.equal(broker.pendingCount(), 0);
});

(async () => {
    const failures = [];
    for (const { name, fn } of tests) {
        try {
            await fn();
            console.log('ok - ' + name);
        } catch (error) {
            failures.push({ name, error });
            console.error('not ok - ' + name + '\n' + (error?.stack ?? String(error)));
        }
    }
    if (failures.length) {
        console.error(failures.length + '/' + tests.length + ' 个用例失败');
        process.exitCode = 1;
        return;
    }
    console.log('review-broker smoke passed (' + tests.length + ' 个用例)');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
