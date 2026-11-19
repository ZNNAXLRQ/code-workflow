const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const prompts = require('./prompts');

const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' };
const active = new Set(['准备中', '实现中', '测试中', '审查中', '集成中']);
const uriSafe = /^[a-z0-9][a-z0-9-]{0,35}$/;
const maxCapture = 2 * 1024 * 1024;

function run(command, args, cwd, options = {}) {
    return new Promise((resolve, reject) => {
        if (options.signal?.aborted) return reject(options.signal.reason);
        const child = spawn(command, args, { cwd, env: { ...ENV, ...options.env }, windowsHide: true,
            stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '', timeout = false;
        const stop = () => {
            if (!child.pid || child.exitCode !== null) return;
            if (process.platform === 'win32') {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                killer.once('error', () => child.kill());
                killer.once('close', code => { if (code && child.exitCode === null) child.kill(); });
            } else child.kill();
        };
        const timer = setTimeout(() => { timeout = true; stop(); }, options.timeout ?? 120000);
        options.signal?.addEventListener('abort', stop, { once: true });
        const clean = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', stop); };
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            stdout = (stdout + chunk).slice(-maxCapture);
            options.log?.(chunk);
        });
        child.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-maxCapture);
            options.log?.(chunk);
        });
        if (options.input !== undefined) {
            child.stdin.on('error', () => {});
            child.stdin.end(options.input);
        }
        child.once('error', error => { clean(); reject(error); });
        child.once('close', code => {
            clean();
            if (options.signal?.aborted) return reject(options.signal.reason);
            resolve({ code: timeout ? 124 : code ?? 1, stdout, stderr });
        });
    });
}

async function git(cwd, ...args) {
    const result = await run('git', ['-c', 'core.quotepath=false', ...args], cwd);
    if (result.code) throw new Error(result.stderr.trim() || `Git 失败：${args[0]}`);
    return result.stdout.trimEnd();
}

function fileKey(value) {
    return process.platform === 'win32' ? value.toLowerCase() : value;
}

function overlaps(a, b) {
    return a.some(left => b.some(right => {
        left = fileKey(left); right = fileKey(right);
        return left === right || left.startsWith(right.endsWith('/') ? right : right + '/') ||
            right.startsWith(left.endsWith('/') ? left : left + '/');
    }));
}

function insideFileScope(filename, scopes) {
    const key = fileKey(filename);
    return scopes.some(scope => scope.endsWith('/') ? key.startsWith(fileKey(scope)) : key === fileKey(scope));
}

function repairsByFile(findings, scopes) {
    const files = new Map();
    for (const finding of findings.filter(item => item.blocking)) {
        const file = finding.path;
        if (typeof file !== 'string' || !file || /[\\:*?\x00-\x1f]/.test(file) ||
            file.split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase())) ||
            !insideFileScope(file, scopes)) throw new Error('审查要求修改计划范围之外的文件：' + file);
        const key = fileKey(file);
        if (!files.has(key)) files.set(key, { paths: [file], findings: [] });
        files.get(key).findings.push(finding);
    }
    return [...files.values()].map(({ paths, findings: group }) => ({ paths, feedback: JSON.stringify(group) }));
}

function testCommand(value) {
    if (value === undefined) return '';
    if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value) || value.length > 2000) {
        throw new Error('测试命令必须是一行可见文本。');
    }
    return value.trim();
}

function authorizedPlan(request) {
    const instruction = request.split(/\r?\n/, 1)[0];
    return !/(?:不要|先别|暂不|无需|待确认|确认后|如果|吗|[?？])/.test(instruction) &&
        /(?:按|照|根据|依照).{0,28}(?:计划|方案).{0,20}(?:执行|实施|实现|开工|开始(?:做|任务|开发)?)/.test(instruction);
}

function historicalReviewRequest(request) {
    return /^(?:请|帮我|先|麻烦\s*)*(?:审查|审阅|review).{0,60}(?:提交|代码|改动|commits?)/i.test(request);
}

function repositoryFactRequest(question) {
    return typeof question === 'string' &&
        /请|需要|能否|provide|share|paste/i.test(question) &&
        /git\s+(?:--no-pager\s+)?(?:status|diff|log|show|ls-files|rev-parse)\b|Get-Content\b|(?:package\.json|项目配置|仓库状态|文件列表|目录结构).{0,24}(?:输出|内容|贴出|提供)/i.test(question) &&
        /命令|输出|执行|运行|粘贴|贴出|文件内容|提供|查阅|run|output|paste/i.test(question);
}

function safeAutomaticTest(value) {
    return /^(?:(?:npm(?:\.cmd)?|pnpm(?:\.cmd)?|yarn(?:\.cmd)?)\s+(?:test|run\s+test[\w:-]*)|node\s+--test|(?:python(?:\.exe)?|py)\s+-m\s+(?:pytest|unittest)|dotnet\s+test|go\s+test|cargo\s+test)(?:\s+[\w./\\:@*-]+)*$/i.test(value);
}

function validatePlan(plan) {
    if (typeof plan.stage !== 'string' || !plan.stage.trim() || !Array.isArray(plan.tasks)) {
        throw new Error('规划输出缺少阶段或任务列表');
    }
    plan.testCommand = testCommand(plan.testCommand);
    const ids = new Set();
    for (const task of plan.tasks) {
        if (!uriSafe.test(task.id) || ids.has(task.id) || !task.title?.trim() || !task.requirements?.trim() ||
            !Array.isArray(task.criteria) || !task.criteria.length || task.criteria.some(item => typeof item !== 'string' || !item.trim()) ||
            !Array.isArray(task.paths) || !task.paths.length || !Array.isArray(task.dependsOn)) {
            throw new Error('子任务缺少唯一 ID、验收标准或写入范围');
        }
        task.testCommand = testCommand(task.testCommand);
        if (task.testCoverage !== undefined && (!Array.isArray(task.testCoverage) || !task.testCoverage.length ||
            task.testCoverage.some(check => typeof check !== 'string' || !check.trim()))) {
            throw new Error('子任务缺少具体的测试覆盖项。');
        }
        for (const item of task.paths) {
            if (typeof item !== 'string' || !item || /[\\:*?\x00-\x1f]/.test(item) ||
                item.replace(/\/$/, '').split('/').some(part => !part || ['.', '..', '.git'].includes(part.toLowerCase()))) {
                throw new Error(`无效写入范围：${item}`);
            }
        }
        ids.add(task.id);
    }
    const resolved = new Set();
    while (resolved.size < ids.size) {
        const count = resolved.size;
        for (const task of plan.tasks) {
            if (task.dependsOn.every(dependency => resolved.has(dependency))) resolved.add(task.id);
        }
        if (count === resolved.size) throw new Error('存在循环依赖或不存在的依赖 ID');
    }
    return plan;
}

function validateReview(review, sha, criteria) {
    if (review.candidate !== sha || !['pass', 'changes_requested', 'blocked'].includes(review.verdict) ||
        !Array.isArray(review.criteria) || review.criteria.length !== criteria.length || !Array.isArray(review.findings) ||
        criteria.some(item => review.criteria.filter(result => result.id === item.id &&
            ['met', 'unmet', 'unverified'].includes(result.status) && result.evidence?.trim()).length !== 1)) {
        throw new Error('审查输出与候选提交或验收项不一致');
    }
    if (review.verdict === 'pass' && (review.criteria.some(item => item.status !== 'met') || review.findings.length)) {
        throw new Error('审查通过结论与验收证据冲突');
    }
    if (review.verdict === 'changes_requested' && !review.findings.some(item => item.blocking)) {
        throw new Error('审查要求返修，但没有提供阻塞问题');
    }
    return review;
}

function criteriaFor(tasks) {
    return tasks.flatMap(task => task.criteria.map((description, index) => ({ id: `${task.id}/A${index + 1}`, description })));
}

class Workflow {
    constructor({ repo, store, records = store, legacyStore = store, config, changed, log, adapter, reviewJournal = null }) {
        Object.assign(this, { repo, store, records, legacyStore, config, changed, log, adapter, reviewJournal });
        this.jobs = new Map();
        this.controllers = new Map();
        this.lanes = new Map();
        this.writes = Promise.resolve();
        this.ticking = false;
        this.stages = new Map();
        this.implementationQueue = [];
        this.implementing = 0;
        this.reviewQueue = [];
    }

    get owner() { return this.pipelineOwner || this; }

    stageWorkers() {
        return [this, ...this.stages.values()];
    }

    stageWorker(id) {
        return this.stageWorkers().find(worker => worker.state.id === id);
    }

    createStage(state) {
        const worker = new Workflow(this);
        worker.pipelineOwner = this;
        worker.state = state;
        worker.queue = [];
        this.stages.set(state.id, worker);
        return worker;
    }

    async setPipelinePaused(paused, selected) {
        if (!paused && this.stageWorkers().some(worker => worker.state.phase === '已请求暂停')) {
            throw new Error('工作流仍在停止执行，请等待暂停完成。');
        }
        this.pipelinePaused = paused;
        await this.save();
        for (const worker of this.stageWorkers()) {
            const phase = worker.state.phase;
            if (paused && ['规划中', '运行中', '联合验收中'].includes(phase)) {
                worker.state.pipelineSuspended = true;
                await worker.action(phase === '规划中' ? 'interrupt' : 'pause');
            } else if (!paused && (worker === selected || worker.state.pipelineSuspended)) {
                delete worker.state.pipelineSuspended;
                if (phase === '已暂停') await worker.action('resume');
                if (phase === '规划已中断') await worker.action('retry');
            }
            if (!paused && !this.config().confirmPlan && worker.state.phase === '待确认方案') {
                await worker.action('approve');
            }
        }
        await this.save();
        this.pump();
    }

    recordStageMessage(text) {
        (this.state.messages ??= []).push({ role: 'user', text, mirrored: Boolean(this.config().pipeline) });
        if (this.config().pipeline) this.owner.conversation.push({ role: 'user', text, run: this.state.id });
    }

    async load() {
        await fs.mkdir(this.store, { recursive: true });
        this.stateFile = path.join(this.records, 'state.json');
        this.queue = [];
        this.archive = [];
        this.conversation = [];
        let migrated = false;
        try {
            this.state = JSON.parse(await fs.readFile(this.stateFile, 'utf8'));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            this.state = { phase: '空闲', tasks: [] };
            if (this.legacyStore !== this.records) {
                try {
                    this.state = JSON.parse(await fs.readFile(path.join(this.legacyStore, 'state.json'), 'utf8'));
                    migrated = true;
                } catch (legacyError) {
                    if (legacyError.code !== 'ENOENT') throw legacyError;
                }
            }
        }
        delete this.state.lastTest;
        const { queue = [], archive = [], conversation = [], codexThreadId = '', takeover,
            clineTakeover, clineAct, parallelStages = [], pipelinePaused, ...state } = this.state;
        Object.assign(this, { state, queue, archive, conversation, codexThreadId, takeover, clineTakeover, clineAct,
            pipelinePaused: pipelinePaused ?? (this.config().pipeline && ['已暂停', '已请求暂停'].includes(state.phase)) });
        if (pipelinePaused === undefined && this.pipelinePaused) {
            state.pipelineSuspended = true;
            migrated = true;
        }
        for (const stage of parallelStages) this.createStage(stage);
        for (const entry of this.queue) {
            if (entry.logged) continue;
            this.conversation.push({ role: 'user', text: entry.request, queuedId: entry.id });
            entry.logged = true;
            migrated = true;
        }
        for (const worker of this.stageWorkers()) {
            if (worker.state.phase === '已验收') worker.archiveCurrent();
            if (this.config().pipeline) {
                const record = worker.state;
                const legacy = (record.messages || []).filter((message, index) =>
                    message.role === 'user' && !message.mirrored && (index !== 0 || !record.submissionLogged));
                if (legacy.length) {
                    const index = this.conversation.findIndex(message => this.queue.some(entry => entry.id === message.queuedId));
                    this.conversation.splice(index < 0 ? this.conversation.length : index, 0,
                        ...legacy.map(message => ({ role: 'user', text: message.text, run: record.id })));
                    for (const message of legacy) message.mirrored = true;
                    migrated = true;
                }
            }
            if (worker !== this && worker.restoreExecution()) migrated = true;
        }
        for (const message of this.conversation) {
            if (!message.pending) continue;
            message.pending = false;
            message.text = '对话在窗口关闭时中断，可以重新发送。';
            migrated = true;
        }
        if (this.restoreExecution() || migrated) await this.save();
        return this;
    }

    restoreExecution() {
        if (this.state.phase === '规划中') {
            this.state.phase = '规划失败';
            this.state.message = '规划过程曾中断，可以重新规划。';
            return true;
        } else if (['运行中', '联合验收中', '已请求暂停'].includes(this.state.phase)) {
            this.state.phase = '已暂停';
            delete this.state.stageStep;
            this.state.message = '执行过程曾中断。请检查保留的任务和 worktree，再继续。';
            for (const task of this.state.tasks) {
                if (task.cancelRequested) {
                    delete task.cancelRequested;
                    task.status = '已取消';
                    task.reason = '可重试，已有改动已保留';
                } else if (active.has(task.status) || task.status === '排队执行') task.status = '排队中';
            }
            return true;
        }
        return false;
    }

    async retryRepositoryQuestions() {
        if (this.pipelinePaused) return;
        for (const worker of this.stageWorkers()) {
            const stage = worker.state;
            if (stage.phase !== '待澄清' || !stage.stageTree || stage.repositoryRetry ||
                !repositoryFactRequest(stage.question)) continue;
            stage.repositoryRetry = true;
            await worker.planStage(stage.question);
        }
    }

    async save() {
        if (this.pipelineOwner) return this.pipelineOwner.save();
        const snapshot = JSON.stringify({ ...this.state, queue: this.queue, archive: this.archive,
            conversation: this.conversation, codexThreadId: this.codexThreadId, clineTakeover: this.clineTakeover,
            takeover: this.takeover, clineAct: this.clineAct, pipelinePaused: this.pipelinePaused,
            parallelStages: [...this.stages.values()].map(worker => worker.state)
                .filter(stage => stage.phase !== '已验收') }, null, 2);
        const write = this.writes.catch(() => {}).then(async () => {
            if (this.records !== this.store) {
                await fs.mkdir(this.records, { recursive: true });
                await fs.writeFile(path.join(this.records, '.gitignore'), '*\n', { flag: 'wx' })
                    .catch(error => { if (error.code !== 'EEXIST') throw error; });
            }
            const temporary = this.stateFile + '.' + randomUUID() + '.tmp';
            await fs.writeFile(temporary, snapshot);
            await fs.rename(temporary, this.stateFile);
            this.changed(this.state);
        });
        this.writes = write;
        return write;
    }

    emit(task, content) {
        this.log(`[${task}] ${content.trimEnd()}`);
    }

    archiveCurrent() {
        const archive = this.owner.archive;
        if (!this.state.id || archive.some(item => item.id === this.state.id)) return;
        archive.unshift({ ...structuredClone(this.state), archivedAt: new Date().toISOString() });
    }

    async submit(request, test, authorize = authorizedPlan(request || ''), fromConversation = false) {
        if (!request?.trim()) throw new Error('请填写任务要求。');
        const override = testCommand(test);
        const entry = { id: randomUUID().slice(0, 12), request: request.trim(), test: override, authorize, logged: true };
        this.queue.push(entry);
        if (!fromConversation) this.conversation.push({ role: 'user', text: entry.request, queuedId: entry.id });
        await this.save();
        this.pump();
    }

    async cancelQueued(id) {
        const entry = this.queue.find(item => item.id === id);
        if (!entry || this.starting === id) {
            throw new Error('该任务已开始处理，无法从待处理队列取消。');
        }
        this.queue = this.queue.filter(item => item !== entry);
        const message = this.conversation.find(item => item.queuedId === id);
        if (message) message.cancelled = true;
        await this.save();
        this.pump();
    }

    canCancelStage() {
        return Boolean(this.state.id && !this.jobs.size && !this.phaseController && !this.approving &&
            ['已暂停', '规划已中断', '规划失败', '待澄清', '待确认方案', '需处理'].includes(this.state.phase));
    }

    async cancelStage() {
        if (!this.canCancelStage()) throw new Error('请先停止此阶段的执行，再取消整项任务。');
        this.state.phase = '已取消';
        this.state.message = '整项任务已取消，已有工作树和提交已保留。';
        delete this.state.pipelineSuspended;
        const original = this.owner.conversation.find(message => message.queuedId === this.state.id);
        if (original) original.cancelled = true;
        else this.owner.conversation.push({ role: 'assistant', text: '已取消任务：' + this.state.request });
        await this.save();
    }

    pump() {
        if (this.pipelineOwner) return this.owner.pump();
        if (this.pumping || !this.queue.length || this.pipelinePaused ||
            (!this.config().pipeline && !['空闲', '已验收', '已取消', '无可推进任务'].includes(this.state.phase))) return;
        this.pumping = true;
        const entry = this.queue[0];
        this.starting = entry.id;
        const worker = this.config().pipeline ? this.createStage({ id: entry.id, request: entry.request, test: entry.test, phase: '空闲', tasks: [] }) : this;
        worker.start(entry.request, entry.test, entry).catch(async error => {
            this.queue = this.queue.filter(item => item.id !== entry.id);
            worker.state.phase = '规划失败';
            worker.state.message = error.message;
            await this.save();
        }).catch(error => this.log(error.message)).finally(() => {
            this.pumping = false;
            this.starting = undefined;
            this.pump();
        });
    }

    async ask(request) {
        if (!request?.trim()) throw new Error('请填写消息');
        if (this.chatController) throw new Error('上一条对话消息仍在处理');
        const inCline = Boolean(this.config().useClinePlan);
        const takeover = inCline ? this.beginTakeover() : undefined;
        const previous = this.conversation.slice(-10);
        const reply = { role: 'assistant', text: '正在回答…', pending: true, takeover: takeover?.id };
        const userMessage = { role: 'user', text: request.trim(), takeover: takeover?.id };
        const controller = new AbortController();
        this.chatController = controller;
        this.conversation.push(userMessage, reply);
        try {
            await this.save();
            const result = await this.adapter.chat(this.repo, request.trim(), previous, this.store, {
                signal: controller.signal,
                takeover,
                onControls: steer => {
                    this.steerChat = steer ? async text => {
                        await steer(text);
                        userMessage.text += '\n用户补充：' + text;
                        await this.save();
                    } : undefined;
                    this.changed(this.state);
                }
            });
            reply.text = typeof result === 'string' ? result : result.text;
            if (result.propose) {
                reply.proposal = { id: randomUUID(), threadId: this.codexThreadId, authorize: authorizedPlan(userMessage.text),
                    request: userMessage.text + '\n\n讨论确认的候选范围\n' + result.text };
                try {
                    await this.adapter.ready();
                    if (!controller.signal.aborted) await this.dispatchProposal(reply.proposal.id);
                } catch (error) {
                    reply.dispatchError = error.message;
                }
            }
        } catch (error) {
            reply.failed = true;
            reply.retry = { id: randomUUID(), text: userMessage.text };
            reply.text = controller.signal.aborted ? '对话已中断。' : error.message;
        } finally {
            reply.pending = false;
            this.chatController = undefined;
            await this.save();
        }
    }

    beginTakeover() {
        if (this.takeover) return this.takeover;
        this.takeover = { id: randomUUID(), archiveIds: this.archive.map(record => record.id) };
        return this.takeover;
    }

    takeoverContext(id) {
        const stage = record => ({
            request: record.request, title: record.title, phase: record.phase, question: record.question,
            messages: record.messages, base: record.base, candidate: record.stageHead,
            test: record.stageTest, review: record.stageReview?.summary,
            tasks: record.tasks?.map(task => ({
                title: task.title, requirements: task.requirements, criteria: task.criteria, status: task.status,
                candidate: task.candidate, test: task.test, feedback: task.feedback
            }))
        });
        return {
            discussion: this.conversation.filter(message => message.takeover === id && !message.pending && !message.failed)
                .map(({ role, text }) => ({ role, text })),
            active: this.state.id ? stage(this.state) : undefined,
            parallel: [...this.stages.values()].map(worker => worker.state).filter(record => record.phase !== '已验收').map(stage),
            archived: this.archive.filter(record => !this.takeover?.archiveIds.includes(record.id)).map(stage),
            queued: this.queue.map(({ request, test }) => ({ request, test }))
        };
    }

    async dispatchProposal(id, test) {
        const message = this.conversation.find(entry => entry.proposal?.id === id && !entry.proposal.dispatched);
        if (!message || message.proposal.threadId !== this.codexThreadId) throw new Error('这条派发建议已处理或属于其他会话。');
        const override = testCommand(test);
        const proposal = message.proposal;
        proposal.dispatched = true;
        await this.submit(proposal.request, override, proposal.authorize === true, true);
    }

    async start(request, test, entry) {
        if (this.jobs.size || !['空闲', '已验收', '规划失败', '无可推进任务'].includes(this.state.phase)) {
            throw new Error('当前阶段仍在进行或等待验收');
        }
        if (!request.trim()) throw new Error('请填写任务要求。');
        test = testCommand(test);
        if (this.config().initialCommit) {
            const dirty = (await git(this.repo, 'status', '--porcelain')).trim();
            if (dirty) {
                await git(this.repo, 'add', '-A');
                await git(this.repo, 'commit', '-m', 'chore: 工作流初始提交');
            }
        }
        const targetBranch = (await git(this.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
        const targetHead = (await git(this.repo, 'rev-parse', 'HEAD')).trim();
        let base = await git(this.repo, 'rev-parse', 'HEAD');
        const rootBase = base;
        const reviewSnapshot = entry?.reviewSnapshot || this.state.reviewSnapshot;
        const accepted = this.owner.archive.find(record => (record.rootBase || record.base) === rootBase &&
            record.stageHead && (!record.reviewBase || record.base === rootBase));
        if (reviewSnapshot) {
            if (![reviewSnapshot.base, reviewSnapshot.candidate].every(ref => typeof ref === 'string' && /^[\da-f]{40,64}$/i.test(ref))) {
                throw new Error('审查快照缺少有效的提交。');
            }
            await git(this.repo, 'cat-file', '-e', reviewSnapshot.candidate + '^{commit}');
            await git(this.repo, 'merge-base', '--is-ancestor', reviewSnapshot.base, reviewSnapshot.candidate);
            base = reviewSnapshot.candidate;
        } else if (accepted) {
            base = accepted.stageHead;
            await git(this.repo, 'cat-file', '-e', base + '^{commit}');
        }
        const id = entry?.id || (this.pipelineOwner && this.state.id) || randomUUID().slice(0, 12);
        const messages = [{ role: 'user', text: request }];
        this.state = { id, phase: '规划中', request, test, authorize: entry?.authorize === true, submissionLogged: entry?.logged, reviewSnapshot,
            base, rootBase, stageHead: base, tasks: [], messages,
            targetBranch: targetBranch === 'HEAD' ? null : targetBranch, targetHead,
            inbox: [], directory: path.join(this.store, id) };
        if (entry) this.owner.queue = this.owner.queue.filter(item => item.id !== entry.id);
        await fs.mkdir(this.state.directory);
        await this.save();
        try {
            const location = path.join(this.state.directory, 'stage');
            await git(this.repo, 'worktree', 'add', '--detach', location, base);
            this.state.stageTree = location;
            await this.save();
            await this.planStage();
        } catch (error) {
            this.state.phase = '规划失败';
            this.state.message = error.message;
            await this.save();
            throw error;
        }
    }

    async startStageWithPlan(plan, request, test) {
        const validated = validatePlan(plan);
        const id = randomUUID().slice(0, 12);
        const worker = this.createStage({ id, request, test, phase: '空闲', tasks: [] });
        this.stages.set(id, worker);
        worker.externalPlan = validated;
        await worker.start(request, test, { id, request, test, logged: true });
        return worker;
    }

    async planStage(repositoryQuestion) {
        if (this.owner.pipelinePaused) {
            this.state.pipelineSuspended = true;
            this.state.phase = '规划已中断';
            return this.save();
        }
        if (this.pendingPlanInterrupt) {
            this.pendingPlanInterrupt = false;
            this.state.phase = '规划已中断';
            this.state.message = '规划已中断，可继续或修改要求。';
            return this.save();
        }
        const controller = this.phaseController = new AbortController();
        this.state.phase = '规划中';
        this.state.message = '';
        await this.save();
        try {
            const additions = (this.state.messages || []).slice(1).filter(item => item.role === 'user').map(item => item.text);
            const request = [this.state.request, ...additions.map(text => '用户补充：' + text)].join('\n\n');
            const takeover = this.config().useClinePlan ? this.owner.beginTakeover() : undefined;
            if (takeover) await this.save();
            const accepted = this.owner.archive.slice(0, 12).map(record => ({
                title: record.title, base: record.reviewBase || record.base, candidate: record.stageHead
            }));
            const plan = this.externalPlan || validatePlan(await this.lane('planning', () => {
                controller.signal.throwIfAborted();
                return this.adapter.plan(this.state.stageTree, request, this.state.directory, controller.signal,
                    takeover, this.state.test, accepted, repositoryQuestion);
            }));
            this.externalPlan = undefined;
            controller.signal.throwIfAborted();
            this.state.title = plan.stage;
            this.state.question = typeof plan.question === 'string' ? plan.question.trim() : '';
            if (repositoryFactRequest(this.state.question)) {
                throw new Error('规划器仍未能使用已读取的项目资料。可重新规划；无需手工执行这些命令。');
            }
            delete this.state.reviewBase;
            delete this.state.reviewCandidate;
            if (this.state.reviewSnapshot) {
                plan.reviewBase = this.state.reviewSnapshot.base;
                plan.reviewCandidate = this.state.reviewSnapshot.candidate;
            }
            if (!this.state.question && (plan.reviewBase || plan.reviewCandidate)) {
                try {
                    if (![plan.reviewBase, plan.reviewCandidate].every(ref => typeof ref === 'string' && /^[\da-f]{7,64}$/i.test(ref))) {
                        throw new Error('需要两个明确的提交 SHA');
                    }
                    const [base, candidate] = await Promise.all([plan.reviewBase, plan.reviewCandidate].map(ref =>
                        git(this.repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}')));
                    if (base === candidate) throw new Error('起点与终点相同');
                    await git(this.repo, 'merge-base', '--is-ancestor', base, candidate);
                    this.state.reviewBase = base;
                    this.state.reviewCandidate = candidate;
                } catch {
                    this.state.question = '无法核实这次历史审查的提交范围。请给出上次已审提交与此次候选提交。';
                }
            }
            if (!this.state.question && historicalReviewRequest(this.state.request) && !this.state.reviewBase) {
                this.state.question = '请给出这次只审查哪些已提交代码，例如上次已审提交和本次候选提交。';
            }
            this.state.stageTestCommand = this.state.test || plan.testCommand;
            this.state.tasks = plan.tasks.map(task => ({ ...task, status: '排队中', round: 0 }));
            if (plan.tasks.length && !this.state.stageTestCommand && !this.state.question) {
                this.state.question = '还缺一条覆盖本阶段改动的测试命令。可以说明项目现有的测试方式，或指定希望新增的测试程序，由我重新规划。';
            }
            if (this.state.question) this.state.phase = '待澄清';
            else if (!plan.tasks.length) {
                this.state.phase = '无可推进任务';
                this.state.message = plan.stage;
            } else if (this.config().confirmPlan && !(this.state.authorize &&
                (this.state.test || safeAutomaticTest(this.state.stageTestCommand)) &&
                this.state.tasks.every(task => !task.testCommand || safeAutomaticTest(task.testCommand)))) this.state.phase = '待确认方案';
            else await this.approve();
            await this.save();
        } catch (error) {
            this.state.phase = controller.signal.aborted ? '规划已中断' : '规划失败';
            this.state.message = controller.signal.aborted ? '规划已中断，可继续或修改要求。' : error.message;
            await this.save();
        } finally {
            if (this.phaseController === controller) this.phaseController = undefined;
        }
        if (this.replan) {
            this.replan = false;
            return this.planStage();
        }
    }

    async approve() {
        if (this.approving) return;
        if (this.owner.pipelinePaused) throw new Error('工作流已暂停，请先恢复再运行。');
        if (!this.state.stageTestCommand && !this.state.test) throw new Error('请先确定阶段测试命令。');
        this.approving = true;
        try {
            if (!this.state.stageBranch) {
                const branch = `workflow/${this.state.id}/stage`;
                await git(this.state.stageTree, 'switch', '-c', branch, ...(this.state.reviewCandidate ? [this.state.reviewCandidate] : []));
                this.state.stageBranch = branch;
            }
            if (this.state.reviewCandidate) {
                this.state.base = this.state.reviewCandidate;
                this.state.stageHead = this.state.reviewCandidate;
                for (const task of this.state.tasks) {
                    task.historicalReview = true;
                    task.status = '已集成';
                }
            }
            this.state.phase = '运行中';
            await this.save();
            this.schedule();
        } finally {
            this.approving = false;
        }
    }

    async mergeStage(target) {
        const head = this.state.stageHead;
        const message = `merge: 工作流阶段 ${this.state.id} 验收`;
        const tip = (await git(this.repo, 'rev-parse', target)).trim();
        if (this.state.targetHead && tip !== this.state.targetHead) {
            throw new Error('目标分支在规划后已更新（' + this.state.targetHead.slice(0, 8) +
                ' → ' + tip.slice(0, 8) + '），不能在未重新测试合并结果的情况下验收。请重新规划/测试。');
        }
        const current = (await git(this.repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
        if (current === target) {
            if ((await git(this.repo, 'status', '--porcelain')).trim()) {
                throw new Error('目标分支有未提交改动，无法合并；请先提交或清理工作区。');
            }
            try {
                await git(this.repo, 'merge', '--no-ff', head, '-m', message);
            } catch (error) {
                await git(this.repo, 'merge', '--abort').catch(() => {});
                throw error;
            }
            return;
        }
        const temporary = path.join(this.state.directory, 'accept');
        try {
            await git(this.repo, 'worktree', 'add', temporary, target);
        } catch (error) {
            throw new Error('无法在目标分支「' + target + '」上合并：' + error.message);
        }
        try {
            if ((await git(temporary, 'status', '--porcelain')).trim()) {
                throw new Error('目标分支工作树不干净，无法合并。');
            }
            try {
                await git(temporary, 'merge', '--no-ff', head, '-m', message);
            } catch (error) {
                await git(temporary, 'merge', '--abort').catch(() => {});
                throw error;
            }
        } finally {
            await git(this.repo, 'worktree', 'remove', '--force', temporary).catch(() => {});
        }
    }

    async cleanupStage() {
        const preserved = [];
        for (const task of this.state.tasks || []) {
            if (!task.tree) continue;
            try {
                await git(this.repo, 'worktree', 'remove', task.tree);
            } catch (error) {
                preserved.push({ path: task.tree, reason: error.message });
            }
        }
        if (this.state.stageTree) {
            try {
                await git(this.repo, 'worktree', 'remove', this.state.stageTree);
            } catch (error) {
                preserved.push({ path: this.state.stageTree, reason: error.message });
            }
        }
        if (this.state.stageBranch) {
            try {
                await git(this.repo, 'branch', '-D', this.state.stageBranch);
            } catch (error) {
                if (!preserved.some(item => item.path === this.state.stageTree)) {
                    preserved.push({ path: this.state.stageTree || this.state.stageBranch, reason: error.message });
                }
            }
        }
        this.state.preservedWorktrees = preserved;
        if (this.owner) this.owner.preservedWorktrees = [...(this.owner.preservedWorktrees || []), ...preserved];
    }

    async acceptStage() {
        if (this.state.phase !== '待验收') throw new Error('当前状态不支持验收');
        if (await git(this.state.stageTree, 'rev-parse', 'HEAD') !== this.state.stageHead) {
            throw new Error('待验收版本已变化');
        }
        if (!this.state.targetBranch) {
            throw new Error('提交方案时没有锁定目标分支（当时处于 detached HEAD），无法验收合并。');
        }
        const tip = (await git(this.repo, 'rev-parse', this.state.targetBranch)).trim();
        if (this.state.targetHead && tip !== this.state.targetHead) {
            await this.revalidateStage();
            if (this.state.phase !== '待验收') {
                throw new Error('目标分支已更新，重新联合审查未通过，不能验收。');
            }
        }
        await this.mergeStage(this.state.targetBranch);
        this.state.phase = '已验收';
        this.state.acceptedAt = new Date().toISOString();
        this.archiveCurrent();
        if (this.pipelineOwner) this.owner.stages.delete(this.state.id);
        await this.save();
        await this.cleanupStage();
        const archived = this.owner?.archive?.find(record => record.id === this.state.id);
        if (archived) archived.preservedWorktrees = this.state.preservedWorktrees || [];
        await this.save();
    }

    async revalidateStage() {
        const target = this.state.targetBranch;
        if (!target) throw new Error('没有锁定目标分支，无法更新基线。');
        const tip = (await git(this.repo, 'rev-parse', target)).trim();
        if (this.state.targetHead === tip) return false;
        if (!this.state.stageTree) throw new Error('阶段工作树已不存在，无法更新目标基线。');
        if ((await git(this.state.stageTree, 'status', '--porcelain')).trim()) {
            throw new Error('阶段工作树有未提交改动，不能自动更新目标基线。');
        }
        try {
            await git(this.state.stageTree, 'merge', '--no-ff', tip, '-m', 'merge: 更新目标分支基线');
        } catch (error) {
            await git(this.state.stageTree, 'merge', '--abort').catch(() => {});
            throw new Error('目标分支无法自动合入阶段：' + error.message);
        }
        this.state.stageHead = (await git(this.state.stageTree, 'rev-parse', 'HEAD')).trim();
        this.state.targetHead = tip;
        delete this.state.stageReview;
        await this.save();
        await this.finishStage();
        return true;
    }

    async planSingleFollowup(feedback, fromUser = false) {
        if (fromUser) this.recordStageMessage(feedback);
        const task = {
            id: `acceptance-${this.state.tasks.length + 1}`, title: fromUser ? '按人工验收反馈修订' : '按审查结果返修',
            requirements: feedback, criteria: [feedback], paths: [...new Set(this.state.tasks.flatMap(item => item.paths))],
            dependsOn: this.state.tasks.map(item => item.id), status: '排队中', round: 0
        };
        this.state.tasks.push(task);
        this.state.phase = '运行中';
        this.state.message = '';
        await this.save();
        this.schedule();
    }

    async action(command, feedback, taskId) {
        if (command === 'cancelStage') return this.cancelStage();
        const phase = this.state.phase;
        const message = feedback?.trim();
        if (command === 'cancelTask' || command === 'retryTask') {
            if (!['运行中', '需处理', '已暂停'].includes(phase)) throw new Error('当前阶段暂时不能操作子任务。');
            const task = this.state.tasks.find(item => item.id === taskId);
            if (!task) throw new Error('找不到该子任务。');
            if (command === 'cancelTask') {
                const controller = this.controllers.get(taskId);
                if (task.cancelRequested || !['排队中', '排队执行', '准备中', '实现中', '测试中', '审查中'].includes(task.status)) {
                    throw new Error('当前任务暂时不能取消。');
                }
                if (controller) {
                    task.cancelRequested = true;
                    task.status = '取消中';
                    task.reason = '正在停止任务';
                    controller.abort();
                } else {
                    task.status = '已取消';
                    task.reason = '可重试，已有改动已保留';
                }
            } else {
                if (this.jobs.has(taskId) || !['已取消', '需处理'].includes(task.status)) {
                    throw new Error('请等这个任务停止后再重试。');
                }
                this.state.inbox = (this.state.inbox || []).filter(entry => entry.id !== taskId);
                task.status = '排队中';
                task.reason = '';
                task.round = 0;
                if (phase === '需处理') {
                    this.state.phase = '运行中';
                    this.state.message = '';
                }
            }
            await this.save();
            this.schedule();
            return;
        }
        if (command === 'approve' && phase === '待确认方案') return this.approve();
        if (['answerPlan', 'revise', 'retry'].includes(command) &&
            ['待澄清', '待确认方案', '规划失败', '规划已中断'].includes(phase) && this.state.stageTree) {
            if (phase === '待澄清' && !message) throw new Error('请先填写澄清问题的答复');
            if (message) {
                const transcript = this.state.messages ??= [];
                if (phase === '待澄清') transcript.push({ role: 'assistant', text: this.state.question });
                else if (phase === '待确认方案') transcript.push({ role: 'assistant', text: this.state.title });
                this.recordStageMessage(message);
            }
            return this.planStage();
        }
        if (command === 'interrupt' && phase === '规划中') {
            this.replan = false;
            if (this.phaseController) this.phaseController.abort();
            else this.pendingPlanInterrupt = true;
            return;
        }
        if (command === 'steer' && phase === '规划中') {
            if (!message) throw new Error('请先填写新的要求');
            this.recordStageMessage(message);
            if (this.phaseController) {
                this.replan = true;
                this.phaseController.abort();
                return this.save();
            }
            return this.save();
        }
        if (['interrupt', 'pause', 'steer'].includes(command) && ['运行中', '联合验收中'].includes(phase)) {
            if (command === 'steer' && !message) throw new Error('请先填写新的要求');
            if (command === 'steer') {
                this.recordStageMessage(message);
                this.state.steer = message;
                for (const task of this.state.tasks.filter(item => item.status !== '已集成')) {
                    task.feedback = [task.feedback, message].filter(Boolean).join('\n');
                    delete task.fileRepairs;
                }
            }
            if (message && !(this.state.reviewBase && !this.state.stageReview) &&
                (phase === '联合验收中' || this.state.tasks.every(task => task.status === '已集成'))) {
                this.state.stageSteer = message;
            }
            this.state.phase = '已请求暂停';
            this.state.message = '正在停止执行中的实现、测试和审查，已有改动会保留。';
            this.state.autoContinue = command === 'steer';
            for (const controller of this.controllers.values()) controller.abort();
            this.phaseController?.abort();
        } else if (command === 'answerTask' && ['运行中', '需处理'].includes(phase) && this.state.inbox?.[0]?.id === taskId) {
            if (!message) throw new Error('请先填写答复');
            const task = this.state.tasks.find(item => item.id === taskId);
            (this.state.messages ??= []).push({ role: 'assistant', text: this.state.inbox[0].text });
            this.recordStageMessage(message);
            task.feedback = [task.feedback, message].filter(Boolean).join('\n');
            for (const repair of task.fileRepairs || []) repair.feedback += '\n用户补充：' + message;
            task.status = '排队中';
            task.round = 0;
            this.state.inbox.shift();
            this.state.phase = '运行中';
        } else if (command === 'rollback' && ['已暂停', '需处理'].includes(phase) && !this.jobs.size) {
            return this.rollback(taskId);
        } else if (command === 'resume' && ['已暂停', '需处理'].includes(phase)) {
            if (feedback?.trim()) this.recordStageMessage(feedback.trim());
            if (message && this.state.tasks.length && this.state.tasks.every(task => task.status === '已集成')) {
                return this.planSingleFollowup(message);
            }
            this.state.phase = '运行中';
            this.state.message = '';
            this.state.inbox = (this.state.inbox || []).filter(entry =>
                !this.state.tasks.some(task => task.id === entry.id && task.pendingReview));
            for (const task of this.state.tasks) {
                if (task.status !== '需处理' || this.state.inbox?.some(item => item.id === task.id)) continue;
                task.status = '排队中';
                task.round = 0;
                if (feedback?.trim()) {
                    task.feedback = [task.feedback, feedback].filter(Boolean).join('\n');
                    delete task.fileRepairs;
                }
            }
        } else if (command === 'accept' && phase === '待验收') {
            await this.acceptStage();
        } else if (command === 'reject' && phase === '待验收') {
            if (!feedback?.trim()) throw new Error('请先填写退回意见');
            return await this.planSingleFollowup(feedback.trim(), true);
        } else if (command === 'retry' && phase === '规划失败') {
            const failed = this.state;
            const next = this.queue[0];
            if (next?.request === failed.request && next.test === failed.test) {
                this.state.phase = '空闲';
                await this.save();
                this.pump();
                return;
            }
            return await this.start(failed.request, failed.test);
        } else {
            throw new Error('当前状态不支持这个操作');
        }
        await this.save();
        this.schedule();
        this.pump();
    }

    async rollback(id) {
        const task = this.state.tasks.find(item => item.id === id && item.tree && item.status !== '已集成');
        if (!task || this.jobs.size) throw new Error('请暂停后选择有工作树的未集成任务');
        const target = task.checkpoint || task.base;
        const backup = `workflow/${this.state.id}/backup/${task.id}-${randomUUID().slice(0, 8)}`;
        const hooks = 'core.hooksPath=' + path.join(this.store, 'no-git-hooks');
        if (await git(task.tree, 'status', '--porcelain')) {
            await git(task.tree, 'add', '-A');
            await git(task.tree, '-c', hooks, 'commit', '--no-gpg-sign', '-m', 'workflow: preserve rollback snapshot');
        }
        await git(task.tree, 'branch', backup);
        await git(task.tree, 'reset', '--hard', target);
        task.backup = backup;
        task.candidate = target;
        delete task.pendingReview;
        task.review = undefined;
        task.test = undefined;
        task.status = '排队中';
        task.reason = '';
        this.state.inbox = (this.state.inbox || []).filter(item => item.id !== task.id);
        this.state.phase = '已暂停';
        this.state.message = '已回退到本轮开始前。恢复分支 ' + backup;
        await this.save();
    }

    schedule() {
        if (this.ticking) {
            this.tickAgain = true;
            return;
        }
        this.ticking = true;
        setImmediate(async () => {
            try { await this.tick(); } catch (error) {
                this.state.phase = '需处理';
                this.state.message = error.message;
                await this.save().catch(() => {});
            } finally {
                this.ticking = false;
                if (this.tickAgain) {
                    this.tickAgain = false;
                    this.schedule();
                }
            }
        });
    }

    async tick() {
        if (this.state.phase === '已请求暂停' && this.jobs.size === 0) {
            if (this.phaseController) return;
            this.state.phase = this.state.autoContinue ? '运行中' : '已暂停';
            this.state.message = this.state.autoContinue ? '' : '所有执行已暂停，工作树已保留。';
            this.state.autoContinue = false;
            if (this.state.stageSteer) {
                const feedback = this.state.stageSteer;
                this.state.stageSteer = undefined;
                return this.planSingleFollowup(feedback);
            }
            await this.save();
        }
        if (this.state.phase !== '运行中' || this.owner.pipelinePaused) return;
        let dirty = false;
        for (const task of this.state.tasks.filter(task => task.status === '排队中')) {
            let reason = '';
            const unmet = task.dependsOn.filter(id => this.state.tasks.find(item => item.id === id).status !== '已集成');
            const conflict = this.owner.stageWorkers().flatMap(worker =>
                worker.state.tasks.filter(item => worker.jobs.has(item.id) && overlaps(task.paths, item.paths)))[0];
            if (unmet.length) reason = '等待依赖 ' + unmet.join('、');
            else if (conflict) reason = '写入范围与「' + conflict.title + '」冲突';
            if (reason) {
                if (task.reason !== reason) { task.reason = reason; dirty = true; }
                continue;
            }
            task.status = '准备中';
            task.reason = '';
            const controller = new AbortController();
            this.controllers.set(task.id, controller);
            this.jobs.set(task.id, this.execute(task, controller.signal).catch(async error => {
                if (task.cancelRequested) {
                    delete task.cancelRequested;
                    task.status = '已取消';
                    task.reason = '可重试，已有改动已保留';
                } else {
                    task.status = controller.signal.aborted ? '排队中' : '需处理';
                    task.reason = controller.signal.aborted ? '已中断，工作树已保留' : error.message;
                }
                if (!controller.signal.aborted && !task.pendingReview) {
                    const inbox = this.state.inbox ??= [];
                    if (!inbox.some(item => item.id === task.id)) inbox.push({ id: task.id, title: task.title, text: error.question || error.message });
                }
                if (!controller.signal.aborted && task.pendingReview) this.state.message = task.reason;
                await this.save();
            }).finally(() => {
                this.controllers.delete(task.id);
                this.jobs.delete(task.id);
                for (const worker of this.owner.stageWorkers()) worker.schedule();
            }));
            dirty = true;
        }
        if (dirty) await this.save();
        if (this.jobs.size) return;
        if (this.state.tasks.every(task => task.status === '已集成')) await this.finishStage();
        else {
            const pendingReview = this.state.tasks.find(task => task.status === '需处理' && task.pendingReview);
            const waitingForOtherStage = this.state.tasks.some(task => task.status === '排队中' &&
                task.reason?.startsWith('写入范围与'));
            if (waitingForOtherStage && !pendingReview) return;
            this.state.phase = '需处理';
            this.state.message = pendingReview?.reason || '有子任务需要处理。依赖它们的任务继续排队。';
            await this.save();
        }
    }

    async lane(name, operation) {
        const lanes = this.owner.lanes;
        const previous = lanes.get(name) ?? Promise.resolve();
        const next = previous.catch(() => {}).then(operation);
        lanes.set(name, next);
        try { return await next; } finally { if (lanes.get(name) === next) lanes.delete(name); }
    }

    implementationSlot(signal, operation) {
        return new Promise((resolve, reject) => {
            const ticket = { signal, operation, resolve, reject };
            ticket.cancel = () => {
                const queue = this.owner.implementationQueue;
                const index = queue.indexOf(ticket);
                if (index < 0) return;
                queue.splice(index, 1);
                reject(signal.reason);
            };
            this.owner.implementationQueue.push(ticket);
            signal.addEventListener('abort', ticket.cancel, { once: true });
            if (signal.aborted) ticket.cancel();
            this.owner.drainImplementation();
        });
    }

    drainImplementation() {
        const cap = this.config().maxParallel;
        const limit = cap === 'unlimited' ? Infinity : Math.max(1, Number(cap) || 1);
        while (this.implementing < limit && this.implementationQueue.length) {
            const ticket = this.implementationQueue.shift();
            ticket.signal.removeEventListener('abort', ticket.cancel);
            this.implementing++;
            Promise.resolve().then(() => {
                ticket.signal.throwIfAborted();
                return ticket.operation();
            }).then(ticket.resolve, ticket.reject).finally(() => {
                this.implementing--;
                this.drainImplementation();
            });
        }
    }

    reviewSlot(where, data, directory, label, signal, onStart) {
        if (!this.adapter.reviewBatch) return this.lane('review', async () => {
            signal.throwIfAborted();
            await onStart();
            return this.adapter.review(where, data, directory, label, signal);
        });
        return new Promise((resolve, reject) => {
            const cancel = () => reject(signal.reason);
            if (signal.aborted) return cancel();
            signal.addEventListener('abort', cancel, { once: true });
            this.owner.reviewQueue.push({ id: randomUUID(), where, data, label, stageId: this.state.id, signal, onStart,
                resolve: result => { signal.removeEventListener('abort', cancel); resolve(result); },
                reject: error => { signal.removeEventListener('abort', cancel); reject(error); } });
            this.owner.scheduleReview();
        });
    }

    scheduleReview() {
        if (this.reviewTimer || this.reviewing || !this.reviewQueue.length) return;
        this.reviewTimer = setTimeout(() => {
            this.reviewTimer = undefined;
            this.flushReview().catch(error => this.log(error.message));
        }, 250);
    }

    async flushReview() {
        const entries = this.reviewQueue.splice(0).filter(entry => {
            if (!entry.signal.aborted) return true;
            entry.reject(entry.signal.reason);
            return false;
        });
        if (!entries.length) return;
        this.reviewing = true;
        const controller = new AbortController();
        const check = () => { if (entries.every(entry => entry.signal.aborted)) controller.abort(); };
        for (const entry of entries) entry.signal.addEventListener('abort', check);
        try {
            await Promise.all(entries.filter(entry => !entry.signal.aborted).map(entry => entry.onStart()));
            check();
            controller.signal.throwIfAborted();
            const results = await this.adapter.reviewBatch(entries, controller.signal);
            for (const entry of entries) {
                const result = results.get(entry.id);
                if (entry.signal.aborted) entry.reject(entry.signal.reason);
                else if (!result || result.error) entry.reject(result?.error || new Error('这一候选提交缺少审查结果。'));
                else entry.resolve(result.review);
            }
        } catch (error) {
            for (const entry of entries) entry.reject(error);
        } finally {
            for (const entry of entries) entry.signal.removeEventListener('abort', check);
            this.reviewing = false;
            this.scheduleReview();
        }
    }
    async status(task, status, reason = '') {
        task.status = status;
        task.reason = reason;
        await this.save();
    }

    async test(where, id, services, signal, override) {
        const command = override || this.state.stageTestCommand || this.state.test;
        if (!command) throw new Error('缺少已确认的测试命令。');
        const result = await services.test(where, command, chunk => this.emit(id, chunk), signal);
        if (result.code === 0) return { passed: true, command, detail: result.stdout.slice(-4000) };
        return { passed: false, command, detail: `退出码 ${result.code}\n${(result.stderr + '\n' + result.stdout).slice(-6000)}` };
    }

    async prepareCandidate(task, services, signal) {
        await this.status(task, '排队执行', '等待实现槽');
        task.checkpoint = await git(task.tree, 'rev-parse', 'HEAD');
        const repairs = task.fileRepairs || [{ paths: task.paths, feedback: task.feedback }];
        const implemented = await Promise.allSettled(repairs.map(repair => this.implementationSlot(signal, async () => {
            await this.status(task, '实现中');
            const scoped = { ...task, paths: repair.paths, fileRepairs: undefined };
            await services.implement(task.tree, prompts.implementPrompt(this.state.title, scoped, repair.feedback),
                chunk => this.emit(task.id, chunk), scoped, signal);
        })));
        const failed = implemented.find(result => result.status === 'rejected');
        if (failed) throw failed.reason;
        delete task.fileRepairs;
        signal.throwIfAborted();
        const files = new Set();
        for (const args of [['diff', '--name-only', '-z', '--no-renames', task.base], ['ls-files', '-z', '--others', '--exclude-standard']]) {
            for (const filename of (await git(task.tree, ...args)).split('\0').filter(Boolean)) files.add(filename);
        }
        const outside = [...files].filter(filename => !insideFileScope(filename, task.paths));
        if (outside.length) {
            task.paths.push(...outside);
            this.emit(task.id, '实现发现额外文件，已纳入冲突检查：' + outside.join('、'));
            await this.save();
        }
        if (await git(task.tree, 'status', '--porcelain', '--untracked-files=all')) {
            await git(task.tree, 'add', '-A', '--', '.');
            await git(task.tree, '-c', 'core.hooksPath=' + path.join(this.store, 'no-git-hooks'), 'commit',
                '--no-gpg-sign', '-m', `workflow: ${task.id} (round ${task.round + 1})`);
        }
        const sha = await git(task.tree, 'rev-parse', 'HEAD');
        await git(task.tree, 'merge-base', '--is-ancestor', task.base, sha);
        await this.status(task, '排队执行', '等待测试槽');
        const test = await this.lane('test', async () => {
            signal.throwIfAborted();
            await this.status(task, '测试中');
            return this.test(task.tree, task.id, services, signal, task.testCommand);
        });
        signal.throwIfAborted();
        if (await git(task.tree, 'status', '--porcelain', '--untracked-files=all') ||
            sha !== await git(task.tree, 'rev-parse', 'HEAD')) {
            throw new Error('测试执行后候选提交或工作树发生变化，无法确认测试结果对应的版本。');
        }
        task.test = test;
        if (!test.passed) {
            await this.repair(task, '子任务测试失败：\n' + test.detail);
            return false;
        }
        task.candidate = sha;
        task.pendingReview = { candidate: sha, feedback: task.feedback || '' };
        return true;
    }

    async execute(task, signal) {
        const services = this.adapter;
        if (!task.tree) {
            const target = path.join(this.state.directory, task.previousTree ? task.id + '-' + randomUUID().slice(0, 8) : task.id);
            const base = await git(this.state.stageTree, 'rev-parse', 'HEAD');
            await git(this.repo, 'worktree', 'add', '--detach', target, base);
            task.tree = target;
            task.base = base;
            await this.save();
        }
        const criteria = criteriaFor([task]);
        for (;;) {
            signal.throwIfAborted();
            const pending = task.pendingReview;
            const reuse = pending && task.test?.passed && pending.feedback === (task.feedback || '') &&
                pending.candidate === task.candidate &&
                pending.candidate === await git(task.tree, 'rev-parse', 'HEAD') &&
                !await git(task.tree, 'status', '--porcelain', '--untracked-files=all');
            if (!reuse) {
                delete task.pendingReview;
                if (!await this.prepareCandidate(task, services, signal)) continue;
            }
            const sha = task.candidate;
            const test = task.test;
            await this.status(task, '排队执行', '等待 Codex 审查槽');
            const recovered = this.reviewJournal?.take({ stageId: this.state.id, taskId: task.id, candidate: sha });
            const review = validateReview(recovered || await this.reviewSlot(task.tree, {
                    title: task.title, requirements: task.requirements, clarification: task.feedback,
                    base: task.base, candidate: sha, criteria, test, testCoverage: task.testCoverage, previous: task.review
                }, this.state.directory, task.id, signal, () => this.status(task, '审查中')), sha, criteria);
            signal.throwIfAborted();
            delete task.pendingReview;
            task.review = review;
            await this.save();
            try { this.reviewJournal?.commit({ stageId: this.state.id, taskId: task.id, candidate: sha }); }
            catch (error) { this.log('[review-journal] ' + error.message); }
            if (review.verdict === 'blocked') throw new Error(review.summary || '审查缺少证据');
            if (review.verdict === 'changes_requested') {
                task.fileRepairs = repairsByFile(review.findings, task.paths);
                await this.repair(task, JSON.stringify(review.findings.filter(item => item.blocking)));
                continue;
            }
            return this.lane('integration', () => {
                signal.throwIfAborted();
                return this.integrate(task);
            });
        }
    }

    async repair(task, feedback) {
        if (task.feedback === feedback) throw new Error('同一问题重复，已暂停自动返修');
        task.feedback = feedback;
        if (task.round >= this.config().maxRepairs) throw new Error('达到自动返修上限');
        task.round++;
        await this.save();
    }

    async integrate(task) {
        const tree = this.state.stageTree;
        await this.status(task, '集成中');
        if (await git(tree, 'status', '--porcelain')) throw new Error('阶段 worktree 有未提交改动');
        const current = await git(tree, 'rev-parse', 'HEAD');
        const commits = (await git(task.tree, 'rev-list', '--reverse', `${task.base}..${task.candidate}`)).split('\n').filter(Boolean);
        if (commits.length) {
            try {
                await git(tree, '-c', 'core.hooksPath=' + path.join(this.store, 'no-git-hooks'), 'cherry-pick', ...commits);
            } catch (error) {
                await git(tree, 'cherry-pick', '--abort');
                if (await git(tree, 'rev-parse', 'HEAD') !== current) throw new Error('集成回退不完整，请检查阶段 worktree');
                task.previousTree = task.tree;
                task.tree = undefined;
                task.feedback = '与阶段新基线集成冲突。参考以前的实现，基于新基线重新改动。旧 worktree：' + task.previousTree;
                task.status = '排队中';
                task.round++;
                await this.save();
                if (task.round > this.config().maxRepairs) throw new Error('集成冲突超过返修上限');
                return;
            }
        }
        this.state.stageHead = await git(tree, 'rev-parse', 'HEAD');
        await this.status(task, '已集成');
    }

    async finishStage() {
        const controller = this.phaseController = new AbortController();
        let reviewedCandidate = null;
        this.state.phase = '联合验收中';
        this.state.stageStep = '测试排队';
        await this.save();
        try {
            const where = this.state.stageTree;
            const test = await this.lane('test', async () => {
                controller.signal.throwIfAborted();
                this.state.stageStep = '测试中';
                await this.save();
                return this.test(where, '阶段', this.adapter, controller.signal);
            });
            controller.signal.throwIfAborted();
            this.state.stageTest = test;
            const sha = await git(where, 'rev-parse', 'HEAD');
            reviewedCandidate = sha;
            if (await git(where, 'status', '--porcelain') || sha !== this.state.stageHead) throw new Error('阶段工作树或候选提交已变化');
            if (!test.passed && (!this.state.reviewBase || this.state.stageRepairs)) {
                await this.stageRepair('阶段测试失败：' + test.detail);
                return;
            }
            const criteria = criteriaFor(this.state.tasks);
            this.state.stageStep = '审查排队';
            await this.save();
            const recovered = this.reviewJournal?.take({ stageId: this.state.id, taskId: 'stage', candidate: sha });
            const review = validateReview(recovered || await this.reviewSlot(where, {
                title: this.state.title, requirements: this.state.request, clarification: this.state.messages?.slice(1),
                base: this.state.reviewBase || this.state.base, candidate: sha, criteria, test,
                plannedTasks: this.state.tasks.map(task => ({ title: task.title, requirements: task.requirements,
                    testCoverage: task.testCoverage, candidate: task.candidate, test: task.test, review: task.review?.summary }))
                }, this.state.directory, 'stage', controller.signal, async () => {
                    this.state.stageStep = '审查中';
                    await this.save();
                }), sha, criteria);
            controller.signal.throwIfAborted();
            this.state.stageReview = review;
            if (!test.passed && review.verdict === 'pass') {
                throw new Error('历史提交测试未通过，不能通过审查。\n' + test.detail);
            }
            if (review.verdict === 'changes_requested') {
                const scoped = repairsByFile(review.findings, this.state.tasks.flatMap(task => task.paths));
                await this.stageRepair(JSON.stringify(review.findings.filter(item => item.blocking)), scoped);
                try { this.reviewJournal?.commit({ stageId: this.state.id, taskId: 'stage', candidate: reviewedCandidate }); }
                catch (error) { this.log('[review-journal] ' + error.message); }
                return;
            }
            this.state.phase = review.verdict === 'pass' ? '待验收' : '需处理';
            this.state.message = review.summary;
        } catch (error) {
            if (!controller.signal.aborted) {
                this.state.phase = '需处理';
                this.state.message = error.message;
            }
        } finally {
            delete this.state.stageStep;
            if (this.phaseController === controller) this.phaseController = undefined;
            this.schedule();
        }
        await this.save();
        try { this.reviewJournal?.commit({ stageId: this.state.id, taskId: 'stage', candidate: reviewedCandidate }); }
        catch (error) { this.log('[review-journal] ' + error.message); }
    }

    async stageRepair(feedback, scoped) {
        const count = this.state.stageRepairs ?? 0;
        if (count >= this.config().maxRepairs || this.state.stageFeedback === feedback) {
            throw new Error('阶段返修已达上限或重复：' + feedback);
        }
        this.state.stageRepairs = count + 1;
        this.state.stageFeedback = feedback;
        if (!scoped?.length) return this.planSingleFollowup(feedback);
        const dependsOn = this.state.tasks.map(task => task.id);
        const start = dependsOn.length;
        this.state.tasks.push(...scoped.map((repair, index) => ({
            id: `acceptance-${start + index + 1}`, title: '返修 · ' + repair.paths[0],
            requirements: repair.feedback, criteria: [repair.feedback], paths: repair.paths,
            dependsOn, status: '排队中', round: 0
        })));
        this.state.phase = '运行中';
        this.state.message = '';
        await this.save();
    }

    async diff(id, record = this.state) {
        const task = record.tasks.find(item => item.id === id);
        return git(this.repo, 'diff', '--no-ext-diff', '--no-textconv', task?.base || record.reviewBase || record.base, task?.candidate || record.stageHead);
    }
}

module.exports = { Workflow, run, git, overlaps, validatePlan, validateReview, repositoryFactRequest, historicalReviewRequest };
