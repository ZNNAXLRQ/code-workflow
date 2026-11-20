const assert = require('node:assert/strict');
const { effortForProvider } = require('../cline-preferences');

assert.equal(effortForProvider({
    provider: 'ollama', sharedEffort: 'high', modeEffort: 'high', profileEffort: undefined
}), undefined, 'Ollama 必须忽略共享的 actModeReasoningEffort');
assert.equal(effortForProvider({
    provider: 'ollama', sharedEffort: 'high', modeEffort: 'medium', profileEffort: 'low'
}), 'low', 'Ollama 只使用 provider profile 的显式推理强度');
assert.equal(effortForProvider({
    provider: 'deepseek', sharedEffort: 'high', modeEffort: 'medium', profileEffort: 'low'
}), 'high', 'DeepSeek 继续使用共享推理强度');
assert.equal(effortForProvider({
    provider: 'deepseek', sharedEffort: '', modeEffort: 'medium', profileEffort: undefined
}), 'medium', '非 Ollama 保留 mode 级回退');
console.log('cline preferences smoke passed');
