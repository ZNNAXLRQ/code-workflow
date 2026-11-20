const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Workflow, git } = require('../workflow');

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-self-review-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'DSH Review');
    await git(repo, 'config', 'user.email', 'dsh@example.invalid');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'base');

    let reviews = 0;
    let codexReviews = 0;
    const adapter = {
        implement: async (where, prompt, report, task) => {
            const file = task.id === 'two' ? 'b.txt' : 'a.txt';
            await fs.writeFile(path.join(where, file), 'implemented by ' + task.id);
        },
        test: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        selfReview: async (where, data, label) => {
            reviews++;
            await fs.writeFile(path.join(where, 'dsh-review-' + label + '.txt'), 'fixed by DSH');
            return {
                candidate: data.candidate, verdict: 'pass',
                criteria: data.criteria.map(item => ({ id: item.id, status: 'met', evidence: 'DSH 修复并验证' })),
                findings: [], summary: 'DSH 自审通过'
            };
        },
        review: async (where, data) => {
            codexReviews++;
            return {
                candidate: data.candidate, verdict: 'pass',
                criteria: data.criteria.map(item => ({ id: item.id, status: 'met', evidence: 'Codex 复审' })),
                findings: [], summary: 'Codex 复审通过'
            };
        }
    };
    const plan = {
        stage: 'DSH 自审阶段', question: '', testCommand: 'node -e "process.exit(0)"',
        tasks: [{
            id: 'one', title: '写文件', requirements: '写文件', criteria: ['文件存在'],
            paths: ['a.txt', 'dsh-review-one.txt', 'dsh-review-stage.txt'], dependsOn: [], testCommand: ''
        }]
    };
    const workflow = new Workflow({
        repo, store: path.join(root, 'store'),
        config: () => ({ pipeline: true, maxParallel: '2', maxRepairs: 2, useClineAct: false,
            reviewDsh: true, reviewCodex: false }),
        adapter, changed() {}, log() {}
    });
    await workflow.load();
    const worker = await workflow.startStageWithPlan(plan, '实现 DSH 自审', plan.testCommand);
    let phase = '';
    for (let index = 0; index < 200; index++) {
        phase = worker.state.phase;
        if (phase === '待验收') break;
        if (phase === '需处理' || phase === '规划失败') throw new Error(JSON.stringify(worker.state));
        await sleep(50);
    }
    assert.equal(phase, '待验收', 'unexpected phase ' + phase);
    assert.ok(reviews >= 2, 'DSH self-review should run for task and stage');
    assert.equal(codexReviews, 0, 'DSH-only mode must not call Codex review');
    assert.equal(worker.state.stageDshReview.verdict, 'pass');
    assert.equal(worker.state.stageReview.candidate, worker.state.stageHead);
    assert.equal(await git(worker.state.stageTree, 'show', 'HEAD:dsh-review-stage.txt'), 'fixed by DSH');
    await worker.action('accept');
    const target = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    assert.equal(await git(repo, 'show', target + ':dsh-review-stage.txt'), 'fixed by DSH');
    assert.equal(await git(repo, 'show', target + ':a.txt'), 'implemented by one');

    const both = new Workflow({
        repo, store: path.join(root, 'store-both'),
        config: () => ({ pipeline: true, maxParallel: '2', maxRepairs: 2, useClineAct: false,
            reviewDsh: true, reviewCodex: true }),
        adapter, changed() {}, log() {}
    });
    await both.load();
    const plan2 = {
        stage: 'DSH 初审加 Codex 复审', question: '', testCommand: 'node -e "process.exit(0)"',
        tasks: [{
            id: 'two', title: '写第二个文件', requirements: '写第二个文件', criteria: ['第二个文件存在'],
            paths: ['b.txt', 'dsh-review-two.txt', 'dsh-review-stage.txt'], dependsOn: [], testCommand: ''
        }]
    };
    const second = await both.startStageWithPlan(plan2, '实现双重审查', plan2.testCommand);
    let bothPhase = '';
    for (let index = 0; index < 200; index++) {
        bothPhase = second.state.phase;
        if (bothPhase === '待验收') break;
        if (bothPhase === '需处理' || bothPhase === '规划失败') throw new Error(JSON.stringify(second.state));
        await sleep(50);
    }
    assert.equal(bothPhase, '待验收', 'unexpected phase ' + bothPhase);
    assert.ok(codexReviews >= 2, 'Codex review should run for task and stage');
    assert.equal(second.state.stageReview.dshReview.verdict, 'pass');
    await second.action('accept');
    const target2 = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    assert.equal(await git(repo, 'show', target2 + ':b.txt'), 'implemented by two');
    assert.equal(await git(repo, 'show', target2 + ':dsh-review-stage.txt'), 'fixed by DSH');
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    console.log('dsh self-review smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
