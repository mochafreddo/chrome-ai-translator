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
const { DEFAULT_MODEL, getEffectiveModelSettings } =
  globalThis.ChromeAiTranslatorDefaultModel ||
  (typeof module !== 'undefined' && module.exports
    ? require('./default-model.js')
    : {});
const { describeSidePanelFailure } =
  globalThis.ChromeAiTranslatorSidePanelFailure ||
  (typeof module !== 'undefined' && module.exports
    ? require('./sidepanel-failure.js')
    : {});
const { getTargetLanguageCode } =
  globalThis.ChromeAiTranslatorTranslationSettings ||
  (typeof module !== 'undefined' && module.exports
    ? require('./translation-settings.js')
    : {});

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
  if (elError.textContent !== message) elError.textContent = message;
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

function trimPanelText(value) {
  return String(value || '').trim();
}

function getTranslatedPanelParts(state, viewMode = 'translation') {
  const translated = trimPanelText(state?.translated);
  if (!translated) return [];

  const original = trimPanelText(state?.extracted?.contentMarkdown);
  const language = getContentLanguage(state?.settingsUsed?.targetLanguage);
  if (viewMode === 'bilingual' && original) {
    return [
      ['Original\n\n', 'en'],
      [original, getContentLanguage(state.extracted?.langHint)],
      ['\n\nTranslation\n\n', 'en'],
      [translated, language],
    ];
  }

  return [[translated, language]];
}

function formatTranslatedPanelText(state, viewMode = 'translation') {
  return getTranslatedPanelParts(state, viewMode).map(([text]) => text).join('');
}

function formatOriginalPanelText(state) {
  return state?.extracted?.contentMarkdown || '';
}

function formatStatusText(status) {
  const safe = String(status || 'idle');
  return safe.charAt(0).toUpperCase() + safe.slice(1);
}

function getContentLanguage(value) {
  const language = String(value || '').normalize('NFKC').trim();
  if (/^[a-z]{2,3}(?:-|$)/i.test(language)) {
    try {
      return Intl.getCanonicalLocales(language)[0] || '';
    } catch {
      return '';
    }
  }
  return getTargetLanguageCode(language);
}

function getSidepanelDisplayState(state = {}, viewMode = 'translation') {
  const status = state?.status || 'idle';
  const busy = status === 'extracting' || status === 'translating';
  const translatedParts = getTranslatedPanelParts(state, viewMode);
  const translatedText = translatedParts.map(([text]) => text).join('');
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
    translatedParts,
    originalLanguage: originalText ? getContentLanguage(state.extracted?.langHint) : 'en',
    translatedLanguage: trimPanelText(state.translated)
      ? getContentLanguage(state.settingsUsed?.targetLanguage) : 'en',
    statusText: formatStatusText(status),
    translateButtonText: busy ? 'Translating...' : 'Translate current tab',
    translateDisabled: busy,
    errorText: hasFailure ? describeSidePanelFailure(state.error) : '',
    progressText,
    translatedText:
      translatedText ||
      (busy
        ? 'Translating current tab...\n\nThe translation appears here when the last chunk is back. A failure before then leaves nothing here.'
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
  invocationErrorCode = '',
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
  if (invocationErrorCode === 'content_script_not_ready') {
    return {
      startText,
      startDisabled: true,
      stopDisabled: true,
      restoreDisabled: true,
      statusText: '',
      errorText: invocationError,
    };
  }

  if (hasPageAccess === null) {
    return {
      startText,
      startDisabled: true,
      stopDisabled: true,
      restoreDisabled: true,
      statusText: 'Checking access to this tab...',
      errorText: '',
    };
  }

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

// One owner for the panel's tab selection and both Translation displays. Adapters
// supply Chrome queries and messages; rendering observes only the public display state.
function createTabStateController({ queryActiveTab, sendMessage, render }) {
  let tabId = null;
  let selection = {};
  let queryVersion = 0;
  let stateRequest = null;
  let inlineRequest = null;
  let inlineControl = null;
  let translationRequest = null;
  let windowId = null;
  let state = { status: 'idle' };
  let panelError = '';
  let snapshot = null;
  let controlError = '';
  let controlErrorTabId = null;
  let invocationError = '';
  let hasPageAccess = null;
  let hasBody = false;
  let bodyRecovery = null;
  let invalidatedBody = null;
  let minimumStateSequence = 0;
  let pendingNotification = null;
  const retiredEpochs = new Set();

  function acceptState(incoming, currentRequest = true) {
    if (!incoming || typeof incoming.workerEpoch !== 'string' || !incoming.workerEpoch ||
      !Number.isSafeInteger(incoming.stateSequence) || incoming.stateSequence < 0 ||
      !Number.isSafeInteger(incoming.bodyVersion) || incoming.bodyVersion < 0 ||
      retiredEpochs.has(incoming.workerEpoch)) return;
    if (incoming.workerEpoch !== state.workerEpoch) {
      if (!currentRequest) return;
      if (state.workerEpoch) retiredEpochs.add(state.workerEpoch);
      state = { status: 'idle' };
      hasBody = false;
      invalidatedBody = null;
      minimumStateSequence = 0;
    }
    const bodyMatches = incoming.bodyVersion === state.bodyVersion;
    const fullBody = Object.prototype.hasOwnProperty.call(incoming, 'extracted') &&
      Object.prototype.hasOwnProperty.call(incoming, 'translated') &&
      invalidatedBody !== `${incoming.workerEpoch}/${incoming.bodyVersion}`;
    if ((currentRequest || incoming.stateSequence > (state.stateSequence ?? 0)) &&
      incoming.stateSequence >= minimumStateSequence &&
      incoming.stateSequence >= (state.stateSequence ?? 0)) {
      const body = fullBody ? incoming : bodyMatches && hasBody ? state : null;
      state = { ...incoming, extracted: body?.extracted ?? null, translated: body?.translated ?? null };
      hasBody = Boolean(body);
    } else if (fullBody && bodyMatches && !hasBody) {
      state = { ...state, extracted: incoming.extracted, translated: incoming.translated };
      hasBody = true;
    } else return;
    invocationError = readInlineTranslationError(state);
    paint();
    if (pendingNotification?.workerEpoch === state.workerEpoch) {
      const notification = pendingNotification;
      pendingNotification = null;
      acceptState(notification);
    }
  }

  async function refreshState(requestedSelection, requestedControl = null, requireBody = false) {
    const request = stateRequest = {};
    const response = await sendMessage({ type: 'GET_STATE', tabId,
      ...(hasBody && !requireBody ? { knownBody: {
        workerEpoch: state.workerEpoch, bodyVersion: state.bodyVersion,
      } } : {}),
    });
    if (selection !== requestedSelection ||
      (requestedControl && inlineControl !== requestedControl) || !response?.ok) return;
    acceptState(response.state, stateRequest === request);
  }

  function recoverBody(epoch, version) {
    if (retiredEpochs.has(epoch)) return;
    if (bodyRecovery?.epoch === epoch && bodyRecovery.version === version) return;
    const recovery = bodyRecovery = { epoch, version };
    const requestedSelection = selection;
    refreshState(requestedSelection, null, true).catch(() => {}).finally(() => {
      if (bodyRecovery !== recovery || selection !== requestedSelection) return;
      bodyRecovery = null;
      if (!hasBody && state.workerEpoch === epoch && state.bodyVersion !== version) {
        recoverBody(state.workerEpoch, state.bodyVersion);
      }
    });
  }

  function paint() {
    render({
      tabId, state, panelError,
      inline: { snapshot, controlError, invocationError, hasPageAccess,
        invocationErrorCode: state.inlineTranslationError?.code || '' },
    });
  }
  function forgetControlError() {
    controlError = '';
    controlErrorTabId = null;
  }
  function select(nextTabId, initiatingRequest = null) {
    if (tabId === nextTabId) return;
    // A query may discover the tab for its own action; other visits end pending actions.
    if (tabId !== null) {
      if (inlineControl !== initiatingRequest) inlineControl = null;
      if (translationRequest !== initiatingRequest) translationRequest = null;
    }
    tabId = nextTabId;
    selection = {};
    state = { status: 'idle' };
    hasBody = false;
    bodyRecovery = null;
    invalidatedBody = null;
    minimumStateSequence = 0;
    pendingNotification = null;
    retiredEpochs.clear();
    panelError = '';
    snapshot = null;
    forgetControlError();
    invocationError = '';
    hasPageAccess = null;
    paint();
  }
  async function resolveTab(initiatingRequest = null) {
    const version = ++queryVersion;
    const tab = await queryActiveTab();
    // A newer selection wins, but a poll confirming the same tab must not swallow
    // a button action that was waiting for its own query.
    if (version !== queryVersion) return tabId !== null && tab?.id === tabId;
    select(tab?.id ?? null, initiatingRequest);
    return tabId !== null;
  }
  async function refreshSelected(requestedControl = null) {
    if (tabId === null) return;
    if (controlErrorTabId !== tabId) forgetControlError();
    const requestedTab = tabId;
    const requestedSelection = selection;
    await Promise.all([
      (async () => {
        await refreshState(requestedSelection, requestedControl);
      })().catch(() => {}),
      (async () => {
        const request = inlineRequest = {};
        const response = await sendMessage({
          type: 'GET_INLINE_TRANSLATION_STATE', tabId: requestedTab,
        });
        if (selection !== requestedSelection || inlineRequest !== request ||
            (requestedControl && inlineControl !== requestedControl)) return;
        const wasOutOfReach = hasPageAccess === false;
        hasPageAccess = response?.ok === true;
        if (wasOutOfReach && hasPageAccess) forgetControlError();
        snapshot = response?.ok ? response.snapshot || null : null;
        paint();
      })().catch(() => {}),
    ]);
  }
  async function refresh() {
    if (await resolveTab()) await refreshSelected();
  }
  async function runInlineControl(control) {
    const requestedControl = inlineControl = {};
    forgetControlError();
    paint();
    let requestedSelection = selection;
    try {
      if (!(await resolveTab(requestedControl))) return;
      if (inlineControl !== requestedControl) return;
      const requestedTab = tabId;
      requestedSelection = selection;
      const response = await sendMessage({
        type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: requestedTab, control,
      });
      if (selection !== requestedSelection || inlineControl !== requestedControl) return;
      if (!response?.ok) {
        controlError = response?.error?.message ||
          'Inline translation did not answer on this tab.';
        controlErrorTabId = requestedTab;
        paint();
        return;
      }
      await refreshSelected(requestedControl);
    } catch (error) {
      if (selection !== requestedSelection || inlineControl !== requestedControl) return;
      controlError = error?.message || String(error);
      controlErrorTabId = tabId;
      paint();
    }
  }
  async function translate(settingsOverride) {
    const request = translationRequest = {};
    let requestedSelection = selection;
    let startingState = null;
    try {
      if (!(await resolveTab(request))) return;
      if (translationRequest !== request && tabId !== null) return;
      const requestedTab = tabId;
      requestedSelection = selection;
      startingState = state;
      panelError = '';
      stateRequest = null;
      bodyRecovery = null;
      hasBody = false;
      invalidatedBody = `${state.workerEpoch}/${state.bodyVersion}`;
      minimumStateSequence = (state.stateSequence || 0) + 1;
      state = { ...state, status: 'translating', extracted: null, translated: null };
      paint();
      const response = await sendMessage({
        type: 'TRANSLATE_TAB', tabId: requestedTab, settingsOverride,
      });
      // The worker can answer after translation finishes. Only this visit to the
      // requested tab may display its result; polling does not end that visit.
      if (selection !== requestedSelection || translationRequest !== request) return;
      if (!response?.ok) {
        const failure = new Error(
          response?.error?.message || 'Failed to start translation'
        );
        if (typeof response?.error?.code === 'string') failure.code = response.error.code;
        throw failure;
      }
      if (response.skipped) {
        invalidatedBody = null;
        minimumStateSequence = 0;
        await refreshSelected();
      }
    } catch (error) {
      if (selection !== requestedSelection || translationRequest !== request ||
        (startingState && (state.workerEpoch !== startingState.workerEpoch ||
          state.bodyVersion !== startingState.bodyVersion))) return;
      panelError = describeSidePanelFailure({
        message: error?.message || String(error), code: error?.code,
      });
      invalidatedBody = null;
      minimumStateSequence = 0;
      state = { ...state, status: 'idle', error: { message: panelError } };
      paint();
    }
  }
  paint();
  return {
    start(ownWindowId) {
      windowId = ownWindowId;
      return refresh();
    },
    refresh,
    activate(info) {
      if (info.windowId !== windowId) return Promise.resolve();
      ++queryVersion;
      select(info.tabId);
      return refreshSelected();
    },
    receive(msg) {
      if (msg?.type !== 'STATE_UPDATED' || msg.tabId !== tabId) return;
      const incoming = msg.state;
      if (!incoming || typeof incoming.workerEpoch !== 'string' ||
        retiredEpochs.has(incoming.workerEpoch)) return;
      if (incoming.workerEpoch !== state.workerEpoch) {
        if (pendingNotification?.workerEpoch !== incoming.workerEpoch ||
          incoming.stateSequence > pendingNotification.stateSequence) pendingNotification = incoming;
        recoverBody(incoming.workerEpoch, incoming.bodyVersion);
        return;
      }
      stateRequest = null;
      if (controlErrorTabId !== tabId) forgetControlError();
      acceptState(incoming);
      if (!hasBody) recoverBody(state.workerEpoch, state.bodyVersion);
    },
    runInlineControl,
    translate,
  };
}

function renderInlineTranslation(input) {
  const model = getInlineTranslationPanelViewModel(input);
  btnInlineTranslate.textContent = model.startText;
  btnInlineTranslate.disabled = model.startDisabled;
  btnInlineStop.disabled = model.stopDisabled;
  btnInlineRestore.disabled = model.restoreDisabled;
  elInlineStatus.textContent = model.statusText;
  elInlineError.hidden = !model.errorText;
  elInlineError.textContent = model.errorText;
}

async function loadSettings() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (!resp?.ok) return;
  const s = resp.settings;

  elTargetLanguage.value = s.targetLanguage || 'Korean';
  elTone.value = s.tone || 'technical';
  elModel.value = getEffectiveModelSettings(s).model;
  elModel.disabled = s.service === 'openrouter';
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
    ...(!elModel.disabled ? { model: elModel.value.trim() || DEFAULT_MODEL } : {}),
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

function setPanelText(element, text) {
  if (element.childNodes.length !== 1 || element.childNodes[0].nodeType !== 3 || element.textContent !== text) {
    element.textContent = text;
  }
}

function renderState(state, panelErrorMessage) {
  const viewMode = elViewMode.value || state?.settingsUsed?.viewMode || 'translation';
  const displayState = getSidepanelDisplayState(
    state || { status: 'idle' },
    viewMode
  );
  setStatus(displayState.statusText);
  btnTranslate.textContent = displayState.translateButtonText;
  btnTranslate.disabled = displayState.translateDisabled;

  if (displayState.errorText) setError(displayState.errorText);
  else if (panelErrorMessage) setError(panelErrorMessage);
  else setError(null);

  setProgress(displayState.progressText);

  setPanelText(elOriginal, displayState.originalText);
  if (elOriginal.lang !== displayState.originalLanguage) elOriginal.lang = displayState.originalLanguage;
  const translatedLanguage = displayState.translatedParts.length > 1 ? '' : displayState.translatedLanguage;
  if (elTranslated.lang !== translatedLanguage) elTranslated.lang = translatedLanguage;
  if (displayState.translatedParts.length > 1) {
    const children = elTranslated.childNodes;
    const unchanged = children.length === displayState.translatedParts.length &&
      displayState.translatedParts.every(([text, language], index) => {
        const child = children[index];
        return child.nodeType === 1 && child.tagName === 'SPAN' && child.lang === language &&
          child.childNodes.length === 1 && child.childNodes[0].nodeType === 3 && child.textContent === text;
      });
    if (!unchanged) {
      elTranslated.replaceChildren(...displayState.translatedParts.map(([text, language]) => {
        const span = document.createElement('span');
        span.lang = language;
        span.textContent = text;
        return span;
      }));
    }
  } else {
    setPanelText(elTranslated, displayState.translatedText);
  }
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
      b.tabIndex = active ? 0 : -1;
    }
    panels.original.hidden = which !== 'original';
    panels.translated.hidden = which !== 'translated';
  }

  buttons.forEach((b) => {
    b.addEventListener('click', () => activate(b.dataset.tab));
    b.addEventListener('keydown', (event) => {
      const index = buttons.indexOf(b);
      const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length
        : event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length
        : event.key === 'Home' ? 0
        : event.key === 'End' ? buttons.length - 1 : null;
      if (next === null) return;
      event.preventDefault();
      activate(buttons[next].dataset.tab);
      buttons[next].focus();
    });
  });
}

if (hasDocument) {
  let ownWindowId;
  const tabState = createTabStateController({
    queryActiveTab: async () => {
      const tabs = await chrome.tabs.query({ active: true, windowId: ownWindowId });
      return tabs?.[0] || null;
    },
    sendMessage: (message) => chrome.runtime.sendMessage(message),
    render(display) {
      renderState(display.state, display.panelError);
      renderInlineTranslation(display.inline);
    },
  });
  btnTranslate.addEventListener('click', () => tabState.translate(readSettings()));
  btnSave.addEventListener('click', () => settingsSaveController.save());
  document.getElementById('btnOpenOptions').addEventListener('click', () =>
    chrome.runtime.openOptionsPage()
  );
  elViewMode.addEventListener('change', () => tabState.refresh().catch(() => {}));
  btnInlineTranslate.addEventListener('click', () =>
    tabState.runInlineControl(INLINE_TRANSLATION_CONTROLS.START)
  );
  btnInlineStop.addEventListener('click', () =>
    tabState.runInlineControl(INLINE_TRANSLATION_CONTROLS.STOP)
  );
  btnInlineRestore.addEventListener('click', () =>
    tabState.runInlineControl(INLINE_TRANSLATION_CONTROLS.RESTORE)
  );
  chrome.runtime.onMessage.addListener((msg) => tabState.receive(msg));

  (async function init() {
    elModel.placeholder = DEFAULT_MODEL;
    setupTabs();
    await loadSettings();
    const ownWindow = await chrome.windows.getCurrent();
    ownWindowId = ownWindow.id;
    // Subscribe before querying: activation invalidates a query already in flight.
    chrome.tabs.onActivated.addListener((info) =>
      tabState.activate(info).catch(() => {})
    );
    const initialRefresh = tabState.start(ownWindow.id);
    setInterval(() => tabState.refresh().catch(() => {}), 1000);
    await initialRefresh;
  })().catch(() => {});
}

const sidepanelApi = {
  createSettingsSaveController,
  createTabStateController,
  formatOriginalPanelText,
  formatTranslatedPanelText,
  getInlineTranslationPanelViewModel,
  getSidepanelDisplayState,
  readInlineTranslationError,
};
globalThis.ChromeAiTranslatorSidepanel = sidepanelApi;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = sidepanelApi;
}
