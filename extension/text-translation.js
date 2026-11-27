(function initTextTranslationPage() {
  const contract = globalThis.ChromeAiTranslatorTextTranslationRequest;
  const { startJob, readRetainedState } = globalThis.ChromeAiTranslatorTextTranslationProgress;
  const { DEFAULT_MODEL, OPENROUTER_MODEL } = globalThis.ChromeAiTranslatorDefaultModel;
  const { getTargetLanguageCode } = globalThis.ChromeAiTranslatorTranslationSettings;
  const get = id => document.getElementById(id);
  const draftFields = { sourceLanguage: 'auto', targetLanguage: 'Korean', model: DEFAULT_MODEL };
  let ready = false;
  let composing = false;
  let active = null;
  let job = null;
  let openaiModel = '';
  let openaiReasoningEffort = 'none';
  let selectedService = 'openai';
  let revision = 0;
  let departed = false;

  async function retain(clear = false) {
    if (!ready || departed) return;
    rememberOpenai();
    const settings = readInputSettings();
    for (const key of Object.keys(draftFields)) {
      if (settings[key].length > contract.MAX_SETTING_LENGTH) settings[key] = draftFields[key];
    }
    const retainedModel = openaiModel.length > contract.MAX_SETTING_LENGTH ? draftFields.model : openaiModel;
    const response = await chrome.runtime.sendMessage({
      type: clear ? 'CLEAR_TEXT_TRANSLATION_STATE' : 'SAVE_TEXT_TRANSLATION_STATE', revision: ++revision,
      ...(clear ? {} : { state: { source: get('sourceText').value, settings, openaiModel: retainedModel, openaiReasoningEffort, job: job?.snapshot() ?? null } }),
    });
    if (!response?.ok) throw new Error('Could not retain this translation. Keep this tab open and try again.');
  }

  function retainInBackground(clear = false) {
    const write = retain(clear);
    const submittedRevision = revision;
    void write.catch(error => {
      if (!departed && revision === submittedRevision) {
        showError(clear ? new Error('The previous draft is still saved. Select Clear all again to delete it.') : error);
      }
    });
  }

  function showError(error) {
    get('errorBox').textContent = error?.message || 'Text Translation failed. Try again.';
    get('errorBox').hidden = false;
  }

  function renderBusy() {
    const source = get('sourceText').value;
    let settings;
    if (job && source === job.source) {
      try { settings = readSettings(); } catch {}
    }
    get('translationSettings').disabled = !ready || Boolean(active);
    get('sourceText').disabled = !ready || Boolean(active);
    get('btnTranslate').disabled = !ready || Boolean(active);
    get('btnStop').disabled = !active;
    get('btnClear').disabled = !ready;
    get('btnResume').disabled = !ready || Boolean(active) ||
      !job?.canResume(source, settings);
    get('btnSwap').disabled = !ready || Boolean(active) || !job?.isComplete;
    get('btnCopy').disabled = !get('translatedText').value;
    get('resultRelationship').textContent = job?.completedParts && !job.matchesInput(source, settings)
      ? 'This translation belongs to previous text or settings.' : '';
    applyContentLanguages();
  }

  function applyContentLanguages() {
    const choice = get('sourceLanguage').value.trim();
    let sourceLanguage = '';
    if (get('sourceText').value) {
      if (choice === 'auto') {
        if (job && get('sourceText').value === job.source) {
          const detected = job.detectedSourceLanguage;
          if (detected) sourceLanguage = getTargetLanguageCode(detected);
        }
      } else sourceLanguage = getTargetLanguageCode(choice);
    }
    get('sourceText').lang = sourceLanguage;
    get('translatedText').lang = job && get('translatedText').value
      ? getTargetLanguageCode(job.settings.targetLanguage) : '';
  }

  function renderJob() {
    get('translatedText').value = job?.translation ?? '';
    get('progressStatus').textContent = job
      ? `${job.completedParts} of ${job.totalParts} parts complete.${job.isComplete ? '' : ' Incomplete translation.'}` : '';
    if (job?.completedParts) {
      const detected = job.detectedSourceLanguage;
      get('languageStatus').textContent = job.settings.sourceLanguage === 'auto'
        ? detected ? `Detected source language: ${detected}` : 'Source language is uncertain.'
        : `Source language: ${job.settings.sourceLanguage}`;
    } else get('languageStatus').textContent = '';
    renderBusy();
  }

  function inputChanged() {
    get('errorBox').hidden = true;
    for (const key of Object.keys(draftFields)) {
      const field = get(key);
      const tooLong = field.value.length > contract.MAX_SETTING_LENGTH;
      field.ariaInvalid = String(tooLong);
      const hint = get(key + 'Error');
      hint.hidden = !tooLong;
      hint.textContent = tooLong ? `Use at most ${contract.MAX_SETTING_LENGTH} characters.` : '';
      if (!tooLong && field.value.trim() && (key !== 'model' || selectedService === 'openai')) {
        draftFields[key] = field.value;
      }
    }
    get('inputHint').textContent = `${Array.from(get('sourceText').value).length.toLocaleString('en-US')} / ${contract.MAX_SOURCE_CHARACTERS.toLocaleString('en-US')} Unicode characters (code points). Plain text only.`;
    renderBusy();
    retainInBackground();
  }

  function swap() {
    if (!ready || active || !job?.isComplete) return;
    let sourceLanguage = job.settings.sourceLanguage !== 'auto' ? job.settings.sourceLanguage : job.detectedSourceLanguage;
    if (!sourceLanguage) {
      try {
        sourceLanguage = contract.normalizeSettings({ ...job.settings, sourceLanguage: get('sourceLanguage').value }).sourceLanguage;
      } catch {}
    }
    if (!sourceLanguage || sourceLanguage === 'auto') {
      showError(new Error('Choose the source language before swapping.'));
      get('sourceLanguage').focus();
      return;
    }
    get('sourceText').value = job.translation;
    get('sourceLanguage').value = job.settings.targetLanguage;
    get('targetLanguage').value = sourceLanguage;
    inputChanged();
  }

  function rememberOpenai() {
    if (selectedService === 'openai') {
      openaiModel = get('model').value;
      openaiReasoningEffort = get('reasoningEffort').value;
    }
  }

  function displayService() {
    const openrouter = selectedService === 'openrouter';
    get('model').value = openrouter ? OPENROUTER_MODEL : openaiModel;
    get('model').readOnly = openrouter;
    get('reasoningEffort').value = openrouter ? 'none' : openaiReasoningEffort;
    get('reasoningEffort').disabled = openrouter;
  }

  function readInputSettings() {
    return Object.fromEntries(contract.SETTINGS_KEYS.map(key => [key, get(key).value]));
  }

  function readSettings() {
    return contract.normalizeSettings(readInputSettings());
  }

  function cancelActiveTranslation() {
    const operation = active;
    if (!operation) return null;
    active = null;
    void chrome.runtime.sendMessage({ type: 'STOP_TEXT_TRANSLATION', operationId: operation.id }).catch(() => {});
    return operation;
  }

  function stop() {
    const operation = cancelActiveTranslation();
    if (operation) {
      operation.job.stop();
      get('status').textContent = 'Stopped.';
    }
    renderJob();
    retainInBackground();
  }

  async function translate(resume = false) {
    if (!ready || active || composing) return;
    get('errorBox').hidden = true;
    let source;
    let settings;
    try {
      source = contract.validateSource(get('sourceText').value);
      settings = readSettings();
    } catch (error) {
      showError(error);
      return;
    }
    if (resume && !job?.resume(source, settings)) {
      showError(new Error('Source or translation settings changed. Start a new translation.'));
      return;
    }
    if (!resume) job = startJob(source, settings);
    const operation = { id: crypto.randomUUID(), job };
    active = operation;
    get('status').textContent = 'Translating…';
    renderJob();
    try {
      await retain();
      for (let part = operation.job.nextPart; part !== undefined; part = operation.job.nextPart) {
        if (active !== operation) return;
        let result = { translation: part, sourceLanguage: null };
        if (part.trim()) {
          const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT',
            operationId: operation.id, source: part, settings: operation.job.settings });
          if (!response?.ok) throw new Error(response?.error?.message || 'Text Translation failed. Try again.');
          result = response.result;
        }
        if (active !== operation) return;
        operation.job.append(result);
        if (operation.job.isComplete) break;
        renderJob();
        await retain();
      }
      if (active !== operation) return;
      get('status').textContent = 'Translation complete.';
    } catch (error) {
      if (active === operation) {
        operation.job.fail();
        get('status').textContent = 'Translation failed.';
        showError(error);
      }
    } finally {
      if (active === operation) {
        active = null;
        renderJob();
        retainInBackground();
      }
    }
  }

  get('translationForm').addEventListener('submit', event => {
    event.preventDefault();
    void translate();
  });
  document.addEventListener('compositionstart', () => { composing = true; });
  document.addEventListener('compositionend', () => { composing = false; });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (!(event.metaKey || event.ctrlKey)) {
      if (event.target?.tagName === 'INPUT' && event.target.type === 'text') event.preventDefault();
      return;
    }
    event.preventDefault();
    void translate();
  });
  get('service').addEventListener('change', () => {
    rememberOpenai();
    selectedService = get('service').value;
    displayService();
    retainInBackground();
  });
  get('sourceText').addEventListener('input', inputChanged);
  get('translationSettings').addEventListener('input', inputChanged);
  get('translationSettings').addEventListener('change', inputChanged);
  get('btnStop').addEventListener('click', stop);
  get('btnResume').addEventListener('click', () => { void translate(true); });
  get('btnSwap').addEventListener('click', swap);
  get('btnClear').addEventListener('click', () => {
    if (!ready) return;
    cancelActiveTranslation();
    job = null;
    get('sourceText').value = '';
    get('translatedText').value = '';
    get('languageStatus').textContent = '';
    get('status').textContent = '';
    get('errorBox').hidden = true;
    get('inputHint').textContent = `0 / ${contract.MAX_SOURCE_CHARACTERS.toLocaleString('en-US')} Unicode characters (code points). Plain text only.`;
    retainInBackground(true);
    renderJob();
    get('sourceText').focus();
  });
  get('btnCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(get('translatedText').value);
      get('status').textContent = 'Copied.';
    } catch {
      showError(new Error('Copy failed. Select the translation and copy it manually.'));
    }
  });
  get('btnSaveDefaults').addEventListener('click', async () => {
    if (!ready || active) return;
    get('errorBox').hidden = true;
    try {
      const settings = readSettings();
      rememberOpenai();
      const response = await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
        service: settings.service, model: openaiModel, reasoningEffort: openaiReasoningEffort,
        targetLanguage: settings.targetLanguage, tone: settings.tone,
      } });
      if (!response?.ok) throw new Error('Could not save defaults. Try again.');
      get('status').textContent = 'Defaults saved.';
    } catch (error) { showError(error); }
  });
  window.addEventListener('pagehide', () => {
    departed = true;
    cancelActiveTranslation();
  });
  inputChanged();
  void (async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (!response?.ok) throw new Error('Could not load settings. Reload this page to try again.');
      const settings = response.settings;
      selectedService = settings.service;
      openaiModel = settings.model;
      openaiReasoningEffort = settings.reasoningEffort;
      get('service').value = selectedService;
      get('targetLanguage').value = settings.targetLanguage;
      get('tone').value = settings.tone;
      displayService();
      const retained = await chrome.runtime.sendMessage({ type: 'GET_TEXT_TRANSLATION_STATE' });
      if (!retained?.ok) throw new Error('Could not restore this translation. Reload this page to try again.');
      if (retained.state) {
        const state = readRetainedState(retained.state);
        for (const [key, value] of Object.entries(state.settings)) {
          get(key).value = value;
        }
        get('sourceText').value = state.source;
        selectedService = state.settings.service;
        openaiModel = state.openaiModel;
        openaiReasoningEffort = state.openaiReasoningEffort;
        job = state.job;
        displayService();
      }
      if (openaiModel.trim() && openaiModel.length <= contract.MAX_SETTING_LENGTH) draftFields.model = openaiModel;
      inputChanged();
      ready = true;
      renderJob();
    } catch (error) { showError(error); }
  })();
})();
