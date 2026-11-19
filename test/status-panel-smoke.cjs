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

// --- 两个 tab -------------------------------------------------------------
text(html, '>任务</button>', '任务 tab 文案');
text(html, '>设置</button>', '设置 tab 文案');
text(html, 'id="taskTab" aria-selected="true"', '默认选中任务页');
text(html, 'id="settingsTab" aria-selected="false"', '设置页初始未选中');
text(html, 'id="tasksPage"', '任务页容器');
text(html, 'id="settingsPage" hidden', '设置页初始隐藏');
has(html, /\$\('tasksPage'\)\.hidden = tab !== 'tasks'/, '切换 tab 只切显隐');
has(html, /\$\('settingsPage'\)\.hidden = tab !== 'settings'/, '设置页按 tab 显示');
has(html, /\$\('taskTab'\)\.setAttribute\('aria-selected'/, 'tab 同步 aria-selected');
text(html, 'scrollMemory', '两个 tab 各自记忆滚动位置');
text(html, 'function selectTab', 'tab 切换函数');
ok('两个 tab 且切换不重建页面');

// 绑定在任务页，设置项在设置页
const tasksIndex = html.indexOf('id="tasksPage"');
const bindingIndex = html.indexOf('id="bindingSection"');
const settingsIndex = html.indexOf('id="settingsPage"');
const settingsFieldIndex = html.indexOf('id="sParallel"');
assert.ok(tasksIndex < bindingIndex && bindingIndex < settingsIndex, '绑定区必须在任务页内');
ok('绑定区位于任务页');
assert.ok(settingsFieldIndex > settingsIndex, '设置项必须在设置页内');
ok('设置项位于设置页');

// --- 7 个状态标签 ---------------------------------------------------------
text(html, "const STATUSES = ['排队中', '规划中', '实现中', '审查中', '修复中', '待验收', '已验收'];",
    '7 个状态按固定顺序声明');
for (const label of ['排队中', '规划中', '实现中', '审查中', '修复中', '待验收', '已验收']) {
    text(html, "'" + label + "'", '状态标签 ' + label);
}
has(html, /for \(const status of STATUSES\)/, '逐阶段渲染 7 个徽章');
text(html, "status === active ? 'sbadge on' : 'sbadge'", '当前状态徽章高亮');
text(html, 'stageBadgeName', '阶段展示状态由 display 归一');
text(html, "原因：", '阶段展示等待/阻塞原因');
text(html, '进度：共 ', '阶段展示 progress 计数');
text(html, '阶段步骤：', '阶段展示 stageStep');

text(html, 'id="pipelineState"', '调度状态（只读）');
text(html, "'调度：' + (paused ? '已暂停' : '运行中')", '调度状态文案只读刷新');
text(html, 'id="pipelineHint"', '调度状态旁的小字说明');
text(html, '在 Codex 里说“暂停调度/继续调度”即可，面板不直接控制。', '说明调度由 Codex 发起');
missing(html, /id="togglePipeline"/, '面板不提供暂停/恢复调度按钮');
missing(html, /'pipelinePause'|'pipelineResume'|send\('pipeline/, '不再发送 pipelinePause/pipelineResume');
assert.equal((html.match(/暂停调度/g) || []).length, 1, '「暂停调度」只应出现在只读说明里');
ok('「暂停调度」仅出现在只读说明中');
missing(html, /恢复调度/, '不再有「恢复调度」按钮文案');
missing(html, /actionButton\(paused \?/, '阶段操作里也没有暂停/恢复按钮');

// --- 阶段 / 任务 / 队列说明 -----------------------------------------------
text(html, '阶段 = 一次完整开发（规划 → 实现 → 测试 → 审查 → 验收）；任务 = 阶段内拆分出的可并行工作项。',
    '任务页顶部解释阶段与任务');
text(html, '<h3>当前阶段</h3>', '「当前阶段」分区');
text(html, '<h3>阶段任务</h3>', '「阶段任务」分区');
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

// --- 任务分组（四组） -----------------------------------------------------
text(html, "const TASK_GROUPS = ['排队中', '实现中', '审查中', '修复中'];", '任务分四组且顺序固定');
text(html, "if (status === '审查中' || status === '待审查') return '审查中';", '审查中/待审查归入审查中组');
text(html, "if (status === '实现中' || status === '测试中' || status === '集成中' || status === '取消中') return '实现中';",
    '实现中组只含实现/测试/集成/取消中，审查中已移出');
text(html, "if (status === '需处理' || status === '已取消') return '修复中';", '需处理/已取消归入修复中组');
text(html, '等待 Codex 返回审查结论；不会自动完成。', '审查中组标题旁的小字');
text(html, "if (group === '审查中')", '只有审查中组带这句说明');
text(html, 'groupTitle', '审查中组标题单独排版');
text(html, '这个阶段当前没有排队中、实现中、审查中或修复中的任务。', '空任务提示覆盖四组');
has(html, /for \(const \[group, tasks\] of groups\)/, '按 TASK_GROUPS 顺序渲染各组');

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
text(html, 'clinePayload().repo ? text(clinePayload().repo) :', 'Cline 模式可回退 cline.repo');
text(html, ": '未打开工作区';", '都没有时显示未打开工作区');

// --- 设置项（仅项目局部） -------------------------------------------------
for (const id of ['sParallel', 'sRepairs', 'sClinePlan', 'sInitialCommit', 'saveSettings']) {
    text(html, 'id="' + id + '"', '设置控件 ' + id);
}
for (const value of ['value="1"', 'value="2"', 'value="4"', 'value="8"', 'value="unlimited"']) {
    text(html, value, '并行档位 ' + value);
}
text(html, 'id="sRepairs" type="number" min="0" max="10"', '返修上限 0–10 的数字输入');
text(html, '保存到当前项目 .local-workflow/settings.json。', '设置页写明保存位置');
missing(html, /保存范围/, '不再有保存范围选择器');
missing(html, /id="sScope"/, '不再有 scope 下拉');
missing(html, /value="global"|'global'/, 'UI 不再提供全局范围');
has(html, /scope: 'folder'/, 'settings 消息固定 scope=folder');
text(html, 'maxParallel:', 'settings 字段 maxParallel');
text(html, 'maxRepairs:', 'settings 字段 maxRepairs');
text(html, 'useClinePlan:', 'settings 字段 useClinePlan');
text(html, 'initialCommit:', 'settings 字段 initialCommit');

// --- 初始提交 -------------------------------------------------------------
text(html, '阶段开始时自动提交当前工作区', 'initialCommit 复选框说明');
text(html, 'id="commitSnapshot"', '任务页小号「提交快照」按钮');
text(html, '提交快照', '任务页快照按钮文案');
text(html, 'id="commitSnapshotSettings"', '设置页「提交当前工作区快照」按钮');
text(html, '提交当前工作区快照', '设置页快照按钮文案');
text(html, '会把当前未提交改动提交为基线；执行前扩展会弹确认。', '快照按钮旁的风险说明');
assert.equal((html.match(/send\('initialCommit'\)/g) || []).length, 1, 'initialCommit 消息只有一处');
ok('initialCommit 消息只发送一次（共用一套逻辑）');
text(html, "$('commitSnapshot').onclick = commitSnapshot", '任务页快照按钮共用同一函数');
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
text(html, '启用 Cline 前端模式（Codex 没额度时）', 'useClinePlan 复选框新文案');
missing(html, /由 Cline Plan 接管规划/, '旧的 useClinePlan 文案已移除');
text(html, "if (cline) {", 'render 按 frontend 分支渲染');
const clineBody = html.slice(html.indexOf('function renderClineTasks'), html.indexOf('function render()'));
assert.ok(!clineBody.includes('STATUSES') && !clineBody.includes('sbadge'), 'Cline 视图不渲染 7 徽章');
assert.ok(!clineBody.includes('stageActions'), 'Cline 视图不渲染阶段操作');
ok('Cline 视图无阶段卡片/7 徽章/阶段操作');
const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
assert.equal((nav.match(/<button\b/g) || []).length, 2, 'Cline 视图没有新增第三个 tab');
ok('Cline 视图放在任务 tab 内，仍只有两个 tab');

// --- 消息契约 -------------------------------------------------------------
has(html, /send\('ready'\)/, '挂载后发送 ready');
has(html, /send\('refresh'\)/, '刷新按钮发送 refresh');
has(html, /send\('selectStage', \{ run:/, '阶段选择发送 selectStage');
has(html, /send\('cancelQueued', \{ id: item\.id \}\)/, '取消请求发送 cancelQueued');
has(html, /send\('action', \{ action: 'interrupt', run: stage\.id \}\)/, '中断执行 action:interrupt');
has(html, /send\('action', \{ action: 'cancelStage', run: stage\.id \}\)/, '取消阶段 action:cancelStage');
has(html, /send\('action', \{ action: 'rollback', task: candidate\.id, run: stage\.id \}\)/, '回退本轮 action:rollback');
has(html, /send\('action', \{ action: 'accept', run: stage\.id \}\)/, '验收 action:accept');
has(html, /send\('action', \{ action: 'retry', run: stage\.id \}\)/, '阶段重试 action:retry');
has(html, /send\('action', \{ action: 'cancelTask', task: task\.id, run: stage\.id \}\)/, '任务取消 action:cancelTask');
has(html, /send\('action', \{ action: 'retryTask', task: task\.id, run: stage\.id \}\)/, '任务重试 action:retryTask');
has(html, /send\('openCline', \{ taskId: task\.id, run: stage\.id \}\)/, '查看 Cline 历史发送 openCline');
has(html, /send\('unbind', \{ run: stage\.id \}\)/, '解除绑定发送 unbind');
has(html, /send\('bind', \{ threadId: threadId \}\)/, '绑定发送 bind + threadId');
has(html, /send\('settings', \{/, '保存设置发送 settings');
text(html, 'api.postMessage', '所有交互走 postMessage');

// --- 无聊天 / 无 markdown / 无外部资源 ------------------------------------
missing(html, /<textarea/i, '没有 textarea（无聊天输入）');
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
