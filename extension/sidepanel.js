let activeTabId = null;

const hasDocument = typeof document !== 'undefined';

const elStatus = hasDocument ? document.getElementById('status') : null;
const elError = hasDocument ? document.getElementById('errorBox') : null;
const elProgress = hasDocument ? document.getElementById('progress') : null;

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

async function saveSettings() {
  const settings = {
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || 'gpt-5.4-mini',
    viewMode: elViewMode.value,
  };
  const resp = await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings,
  });
  if (!resp?.ok) {
    setError(resp?.error?.message || 'Failed to save settings');
    return;
  }
}

function renderState(state) {
  if (!state) {
    setStatus('Idle');
    setError(null);
    setProgress(null);
    elOriginal.textContent = '';
    elTranslated.textContent = '';
    return;
  }

  const status = state.status || 'idle';
  setStatus(status);

  if (state.error?.message) setError(state.error.message);
  else setError(null);

  if (state.progress?.total) {
    setProgress(`Chunk ${state.progress.current}/${state.progress.total}`);
  } else {
    setProgress(null);
  }

  elOriginal.textContent = formatOriginalPanelText(state);

  elTranslated.textContent = formatTranslatedPanelText(
    state,
    elViewMode.value || state.settingsUsed?.viewMode || 'translation'
  );
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
  setError(null);
  const settingsOverride = {
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || 'gpt-5.4-mini',
    viewMode: elViewMode.value,
  };
  await chrome.runtime.sendMessage({
    type: 'TRANSLATE_TAB',
    tabId: activeTabId,
    settingsOverride,
  });
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
  document.getElementById('btnTranslate').addEventListener('click', translateNow);
  document.getElementById('btnSave').addEventListener('click', saveSettings);
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
    formatOriginalPanelText,
    formatTranslatedPanelText,
  };
}
