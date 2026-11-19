'use strict';

const assert = require('node:assert/strict');
const {
    DISPLAY_STATUSES,
    displayStatus,
    taskDisplay,
    waiting,
    progress,
    retryable,
    TRANSITIONS
} = require('../state-machine.js');

function expectWaiting(stage, waitingFor, reason) {
    const actual = waiting(stage);
    assert.equal(actual.waitingFor, waitingFor);
    assert.equal(typeof actual.reason, 'string');
    if (reason !== undefined) assert.equal(actual.reason, reason);
}

// --- 导出形态 -------------------------------------------------------------
assert.equal(DISPLAY_STATUSES.length, 7);
assert.deepEqual([...DISPLAY_STATUSES], ['排队中', '规划中', '实现中', '审查中', '修复中', '待验收', '已验收']);
assert.equal(typeof displayStatus, 'function');
assert.equal(typeof taskDisplay, 'function');
assert.equal(typeof waiting, 'function');
assert.equal(typeof progress, 'function');
assert.equal(typeof retryable, 'function');
assert.ok(TRANSITIONS && typeof TRANSITIONS === 'object');

// --- 正常实现 -------------------------------------------------------------
const implementing = {
    phase: '运行中',
    tasks: [
        { id: 'a', status: '已集成' },
        { id: 'b', status: '实现中' },
        { id: 'c', status: '排队中' }
    ]
};
assert.equal(displayStatus(implementing), '实现中');
expectWaiting(implementing, 'queue-position', '等待排队执行。');
assert.deepEqual(progress(implementing), {
    total: 3, queued: 1, implementing: 1, reviewing: 0, repairing: 0, integrated: 1
});
assert.equal(retryable(implementing), false);

// 测试中 / 集成中的阶段级任务仍算实现中。
assert.equal(displayStatus({ phase: '运行中', tasks: [{ status: '测试中' }] }), '实现中');
assert.equal(displayStatus({ phase: '运行中', tasks: [{ status: '集成中' }] }), '实现中');
// 运行中但暂时没有任务（刚批准、还没 tick）也归实现中，而不是审查中。
assert.equal(displayStatus({ phase: '运行中', tasks: [] }), '实现中');
expectWaiting({ phase: '运行中', tasks: [{ status: '实现中' }] }, 'none', '');

// --- 排队 / 依赖 / 冲突 ----------------------------------------------------
assert.equal(displayStatus({ phase: '运行中', tasks: [{ status: '排队中', reason: '等待依赖 a' }] }), '排队中');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队中', reason: '等待依赖 a' }] }, 'dependency', '等待依赖 a');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队中', reason: '写入范围与「x」冲突' }] },
    'scope-conflict', '写入范围与「x」冲突');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队中', reason: '排队等槽', reasonCode: 'impl-slot' }] },
    'impl-slot', '排队等槽');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队执行', reason: '等待实现槽' }] },
    'impl-slot', '等待实现槽');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队执行', reason: '等待测试槽' }] },
    'impl-slot', '等待测试槽');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队执行', reason: '等待 Codex 审查槽' }] },
    'review-slot', '等待 Codex 审查槽');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队中', reason: '已中断，工作树已保留' }] },
    'paused', '已中断，工作树已保留');
expectWaiting({ phase: '运行中', tasks: [{ status: '排队中', reason: '自定义排队原因' }] },
    'queue-position', '自定义排队原因');
// 多个排队任务时具体原因优先于无原因的纯排队。
expectWaiting({
    phase: '运行中',
    tasks: [
        { status: '排队中', reason: '普通排队' },
        { status: '排队中', reason: '等待依赖 b' }
    ]
}, 'dependency', '等待依赖 b');
// reasonCode 优先，退化兼容中文 reason 前缀。
expectWaiting({
    phase: '运行中',
    tasks: [{ status: '排队中', reason: '等待依赖 a', reasonCode: 'review-slot' }]
}, 'review-slot', '等待依赖 a');
expectWaiting({
    phase: '运行中',
    tasks: [{ status: '排队中', reason: '等待依赖 a', reasonCode: 'not-a-code' }]
}, 'dependency', '等待依赖 a');

// 空闲 + 流水线队列。
const idleWithQueue = { phase: '空闲', tasks: [], queue: [{ id: 'q1' }] };
assert.equal(displayStatus(idleWithQueue), '排队中');
expectWaiting(idleWithQueue, 'queue-position', '等待工作流处理排队任务。');
assert.equal(displayStatus({ phase: '空闲', tasks: [] }), null);

// --- 联合验收审查 ----------------------------------------------------------
assert.equal(displayStatus({ phase: '联合验收中', stageStep: '审查排队', tasks: [{ status: '已集成' }] }), '审查中');
assert.equal(displayStatus({ phase: '联合验收中', stageStep: '审查中', tasks: [{ status: '已集成' }] }), '审查中');
expectWaiting({ phase: '联合验收中', stageStep: '审查排队', tasks: [{ status: '已集成' }] },
    'review-slot', '等待阶段审查槽。');
// 阶段测试属于实现侧验证。
assert.equal(displayStatus({ phase: '联合验收中', stageStep: '测试排队', tasks: [{ status: '已集成' }] }), '实现中');
assert.equal(displayStatus({ phase: '联合验收中', stageStep: '测试中', tasks: [{ status: '已集成' }] }), '实现中');
expectWaiting({ phase: '联合验收中', stageStep: '测试排队', tasks: [{ status: '已集成' }] },
    'impl-slot', '等待阶段测试槽。');
// 没有 stageStep 时回退实现中。
assert.equal(displayStatus({ phase: '联合验收中', tasks: [{ status: '已集成' }] }), '实现中');
assert.equal(retryable({ phase: '联合验收中', stageStep: '审查中' }), false);

// --- 修复中 ----------------------------------------------------------------
assert.equal(displayStatus({
    phase: '运行中',
    stageRepairs: 1,
    tasks: [{ status: '排队中', round: 0 }, { status: '已集成' }]
}), '修复中');
assert.equal(displayStatus({
    phase: '运行中',
    tasks: [{ status: '排队中', round: 1 }, { status: '已集成' }]
}), '修复中');
// 需处理且仍有 pendingReview 也是返修上下文。
assert.equal(displayStatus({
    phase: '需处理',
    tasks: [{ status: '需处理', pendingReview: { candidate: 'sha' } }]
}), '修复中');
assert.equal(retryable({
    phase: '需处理',
    tasks: [{ status: '需处理', pendingReview: { candidate: 'sha' } }]
}), true);

// --- 需处理的归属 ----------------------------------------------------------
// 没有审查报告、没有返修上下文：实现/测试/集成中断 -> 实现中。
const blockedImpl = { phase: '需处理', message: '集成失败', tasks: [{ status: '需处理', reason: '测试失败' }] };
assert.equal(displayStatus(blockedImpl), '实现中');
expectWaiting(blockedImpl, 'blocked', '集成失败');
// 已有阶段审查报告（如审查 blocked）-> 审查中。
assert.equal(displayStatus({ phase: '需处理', stageReview: { verdict: 'blocked' }, tasks: [{ status: '已集成' }] }), '审查中');
assert.equal(retryable(blockedImpl), true);

// --- 待验收 / 已验收 -------------------------------------------------------
const awaiting = { phase: '待验收', tasks: [{ status: '已集成' }] };
assert.equal(displayStatus(awaiting), '待验收');
expectWaiting(awaiting, 'none', '');
assert.equal(retryable(awaiting), false);
assert.equal(progress(awaiting).integrated, 1);

const accepted = { phase: '已验收', tasks: [{ status: '已集成' }] };
assert.equal(displayStatus(accepted), '已验收');
assert.equal(retryable(accepted), false);

// --- 规划失败 / 规划中 / 待澄清 --------------------------------------------
const failed = { phase: '规划失败', message: '规划模型超时' };
assert.equal(displayStatus(failed), '规划中');
assert.equal(retryable(failed), true);
expectWaiting(failed, 'blocked', '规划模型超时');

assert.equal(displayStatus({ phase: '规划中' }), '规划中');
assert.equal(retryable({ phase: '规划中' }), false);
assert.equal(displayStatus({ phase: '规划已中断' }), '规划中');
assert.equal(retryable({ phase: '规划已中断' }), true);

const clarifying = { phase: '待澄清', question: '需要哪条测试命令？' };
assert.equal(displayStatus(clarifying), '规划中');
expectWaiting(clarifying, 'user-answer', '需要哪条测试命令？');
assert.equal(displayStatus({ phase: '待确认方案', title: '方案' }), '规划中');
expectWaiting({ phase: '待确认方案', title: '方案' }, 'user-answer', '等待确认方案。');

// --- 已取消（7 态之外） ----------------------------------------------------
assert.equal(displayStatus({ phase: '已取消', message: '已取消' }), null);
assert.equal(retryable({ phase: '已取消' }), true);
expectWaiting({ phase: '已取消', message: '已取消' }, 'blocked', '已取消');
// 无可推进任务同样不落入 7 态。
assert.equal(displayStatus({ phase: '无可推进任务', message: '没有任务' }), null);

// --- 暂停 ------------------------------------------------------------------
const paused = { phase: '已暂停', message: '所有执行已暂停', tasks: [{ status: '实现中' }] };
assert.equal(displayStatus(paused), '实现中');
expectWaiting(paused, 'paused', '所有执行已暂停');
assert.equal(retryable(paused), false);

const pausing = { phase: '已请求暂停', tasks: [{ status: '排队中' }] };
assert.equal(displayStatus(pausing), '排队中');
assert.equal(waiting(pausing).waitingFor, 'paused');
// 全局暂停优先于任务级排队原因。
expectWaiting({
    phase: '运行中',
    pipelinePaused: true,
    tasks: [{ status: '排队中', reason: '等待依赖 a' }]
}, 'paused', '工作流已暂停，等待继续。');
// 返回暂停流程中的规划中断也视为暂停。
expectWaiting({ phase: '规划已中断', pipelineSuspended: true }, 'paused', '工作流已暂停，等待继续。');

// --- progress 计数 ---------------------------------------------------------
const counted = {
    phase: '运行中',
    tasks: [
        { status: '排队中' },
        { status: '排队执行' },
        { status: '实现中' },
        { status: '测试中' },
        { status: '审查中' },
        { status: '需处理' },
        { status: '已集成' },
        { status: '已取消' }
    ]
};
assert.deepEqual(progress(counted), {
    total: 8, queued: 2, implementing: 2, reviewing: 1, repairing: 1, integrated: 1
});
assert.deepEqual(progress({ phase: '空闲', tasks: [] }),
    { total: 0, queued: 0, implementing: 0, reviewing: 0, repairing: 0, integrated: 0 });
assert.deepEqual(progress({ phase: '运行中' }),
    { total: 0, queued: 0, implementing: 0, reviewing: 0, repairing: 0, integrated: 0 });

// --- taskDisplay -----------------------------------------------------------
assert.equal(taskDisplay({ status: '排队中' }), '排队中');
assert.equal(taskDisplay({ status: '准备中' }), '排队中');
assert.equal(taskDisplay({ status: '排队执行' }), '排队中');
assert.equal(taskDisplay({ status: '实现中' }), '实现中');
assert.equal(taskDisplay({ status: '测试中' }), '实现中');
assert.equal(taskDisplay({ status: '审查中' }), '实现中');
assert.equal(taskDisplay({ status: '集成中' }), '实现中');
assert.equal(taskDisplay({ status: '取消中' }), '实现中');
assert.equal(taskDisplay({ status: '需处理' }), '修复中');
assert.equal(taskDisplay({ status: '已集成' }), null);
assert.equal(taskDisplay({ status: '已取消' }), null);
assert.equal(taskDisplay(null), null);
assert.equal(taskDisplay({}), null);

// --- 队列 / 收件箱 ---------------------------------------------------------
expectWaiting({ phase: '运行中', inbox: [{ id: 'a', text: '请补充文件范围' }] },
    'user-answer', '请补充文件范围');
expectWaiting({ phase: '运行中', tasks: [{ status: '需处理', reason: '同一问题重复' }] },
    'blocked', '同一问题重复');

// --- retryable 的剩余边界 --------------------------------------------------
assert.equal(retryable({ phase: '运行中', tasks: [{ status: '实现中' }] }), false);
assert.equal(retryable({ phase: '联合验收中', stageStep: '审查中' }), false);
assert.equal(retryable({ phase: '需处理', message: '阶段返修已达上限或重复：x' }), true);
assert.equal(retryable({ phase: '规划失败', maxRepairs: 3, stageRepairs: 3 }), true);
assert.equal(retryable(null), false);
assert.equal(retryable({}), false);

// --- TRANSITIONS -----------------------------------------------------------
assert.ok(Object.isFrozen(TRANSITIONS));
assert.deepEqual(TRANSITIONS.approve, ['待确认方案']);
assert.deepEqual(TRANSITIONS.resume, ['已暂停', '需处理']);
assert.ok(TRANSITIONS.steer.includes('规划中'));
assert.ok(TRANSITIONS.steer.includes('运行中'));
assert.ok(TRANSITIONS.steer.includes('联合验收中'));
assert.ok(!TRANSITIONS.steer.includes('待验收'));
assert.deepEqual(TRANSITIONS.retry, ['规划失败', '规划已中断', '待澄清', '待确认方案']);
assert.deepEqual(TRANSITIONS.cancel, ['已暂停', '规划已中断', '规划失败', '待澄清', '待确认方案', '需处理']);
assert.deepEqual(TRANSITIONS.accept, ['待验收', '待重新验证']);
assert.deepEqual(TRANSITIONS.reject, ['待验收']);
assert.deepEqual(TRANSITIONS.rollback, ['已暂停', '需处理']);
assert.deepEqual(TRANSITIONS.answerTask, ['运行中', '需处理']);
for (const phases of Object.values(TRANSITIONS)) {
    assert.ok(Array.isArray(phases));
    assert.ok(Object.isFrozen(phases));
}

console.log('state-machine smoke tests passed');
