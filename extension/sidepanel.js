let activeTabId = null;
let panelErrorMessage = '';

const hasDocument = typeof document !== 'undefined';

const elStatus = hasDocument ? document.getElementById('status') : null;
const elError = hasDocument ? document.getElementById('errorBox') : null;
const elProgress = hasDocument ? document.getElementById('progress') : null;
const btnTranslate = hasDocument ? document.getElementById('btnTranslate') : null;
const btnSave = hasDocument ? document.getElementById('btnSave') : null;

const elTargetLanguage = hasDocument
  ? document.getElementById('targetLanguage')
  : null;
const elTone = hasDocument ? document.getElementById('tone') : null;
const elModel = hasDocument ? document.getElementById('model') : null;
const elViewMode = hasDocument ? document.getElementById('viewMode') : null;

const elOriginal = hasDocument ? document.getElementById('original') : null;
const elTranslated = hasDocument ? document.getElementById('translated') : null;

function setStatus(text) {
  elStatus.textContent = text;
}

function setError(message) {
  if (!message) {
    elError.hidden = true;
    elError.textContent = '';
    return;
  }
  elError.hidden = false;
  elError.textContent = message;
}

function setProgress(p) {
  elProgress.textContent = p || '';
}

function setPanelError(message) {
  panelErrorMessage = message || '';
  setError(panelErrorMessage);
}

function trimPanelText(value) {
  return String(value || '').trim();
}

function formatTranslatedPanelText(state, viewMode = 'translation') {
  const translated = trimPanelText(state?.translated);
  if (!translated) return '';

  const original = trimPanelText(state?.extracted?.contentMarkdown);
  if (viewMode === 'bilingual' && original) {
    return `Original\n\n${original}\n\nTranslation\n\n${translated}`;
  }

  return translated;
}

function formatOriginalPanelText(state) {
  return state?.extracted?.contentMarkdown || '';
}

function formatStatusText(status) {
  const safe = String(status || 'idle');
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

function getSidepanelDisplayState(state = {}, viewMode = 'translation') {
  const status = state?.status || 'idle';
  const busy = status === 'extracting' || status === 'translating';
  const translatedText = formatTranslatedPanelText(state, viewMode);
  const originalText = formatOriginalPanelText(state);
  const progressText = state?.progress?.total
    ? `Chunk ${state.progress.current}/${state.progress.total}`
    : '';

  return {
    statusText: formatStatusText(status),
    translateButtonText: busy ? 'Translating...' : 'Translate current tab',
    translateDisabled: busy,
    progressText,
    translatedText:
      translatedText ||
      (busy
        ? 'Translating current tab...\n\nProgress will appear here as chunks complete.'
        : 'No translation yet.\n\nUse Translate current tab to translate the active article.'),
    originalText:
      originalText ||
      (busy
        ? 'Extracting article text...'
        : 'No original text yet.\n\nRun Translate current tab to extract the source article.'),
  };
}

async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs?.[0]?.id ?? null;
}

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (!resp?.ok) return;
  const s = resp.settings;

  elTargetLanguage.value = s.targetLanguage || 'Korean';
  elTone.value = s.tone || 'technical';
  elModel.value = s.model || 'gpt-5.4-mini';
  elViewMode.value = s.viewMode || 'translation';
}

function createSettingsSaveController({ sendMessage, readSettings, render }) {
  let inFlight = null;

  return {
    isSaving() {
      return Boolean(inFlight);
    },
    save() {
      if (inFlight) return inFlight;

      render({ saving: true, status: 'Saving...', error: '' });
      inFlight = Promise.resolve()
        .then(() =>
          sendMessage({
            type: 'SAVE_SETTINGS',
            settings: readSettings(),
          })
        )
        .then((response) => {
          if (!response?.ok) {
            throw new Error(
              response?.error?.message || 'Failed to save settings'
            );
          }
          render({ saving: false, status: 'Saved.', error: '' });
          return true;
        })
        .catch((error) => {
          render({
            saving: false,
            status: '',
            error: String(error?.message || error).slice(0, 300),
          });
          return false;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

function readSettings() {
  return {
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || 'gpt-5.4-mini',
    viewMode: elViewMode.value,
  };
}

function renderSettingsSave({ saving, status, error }) {
  btnSave.disabled = saving;
  setStatus(status);
  setError(error);
}

const settingsSaveController = hasDocument
  ? createSettingsSaveController({
      sendMessage: (message) => chrome.runtime.sendMessage(message),
      readSettings,
      render: renderSettingsSave,
    })
  : null;

function renderTranslateFailure(error) {
  const message = error?.message || String(error);
  setPanelError(message);
  renderState({ status: 'idle', error: { message } });
}

function renderState(state) {
  const displayState = getSidepanelDisplayState(
    state || { status: 'idle' },
    elViewMode.value || state?.settingsUsed?.viewMode || 'translation'
  );
  setStatus(displayState.statusText);
  btnTranslate.textContent = displayState.translateButtonText;
  btnTranslate.disabled = displayState.translateDisabled;

  if (state?.error?.message) setError(state.error.message);
  else if (panelErrorMessage) setError(panelErrorMessage);
  else setError(null);

  setProgress(displayState.progressText);

  elOriginal.textContent = displayState.originalText;
  elTranslated.textContent = displayState.translatedText;
}

async function refreshState() {
  // Side panel can stay open across tab switches.
  // Always re-check the active tab before fetching state.
  activeTabId = await getActiveTabId();
  if (!activeTabId) return;
  const resp = await chrome.runtime.sendMessage({
    type: 'GET_STATE',
    tabId: activeTabId,
  });
  if (!resp?.ok) return;
  renderState(resp.state);
}

async function translateNow() {
  activeTabId = await getActiveTabId();
  if (!activeTabId) return;
  setPanelError('');
  renderState({ status: 'translating' });
  const settingsOverride = {
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || 'gpt-5.4-mini',
    viewMode: elViewMode.value,
  };
  const resp = await chrome.runtime.sendMessage({
    type: 'TRANSLATE_TAB',
    tabId: activeTabId,
    settingsOverride,
  });
  if (!resp?.ok) {
    throw new Error(resp?.error?.message || 'Failed to start translation');
  }
  if (resp.skipped) {
    await refreshState();
  }
}

function handleTranslateClick() {
  translateNow().catch(renderTranslateFailure);
}

function setupTabs() {
  const buttons = Array.from(document.querySelectorAll('.tab'));
  const panels = {
    original: document.getElementById('panel-original'),
    translated: document.getElementById('panel-translated'),
  };

  function activate(which) {
    for (const b of buttons) {
      const active = b.dataset.tab === which;
      b.setAttribute('aria-selected', String(active));
    }
    panels.original.hidden = which !== 'original';
    panels.translated.hidden = which !== 'translated';
  }

  buttons.forEach((b) => {
    b.addEventListener('click', () => activate(b.dataset.tab));
  });
}

if (hasDocument) {
  document
    .getElementById('btnTranslate')
    .addEventListener('click', handleTranslateClick);
  btnSave.addEventListener('click', () => {
    settingsSaveController.save();
  });
  document
    .getElementById('btnOpenOptions')
    .addEventListener('click', () => chrome.runtime.openOptionsPage());
  elViewMode.addEventListener('change', () => refreshState().catch(() => {}));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'STATE_UPDATED') return;
    if (msg.tabId !== activeTabId) return;
    renderState(msg.state);
  });

  (async function init() {
    setupTabs();
    await loadSettings();
    await refreshState();

    // Keep UI in sync when user switches tabs while the panel is open.
    setInterval(() => {
      refreshState().catch(() => {});
    }, 1000);
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createSettingsSaveController,
    formatOriginalPanelText,
    formatTranslatedPanelText,
    getSidepanelDisplayState,
  };
}
