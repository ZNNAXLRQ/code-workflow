'use strict';

/**
 * DSH 自审适配器。
 *
 * 通过 `dsh --profile <profile> --json` 一次性运行一个审查任务，
 * 读取 NDJSON 事件里的 session 与 final，再把 final 文本解析成工作流
 * 需要的审查结果。审查提示要求 DSH 使用 goal/多轮自审，直到没有新的
 * 阻塞问题后再输出最终 JSON。这里不判断额度，也不修改仓库。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

function discoverDshCommand() {
    const executableName = 'DeepSeek Harness.exe';
    const candidates = [];
    if (process.env.DSH_NODE_EXECUTABLE) candidates.push(process.env.DSH_NODE_EXECUTABLE);
    const roots = [
        process.env.ProgramFiles,
        process.env.ProgramW6432,
        process.env['ProgramFiles(x86)'],
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
        'C:\\Program Files',
        'D:\\Program Files',
        'E:\\Program Files'
    ].filter(Boolean);
    for (const root of roots) {
        candidates.push(path.join(root, 'DeepseekHarness', executableName));
    }
    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // Ignore an unreadable candidate and keep looking.
        }
    }
    return 'dsh';
}

function dshCliPath(executable) {
    return path.join(path.dirname(executable), 'resources', 'app.asar', 'dsh', 'node_modules',
        '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js');
}

function resolveDshLauncher(value) {
    let executable = typeof value === 'string' && value.trim() ? value.trim() : discoverDshCommand();
    if (/\.cmd$/i.test(executable)) {
        executable = path.resolve(path.dirname(executable), '..', '..', '..', '..', 'DeepSeek Harness.exe');
    }
    if (/DeepSeek Harness\.exe$/i.test(executable)) {
        return {
            command: executable,
            prefix: ['--expose-internals', dshCliPath(executable)],
            env: { ELECTRON_RUN_AS_NODE: '1' }
        };
    }
    return { command: executable, prefix: [], env: {} };
}

function reviewPrompt(where, data, label) {
    const criteria = (data.criteria || []).map(item => ({ id: item.id, description: item.description }));
    const subagentPrompt = [
        '你是本地开发工作流的 DSH 初审子智能体。你有完全权限，可以读取、修改、创建、删除文件，运行命令并提交修复。',
        '仓库工作目录：' + where,
        '审查对象：' + label,
        '阶段/任务：' + (data.title || ''),
        '需求：' + (data.requirements || ''),
        '澄清/返修反馈：' + (Array.isArray(data.clarification) ? data.clarification.join('\n') : (data.clarification || '')),
        '审查范围：' + (data.base || '') + '..' + (data.candidate || ''),
        '测试摘要：' + JSON.stringify(data.test || {}),
        '测试覆盖：' + JSON.stringify(data.testCoverage || []),
        '验收标准：',
        JSON.stringify(criteria, null, 2),
        '历史审查：' + JSON.stringify(data.previous || null),
        '',
        '审查流程要求：',
        '1. 第一步创建 goal（审查目标）：持续自审并修复本次候选，直到你确认没有实现偏差、代码问题和潜在 bug；不限制自审轮次，不要因为“轮次够了”停止。只有工作流的返修轮次有上限，不是自审轮次。',
        '2. 实际读取 diff、相关文件，并按验收标准逐项核对；发现阻塞问题就直接修复，并运行相关测试。',
        '3. 你可以修改工作树、补充测试、提交修复；不要修改计划范围之外的文件，不要把风格偏好当阻塞。',
        '4. 修复后必须复核：重新读取 diff/文件，确认阻塞问题消失，测试通过。',
        '5. 最终只输出一个 JSON 对象，不要输出完整审查报告；工作流只需要知道通过，或者哪里有问题：',
        '{',
        '  "verdict": "pass" | "changes_requested" | "blocked",',
        '  "summary": "一句话结论；有问题时写清问题",',
        '  "findings": [{"path": "src/a.js", "line": 42, "blocking": true, "problem": "问题", "correction": "修复方向"}]',
        '}',
        'pass 时 findings 必须为空数组；不要返回逐项验收表或长篇报告，修改后的代码会保留并由复审直接检查。'
    ].join('\n');
    return [
        '你是本地开发工作流的 DSH 初审协调者。父会话不要创建 main goal，也不要自己直接修改代码；审查目标必须放在独立子智能体里。',
        '必须调用 subagent 工具，创建一个审查子智能体，把下面完整任务作为子智能体的 prompt；随后必须调用 wait_agent 等待子智能体完成，不要提前结束回合。',
        '子智能体完成后，把它的最终 JSON 原样作为你的最终输出。',
        '如果 subagent 工具不可用，或者子智能体启动失败，你直接按下面同一份任务完成审查（不要创建 goal，不要等待确认）。',
        '',
        '===== 子智能体任务开始 =====',
        subagentPrompt,
        '===== 子智能体任务结束 ====='
    ].join('\n');
}

function extractJson(text) {
    if (typeof text !== 'string') throw new Error('DSH 审查没有返回文本');
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : text;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('DSH 审查结果不是 JSON：' + text.slice(0, 500));
    try { return JSON.parse(body.slice(start, end + 1)); }
    catch (error) { throw new Error('DSH 审查 JSON 解析失败：' + error.message + '\n' + body.slice(start, end + 1).slice(0, 1000)); }
}

function validateShaped(review, data) {
    if (!review || !['pass', 'changes_requested', 'blocked'].includes(review.verdict)) {
        throw new Error('DSH 审查缺少合法 verdict');
    }
    if (typeof review.summary !== 'string' || !review.summary.trim()) {
        throw new Error('DSH 审查缺少 summary');
    }
    if (review.findings === undefined) review.findings = [];
    if (!Array.isArray(review.findings)) throw new Error('DSH 审查缺少 findings');
    if (review.verdict === 'pass' && review.findings.length) {
        throw new Error('DSH 审查结论为 pass，但仍有 findings');
    }
    if (review.verdict === 'changes_requested' && !review.findings.some(item => item.blocking)) {
        throw new Error('DSH 审查要求返修，但没有阻塞问题');
    }
    if (review.verdict === 'changes_requested') {
        for (const finding of review.findings.filter(item => item.blocking)) {
            if (typeof finding.path !== 'string' || !finding.path.trim() || typeof finding.problem !== 'string' ||
                typeof finding.correction !== 'string') {
                throw new Error('DSH 审查的阻塞问题必须提供 path、problem 和 correction');
            }
        }
    }
    return { ...review, candidate: data.candidate };
}

function runDshReview({ cwd, data, label, executable, args, profile = 'headless', permissionMode, approvalPolicy, timeoutMs = DEFAULT_TIMEOUT_MS, signal, log = () => {} }) {
    const launcher = resolveDshLauncher(executable);
    const command = launcher.command;
    const commandArgs = Array.isArray(args) && args.length
        ? args
        : [...launcher.prefix, '--profile', profile,
            ...(permissionMode ? ['--permission-mode', permissionMode] : []),
            ...(approvalPolicy ? ['--approval-policy', approvalPolicy] : []),
            '--json', '-'];
    const prompt = reviewPrompt(cwd, data, label);
    return new Promise((resolve, reject) => {
        let child;
        try {
            const env = {
                ...process.env,
                ...launcher.env,
                OLLAMA_API_KEY: process.env.OLLAMA_API_KEY || 'ollama'
            };
            child = spawn(command, commandArgs, { cwd, windowsHide: true, env });
        } catch (error) {
            reject(new Error('无法启动 DSH：' + error.message));
            return;
        }
        let stdout = '';
        let stderr = '';
        let settled = false;
        let sessionId = null;
        let finalText = null;
        let timer;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (error) reject(error); else resolve(value);
        };
        const onAbort = () => {
            try { child.kill(); } catch {}
            finish(signal.reason || new Error('DSH 自审已取消'));
        };
        if (signal) {
            if (signal.aborted) { onAbort(); return; }
            signal.addEventListener('abort', onAbort, { once: true });
        }
        timer = setTimeout(() => {
            try { child.kill(); } catch {}
            finish(new Error('DSH 自审超时（' + Math.round(timeoutMs / 60000) + ' 分钟）'));
        }, timeoutMs);
        child.stdout.on('data', chunk => {
            stdout += chunk.toString('utf8');
            const lines = stdout.split(/\r?\n/);
            stdout = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const event = JSON.parse(line);
                    if (event.type === 'session' && event.sessionId) {
                        sessionId = event.sessionId;
                        log('[dsh-review] session ' + sessionId);
                    }
                    if (event.type === 'status' && event.text) log('[dsh-review] ' + event.text);
                    if (event.type === 'final') {
                        sessionId = event.sessionId || sessionId;
                        finalText = typeof event.text === 'string' ? event.text : finalText;
                    }
                } catch {}
            }
        });
        child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
        child.on('error', error => finish(new Error('DSH 自审启动失败：' + error.message)));
        child.on('close', code => {
            if (settled) return;
            if (stdout.trim()) {
                try {
                    const event = JSON.parse(stdout.trim());
                    if (event.type === 'session' && event.sessionId) sessionId = event.sessionId;
                    if (event.type === 'final') finalText = event.text ?? finalText;
                } catch {}
            }
            if (code !== 0) {
                finish(new Error('DSH 自审退出码 ' + code + '：' + (stderr.trim() || '没有诊断输出')));
                return;
            }
            if (!finalText) {
                finish(new Error('DSH 自审没有 final 文本：' + (stderr.trim() || '没有诊断输出')));
                return;
            }
            try {
                const parsed = validateShaped(extractJson(finalText), data);
                log('[dsh-review] ' + (sessionId || 'session?') + ' ' + parsed.verdict);
                finish(null, parsed);
            } catch (error) { finish(error); }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(prompt);
    });
}

module.exports = { discoverDshCommand, resolveDshLauncher, reviewPrompt, extractJson, validateShaped, runDshReview };
