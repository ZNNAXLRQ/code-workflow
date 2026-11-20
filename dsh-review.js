'use strict';

/**
 * DSH 自审适配器。
 *
 * 通过 `dsh --profile headless --json` 一次性运行一个只读审查任务，
 * 读取 NDJSON 事件里的 session 与 final，再把 final 文本解析成工作流
 * 需要的审查结果。审查提示要求 DSH 使用 goal/多轮自审，直到没有新的
 * 阻塞问题后再输出最终 JSON。这里不判断额度，也不修改仓库。
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;

function discoverDshCommand() {
    if (process.env.DSH_NODE_EXECUTABLE) {
        const candidate = path.join(path.dirname(process.env.DSH_NODE_EXECUTABLE),
            'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
        if (fs.existsSync(candidate)) return candidate;
    }
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const common = path.join(programFiles, 'DeepseekHarness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
    if (fs.existsSync(common)) return common;
    return 'dsh';
}

function reviewPrompt(where, data, label) {
    const criteria = (data.criteria || []).map(item => ({ id: item.id, description: item.description }));
    return [
        '你是本地开发工作流的 DSH 初审。只读审查，不要修改、提交或创建文件。',
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
        '1. 如果当前工具有 goal 工具，先创建/使用目标（goal）：完整审查本次候选并完成至少两轮自审，直到没有新的阻塞问题；没有 goal 工具时也要做至少两轮自审。',
        '2. 实际读取 diff、相关文件，并按验收标准逐项核对；不要只凭测试摘要。',
        '3. 发现阻塞问题时给出具体文件/行为/修复方向；不要把风格偏好当阻塞。',
        '4. 不修改代码。只有全部验收项有证据且没有阻塞问题时才 pass；pass 时 findings 必须是空数组。',
        '5. 最终只输出一个 JSON 对象，不要输出其他文字：',
        '{',
        '  "verdict": "pass" | "changes_requested" | "blocked",',
        '  "summary": "一句话结论",',
        '  "criteria": [{"id": "验收项 id", "status": "met" | "unmet" | "unverified", "evidence": "证据"}],',
        '  "findings": [{"path": "src/a.js", "line": 42, "blocking": true, "problem": "问题", "evidence": "证据", "correction": "修复方向"}]',
        '}'
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
    if (!Array.isArray(review.criteria) || review.criteria.length !== (data.criteria || []).length) {
        throw new Error('DSH 审查的 criteria 数量与验收项不一致');
    }
    for (const item of data.criteria || []) {
        if (review.criteria.filter(result => result && result.id === item.id).length !== 1) {
            throw new Error('DSH 审查没有逐项返回验收项：' + item.id);
        }
    }
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

function runDshReview({ cwd, data, label, executable, args, permissionMode, approvalPolicy, timeoutMs = DEFAULT_TIMEOUT_MS, signal, log = () => {} }) {
    const command = executable || discoverDshCommand();
    const commandArgs = Array.isArray(args) && args.length
        ? args
        : ['--profile', 'headless',
            ...(permissionMode ? ['--permission-mode', permissionMode] : []),
            ...(approvalPolicy ? ['--approval-policy', approvalPolicy] : []),
            '--json', '-'];
    const prompt = reviewPrompt(cwd, data, label);
    return new Promise((resolve, reject) => {
        let child;
        try {
            const env = { ...process.env };
            delete env.ELECTRON_RUN_AS_NODE;
            if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
                const line = [command, ...commandArgs]
                    .map(argument => '"' + String(argument).replace(/"/g, '""') + '"').join(' ');
                child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
                    cwd, windowsHide: true, env
                });
            } else {
                child = spawn(command, commandArgs, { cwd, windowsHide: true, env });
            }
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
                    if (event.type === 'session' && event.sessionId) sessionId = event.sessionId;
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

module.exports = { discoverDshCommand, reviewPrompt, extractJson, validateShaped, runDshReview };
