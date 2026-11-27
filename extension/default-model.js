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
  const SERVICE_FAILURE_MESSAGES = Object.freeze({
    'openai.authentication': 'OpenAI authentication failed. Check its API key in Options.',
    'openai.access': 'OpenAI refused access to this request.',
    'openai.model': 'OpenAI could not serve the selected model.',
    'openai.rate_limit': 'OpenAI rate limit or usage limit reached. Check your account or try again later.',
    'openai.unavailable': 'OpenAI is temporarily unavailable. Try again later.',
    'openai.transport': 'OpenAI request could not reach the service.',
    'openai.request': 'OpenAI request failed. Try again later.',
    'openrouter.authentication': 'OpenRouter authentication failed. Check its API key in Options.',
    'openrouter.credits': 'OpenRouter has insufficient credits. Check your OpenRouter account.',
    'openrouter.access': 'OpenRouter refused access to this request.',
    'openrouter.model': 'OpenRouter could not serve the pinned model.',
    'openrouter.rate_limit': 'OpenRouter rate limit reached. Try again later.',
    'openrouter.unavailable': 'OpenRouter has no available endpoint meeting the required model and data policy.',
    'openrouter.transport': 'OpenRouter request could not reach the service.',
    'openrouter.request': 'OpenRouter request failed. Try again later.',
  });

  function getServiceFailureMessage(service, code) {
    if (typeof code === 'string' && code.startsWith(service + '.') && Object.hasOwn(SERVICE_FAILURE_MESSAGES, code)) {
      return SERVICE_FAILURE_MESSAGES[code];
    }
    return /^(?:response|protocol)\./.test(String(code || ''))
      ? `${service === 'openrouter' ? 'OpenRouter' : 'OpenAI'} returned an invalid or incomplete translation response.` : '';
  }

  const api = { DEFAULT_MODEL, OPENROUTER_MODEL, getEffectiveModelSettings, getServiceFailureMessage };
  globalScope.ChromeAiTranslatorDefaultModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
