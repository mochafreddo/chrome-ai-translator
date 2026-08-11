// The model the extension falls back to when the reader has not chosen one.
//
// Four contexts need that fallback — the worker's stored settings, the content script's
// settings snapshot, and the options page and side panel, each of which both shows the
// value and saves it. A fallback is only reached when a setting is absent, so a copy left
// behind after a change disagrees with the rest in a way nothing on the screen reports.
// One home is what makes that impossible rather than merely unlikely.
(function initDefaultModel(globalScope) {
  const DEFAULT_MODEL = 'gpt-5.6-luna';

  const api = { DEFAULT_MODEL };
  globalScope.ChromeAiTranslatorDefaultModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
