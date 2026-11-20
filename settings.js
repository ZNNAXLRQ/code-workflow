'use strict';

/**
 * 项目级行为设置。
 *
 * 纯 CommonJS，不 require('vscode')，可直接在 Node 里做冒烟测试。
 * 落盘位置：<repo>/.local-workflow/settings.json
 *
 * 约定：
 * - 项目文件只保存“项目覆盖项”，绝不把 VS Code 全局默认值抄进去；
 * - 有效值优先级：项目文件 > globalDefaults（VS Code 全局配置）> DEFAULT_SETTINGS；
 * - 文件损坏、字段非法都直接抛中文错误，不静默回退默认值，避免把用户配置悄悄改坏；
 * - 读改写用同步 API：settings.json 只有几百字节，同步读写可以避免异步
 *   read-modify-write 交错（同一进程内 updateSettings 天然是一次原子 RMW）；
 * - 写盘走同目录 tmp 文件 + rename，Windows 上 rename 覆盖目标文件是原子的。
 */

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/** maxParallel 的合法取值（字符串，便于直接对应 VS Code 枚举配置）。 */
const MAX_PARALLEL_VALUES = Object.freeze(['1', '2', '4', '8', 'unlimited']);

/** maxRepairs 的取值范围（闭区间）。 */
const MAX_REPAIRS_MIN = 0;
const MAX_REPAIRS_MAX = 10;

/**
 * 默认设置。
 * 与现有 package.json 里的 VS Code 默认值保持一致，但这里不再依赖 vscode 配置。
 */
const DEFAULT_SETTINGS = Object.freeze({
    maxParallel: '2',
    maxRepairs: 3,
    useDshFrontend: false,
    dshSessionId: '',
    reviewCodex: true,
    reviewDsh: false,
    initialCommit: false
});

/** 由本模块管理的设置项；其他键（如 useClineAct）不归这里管。 */
const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));

const MAX_PARALLEL_SET = new Set(MAX_PARALLEL_VALUES);

/** 把任意值渲染成可读文本，用于中文错误信息。 */
function describe(value) {
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return JSON.stringify(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

/** 校验 repo 参数：必须是非空字符串路径；返回规范化后的绝对路径。 */
function repositoryRoot(repo) {
    if (typeof repo !== 'string' || !repo.trim()) {
        throw new Error('repo 必须是非空字符串路径');
    }
    return path.resolve(repo.trim());
}

/** <repo>/.local-workflow/settings.json。 */
function settingsPath(repo) {
    return path.join(repositoryRoot(repo), '.local-workflow', 'settings.json');
}

/** 单个字段的类型/取值校验；label 用于在错误信息里标明来源（项目文件 / globalDefaults）。 */
function validateField(key, value, label) {
    const where = label ? label + '：' : '';
    switch (key) {
        case 'maxParallel':
            if (typeof value !== 'string' || !MAX_PARALLEL_SET.has(value)) {
                throw new Error(where + 'maxParallel 只能是 ' + MAX_PARALLEL_VALUES.join('、') +
                    '，收到 ' + describe(value));
            }
            return;
        case 'maxRepairs':
            if (!Number.isInteger(value) || value < MAX_REPAIRS_MIN || value > MAX_REPAIRS_MAX) {
                throw new Error(where + 'maxRepairs 必须是 ' + MAX_REPAIRS_MIN + ' 到 ' + MAX_REPAIRS_MAX +
                    ' 之间的整数，收到 ' + describe(value));
            }
            return;
        case 'useClinePlan':
        case 'useDshFrontend':
        case 'reviewCodex':
        case 'reviewDsh':
        case 'initialCommit':
            if (typeof value !== 'boolean') {
                throw new Error(where + key + ' 必须是布尔值，收到 ' + describe(value));
            }
            return;
        case 'dshSessionId':
            if (typeof value !== 'string') {
                throw new Error(where + 'dshSessionId 必须是字符串，收到 ' + describe(value));
            }
            return;
        default:
            throw new Error(where + '未知设置项 ' + key);
    }
}

/**
 * 校验一段设置补丁：只接受本模块的 4 个键，未知键也视为错误（防手滑写错键名）。
 * 非法值抛中文错误；合法时原样返回 patch。
 */
function validateSettings(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        throw new Error('设置必须是普通对象，收到 ' + describe(patch));
    }
    for (const key of Object.keys(patch)) {
        if (!SETTINGS_KEYS.includes(key)) {
            throw new Error('未知设置项 ' + key + '，可用项：' + SETTINGS_KEYS.join('、'));
        }
        if (patch[key] === undefined) continue;
        validateField(key, patch[key]);
    }
    if (patch.reviewCodex === false && patch.reviewDsh === false) {
        throw new Error('至少开启一种审查：Codex 复审或 DSH 自审。');
    }
    return patch;
}

/**
 * 从任意对象里挑出本模块管理的键并校验。
 * 未提供的键直接跳过；未知键忽略（globalDefaults 里可能混着 codexExecutable 等
 * 其他 VS Code 配置，不能因此报错）。
 */
function pickSettings(value, label) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) {
        throw new Error((label ? label + '：' : '') + '设置必须是普通对象，收到 ' + describe(value));
    }
    const picked = {};
    for (const key of SETTINGS_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (value[key] === undefined) continue;
        validateField(key, value[key], label);
        picked[key] = value[key];
    }
    return picked;
}

/** 项目的默认值基线：DEFAULT_SETTINGS 叠加 globalDefaults（只取本模块管理的键）。 */
function baseline(globalDefaults) {
    return { ...DEFAULT_SETTINGS, ...pickSettings(globalDefaults, 'globalDefaults') };
}

function requireReviewSelection(settings, where) {
    if (!settings.reviewCodex && !settings.reviewDsh) {
        throw new Error(where + '至少开启一种审查：Codex 复审或 DSH 自审。');
    }
    return settings;
}

/**
 * 读取并把项目文件解析成原始对象。
 * 不存在返回 null；损坏 / 非对象直接抛中文错误（不静默吞掉）。
 */
function readRawSettings(repo) {
    const file = settingsPath(repo);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('读取项目设置失败：' + file + '（' + error.message + '）');
    }
    let data;
    try {
        data = JSON.parse(text);
    } catch (error) {
        throw new Error('项目设置文件已损坏，无法解析：' + file + '（' + error.message + '）');
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('项目设置文件格式无效（应为 JSON 对象）：' + file);
    }
    return data;
}

/** 同目录 tmp + rename 原子写入。 */
function writeJsonAtomic(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
        fs.writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n', 'utf8');
        fs.renameSync(temporary, file);
    } catch (error) {
        try {
            fs.rmSync(temporary, { force: true });
        } catch {
            /* 清理失败不影响错误上报：残留 .tmp 不会覆盖正式文件。 */
        }
        throw new Error('写入项目设置失败：' + file + '（' + error.message + '）');
    }
}

/**
 * 读取有效设置。
 * 项目文件不存在时返回 globalDefaults + DEFAULT_SETTINGS 的合并结果；
 * 文件损坏、字段非法都抛错。
 *
 * @param {string} repo 仓库根目录
 * @param {{globalDefaults?: object}} [options]
 * @returns {{maxParallel: string, maxRepairs: number, useClinePlan: boolean, initialCommit: boolean}}
 */
function readSettings(repo, { globalDefaults } = {}) {
    const raw = readRawSettings(repo);
    const fileValues = raw === null
        ? {}
        : pickSettings(raw, '项目设置 ' + settingsPath(repo));
    return requireReviewSelection({ ...baseline(globalDefaults), ...fileValues }, '项目设置：');
}

/**
 * 更新设置。
 *
 * - scope='folder'（默认）：只把 patch 合并进项目文件并原子写盘（不写 globalDefaults），
 *   返回合并后的有效设置；
 * - scope='global'：不碰项目文件，返回 patch 合并到 globalDefaults 上的结果，
 *   由调用方自己写 VS Code 全局配置。
 *
 * 非法 patch 抛错；项目文件本来损坏时也抛错，且不会覆盖坏文件（避免丢用户数据）。
 *
 * @param {string} repo 仓库根目录
 * @param {object} patch 要写入的覆盖项（只允许 4 个已知键）
 * @param {{scope?: 'folder'|'global', globalDefaults?: object}} [options]
 */
function updateSettings(repo, patch, { scope = 'folder', globalDefaults } = {}) {
    validateSettings(patch);
    if (scope !== 'folder' && scope !== 'global') {
        throw new Error("scope 只能是 'folder' 或 'global'，收到 " + describe(scope));
    }
    const defaults = baseline(globalDefaults);
    if (scope === 'global') {
        return requireReviewSelection({ ...defaults, ...patch }, '全局设置：');
    }
    const file = settingsPath(repo);
    const existing = readRawSettings(repo) ?? {};
    // 保留文件里已有的（包含不属于本模块的）键，只覆盖 patch 里的键。
    const merged = { ...existing, ...patch };
    // 手改出来的非法值可能在合并后仍然存在，写盘前必须拦住，避免固化坏配置。
    const mergedKnown = pickSettings(merged, '项目设置 ' + file);
    requireReviewSelection({ ...defaults, ...mergedKnown }, '项目设置：');
    writeJsonAtomic(file, merged);
    return { ...defaults, ...mergedKnown };
}

/**
 * 解析有效设置，显式表达优先级。
 * scope='folder'：项目文件 > globalDefaults > 默认值；
 * scope='global'：忽略项目文件，只算 globalDefaults > 默认值。
 *
 * @param {string} repo 仓库根目录
 * @param {{globalDefaults?: object, scope?: 'folder'|'global'}} [options]
 */
function resolveSettings(repo, { globalDefaults, scope = 'folder' } = {}) {
    // 即使 scope=global 也校验 repo，尽早暴露调用方的路径错误。
    repositoryRoot(repo);
    if (scope === 'global') return requireReviewSelection(baseline(globalDefaults), '全局设置：');
    if (scope !== 'folder') {
        throw new Error("scope 只能是 'folder' 或 'global'，收到 " + describe(scope));
    }
    return readSettings(repo, { globalDefaults });
}

module.exports = {
    DEFAULT_SETTINGS,
    MAX_PARALLEL_VALUES,
    SETTINGS_KEYS,
    settingsPath,
    validateSettings,
    readSettings,
    updateSettings,
    resolveSettings
};
