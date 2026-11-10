(function initTextTranslationPage() {
  const contract = globalThis.ChromeAiTranslatorTextTranslationRequest;
  const { OPENROUTER_MODEL } = globalThis.ChromeAiTranslatorDefaultModel;
  const get = id => document.getElementById(id);
  let ready = false;
  let composing = false;
  let active = null;
  let job = null;
  let openaiModel = '';
  let openaiReasoningEffort = 'none';
  let selectedService = 'openai';

  function showError(error) {
    get('errorBox').textContent = error?.message || 'Text Translation failed. Try again.';
    get('errorBox').hidden = false;
  }

  function renderBusy() {
    get('translationSettings').disabled = !ready || Boolean(active);
    get('sourceText').disabled = !ready || Boolean(active);
    get('btnTranslate').disabled = !ready || Boolean(active);
    get('btnStop').disabled = !active;
    get('btnResume').disabled = !ready || Boolean(active) ||
      !job || !['stopped', 'failed'].includes(job.status) || !sameInput();
    get('btnCopy').disabled = !get('translatedText').value;
  }

  function sameInput() {
    if (!job || get('sourceText').value !== job.source) return false;
    try {
      const settings = readSettings();
      return Object.keys(job.settings).every(key => job.settings[key] === settings[key]);
    } catch { return false; }
  }

  function renderJob() {
    get('translatedText').value = job ? job.results.map(result => result.translation).join('') : '';
    get('progressStatus').textContent = job
      ? `${job.results.length} of ${job.units.length} parts complete.${job.status === 'complete' ? '' : ' Incomplete translation.'}` : '';
    if (job?.results.length) {
      const languages = job.results.filter((_result, index) => job.units[index].trim()).map(result => result.sourceLanguage);
      const detected = languages.length && languages[0] && languages.every(language => language === languages[0]) ? languages[0] : null;
      get('languageStatus').textContent = job.settings.sourceLanguage === 'auto'
        ? detected ? `Detected source language: ${detected}` : 'Source language is uncertain.'
        : `Source language: ${job.settings.sourceLanguage}`;
    } else get('languageStatus').textContent = '';
    renderBusy();
  }

  function inputChanged() {
    get('errorBox').hidden = true;
    get('inputHint').textContent = `${Array.from(get('sourceText').value).length.toLocaleString('en-US')} / ${contract.MAX_SOURCE_CHARACTERS.toLocaleString('en-US')} Unicode characters (code points). Plain text only.`;
    renderBusy();
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

  function readSettings() {
    return contract.normalizeSettings({ service: get('service').value,
      model: get('model').value, reasoningEffort: get('reasoningEffort').value,
      sourceLanguage: get('sourceLanguage').value, targetLanguage: get('targetLanguage').value,
      tone: get('tone').value });
  }

  function stop() {
    const operation = active;
    active = null;
    if (operation) {
      operation.job.status = 'stopped';
      void chrome.runtime.sendMessage({ type: 'STOP_TEXT_TRANSLATION', operationId: operation.id }).catch(() => {});
      get('status').textContent = 'Stopped.';
    }
    renderJob();
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
    if (resume && (!job || !['stopped', 'failed'].includes(job.status) || !sameInput())) {
      showError(new Error('Source or translation settings changed. Start a new translation.'));
      return;
    }
    if (!resume) job = { source, settings, units: contract.splitSource(source), results: [], status: 'running' };
    job.status = 'running';
    const operation = { id: crypto.randomUUID(), job };
    active = operation;
    get('status').textContent = 'Translating…';
    renderJob();
    try {
      while (job.results.length < job.units.length) {
        const unit = job.units[job.results.length];
        let result = { translation: unit, sourceLanguage: null };
        if (unit.trim()) {
          const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT',
            operationId: operation.id, source: unit, settings: job.settings });
          if (!response?.ok) throw new Error(response?.error?.message || 'Text Translation failed. Try again.');
          result = response.result;
        }
        if (active !== operation) return;
        job.results.push(result);
        renderJob();
      }
      job.status = 'complete';
      get('status').textContent = 'Translation complete.';
    } catch (error) {
      if (active === operation) {
        job.status = 'failed';
        get('status').textContent = 'Translation failed.';
        showError(error);
      }
    } finally {
      if (active === operation) {
        active = null;
        renderJob();
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
    if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return;
    if (composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    void translate();
  });
  get('service').addEventListener('change', () => {
    rememberOpenai();
    selectedService = get('service').value;
    displayService();
  });
  get('sourceText').addEventListener('input', inputChanged);
  get('translationSettings').addEventListener('input', inputChanged);
  get('translationSettings').addEventListener('change', inputChanged);
  get('btnStop').addEventListener('click', stop);
  get('btnResume').addEventListener('click', () => { void translate(true); });
  get('btnClear').addEventListener('click', () => {
    stop();
    job = null;
    get('sourceText').value = '';
    get('translatedText').value = '';
    get('languageStatus').textContent = '';
    get('status').textContent = '';
    get('errorBox').hidden = true;
    inputChanged();
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
  window.addEventListener('pagehide', stop);
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
      ready = true;
      renderBusy();
    } catch (error) { showError(error); }
  })();
})();
