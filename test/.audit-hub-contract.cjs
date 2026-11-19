'use strict';
// Temporary audit harness: real hub.js envelope + real plugin server.cjs.
// Creates files only under os.tmpdir(); no Codex session, no source edits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHub, writeDiscovery } = require('../hub');

const pluginDir = 'C:\\Users\\ZNNAXLRQ\\.codex\\plugins\\local-workflow-marketplace\\plugins\\local-workflow';
const serverPath = path.join(pluginDir, 'server.cjs');
const token = 'audit-token-' + process.pid;

function connectMcp(child) {
    let buffer = '';
    let nextId = 1;
    const pending = new Map();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
        buffer += chunk;
        let i;
        while ((i = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, i).trim();
            buffer = buffer.slice(i + 1);
            if (!line) continue;
            const msg = JSON.parse(line);
            const entry = pending.get(msg.id);
            if (!entry) continue;
            pending.delete(msg.id);
            entry(msg.error ? new Error(JSON.stringify(msg.error)) : null, msg.result);
        }
    });
    return (method, params) => new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (err, result) => err ? reject(err) : resolve(result));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
}

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-hub-contract-'));
    let child;
    let hub;
    try {
        // Handlers shaped exactly like extension.js: status/reviews/plan.
        hub = createHub({
            token,
            handlers: {
                status: async () => ({
                    repo: root, frontend: 'codex', phase: '运行中', pipelinePaused: false,
                    queue: 0, archive: 0, boundThread: 't', binding: null,
                    selectedStage: 'stage-1', stages: [{ id: 'stage-1', phase: '运行中', tasks: [] }]
                }),
                reviews: async () => ({
                    batches: [{ id: 'batch-real-1', entries: [{ id: 'entry-1', stageId: 'stage-1', taskId: 'task-1', candidate: 'c'.repeat(40), criteria: [] }] }]
                }),
                plan: async () => ({
                    planId: 'plan-real-1', status: 'pending_confirmation', stage: '实现登录',
                    taskCount: 2, testCommand: 'npm test', initialCommit: false, dirtyCount: 0,
                    message: '方案已暂存，等待用户明确确认后才会派发。'
                }),
                pause: async () => ({ paused: true })
            }
        });
        const started = await hub.start();
        writeDiscovery(root, { port: started.port, token, repo: root });

        child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const request = connectMcp(child);
        await request('initialize', { protocolVersion: '2024-11-05', capabilities: {} });
        const call = async (name, args) => request('tools/call', { name, arguments: args });

        const reviews = await call('workflow_pending_reviews', { repo: root });
        console.log('=== workflow_pending_reviews ===');
        console.log(reviews.content[0].text);

        const status = await call('workflow_status', { repo: root });
        console.log('=== workflow_status ===');
        console.log(status.content[0].text);

        const plan = await call('submit_plan', {
            repo: root, request: '实现登录', testCommand: 'npm test', stage: '实现登录',
            tasks: [{ id: 'task-1', title: 't', files: ['a.js'], acceptance: ['a'] }]
        });
        console.log('=== submit_plan ===');
        console.log(plan.content[0].text);

        const single = await call('submit_review', {
            repo: root, stageId: 'stage-1', verdict: 'pass', criteria: ['a'], findings: [], summary: 'ok'
        });
        console.log('=== submit_review (hub has no /review handler here) ===');
        console.log(JSON.stringify({ isError: single.isError, text: single.content[0].text }));
    } finally {
        try { child?.kill(); } catch {}
        try { await hub?.close(); } catch {}
        fs.rmSync(root, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
