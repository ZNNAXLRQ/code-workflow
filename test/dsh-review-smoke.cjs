const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runDshReview, extractJson } = require('../dsh-review');

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-review-'));
    const fake = path.join(dir, 'fake-dsh.cjs');
    fs.writeFileSync(fake, `
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const data = JSON.parse(process.env.FAKE_RESULT);
  process.stdout.write(JSON.stringify({ type: 'session', sessionId: 'session-test' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'status', text: 'reviewing' }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'final', sessionId: 'session-test', text: JSON.stringify(data) }) + '\\n');
  if (!input.includes('验收标准')) process.exit(2);
});
`, 'utf8');
    const data = {
        title: '测试任务', requirements: '实现功能', candidate: 'abc123', base: 'base',
        criteria: [{ id: 't1/A1', description: '功能可用' }],
        test: { passed: true, detail: 'ok' }
    };
    process.env.FAKE_RESULT = JSON.stringify({
        verdict: 'pass', summary: '通过',
        criteria: [{ id: 't1/A1', status: 'met', evidence: '测试通过' }],
        findings: []
    });
    const result = await runDshReview({
        cwd: dir, data, label: 't1', executable: process.execPath, args: [fake]
    });
    assert.equal(result.verdict, 'pass');
    assert.equal(result.candidate, 'abc123');
    assert.deepEqual(result.criteria[0], { id: 't1/A1', status: 'met', evidence: '测试通过' });

    process.env.FAKE_RESULT = JSON.stringify({
        verdict: 'changes_requested', summary: '返修',
        criteria: [{ id: 't1/A1', status: 'unmet', evidence: '缺少校验' }],
        findings: [{ blocking: true, path: 'src/a.js', problem: '缺少校验', correction: '补校验' }]
    });
    const rejected = await runDshReview({
        cwd: dir, data, label: 't1', executable: process.execPath, args: [fake]
    });
    assert.equal(rejected.verdict, 'changes_requested');

    assert.equal(extractJson('```json\n{"verdict":"pass"}\n```').verdict, 'pass');
    fs.rmSync(dir, { recursive: true, force: true });
    console.log('dsh review smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
