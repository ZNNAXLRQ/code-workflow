'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_CAPTURE = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MISSING = '找不到 Cline CLI，请安装或在设置中指定入口';
const CLARIFY = '[需要澄清]';
const SUBMISSION_PREFIX = /^Submission recorded \([^)]*\):\s*/i;
const UNVERIFIED_PREFIX = 'Submission recorded (unverified):';

function nodeEnv() {
    return { ELECTRON_RUN_AS_NODE: '1' };
}

// Keep the existing behavior in extension.js: always bypass the local machine
// even when the user's NO_PROXY already contains other entries.
function localProxyBypass() {
    const existing = [process.env.NO_PROXY, process.env.no_proxy]
        .flatMap(value => (value || '').split(','));
    return [...new Set([
        ...existing.map(value => value.trim()).filter(Boolean),
        'localhost', '127.0.0.1', '::1'
    ])].join(',');
}

function fromEntry(clineEntry) {
    if (typeof clineEntry !== 'string' || !clineEntry.trim()) return undefined;
    const entry = clineEntry.trim();
    return entry.toLowerCase().endsWith('.exe')
        ? { command: entry, baseArgs: [], env: {} }
        : { command: process.execPath, baseArgs: [entry], env: nodeEnv() };
}

// Resolve the CLI executable only.  This module never passes --data-dir,
// -P/-m or --id: the task uses Cline's native data directory and the
// provider/model selected by the user inside Cline.
function resolveCline({ clineEntry, platform = process.platform, appData = process.env.APPDATA } = {}) {
    const configured = fromEntry(clineEntry);
    if (configured) return configured;
    if (platform !== 'win32') return { command: 'cline', baseArgs: [], env: {} };
    const install = path.join(appData || '', 'npm', 'node_modules', 'cline');
    const candidates = [
        path.join(install, 'node_modules', '@cline', 'cli-windows-' + process.arch, 'bin', 'cline.exe'),
        path.join(install, 'bin', 'cline')
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return fromEntry(candidate);
    }
    throw new Error(MISSING);
}

function parseLine(line, events) {
    const text = line.trim();
    if (!text) return;
    try {
        events.push(JSON.parse(text));
    } catch {
        // A CLI may emit a non-JSON log line on stdout; it is not an event.
    }
}

function lastRunResult(events) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index]?.type === 'run_result') return events[index];
    }
    return undefined;
}

// Only an explicit session id is accepted.  Events may carry a taskId like
// conv_..., but that is not the session id stored under Cline's sessions
// directory, so it is deliberately ignored.
function explicitSessionId(value) {
    if (!value || typeof value !== 'object') return null;
    for (const key of ['session_id', 'sessionId']) {
        const id = value[key];
        if (typeof id === 'string' && id.trim()) return id.trim();
    }
    return null;
}

function findSessionId(final, events) {
    const direct = explicitSessionId(final);
    if (direct) return direct;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const id = explicitSessionId(events[index]);
        if (id) return id;
    }
    return null;
}

function runTask({ cwd, prompt, clineEntry, signal, timeoutSec = 0, onLog, runtime: prepared, extraArgs = [] } = {}) {
    if (typeof cwd !== 'string' || !cwd) return Promise.reject(new Error('runTask 需要 cwd'));
    if (typeof prompt !== 'string' || !prompt) return Promise.reject(new Error('runTask 需要 prompt'));
    let runtime;
    try {
        runtime = prepared || resolveCline({ clineEntry });
    } catch (error) {
        return Promise.reject(error);
    }
    if (signal?.aborted) return Promise.reject(signal.reason);

    const bypass = localProxyBypass();
    return new Promise((resolve, reject) => {
        const events = [];
        let pending = '';
        let stderr = '';
        let child;
        let timer;
        let settled = false;
        let timedOut = false;

        const finish = () => {
            if (settled) return false;
            settled = true;
            if (timer) clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            return true;
        };

        const log = chunk => {
            if (typeof onLog !== 'function') return;
            try {
                onLog(chunk);
            } catch {
                // A logging callback must never change the outcome of a task.
            }
        };

        function killTree() {
            if (!child?.pid || child.exitCode !== null) return;
            if (process.platform === 'win32') {
                const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
                    windowsHide: true, stdio: 'ignore'
                });
                killer.once('error', () => child.kill());
                killer.once('close', code => {
                    if (code && child.exitCode === null) child.kill();
                });
            } else {
                child.kill();
            }
        }

        function onAbort() {
            killTree();
        }

        try {
            child = spawn(runtime.command, [
                ...runtime.baseArgs,
                '--json',
                '--auto-approve=true',
                ...extraArgs,
                ...(Number(timeoutSec) > 0 ? ['--timeout', String(timeoutSec)] : []),
                '--', prompt
            ], {
                cwd,
                env: { ...process.env, ...(runtime.env || runtime.runtimeEnv || {}), NO_PROXY: bypass, no_proxy: bypass },
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (error) {
            finish();
            reject(error);
            return;
        }

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
            pending += chunk;
            let index;
            while ((index = pending.indexOf('\n')) !== -1) {
                parseLine(pending.slice(0, index), events);
                pending = pending.slice(index + 1);
            }
            if (pending.length > MAX_LINE) pending = pending.slice(-MAX_LINE);
            log(chunk);
        });
        child.stderr.on('data', chunk => {
            stderr = (stderr + chunk).slice(-MAX_CAPTURE);
            log(chunk);
        });

        // --timeout is enforced by the CLI itself; this is only a last-resort
        // guard so a wedged CLI cannot keep the workflow waiting forever.
        const seconds = Number(timeoutSec);
        if (Number.isFinite(seconds) && seconds > 0) {
            timer = setTimeout(() => {
                timedOut = true;
                killTree();
            }, (seconds + 60) * 1000);
        }

        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) killTree();

        child.once('error', error => {
            if (!finish()) return;
            reject(signal?.aborted
                ? signal.reason
                : new Error('无法启动 Cline CLI（' + runtime.command + '）：' + error.message));
        });

        child.once('close', code => {
            if (pending.trim()) parseLine(pending, events);
            pending = '';
            if (!finish()) return;
            if (signal?.aborted) {
                reject(signal.reason);
                return;
            }

            const exitCode = code ?? 1;
            if (timedOut) {
                const tail = stderr.trim();
                reject(new Error('Cline 任务超时（' + timeoutSec + ' 秒）' + (tail ? '：' + tail.slice(-1400) : '')));
                return;
            }

            const final = lastRunResult(events);
            const rawText = typeof final?.text === 'string' ? final.text : '';
            const finalText = rawText.replace(SUBMISSION_PREFIX, '').trim();
            const sessionId = findSessionId(final, events);

            // A clarification request is a valid outcome of an implementation
            // task even when Cline's own finish reason is not "completed".
            if (finalText.startsWith(CLARIFY)) {
                resolve({
                    sessionId, finalText, events, exitCode,
                    question: finalText.slice(CLARIFY.length).trim()
                });
                return;
            }

            const unverified = rawText.startsWith(UNVERIFIED_PREFIX);
            if (final?.finishReason !== 'completed' || (exitCode !== 0 && !unverified)) {
                const errorMessages = events
                    .filter(event => event?.type === 'error')
                    .map(event => typeof event?.message === 'string' ? event.message : '')
                    .filter(Boolean);
                const details = [stderr.trim(), ...errorMessages, rawText].filter(Boolean).join('\n');
                reject(new Error('Cline 运行失败（' + (final?.finishReason || exitCode) + '）：' +
                    (details || '请查看输出').slice(-1400)));
                return;
            }

            resolve({ sessionId, finalText, events, exitCode, question: undefined });
        });
    });
}

module.exports = { resolveCline, runTask };
