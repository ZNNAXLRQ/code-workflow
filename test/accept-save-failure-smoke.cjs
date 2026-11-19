const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Workflow, git } = require('../workflow');

const adapter = {
    plan: async () => { throw new Error('external'); },
    implement: async (cwd, prompt, report, task) => { await fs.writeFile(path.join(cwd, 'a.txt'), 'one'); },
    test: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
    review: async (where, data) => ({
        candidate: data.candidate, verdict: 'pass',
        criteria: data.criteria.map(check => ({ id: check.id, status: 'met', evidence: 'ok' })),
        findings: [], summary: 'ok'
    })
};
const config = () => ({ pipeline: true, maxParallel: '1', maxRepairs: 2, useClinePlan: false, initialCommit: false });

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'accept-save-failure-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'Failure');
    await git(repo, 'config', 'user.email', 'failure@example.invalid');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'base');
    const target = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    const store = path.join(root, 'store');
    const first = new Workflow({ repo, store, config, adapter, changed() {}, log() {} });
    await first.load();
    const worker = await first.startStageWithPlan({
        stage: '保存失败', question: '', testCommand: 'node --test',
        tasks: [{ id: 'one', title: '写 a.txt', requirements: '写文件', criteria: ['存在'], paths: ['a.txt'], dependsOn: [] }]
    }, 'one', 'node --test');
    for (let index = 0; index < 200; index++) {
        if (worker.state.phase === '待验收') break;
        if (worker.state.phase === '需处理') throw new Error(worker.state.message);
        await sleep(50);
    }
    assert.equal(worker.state.phase, '待验收');
    assert.equal(await git(worker.state.stageTree, 'rev-parse', 'HEAD'), worker.state.stageHead);

    const originalSave = worker.save.bind(worker);
    let failed = false;
    worker.save = async () => {
        if (!failed) { failed = true; throw new Error('simulated save failure'); }
        return originalSave();
    };
    await assert.rejects(worker.action('accept'), /simulated save failure/);
    assert.equal(await git(repo, 'show', target + ':a.txt'), 'one', 'merge happened before the failed save');
    assert.equal(await fs.access(worker.state.stageTree).then(() => true, () => false), true,
        'stage worktree must not be removed before state save');

    const second = new Workflow({ repo, store, config, adapter, changed() {}, log() {} });
    await second.load();
    const reloaded = second.stageWorker(worker.state.id);
    assert.ok(reloaded);
    assert.equal(reloaded.state.phase, '待验收');
    await reloaded.action('accept');
    assert.equal(reloaded.state.phase, '已验收');
    assert.equal(await git(repo, 'show', target + ':a.txt'), 'one');
    assert.equal(await fs.access(reloaded.state.stageTree).then(() => true, () => false), false);

    await fs.rm(root, { recursive: true, force: true });
    console.log('accept save failure smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
