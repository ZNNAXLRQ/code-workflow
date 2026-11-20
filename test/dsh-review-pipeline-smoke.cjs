const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { Workflow } = require('../workflow');

function fakeReview(data, verdict = 'pass') {
    return {
        candidate: data.candidate, verdict,
        criteria: data.criteria.map(item => ({ id: item.id, status: verdict === 'pass' ? 'met' : 'unmet', evidence: 'fixture' })),
        findings: verdict === 'pass' ? [] : [{ blocking: true, path: 'a.js', problem: 'missing', correction: 'fix' }],
        summary: verdict
    };
}

function entry(id, data, signal, result) {
    return {
        id, where: process.cwd(), data, label: id, signal,
        onStart: async () => { result.started++; },
        resolve: value => { result.resolves[id] = value; result.done++; },
        reject: error => { result.rejects[id] = error; result.done++; }
    };
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-review-pipeline-'));
    const data = {
        candidate: 'abc', base: 'base', title: 't', requirements: 'r',
        criteria: [{ id: 't/A1', description: 'works' }]
    };
    const state = { reviewDsh: true, reviewCodex: true };
    let codexCalls = 0;
    let dshCalls = 0;
    const workflow = new Workflow({
        repo: root, store: path.join(root, 'store'), records: path.join(root, 'records'),
        legacyStore: path.join(root, 'legacy'), config: () => ({ ...state }),
        adapter: {
            selfReview: async () => { dshCalls++; return fakeReview(data); },
            reviewBatch: async entries => {
                codexCalls++;
                return new Map(entries.map(item => [item.id, { review: fakeReview(item.data) }]));
            }
        },
        changed() {}, log() {}
    });

    let result = { started: 0, done: 0, resolves: {}, rejects: {} };
    const controller = new AbortController();
    workflow.reviewQueue = [entry('e1', data, controller.signal, result)];
    await workflow.flushReview();
    assert.equal(dshCalls, 1);
    assert.equal(codexCalls, 1);
    assert.equal(result.resolves.e1.verdict, 'pass');
    assert.equal(result.resolves.e1.dshReview.verdict, 'pass');

    state.reviewCodex = false;
    result = { started: 0, done: 0, resolves: {}, rejects: {} };
    workflow.reviewQueue = [entry('e2', data, controller.signal, result)];
    await workflow.flushReview();
    assert.equal(dshCalls, 2);
    assert.equal(codexCalls, 1);
    assert.equal(result.resolves.e2.verdict, 'pass');

    state.reviewCodex = true;
    state.reviewDsh = false;
    result = { started: 0, done: 0, resolves: {}, rejects: {} };
    workflow.reviewQueue = [entry('e3', data, controller.signal, result)];
    await workflow.flushReview();
    assert.equal(dshCalls, 2);
    assert.equal(codexCalls, 2);
    assert.equal(result.resolves.e3.verdict, 'pass');

    state.reviewDsh = true;
    state.reviewCodex = false;
    const failing = new Workflow({
        repo: root, store: path.join(root, 'store2'), records: path.join(root, 'records2'),
        legacyStore: path.join(root, 'legacy2'), config: () => ({ ...state }),
        adapter: {
            selfReview: async () => ({ ...fakeReview(data, 'changes_requested') }),
            reviewBatch: async () => { throw new Error('Codex must not run after DSH rejection'); }
        },
        changed() {}, log() {}
    });
    result = { started: 0, done: 0, resolves: {}, rejects: {} };
    failing.reviewQueue = [entry('e4', data, controller.signal, result)];
    await failing.flushReview();
    assert.equal(result.resolves.e4.verdict, 'changes_requested');

    fs.rmSync(root, { recursive: true, force: true });
    console.log('dsh review pipeline smoke passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
