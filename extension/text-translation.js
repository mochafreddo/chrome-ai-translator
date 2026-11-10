(function initTextTranslationPage() {
  const contract = globalThis.ChromeAiTranslatorTextTranslationRequest;
  const { OPENROUTER_MODEL } = globalThis.ChromeAiTranslatorDefaultModel;
  const get = id => document.getElementById(id);
  let ready = false;
  let composing = false;
  let active = null;
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
    get('btnCopy').disabled = !get('translatedText').value;
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
      void chrome.runtime.sendMessage({ type: 'STOP_TEXT_TRANSLATION', operationId: operation.id }).catch(() => {});
      get('status').textContent = 'Stopped.';
    }
    renderBusy();
  }

  async function translate() {
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
    const operation = { id: crypto.randomUUID(), source, settings };
    active = operation;
    get('translatedText').value = '';
    get('languageStatus').textContent = '';
    get('status').textContent = 'Translating…';
    renderBusy();
    try {
      const response = await chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT',
        operationId: operation.id, source: operation.source, settings: operation.settings });
      if (active !== operation) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Text Translation failed. Try again.');
      get('translatedText').value = response.result.translation;
      get('languageStatus').textContent = settings.sourceLanguage === 'auto'
        ? response.result.sourceLanguage ? `Detected source language: ${response.result.sourceLanguage}` : 'Source language is uncertain.'
        : `Source language: ${settings.sourceLanguage}`;
      get('status').textContent = 'Translation complete.';
    } catch (error) {
      if (active === operation) {
        get('status').textContent = 'Translation failed.';
        showError(error);
      }
    } finally {
      if (active === operation) {
        active = null;
        renderBusy();
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
  get('sourceText').addEventListener('input', () => { get('errorBox').hidden = true; });
  get('btnStop').addEventListener('click', stop);
  get('btnClear').addEventListener('click', () => {
    stop();
    get('sourceText').value = '';
    get('translatedText').value = '';
    get('languageStatus').textContent = '';
    get('status').textContent = '';
    get('errorBox').hidden = true;
    renderBusy();
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
  get('inputHint').textContent = `Up to ${contract.MAX_SOURCE_CHARACTERS.toLocaleString('en-US')} characters per translation. Plain text only.`;
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
