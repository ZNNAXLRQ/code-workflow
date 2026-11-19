'use strict';

/**
 * 展示状态模块：把 workflow.js 的原始阶段/任务状态压缩成 7 个展示状态。
 *
 * 纯 CommonJS，不依赖 vscode、fs 或其他模块，可直接在 Node 测试和 webview 宿主里使用。
 *
 * 原始取值来源（workflow.js / panel.js）：
 * - stage.phase：空闲、规划中、规划已中断、规划失败、待澄清、待确认方案、运行中、
 *   已请求暂停、已暂停、联合验收中、待验收、已验收、需处理、已取消、无可推进任务。
 * - stage.stageStep：测试排队、测试中、审查排队、审查中（仅联合验收中出现）。
 * - task.status：排队中、准备中、排队执行、实现中、测试中、审查中、集成中、
 *   需处理、取消中、已取消、已集成。
 * - task.round、stage.stageRepairs：返修轮次 / 阶段返修次数。
 * - task.reasonCode（新）与 task.reason（现有中文前缀）描述排队原因。
 */

/** 7 个展示状态。顺序即 UI 建议的展示顺序。 */
const DISPLAY_STATUSES = Object.freeze([
    '排队中',
    '规划中',
    '实现中',
    '审查中',
    '修复中',
    '待验收',
    '已验收'
]);

/** waiting() 的 waitingFor 取值。 */
const WAITING_FOR_VALUES = Object.freeze([
    'none',
    'queue-position',
    'dependency',
    'impl-slot',
    'scope-conflict',
    'review-slot',
    'user-answer',
    'paused',
    'blocked'
]);

const WAITING_FOR_SET = new Set(WAITING_FOR_VALUES);

/** 规划阶段：对外统一显示“规划中”，其中“待澄清”等待用户答复，失败/中断可重试。 */
const PLANNING_PHASES = new Set(['规划中', '待澄清', '待确认方案', '规划失败', '规划已中断']);

/** 执行阶段：实现、暂停都在这一组里区分任务是否仍在运行。 */
const RUNNING_PHASES = new Set(['运行中', '已请求暂停', '已暂停']);

/** 任务仍在执行流水线中（占用或即将占用实现/测试/审查槽）。 */
const ACTIVE_TASK_STATUSES = new Set(['准备中', '排队执行', '实现中', '测试中', '审查中', '集成中', '取消中']);

/** 除“已集成”“已取消”外的任务状态，taskDisplay 都应给出 7 态中的一种。 */
const TASK_QUEUED_STATUSES = new Set(['排队中', '排队执行', '准备中']);

const DEFAULT_WAITING_REASON = Object.freeze({
    none: '',
    'queue-position': '等待排队执行。',
    dependency: '等待依赖任务完成。',
    'impl-slot': '等待实现槽。',
    'scope-conflict': '写入范围与其他任务冲突。',
    'review-slot': '等待审查槽。',
    'user-answer': '等待用户答复。',
    paused: '工作流已暂停。',
    blocked: '需要用户处理。'
});

/** 引擎里的返修上限提示（workflow.js 的 repair/stageRepair 抛出的原文）。 */
const REPAIR_LIMIT_MESSAGE = /返修上限|返修已达上限|超过返修上限|达到自动返修上限/;

/**
 * 动作 -> 允许的原始 phase 列表，供后续 action 校验。
 * 取值直接对照 workflow.js 的 action() / canCancelStage() / setPipelinePaused()。
 */
const TRANSITIONS = Object.freeze({
    // action(): `command === 'approve' && phase === '待确认方案'`
    approve: Object.freeze(['待确认方案']),
    // action(): resume 仅允许已暂停、需处理
    resume: Object.freeze(['已暂停', '需处理']),
    // action(): 规划中插话（重规划），以及运行中/联合验收中的阶段级插话
    steer: Object.freeze(['规划中', '运行中', '联合验收中']),
    // action(): retry 与 answerPlan/revise/retry 都接受规划中断/失败与待澄清/待确认
    retry: Object.freeze(['规划失败', '规划已中断', '待澄清', '待确认方案']),
    // canCancelStage(): 只有这些阶段允许取消整项任务
    cancel: Object.freeze(['已暂停', '规划已中断', '规划失败', '待澄清', '待确认方案', '需处理']),
    accept: Object.freeze(['待验收', '待重新验证']),
    reject: Object.freeze(['待验收']),
    // action(): rollback 仅允许已暂停、需处理
    rollback: Object.freeze(['已暂停', '需处理']),
    // action(): answerTask 仅允许运行中、需处理
    answerTask: Object.freeze(['运行中', '需处理'])
});

function tasksOf(stage) {
    return stage && Array.isArray(stage.tasks) ? stage.tasks.filter(task => task && typeof task === 'object') : [];
}

function queuedWorkCount(stage, tasks) {
    if (!stage || typeof stage !== 'object') return 0;
    // 流水线队列挂在 Workflow 实例上，不在 stage.state 里；调用方若把队列一并传入，也兼容。
    if (Array.isArray(stage.queue)) return stage.queue.length;
    if (Array.isArray(stage.pipelineQueue)) return stage.pipelineQueue.length;
    if (Number.isFinite(stage.queued) && stage.queued > 0) return stage.queued;
    // 退化为：阶段自身还有排队中的子任务。
    return tasks.filter(task => task.status === '排队中' || task.status === '排队执行').length;
}

function isPaused(stage) {
    return stage.pipelinePaused === true || stage.pipelineSuspended === true ||
        stage.phase === '已请求暂停' || stage.phase === '已暂停';
}

/**
 * 是否存在返修上下文：
 * - 阶段返修过（stageRepairs > 0，finishStage/stageRepair 写入）；
 * - 子任务返修过（round > 0，repair() 每次失败/返修 +1）；
 * - 需处理且仍有 pendingReview（测试通过、等审查时中断，workflow tick 的判定）。
 */
function hasRepairContext(stage) {
    const tasks = tasksOf(stage);
    if (Number(stage.stageRepairs) > 0) return true;
    if (tasks.some(task => Number(task.round) > 0)) return true;
    return stage.phase === '需处理' && tasks.some(task => Boolean(task.pendingReview));
}

/**
 * 是否已经到达返修上限。
 * stage.maxRepairs 不是 state.json 的固定字段，因此优先识别引擎抛出的提示；
 * 调用方如果显式带上 maxRepairs / repairLimitHit，也可以直接判断。
 */
function repairLimitReached(stage) {
    if (!stage || typeof stage !== 'object') return false;
    if (stage.repairLimitHit === true || stage.repairLimit === true) return true;
    const limit = Number(stage.maxRepairs ?? (stage.config && stage.config.maxRepairs));
    if (Number.isFinite(limit) && limit >= 0) {
        if (Number(stage.stageRepairs) >= limit && Number(stage.stageRepairs) > 0) return true;
        if (tasksOf(stage).some(task => Number(task.round) >= limit && Number(task.round) > 0)) return true;
    }
    return typeof stage.message === 'string' && REPAIR_LIMIT_MESSAGE.test(stage.message);
}

/**
 * 派生 7 个展示状态之一；已取消等终止态返回 null，由调用方从活动列表移除。
 *
 * 归属规则（与 workflow.js 的真实流转对应）：
 * - 已验收 / 待验收：直接对应。
 * - 规划中/待澄清/待确认方案/规划失败/规划已中断：规划中。
 * - 联合验收中：stageStep 为审查排队/审查中时是审查中；
 *   测试排队/测试中属于阶段验证，仍显示实现中（substep 由 stageStep 提供）。
 * - 运行中且存在返修上下文：修复中（优先于实现中）。
 * - 运行中/已请求暂停/已暂停：还有活跃任务即实现中；只剩排队任务则排队中；
 *   任务全部集成或暂时没有任务时仍算实现中（下一步是阶段测试/审查，“实现中”比“审查中”准确）。
 * - 需处理：有返修上下文是修复中；否则按 waitingFor=blocked 归属最近阶段，
 *   已有阶段审查报告（stageReview）归属审查中，其余（实现/测试/集成中断）归属实现中。
 * - 空闲且确有排队任务：排队中；空闲且无队列、无可推进任务及未知阶段：null。
 * - 已取消：终止态，不属于 7 态，返回 null（调用方从活动列表移除）。取消后若仍要占一个
 *   展示位，只会落到“排队中”，会让人误以为任务还会继续，故不这样处理。
 */
function displayStatus(stage) {
    if (!stage || typeof stage !== 'object' || typeof stage.phase !== 'string') return null;
    const phase = stage.phase;
    const tasks = tasksOf(stage);

    if (phase === '已取消') return null;
    if (phase === '已验收') return '已验收';
    if (phase === '待验收') return '待验收';
    if (phase === '待重新验证') return '审查中';
    if (PLANNING_PHASES.has(phase)) return '规划中';

    if (phase === '联合验收中') {
        if (stage.stageStep === '审查排队' || stage.stageStep === '审查中') return '审查中';
        // 测试排队/测试中或缺失 stageStep：阶段测试与验证仍属于实现侧。
        return '实现中';
    }

    if (phase === '运行中' && hasRepairContext(stage)) return '修复中';

    if (RUNNING_PHASES.has(phase)) {
        if (tasks.some(task => ACTIVE_TASK_STATUSES.has(task.status))) return '实现中';
        if (tasks.some(task => task.status === '排队中')) return '排队中';
        return '实现中';
    }

    if (phase === '需处理') {
        if (hasRepairContext(stage)) return '修复中';
        return stage.stageReview ? '审查中' : '实现中';
    }

    if (phase === '空闲') return queuedWorkCount(stage, tasks) > 0 ? '排队中' : null;

    // 无可推进任务及未知阶段不强行塞进 7 态，交由调用方隐藏。
    return null;
}

/**
 * 任务级展示：只显示 排队中 / 实现中 / 修复中。
 * 已集成、已取消返回 null（由阶段详情处理）。
 * 审查中的子任务仍处于实现循环里（实现 -> 测试 -> 审查 -> 集成），统一显示实现中，
 * 阶段级审查由 displayStatus 的联合验收分支表达。
 */
function taskDisplay(task) {
    if (!task || typeof task !== 'object' || typeof task.status !== 'string') return null;
    const status = task.status;
    if (status === '已集成' || status === '已取消') return null;
    if (status === '需处理') return '修复中';
    if (status === '实现中' || status === '测试中' || status === '审查中' ||
        status === '集成中' || status === '取消中') return '实现中';
    if (TASK_QUEUED_STATUSES.has(status)) return '排队中';
    return null;
}

function waitingCodeOf(value) {
    if (typeof value !== 'string') return '';
    // 兼容 kebab 与 snake：impl-slot / impl_slot。
    const code = value.trim().toLowerCase().replace(/_/g, '-');
    return WAITING_FOR_SET.has(code) && code !== 'none' ? code : '';
}

/**
 * 单个排队任务的等待原因。task.reasonCode 优先；缺失时兼容现有中文 reason 前缀：
 * - “写入范围与…” -> scope-conflict
 * - “等待依赖 …” -> dependency
 * - “等待实现槽/测试槽/集成槽” -> impl-slot（测试槽属于实现流水线槽位）
 * - “等待 Codex 审查槽” -> review-slot
 * - “已中断/正在停止” -> paused
 * - 其他非空 reason / 纯排队 -> queue-position
 */
function taskWaiting(task) {
    if (!task || (task.status !== '排队中' && task.status !== '排队执行')) return null;
    const reason = typeof task.reason === 'string' ? task.reason.trim() : '';
    const code = waitingCodeOf(task.reasonCode);
    if (code) return { waitingFor: code, reason: reason || DEFAULT_WAITING_REASON[code] || '' };

    if (/^写入范围/.test(reason)) return { waitingFor: 'scope-conflict', reason };
    if (/^等待依赖/.test(reason)) return { waitingFor: 'dependency', reason };
    if (/^等待(?:实现|测试|集成)槽/.test(reason)) return { waitingFor: 'impl-slot', reason };
    if (/^等待\s*(?:Codex\s*)?审查槽/i.test(reason)) return { waitingFor: 'review-slot', reason };
    if (/^(?:已中断|正在停止)/.test(reason)) return { waitingFor: 'paused', reason };

    return {
        waitingFor: 'queue-position',
        reason: reason || (task.status === '排队执行' ? '等待执行槽。' : DEFAULT_WAITING_REASON['queue-position'])
    };
}

/**
 * 返回 { waitingFor, reason }。
 * 优先级：整体暂停 > 用户答复（待澄清/待确认/收件箱）> 阻塞（失败/需处理/取消）
 * > 阶段槽位排队 > 子任务 reasonCode/中文原因 > 空闲队列 > none。
 */
function waiting(stage) {
    if (!stage || typeof stage !== 'object') return { waitingFor: 'none', reason: '' };
    const phase = stage.phase;
    const tasks = tasksOf(stage);

    if (isPaused(stage)) {
        return { waitingFor: 'paused', reason: stage.message || '工作流已暂停，等待继续。' };
    }
    if (phase === '待澄清') {
        return { waitingFor: 'user-answer', reason: stage.question || stage.message || DEFAULT_WAITING_REASON['user-answer'] };
    }
    if (phase === '待确认方案') {
        return { waitingFor: 'user-answer', reason: '等待确认方案。' };
    }
    if (Array.isArray(stage.inbox) && stage.inbox.length) {
        const entry = stage.inbox[0] || {};
        return { waitingFor: 'user-answer', reason: entry.text || DEFAULT_WAITING_REASON['user-answer'] };
    }
    if (phase === '规划失败') {
        return { waitingFor: 'blocked', reason: stage.message || '规划失败，等待重新规划。' };
    }
    if (phase === '规划已中断') {
        return { waitingFor: 'blocked', reason: stage.message || '规划已中断，等待重试。' };
    }
    if (phase === '需处理') {
        return { waitingFor: 'blocked', reason: stage.message || '阶段需要处理。' };
    }
    if (phase === '已取消') {
        return { waitingFor: 'blocked', reason: stage.message || '任务已取消。' };
    }
    if (phase === '无可推进任务') {
        return { waitingFor: 'blocked', reason: stage.message || '没有可推进的任务。' };
    }

    // 联合验收阶段：槽位排队同样是“等待”，但任务都已集成，不会有任务级 reason。
    if (phase === '联合验收中') {
        if (stage.stageStep === '测试排队') return { waitingFor: 'impl-slot', reason: '等待阶段测试槽。' };
        if (stage.stageStep === '审查排队') return { waitingFor: 'review-slot', reason: '等待阶段审查槽。' };
    }

    // 具体原因优先；没有具体原因的纯排队留作兜底。
    let fallback = null;
    for (const task of tasks) {
        const derived = taskWaiting(task);
        if (!derived) continue;
        if (derived.waitingFor === 'queue-position') {
            fallback = fallback || derived;
            continue;
        }
        return derived;
    }
    if (fallback) return fallback;

    const blockedTask = tasks.find(task => task.status === '需处理');
    if (blockedTask) {
        return { waitingFor: 'blocked', reason: blockedTask.reason || stage.message || DEFAULT_WAITING_REASON.blocked };
    }
    if (phase === '空闲' && queuedWorkCount(stage, tasks) > 0) {
        return { waitingFor: 'queue-position', reason: '等待工作流处理排队任务。' };
    }
    return { waitingFor: 'none', reason: '' };
}

/**
 * 任务进度计数（互斥分桶，已取消不计入任何桶）。
 * reviewing 单独按 status === '审查中' 计数；其余按 taskDisplay 归类。
 */
function progress(stage) {
    const tasks = tasksOf(stage);
    const result = { total: tasks.length, queued: 0, implementing: 0, reviewing: 0, repairing: 0, integrated: 0 };
    for (const task of tasks) {
        if (task.status === '已集成') {
            result.integrated += 1;
            continue;
        }
        if (task.status === '已取消') continue;
        if (task.status === '审查中') {
            result.reviewing += 1;
            continue;
        }
        const display = taskDisplay(task);
        if (display === '排队中') result.queued += 1;
        else if (display === '实现中') result.implementing += 1;
        else if (display === '修复中') result.repairing += 1;
    }
    return result;
}

/**
 * 是否可重试：规划失败/规划已中断/需处理/已取消，或已达到返修上限。
 * 运行中/联合验收中（显示实现中/审查中/修复中）以及架构性的暂停阶段一律不可重试；
 * 即便这些阶段残留了返修上限提示，也应以“先停止/继续”为准。
 */
function retryable(stage) {
    if (!stage || typeof stage !== 'object' || typeof stage.phase !== 'string') return false;
    if (RUNNING_PHASES.has(stage.phase) || stage.phase === '联合验收中') return false;
    if (repairLimitReached(stage)) return true;
    return stage.phase === '规划失败' || stage.phase === '规划已中断' ||
        stage.phase === '需处理' || stage.phase === '已取消';
}

module.exports = {
    DISPLAY_STATUSES,
    displayStatus,
    taskDisplay,
    waiting,
    progress,
    retryable,
    TRANSITIONS
};
