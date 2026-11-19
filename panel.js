const { readFileSync } = require('node:fs');
const path = require('node:path');

const markdownScript = readFileSync(path.join(__dirname, 'vendor', 'markdown-it.umd.min.js'), 'utf8')
    .replace(/<\/script/gi, '<\\/script');

function webview(nonce) {
    return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'">
<style nonce="${nonce}">
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;color:var(--vscode-foreground);font:var(--vscode-font-size)/1.55 var(--vscode-font-family);display:flex;flex-direction:column;height:100vh}
header{padding:10px 14px 0;border-bottom:1px solid var(--vscode-panel-border)}
.topline,.row,.buttons{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.topline{justify-content:space-between}.row{justify-content:space-between}
#current{margin:8px 0 9px;overflow-wrap:anywhere;max-height:30vh;overflow:auto}.label{color:var(--vscode-descriptionForeground);font-size:.92em}
#current .row p{flex:1;min-width:0;margin:0}
#current .row{padding:3px 0}
#current>p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden}
nav{display:flex;gap:16px}nav button{border:0;border-bottom:2px solid transparent;background:none;color:var(--vscode-descriptionForeground);padding:6px 0}
nav button[aria-selected=true]{border-bottom-color:var(--vscode-focusBorder);color:var(--vscode-foreground)}
main{flex:1;min-height:0;overflow:auto;padding:12px 14px}
footer{padding:8px 14px 12px;border-top:1px solid var(--vscode-panel-border)}
p,h3,h4{margin:0 0 7px;white-space:pre-wrap;overflow-wrap:anywhere}
h3{font-size:1.05em}h4{font-size:1em}
button,input,textarea,select{font:inherit}
button{cursor:pointer}
button:disabled{opacity:.55;cursor:default}
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible,summary:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.primary,.secondary{padding:4px 9px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px}
.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}
.primary:hover{background:var(--vscode-button-hoverBackground)}
.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
.link{padding:2px 0;background:none;border:0;color:var(--vscode-textLink-foreground);text-align:left;overflow-wrap:anywhere}
select,input:not([type=checkbox]),textarea{border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:3px;padding:4px 7px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);max-width:100%}
textarea,#test{width:100%}textarea{resize:vertical;min-height:56px;margin:6px 0}
#mode{min-width:92px}.topline select{max-width:70%}
.bubble{margin-bottom:12px;padding:8px 10px;border-radius:5px;background:var(--vscode-editor-background)}
.bubble.user{margin-left:20px;background:var(--vscode-textBlockQuote-background,var(--vscode-editor-background))}
.bubble p:last-child{margin-bottom:0}
.markdown{min-width:0;overflow-wrap:anywhere}
.markdown p,.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{white-space:normal}
.markdown h1,.markdown h2,.markdown h3,.markdown h4,.markdown h5,.markdown h6{margin:12px 0 5px;line-height:1.35}
.markdown h1{font-size:1.35em}.markdown h2{font-size:1.2em}
.markdown :first-child{margin-top:0}.markdown :last-child{margin-bottom:0}
.markdown ul,.markdown ol{padding-left:21px;margin:6px 0}
.markdown li{margin:2px 0}
.markdown pre,.markdown .table-scroll{max-width:100%;overflow:auto;margin:8px 0}
.markdown pre{padding:8px;border:1px solid var(--vscode-panel-border);background:var(--vscode-textCodeBlock-background)}
.markdown code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background)}
.markdown pre code{background:none;white-space:pre;overflow-wrap:normal}
.markdown blockquote{margin:8px 0;padding:4px 8px;border-left:3px solid var(--vscode-textBlockQuote-border);background:var(--vscode-textBlockQuote-background)}
.markdown table{border-collapse:collapse}.markdown th,.markdown td{border:1px solid var(--vscode-panel-border);padding:4px 6px}
.markdown th{background:var(--vscode-textBlockQuote-background)}
.markdown a{color:var(--vscode-textLink-foreground)}
.markdown hr{border:0;border-top:1px solid var(--vscode-panel-border)}
.decision{padding:8px 0 4px;border-top:1px solid var(--vscode-panel-border)}
.task{padding:8px 0;border-bottom:1px solid var(--vscode-panel-border)}
.badge{color:var(--vscode-descriptionForeground);font-size:.9em;white-space:nowrap}
summary{cursor:pointer;color:var(--vscode-descriptionForeground)}
details{margin:6px 0 10px}
.settings-field{margin:0 0 12px}.settings-field>label{display:block;margin:5px 0}
ol{padding-left:21px;margin:8px 0}li{margin-bottom:6px;overflow-wrap:anywhere}
#error{color:var(--vscode-errorForeground);margin-top:5px}
[hidden]{display:none!important}
</style>
<body>
<header>
  <div class="topline"><strong>本地开发工作流</strong><select id="folder" aria-label="工作区文件夹" hidden></select></div>
  <div id="current" aria-live="polite"></div>
  <div class="row" id="stageControls" hidden>
    <select id="stagePicker" aria-label="查看任务阶段"></select>
    <button id="pipelineToggle" class="link"></button>
  </div>
  <nav aria-label="工作流视图">
    <button id="chatTab" aria-selected="true">对话</button>
    <button id="queueTab" aria-selected="false">队列</button>
    <button id="settingsTab" aria-selected="false">设置</button>
  </nav>
  <div class="row" id="linkedSession">
    <div aria-live="polite"><strong id="linkedTitle"></strong><div class="label" id="linkedStatus"></div></div>
    <button class="link" id="refreshTitle" hidden>刷新标题</button>
  </div>
  <div class="row" id="quotaRow" hidden><span class="label" id="quotaText"></span><button class="link" id="refreshQuota">刷新额度</button></div>
  <p id="error" role="alert"></p>
  <div class="row" id="handoff" hidden><span class="label" id="handoffStatus"></span><button id="retryHandoff" hidden>重试交接</button></div>
</header>
<main id="main">
  <section id="chat">
    <details id="history" hidden><summary>Codex 会话历史</summary>
      <div class="buttons"><button id="refreshHistory">刷新</button><button id="openChat">在 Codex Desktop 打开</button></div>
      <div id="historyMessages"></div>
    </details>
    <div id="messages"></div><div id="codexQuestion"></div><div id="decision"></div>
  </section>
  <section id="queue" hidden><div id="tasks"></div><div id="pending"></div>
    <details id="archiveList"><summary id="archiveSummary">已验收</summary><div id="archives"></div></details>
    <div id="archiveDetail" hidden></div>
  </section>
  <section id="settings" hidden>
    <div class="settings-field"><label for="thread">Codex 会话 ID 或链接</label>
      <input id="thread" type="text" spellcheck="false" placeholder="留空时首次发送自动创建">
      <p class="label" id="threadStatus"></p>
      <div class="buttons"><button id="bindThread" class="primary">保存会话绑定</button><button id="copyThread">复制链接</button><button id="openThread">打开桌面会话</button></div>
      <p class="label">可在「对话 → Codex 会话历史」查看已保存的讨论。桌面端打开会话后可能会暂时占用写入连接。</p>
    </div>
    <div class="settings-field"><label for="parallel">实现最大并行数</label><select id="parallel"><option value="1">无并行</option><option>2</option><option>4</option><option>8</option><option value="unlimited">无限制</option></select></div>
    <div class="settings-field"><label for="repairs">自动返修上限</label><input id="repairs" type="number" min="0" max="10"></div>
    <div class="settings-field"><label><input id="clinePlan" type="checkbox"> 由 Cline Plan 接管对话和规划</label>
    <p class="label">保存后应用于当前文件夹。关闭时把接管期间的进度交回 Codex。审查始终由 Codex 负责。</p></div>
    <div class="settings-field"><label><input id="clineAct" type="checkbox"> 实现使用 Cline Act 模型</label>
    <p class="label">开启后，下一次实现或返修使用 Cline 原生 Act 供应商和模型。选择云端供应商时，任务内容会发给该供应商。关闭时使用本机 Ollama。</p></div>
    <div class="buttons"><button class="primary" id="save">保存</button><button class="secondary" id="cline">Cline 设置</button><button class="secondary" id="codex">Codex 设置</button></div>
  </section>
</main>
<footer id="composer">
  <div class="row"><select id="mode" aria-label="消息用途"><option value="chat">Codex 对话</option><option value="current">回应当前开发任务</option><option value="new">直接提交开发任务</option></select>
  <button id="logs" class="link">运行日志</button></div>
  <textarea id="input" rows="2" aria-label="发送消息" placeholder="发送消息…"></textarea>
  <details id="options"><summary>测试命令（可选）</summary><input id="test" aria-label="可选测试命令" placeholder="留空由规划选择"></details>
  <div class="row"><span class="label" id="hint">Enter 发送 · Shift+Enter 换行</span><button id="stopChat" hidden>中断回复</button><button id="send" class="primary">发送</button></div>
</footer>
<script nonce="${nonce}">${markdownScript}</script>
<script nonce="${nonce}">
const api=acquireVsCodeApi();
const markdown=window.markdownit({html:false,breaks:true});
markdown.validateLink=url=>/^https?:[/][/]/i.test(url);
markdown.renderer.rules.image=(tokens,index)=>markdown.utils.escapeHtml(tokens[index].content);
markdown.renderer.rules.table_open=()=>'<div class="table-scroll"><table>';
markdown.renderer.rules.table_close=()=>'</table></div>';
const $=id=>document.getElementById(id);
let data, tab='chat', archive, initialized=false, lastDecision, questionId;
const quotaByFolder=new Map();
const send=(type,extra={})=>api.postMessage({ type, folder:data?.folder, ...extra });
const node=(tag,text,cls)=>{
    const element=document.createElement(tag);
    if(text)element.textContent=text;
    if(cls)element.className=cls;
    return element;
};
function button(label,callback,style='secondary'){
    const element=node('button',label,style);element.onclick=callback;return element;
}
function formatted(text){
    const result=node('div','','markdown');
    result.innerHTML=markdown.render(text||'');
    return result;
}
document.addEventListener('click',event=>{
    const link=event.target.closest('.markdown a[href]');
    if(!link)return;
    event.preventDefault();
    send('openMarkdownLink',{url:link.getAttribute('href')});
});
function requestAction(action,text,task,run=data?.state.id){
    send('action',{action,text,task,run});
}
function selectTab(next){
    tab=next;
    for(const name of ['chat','queue','settings']){
        $(name).hidden=name!==next;
        $(name+'Tab').setAttribute('aria-selected',String(name===next));
    }
    $('composer').hidden=next==='settings';
    $('linkedSession').hidden=next!=='chat';
    updateQuota();
    updateComposer();
    if(next==='chat')$('main').scrollTop=$('main').scrollHeight;
}
for(const name of ['chat','queue','settings'])$(name+'Tab').onclick=()=>selectTab(name);
function showReview(target,review,task,recordId){
    if(!review)return;
    if(review.summary)target.append(formatted(review.summary));
    for(const finding of review.findings||[]){
        target.append(button((finding.blocking?'阻塞 · ':'')+finding.path+':'+finding.line+' · '+finding.problem,
            ()=>send('file',{path:finding.path,line:finding.line,task,archive:recordId,run:data?.state.id}),'link'));
        if(finding.correction)target.append(formatted(finding.correction));
    }
}
function messages(target,list){
    for(const item of list||[]){
        const wrapper=node('div','',item.role==='user'?'bubble user':'bubble');
        wrapper.append(item.role==='user'?node('p',item.text):formatted(item.text));target.append(wrapper);
        if(item.cancelled)wrapper.append(node('p','已取消队列请求','label'));
        else if(item.queuedId && data.queue.some(entry=>entry.id===item.queuedId))wrapper.append(node('p','已提交 · 等待规划','label'));
        if(item.proposal?.dispatched)wrapper.append(node('p','已提交开发规划，确认方案后由 Cline 实现。','label'));
        if(item.dispatchError)wrapper.append(node('p',item.dispatchError,'label'));
        if(item.retry&&!data.chatting)wrapper.append(button('重试消息',()=>send('retryChat',{id:item.retry.id})));
        if(item.proposal && item.proposal.threadId===data.codexThreadId && !item.proposal.dispatched) {
            wrapper.append(button('重试提交开发任务',()=>send('dispatch',{id:item.proposal.id}),'primary'));
        }
    }
}
function inputRoute(){
    if(!data?.repo)return null;
    const state=data.state, mode=$('mode').value;
    if(mode==='chat'){
        const model=data.settings.useClinePlan?'Cline Plan':'Codex';
        if(data.chatting)return data.canSteerChat?{mode:'steerChat',hint:'补充给正在回复的 '+model}:null;
        return {mode:'chat',hint:'与 '+model+' 讨论，或提出实现请求'};
    }
    if(mode==='new')return {mode:'new',hint:'提交新任务，忙碌时排队'};
    if(state.phase==='待澄清')return {action:'answerPlan',hint:'回答规划问题'};
    if(state.phase==='待确认方案')return {action:'revise',hint:'提出方案修改意见'};
    if(state.inbox?.length && !['已暂停','已请求暂停','联合验收中'].includes(state.phase))
        return {action:'answerTask',task:state.inbox[0].id,hint:'回答当前任务问题'};
    if(state.phase==='待验收')return {action:'reject',hint:'回复「验收通过」，或提出修改意见'};
    if(['规划中','运行中','联合验收中'].includes(state.phase))return {action:'steer',
        hint:state.phase==='规划中'?'补充阶段规划要求':'阶段级插话 · 会中断并更新尚未集成的任务'};
    if(['已暂停','需处理'].includes(state.phase))return {action:'resume',hint:'补充要求后继续'};
    if(['规划失败','规划已中断'].includes(state.phase))return {action:'retry',hint:'补充要求并重新规划'};
    return null;
}
function updateComposer(){
    const route=inputRoute();
    $('input').placeholder=route?.hint||(data?.repo?'等待当前操作完成，或切换到 Codex 对话':'请打开受信任的本地 Git 文件夹');
    $('send').disabled=!route;
    $('stopChat').hidden=!data?.chatting;
    $('options').hidden=route?.mode!=='new';
}
function submit(){
    const route=inputRoute(),text=$('input').value;
    if(!route||!text.trim())return;
    $('error').textContent='';
    if(route.action==='reject'&&/^(?:通过|审查通过|验收通过|确认通过|通过验收)[。！!]*$/.test(text.trim())){
        requestAction('accept',text);return;
    }
    if(route.action){requestAction(route.action,text,route.task);return;}
    if(route.mode==='steerChat'){send('chatSteer',{text});return;}
    send('send',{mode:route.mode,text,test:$('test').value});
}
$('mode').onchange=updateComposer;
$('stagePicker').onchange=()=>send('selectStage',{run:$('stagePicker').value});
$('pipelineToggle').onclick=()=>send(data.pipelinePaused?'pipelineResume':'pipelinePause',{run:data.state.id});
$('folder').onchange=()=>send('folder',{folder:$('folder').value});
$('input').onkeydown=event=>{
    if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();submit();}
};
$('send').onclick=submit;
$('stopChat').onclick=()=>send('chatStop');
$('retryHandoff').onclick=()=>{$('error').textContent='';send('retryHandoff');};
$('refreshTitle').onclick=()=>send('codexTitle');
$('refreshQuota').onclick=()=>updateQuota(true);
function updateQuota(force=false){
    $('quotaRow').hidden=tab!=='chat'||!data?.repo;
    if($('quotaRow').hidden)return;
    let quota=quotaByFolder.get(data.folder);
    if(force||!quota||(!quota.loading&&Date.now()-quota.time>120000)){
        quota={...quota,loading:true};
        quotaByFolder.set(data.folder,quota);
        send('codexQuota');
    }
    $('refreshQuota').disabled=Boolean(quota.loading);
    $('quotaText').textContent=quota.limits?.length?quota.limits.map(window=>{
        const period=window.minutes===10080?'每周':window.minutes>=60?window.minutes/60+' 小时':window.minutes?window.minutes+' 分钟':'额度';
        return period+'剩余 '+Math.max(0,100-window.used)+'%'+(window.reset?' · '+new Date(window.reset*1000).toLocaleString()+' 重置':'');
    }).join(' / '):quota.loading?'正在读取 Codex 额度…':'暂时未能读取 Codex 额度';
}
setInterval(()=>updateQuota(),120000);
$('logs').onclick=()=>send('output');
$('cline').onclick=()=>send('native',{provider:'cline'});
$('codex').onclick=()=>send('native',{provider:'codex'});
$('save').onclick=()=>send('settings',{maxParallel:$('parallel').value,maxRepairs:Number($('repairs').value),useClinePlan:$('clinePlan').checked,useClineAct:$('clineAct').checked});
$('bindThread').onclick=()=>{$('error').textContent='';send('codexBind',{value:$('thread').value});};
$('copyThread').onclick=()=>send('codexCopy');
$('openThread').onclick=$('openChat').onclick=()=>send('codexOpen');
$('refreshHistory').onclick=()=>send('codexHistory');
$('history').ontoggle=()=>{if($('history').open)send('codexHistory');};

function renderCodexQuestion(question){
    if(question?.id===questionId)return;
    questionId=question?.id;
    const target=$('codexQuestion');
    target.replaceChildren();
    if(!question)return;
    const form=node('form','','card');
    form.append(node('h3','Codex 需要你确认'));
    const fields=new Map();
    for(const entry of question.questions){
        const label=node('label',entry.question,'settings-field');
        const options=entry.options||[];
        let field;
        if(options.length){
            field=node('select');
            const placeholder=node('option','请选择');placeholder.value='';field.append(placeholder);
            for(const option of options){
                const choice=node('option',option.label);choice.title=option.description;choice.value=option.label;field.append(choice);
            }
        }else{
            field=node('input');field.type=entry.isSecret?'password':'text';
        }
        label.append(field);form.append(label);
        const other=node('input');other.type=entry.isSecret?'password':'text';other.placeholder='补充自己的选项';
        if(entry.isOther&&options.length)form.append(other);
        fields.set(entry.id,()=>other.value.trim()||field.value);
    }
    const submit=node('button','回复 Codex','primary');form.append(submit);
    form.onsubmit=event=>{
        event.preventDefault();
        send('codexAnswer',{id:question.id,answers:Object.fromEntries([...fields].map(([id,value])=>[id,value()]))});
    };
    target.append(form);
}

function renderDecision(state){
    const target=$('decision'), s=state.phase, actions=node('div','','buttons');
    target.replaceChildren();
    const title=text=>target.append(node('h3',text));
    const call=(label,action,style)=>actions.append(button(label,()=>requestAction(action,undefined),style));
    if(s==='待澄清'){
        title('需要澄清');target.append(formatted(state.question));
    }else if(s==='待确认方案'){
        title('确认方案');target.append(node('p',state.title));
        if(state.reviewBase){
            target.append(node('p','历史审查范围 '+state.reviewBase.slice(0,10)+'..'+state.reviewCandidate.slice(0,10),'label'));
            target.append(node('p','先测试并审查已提交代码，发现问题才进入实现返修。','label'));
        }
        if(state.authorize)target.append(node('p','已收到执行授权，请确认本轮新增的测试命令。','label'));
        const checks=node('p','阶段测试 ');checks.append(node('code',state.stageTestCommand||state.test));target.append(checks);
        const list=node('ol');
        for(const task of state.tasks){
            const li=node('li');li.append(node('strong',task.title),formatted(task.requirements));
            if(task.criteria?.length){
                const criteria=node('ul');
                for(const criterion of task.criteria){
                    const entry=node('li');entry.append(formatted(criterion));criteria.append(entry);
                }
                li.append(criteria);
            }
            if(task.testCoverage?.length){
                li.append(node('p','本任务需要补的测试','label'));
                const cases=node('ul');
                for(const check of task.testCoverage){const entry=node('li');entry.append(formatted(check));cases.append(entry);}
                li.append(cases);
            }
            if(task.testCommand){const line=node('p','子任务测试 ');line.append(node('code',task.testCommand));li.append(line);}
            list.append(li);
        }
        target.append(list);
        call('确认并运行','approve','primary');
    }else if(state.inbox?.length && !['已暂停','已请求暂停','联合验收中'].includes(s)){
        const current=state.inbox[0];
        title('需要处理 · '+current.title);target.append(formatted(current.text));
        if(state.inbox.length>1)target.append(node('p','另有 '+(state.inbox.length-1)+' 项等待答复','label'));
    }else if(s==='待验收'){
        title('审查报告 · 待人工验收');
        target.append(node('p',state.title));
        showReview(target,state.stageReview);
        if(state.stageReview?.criteria?.length){
            const coverage=node('details');
            coverage.append(node('summary','计划完成情况'));
            const list=node('ul');
            const descriptions=new Map(state.tasks.flatMap(task=>task.criteria.map((criterion,index)=>[task.id+'/A'+(index+1),criterion])));
            for(const check of state.stageReview.criteria){
                const item=node('li');
                item.append(node('strong',descriptions.get(check.id)||check.id),formatted(check.evidence));
                list.append(item);
            }
            coverage.append(list);target.append(coverage);
        }
        if(state.stageTest){
            const tests=node('details');
            tests.append(node('summary','测试通过'+(state.stageTest.command?' · '+state.stageTest.command:'')));
            if(state.stageTest.detail)tests.append(node('pre',state.stageTest.detail));
            target.append(tests);
        }
        if(state.stageHead)actions.append(button('查看阶段差异',()=>send('diff',{run:state.id}),'secondary'));
        call('验收通过并归档','accept','primary');
    }else if(['需处理','规划失败','规划已中断','无可推进任务'].includes(s)){
        title(s);target.append(node('p',state.message||state.title));
        if(s==='需处理')call('继续','resume');
        if(['规划失败','规划已中断'].includes(s))call('重新规划','retry');
    }
    if(s==='规划中')call('中断规划','interrupt');
    if(['运行中','联合验收中'].includes(s))call('暂停执行','pause');
    if(state.cancellable)call(state.reviewRequest?'取消整项审查':'取消整项任务','cancelStage');
    if(s==='已请求暂停'){title('正在暂停');target.append(node('p',state.message));}
    if(s==='已暂停'){title('已暂停');if(state.message)target.append(node('p',state.message,'label'));call('继续','resume','primary');}
    if(['待澄清','待确认方案','待验收'].includes(s)||state.inbox?.length){
        actions.append(button('在输入框回应',()=>{$('mode').value='current';updateComposer();$('input').focus();}));
    }
    if(actions.childElementCount)target.append(actions);
    target.classList.toggle('decision',target.childElementCount>0);
}
function renderArchive(){
    const target=$('archiveDetail');
    target.hidden=!archive;
    if(!archive)return;
    target.replaceChildren(node('h3',archive.title||'已验收任务'));
    messages(target,archive.messages?.length?archive.messages:[{role:'user',text:archive.request}]);
    if(archive.stageTest)target.append(node('p','测试 '+(archive.stageTest.passed?'通过':'失败'),'label'));
    showReview(target,archive.stageReview,undefined,archive.id);
    const controls=node('div','','buttons');
    if(archive.stageHead)controls.append(button('查看最终差异',()=>send('diff',{archive:archive.id})));
    controls.append(button('关闭记录',()=>{archive=undefined;renderArchive();}));
    target.append(controls);
}
function taskControls(task,state){
    const controls=node('div','','buttons');
    if(!['运行中','需处理','已暂停'].includes(state.phase))return controls;
    if(['排队中','排队执行','准备中','实现中','测试中','审查中'].includes(task.status)){
        controls.append(button('取消',()=>requestAction('cancelTask',undefined,task.id,state.id)));
    }else if(['已取消','需处理'].includes(task.status)){
        controls.append(button(state.phase==='已暂停'?'排队重试':'重试',()=>requestAction('retryTask',undefined,task.id,state.id),'primary'));
    }
    return controls;
}
function renderQueue(){
    const tasks=$('tasks');tasks.replaceChildren();
    for(const state of data.stages||[]){
        const section=node('div','','task');
        tasks.append(section);
        section.append(button((state.request||state.title)+' · '+(state.stageStep||state.phase),()=>{
            send('selectStage',{run:state.id});selectTab('chat');
        },'link'));
        if(state.cancellable) {
            section.append(button(state.reviewRequest?'取消整项审查':'取消整项任务',
                ()=>requestAction('cancelStage',undefined,undefined,state.id)));
        }
        const draft=['规划中','规划失败','规划已中断','待确认方案','待澄清'].includes(state.phase);
        const reviewPoints=state.reviewRequest?state.tasks.filter(task=>draft||task.historicalReview):[];
        if(reviewPoints.length){
            const details=node('details');
            details.append(node('summary',(draft?'审查方案草稿':'审查检查项')+' · '+reviewPoints.length+' 项'));
            const list=node('ul');
            for(const task of reviewPoints)list.append(node('li',task.title));
            details.append(list);section.append(details);
        }
        if(draft)continue;
        for(const task of state.tasks.filter(task=>!task.historicalReview)){
            const row=node('div','','task'),top=node('div','','row');
            top.append(node('strong',task.title),node('span',task.status,'badge'));row.append(top);
            if(task.reason)row.append(node('p',task.reason,'label'));
            if(task.round)row.append(node('p','已返修 '+task.round+' 次','label'));
            if(task.test)row.append(node('p','测试 '+(task.test.passed?'通过':'失败'),'label'));
            if(task.candidate)row.append(button('查看差异',()=>send('diff',{task:task.id,run:state.id}),'link'));
            const controls=taskControls(task,state);
            if(controls.childElementCount)row.append(controls);
            if(task.tree&&task.status!=='已集成'&&['已暂停','需处理'].includes(state.phase)){
                row.append(button('回退本轮',()=>requestAction('rollback',undefined,task.id,state.id),'secondary'));
            }
            if(task.backup)row.append(node('p','恢复分支 '+task.backup,'label'));
            section.append(row);
        }
    }
    const waiting=$('pending');waiting.replaceChildren();
    for(const [index,item] of data.queue.entries()){
        const row=node('div','','task');
        const reason=data.pipelinePaused?' · 工作流已暂停':'';
        row.append(node('p',item.request),node('p','规划排队 · 第 '+(index+1)+' 项'+reason,'label'));
        row.append(button('取消',()=>send('cancelQueued',{id:item.id})));
        waiting.append(row);
    }
    if(!tasks.childElementCount&&!waiting.childElementCount)tasks.append(node('p','当前没有排队任务。','label'));
    $('archiveSummary').textContent='已验收'+(data.archive.length?' · '+data.archive.length:'');
    $('archives').replaceChildren();
    for(const record of data.archive){
        const row=node('div','','task');
        row.append(button(record.title,()=>send('archive',{archive:record.id}),'link'));
        if(record.archivedAt)row.append(node('p',new Date(record.archivedAt).toLocaleString(),'label'));
        $('archives').append(row);
    }
    if(!data.archive.length)$('archives').append(node('p','还没有已验收任务。','label'));
    renderArchive();
}
window.addEventListener('message',({data:incoming})=>{
    if(incoming.type==='codexQuota'){
        quotaByFolder.set(incoming.folder,{...incoming,time:Date.now()});
        updateQuota();return;
    }
    if(incoming.type==='error'){if(!incoming.folder||incoming.folder===data?.folder)$('error').textContent=incoming.message;return;}
    if(incoming.type==='sent'){
        if(incoming.folder===data?.folder&&incoming.text&&incoming.text===$('input').value)$('input').value='';
        return;
    }
    if(incoming.type==='archive'&&incoming.folder===data?.folder){archive=incoming.record;renderArchive();return;}
    if(incoming.type==='codexBound'&&incoming.folder===data?.folder){$('thread').value=incoming.id;return;}
    if(incoming.type==='codexHistory'&&incoming.folder===data?.folder&&incoming.id===data.codexThreadId){
        $('historyMessages').replaceChildren();
        messages($('historyMessages'),incoming.history);
        if(!incoming.history.length)$('historyMessages').append(node('p','最近没有可显示的对话。','label'));
        return;
    }
    if(incoming.type!=='state')return;
    const changedFolder=incoming.folder!==data?.folder;
    const changedThread=incoming.codexThreadId!==data?.codexThreadId;
    data=incoming;
    const s=data.state;
    if(changedFolder){archive=undefined;$('mode').value='chat';$('input').value='';$('error').textContent='';$('archiveList').open=false;}
    if(changedFolder||changedThread){
        $('thread').value=data.codexThreadId;
        $('historyMessages').replaceChildren();
        $('history').open=false;
    }
    $('history').hidden=!data.codexThreadId;
    $('bindThread').disabled=!data.repo;
    $('copyThread').disabled=$('openThread').disabled=!data.codexThreadId;
    $('threadStatus').textContent=data.codexThreadId?'已绑定此文件夹':'留空可在第一次使用 Codex 时自动创建会话。';
    const metadata=data.codexMetadata?.id===data.codexThreadId?data.codexMetadata:undefined;
    const linked=$('linkedTitle');
    linked.textContent=!data.repo?'':!data.codexThreadId?'未绑定 Codex 会话':
        metadata?.title||metadata?.preview||(metadata?.loading?'正在读取会话标题…':metadata?.unavailable?'暂时无法读取会话标题':'未命名会话');
    linked.title=linked.textContent;
    $('linkedStatus').textContent=data.codexThreadId?
        (metadata?.unavailable?'绑定已保存 · 标题暂不可用':metadata?.loading?'正在核对绑定':'已绑定 Codex 会话')+
        ' · '+data.codexThreadId.slice(-8)+(metadata?.preview&&!metadata?.title?' · 显示首条消息':''):'';
    $('linkedStatus').title=data.codexThreadId;
    $('refreshTitle').hidden=!data.codexThreadId;
    $('refreshTitle').disabled=Boolean(metadata?.loading);
    $('mode').options[0].textContent=data.settings.useClinePlan?'Cline Plan 临时对话':'Codex 对话';
    $('handoff').hidden=!(data.settings.useClinePlan||data.takeoverPending||data.takeoverSyncing);
    $('handoffStatus').textContent=data.settings.useClinePlan?'Cline 正在接管对话和规划':
        data.takeoverSyncing?'正在把临时对话交回 Codex':'有临时对话待交回 Codex';
    $('retryHandoff').hidden=data.settings.useClinePlan||!data.takeoverPending||data.takeoverSyncing;
    const picker=$('folder');picker.replaceChildren();
    for(const folder of data.folders){const option=node('option',folder.name);option.value=folder.path;picker.append(option);}
    if(data.folder)picker.value=data.folder;
    picker.hidden=data.folders.length<2;
    if(changedFolder||!initialized)$('test').value='';
    if(changedFolder||data.refreshSettings||!initialized){
        $('parallel').value=data.settings.maxParallel;
        $('repairs').value=data.settings.maxRepairs;
        $('clinePlan').checked=data.settings.useClinePlan===true;
        $('clineAct').checked=data.settings.useClineAct===true;
    }
    initialized=true;
    const visible=s.phase!=='已验收'&&s.phase!=='空闲';
    const stages=data.stages||[];
    const stagePicker=$('stagePicker');stagePicker.replaceChildren();
    for(const stage of stages){
        const option=node('option',(stage.title||stage.request)+' · '+(stage.stageStep||stage.phase));
        option.value=stage.id;stagePicker.append(option);
    }
    stagePicker.value=s.id||'';
    $('stageControls').hidden=!(stages.length||data.pipelinePaused||data.queue.length);
    stagePicker.hidden=!stages.length;
    $('pipelineToggle').textContent=data.pipelinePaused?'继续工作流':'暂停工作流';
    $('pipelineToggle').disabled=data.pipelinePaused&&stages.some(stage=>stage.phase==='已请求暂停');
    const running=stages.flatMap(stage=>stage.tasks
        .filter(task=>!task.historicalReview&&['实现中','测试中','审查中','集成中','准备中','取消中','需处理','已取消','已集成'].includes(task.status))
        .map(task=>({stage,task})));
    const current=$('current');current.replaceChildren();
    if(!running.length)current.append(node('p',!data.repo?'打开本地 Git 文件夹':
        ['规划中','待确认方案','待澄清','已请求暂停','已暂停'].includes(s.phase)?s.phase:'当前没有执行中的子任务','label'));
    for(const {stage,task} of running){
        const row=node('div','','row');
        const status=task.status==='已集成'?(stage.phase==='待验收'?'待人工验收':
            task.historicalReview&&!stage.stageReview?'历史提交 · '+stage.phase:'已审查 · 待阶段验收'):task.status;
        row.append(node('p',task.title+' · '+status));
        const controls=taskControls(task,stage);
        if(controls.childElementCount)row.append(controls);
        current.append(row);
    }
    $('queueTab').textContent='队列'+(data.queue.length?' · '+data.queue.length:'');
    $('messages').replaceChildren();
    messages($('messages'),data.conversation);
    if(visible&&!data.settings.pipeline){
        const transcript=s.messages?.length?s.messages:(s.request?[{role:'user',text:s.request}]:[]);
        messages($('messages'),(s.submissionLogged?transcript.slice(1):transcript).filter(item=>item.role==='user'));
    }
    renderCodexQuestion(data.codexQuestion);
    $('decision').hidden=Boolean(data.codexQuestion);
    renderDecision(s);
    renderQueue();
    updateComposer();
    updateQuota();
    const decision = [data.folder, s.id, s.phase, s.question, s.inbox?.[0]?.id, s.message, data.codexQuestion?.id,
        data.conversation.length, data.conversation.at(-1)?.text].join('|');
    if(tab==='chat'&&decision!==lastDecision)$('main').scrollTop=$('main').scrollHeight;
    lastDecision=decision;
});
send('ready');
</script></body></html>`;
}

module.exports = { webview };
