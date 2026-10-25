// The model the extension falls back to when the reader has not chosen one.
//
// Four contexts need that fallback — the worker's stored settings, the content script's
// settings snapshot, and the options page and side panel, each of which both shows the
// value and saves it. A fallback is only reached when a setting is absent, so a copy left
// behind after a change disagrees with the rest in a way nothing on the screen reports.
// One home is what makes that impossible rather than merely unlikely.
(function initDefaultModel(globalScope) {
  const DEFAULT_MODEL = 'gpt-5.6-luna';

  const OPENROUTER_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
  function getEffectiveModelSettings(settings = {}) {
    if (settings.service !== undefined && !['openai', 'openrouter'].includes(settings.service)) {
      throw Object.assign(new Error('Unsupported translation service.'), { code: 'settings.service_unsupported' });
    }
    const service = settings.service === 'openrouter' ? 'openrouter' : 'openai';
    return {
      service,
      model: service === 'openrouter' ? OPENROUTER_MODEL : String(settings.model || DEFAULT_MODEL),
      reasoningEffort: service === 'openrouter' ? 'none' : String(settings.reasoningEffort || 'none'),
    };
  }
  const api = { DEFAULT_MODEL, OPENROUTER_MODEL, getEffectiveModelSettings };
  globalScope.ChromeAiTranslatorDefaultModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
