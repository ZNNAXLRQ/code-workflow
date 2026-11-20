'use strict';

/**
 * 任务状态面板 webview（无聊天）。
 *
 * 纯 CommonJS，不依赖 vscode 模块，也不引用现成的 panel.js：
 * - 只导出 webview(nonce)，返回一整段 HTML 字符串；
 * - 页面内脚本只用 acquireVsCodeApi()、document 与 postMessage，不引任何外部资源；
 * - 状态与设置都由扩展 postMessage({ type:'state', ... }) 推入（契约见对外说明）。
 *
 * 设计取舍：
 * - 两个 tab：「任务」放阶段/任务/队列/绑定/调度，「设置」只放设置项与初始提交；
 * - 设置一律保存到当前项目（scope:'folder'），UI 不提供全局范围；
 * - 文本一律走 textContent / createElement，页面内不出现 innerHTML，从结构上避免注入；
 * - 收到 state 后按数据签名判断是否需要重绘，重绘前后保存并恢复 main 的滚动位置；
 * - 不做聊天、不做富文本渲染，因此没有第三方脚本依赖。
 */

/** nonce 会被拼进 CSP 与 nonce 属性，必须是 base64 / url 安全字符且足够长。 */
const NONCE_PATTERN = /^[A-Za-z0-9+/=_-]{8,}$/;

/**
 * 校验并返回可安全拼接的 nonce。
 * 调用方约定用 randomBytes(24).toString('base64')，非法值直接报中文错误，避免做出弱 CSP。
 */
function safeNonce(nonce) {
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) {
        throw new Error('status-panel.webview 需要 8 位以上 base64/url 安全字符的 nonce，收到 ' +
            JSON.stringify(nonce));
    }
    return nonce;
}

/**
 * 生成完整 HTML。
 *
 * @param {string} nonce CSP nonce（同时用于 style 与 script）
 * @returns {string} 完整 HTML 文档
 */
function webview(nonce) {
    const token = safeNonce(nonce);
    return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${token}'; script-src 'nonce-${token}'">
<style nonce="${token}">
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;color:var(--vscode-foreground);font:var(--vscode-font-size)/1.55 var(--vscode-font-family);display:flex;flex-direction:column;height:100vh}
header{padding:10px 14px 4px;border-bottom:1px solid var(--vscode-panel-border)}
main{flex:1;min-height:0;overflow:auto;padding:12px 14px 24px}
main section{margin-bottom:16px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;justify-content:space-between}
.topline{justify-content:flex-start}
nav{display:flex;gap:16px;margin-top:4px;align-items:center}
nav button{border:0;border-bottom:2px solid transparent;background:none;color:var(--vscode-descriptionForeground);padding:5px 0}
nav button[aria-selected=true]{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}
#refresh{margin-left:auto;color:var(--vscode-textLink-foreground);padding:5px 2px}
.sessionLine{display:flex;gap:10px;flex-wrap:wrap;margin-top:6px;align-items:baseline}
h3{font-size:1.05em;margin:12px 0 8px}
h3:first-child{margin-top:0}
h4{font-size:.98em;margin:10px 0 6px;color:var(--vscode-descriptionForeground)}
.groupTitle{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap;margin:10px 0 6px}
.groupTitle h4{margin:0}
p{margin:0 0 6px;white-space:pre-wrap;overflow-wrap:anywhere}
.label{color:var(--vscode-descriptionForeground);font-size:.92em}
button,input,select{font:inherit}
button{cursor:pointer}
button:disabled{opacity:.55;cursor:default}
button:focus-visible,input:focus-visible,select:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.primary,.secondary{padding:3px 9px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px}
.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
.danger{color:var(--vscode-errorForeground)}
select,input[type=text],input[type=number]{border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:3px 6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);max-width:100%}
.field{margin:0 0 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.field>label{min-width:92px}
.field .label{flex:1;min-width:0}
.card{border:1px solid var(--vscode-panel-border);border-radius:4px;padding:8px 10px;margin:0 0 8px;background:var(--vscode-editor-background)}
.badges{display:flex;flex-wrap:wrap;gap:4px;margin:6px 0}
.sbadge{border:1px solid var(--vscode-panel-border);border-radius:10px;padding:1px 8px;font-size:.88em;color:var(--vscode-descriptionForeground);white-space:nowrap}
.sbadge.on{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-color:transparent}
.badge{color:var(--vscode-descriptionForeground);font-size:.9em;white-space:nowrap}
.buttons{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.notice{border:1px solid var(--vscode-focusBorder);border-left-width:4px;border-radius:4px;padding:8px 10px;margin:0 0 12px;background:var(--vscode-textBlockQuote-background,var(--vscode-editor-background))}
.notice p:last-child{margin-bottom:0}
.plan{white-space:pre-wrap;overflow-wrap:anywhere;max-height:42vh;overflow:auto;margin:0 0 8px;padding:6px 8px;border:1px solid var(--vscode-panel-border);border-radius:4px;background:var(--vscode-textCodeBlock-background);font-family:var(--vscode-editor-font-family)}
#error{color:var(--vscode-errorForeground);margin-top:6px}
[hidden]{display:none!important}
</style>
<body>
<header>
  <div class="row topline">
    <span class="label">仓库</span>
    <span id="repo">未打开工作区</span>
  </div>
  <div class="row sessionLine" aria-live="polite">
    <span class="label">Codex 会话</span>
    <span id="codexSessionName">未绑定</span>
    <span class="label">DSH 会话</span>
    <span id="dshSessionName">未绑定</span>
  </div>
  <nav aria-label="面板视图">
    <button type="button" id="taskTab" aria-selected="true">任务</button>
    <button type="button" id="settingsTab" aria-selected="false">设置</button>
    <button type="button" id="refresh" title="刷新状态">刷新</button>
  </nav>
  <p id="error" role="alert" hidden></p>
</header>
<main id="main">
  <section id="tasksPage">
    <div class="row" id="pipelineRow">
      <span class="label" id="pipelineState" aria-live="polite">调度：运行中</span>
      <span class="label" id="pipelineHint">在 Codex 里说“暂停调度/继续调度”即可，面板不直接控制。</span>
    </div>
    <section id="clineSection" hidden>
      <div class="notice">
        <strong>Cline 前端模式</strong>
        <p class="label">Codex 暂不使用；在 Cline 插件里手动 Plan / Act。这里只同步交接文件。</p>
      </div>
      <div class="row">
        <span class="label">请求</span>
        <span id="clineRequest"></span>
      </div>
      <div class="row" id="clineStageRow">
        <span class="label">阶段</span>
        <span id="clineStage"></span>
      </div>
      <h3>计划</h3>
      <p class="plan" id="clinePlan"></p>
      <h3>任务</h3>
      <div id="clineTasks"></div>
      <section id="clineQueueSection" hidden>
        <h3>等待处理的请求</h3>
        <div id="clineQueue"></div>
      </section>
      <div class="buttons">
        <button type="button" class="primary" id="openCline">打开 Cline</button>
        <button type="button" class="secondary" id="switchCodex">切回 Codex</button>
      </div>
    </section>
    <section id="codexSection">
      <div class="notice" id="dshNotice" hidden>
        <strong>DSH 前端模式</strong>
        <p class="label" id="dshSessionLabel"></p>
        <p class="label">规划和审查通过 DSH 的 local_workflow MCP 工具完成；本面板只负责状态、设置和验收。</p>
      </div>
      <p class="label" id="glossary">阶段 = 一次完整开发（规划 → 实现 → 测试 → 审查 → 验收）；任务 = 阶段内拆分出的可并行工作项。</p>
      <div class="field" id="stagePickerRow" hidden>
        <label for="stagePicker">阶段</label>
        <select id="stagePicker" aria-label="选择阶段"></select>
      </div>
      <h3>当前阶段</h3>
      <div id="stageCard"></div>
      <h3>阶段任务</h3>
      <div id="tasks"></div>
    </section>
    <section id="queueSection" hidden>
      <h3>等待开始的请求</h3>
      <p class="label" id="queueHint">当前阶段结束后会自动开始；这些请求还没有拆成任务。</p>
      <div id="queue"></div>
    </section>
  </section>
  <section id="settingsPage" hidden>
    <h3>设置</h3>
    <p class="label" id="settingsPathHint">保存到当前项目 .local-workflow/settings.json。</p>
    <div class="field">
      <label for="sParallel">并行数</label>
      <select id="sParallel">
        <option value="1">1 · 无并行</option>
        <option value="2">2</option>
        <option value="4">4</option>
        <option value="8">8</option>
        <option value="unlimited">unlimited · 无限制</option>
      </select>
    </div>
    <div class="field">
      <label for="sRepairs">返修上限</label>
      <select id="sRepairs">
        <option value="0">0 · 不自动返修</option>
        <option value="1">1</option>
        <option value="2">2</option>
        <option value="3">3</option>
        <option value="4">4</option>
        <option value="5">5</option>
        <option value="6">6</option>
        <option value="7">7</option>
        <option value="8">8</option>
        <option value="9">9</option>
        <option value="10">10</option>
        <option value="unlimited">unlimited · 无限制</option>
      </select>
      <span class="label">0 表示不自动返修；unlimited 表示不限制。</span>
    </div>
    <div class="field">
      <label><input id="sDshFrontend" type="checkbox"> 使用 DSH 前端（默认 Codex）</label>
    </div>
    <section id="bindingSection">
      <h3>会话绑定</h3>
      <div class="field">
        <label for="sDshSessionId">DSH 会话 ID</label>
        <input id="sDshSessionId" type="text" placeholder="会话 ID；可留空后在 DSH 中绑定" autocomplete="off">
      </div>
      <h4>Codex 会话</h4>
      <p class="label" id="boundSession">未绑定</p>
      <p class="label" id="bindingDetail"></p>
      <div class="field" id="bindField">
        <label for="threadInput">会话 ID 或链接</label>
        <input id="threadInput" type="text" spellcheck="false" placeholder="粘贴 Codex 会话 ID 或 codex://threads/… 链接">
        <button type="button" class="primary" id="bindButton">绑定</button>
      </div>
      <div class="buttons" id="unbindRow">
        <button type="button" class="secondary danger" id="unbindButton">解除绑定</button>
      </div>
    </section>
    <div class="field">
      <label><input id="sReviewCodex" type="checkbox"> 启用 Codex 复审</label>
    </div>
    <div class="field">
      <label><input id="sReviewDsh" type="checkbox"> 启用 DSH 自审（goal 循环，作为初审）</label>
    </div>
    <div class="field">
      <label><input id="sInitialCommit" type="checkbox"> 阶段开始时自动提交当前工作区</label>
    </div>
    <div class="buttons">
      <button type="button" class="primary" id="saveSettings">保存设置</button>
      <button type="button" class="secondary" id="commitSnapshotSettings" title="执行前扩展会弹确认">提交当前工作区快照</button>
    </div>
    <p class="label" id="snapshotHint">会把当前未提交改动提交为基线；执行前扩展会弹确认。</p>
    <p class="label" id="settingsHint"></p>
  </section>
</main>
<script nonce="${token}">
const api = acquireVsCodeApi();
const STATUSES = ['排队中', '规划中', '实现中', '审查中', '修复中', '待验收', '已验收'];
const TASK_GROUPS = ['排队中', '实现中', '审查中', '修复中'];
const CANCEL_STAGE_PHASES = ['已暂停', '规划已中断', '规划失败', '待澄清', '待确认方案', '需处理'];
const INTERRUPT_PHASES = ['规划中', '运行中', '联合验收中'];
const ROLLBACK_PHASES = ['已暂停', '需处理'];
const PLANNING_PHASES = ['规划中', '待澄清', '待确认方案', '规划失败', '规划已中断'];
const CANCELLABLE_TASKS = ['排队中', '排队执行', '准备中', '实现中', '测试中', '审查中'];
const RETRYABLE_TASKS = ['已取消', '需处理'];
const TABS = ['tasks', 'settings'];
const CLINE_STATUS_NAMES = { todo: '排队中', doing: '实现中', done: '已完成', blocked: '修复中' };

let data = null;
let tab = 'tasks';
let selectedId = '';
let lastSignature = '';
let settingsFolder = null;
const scrollMemory = { tasks: 0, settings: 0 };

const $ = id => document.getElementById(id);
const text = value => value === undefined || value === null ? '' : String(value);
const amount = value => Number.isFinite(value) ? value : 0;

function send(type, extra) {
    api.postMessage(Object.assign({ type: type, folder: data ? data.folder : undefined }, extra || {}));
}

function node(tag, content, cls) {
    const element = document.createElement(tag);
    if (content !== undefined && content !== null && content !== '') element.textContent = String(content);
    if (cls) element.className = cls;
    return element;
}

function actionButton(label, onClick, cls, disabled) {
    const element = node('button', label, cls || 'secondary');
    element.type = 'button';
    element.onclick = onClick;
    element.disabled = Boolean(disabled);
    return element;
}

function showError(message) {
    const target = $('error');
    target.textContent = message ? String(message) : '';
    target.hidden = !message;
}

function stages() {
    return data && Array.isArray(data.stages) ? data.stages : [];
}

function clineMode() {
    return Boolean(data && data.frontend === 'cline');
}

function clinePayload() {
    return data && data.cline && typeof data.cline === 'object' ? data.cline : {};
}

function clineStatusName(status) {
    return CLINE_STATUS_NAMES[text(status)] || text(status) || '未知状态';
}

function selectedStage() {
    const list = stages();
    return list.find(stage => stage.id === selectedId) || list[0] || null;
}

function binding() {
    if (data && data.binding && typeof data.binding === 'object') return data.binding;
    if (data && data.codexThreadId) {
        return { mode: 'codex', frontendSessionId: data.codexThreadId, codexThreadId: data.codexThreadId };
    }
    return null;
}

function tail(value) {
    const id = text(value);
    return id ? id.slice(-8) : '';
}

function stageBadgeName(stage) {
    const display = text(stage.display);
    if (STATUSES.indexOf(display) >= 0) return display;
    const phase = text(stage.phase);
    if (phase === '待验收' || phase === '已验收') return phase;
    if (PLANNING_PHASES.indexOf(phase) >= 0) return '规划中';
    if (phase === '联合验收中' && (text(stage.stageStep) === '审查排队' || text(stage.stageStep) === '审查中')) return '审查中';
    if (phase === '需处理' || phase === '已暂停' || phase === '已请求暂停' ||
        phase === '运行中' || phase === '联合验收中') return '实现中';
    return display || phase;
}

function badgeAmount(status, stage) {
    const progress = stage.progress || {};
    const active = stageBadgeName(stage);
    if (status === '排队中') return amount(progress.queued);
    if (status === '实现中') return amount(progress.implementing);
    if (status === '审查中') return amount(progress.reviewing);
    if (status === '修复中') return amount(progress.repairing);
    return active === status ? 1 : 0;
}

function taskGroupName(task) {
    const status = text(task.status);
    if (status === '已集成' || status === '已验收') return '';
    if (status === '需处理' || status === '已取消') return '修复中';
    if (status === '审查中' || status === '待审查') return '审查中';
    if (status === '实现中' || status === '测试中' || status === '集成中' || status === '取消中') return '实现中';
    if (status === '排队中' || status === '排队执行' || status === '准备中') return '排队中';
    return '';
}

function rollbackCandidate(stage) {
    if (ROLLBACK_PHASES.indexOf(text(stage.phase)) < 0) return null;
    const tasks = Array.isArray(stage.tasks) ? stage.tasks : [];
    return tasks.find(task => text(task.status) !== '已集成' && text(task.status) !== '已取消') || null;
}

function stageActions(stage) {
    const box = node('div', '', 'buttons');
    const phase = text(stage.phase);
    const candidate = rollbackCandidate(stage);
    const bound = binding();
    box.append(actionButton('中断执行',
        () => send('action', { action: 'interrupt', run: stage.id }), 'secondary', INTERRUPT_PHASES.indexOf(phase) < 0));
    const cancellable = typeof stage.cancellable === 'boolean' ? stage.cancellable : CANCEL_STAGE_PHASES.indexOf(phase) >= 0;
    box.append(actionButton('取消阶段',
        () => send('action', { action: 'cancelStage', run: stage.id }), 'secondary', !cancellable));
    box.append(actionButton('回退本轮',
        () => send('action', { action: 'rollback', task: candidate.id, run: stage.id }), 'secondary', !candidate));
    const accepting = phase === '待验收' || stageBadgeName(stage) === '待验收';
    const revalidating = phase === '待重新验证';
    const resumable = phase === '已暂停' || phase === '需处理';
    box.append(actionButton('继续执行',
        () => send('action', { action: 'resume', run: stage.id }), 'primary', !resumable));
    box.append(actionButton('继续重新验证',
        () => send('action', { action: 'revalidate', run: stage.id }), 'primary', !revalidating));
    box.append(actionButton('验收',
        () => send('action', { action: 'accept', run: stage.id }), 'primary', !accepting));
    box.append(actionButton('重试',
        () => send('action', { action: 'retry', run: stage.id }), 'secondary', !stage.retryable));
    box.append(actionButton('解除绑定',
        () => send('unbind', { run: stage.id }), 'secondary danger', !bound));
    return box;
}

function renderStageCard() {
    const target = $('stageCard');
    const stage = selectedStage();
    target.replaceChildren();
    if (!stage) {
        target.append(node('p', '当前没有进行中的阶段。', 'label'));
        return;
    }
    const card = node('div', '', 'card');
    const top = node('div', '', 'row');
    top.append(node('strong', stage.title || stage.request || stage.id || '未命名阶段'));
    top.append(node('span', stageBadgeName(stage), 'badge'));
    card.append(top);

    const badges = node('div', '', 'badges');
    const active = stageBadgeName(stage);
    for (const status of STATUSES) {
        const total = badgeAmount(status, stage);
        const chip = node('span', total ? status + ' ' + total : status, status === active ? 'sbadge on' : 'sbadge');
        chip.title = status + (total ? '：' + total + ' 项' : '：无');
        badges.append(chip);
    }
    card.append(badges);

    const reason = (stage.waiting && stage.waiting.reason) || stage.message || '';
    card.append(node('p', '原因：' + (reason || '—'), 'label'));
    const progress = stage.progress || {};
    card.append(node('p', '进度：共 ' + amount(progress.total) + ' · 排队 ' + amount(progress.queued) +
        ' · 实现 ' + amount(progress.implementing) + ' · 审查 ' + amount(progress.reviewing) +
        ' · 修复 ' + amount(progress.repairing) + ' · 已集成 ' + amount(progress.integrated), 'label'));
    card.append(node('p', '阶段步骤：' + (stage.stageStep || stage.phase || '—'), 'label'));
    card.append(stageActions(stage));
    target.append(card);
}

function taskCard(task, stage, group) {
    const card = node('div', '', 'card');
    const top = node('div', '', 'row');
    top.append(node('strong', task.title || task.id || '未命名任务'));
    top.append(node('span', group, 'badge'));
    card.append(top);

    if (Array.isArray(task.paths) && task.paths.length) {
        card.append(node('p', '路径：' + task.paths.map(entry => text(entry)).join('、'), 'label'));
    }
    if (task.reason) card.append(node('p', '原因：' + text(task.reason), 'label'));
    card.append(node('p', '返修轮次：' + amount(Number(task.round)), 'label'));
    if (task.status) card.append(node('p', '原始状态：' + text(task.status), 'label'));

    const buttons = node('div', '', 'buttons');
    const status = text(task.status);
    buttons.append(actionButton('重试',
        () => send('action', { action: 'retryTask', task: task.id, run: stage.id }), 'primary', RETRYABLE_TASKS.indexOf(status) < 0));
    buttons.append(actionButton('取消',
        () => send('action', { action: 'cancelTask', task: task.id, run: stage.id }), 'secondary', CANCELLABLE_TASKS.indexOf(status) < 0));
    buttons.append(actionButton('回退本轮',
        () => send('action', { action: 'rollback', task: task.id, run: stage.id }),
        'secondary', ROLLBACK_PHASES.indexOf(text(stage.phase)) < 0));
    buttons.append(actionButton('查看 Cline 历史',
        () => send('openCline', { taskId: task.id, run: stage.id }), 'secondary'));
    card.append(buttons);
    return card;
}

function renderPipeline() {
    const cline = clineMode();
    const paused = Boolean(data && data.pipelinePaused);
    $('pipelineState').textContent = cline ? '调度：由 Cline 手动操作'
        : '调度：' + (paused ? '已暂停' : '运行中');
    $('pipelineHint').hidden = cline;
}

function renderStagePicker(list) {
    const picker = $('stagePicker');
    const signature = list.map(stage => text(stage.id) + '|' + text(stage.title || stage.request)).join('~');
    if (picker.dataset.signature !== signature) {
        const previous = picker.value;
        picker.replaceChildren();
        for (const stage of list) {
            const option = node('option', (stage.title || stage.request || stage.id || '阶段') + ' · ' +
                (stage.stageStep || stageBadgeName(stage)));
            option.value = text(stage.id);
            picker.append(option);
        }
        picker.dataset.signature = signature;
        if (list.some(stage => text(stage.id) === previous)) picker.value = previous;
    }
    picker.value = selectedId;
    $('stagePickerRow').hidden = list.length <= 1;
}

function renderTasks() {
    const target = $('tasks');
    const stage = selectedStage();
    target.replaceChildren();
    if (!stage) {
        target.append(node('p', '选择阶段后显示任务。', 'label'));
        return;
    }
    const groups = new Map(TASK_GROUPS.map(name => [name, []]));
    for (const task of Array.isArray(stage.tasks) ? stage.tasks : []) {
        const group = taskGroupName(task);
        if (group) groups.get(group).push(task);
    }
    let rendered = 0;
    for (const [group, tasks] of groups) {
        if (!tasks.length) continue;
        const heading = node('h4', group + ' · ' + tasks.length);
        if (group === '审查中') {
            const row = node('div', '', 'groupTitle');
            row.append(heading, node('span', '等待 Codex 返回审查结论；不会自动完成。', 'label'));
            target.append(row);
        } else {
            target.append(heading);
        }
        for (const task of tasks) {
            target.append(taskCard(task, stage, group));
            rendered += 1;
        }
    }
    if (!rendered) target.append(node('p', '这个阶段当前没有排队中、实现中、审查中或修复中的任务。', 'label'));
}

function renderQueue() {
    const target = $('queue');
    const items = data && Array.isArray(data.queue) ? data.queue : [];
    $('queueSection').hidden = !items.length;
    target.replaceChildren();
    if (!items.length) return;
    items.forEach((item, index) => {
        const card = node('div', '', 'card');
        card.append(node('p', (index + 1) + '. ' + text(item.request || item.id)));
        if (data.pipelinePaused) card.append(node('p', '调度已暂停，恢复后才会开始。', 'label'));
        card.append(actionButton('取消请求', () => send('cancelQueued', { id: item.id }), 'secondary'));
        target.append(card);
    });
}

function keepField(element, apply) {
    if (document.activeElement === element) return;
    apply();
}

function renderSettings() {
    const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {};
    const folder = data ? text(data.folder) : '';
    const refresh = !data || data.refreshSettings === true || settingsFolder !== folder;
    if (refresh) {
        const parallel = text(settings.maxParallel || '2');
        keepField($('sParallel'), () => {
            if (Array.from($('sParallel').options).some(option => option.value === parallel)) $('sParallel').value = parallel;
        });
        keepField($('sRepairs'), () => {
            const repairs = text(settings.maxRepairs);
            const value = repairs === 'unlimited' ? 'unlimited'
                : String(Number.isFinite(Number(repairs)) ? Number(repairs) : 3);
            if (Array.from($('sRepairs').options).some(option => option.value === value)) $('sRepairs').value = value;
        });
        keepField($('sDshFrontend'), () => { $('sDshFrontend').checked = settings.useDshFrontend === true; });
        keepField($('sDshSessionId'), () => { $('sDshSessionId').value = text(settings.dshSessionId || ''); });
        keepField($('sReviewCodex'), () => { $('sReviewCodex').checked = settings.reviewCodex !== false; });
        keepField($('sReviewDsh'), () => { $('sReviewDsh').checked = settings.reviewDsh === true; });
        keepField($('sInitialCommit'), () => { $('sInitialCommit').checked = settings.initialCommit === true; });
        settingsFolder = folder;
    }
    const ready = Boolean(data && data.repo);
    $('saveSettings').disabled = !ready;
    $('commitSnapshotSettings').disabled = !ready;
    $('sParallel').disabled = !ready;
    $('sRepairs').disabled = !ready;
    $('sDshFrontend').disabled = !ready;
    $('sDshSessionId').disabled = !ready;
    $('sReviewCodex').disabled = !ready;
    $('sReviewDsh').disabled = !ready;
    $('sInitialCommit').disabled = !ready;
    $('settingsHint').textContent = ready ? '' : '打开受信任的本地 Git 项目后才能保存设置。';
}

function renderBinding() {
    const bound = binding();
    const ready = Boolean(data && data.repo);
    $('boundSession').textContent = bound
        ? (text(bound.mode) === 'cline' ? 'Cline 会话' : 'Codex 会话') + ' · ' + tail(bound.codexThreadId || bound.frontendSessionId)
        : '未绑定';
    $('boundSession').title = bound ? text(bound.codexThreadId || bound.frontendSessionId) : '';
    $('bindingDetail').textContent = bound
        ? '模式 ' + text(bound.mode) + ' · 前端会话 ' + text(bound.frontendSessionId) +
            ' · Codex 线程 ' + text(bound.codexThreadId)
        : '还没有绑定 Codex 会话，粘贴会话 ID 或链接后绑定。';
    $('bindField').hidden = Boolean(bound);
    $('unbindRow').hidden = !bound;
    $('threadInput').disabled = !ready;
    $('bindButton').disabled = !ready;
    $('unbindButton').disabled = !bound;
    if (!bound && document.activeElement !== $('threadInput')) $('threadInput').value = '';
}

function renderClineTasks(list) {
    const target = $('clineTasks');
    const tasks = Array.isArray(list) ? list : [];
    target.replaceChildren();
    if (!tasks.length) {
        target.append(node('p', '交接文件里还没有任务。', 'label'));
        return;
    }
    for (const task of tasks) {
        const card = node('div', '', 'card');
        const top = node('div', '', 'row');
        top.append(node('strong', task.title || task.id || '未命名任务'));
        top.append(node('span', clineStatusName(task.status), 'badge'));
        card.append(top);
        if (Array.isArray(task.paths) && task.paths.length) {
            card.append(node('p', '路径：' + task.paths.map(entry => text(entry)).join('、'), 'label'));
        }
        if (task.notes) card.append(node('p', '备注：' + text(task.notes), 'label'));
        target.append(card);
    }
}

function renderClineQueue(list) {
    const items = Array.isArray(list) ? list : [];
    const target = $('clineQueue');
    $('clineQueueSection').hidden = !items.length;
    target.replaceChildren();
    if (!items.length) return;
    items.forEach((item, index) => {
        const card = node('div', '', 'card');
        card.append(node('p', (index + 1) + '. ' + text(item.request || item.id)));
        target.append(card);
    });
}

function renderCline() {
    const payload = clinePayload();
    const stage = payload.stage && typeof payload.stage === 'object' ? payload.stage : null;
    $('clineRequest').textContent = text(payload.request) || '（没有请求文本）';
    $('clineStageRow').hidden = !stage;
    $('clineStage').textContent = stage ? (text(stage.title) || text(stage.id) || '未命名阶段') : '';
    $('clinePlan').textContent = text(payload.plan) || '（交接文件里还没有 plan）';
    renderClineTasks(payload.tasks);
    renderClineQueue(payload.queue);
}

function renderHeaderSessions() {
    const bound = binding();
    const codex = (data && data.codexMetadata && (data.codexMetadata.title || data.codexMetadata.name)) ||
        (bound && bound.codexThreadId) || (data && data.codexThreadId) || '';
    $('codexSessionName').textContent = codex ? text(codex) : '未绑定';
    $('codexSessionName').title = codex ? text(codex) : '';
    const settings = data && data.settings && typeof data.settings === 'object' ? data.settings : {};
    const dsh = (data && data.dshSessionId) || settings.dshSessionId || '';
    $('dshSessionName').textContent = dsh ? text(dsh) : '未绑定';
    $('dshSessionName').title = dsh ? text(dsh) : '';
}

function render() {
    const main = $('main');
    const scrollTop = main.scrollTop;
    const cline = clineMode();
    const dsh = Boolean(data && data.frontend === 'dsh');
    const repo = data && data.repo ? text(data.repo)
        : data && data.folder ? text(data.folder)
            : '未打开工作区';
    $('repo').textContent = repo;
    renderHeaderSessions();
    $('codexSection').hidden = cline;
    $('clineSection').hidden = !cline;
    $('dshNotice').hidden = !dsh;
    if (dsh) {
        $('dshSessionLabel').textContent = data.dshSessionId
            ? '会话 ID：' + text(data.dshSessionId)
            : '未绑定 DSH 会话 ID；可在设置中填写。';
    }
    renderPipeline();
    if (cline) {
        $('queueSection').hidden = true;
        renderCline();
    } else {
        const list = stages();
        renderStagePicker(list);
        renderStageCard();
        renderTasks();
        renderQueue();
    }
    renderBinding();
    renderSettings();
    main.scrollTop = scrollTop;
}

function signatureOf(incoming) {
    return JSON.stringify({
        folder: incoming.folder,
        repo: incoming.repo,
        frontend: incoming.frontend || 'codex',
        dshSessionId: incoming.dshSessionId || '',
        dshSessionLabel: incoming.dshSessionId || '',
        codexTitle: incoming.codexMetadata && (incoming.codexMetadata.title || incoming.codexMetadata.name) || '',
        paused: Boolean(incoming.pipelinePaused),
        state: incoming.state && incoming.state.id,
        settings: incoming.settings,
        binding: incoming.binding || incoming.codexThreadId || null,
        selected: selectedId,
        stages: (Array.isArray(incoming.stages) ? incoming.stages : []).map(stage => [
            stage.id, stage.display, stage.phase, stage.stageStep, stage.retryable, stage.cancellable,
            stage.progress, stage.waiting && stage.waiting.reason, stage.message,
            (Array.isArray(stage.tasks) ? stage.tasks : []).map(task =>
                [task.id, task.title, task.status, task.round, task.reason, task.paths])
        ]),
        queue: (Array.isArray(incoming.queue) ? incoming.queue : []).map(item => [item.id, item.request])
    });
}

function applyState(incoming) {
    data = incoming;
    const list = stages();
    const serverSelected = incoming.state && incoming.state.id;
    if (serverSelected && list.some(stage => stage.id === serverSelected)) selectedId = serverSelected;
    else if (!list.some(stage => stage.id === selectedId)) selectedId = list.length ? list[0].id : '';
    const signature = signatureOf(incoming);
    if (signature === lastSignature) return;
    lastSignature = signature;
    render();
}

function applyTab() {
    $('tasksPage').hidden = tab !== 'tasks';
    $('settingsPage').hidden = tab !== 'settings';
    $('taskTab').setAttribute('aria-selected', String(tab === 'tasks'));
    $('settingsTab').setAttribute('aria-selected', String(tab === 'settings'));
}

function selectTab(next) {
    if (TABS.indexOf(next) < 0 || next === tab) return;
    scrollMemory[tab] = $('main').scrollTop;
    tab = next;
    applyTab();
    $('main').scrollTop = scrollMemory[tab] || 0;
}

function commitSnapshot() {
    showError('');
    send('initialCommit');
}

$('taskTab').onclick = () => selectTab('tasks');
$('settingsTab').onclick = () => selectTab('settings');

$('openCline').onclick = () => {
    showError('');
    send('openCline');
};
$('switchCodex').onclick = () => {
    showError('');
    send('frontend', { mode: 'codex' });
};
$('commitSnapshotSettings').onclick = commitSnapshot;

$('refresh').onclick = () => {
    showError('');
    send('refresh');
};

$('stagePicker').onchange = () => {
    const value = $('stagePicker').value;
    if (!value) return;
    selectedId = value;
    send('selectStage', { run: selectedId });
    render();
};

$('saveSettings').onclick = () => {
    const repairValue = $('sRepairs').value;
    const maxRepairs = repairValue === 'unlimited' ? 'unlimited' : Number(repairValue);
    if (maxRepairs !== 'unlimited' && (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 10)) {
        showError('返修上限必须是 0 到 10 之间的整数，或选择无限制。');
        return;
    }
    showError('');
    send('settings', {
        scope: 'folder',
        maxParallel: $('sParallel').value,
        maxRepairs: maxRepairs,
        useDshFrontend: $('sDshFrontend').checked,
        dshSessionId: $('sDshSessionId').value.trim(),
        reviewCodex: $('sReviewCodex').checked,
        reviewDsh: $('sReviewDsh').checked,
        initialCommit: $('sInitialCommit').checked
    });
};

$('bindButton').onclick = () => {
    const threadId = $('threadInput').value.trim();
    if (!threadId) {
        showError('请粘贴 Codex 会话 ID 或链接。');
        return;
    }
    showError('');
    send('bind', { threadId: threadId });
};

$('unbindButton').onclick = () => {
    const stage = selectedStage();
    showError('');
    send('unbind', { run: stage ? stage.id : undefined });
};

window.addEventListener('message', event => {
    const incoming = event && event.data;
    if (!incoming || typeof incoming !== 'object') return;
    if (incoming.type === 'error') {
        showError(incoming.message || '操作失败');
        return;
    }
    if (incoming.type === 'state') applyState(incoming);
});

applyTab();
render();
send('ready');
</script></body></html>`;
}

module.exports = { webview };
