const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ReviewJournal } = require('../review-journal');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-journal-'));
const file = path.join(dir, 'reviews.json');
const candidate = 'a'.repeat(40);
const entry = {
    id: 'entry-1', stageId: 'stage-1', taskId: 'stage-1:task-1', label: 'task-1',
    candidate, base: 'b'.repeat(40), criteria: [{ id: 'task-1/A1' }], requirements: 'do it'
};
const journal = new ReviewJournal(file);
journal.recordBatch({ id: 'batch-1', entries: [entry] });
assert.equal(journal.openBatches().length, 1);

const review = {
    id: 'entry-1', candidate, verdict: 'pass',
    criteria: [{ id: 'task-1/A1', status: 'met', evidence: 'ok' }],
    findings: [], summary: 'ok'
};
assert.equal(journal.accept('batch-1', [review]), 1);
assert.equal(journal.openBatches().length, 0);
assert.deepEqual(journal.take({ stageId: 'stage-1', taskId: 'task-1', candidate }), review);
assert.deepEqual(journal.take({ stageId: 'stage-1', taskId: 'task-1', candidate }), review);
assert.equal(journal.commit({ stageId: 'stage-1', taskId: 'task-1', candidate }), true);
assert.equal(journal.take({ stageId: 'stage-1', taskId: 'task-1', candidate }), null);

journal.recordBatch({ id: 'batch-2', entries: [entry] });
assert.throws(() => journal.accept('batch-2', [{ ...review, candidate: 'c'.repeat(40), id: 'entry-1' }]), /候选/);
assert.equal(journal.openBatches().length, 1);
assert.throws(() => journal.accept('missing', []), error => error.code === 'UNKNOWN_BATCH');

const reloaded = new ReviewJournal(file);
assert.equal(reloaded.openBatches().length, 1);
reloaded.accept('batch-2', [review]);
assert.deepEqual(reloaded.take({ stageId: 'stage-1', taskId: 'task-1', candidate }), review);
assert.equal(reloaded.commit({ stageId: 'stage-1', taskId: 'task-1', candidate }), true);

fs.rmSync(dir, { recursive: true, force: true });
console.log('review journal smoke passed');
