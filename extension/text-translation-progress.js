(function initTextTranslationProgress(globalScope) {
  const { MAX_SETTING_LENGTH, SETTINGS_KEYS, normalizeSettings, splitSource } =
    globalScope.ChromeAiTranslatorTextTranslationRequest || require('./text-translation-request.js');

  function createJob({ source, settings, units, results, status }) {
    function matchesInput(currentSource, currentSettings) {
      return source === currentSource && Boolean(currentSettings) &&
        SETTINGS_KEYS.every(key => settings[key] === currentSettings[key]);
    }

    function canResume(currentSource, currentSettings) {
      return (status === 'stopped' || status === 'failed') && matchesInput(currentSource, currentSettings);
    }

    return {
      source,
      settings,
      matchesInput,
      canResume,
      resume(currentSource, currentSettings) {
        if (!canResume(currentSource, currentSettings)) return false;
        status = 'running';
        return true;
      },
      stop() { status = 'stopped'; },
      fail() { status = 'failed'; },
      append(result) {
        results.push(result);
        if (results.length === units.length) status = 'complete';
      },
      get nextPart() { return units[results.length]; },
      get completedParts() { return results.length; },
      get totalParts() { return units.length; },
      get isComplete() { return status === 'complete'; },
      get translation() { return results.map(result => result.translation).join(''); },
      get detectedSourceLanguage() {
        const languages = results.filter((_result, index) => units[index].trim()).map(result => result.sourceLanguage);
        return languages[0] && languages.every(language => language === languages[0]) ? languages[0] : null;
      },
      snapshot() { return { source, settings, units, results: [...results], status }; },
    };
  }

  function startJob(source, settings) {
    return createJob({ source, settings, units: splitSource(source), results: [], status: 'running' });
  }

  function readJob(saved, interrupted) {
    const source = saved.source;
    const units = splitSource(source);
    if (!Array.isArray(saved.units) || JSON.stringify(saved.units) !== JSON.stringify(units) ||
        !Array.isArray(saved.results) || saved.results.length > units.length ||
        !['running', 'stopped', 'failed', 'complete'].includes(saved.status) ||
        (saved.status === 'complete' && saved.results.length !== units.length)) {
      throw new Error('Invalid retained progress.');
    }
    const results = saved.results.map(result => {
      if (typeof result?.translation !== 'string' || !(result.sourceLanguage === null ||
          (typeof result.sourceLanguage === 'string' && result.sourceLanguage.length <= 200))) {
        throw new Error('Invalid retained result.');
      }
      return { translation: result.translation, sourceLanguage: result.sourceLanguage };
    });
    let status = saved.status;
    if (results.length === units.length) {
      status = 'complete';
    } else if (interrupted && status === 'running') {
      status = 'stopped';
    }
    return createJob({ source, settings: normalizeSettings(saved.settings), units, results, status });
  }

  function readRetainedState(value, { interrupted = false } = {}) {
    if (!value || typeof value.source !== 'string') throw new Error('Invalid retained translation.');
    const settings = {};
    for (const key of SETTINGS_KEYS) {
      if (typeof value.settings?.[key] !== 'string' || value.settings[key].length > MAX_SETTING_LENGTH) {
        throw new Error('Invalid retained settings.');
      }
      settings[key] = value.settings[key];
    }
    if (typeof value.openaiModel !== 'string' || value.openaiModel.length > MAX_SETTING_LENGTH ||
        typeof value.openaiReasoningEffort !== 'string' || value.openaiReasoningEffort.length > MAX_SETTING_LENGTH) {
      throw new Error('Invalid retained preferences.');
    }
    const job = value.job ? readJob(value.job, interrupted) : null;
    return { source: value.source, settings, openaiModel: value.openaiModel,
      openaiReasoningEffort: value.openaiReasoningEffort, job };
  }

  function serializeRetainedState(value, options) {
    const state = readRetainedState(value, options);
    return { ...state, job: state.job?.snapshot() ?? null };
  }

  const api = { startJob, readRetainedState, serializeRetainedState };
  globalScope.ChromeAiTranslatorTextTranslationProgress = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
