// content.js

var inlineBlockCodec =
  globalThis.ChromeAiTranslatorInlineBlock ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-block.js')
    : null);
var inlineDiagnosticsProtocol =
  globalThis.ChromeAiTranslatorInlineDiagnosticsProtocol ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-diagnostics-protocol.js')
    : null);
var markdownDocument =
  globalThis.ChromeAiTranslatorMarkdownDocument ||
  (typeof module !== 'undefined' && module.exports
    ? require('./markdown-document.js')
    : null);
var inlineTranslationControls =
  globalThis.ChromeAiTranslatorInlineTranslationControls ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-translation-controls.js')
    : null);
var inlineTranslationSession =
  globalThis.ChromeAiTranslatorInlineTranslationSession ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-translation-session.js')
    : null);

var INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
var INLINE_TRANSLATION_AUTH_MS = 5 * 60 * 1000;
var INLINE_VIEWPORT_SCAN_DEBOUNCE_MS = 250;
var INLINE_VIEWPORT_PREFETCH_RATIO = 0.5;
var INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES = 1200;
var INLINE_TRANSLATION_SETTINGS_DEFAULTS = inlineTranslationSession.SETTINGS_DEFAULTS;
var createInlineTranslationSettingsSnapshot = inlineTranslationSession.createSettingsSnapshot;
var INLINE_EXCLUDED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'CANVAS',
  'IFRAME',
  'NAV',
  'FOOTER',
  'FORM',
  'BUTTON',
  'INPUT',
  'TEXTAREA',
  'SELECT',
  'OPTION',
  'PRE',
  'CODE',
  'KBD',
  'SAMP',
]);
var INLINE_EXCLUDED_ROLES = new Set([
  'navigation',
  'banner',
  'contentinfo',
  'complementary',
  'search',
  'form',
  'button',
  'menu',
  'menubar',
  'tablist',
  'toolbar',
]);
function flushInlineLocalDiagnostics(store, state = inlineState) {
  if (!store?.localDiagnostics?.length || store.localDiagnosticsInFlight) return;
  const batch = {
    id: createInlineLocalDiagnosticBatchId(),
    diagnostics: store.localDiagnostics.splice(0, inlineDiagnosticsProtocol.limits.maxRecords),
    attempt: 0,
  };
  store.localDiagnosticsInFlight = batch;
  sendInlineLocalDiagnosticBatch(store, batch, state);
}

// The page's own crypto, named here rather than inside the protocol object: the token is
// minted with whatever crypto its caller mints it with, and in the page that is the page's.
function createInlineLocalDiagnosticBatchId() {
  return inlineDiagnosticsProtocol.createUuidV4(globalThis.crypto);
}

function sendInlineLocalDiagnosticBatch(store, batch, state = inlineState) {
  const fail = () => {
    if (batch.attempt < 1 && store.localDiagnosticsInFlight === batch) {
      batch.attempt += 1;
      scheduleInlineLocalDiagnosticTask(store, () => sendInlineLocalDiagnosticBatch(store, batch, state), 250);
    } else {
      store.diagnosticsUnavailable = true;
      if (store.localDiagnosticsInFlight === batch) store.localDiagnosticsInFlight = null;
      if (store.localDiagnostics.length) {
        scheduleInlineLocalDiagnosticTask(store, () => flushInlineLocalDiagnostics(store, state), 250);
      }
    }
    if (store.diagnosticsUnavailable && state.viewport === store && state.session.operationId === store.operationId) {
      updateInlineViewportMessage(state);
    }
  };
  chrome.runtime.sendMessage({
    type: inlineDiagnosticsProtocol.messages.recordLocal,
    diagnosticBatchId: batch.id,
    operationId: store.operationId,
    settingsSnapshot: store.translationSettings,
    diagnostics: batch.diagnostics,
  }).then((response) => {
    if (response?.ok !== true) {
      fail();
      return;
    }
    if (store.localDiagnosticsInFlight === batch) store.localDiagnosticsInFlight = null;
    if (store.localDiagnostics.length) {
      scheduleInlineLocalDiagnosticTask(store, () => flushInlineLocalDiagnostics(store, state), 0);
    }
  }).catch(fail);
}

function scheduleInlineLocalDiagnosticTask(store, task, delay) {
  if (store.localDiagnosticRetryTimer) clearTimeout(store.localDiagnosticRetryTimer);
  store.localDiagnosticRetryTimer = setTimeout(() => {
    store.localDiagnosticRetryTimer = null;
    if (!store.stopped) task();
  }, delay);
}

function drainInlineLocalDiagnosticsOnStop(store, resendInFlight, state = inlineState) {
  if (resendInFlight && store.localDiagnosticsInFlight) {
    const inFlight = store.localDiagnosticsInFlight;
    store.localDiagnosticsInFlight = null;
    sendInlineLocalDiagnosticBatch(store, inFlight, state);
  }
  while (store.localDiagnostics.length) {
    sendInlineLocalDiagnosticBatch(store, {
      id: createInlineLocalDiagnosticBatchId(),
      diagnostics: store.localDiagnostics.splice(0, inlineDiagnosticsProtocol.limits.maxRecords),
      attempt: 1,
    }, state);
  }
}

function isInlineViewportOperationCurrent(state, store, operationId) {
  return Boolean(state && store && state.viewport === store && state.session.isCurrent(operationId));
}

// The session ends the operation's Semantic Block work; what is left here is the scanner's
// timer and the last chance to send the local diagnostics the operation queued.
function stopInlineViewportTranslation(state = inlineState) {
  const store = state.viewport;
  const hasPendingDiagnosticTask = Boolean(store.localDiagnosticRetryTimer);
  const operationId = state.session.stop();
  store.stopped = true;
  if (store.scanTimer) {
    clearTimeout(store.scanTimer);
    store.scanTimer = null;
  }
  if (store.localDiagnosticRetryTimer) {
    clearTimeout(store.localDiagnosticRetryTimer);
    store.localDiagnosticRetryTimer = null;
  }
  drainInlineLocalDiagnosticsOnStop(store, hasPendingDiagnosticTask, state);
  return operationId;
}

// A run is live from the moment Start hands it to the viewport scanner until something
// stops it. Pressing Start again while it is — from either of the two homes, both of which
// leave Start pressable — is the only thing the reader can do that would pay for the same
// page twice, so `translateInlinePage` answers it with a rescan of what has scrolled into
// view rather than a second run. A stopped run no longer admits work; Start begins a new
// operation while submitted requests can still settle against the same Session Budget.
function isInlineTranslationRunLive(state = inlineState) {
  return state?.session?.status === 'active' && !state?.viewport?.stopped;
}

function hasInlineSettingsApiKey(settings) {
  return Boolean(settings?.apiKey);
}

// The background worker decides what should happen on this page; this script carries the
// decision out. It deliberately does not read settings to work out whether the Floating
// Translate Button belongs here — that judgment lives in the worker's planning function so
// that injecting this script and granting Inline Translation Authorization can happen
// without the button being mounted.
//
// Inline Translation has two homes — the Floating Translate Button and the Inline
// Translation Section in the side panel — and the section reaches this script the same way
// the worker does. So the three controls are instructions too, and each has one
// implementation here whatever pressed it.
function getDefaultInlineInstructionHandlers(state = inlineState) {
  return {
    grantInlineTranslationAuthorization: () => authorizeInlineTranslation(state),
    mountFloatingTranslateButton: () => ensureInlineTranslatorUi(state),
    startInlineTranslation: () => startInlineTranslationRun(state),
    stopInlineTranslation: () => stopInlineTranslationRun(state),
    restoreInlineOriginal: () => restoreInlineOriginal(state),
  };
}

function runInlineInstruction(
  instruction,
  handlers = getDefaultInlineInstructionHandlers()
) {
  const handler = handlers?.[instruction];
  if (!handler) return false;
  handler();
  return true;
}

// Instructions are independent of one another, as the worker's own plan steps are: one
// that cannot be carried out must not cost the page the rest of them.
function runInlineInstructions(instructions = [], handlers) {
  for (const instruction of instructions) {
    try {
      runInlineInstruction(instruction, handlers);
    } catch {}
  }
}

// Closing the Floating Translate Button is a "move this out of my way now" gesture, not a
// preference. Nothing records it, and nothing needs to: the button is gone exactly while
// its UI is detached, which is the same state the page is in before the reader ever
// invokes the extension, and the same instruction ends both. Every render path runs
// through updateInlineTranslatorUi, which does nothing without a UI, so page activity
// cannot bring it back — only a mount instruction can.
//
// What does survive the gesture is the menu: leaving it open would re-mount the button
// with its menu already down, which is not what the reader asked for.
function closeFloatingTranslateButton(state = inlineState) {
  state.menuOpen = false;
  return state;
}

async function requestInlineStartupInstructions(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.sendMessage) return [];
  const response = await chromeApi.runtime.sendMessage({
    type: 'GET_INLINE_STARTUP_INSTRUCTIONS',
  });
  if (!response?.ok || !Array.isArray(response.instructions)) return [];
  return response.instructions;
}

// The viewport scanner and diagnostic transport belong to the page, separate from the
// session's Semantic Block state. The outbox is the session's transport interface.
function createInlineViewportState(session, settings = null) {
  return {
    operationId: session.operationId,
    translationSettings: settings,
    localDiagnostics: session.outbox,
    stopped: false,
  };
}

function createInlineTranslationState(overrides = {}) {
  const session = inlineTranslationSession.createInlineTranslationSession();
  return {
    menuOpen: false,
    message: '',
    error: '',
    authorizedUntil: 0,
    session,
    viewport: createInlineViewportState(session),
    ...overrides,
  };
}

var inlineState =
  globalThis.__chromeAiTranslatorInlineState || createInlineTranslationState();
globalThis.__chromeAiTranslatorInlineState = inlineState;
var inlineUiRoot = globalThis.__chromeAiTranslatorInlineUiRoot || null;

async function refreshInlineTranslatorSettings(
  chromeApi = globalThis.chrome,
  state = inlineState
) {
  if (!chromeApi?.runtime?.sendMessage) return null;
  const response = await chromeApi.runtime.sendMessage({ type: 'GET_SETTINGS' });
  if (!response?.ok) return null;
  const snapshot = createInlineTranslationSettingsSnapshot(response.settings);
  state.translationSettings = snapshot;
  return snapshot;
}

function isInlineTranslationExcludedTag(tagName) {
  return INLINE_EXCLUDED_TAGS.has(String(tagName || '').toUpperCase());
}

function isInlineTranslationExcludedElement(el) {
  if (!el) return false;
  if (isInlineTranslationExcludedTag(el.tagName)) return true;
  const role = String(el.getAttribute?.('role') || '').toLowerCase();
  return INLINE_EXCLUDED_ROLES.has(role);
}

function isInlineEffectivelyEditable(element) {
  if (element?.isContentEditable === true) return true;
  for (let current = element; current; current = current.parentElement) {
    if (!current.hasAttribute?.('contenteditable')) continue;
    return (
      String(current.getAttribute?.('contenteditable') || '').toLowerCase() !==
      'false'
    );
  }
  return false;
}

function isTrustedInlineUiEvent(event) {
  return event?.isTrusted === true;
}

function getInlineShadowMode() {
  return 'closed';
}

function getInlineHostStyleText() {
  return [
    'all: initial !important',
    'position: fixed !important',
    'right: 18px !important',
    'bottom: 18px !important',
    'z-index: 2147483647 !important',
    'display: block !important',
    'width: auto !important',
    'height: auto !important',
    'margin: 0 !important',
    'padding: 0 !important',
    'border: 0 !important',
    'background: transparent !important',
    'pointer-events: auto !important',
  ].join('; ');
}

function isInlineRectInViewport(
  rect,
  viewport,
  prefetchRatio = INLINE_VIEWPORT_PREFETCH_RATIO
) {
  if (!rect || !viewport) return false;
  const width = Number(viewport.width) || 0;
  const height = Number(viewport.height) || 0;
  if (width <= 0 || height <= 0) return false;

  const margin = height * prefetchRatio;
  const top = Number(rect.top);
  const bottom = Number(rect.bottom);
  const left = Number(rect.left);
  const right = Number(rect.right);

  if (![top, bottom, left, right].every(Number.isFinite)) return false;
  if (bottom < -margin) return false;
  if (top > height + margin) return false;
  if (right < 0) return false;
  if (left > width) return false;
  return true;
}

function findInlineSemanticBlock(textNode, root) {
  for (
    let element = textNode?.parentElement;
    element;
    element = element.parentElement
  ) {
    if (inlineBlockCodec?.isSemanticBlockElement(element)) {
      return element;
    }
    if (element === root) break;
  }
  return null;
}

function formatInlineViewportStatusMessage(counts, status = 'active') {
  const safe = counts || {};
  const stopped = status === 'stopped';
  return [
    stopped ? 'Visible translation stopped' : 'Visible translation on',
    `Translated ${Number(safe.translated) || 0} · Partial ${
      Number(safe.partial) || 0
    } · Pending ${
      stopped ? 0 : Number(safe.pending) || 0
    } · Changed ${Number(safe.changed) || 0} · Failed ${
      Number(safe.failed) || 0
    }`,
  ].join('\n');
}

// What the Floating Translate Button shows. Progress and errors are deliberately absent:
// they are single-sourced in the Inline Translation Section, so the button carries the
// controls alone and there is no two-way synchronisation to maintain.
function getInlineTranslatorUiModel(
  state = inlineState,
  settings = state?.translationSettings || INLINE_TRANSLATION_SETTINGS_DEFAULTS
) {
  const status = state?.session?.status || 'original';
  const targetLanguage =
    settings?.targetLanguage || INLINE_TRANSLATION_SETTINGS_DEFAULTS.targetLanguage;
  const menuOpen = Boolean(state?.menuOpen);
  // Which controls are on offer is the shared rule; only the labels are this home's own.
  // Start is not among the rules — it stays pressable in every status, and reads as a
  // rescan once a run is live.
  const { isActive, canStop, canRestore } =
    inlineTranslationControls.getInlineTranslationControlAvailability(status);

  return {
    toggleText: isActive
      ? 'Translated'
      : status === 'stopped'
      ? 'Stopped'
      : 'Translate',
    menuOpen,
    translateText: isActive ? 'Scan visible text' : `Page in ${targetLanguage}`,
    stopDisabled: !canStop,
    restoreDisabled: !canRestore,
    expanded: String(menuOpen),
  };
}

async function toggleInlineTranslatorMenu(
  chromeApi = globalThis.chrome,
  state = inlineState,
  renderUi = () => updateInlineTranslatorUi(state)
) {
  state.menuOpen = !Boolean(state.menuOpen);
  renderUi?.();
  if (!state.menuOpen) return state.menuOpen;
  try {
    await refreshInlineTranslatorSettings(chromeApi, state);
  } catch {}
  renderUi?.();
  return state.menuOpen;
}

function restoreInlineViewportRecords(state = inlineState) {
  const viewport = state.viewport;
  if (viewport.observer) {
    viewport.observer.disconnect();
  }
  if (viewport.scanTimer) {
    clearTimeout(viewport.scanTimer);
  }
  state.session.restore();
  state.viewport = createInlineViewportState(state.session);
}

function authorizeInlineTranslation(state = inlineState, now = Date.now()) {
  state.authorizedUntil = now + INLINE_TRANSLATION_AUTH_MS;
}

function authorizeInlineTranslationFromUiEvent(
  event,
  state = inlineState,
  now = Date.now()
) {
  if (!isTrustedInlineUiEvent(event)) return false;
  authorizeInlineTranslation(state, now);
  return true;
}

function hasInlineTranslationAuthorization(state = inlineState, now = Date.now()) {
  return Number(state.authorizedUntil) > now;
}

function pickArticleRoot() {
  const candidates = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.body,
  ].filter(Boolean);

  // Choose the candidate with the most text, but prefer article/main
  let best = candidates[0];
  let bestLen = (best?.innerText || '').trim().length;
  for (const el of candidates) {
    const len = (el.innerText || '').trim().length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }

  // If article exists and isn't tiny, use it even if not maximal.
  const article = document.querySelector('article');
  if (article && (article.innerText || '').trim().length > 400) return article;

  return best;
}

function buildArticleExtraction(root, metadata) {
  const translationDocument = markdownDocument.serializeMarkdownDocument(
    root,
    metadata
  );
  return {
    ...metadata,
    contentMarkdown: markdownDocument.renderOriginalMarkdown(
      translationDocument
    ),
    translationDocument,
  };
}

function isElementHidden(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    el.hidden ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

function getInlineViewportInfo() {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 0,
    height: window.innerHeight || document.documentElement.clientHeight || 0,
  };
}

function getInlineTextNodeRect(textNode) {
  try {
    const range = document.createRange();
    range.selectNodeContents(textNode);
    const rect = range.getBoundingClientRect();
    range.detach?.();
    if (rect && (rect.width || rect.height)) return rect;
  } catch {}
  return textNode.parentElement?.getBoundingClientRect?.() || null;
}

function isInlineTextNodeInViewport(textNode, viewport = getInlineViewportInfo()) {
  return isInlineRectInViewport(
    getInlineTextNodeRect(textNode),
    viewport
  );
}

function shouldSkipInlineBlockCandidateTextNode(textNode) {
  const parent = textNode?.parentElement;
  if (!parent) return true;
  if (parent.closest(`#${INLINE_TRANSLATOR_ID}`)) return true;
  if (isInlineEffectivelyEditable(parent)) return true;
  for (let element = parent; element; element = element.parentElement) {
    if (isInlineTranslationExcludedElement(element)) return true;
    if (isElementHidden(element)) return true;
  }
  const value = String(textNode.nodeValue || '').replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z]/.test(value)) return true;
  return inlineBlockCodec.isCodeLikeInlineText(value);
}

function normalizeInlineViewportScanLimit(maxTextNodes) {
  const parsed = Number(maxTextNodes);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES;
  }
  return Math.floor(parsed);
}

function isInlineTextNode(node) {
  return Boolean(node && node.nodeType === 3);
}

function shouldSkipInlineElementSubtree(node, viewport = getInlineViewportInfo()) {
  if (!node || !(node instanceof HTMLElement)) return false;
  if (node.closest?.(`#${INLINE_TRANSLATOR_ID}`)) return true;
  if (
    isInlineTranslationExcludedElement(node) ||
    isInlineEffectivelyEditable(node) ||
    isElementHidden(node)
  ) {
    return true;
  }
  const rect = node.getBoundingClientRect?.();
  return rect ? !isInlineRectInViewport(rect, viewport) : false;
}

function getInlineChildNodes(node) {
  return Array.from(node?.childNodes || []);
}

// Collects visible blocks through the session, retaining only scan position on the page.
function collectVisibleInlineBlocks(
  root,
  state,
  maxTextNodes = INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES
) {
  const limit = normalizeInlineViewportScanLimit(maxTextNodes);
  const store = state.viewport;
  const startIndex = Math.max(0, Number(store.scanStartIndex) || 0);
  const viewport = getInlineViewportInfo();
  const queued = [];
  const queuedBlocks = new Set();
  const stack = [root];
  let textIndex = 0;
  let inspected = 0;
  let truncated = false;

  while (stack.length) {
    const node = stack.pop();
    if (isInlineTextNode(node)) {
      if (textIndex < startIndex) {
        textIndex += 1;
        continue;
      }
      if (inspected >= limit) {
        truncated = true;
        break;
      }
      textIndex += 1;
      inspected += 1;
      if (
        !shouldSkipInlineBlockCandidateTextNode(node) &&
        isInlineTextNodeInViewport(node, viewport)
      ) {
        const block = findInlineSemanticBlock(node, root);
        if (block && !queuedBlocks.has(block)) {
          queuedBlocks.add(block);
          const record = state.session.admit(block);
          if (record) queued.push(record);
        }
      }
      continue;
    }

    if (shouldSkipInlineElementSubtree(node, viewport)) continue;
    const children = getInlineChildNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }

  if (store) store.scanStartIndex = truncated ? textIndex : 0;
  return queued;
}

// Progress and errors are kept apart because the side panel, which is now the only place
// either is shown, has a line for each: one string would leave it guessing which it held.
// Progress is written by `updateInlineViewportMessage`, which counts Semantic Blocks.
function setInlineErrorMessage(message, state = inlineState) {
  state.error = message || '';
  updateInlineTranslatorUi(state);
}

function clearInlineFeedback(state = inlineState) {
  state.message = '';
  state.error = '';
  updateInlineTranslatorUi(state);
}

// What the side panel reads to decide what the Inline Translation Section shows. This
// script keeps the state; the section's own view model decides how it reads.
function getInlineTranslationStatusSnapshot(state = inlineState) {
  return {
    status: state?.session?.status || 'original',
    progress: state?.message || '',
    error: state?.error || '',
  };
}

// Why part of a run will not finish. This is an error, not progress: it belongs on the
// line the panel raises rather than the one it keeps muted, which is what telling the two
// apart in the state was for.
function formatInlineViewportReasons(terminalReason, diagnosticsUnavailable = false) {
  const reasons = [];
  if (terminalReason) reasons.push(terminalReason);
  if (diagnosticsUnavailable) reasons.push('Diagnostics could not be saved.');
  return reasons.join('\n');
}

// The counts are progress. A reason that has been reached is not withdrawn by a later
// scan, so this only ever sets one — the reader's next attempt is what clears it.
function updateInlineViewportMessage(state = inlineState) {
  const { counts, reason } = state.session.progress();
  state.message = formatInlineViewportStatusMessage(counts, state.session.status);
  const errorText = formatInlineViewportReasons(
    reason,
    Boolean(state.viewport.diagnosticsUnavailable)
  );
  if (errorText) state.error = errorText;
  updateInlineTranslatorUi(state);
}

function detachInlineTranslatorUi() {
  document.getElementById(INLINE_TRANSLATOR_ID)?.remove();
  inlineUiRoot = null;
  globalThis.__chromeAiTranslatorInlineUiRoot = null;
}

function ensureInlineTranslatorUi(state = inlineState) {
  let host = document.getElementById(INLINE_TRANSLATOR_ID);
  if (host && inlineUiRoot) {
    refreshInlineTranslatorSettings(globalThis.chrome, state)
      .then(() => updateInlineTranslatorUi(state))
      .catch(() => {});
    return host;
  }
  if (host) host.remove();

  host = document.createElement('div');
  host.id = INLINE_TRANSLATOR_ID;
  host.style.cssText = getInlineHostStyleText();
  (document.body || document.documentElement).appendChild(host);

  inlineUiRoot = host.attachShadow({ mode: getInlineShadowMode() });
  globalThis.__chromeAiTranslatorInlineUiRoot = inlineUiRoot;
  inlineUiRoot.innerHTML = `
    <style>
    :host {
      all: initial;
    }
    [data-role="container"] {
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #111827;
    }
    button {
      border: 1px solid #d1d5db;
      border-radius: 6px;
      background: #fff;
      color: #111827;
      cursor: pointer;
      min-height: 44px;
      padding: 7px 10px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.16);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }
    [data-role="menu"] {
      display: grid;
      gap: 6px;
      margin-bottom: 8px;
      padding: 8px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
    }
    [hidden] {
      display: none !important;
    }
    </style>
    <div data-role="container">
      <button type="button" data-role="toggle" aria-expanded="false">Translate</button>
      <div data-role="menu" hidden>
        <button type="button" data-action="translate">Page in Korean</button>
        <button type="button" data-action="stop">Stop</button>
        <button type="button" data-action="restore">Original text</button>
        <button type="button" data-action="close">Hide this button</button>
      </div>
    </div>
  `;

  inlineUiRoot.querySelector('[data-role="toggle"]').addEventListener('click', (event) => {
    if (!isTrustedInlineUiEvent(event)) return;
    toggleInlineTranslatorMenu(globalThis.chrome, state).catch(() =>
      updateInlineTranslatorUi(state)
    );
  });
  inlineUiRoot
    .querySelector('[data-action="translate"]')
    .addEventListener('click', (event) => {
      if (!authorizeInlineTranslationFromUiEvent(event, state)) return;
      startInlineTranslationRun(state);
    });
  inlineUiRoot
    .querySelector('[data-action="stop"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      stopInlineTranslationRun(state);
    });
  inlineUiRoot
    .querySelector('[data-action="restore"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      restoreInlineOriginal(state);
    });
  inlineUiRoot
    .querySelector('[data-action="close"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      // Only the UI goes. A translation already under way keeps running and keeps its
      // records, so the reader can bring the button back and pick it up where it is.
      closeFloatingTranslateButton(state);
      detachInlineTranslatorUi();
    });

  updateInlineTranslatorUi(state);
  refreshInlineTranslatorSettings(globalThis.chrome, state)
    .then(() => updateInlineTranslatorUi(state))
    .catch(() => {});
  return host;
}

function updateInlineTranslatorUi(state = inlineState) {
  if (!inlineUiRoot) return;
  const toggle = inlineUiRoot.querySelector('[data-role="toggle"]');
  const menu = inlineUiRoot.querySelector('[data-role="menu"]');
  const translate = inlineUiRoot.querySelector('[data-action="translate"]');
  const stop = inlineUiRoot.querySelector('[data-action="stop"]');
  const restore = inlineUiRoot.querySelector('[data-action="restore"]');
  const model = getInlineTranslatorUiModel(state);

  toggle.textContent = model.toggleText;
  toggle.setAttribute('aria-expanded', model.expanded);
  menu.hidden = !model.menuOpen;
  translate.textContent = model.translateText;
  stop.disabled = model.stopDisabled;
  restore.disabled = model.restoreDisabled;
}

function runInlineViewportScan(state = inlineState) {
  const store = state.viewport;
  if (!store || store.stopped || state.session.status !== 'active') return;
  const root = store.root || pickArticleRoot();
  if (!root) {
    setInlineErrorMessage('No article content found.', state);
    return;
  }
  store.root = root;
  collectVisibleInlineBlocks(root, state);
  if (store.scanStartIndex > 0) {
    scheduleInlineViewportScan(state);
  }
  updateInlineViewportMessage(state);
  drainInlineViewportQueue(state).catch((error) =>
    setInlineErrorMessage(error?.message || String(error), state)
  );
}

function scheduleInlineViewportScan(state = inlineState, options = {}) {
  const store = state.viewport;
  if (!store || store.stopped || state.session.status !== 'active') return;
  if (options?.resetScanStartIndex) {
    store.scanStartIndex = 0;
    state.session.resetQueue();
  }
  if (store.scanTimer) clearTimeout(store.scanTimer);
  store.scanTimer = setTimeout(() => {
    store.scanTimer = null;
    runInlineViewportScan(state);
  }, INLINE_VIEWPORT_SCAN_DEBOUNCE_MS);
}

function scheduleInlineViewportScanFromViewportChange(state = inlineState) {
  scheduleInlineViewportScan(state, { resetScanStartIndex: true });
}

function isInlineScrollableElement(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY || style.overflow || '';
  if (!/(auto|scroll|overlay)/.test(overflowY)) return false;
  return Number(el.scrollHeight) > Number(el.clientHeight) + 1;
}

function getInlineViewportScrollTargets(root) {
  const targets = [];
  const seen = new Set();
  const addTarget = (target) => {
    if (!target || seen.has(target) || !target.addEventListener) return;
    targets.push(target);
    seen.add(target);
  };

  addTarget(window);
  addTarget(document);
  addTarget(document.scrollingElement);
  addTarget(document.documentElement);
  addTarget(document.body);

  for (let el = root; el; el = el.parentElement) {
    if (isInlineScrollableElement(el)) {
      addTarget(el);
    }
  }

  return targets;
}

// The listener is made here rather than being one module-level function, because it has
// to carry the state whose store the scan it schedules belongs to. It is kept on that
// store so detaching removes the same reference attaching added: a fresh closure per call
// would leave every scroll target holding a listener nothing can take off again.
function attachInlineViewportWatchers(root, state = inlineState) {
  const store = state.viewport;
  const onViewportChange = () =>
    scheduleInlineViewportScanFromViewportChange(state);
  const scrollTargets = getInlineViewportScrollTargets(root);
  for (const target of scrollTargets) {
    target.addEventListener('scroll', onViewportChange, { passive: true });
  }
  window.addEventListener('resize', onViewportChange);

  const observer = new MutationObserver(onViewportChange);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  store.observer = observer;
  store.scrollTargets = scrollTargets;
  store.viewportChangeListener = onViewportChange;
}

function detachInlineViewportWatchers(state = inlineState) {
  const store = state.viewport;
  const onViewportChange = store?.viewportChangeListener;
  if (onViewportChange) {
    for (const target of store.scrollTargets || []) {
      target?.removeEventListener?.('scroll', onViewportChange);
    }
    window.removeEventListener('resize', onViewportChange);
  }
  if (store) {
    store.scrollTargets = [];
    store.viewportChangeListener = null;
    if (store.observer) {
      store.observer.disconnect();
      store.observer = null;
    }
  }
}

// Sends the worker what settling a batch said the page must file. The worker failing to take
// it is reported only while the operation it belongs to is still the one on the page.
function fileInlineRuntimeOutcomes(state, store, operationId, { runtimeOutcomes, releaseTokens }) {
  if (!runtimeOutcomes.length && !releaseTokens.length) return;
  const unavailable = () => {
    if (!isInlineViewportOperationCurrent(state, store, operationId)) return;
    store.diagnosticsUnavailable = true;
    updateInlineViewportMessage(state);
  };
  chrome.runtime.sendMessage({
    type: inlineDiagnosticsProtocol.messages.recordRuntime,
    operationId,
    outcomes: runtimeOutcomes,
    releaseTokens,
  }).then((diagnosticResponse) => {
    if (diagnosticResponse?.ok !== true) unavailable();
  }, unavailable);
}

// Transport for the session's batches: each one it hands over is sent, and what comes back,
// or nothing when the request failed, goes straight back to it to settle.
async function drainInlineViewportQueue(state = inlineState) {
  const store = state.viewport;
  if (store.stopped || state.session.status !== 'active') return;
  const operationId = store.operationId;
  flushInlineLocalDiagnostics(store, state);

  while (isInlineViewportOperationCurrent(state, store, operationId)) {
    const batch = state.session.takeBatch();
    flushInlineLocalDiagnostics(store, state);
    updateInlineViewportMessage(state);
    if (!batch.length) return;

    chrome.runtime
      .sendMessage({
        type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        operationId,
        validateTranslationCompleteness: true,
        settingsSnapshot: store.translationSettings,
        records: batch.map((record) => ({
          id: record.id,
          template: record.template,
          atoms: record.atoms,
          contract: record.contract,
          repair: record.repair,
        })),
      })
      .catch(() => null)
      .then((response) => {
        const settled = state.session.settle(batch, response);
        if (settled.diagnosticsUnavailable) store.diagnosticsUnavailable = true;
        fileInlineRuntimeOutcomes(state, store, operationId, settled);
      })
      // Settling has already accounted for every block; a filing that throws, as sending does
      // once the extension context is gone, leaves nothing for the reader to act on.
      .catch(() => {})
      .finally(() => {
        if (!isInlineViewportOperationCurrent(state, store, operationId)) {
          return;
        }
        updateInlineViewportMessage(state);
        drainInlineViewportQueue(state).catch((error) =>
          setInlineErrorMessage(error?.message || String(error), state)
        );
      });
  }
}

// Begins an Inline Translation Operation, holding what the session carried over from the
// operation it replaces.
function beginInlineTranslationOperation(state, settingsSnapshot) {
  state.translationSettings = settingsSnapshot;
  state.session.begin(settingsSnapshot);
  state.viewport = createInlineViewportState(state.session, settingsSnapshot);
  return state.viewport;
}

async function translateInlinePage(state = inlineState) {
  if (isInlineTranslationRunLive(state)) {
    scheduleInlineViewportScan(state);
    updateInlineViewportMessage(state);
    return;
  }
  if (!hasInlineTranslationAuthorization(state)) {
    setInlineErrorMessage(
      'Use the extension toolbar or shortcut first to authorize inline translation.',
      state
    );
    return;
  }
  const settingsResponse = await chrome.runtime.sendMessage({
    type: 'GET_SETTINGS',
  });
  if (!settingsResponse?.ok) {
    throw new Error(
      settingsResponse?.error?.message || 'Unable to load extension settings.'
    );
  }
  if (!hasInlineSettingsApiKey(settingsResponse.settings)) {
    setInlineErrorMessage('Open Options and paste your OpenAI API key.', state);
    return;
  }

  const root = pickArticleRoot();
  if (!root) throw new Error('No article content found.');

  detachInlineViewportWatchers(state);
  beginInlineTranslationOperation(
    state,
    createInlineTranslationSettingsSnapshot(settingsResponse.settings)
  );
  state.viewport.root = root;

  attachInlineViewportWatchers(root, state);
  runInlineViewportScan(state);
}

function restoreInlineOriginal(state = inlineState) {
  detachInlineViewportWatchers(state);
  restoreInlineViewportRecords(state);
  clearInlineFeedback(state);
  updateInlineTranslatorUi(state);
}

// The three Inline Translation controls, each with one body whichever of its two homes
// pressed it. Starting clears what the last attempt reported: the reader is asking again,
// so the previous answer is no longer the current one.
function startInlineTranslationRun(state = inlineState) {
  setInlineErrorMessage('', state);
  translateInlinePage(state).catch((error) =>
    setInlineErrorMessage(error?.message || String(error), state)
  );
}

function stopInlineTranslationRun(state = inlineState) {
  stopInlineViewportTranslation(state);
  detachInlineViewportWatchers(state);
  updateInlineViewportMessage(state);
}

async function initInlineTranslator(state = inlineState) {
  try {
    runInlineInstructions(
      await requestInlineStartupInstructions(),
      getDefaultInlineInstructionHandlers(state)
    );
  } catch {}
}

function handleExtractArticle(sendResponse) {
  try {
    const root = pickArticleRoot();
    const metadata = {
      title: (document.title || '').trim(),
      url: location.href,
      langHint: document.documentElement?.lang || '',
    };
    const data = buildArticleExtraction(root, metadata);

    // Basic sanity check: if too small, fall back to body
    if ((data.contentMarkdown || '').length < 300 && root !== document.body) {
      const data2 = buildArticleExtraction(document.body, metadata);
      sendResponse({ ok: true, data: data2 });
      return;
    }

    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: { message: e?.message || String(e) } });
  }
}

// Every message this script answers, in one place and against the state it is answering
// for. Returning `true` holds the response channel open until `sendResponse` has run;
// returning nothing says this script has no answer, which is how a message meant for
// another listener passes through untouched.
function handleInlineContentMessage(msg, sendResponse, state = inlineState) {
  if (msg?.type === 'EXTRACT_ARTICLE') {
    handleExtractArticle(sendResponse);
    return true;
  }

  if (msg?.type === 'RUN_INLINE_INSTRUCTION') {
    try {
      if (
        !runInlineInstruction(
          msg.instruction,
          getDefaultInlineInstructionHandlers(state)
        )
      ) {
        throw new Error(`Unknown inline instruction: ${msg.instruction}`);
      }
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({
        ok: false,
        error: { message: e?.message || String(e) },
      });
    }
    return true;
  }

  if (msg?.type === 'GET_INLINE_TRANSLATION_STATE') {
    sendResponse({
      ok: true,
      snapshot: getInlineTranslationStatusSnapshot(state),
    });
    return true;
  }

  return undefined;
}

if (
  typeof chrome !== 'undefined' &&
  chrome.runtime?.onMessage &&
  !globalThis.__chromeAiTranslatorContentInitialized
) {
  globalThis.__chromeAiTranslatorContentInitialized = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) =>
    handleInlineContentMessage(msg, sendResponse)
  );

  initInlineTranslator();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isInlineTranslationExcludedTag,
    isInlineTranslationExcludedElement,
    isCodeLikeInlineText: inlineBlockCodec.isCodeLikeInlineText,
    buildArticleExtraction,
    isTrustedInlineUiEvent,
    authorizeInlineTranslation,
    authorizeInlineTranslationFromUiEvent,
    hasInlineTranslationAuthorization,
    getInlineShadowMode,
    getInlineHostStyleText,
    isInlineRectInViewport,
    collectVisibleInlineBlocks,
    isInlineViewportOperationCurrent,
    stopInlineViewportTranslation,
    isInlineTranslationRunLive,
    hasInlineSettingsApiKey,
    getDefaultInlineInstructionHandlers,
    closeFloatingTranslateButton,
    runInlineInstruction,
    runInlineInstructions,
    requestInlineStartupInstructions,
    refreshInlineTranslatorSettings,
    beginInlineTranslationOperation,
    findInlineSemanticBlock,
    flushInlineLocalDiagnostics,
    formatInlineViewportStatusMessage,
    formatInlineViewportReasons,
    getInlineTranslationStatusSnapshot,
    handleInlineContentMessage,
    createInlineTranslationState,
    attachInlineViewportWatchers,
    detachInlineViewportWatchers,
    getInlineTranslatorUiModel,
    toggleInlineTranslatorMenu,
    runInlineViewportScan,
    scheduleInlineViewportScanFromViewportChange,
    getInlineViewportScrollTargets,
    restoreInlineViewportRecords,
    restoreInlineOriginal,
  };
}
