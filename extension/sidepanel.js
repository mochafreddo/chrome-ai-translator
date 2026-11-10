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
const hasDocument = typeof document !== 'undefined';

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
  if (invocationErrorCode === 'content_script_not_ready' || invocationErrorCode === 'document.unavailable') {
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

function readInlineTranslationError(state) {
  return state?.inlineTranslationError?.message || '';
}

// One owner for the panel's tab selection and Inline Translation display. Adapters
// supply Chrome queries and messages; rendering observes only the public display state.
function createTabStateController({ queryActiveTab, readDocumentId, sendMessage: send, render }) {
  let tabId = null;
  let documentId;
  const sendMessage = (message) => send({ ...message, ...(documentId ? { documentId } : {}) });
  let selection = {};
  let queryVersion = 0;
  let stateRequest = null;
  let inlineRequest = null;
  let inlineControl = null;
  let windowId = null;
  let state = {};
  let snapshot = null;
  let controlError = '';
  let hasPageAccess = null;
  let pendingNotification = null;
  const retiredEpochs = new Set();

  function acceptState(incoming, currentRequest = true) {
    if (!incoming || typeof incoming.workerEpoch !== 'string' || !incoming.workerEpoch ||
      !Number.isSafeInteger(incoming.stateSequence) || incoming.stateSequence < 0 ||
      retiredEpochs.has(incoming.workerEpoch)) return;
    if (incoming.workerEpoch !== state.workerEpoch) {
      if (!currentRequest) return;
      if (state.workerEpoch) retiredEpochs.add(state.workerEpoch);
      state = {};
    }
    if (incoming.stateSequence < (state.stateSequence ?? 0) ||
        (!currentRequest && incoming.stateSequence === state.stateSequence)) return;
    state = incoming;
    paint();
    if (pendingNotification?.workerEpoch === state.workerEpoch) {
      const notification = pendingNotification;
      pendingNotification = null;
      acceptState(notification);
    }
  }

  async function refreshState(requestedSelection, requestedControl = null) {
    const request = stateRequest = {};
    const response = await sendMessage({ type: 'GET_STATE', tabId });
    if (selection !== requestedSelection ||
      (requestedControl && inlineControl !== requestedControl) || !response?.ok) return;
    acceptState(response.state, stateRequest === request);
  }

  function paint() {
    render({
      tabId, state,
      inline: { snapshot, controlError, invocationError: readInlineTranslationError(state), hasPageAccess,
        invocationErrorCode: state.inlineTranslationError?.code || '' },
    });
  }
  function forgetControlError() {
    controlError = '';
  }
  function select(nextTabId, nextDocumentId = null) {
    if (tabId === nextTabId && documentId === nextDocumentId) return;
    if (tabId !== null) {
      inlineControl = null;
    }
    tabId = nextTabId;
    documentId = nextDocumentId;
    selection = {};
    state = {};
    pendingNotification = null;
    retiredEpochs.clear();
    snapshot = null;
    forgetControlError();
    hasPageAccess = null;
    paint();
  }
  async function resolveTab() {
    const version = ++queryVersion;
    const tab = await queryActiveTab();
    // A newer selection wins, but a poll confirming the same tab must not swallow
    // a button action that was waiting for its own query.
    if (version !== queryVersion) return tabId !== null && tab?.id === tabId && tab?.documentId === documentId;
    select(tab?.id ?? null, tab?.documentId);
    return tabId !== null;
  }
  async function refreshSelected(requestedControl = null) {
    if (tabId === null) return;
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
    if (!documentId) return;
    const requestedControl = inlineControl = {};
    forgetControlError();
    paint();
    let requestedSelection = selection;
    try {
      if (!(await resolveTab())) return;
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
        paint();
        return;
      }
      await refreshSelected(requestedControl);
    } catch (error) {
      if (selection !== requestedSelection || inlineControl !== requestedControl) return;
      controlError = error?.message || String(error);
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
    async activate(info) {
      if (info.windowId !== windowId) return;
      const version = ++queryVersion;
      select(info.tabId);
      const currentDocument = await readDocumentId(info.tabId);
      if (version !== queryVersion) return;
      select(info.tabId, currentDocument);
      return refreshSelected();
    },
    navigate(info) {
      if (info.tabId !== tabId || info.frameId !== 0 || info.documentId === documentId) return;
      ++queryVersion;
      select(tabId, info.documentId);
      return refreshSelected();
    },
    receive(msg) {
      if (msg?.type !== 'STATE_UPDATED' || msg.tabId !== tabId) return;
      const incoming = msg.state;
      if ((incoming?.documentId ?? null) !== documentId) return;
      if (!incoming || typeof incoming.workerEpoch !== 'string' ||
        retiredEpochs.has(incoming.workerEpoch)) return;
      if (incoming.workerEpoch !== state.workerEpoch) {
        if (pendingNotification?.workerEpoch !== incoming.workerEpoch ||
          incoming.stateSequence > pendingNotification.stateSequence) pendingNotification = incoming;
        refreshState(selection).catch(() => {});
        return;
      }
      stateRequest = null;
      acceptState(incoming);
    },
    runInlineControl,
  };
}

function renderInlineTranslation(input) {
  const model = getInlineTranslationPanelViewModel(input);
  btnInlineTranslate.textContent = model.startText;
  btnInlineTranslate.disabled = model.startDisabled;
  btnInlineStop.disabled = model.stopDisabled;
  btnInlineRestore.disabled = model.restoreDisabled;
  if (elInlineStatus.textContent !== model.statusText) elInlineStatus.textContent = model.statusText;
  elInlineError.hidden = !model.errorText;
  if (elInlineError.textContent !== model.errorText) elInlineError.textContent = model.errorText;
}

if (hasDocument) {
  let ownWindowId;
  async function readDocumentId(tabId) {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null);
    return frame?.documentId || null;
  }
  const tabState = createTabStateController({
    queryActiveTab: async () => {
      const tabs = await chrome.tabs.query({ active: true, windowId: ownWindowId });
      const tab = tabs?.[0];
      if (!tab) return null;
      return { id: tab.id, documentId: await readDocumentId(tab.id) };
    },
    readDocumentId,
    sendMessage: (message) => {
      if (!message.documentId && message.type === 'GET_STATE') return chrome.runtime.sendMessage({ ...message, documentId: null });
      if (!message.documentId) return Promise.resolve({ ok: false, error: { message: MISSING_PAGE_ACCESS_MESSAGES.afterFailedAttempt } });
      return chrome.runtime.sendMessage(message);
    },
    render(display) {
      renderInlineTranslation(display.inline);
    },
  });
  document.getElementById('btnOpenOptions').addEventListener('click', () =>
    chrome.runtime.openOptionsPage()
  );
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
    const ownWindow = await chrome.windows.getCurrent();
    ownWindowId = ownWindow.id;
    // Subscribe before querying: activation invalidates a query already in flight.
    chrome.tabs.onActivated.addListener((info) =>
      tabState.activate(info).catch(() => {})
    );
    chrome.webNavigation.onCommitted.addListener(info => tabState.navigate(info)?.catch(() => {}));
    const initialRefresh = tabState.start(ownWindow.id);
    setInterval(() => tabState.refresh().catch(() => {}), 1000);
    await initialRefresh;
  })().catch(() => {});
}

const sidepanelApi = {
  createTabStateController,
  getInlineTranslationPanelViewModel,
  readInlineTranslationError,
};
globalThis.ChromeAiTranslatorSidepanel = sidepanelApi;
if (typeof module !== 'undefined' && module.exports) {
  module.exports = sidepanelApi;
}
