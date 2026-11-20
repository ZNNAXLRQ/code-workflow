const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Workflow, git } = require('../workflow');
const { ReviewJournal } = require('../review-journal');

const stageReview = data => ({
    candidate: data.candidate, verdict: 'pass',
    criteria: data.criteria.map(check => ({ id: check.id, status: 'met', evidence: 'stage' })),
    findings: [], summary: 'stage ok'
});

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-reload-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'Reload');
    await git(repo, 'config', 'user.email', 'reload@example.invalid');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'base');

    const firstAdapter = {
        plan: async () => { throw new Error('external'); },
        implement: async (cwd, prompt, report, task) => { await fs.writeFile(path.join(cwd, 'a.txt'), 'one'); },
        test: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        review: async (where, data, directory, label) => {
            if (label === 'stage') return stageReview(data);
            return new Promise(() => {});
        }
    };
    const plan = {
        stage: '重载审查', question: '', testCommand: 'node --test',
        tasks: [{ id: 'one', title: '写 a.txt', requirements: '写文件', criteria: ['存在'], paths: ['a.txt'], dependsOn: [] }]
    };
    const first = new Workflow({
        repo, store: path.join(root, 'store'),
        config: () => ({ pipeline: true, maxParallel: '1', maxRepairs: 2, useClinePlan: false, initialCommit: false }),
        adapter: firstAdapter, changed() {}, log() {}
    });
    await first.load();
    const worker = await first.startStageWithPlan(plan, 'one', 'node --test');
    for (let index = 0; index < 100; index++) {
        if (worker.state.tasks[0]?.pendingReview) break;
        await sleep(50);
    }
    const task = worker.state.tasks[0];
    assert.ok(task?.pendingReview, 'task must be waiting for review');
    const stageId = worker.state.id;
    const candidate = task.candidate;
    const criteria = task.criteria.map((description, index) => ({ id: task.id + '/A' + (index + 1), description }));
    const review = {
        id: 'entry-1', candidate, verdict: 'pass',
        criteria: criteria.map(check => ({ id: check.id, status: 'met', evidence: 'recovered' })),
        findings: [], summary: 'recovered review'
    };
    const journal = new ReviewJournal(path.join(root, 'store', 'reviews.json'));
    journal.recordBatch({ id: 'batch-reload', entries: [{
        id: 'entry-1', stageId, taskId: stageId + ':' + task.id, label: task.id,
        candidate, base: task.base, criteria
    }] });
    journal.accept('batch-reload', [review]);
    assert.deepEqual(journal.take({ stageId, taskId: task.id, candidate }), review);

    let taskReviewCalls = 0;
    const second = new Workflow({
        repo, store: path.join(root, 'store'), reviewJournal: journal,
        config: () => ({ pipeline: true, maxParallel: '1', maxRepairs: 2, useClinePlan: false, initialCommit: false }),
        adapter: {
            plan: async () => { throw new Error('external'); },
            implement: async () => { throw new Error('must reuse pending candidate'); },
            test: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
            review: async (where, data, directory, label) => {
                if (label === 'stage') return stageReview(data);
                taskReviewCalls++;
                throw new Error('task review should come from journal');
            }
        }, changed() {}, log() {}
    });
    await second.load();
    const worker2 = second.stageWorker(stageId);
    assert.ok(['已暂停', '运行中'].includes(worker2.state.phase),
        'reload should either keep the stage paused or auto-resume when no task is blocked');
    if (worker2.state.phase === '已暂停') await worker2.action('resume');
    else if (worker2.state.phase === '运行中') await worker2.tick();
    for (let index = 0; index < 200; index++) {
        if (worker2.state.phase === '待验收') break;
        if (worker2.state.phase === '需处理') throw new Error(worker2.state.message);
        await sleep(50);
    }
    assert.equal(worker2.state.phase, '待验收');
    assert.equal(taskReviewCalls, 0, 'task review must not be requested again');
    assert.equal(journal.take({ stageId, taskId: task.id, candidate }), null, 'journal result consumed after save');

    await fs.rm(root, { recursive: true, force: true });
    console.log('review reload smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
