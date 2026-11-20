'use strict';

/**
 * status-panel.js 冒烟测试。
 *
 * 不启动 VS Code：生成 HTML 后做静态契约检查（两页 tab、CSP、nonce、控件、消息、无聊天、无外部资源），
 * 并把内联脚本交给 new Function 编译，确认页面脚本语法有效。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { webview } = require('../status-panel.js');

let checks = 0;
function ok(message) {
    checks += 1;
    console.log('ok ' + checks + ' - ' + message);
}
function has(source, pattern, label) {
    assert.match(source, pattern, label);
    ok(label);
}
function text(source, fragment, label) {
    assert.ok(source.includes(fragment), label + '（未找到 ' + fragment + '）');
    ok(label);
}
function missing(source, pattern, label) {
    assert.ok(!pattern.test(source), label + '（不应出现 ' + pattern + '）');
    ok(label);
}

const nonce = 'SmokeNonce0123456789+/abc';
const html = webview(nonce);
const source = fs.readFileSync(path.join(__dirname, '..', 'status-panel.js'), 'utf8');

// --- 导出形态 -------------------------------------------------------------
assert.equal(typeof webview, 'function');
ok('导出 webview(nonce)');
assert.ok(!/require\(\s*['"]vscode['"]\s*\)/.test(source));
ok('模块本身不 require vscode');
assert.ok(!/require\(\s*['"]\.\/panel['"]\s*\)/.test(source));
ok('模块不 require 现成的 panel.js');
assert.ok(!/markdown-it/i.test(source) && !/readFileSync|\.\/vendor/.test(source));
ok('模块不读取 markdown-it 或 vendor 资源');
assert.ok(html.startsWith('<!doctype html>'), '应以 <!doctype html> 开头');
assert.ok(html.trimEnd().endsWith('</html>'), '应以 </html> 结尾');
ok('返回完整 HTML 文档');
text(html, 'acquireVsCodeApi', '页面使用 VS Code webview API');

// --- CSP 与 nonce ---------------------------------------------------------
text(html, "default-src 'none'; style-src 'nonce-" + nonce + "'; script-src 'nonce-" + nonce + "'",
    'CSP 为 default-src none + nonce 限定的 style/script');
missing(html, /unsafe-inline|unsafe-eval|'self'|connect-src|img-src|font-src/, 'CSP 无放宽指令');
text(html, 'style nonce="' + nonce + '"', 'style 带 nonce');
text(html, 'script nonce="' + nonce + '"', 'script 带 nonce');
missing(html, /\sstyle="/, '没有内联 style 属性（CSP 下会被拦截）');
assert.equal((html.match(/<script\b/g) || []).length, 1, '只应有一个内联脚本');
ok('只有一段内联脚本（无 vendor 脚本）');
assert.equal((html.match(/<\/script>/g) || []).length, 1);
assert.equal(html.split(nonce).length - 1, 4, 'nonce 应恰好出现在 CSP 两处与 style / script 两个标签上');
ok('nonce 覆盖 CSP、style、script 三处');

// --- 三个 tab -------------------------------------------------------------
text(html, '>任务</button>', '任务 tab 文案');
text(html, '>验收</button>', '验收 tab 文案');
text(html, '>设置</button>', '设置 tab 文案');
text(html, 'id="taskTab" aria-selected="true"', '默认选中任务页');
text(html, 'id="acceptTab" aria-selected="false"', '验收页初始未选中');
text(html, 'id="settingsTab" aria-selected="false"', '设置页初始未选中');
text(html, 'id="tasksPage"', '任务页容器');
text(html, 'id="acceptPage" hidden', '验收页初始隐藏');
text(html, 'id="settingsPage" hidden', '设置页初始隐藏');
has(html, /\$\('tasksPage'\)\.hidden = tab !== 'tasks'/, '切换 tab 只切显隐');
has(html, /\$\('acceptPage'\)\.hidden = tab !== 'accept'/, '验收页按 tab 显示');
has(html, /\$\('settingsPage'\)\.hidden = tab !== 'settings'/, '设置页按 tab 显示');
has(html, /\$\('taskTab'\)\.setAttribute\('aria-selected'/, 'tab 同步 aria-selected');
text(html, 'scrollMemory', '各 tab 各自记忆滚动位置');
text(html, 'function selectTab', 'tab 切换函数');
ok('三个 tab 且切换不重建页面');

// 会话绑定和设置项都在设置页，验收页在任务与设置之间
const tasksIndex = html.indexOf('id="tasksPage"');
const acceptIndex = html.indexOf('id="acceptPage"');
const bindingIndex = html.indexOf('id="bindingSection"');
const settingsIndex = html.indexOf('id="settingsPage"');
const settingsFieldIndex = html.indexOf('id="sParallel"');
assert.ok(tasksIndex < acceptIndex && acceptIndex < settingsIndex && settingsIndex < bindingIndex,
    '验收页必须在任务页和设置页之间，绑定区在设置页内');
ok('任务 / 验收 / 设置顺序正确');
assert.ok(settingsFieldIndex > settingsIndex, '设置项必须在设置页内');
ok('设置项位于设置页');

// 首栏仓库下方的 Codex/DSH 会话名称
text(html, 'id="codexSessionName"', '首栏 Codex 会话名称');
text(html, 'id="dshSessionName"', '首栏 DSH 会话名称');
text(html, 'function renderHeaderSessions()', '首栏会话名称渲染函数');
text(html, "const codex = (data && data.codexMetadata", 'Codex 名称优先使用 Codex 标题');
text(html, "const dshId = (data && data.dshSessionId) || settings.dshSessionId", 'DSH 名称读取绑定 ID');
text(html, "const dshTitle = (dshBound && dshBound.title) || (data && data.dshSessionTitle) || ''", 'DSH 名称读取绑定标题');

// 任务页统一前端模式提示
text(html, 'id="frontendNotice"', '任务页前端模式提示');
text(html, 'id="frontendModeTitle"', '前端模式标题');
text(html, 'id="frontendSessionLabel"', '前端会话名称');
text(html, 'function renderFrontendNotice()', '前端模式提示渲染函数');
text(html, "'Codex 前端模式'", 'Codex 模式提示');
text(html, "'DSH 前端模式'", 'DSH 模式提示');
text(html, "notice.hidden = frontend === 'cline'", '前端提示按模式显示');

// DSH 绑定卡片
text(html, 'id="dshBindField"', 'DSH 绑定输入区');
text(html, 'DSH 会话 ID', 'DSH 绑定字段名');
text(html, 'function renderDshBinding()', 'DSH 绑定渲染函数');
text(html, "send('dshBind', { sessionId })", 'DSH 绑定发送 dshBind');
text(html, "send('dshUnbind')", 'DSH 解绑发送 dshUnbind');
text(html, '请先切回 Codex 再解除 DSH 绑定', 'DSH 前端模式解绑限制');

// 刷新在 tab 同一排右侧
assert.ok(html.indexOf('id="refresh"') < html.indexOf('</nav>'), '刷新按钮必须在 tab 导航行内');
text(html, '#refresh{margin-left:auto', '刷新按钮靠右');
missing(html, /id="commitSnapshot"/, '任务页重复的提交快照按钮已删除');
text(html, 'id="commitSnapshotSettings"', '设置页保留提交快照按钮');

// --- 阶段状态：进行中 / 阻塞 / 待验收 ---------------------------------------
text(html, 'function stageDisplayState(stage)', '阶段状态汇总函数');
text(html, "if (phase === '待验收') return '待验收';", '待验收阶段识别');
text(html, "if (blocked.length || ['需处理', '已暂停', '已请求暂停', '规划失败'].includes(phase)) return '阻塞';",
    '任务阻塞或阶段阻塞归为阻塞');
text(html, "return '进行中';", '其余阶段为进行中');
text(html, 'function stageBlockedTasks(stage)', '阻塞任务识别');
text(html, "['需处理', '已取消'].includes", '需处理/已取消任务视为阻塞');
text(html, '阻塞任务：', '阻塞时显示卡住的任务');
text(html, '依赖它的任务：', '阻塞信息提示受影响任务');
missing(html, /依赖这些任务的工作会等待/, '已删除阻塞任务旁的废话');
text(html, "['已验收', '已取消'].includes", '已验收/已取消阶段从活动列表消失');
missing(html, /action: 'resume'/, '阶段卡没有继续按钮');
missing(html, /for \(const status of STATUSES\)/, '不再逐阶段渲染 7 个任务状态徽章');
text(html, 'id="tasks"', '阶段任务容器恢复');
text(html, '<h3>阶段任务</h3>', '「阶段任务」分区恢复');
text(html, 'function renderTaskStatuses()', '任务状态列表渲染函数');
text(html, 'const status = text(task.status)', '每个任务显示自己的状态');
text(html, '返修轮次：', '任务显示返修轮次');
text(html, '任务：共 ', '阶段摘要仍显示任务数量');
text(html, "send('action', { action: 'retryTask'", '任务重试按钮恢复');
text(html, "send('action', { action: 'cancelTask'", '任务取消按钮恢复');
text(html, "send('action', { action: 'rollback'", '任务回退按钮恢复');
text(html, "send('openCline', { taskId:", '任务查看 Cline 历史恢复');
missing(html, /阶段 = 一次完整开发/, '已删除阶段/任务解释长句');
missing(html, /0 表示不自动返修/, '已删除返修上限说明');
ok('阶段只显示进行中/阻塞/待验收，任务状态和操作完整');

// --- 验收页 ---------------------------------------------------------------
text(html, 'id="acceptanceQueue"', '待验收队列容器');
text(html, 'id="acceptedList"', '已验收清单容器');
text(html, 'function renderAcceptance()', '验收页渲染函数');
text(html, 'function acceptanceReport(stage)', '验收报告读取函数');
text(html, 'stage.stageReview', '验收报告直接使用工作流审查报告');
text(html, '审查结论：', '验收报告包含审查结论');
text(html, '审查结论：', '验收报告包含审查结论');
text(html, '验收标准：', '验收报告包含验收标准');
text(html, '问题：', '验收报告包含阻塞问题');
text(html, '测试：', '验收报告包含测试结果');
missing(html, /stage\.stageReport/, '验收 tab 不再读取额外阶段报告');
missing(html, /等待 DSH\/Codex 前端生成阶段报告/, '验收 tab 不再等待前端生成报告');
text(html, '暂无待验收阶段。', '验收页空态');
text(html, '还没有已验收阶段。', '已验收空态');
text(html, '退回意见（退回时必填）', '退回意见输入框');
has(html, /send\('action', \{ action: 'accept', run: stage\.id \}\)/, '验收页发送 accept');
has(html, /send\('action', \{ action: 'reject', run: stage\.id, text: feedback \}\)/, '验收页发送 reject + 意见');
missing(html, /action: 'revalidate'/, '不再有继续重新验证按钮');
missing(html, /action: 'interrupt'/, '不再有中断执行按钮');
missing(html, /action: 'cancelStage'/, '不再有取消阶段按钮');
missing(html, /send\('unbind', \{ run: stage\.id \}\)/, '阶段卡不再有解除绑定按钮');
ok('验收页承载验收/退回，阶段卡不再放大堆按钮');

text(html, 'id="pipelineState"', '调度状态（只读）');
text(html, "'调度：' + (paused ? '已暂停' : '运行中')", '调度状态文案只读刷新');
text(html, 'id="pipelineHint"', '调度状态旁的小字说明');
text(html, '在 Codex 里说“暂停调度/继续调度”即可，面板不直接控制。', '说明调度由 Codex 发起');
missing(html, /id="togglePipeline"/, '面板不提供暂停/恢复调度按钮');
missing(html, /'pipelinePause'|'pipelineResume'|send\('pipeline/, '不再发送 pipelinePause/pipelineResume');
assert.equal((html.match(/暂停调度/g) || []).length, 1, '「暂停调度」只应出现在只读说明里');
ok('「暂停调度」仅出现在只读说明中');
missing(html, /恢复调度/, '不再有「恢复调度」按钮文案');

// --- 阶段 / 队列 -----------------------------------------------------------
text(html, '<h3>当前阶段</h3>', '「当前阶段」分区');
text(html, 'id="stageCard"', '只有一个当前阶段卡片');
missing(html, /id="stages"/, '不再渲染阶段列表');
missing(html, /查看这个阶段/, '不再有阶段列表里的查看按钮');
has(html, /\$\('stagePickerRow'\)\.hidden = list\.length <= 1/, '阶段选择器仅在多于 1 个阶段时显示');
text(html, '<label for="stagePicker">阶段</label>', '阶段选择器标签为「阶段」');
text(html, 'id="stagePicker"', '阶段选择器');
text(html, '<h3>等待开始的请求</h3>', '队列改名「等待开始的请求」');
text(html, '当前阶段结束后会自动开始；这些请求还没有拆成任务。', '队列说明：尚未拆成任务');
has(html, /\$\('queueSection'\)\.hidden = !items\.length/, '队列为空时不显示');
missing(html, /排队请求/, '不再使用「排队请求」叫法');
text(html, '取消请求', '队列项按钮为「取消请求」');

// --- 顶部路径只出现一次 ---------------------------------------------------
assert.equal((html.match(/id="repo"/g) || []).length, 1, '仓库路径只有一个元素');
ok('仓库路径元素唯一');
missing(html, /id="folder"/, '不再有第二个路径元素');
missing(html, /任务状态/, '不再显示「任务状态」标题行');
assert.equal((html.match(/<span class="label">仓库<\/span>/g) || []).length, 1, '仓库路径行只出现一次');
ok('仓库路径行只出现一次');
assert.equal((html.match(/\$\('repo'\)\.textContent =/g) || []).length, 1, '路径只由一个元素渲染');
ok('路径只由一个元素渲染');
text(html, 'data.repo ? text(data.repo)', '有 repo 时显示 repo');
text(html, 'data && data.folder ? text(data.folder)', '无 repo 时回退 workspace 路径');
text(html, ": '未打开工作区';", '都没有时显示未打开工作区');

// --- 设置项（仅项目局部） -------------------------------------------------
for (const id of ['sParallel', 'sRepairs', 'sDshFrontend', 'sReviewCodex', 'sReviewDsh', 'sInitialCommit', 'saveSettings',
    'dshBoundSession', 'dshBindingDetail', 'dshThreadInput', 'dshBindButton', 'dshUnbindButton']) {
    text(html, 'id="' + id + '"', '设置控件 ' + id);
}
for (const value of ['value="1"', 'value="2"', 'value="4"', 'value="8"', 'value="unlimited"']) {
    text(html, value, '并行档位 ' + value);
}
text(html, 'id="sRepairs"', '返修上限选择器');
text(html, '<option value="unlimited">unlimited · 无限制</option>', '返修上限无限制选项');
text(html, '返修上限必须是 0 到 10 之间的整数，或选择无限制。', '返修上限校验含无限制');
text(html, "repairValue === 'unlimited'", '保存无限制值');
text(html, '保存到当前项目 .local-workflow/settings.json。', '设置页写明保存位置');
missing(html, /保存范围/, '不再有保存范围选择器');
missing(html, /id="sScope"/, '不再有 scope 下拉');
missing(html, /value="global"|'global'/, 'UI 不再提供全局范围');
has(html, /scope: 'folder'/, 'settings 消息固定 scope=folder');
text(html, 'maxParallel:', 'settings 字段 maxParallel');
text(html, 'maxRepairs:', 'settings 字段 maxRepairs');
text(html, 'useDshFrontend:', 'settings 字段 useDshFrontend');
text(html, 'reviewCodex:', 'settings 字段 reviewCodex');
text(html, 'reviewDsh:', 'settings 字段 reviewDsh');
text(html, 'initialCommit:', 'settings 字段 initialCommit');

// --- 初始提交 -------------------------------------------------------------
text(html, '阶段开始时自动提交当前工作区', 'initialCommit 复选框说明');
text(html, 'id="commitSnapshotSettings"', '设置页「提交当前工作区快照」按钮');
text(html, '提交当前工作区快照', '设置页快照按钮文案');
text(html, '会把当前未提交改动提交为基线；执行前扩展会弹确认。', '快照按钮旁的风险说明');
assert.equal((html.match(/send\('initialCommit'\)/g) || []).length, 1, 'initialCommit 消息只有一处');
ok('initialCommit 消息只发送一次（共用一套逻辑）');
text(html, "$('commitSnapshotSettings').onclick = commitSnapshot", '设置页快照按钮共用同一函数');

// --- 绑定区 ---------------------------------------------------------------
text(html, 'id="threadInput"', '未绑定时粘贴会话的输入框');
text(html, 'id="bindButton"', '绑定按钮');
text(html, 'id="unbindButton"', '解除绑定按钮');
text(html, 'codex://threads/', '输入框提示接受 Codex 链接');
text(html, 'type="text" spellcheck="false"', '会话输入框为单行 text 输入');
text(html, 'id="boundSession"', '绑定会话摘要');

// --- Cline 前端模式 -------------------------------------------------------
text(html, 'id="clineSection" hidden', 'Cline 模式区域初始隐藏');
text(html, 'Cline 前端模式', 'Cline 模式标题');
text(html, 'Codex 暂不使用；在 Cline 插件里手动 Plan / Act。这里只同步交接文件。', 'Cline 模式说明');
text(html, "const CLINE_STATUS_NAMES = { todo: '排队中', doing: '实现中', done: '已完成', blocked: '修复中' };",
    'Cline 四状态映射');
text(html, 'id="clinePlan"', 'plan 容器');
text(html, '.plan{white-space:pre-wrap', 'plan 用 pre-wrap 保留换行');
text(html, "text(payload.plan) || '（交接文件里还没有 plan）'", 'plan 为空时的兜底文案');
text(html, 'id="clineTasks"', 'Cline 任务列表容器');
text(html, "'路径：' + task.paths.map", 'Cline 任务显示 paths');
text(html, "'备注：' + text(task.notes)", 'Cline 任务显示 notes');
text(html, '<h3>等待处理的请求</h3>', 'Cline 队列标题');
text(html, 'id="clineQueueSection" hidden', 'Cline 队列空时隐藏');
const queueBody = html.slice(html.indexOf('function renderClineQueue'), html.indexOf('function renderCline()'));
assert.ok(!queueBody.includes('cancelQueued'), 'Cline 队列不提供取消请求');
ok('Cline 队列只读（无 cancelQueued）');
text(html, 'id="openCline"', '「打开 Cline」按钮');
has(html, /send\('openCline'\)/, '打开 Cline 发送 openCline');
text(html, 'id="switchCodex"', '「切回 Codex」按钮');
text(html, "send('frontend', { mode: 'codex' })", '切回 Codex 发送 frontend 消息');
text(html, "data.frontend === 'cline'", 'frontend 缺省时按 codex 处理');
text(html, "$('codexSection').hidden = cline", 'Cline 模式隐藏阶段/任务区');
text(html, "$('clineSection').hidden = !cline", '非 Cline 模式隐藏 Cline 区');
text(html, '调度：由 Cline 手动操作', 'Cline 模式调度只读文案');
text(html, '使用 DSH 前端（默认 Codex）', 'useDshFrontend 复选框新文案');
text(html, '启用 DSH 自审（goal 循环，作为初审）', 'reviewDsh 复选框');
text(html, '启用 Codex 复审', 'reviewCodex 复选框');
missing(html, /启用 Cline 前端模式/, '旧的 Cline 前端复选框已移除');
text(html, "if (cline) {", 'render 按 frontend 分支渲染');
const clineBody = html.slice(html.indexOf('function renderClineTasks'), html.indexOf('function render()'));
assert.ok(!clineBody.includes('STATUSES') && !clineBody.includes('sbadge'), 'Cline 视图不渲染 7 徽章');
assert.ok(!clineBody.includes('stageActions'), 'Cline 视图不渲染阶段操作');
ok('Cline 视图无阶段卡片/7 徽章/阶段操作');
const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
assert.equal((nav.match(/<button\b/g) || []).length, 4, 'tab 导航包含任务、验收、设置和刷新');
ok('任务/验收/设置三个 tab，刷新在同一排');

// --- 消息契约 -------------------------------------------------------------
has(html, /send\('ready'\)/, '挂载后发送 ready');
has(html, /send\('refresh'\)/, '刷新按钮发送 refresh');
has(html, /send\('selectStage', \{ run:/, '阶段选择发送 selectStage');
has(html, /send\('cancelQueued', \{ id: item\.id \}\)/, '取消请求发送 cancelQueued');
has(html, /send\('action', \{ action: 'accept', run: stage\.id \}\)/, '验收 action:accept');
has(html, /send\('action', \{ action: 'reject', run: stage\.id, text: feedback \}\)/, '退回 action:reject + 意见');
missing(html, /send\('action', \{ action: 'resume', run: stage\.id \}\)/, '阶段卡不再有继续按钮');
missing(html, /send\('action', \{ action: 'interrupt'/, '不再发送 interrupt');
missing(html, /send\('action', \{ action: 'cancelStage'/, '不再发送 cancelStage');
has(html, /send\('action', \{ action: 'rollback'/, '任务回退 action:rollback');
missing(html, /send\('action', \{ action: 'revalidate'/, '不再发送 revalidate');
missing(html, /send\('action', \{ action: 'retry', run: stage\.id \}\)/, '不再有阶段重试');
has(html, /send\('action', \{ action: 'cancelTask'/, '任务取消按钮恢复');
has(html, /send\('action', \{ action: 'retryTask'/, '任务重试按钮恢复');
has(html, /send\('openCline', \{ taskId:/, '查看 Cline 历史按钮恢复');
missing(html, /send\('unbind', \{ run: stage\.id \}\)/, '阶段卡不再有解除绑定');
has(html, /send\('bind', \{ threadId: threadId \}\)/, '绑定发送 bind + threadId');
has(html, /send\('settings', \{/, '保存设置发送 settings');
text(html, 'api.postMessage', '所有交互走 postMessage');

// --- 无聊天 / 无 markdown / 无外部资源 ------------------------------------
text(html, "document.createElement('textarea')", '只有验收退回意见 textarea');
missing(html, /发送消息/, '没有聊天发送文案');
missing(html, /id="send"/, '没有发送按钮');
missing(html, /markdown/i, '没有 markdown 渲染');
missing(html, /innerHTML/, '不用 innerHTML 注入文本');
text(html, 'createElement', '用 DOM 节点构建界面');
text(html, 'textContent', '文本一律走 textContent（天然转义）');
missing(html, /<img|<link|<iframe|<object/i, '没有外部资源标签');
missing(html, /\bhttps?:\/\//i, '没有 http(s) 外部地址');
missing(html, /\$\{/, '模板占位符已全部展开');
missing(html, /require\(/, '页面脚本没有 require');

// --- 焦点与滚动 -----------------------------------------------------------
text(html, 'document.activeElement === element', '设置回填跳过正在编辑的控件');
text(html, 'main.scrollTop = scrollTop', '重绘后恢复滚动位置');
text(html, 'lastSignature', '按数据签名跳过重复重绘');
text(html, 'renderStagePicker', '阶段下拉按签名复用，避免丢选择');

// --- 内联脚本语法可编译 ---------------------------------------------------
const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
assert.ok(script, '能提取内联脚本');
assert.doesNotThrow(() => new Function(script[1]), '内联脚本语法必须有效');
ok('内联脚本通过 new Function 编译');

// --- DOM id 唯一，避免事件绑定挂错元素 ------------------------------------
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
assert.ok(ids.length >= 28, '应有足够的静态 id，实际 ' + ids.length);
assert.equal(new Set(ids).size, ids.length, '重复 id：' + ids.filter((id, index) => ids.indexOf(id) !== index));
ok('静态 DOM id 唯一（' + ids.length + ' 个）');

// --- nonce 校验 -----------------------------------------------------------
assert.throws(() => webview(), /nonce/);
assert.throws(() => webview(''), /nonce/);
assert.throws(() => webview('short'), /nonce/);
assert.throws(() => webview('bad" onload="alert(1)'), /nonce/);
ok('非法 or 过短 nonce 直接抛中文错误');

const other = webview('AnotherNonce0123456789');
assert.notEqual(other, html);
assert.equal(other.split('AnotherNonce0123456789').join(nonce), html, '不同 nonce 只影响 nonce 相关字节');
ok('不同 nonce 只替换 nonce 出现处');

console.log('\nstatus-panel smoke ok（' + checks + ' 项检查）');
