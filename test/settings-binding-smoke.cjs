'use strict';

/**
 * settings.js / binding.js 冒烟测试。
 *
 * 全部在 fs.mkdtemp 出来的临时仓库里跑，不碰真实仓库、不碰 Codex/Cline 用户数据。
 * 运行：node test/settings-binding-smoke.cjs
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');

const settings = require('../settings.js');
const binding = require('../binding.js');

let checks = 0;

function ok(name) {
    checks++;
    console.log('  ok  ' + name);
}

/** 断言抛错，并且错误信息是中文（必填 pattern 额外匹配）。 */
function throwsChinese(fn, pattern, label) {
    assert.throws(fn, error => {
        assert.match(error.message, /[\u4e00-\u9fa5]/, '错误信息应为中文：' + error.message);
        if (pattern) assert.match(error.message, pattern);
        return true;
    }, label);
    checks++;
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-settings-smoke-'));
const stateDir = path.join(repo, '.local-workflow');
const settingsFile = path.join(stateDir, 'settings.json');
const bindingFile = path.join(stateDir, 'binding.json');
const lockFile = path.join(stateDir, '.lock');

const remove = file => fs.rmSync(file, { force: true });
const writeJson = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const tmpLeftovers = () => fs.readdirSync(stateDir).filter(name => name.includes('.tmp'));

(async () => {
    fs.mkdirSync(stateDir, { recursive: true });
    console.log('# 路径与导出');

    assert.deepEqual({ ...settings.DEFAULT_SETTINGS },
        { maxParallel: '2', maxRepairs: 3, useClinePlan: false, initialCommit: true });
    assert.ok(Object.isFrozen(settings.DEFAULT_SETTINGS));
    assert.deepEqual([...settings.MAX_PARALLEL_VALUES], ['1', '2', '4', '8', 'unlimited']);
    assert.equal(settings.settingsPath(repo), path.join(repo, '.local-workflow', 'settings.json'));
    assert.equal(binding.bindingPath(repo), path.join(repo, '.local-workflow', 'binding.json'));
    assert.equal(binding.lockPath(repo), path.join(repo, '.local-workflow', '.lock'));
    ok('默认常量、settingsPath/bindingPath/lockPath 形状正确');

    // --- validateSettings ---------------------------------------------------
    console.log('# validateSettings');
    assert.deepEqual(settings.validateSettings({ maxParallel: '4', maxRepairs: 0 }), { maxParallel: '4', maxRepairs: 0 });
    assert.deepEqual(settings.validateSettings({}), {});
    throwsChinese(() => settings.validateSettings({ maxParallel: '3' }), /maxParallel 只能是/);
    throwsChinese(() => settings.validateSettings({ maxParallel: 4 }), /maxParallel/);
    throwsChinese(() => settings.validateSettings({ maxParallel: '' }), /maxParallel/);
    throwsChinese(() => settings.validateSettings({ maxRepairs: 11 }), /maxRepairs 必须是/);
    throwsChinese(() => settings.validateSettings({ maxRepairs: -1 }), /maxRepairs 必须是/);
    throwsChinese(() => settings.validateSettings({ maxRepairs: 1.5 }), /maxRepairs 必须是/);
    throwsChinese(() => settings.validateSettings({ maxRepairs: '3' }), /maxRepairs 必须是/);
    throwsChinese(() => settings.validateSettings({ useClinePlan: 'yes' }), /useClinePlan 必须是布尔值/);
    throwsChinese(() => settings.validateSettings({ initialCommit: 1 }), /initialCommit 必须是布尔值/);
    throwsChinese(() => settings.validateSettings({ useClineAct: true }), /未知设置项 useClineAct/);
    throwsChinese(() => settings.validateSettings(null), /设置必须是普通对象/);
    throwsChinese(() => settings.settingsPath(''), /repo 必须是非空字符串路径/);
    assert.deepEqual(settings.validateSettings({ useClinePlan: true, initialCommit: false }),
        { useClinePlan: true, initialCommit: false });
    ok('合法补丁通过，非法值/未知键/坏参数抛中文错误');

    // --- 默认值合并 ---------------------------------------------------------
    console.log('# 默认值合并');
    assert.deepEqual(settings.readSettings(repo),
        { maxParallel: '2', maxRepairs: 3, useClinePlan: false, initialCommit: true });
    assert.deepEqual(settings.readSettings(repo, { globalDefaults: { maxParallel: '4', maxRepairs: 5 } }),
        { maxParallel: '4', maxRepairs: 5, useClinePlan: false, initialCommit: true });
    // 全局配置里混着其他键（codexExecutable 等）不影响本模块。
    assert.deepEqual(settings.readSettings(repo, { globalDefaults: { maxParallel: '8', codexExecutable: 'C:\\x.exe' } }),
        { maxParallel: '8', maxRepairs: 3, useClinePlan: false, initialCommit: true });
    throwsChinese(() => settings.readSettings(repo, { globalDefaults: { maxRepairs: 99 } }), /maxRepairs 必须是/);
    throwsChinese(() => settings.readSettings(repo, { globalDefaults: { maxParallel: '6' } }), /maxParallel 只能是/);
    ok('无项目文件时按 globalDefaults + 默认值合并，全局非法值也抛错');

    // --- folder 覆盖 global ------------------------------------------------
    console.log('# folder > global > 默认值');
    writeJson(settingsFile, { maxParallel: '8' });
    assert.deepEqual(settings.readSettings(repo, { globalDefaults: { maxParallel: '4', maxRepairs: 5 } }),
        { maxParallel: '8', maxRepairs: 5, useClinePlan: false, initialCommit: true });
    assert.deepEqual(settings.resolveSettings(repo, { globalDefaults: { maxParallel: '4', maxRepairs: 5 } }),
        { maxParallel: '8', maxRepairs: 5, useClinePlan: false, initialCommit: true });
    assert.deepEqual(settings.resolveSettings(repo, { scope: 'global', globalDefaults: { maxParallel: '4', maxRepairs: 5 } }),
        { maxParallel: '4', maxRepairs: 5, useClinePlan: false, initialCommit: true });
    throwsChinese(() => settings.resolveSettings(repo, { scope: 'workspace' }), /scope 只能是/);
    ok('项目文件覆盖全局默认值，scope=global 忽略项目文件');

    // --- updateSettings：只持久化 patch ------------------------------------
    console.log('# updateSettings folder');
    remove(settingsFile);
    const folderEffective = settings.updateSettings(repo, { maxParallel: '4' },
        { globalDefaults: { maxRepairs: 7, codexExecutable: 'C:\\x.exe' } });
    assert.deepEqual(readJson(settingsFile), { maxParallel: '4' });
    assert.deepEqual(folderEffective, { maxParallel: '4', maxRepairs: 7, useClinePlan: false, initialCommit: true });
    assert.deepEqual(settings.readSettings(repo, { globalDefaults: { maxRepairs: 7 } }), folderEffective);
    assert.deepEqual(tmpLeftovers(), []);
    // 第二次补丁应增量合并，不清掉已有键。
    settings.updateSettings(repo, { useClinePlan: true });
    assert.deepEqual(readJson(settingsFile), { maxParallel: '4', useClinePlan: true });
    ok('项目文件只写 patch，原子写后读回一致，无 .tmp 残留');

    // --- updateSettings：scope=global 不写项目文件 ---------------------------
    console.log('# updateSettings global');
    remove(settingsFile);
    const globalEffective = settings.updateSettings(repo, { maxParallel: '1' },
        { scope: 'global', globalDefaults: { maxRepairs: 2 } });
    assert.equal(fs.existsSync(settingsFile), false, 'scope=global 不应创建项目设置文件');
    assert.deepEqual(globalEffective, { maxParallel: '1', maxRepairs: 2, useClinePlan: false, initialCommit: true });
    ok('scope=global 只返回合并结果，不落项目文件');

    // --- 损坏文件 -----------------------------------------------------------
    console.log('# 损坏文件');
    fs.writeFileSync(settingsFile, '{ "maxParallel": "4",', 'utf8');
    throwsChinese(() => settings.readSettings(repo), /已损坏/);
    throwsChinese(() => settings.updateSettings(repo, { maxParallel: '2' }), /已损坏/);
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ "maxParallel": "4",', '损坏文件不能被静默覆盖');
    fs.writeFileSync(settingsFile, '[]', 'utf8');
    throwsChinese(() => settings.readSettings(repo), /格式无效/);
    fs.writeFileSync(settingsFile, JSON.stringify({ maxRepairs: 99 }), 'utf8');
    throwsChinese(() => settings.readSettings(repo), /maxRepairs 必须是/);
    throwsChinese(() => settings.updateSettings(repo, { useClinePlan: true }), /maxRepairs 必须是/);
    remove(settingsFile);
    ok('损坏/格式无效/字段非法的项目设置都抛错且不被覆盖');

    // --- 绑定：读 / 写 ------------------------------------------------------
    console.log('# binding 读写');
    assert.equal(binding.readBinding(repo), null);
    throwsChinese(() => binding.assertBinding(repo, 'thread-a', 'codex'), /尚未绑定/, 'ENOBINDING');

    const codex = binding.bind(repo, { mode: 'codex', codexThreadId: 'thread-a' });
    assert.equal(codex.repo, repo);
    assert.equal(codex.mode, 'codex');
    assert.equal(codex.frontendSessionId, 'thread-a', 'codex 模式 frontendSessionId 默认等于 codexThreadId');
    assert.equal(codex.codexThreadId, 'thread-a');
    assert.ok(!Number.isNaN(Date.parse(codex.createdAt)));
    assert.ok(!Number.isNaN(Date.parse(codex.updatedAt)));
    assert.deepEqual(binding.readBinding(repo), codex);
    assert.deepEqual(binding.validateBinding(codex), codex);
    assert.deepEqual(tmpLeftovers(), []);
    ok('未绑定返回 null，bind 原子写盘并可读回');

    // --- 重复 bind / replace ------------------------------------------------
    console.log('# 重复 bind 与 replace');
    assert.throws(() => binding.bind(repo, { mode: 'codex', codexThreadId: 'thread-b' }), error => {
        assert.equal(error.code, 'EBOUND');
        assert.equal(error.binding.frontendSessionId, 'thread-a', '错误里要带现有绑定');
        assert.match(error.message, /已存在绑定/);
        return true;
    });
    assert.deepEqual(binding.readBinding(repo), codex, '拒绝覆盖时文件不应变化');
    throwsChinese(() => binding.bind(repo, { mode: 'codex', frontendSessionId: 'a', codexThreadId: 'b' }, { replace: true }),
        /必须等于/);
    throwsChinese(() => binding.bind(repo, { mode: 'plan', codexThreadId: 'x' }, { replace: true }), /mode 只能是/);
    throwsChinese(() => binding.bind(repo, { mode: 'codex' }, { replace: true }), /缺少必填字段/);

    await sleep(5);
    const cline = binding.bind(repo, { mode: 'cline', frontendSessionId: 'front-1', codexThreadId: 'thread-c' },
        { replace: true });
    assert.equal(cline.mode, 'cline');
    assert.equal(cline.frontendSessionId, 'front-1');
    assert.equal(cline.codexThreadId, 'thread-c');
    assert.equal(cline.createdAt, codex.createdAt, 'replace 保留原 createdAt');
    assert.ok(Date.parse(cline.updatedAt) > Date.parse(codex.updatedAt), 'replace 刷新 updatedAt');
    assert.deepEqual(binding.readBinding(repo), cline);
    ok('重复 bind 拒绝并带现有绑定，replace 覆盖且保留 createdAt');

    // --- validateBinding 细节 ----------------------------------------------
    console.log('# validateBinding');
    throwsChinese(() => binding.validateBinding(null), /绑定必须是普通对象/);
    throwsChinese(() => binding.validateBinding({ ...cline, mode: 'plan' }), /mode 只能是/);
    throwsChinese(() => binding.validateBinding({ ...cline, repo: '' }), /repo/);
    throwsChinese(() => binding.validateBinding({ ...cline, frontendSessionId: '' }), /frontendSessionId/);
    throwsChinese(() => binding.validateBinding({ ...cline, codexThreadId: '  ' }), /codexThreadId/);
    throwsChinese(() => binding.validateBinding({ mode: 'codex', repo: repo, frontendSessionId: 'a', codexThreadId: 'b' }),
        /必须等于/);
    throwsChinese(() => binding.validateBinding({ ...cline, createdAt: 'not-a-date' }), /createdAt 不是合法时间戳/);
    throwsChinese(() => binding.validateBinding({ ...cline, updatedAt: undefined }), /updatedAt/);
    throwsChinese(() => binding.bindingPath(''), /repo 必须是非空字符串路径/);
    ok('validateBinding 覆盖必填字段、mode、codex 相等约束、时间戳');

    // --- assertBinding ------------------------------------------------------
    console.log('# assertBinding');
    assert.deepEqual(binding.assertBinding(repo, 'front-1', 'cline'), cline);
    assert.throws(() => binding.assertBinding(repo, 'front-2', 'cline'), error => {
        assert.equal(error.code, 'ESESSION');
        return true;
    });
    assert.throws(() => binding.assertBinding(repo, 'front-1', 'codex'), error => {
        assert.equal(error.code, 'EMODE');
        return true;
    });
    ok('assertBinding 放行匹配绑定，会话/模式不符分别抛 ESESSION / EMODE');

    // --- unbind -------------------------------------------------------------
    console.log('# unbind');
    fs.writeFileSync(bindingFile, JSON.stringify(cline), 'utf8');
    assert.throws(() => binding.unbind(repo, { expectedSessionId: 'front-2' }), error => {
        assert.equal(error.code, 'ESESSION');
        assert.equal(error.binding.frontendSessionId, 'front-1');
        return true;
    });
    assert.deepEqual(binding.readBinding(repo), cline, 'expectedSessionId 不符时不能动文件');
    assert.deepEqual(binding.unbind(repo, { expectedSessionId: 'front-1' }), cline);
    assert.equal(fs.existsSync(bindingFile), false);
    assert.equal(binding.readBinding(repo), null);
    assert.equal(binding.unbind(repo), null);
    assert.equal(binding.unbind(repo, { expectedSessionId: 'front-1' }), null);
    ok('unbind 校验 expectedSessionId，返回旧绑定，重复解绑返回 null');

    // --- 损坏的绑定文件 -----------------------------------------------------
    console.log('# 损坏的绑定文件');
    fs.writeFileSync(bindingFile, '{ nope', 'utf8');
    throwsChinese(() => binding.readBinding(repo), /绑定文件已损坏/);
    throwsChinese(() => binding.assertBinding(repo, 'x', 'codex'), /绑定文件已损坏/);
    fs.writeFileSync(bindingFile, JSON.stringify({ repo, mode: 'codex' }), 'utf8');
    throwsChinese(() => binding.assertBinding(repo, 'x', 'codex'), /缺少必填字段/);
    remove(bindingFile);
    ok('损坏/缺字段的绑定抛错，不被当成未绑定');

    // --- withRepoLock：并发串行 --------------------------------------------
    console.log('# withRepoLock 并发串行');
    const order = [];
    let active = 0;
    let peak = 0;
    const worker = index => binding.withRepoLock(repo, async () => {
        active++;
        peak = Math.max(peak, active);
        order.push('enter' + index);
        await sleep(30);
        order.push('leave' + index);
        active--;
    });
    await Promise.all([1, 2, 3].map(worker));
    assert.equal(peak, 1, '同一时刻只能有一个临界区');
    assert.equal(order.length, 6);
    // enter/leave 必须成对相邻，证明没有交错。
    for (let i = 0; i < order.length; i += 2) {
        assert.equal(order[i].replace('enter', ''), order[i + 1].replace('leave', ''));
    }
    assert.deepEqual(new Set(order.map(entry => entry.replace(/^(enter|leave)/, ''))), new Set(['1', '2', '3']));
    assert.equal(fs.existsSync(lockFile), false, '临界区结束后应释放锁');
    assert.equal(await binding.withRepoLock(repo, async () => 42), 42, '返回值应透传');
    ok('async 临界区严格串行、返回值透传、结束后释放锁');

    // --- 锁文件内容与异常释放 ----------------------------------------------
    console.log('# 锁文件内容 / 异常释放');
    let observed = null;
    await binding.withRepoLock(repo, async function critical() {
        observed = readJson(lockFile);
    });
    assert.equal(observed.pid, process.pid);
    assert.equal(observed.reason, 'local-workflow:critical');
    assert.ok(!Number.isNaN(Date.parse(observed.createdAt)));
    await assert.rejects(binding.withRepoLock(repo, async () => { throw new Error('boom'); }), /boom/);
    assert.equal(fs.existsSync(lockFile), false, '抛错也要释放锁');
    await assert.rejects(binding.withRepoLock(repo, null), /必须是函数/);
    throwsChinese(() => binding.lockPath(''), /repo 必须是非空字符串路径/);
    ok('锁内容为 {pid, createdAt, reason}，抛错时 finally 释放');

    // --- withRepoLock：超时 ------------------------------------------------
    console.log('# withRepoLock 超时');
    writeJson(lockFile, { pid: 999999, createdAt: new Date().toISOString(), reason: 'other-process' });
    const started = Date.now();
    await assert.rejects(
        binding.withRepoLock(repo, async () => 'never', { timeoutMs: 120 }),
        error => {
            assert.equal(error.code, 'ELOCKTIMEOUT');
            assert.match(error.message, /超时|等待仓库锁超时/);
            assert.match(error.message, /other-process/);
            return true;
        });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100 && elapsed < 2000, '超时时长约等于 timeoutMs，实际 ' + elapsed + 'ms');
    assert.equal(fs.existsSync(lockFile), true, '超时不应删除别人的锁');
    remove(lockFile);
    ok('未过期的他人锁会让等待超时（' + elapsed + 'ms）并保留对方锁文件');

    // --- withRepoLock：过期锁回收 ------------------------------------------
    console.log('# withRepoLock 过期锁回收');
    writeJson(lockFile, { pid: 999999, createdAt: new Date('2020-01-01T00:00:00.000Z').toISOString(), reason: 'crashed' });
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    let ran = false;
    await binding.withRepoLock(repo, async () => { ran = true; }, { timeoutMs: 2000, staleMs: 60000 });
    assert.equal(ran, true, '过期锁应被抢占并继续执行');
    assert.equal(fs.existsSync(lockFile), false);
    ok('超过 staleMs 的锁被回收，等待者继续执行');

    // --- withRepoLock：同进程嵌套自锁 --------------------------------------
    console.log('# withRepoLock 嵌套检测');
    let nested = null;
    let nestedElapsed = 0;
    await binding.withRepoLock(repo, async () => {
        const begin = Date.now();
        try {
            await binding.withRepoLock(repo, async () => 'inner', { timeoutMs: 5000 });
        } catch (error) {
            nested = error;
            nestedElapsed = Date.now() - begin;
        }
    });
    assert.ok(nested, '嵌套取锁必须失败');
    assert.equal(nested.code, 'EDEADLOCK');
    assert.match(nested.message, /自锁/);
    assert.ok(nestedElapsed < 1000, '嵌套应立刻失败而不是等到超时，实际 ' + nestedElapsed + 'ms');
    assert.equal(fs.existsSync(lockFile), false);
    ok('同进程嵌套取锁立刻抛 EDEADLOCK（' + nestedElapsed + 'ms）');

    // --- 边界：非法数值不会死等 ---------------------------------------------
    console.log('# 边界参数');
    // timeoutMs=0 时只尝试一次就应抛错（不会卡住）。
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 424242, createdAt: new Date().toISOString(), reason: 'zero' }), 'utf8');
    await assert.rejects(binding.withRepoLock(repo, async () => 'never', { timeoutMs: 0 }),
        /等待仓库锁超时/);
    remove(lockFile);
    // timeoutMs=NaN 会退回安全默认值；staleMs=0 被夹回 60000，因此过期锁仍会被回收。
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 424242, createdAt: '2020-01-01T00:00:00.000Z', reason: 'nan' }), 'utf8');
    const veryOld = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, veryOld, veryOld);
    assert.equal(await binding.withRepoLock(repo, async () => 'ok', { timeoutMs: Number.NaN, staleMs: 0 }), 'ok');
    assert.equal(fs.existsSync(lockFile), false);
    throwsChinese(() => settings.updateSettings(repo, { maxParallel: '4' }, { scope: 'nope' }), /scope 只能是/);
    ok('timeoutMs=0 立刻超时，NaN/0 参数被夹到安全默认值');

    console.log('\nsettings/binding smoke ok（' + checks + ' 项检查）');
})().catch(error => {
    console.error('\nFAILED: ' + error.message);
    if (error.stack) console.error(error.stack);
    process.exitCode = 1;
}).finally(() => {
    try {
        fs.rmSync(repo, { recursive: true, force: true });
    } catch {
        /* 临时目录清理失败不影响结论。 */
    }
});
