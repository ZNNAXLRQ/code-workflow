const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Workflow } = require('../workflow');

function git(cwd, ...args) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, windowsHide: true });
        let out = '', err = '';
        child.stdout.on('data', chunk => { out += chunk; });
        child.stderr.on('data', chunk => { err += chunk; });
        child.on('close', code => code === 0 ? resolve(out) : reject(new Error(err || out)));
    });
}

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-temp-'));
    const repo = path.join(dir, 'repo');
    const store = path.join(dir, 'store');
    fs.mkdirSync(repo);
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.email', 'test@example.com');
    await git(repo, 'config', 'user.name', 'Test');
    await git(repo, 'add', '.');
    await git(repo, 'commit', '-m', 'base');

    const workflow = new Workflow({
        repo, store, records: path.join(repo, '.local-workflow'),
        legacyStore: path.join(repo, '.local-workflow'),
        config: () => ({}), adapter: {}, changed() {}, log() {}
    });
    workflow.state = { id: 'stage-temp', acceptTemp: null };
    workflow.stateFile = path.join(store, 'stage-temp.json');
    await workflow.save();

    const unrecorded = path.join(store, 'accept-unrecorded');
    const recorded = path.join(store, 'accept-recorded');
    await git(repo, 'worktree', 'add', '--detach', unrecorded, 'HEAD');
    await git(repo, 'worktree', 'add', '--detach', recorded, 'HEAD');
    fs.writeFileSync(path.join(unrecorded, 'keep-unrecorded.txt'), 'keep\n');
    fs.writeFileSync(path.join(recorded, 'keep-recorded.txt'), 'keep\n');
    workflow.state.acceptTemp = recorded;
    await workflow.save();

    await assert.rejects(workflow.pruneAcceptWorktrees(), /未提交改动/);
    assert.equal(fs.existsSync(path.join(recorded, 'keep-recorded.txt')), true);
    assert.equal(fs.existsSync(path.join(unrecorded, 'keep-unrecorded.txt')), true);
    assert.equal(workflow.state.acceptTemp, recorded);

    const cleaned = await workflow.pruneAcceptWorktrees({ strict: false });
    assert.equal(cleaned, false);
    assert.equal(fs.existsSync(path.join(recorded, 'keep-recorded.txt')), true);
    assert.equal((workflow.state.preservedWorktrees || []).some(entry => entry.path === recorded), true);

    await git(repo, 'worktree', 'remove', '--force', recorded);
    await git(repo, 'worktree', 'remove', '--force', unrecorded);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('accept temp smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
