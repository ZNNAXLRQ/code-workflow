'use strict';

/**
 * Cline stores `actModeReasoningEffort` / `planModeReasoningEffort` as shared
 * fields across providers. Ollama has no such shared control: its Responses
 * API rejects assistant reasoning parts, so only an effort explicitly stored on
 * the Ollama provider profile may be used. Other providers keep the shared
 * precedence they had before.
 */
function effortForProvider({ provider, sharedEffort, modeEffort, profileEffort } = {}) {
    if (provider === 'ollama') return profileEffort || undefined;
    return sharedEffort || modeEffort || profileEffort || undefined;
}

module.exports = { effortForProvider };
