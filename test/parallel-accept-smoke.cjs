const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Workflow, git } = require('../workflow');

(async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-accept-'));
    const repo = path.join(root, 'repo');
    await fs.mkdir(repo);
    await git(repo, 'init', '-q');
    await git(repo, 'config', 'user.name', 'Parallel');
    await git(repo, 'config', 'user.email', 'parallel@example.invalid');
    await fs.writeFile(path.join(repo, 'base.txt'), 'base');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-qm', 'base');
    const target = (await git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();

    const adapter = {
        plan: async () => { throw new Error('external plan only'); },
        implement: async (cwd, prompt, report, task) => {
            await fs.writeFile(path.join(cwd, task.paths[0]), task.id);
        },
        test: async () => ({ code: 0, stdout: 'ok', stderr: '' }),
        review: async (where, data) => ({
            candidate: data.candidate, verdict: 'pass',
            criteria: data.criteria.map(check => ({ id: check.id, status: 'met', evidence: 'fixture' })),
            findings: [], summary: 'ok'
        })
    };
    const workflow = new Workflow({
        repo, store: path.join(root, 'store'),
        config: () => ({ pipeline: true, maxParallel: '2', maxRepairs: 2, useClinePlan: false, initialCommit: false }),
        adapter, changed() {}, log() {}
    });
    await workflow.load();
    const makePlan = (id, file) => ({
        stage: '阶段 ' + id, question: '', testCommand: 'node --test',
        tasks: [{ id, title: '写 ' + file, requirements: '写文件', criteria: ['存在'], paths: [file], dependsOn: [] }]
    });
    const wait = async worker => {
        for (let index = 0; index < 200; index++) {
            if (worker.state.phase === '待验收') return;
            if (['需处理', '规划失败'].includes(worker.state.phase)) throw new Error(worker.state.message);
            await sleep(50);
        }
        throw new Error('timeout ' + worker.state.phase);
    };
    const first = await workflow.startStageWithPlan(makePlan('one', 'a.txt'), 'one', 'node --test');
    const second = await workflow.startStageWithPlan(makePlan('two', 'b.txt'), 'two', 'node --test');
    await wait(first);
    await wait(second);

    await first.action('accept');
    assert.equal(await git(repo, 'show', target + ':a.txt'), 'one');
    assert.equal(first.state.phase, '已验收');
    await second.action('accept');
    assert.equal(await git(repo, 'show', target + ':a.txt'), 'one');
    assert.equal(await git(repo, 'show', target + ':b.txt'), 'two');
    assert.equal(second.state.phase, '已验收');

    await fs.rm(root, { recursive: true, force: true });
    console.log('parallel accept smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
