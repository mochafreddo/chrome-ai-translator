const { INLINE_TRANSLATION_CONTROLS, getInlineTranslationControlAvailability } =
  globalThis.ChromeAiTranslatorInlineTranslationControls ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-translation-controls.js')
    : {});

let activeTabId = null;
let panelErrorMessage = '';
let inlineTranslationSnapshot = null;
let inlineTranslationError = '';
let inlineTranslationErrorTabId = null;

const hasDocument = typeof document !== 'undefined';

const elStatus = hasDocument ? document.getElementById('status') : null;
const elError = hasDocument ? document.getElementById('errorBox') : null;
const elProgress = hasDocument ? document.getElementById('progress') : null;
const elSaveStatus = hasDocument ? document.getElementById('saveStatus') : null;
const elSaveError = hasDocument ? document.getElementById('saveError') : null;
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

const btnInlineTranslate = hasDocument
  ? document.getElementById('btnInlineTranslate')
  : null;
const btnInlineStop = hasDocument
  ? document.getElementById('btnInlineStop')
  : null;
const btnInlineRestore = hasDocument
  ? document.getElementById('btnInlineRestore')
  : null;
const elInlineStatus = hasDocument
  ? document.getElementById('inlineStatus')
  : null;
const elInlineError = hasDocument
  ? document.getElementById('inlineError')
  : null;

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

function setSaveError(message) {
  if (!message) {
    elSaveError.hidden = true;
    elSaveError.textContent = '';
    return;
  }
  elSaveError.hidden = false;
  elSaveError.textContent = message;
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

// Inline Translation runs in the tab, and the tab keeps its own state; this decides what
// the Inline Translation Section makes of it. Everything it needs is an argument, so the
// section's behaviour is settled without a browser or a DOM. Which controls are on offer
// is the rule both homes share; only the labels below are this one's own.
function getInlineTranslationPanelViewModel({
  snapshot = null,
  error = '',
} = {}) {
  const status = snapshot?.status || 'original';
  const { isActive, isTranslating, canStart, canStop, canRestore } =
    getInlineTranslationControlAvailability(status);

  return {
    startText: isTranslating
      ? 'Translating...'
      : isActive
      ? 'Scan visible text'
      : 'Translate visible text',
    startDisabled: !canStart,
    stopDisabled: !canStop,
    restoreDisabled: !canRestore,
    statusText: snapshot?.progress || '',
    // The panel's own account of the click it just made comes first: a control the tab
    // never received leaves no page state behind to report it.
    errorText: error || snapshot?.error || '',
  };
}

function renderInlineTranslation() {
  const model = getInlineTranslationPanelViewModel({
    snapshot: inlineTranslationSnapshot,
    error: inlineTranslationError,
  });

  btnInlineTranslate.textContent = model.startText;
  btnInlineTranslate.disabled = model.startDisabled;
  btnInlineStop.disabled = model.stopDisabled;
  btnInlineRestore.disabled = model.restoreDisabled;
  elInlineStatus.textContent = model.statusText;

  if (model.errorText) {
    elInlineError.hidden = false;
    elInlineError.textContent = model.errorText;
    return;
  }
  elInlineError.hidden = true;
  elInlineError.textContent = '';
}

// What a control did is only ever true of the tab it was aimed at, and the panel stays
// open across tab switches.
function setInlineTranslationError(message, tabId) {
  inlineTranslationError = message || '';
  inlineTranslationErrorTabId = message ? tabId : null;
  renderInlineTranslation();
}

async function refreshInlineTranslationState() {
  activeTabId = await getActiveTabId();
  if (!activeTabId) return;
  if (inlineTranslationErrorTabId !== activeTabId) {
    inlineTranslationError = '';
    inlineTranslationErrorTabId = null;
  }
  const resp = await chrome.runtime.sendMessage({
    type: 'GET_INLINE_TRANSLATION_STATE',
    tabId: activeTabId,
  });
  inlineTranslationSnapshot = resp?.ok ? resp.snapshot || null : null;
  renderInlineTranslation();
}

async function sendInlineTranslationControl(control) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  activeTabId = tabId;

  setInlineTranslationError('', tabId);

  const resp = await chrome.runtime.sendMessage({
    type: 'RUN_INLINE_TRANSLATION_CONTROL',
    tabId,
    control,
  });
  if (!resp?.ok) {
    setInlineTranslationError(
      resp?.error?.message || 'Inline translation did not answer on this tab.',
      tabId
    );
    return;
  }
  await refreshInlineTranslationState();
}

function handleInlineTranslationControlClick(control) {
  sendInlineTranslationControl(control).catch((error) => {
    setInlineTranslationError(error?.message || String(error), activeTabId);
  });
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
  elModel.value = s.model || 'gpt-5.6-luna';
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
            throw new Error('Settings save failed');
          }
          render({ saving: false, status: 'Saved.', error: '' });
          return true;
        })
        .catch(() => {
          render({
            saving: false,
            status: '',
            error: 'Failed to save settings.',
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
    model: elModel.value.trim() || 'gpt-5.6-luna',
    viewMode: elViewMode.value,
  };
}

function renderSettingsSave({ saving, status, error }) {
  btnSave.disabled = saving;
  elSaveStatus.textContent = status;
  setSaveError(error);
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
    model: elModel.value.trim() || 'gpt-5.6-luna',
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
  btnInlineTranslate.addEventListener('click', () =>
    handleInlineTranslationControlClick(INLINE_TRANSLATION_CONTROLS.START)
  );
  btnInlineStop.addEventListener('click', () =>
    handleInlineTranslationControlClick(INLINE_TRANSLATION_CONTROLS.STOP)
  );
  btnInlineRestore.addEventListener('click', () =>
    handleInlineTranslationControlClick(INLINE_TRANSLATION_CONTROLS.RESTORE)
  );

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'STATE_UPDATED') return;
    if (msg.tabId !== activeTabId) return;
    renderState(msg.state);
  });

  (async function init() {
    setupTabs();
    renderInlineTranslation();
    await loadSettings();
    await refreshState();
    await refreshInlineTranslationState().catch(() => {});

    // Keep UI in sync when user switches tabs while the panel is open. Inline Translation
    // is polled on the same beat: the tab owns that state, and it moves on without the
    // panel — a translation may already be under way by the time the panel opens.
    setInterval(() => {
      refreshState().catch(() => {});
      refreshInlineTranslationState().catch(() => {});
    }, 1000);
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createSettingsSaveController,
    formatOriginalPanelText,
    formatTranslatedPanelText,
    getInlineTranslationPanelViewModel,
    getSidepanelDisplayState,
  };
}
