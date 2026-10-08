// content.js

var inlineBlockCodec =
  globalThis.ChromeAiTranslatorInlineBlock ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-block.js')
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

var inlineTranslationOperation =
  globalThis.ChromeAiTranslatorInlineTranslationOperation ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-translation-operation.js')
    : null);

var INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
var INLINE_TRANSLATION_SETTINGS_DEFAULTS = inlineTranslationSession.SETTINGS_DEFAULTS;
var createInlineTranslationSettingsSnapshot = inlineTranslationSession.createSettingsSnapshot;

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
    grantInlineTranslationAuthorization: () => state.operation.authorize(),
    mountFloatingTranslateButton: () => ensureInlineTranslatorUi(state),
    startInlineTranslation: () => state.operation.start(),
    stopInlineTranslation: () => state.operation.stop(),
    restoreInlineOriginal: () => state.operation.restore(),
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

function createInlineContentState() {
  const state = { menuOpen: false };
  state.operation = inlineTranslationOperation.createInlineTranslationOperation({
    sendMessage: message => chrome.runtime.sendMessage(message),
    pickArticleRoot,
    onChange: () => updateInlineTranslatorUi(state),
    onSettings(settings) { state.translationSettings = settings; },
  });
  return state;
}

var inlineState =
  globalThis.__chromeAiTranslatorInlineState || createInlineContentState();
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

// What the Floating Translate Button shows. Progress and errors are deliberately absent:
// they are single-sourced in the Inline Translation Section, so the button carries the
// controls alone and there is no two-way synchronisation to maintain.
function getInlineTranslatorUiModel(
  state = inlineState,
  settings = state?.translationSettings || INLINE_TRANSLATION_SETTINGS_DEFAULTS
) {
  const status = state?.operation?.getStatus().status || 'original';
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

function authorizeInlineTranslationFromUiEvent(event, state = inlineState) {
  if (!isTrustedInlineUiEvent(event)) return false;
  state.operation.authorize();
  return true;
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

function getInlineTranslationStatusSnapshot(state = inlineState) {
  return state.operation.getStatus();
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
      state.operation.start();
    });
  inlineUiRoot
    .querySelector('[data-action="stop"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      state.operation.stop();
    });
  inlineUiRoot
    .querySelector('[data-action="restore"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      state.operation.restore();
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
    isCodeLikeInlineText: inlineBlockCodec.isCodeLikeInlineText,
    buildArticleExtraction,
    isTrustedInlineUiEvent,
    authorizeInlineTranslationFromUiEvent,
    getInlineShadowMode,
    getInlineHostStyleText,
    getDefaultInlineInstructionHandlers,
    closeFloatingTranslateButton,
    runInlineInstruction,
    runInlineInstructions,
    requestInlineStartupInstructions,
    refreshInlineTranslatorSettings,
    getInlineTranslationStatusSnapshot,
    handleInlineContentMessage,
    getInlineTranslatorUiModel,
    toggleInlineTranslatorMenu,
  };
}
