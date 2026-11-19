const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Workflow, git } = require('../workflow');

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'external-plan-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'External Plan');
    await git(repo, 'config', 'user.email', 'plan@example.invalid');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'base');

    let planned = false;
    const adapter = {
        plan: async () => { planned = true; throw new Error('external plan must bypass adapter.plan'); },
        implement: async (cwd, prompt, report, task) => {
            await fs.writeFile(path.join(cwd, 'a.txt'), 'implemented by ' + task.id);
        },
        test: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        review: async (where, data) => ({
            candidate: data.candidate, verdict: 'pass',
            criteria: data.criteria.map(check => ({ id: check.id, status: 'met', evidence: 'fixture' })),
            findings: [], summary: 'ok'
        })
    };
    const plan = {
        stage: '外部方案阶段',
        question: '',
        testCommand: 'node --test',
        tasks: [{
            id: 'one', title: '写 a.txt', requirements: '写文件', criteria: ['文件存在'],
            paths: ['a.txt'], dependsOn: [], testCommand: ''
        }]
    };
    const workflow = new Workflow({
        repo, store: path.join(root, 'store'),
        config: () => ({ pipeline: true, maxParallel: '2', maxRepairs: 2, useClinePlan: false, useClineAct: false }),
        adapter, changed() {}, log() {}
    });
    await workflow.load();
    const worker = await workflow.startStageWithPlan(plan, '实现外部方案', 'node --test');
    assert.equal(planned, false);
    assert.ok(worker.state.id);
    let phase = '';
    for (let index = 0; index < 200; index++) {
        phase = worker.state.phase;
        if (phase === '待验收') break;
        if (phase === '需处理' || phase === '规划失败') throw new Error(JSON.stringify(worker.state));
        await sleep(50);
    }
    assert.equal(phase, '待验收', 'unexpected phase ' + phase);
    assert.equal(await git(worker.state.stageTree, 'show', 'HEAD:a.txt'), 'implemented by one');
    const target = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    const dirtyTree = worker.state.tasks[0].tree;
    await fs.writeFile(path.join(dirtyTree, 'dirty.txt'), 'keep');
    await git(repo, 'switch', '-c', 'verify-other');
    await worker.action('accept');
    assert.equal(await git(repo, 'show', target + ':a.txt'), 'implemented by one');
    assert.equal(await fs.access(worker.state.stageTree).then(() => true, () => false), false);
    assert.equal(await fs.access(dirtyTree).then(() => true, () => false), true);
    assert.equal(await fs.readFile(path.join(dirtyTree, 'dirty.txt'), 'utf8'), 'keep');
    assert.equal(worker.state.preservedWorktrees.some(item => item.path === dirtyTree), true);
    await assert.rejects(git(repo, 'rev-parse', '--verify', worker.state.stageBranch));
    console.log('accept merge checked');
    console.log('external plan smoke passed');
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
})().catch(error => { console.error(error); process.exitCode = 1; });
