const { INLINE_TRANSLATION_CONTROLS, getInlineTranslationControlAvailability } =
  globalThis.ChromeAiTranslatorInlineTranslationControls ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-translation-controls.js')
    : {});
const { MISSING_PAGE_ACCESS_MESSAGES } =
  globalThis.ChromeAiTranslatorPageAccess ||
  (typeof module !== 'undefined' && module.exports
    ? require('./page-access.js')
    : {});
const { DEFAULT_MODEL } =
  globalThis.ChromeAiTranslatorDefaultModel ||
  (typeof module !== 'undefined' && module.exports
    ? require('./default-model.js')
    : {});
const { describeSidePanelFailure } =
  globalThis.ChromeAiTranslatorSidePanelFailure ||
  (typeof module !== 'undefined' && module.exports
    ? require('./sidepanel-failure.js')
    : {});

let activeTabId = null;
let panelErrorMessage = '';
let inlineTranslationSnapshot = null;
// Two accounts of a failed start reach this section, and they are kept apart because they
// are cleared by different things. The first is the panel's own, from a control the reader
// pressed here; the panel holds it and drops it when the tab it was about goes out of
// view. The second is the worker's, from the Inline Translation Shortcut — pressed on the
// page, not here — and it lives in the tab state, so the tab it belongs to keeps it.
let inlineControlError = '';
let inlineControlErrorTabId = null;
let inlineInvocationError = '';
// The panel opens on a tab the reader just invoked the extension on, and asks that tab
// about itself straight away. Until it answers, offering the controls is the better guess
// of the two — and the wrong one costs a single click, where dimming them on a tab that is
// in reach would tell the reader to do something they have already done.
let inlineTranslationPageAccess = true;

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

  // What a failure means is chosen from its code rather than its message — see
  // sidepanel-failure.js. A failed tab is owed a sentence whether or not it said anything
  // about the failure, which is why the status counts on its own; a tab that has not failed
  // is owed silence, because the general sentence would announce a failure of its own.
  const hasFailure =
    status === 'error' || Boolean(state?.error?.message || state?.error?.code);

  return {
    statusText: formatStatusText(status),
    translateButtonText: busy ? 'Translating...' : 'Translate current tab',
    translateDisabled: busy,
    errorText: hasFailure ? describeSidePanelFailure(state.error) : '',
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
  controlError = '',
  invocationError = '',
  hasPageAccess = true,
} = {}) {
  const status = snapshot?.status || 'original';
  const { isActive, canStop, canRestore } =
    getInlineTranslationControlAvailability(status);
  // Start is not among the rules — it stays pressable in every status — so what the tab's
  // status decides here is only which of the two things the label promises.
  const startText = isActive ? 'Scan visible text' : 'Translate visible text';

  // Page access is granted per tab, and the panel stays open across tab switches, so the
  // reader can arrive here on a tab the extension has never been invoked on. None of the
  // three controls can reach it, and Inline Translation Authorization would not help — it
  // is a separate axis, and holding it on one tab grants nothing on another. So the
  // section dims all three and asks for the one thing that does help, rather than taking a
  // click and reporting the failure afterwards.
  if (!hasPageAccess) {
    return {
      startText,
      startDisabled: true,
      stopDisabled: true,
      restoreDisabled: true,
      // One account of one problem, in the register the reader's own gesture puts it in.
      // A gesture this tab refused — a control pressed here, the shortcut pressed on the
      // page — is this same missing grant met from another direction, so it changes what
      // the guidance asks for, there now being something to try again, rather than
      // arriving beside it as a second problem.
      statusText:
        controlError || invocationError
          ? MISSING_PAGE_ACCESS_MESSAGES.afterFailedAttempt
          : MISSING_PAGE_ACCESS_MESSAGES.beforeAnyAttempt,
      // A tab out of reach reports nothing of its own, and the guidance above has already
      // said everything either account would repeat.
      errorText: '',
    };
  }

  return {
    startText,
    // A tab out of reach is the one thing that dims Start, and it returned above; on a tab
    // the section can reach, Start is pressable whatever the run is doing.
    startDisabled: false,
    stopDisabled: !canStop,
    restoreDisabled: !canRestore,
    statusText: snapshot?.progress || '',
    // Newest first. The panel's own account of the click it just made comes ahead of a
    // shortcut press the worker recorded before it, and a control the tab never received
    // leaves no page state behind to report either of them.
    errorText: controlError || invocationError || snapshot?.error || '',
  };
}

// What the Inline Translation Section takes from an update to the tab's state, and what it
// leaves alone. Side Panel Translation's failure is in `error` and stays there.
function readInlineTranslationError(state) {
  return state?.inlineTranslationError?.message || '';
}

function renderInlineTranslation() {
  const model = getInlineTranslationPanelViewModel({
    snapshot: inlineTranslationSnapshot,
    controlError: inlineControlError,
    invocationError: inlineInvocationError,
    hasPageAccess: inlineTranslationPageAccess,
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
function setInlineControlError(message, tabId) {
  inlineControlError = message || '';
  inlineControlErrorTabId = message ? tabId : null;
  renderInlineTranslation();
}

// Dropped rather than rendered away: the two callers are mid-refresh and paint once at the
// end, so neither wants a render of its own.
function forgetInlineControlError() {
  inlineControlError = '';
  inlineControlErrorTabId = null;
}

// The worker's per-tab state is the only way the Inline Translation Shortcut's outcome
// reaches this section: it is pressed on the page, not here. Only the two paths that carry
// that state read it — a render the panel synthesises for itself says nothing about a run
// the worker started, and must not be able to clear what it did.
function syncInlineTranslationFromTabState(state) {
  inlineInvocationError = readInlineTranslationError(state);
  renderInlineTranslation();
}

async function refreshInlineTranslationState() {
  activeTabId = await getActiveTabId();
  if (!activeTabId) return;
  if (inlineControlErrorTabId !== activeTabId) forgetInlineControlError();
  const resp = await chrome.runtime.sendMessage({
    type: 'GET_INLINE_TRANSLATION_STATE',
    tabId: activeTabId,
  });
  // Whether the tab answered at all is what tells the panel it is in reach: the content
  // script answers this one whatever Inline Translation is doing, and only a tab the
  // extension has not been invoked on has nothing there to answer with.
  const wasOutOfReach = !inlineTranslationPageAccess;
  inlineTranslationPageAccess = resp?.ok === true;
  // An error recorded while the tab was out of reach was about exactly that, and the reader
  // has since done what the guidance asked. Letting it back out now would tell them the tab
  // is unreachable in the same breath as re-enabling the controls.
  // The worker's own account is withdrawn on the same news, from the tab state it lives
  // in, when the click that grant took reaches the injection step.
  if (wasOutOfReach && inlineTranslationPageAccess) forgetInlineControlError();
  inlineTranslationSnapshot = resp?.ok ? resp.snapshot || null : null;
  renderInlineTranslation();
}

async function sendInlineTranslationControl(control) {
  const tabId = await getActiveTabId();
  if (!tabId) return;
  activeTabId = tabId;

  setInlineControlError('', tabId);

  const resp = await chrome.runtime.sendMessage({
    type: 'RUN_INLINE_TRANSLATION_CONTROL',
    tabId,
    control,
  });
  if (!resp?.ok) {
    setInlineControlError(
      resp?.error?.message || 'Inline translation did not answer on this tab.',
      tabId
    );
    return;
  }
  await refreshInlineTranslationState();
}

function handleInlineTranslationControlClick(control) {
  sendInlineTranslationControl(control).catch((error) => {
    setInlineControlError(error?.message || String(error), activeTabId);
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
  elModel.value = s.model || DEFAULT_MODEL;
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
    model: elModel.value.trim() || DEFAULT_MODEL,
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

// A failure the panel caught itself rather than heard about from the tab. It is read the
// same way, so that a coded one is not the one failure that still reaches the reader as a
// code — and the sentence is settled here, because what renderState is handed below has no
// code left to settle it from.
function renderTranslateFailure(error) {
  const message = describeSidePanelFailure({
    message: error?.message || String(error),
    code: error?.code,
  });
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

  if (displayState.errorText) setError(displayState.errorText);
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
  syncInlineTranslationFromTabState(resp.state);
}

async function translateNow() {
  activeTabId = await getActiveTabId();
  if (!activeTabId) return;
  setPanelError('');
  renderState({ status: 'translating' });
  const settingsOverride = {
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || DEFAULT_MODEL,
    viewMode: elViewMode.value,
  };
  const resp = await chrome.runtime.sendMessage({
    type: 'TRANSLATE_TAB',
    tabId: activeTabId,
    settingsOverride,
  });
  if (!resp?.ok) {
    const failure = new Error(
      resp?.error?.message || 'Failed to start translation'
    );
    // Re-raising loses everything but the message unless the code is carried across, and a
    // coded failure's message is the code.
    if (typeof resp?.error?.code === 'string') failure.code = resp.error.code;
    throw failure;
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
    syncInlineTranslationFromTabState(msg.state);
  });

  (async function init() {
    // The markup names no model of its own: a placeholder still naming the model the
    // extension defaulted to yesterday is the same quiet lie as a stale fallback.
    elModel.placeholder = DEFAULT_MODEL;
    setupTabs();
    renderInlineTranslation();
    await loadSettings();
    // Whether the tab is in reach is asked first, because the panel opens holding the
    // optimistic guess and the worker may already have a refused start waiting for it. Ask
    // the other way round and that failure is painted in the error area for the one beat
    // before the answer moves it into the guidance.
    await refreshInlineTranslationState().catch(() => {});
    await refreshState();

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
    readInlineTranslationError,
  };
}
