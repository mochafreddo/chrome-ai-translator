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
var fullPageMarkdown =
  globalThis.ChromeAiTranslatorFullPageMarkdown ||
  (typeof module !== 'undefined' && module.exports
    ? require('./full-page-markdown.js')
    : null);
var inlineTranslationControls =
  globalThis.ChromeAiTranslatorInlineTranslationControls ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-translation-controls.js')
    : null);
var { DEFAULT_MODEL } =
  globalThis.ChromeAiTranslatorDefaultModel ||
  (typeof module !== 'undefined' && module.exports
    ? require('./default-model.js')
    : {});

var INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
var INLINE_MAX_RECORDS = 500;
var INLINE_TRANSLATION_AUTH_MS = 5 * 60 * 1000;
var INLINE_BLOCK_BATCH_MAX_CHARS = 12000;
// The only copy of the session cap. The worker enforces the batch and record caps and
// has no session of its own to measure against. See ADR-0003. Its unit is record cost, not
// characters, and it is charged in actual cost rather than the reserved cost the request-size
// caps use — see ADR-0007 for why the two costs stay apart.
var INLINE_BLOCK_SESSION_MAX_RECORD_COST = 150000;
var INLINE_BLOCK_MAX_DIAGNOSTIC_CODE_CHARS = 80;
var INLINE_VIEWPORT_MAX_IN_FLIGHT = 2;
var INLINE_VIEWPORT_SCAN_DEBOUNCE_MS = 250;
var INLINE_VIEWPORT_PREFETCH_RATIO = 0.5;
var INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES = 1200;
var INLINE_TRANSLATION_SETTINGS_DEFAULTS = {
  targetLanguage: 'Korean',
  tone: 'technical',
  model: DEFAULT_MODEL,
  reasoningEffort: 'none',
};
function isInlineTranslatedState(state) {
  return state === 'translated' || state === 'translated_with_warning';
}
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
function createInlineViewportStore(
  operationId,
  translationByOriginal = null,
  translationSettings = null,
  sessionRecordCost = 0
) {
  const translationSettingsSnapshot = translationSettings
    ? createInlineTranslationSettingsSnapshot(translationSettings)
    : null;
  const translationSettingsSignature = translationSettingsSnapshot
    ? getInlineTranslationCacheSignature(translationSettingsSnapshot)
    : null;
  return {
    operationId,
    byBlock: new WeakMap(),
    records: [],
    queue: [],
    inFlight: 0,
    nextBlockId: 0,
    nextTerminalSequence: 0,
    localDiagnostics: [],
    localDiagnosticsInFlight: null,
    localDiagnosticRetryTimer: null,
    sessionRecordCost: Math.max(0, Number(sessionRecordCost) || 0),
    translationByOriginal:
      translationByOriginal instanceof Map ? translationByOriginal : new Map(),
    scanTimer: null,
    observer: null,
    scrollTargets: [],
    viewportChangeListener: null,
    root: null,
    stopped: false,
    scanStartIndex: 0,
    translationSettings: translationSettingsSnapshot,
    translationSettingsSignature,
  };
}

function markInlineTerminalTransition(store, record) {
  if (!record) return 0;
  if (store) store.nextTerminalSequence = (Number(store.nextTerminalSequence) || 0) + 1;
  record.terminalSequence = store?.nextTerminalSequence || (Number(record.terminalSequence) || 0) + 1;
  return record.terminalSequence;
}

function queueInlineLocalDiagnostic(store, record, code, evidence = {}) {
  if (!store?.localDiagnostics) return;
  store.localDiagnostics.push({
    code,
    ...(typeof record?.template === 'string' ? { template: record.template } : {}),
    ...(record?.contract ? { contract: record.contract } : {}),
    evidence,
  });
}

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

function createInlineLocalDiagnosticBatchId() {
  return inlineDiagnosticsProtocol.createUuidV4();
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
    if (store.diagnosticsUnavailable && state.viewport === store && state.operationId === store.operationId) {
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
  return Boolean(
    state &&
      store &&
      state.status === 'active' &&
      state.viewport === store &&
      state.operationId === operationId &&
      store.operationId === operationId &&
      !store.stopped
  );
}

function stopInlineViewportTranslation(state = inlineState) {
  const store = state.viewport;
  if (!store) return state.operationId;

  const hasPendingDiagnosticTask = Boolean(store.localDiagnosticRetryTimer);
  addInlineRestorableRecords(state, store.records);
  // `store.queue = []` below discards every queued retry, so a queued retry cancels here
  // just as an in-flight one does and has to release the record it superseded. This must
  // run before `resetQueuedInlineViewportRecords`, which retains a queued Semantic Block
  // retry rather than clearing its supersession.
  clearCanceledInlineViewportRetrySupersessions(store, ['queued', 'translating']);
  resetQueuedInlineViewportRecords(store);
  store.stopped = true;
  store.queue = [];
  if (store.scanTimer) {
    clearTimeout(store.scanTimer);
    store.scanTimer = null;
  }
  if (store.localDiagnosticRetryTimer) {
    clearTimeout(store.localDiagnosticRetryTimer);
    store.localDiagnosticRetryTimer = null;
  }
  drainInlineLocalDiagnosticsOnStop(store, hasPendingDiagnosticTask, state);
  if (state.operationId === store.operationId) {
    state.operationId = (Number(state.operationId) || 0) + 1;
  }
  state.status = 'stopped';
  return state.operationId;
}

// A run is live from the moment Start hands it to the viewport scanner until something
// stops it. Pressing Start again while it is — from either of the two homes, both of which
// leave Start pressable — is the only thing the reader can do that would pay for the same
// page twice, so `translateInlinePage` answers it with a rescan of what has scrolled into
// view rather than a second run. A stopped run leaves nothing in flight to duplicate, and
// Start begins a new one.
function isInlineTranslationRunLive(state = inlineState) {
  return state?.status === 'active' && !state?.viewport?.stopped;
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

function getInlineTranslationCacheSignature(settings = {}) {
  return JSON.stringify(createInlineTranslationSettingsSnapshot(settings));
}

function createInlineTranslationSettingsSnapshot(settings = {}) {
  const safe = settings || {};
  return {
    targetLanguage: String(
      safe.targetLanguage || INLINE_TRANSLATION_SETTINGS_DEFAULTS.targetLanguage
    ),
    tone: String(safe.tone || INLINE_TRANSLATION_SETTINGS_DEFAULTS.tone),
    model: String(safe.model || INLINE_TRANSLATION_SETTINGS_DEFAULTS.model),
    reasoningEffort: String(
      safe.reasoningEffort ||
        INLINE_TRANSLATION_SETTINGS_DEFAULTS.reasoningEffort
    ),
  };
}

function ensureInlineTranslationCacheBySettings(state = inlineState) {
  if (!(state.translationCacheBySettings instanceof Map)) {
    state.translationCacheBySettings = new Map();
  }
  return state.translationCacheBySettings;
}

function getInlineTranslationCacheBucket(state = inlineState, settings = {}) {
  const caches = ensureInlineTranslationCacheBySettings(state);
  const signature = getInlineTranslationCacheSignature(settings);
  let cache = caches.get(signature);
  if (!cache) {
    cache = new Map();
    caches.set(signature, cache);
  }
  return cache;
}

function activateInlineTranslationCacheBucket(state = inlineState, settings = {}) {
  const cache = getInlineTranslationCacheBucket(state, settings);
  state.translationCache = cache;
  return cache;
}

function ensureInlineRestorableRecords(state = inlineState) {
  if (!Array.isArray(state.restorableRecords)) {
    state.restorableRecords = [];
  }
  return state.restorableRecords;
}

function addInlineRestorableRecords(state = inlineState, records = []) {
  const restorableRecords = ensureInlineRestorableRecords(state);
  const seen = new Set(restorableRecords);
  for (const record of records || []) {
    if (isInlineTranslatedState(record?.state) && !seen.has(record)) {
      restorableRecords.push(record);
      seen.add(record);
    }
  }
  return restorableRecords;
}

function seedInlineViewportStoreWithRestorableRecords(store, records = []) {
  if (!store?.byBlock) return store;
  const seenRecords = new Set(store.records);
  for (const record of records || []) {
    const blockElement = record?.snapshot?.blockElement;
    if (!blockElement) continue;
    if (!isInlineTranslatedState(record.state) || !blockElement.isConnected) continue;
    if (hasInlineViewportSettingsSignatureMismatch(store, record)) {
      if (inlineBlockCodec.matchesAppliedOwnership(record.snapshot)) {
        const restored = inlineBlockCodec.restoreBlock(record.snapshot);
        if (restored.ok) record.state = 'original';
      }
      continue;
    }
    if (!inlineBlockCodec.matchesAppliedOwnership(record.snapshot)) continue;
    if (!store.byBlock.get(blockElement)) {
      store.byBlock.set(blockElement, record);
    }
    if (!seenRecords.has(record)) {
      store.records.push(record);
      seenRecords.add(record);
    }
    cacheInlineViewportBlockTranslation(store, record);
  }
  store.nextTerminalSequence = Math.max(
    Number(store.nextTerminalSequence) || 0,
    ...store.records.map((record) => Number(record?.terminalSequence) || 0)
  );
  return store;
}

function getInlineViewportRestoreRecords(state = inlineState) {
  const records = [];
  const seen = new Set();
  for (const record of state.restorableRecords || []) {
    if (record && !seen.has(record)) {
      records.push(record);
      seen.add(record);
    }
  }
  for (const record of state.viewport?.records || []) {
    if (record && !seen.has(record)) {
      records.push(record);
      seen.add(record);
    }
  }
  return records;
}

// One shape for an Inline Translation state, so a check drives the fields the page has
// rather than the ones it remembered to write down. A hand-rolled state that left out
// `authorizedUntil` would find the run start refusing it and say nothing about why.
function createInlineTranslationState(overrides = {}) {
  return {
    status: 'original',
    menuOpen: false,
    message: '',
    error: '',
    operationId: 0,
    authorizedUntil: 0,
    restorableRecords: [],
    ...overrides,
  };
}

var inlineState =
  globalThis.__chromeAiTranslatorInlineState || createInlineTranslationState();
globalThis.__chromeAiTranslatorInlineState = inlineState;
if (!inlineState.viewport) {
  inlineState.viewport = createInlineViewportStore(inlineState.operationId);
}
ensureInlineRestorableRecords(inlineState);
ensureInlineTranslationCacheBySettings(inlineState);
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

function hasInlineViewportSettingsSignatureMismatch(store, record) {
  const storeSignature = store?.translationSettingsSignature || '';
  const recordSignature = record?.translationSettingsSignature || '';
  if (!storeSignature && !recordSignature) return false;
  return storeSignature !== recordSignature;
}

function stampInlineViewportRecordSettings(store, record) {
  if (store?.translationSettingsSignature && record) {
    record.translationSettingsSignature = store.translationSettingsSignature;
  }
  return record;
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

function getInlineBlockRecordCost(record) {
  return (
    String(record?.template || '').length +
    JSON.stringify(record?.atoms || []).length +
    JSON.stringify(record?.repair ?? null).length
  );
}

function getInlineBlockReservedRecordCost(record) {
  function requestPayloadCost(candidate) {
    return JSON.stringify({
      records: [{
        id: candidate.id,
        template: candidate.template,
        atoms: candidate.atoms,
        repair: candidate.repair ?? null,
      }],
    }).length;
  }
  const repairRecord = {
    ...record,
    repair: {
      attempt: 1,
      previousErrorCode: 'x'.repeat(INLINE_BLOCK_MAX_DIAGNOSTIC_CODE_CHARS),
    },
  };
  // Counting each record as its own request intentionally over-reserves the
  // shared wrapper, guaranteeing the real batched JSON is no larger.
  return requestPayloadCost(record) + requestPayloadCost(repairRecord);
}

// A repair is a second real request carrying the same record, so it is charged the same
// record cost again. The worker says whether one was sent by reporting `attemptCount`, and
// this may only be read where a request actually came back: `attemptCount` is written into
// the translation cache and replayed out of it, so a cached block presents a 2 for a repair
// that happened in an earlier session with nothing sent for it now. See ADR-0007.
//
// The 2 is exact rather than `>= 2` because the worker sends at most two requests per record
// and reports nothing else. If a third attempt is ever added, this charge has to be revisited
// rather than silently counting it as the second.
function chargeInlineBlockRepairRequest(store, record, result) {
  if (!store || Number(result?.attemptCount) !== 2) return;
  store.sessionRecordCost += getInlineBlockRecordCost(record);
}

// The id carries the operation that minted it, so a record minted here cannot collide with
// one `seedInlineViewportStoreWithRestorableRecords` carried over from a stopped session —
// those keep the ids of an earlier operation, and every store is built for an operation id
// that was incremented first. `findInlineViewportRecordById` resolves `retryOf` by scanning
// `store.records` for the first match, so a duplicate id there silently resolves a retry to
// the wrong record. Nothing else reads this format: the worker's
// `normalizeVisibleBlockBatchRecords` asks only for a non-empty string unique within the
// batch, and the one place an id outlives the page is the `runId/<id>` diagnosticId, which
// storage checks by its `runId/` prefix alone and never parses back into a block id.
function createInlineViewportBlockRecord(store, blockElement, values = {}) {
  const record = {
    id: `b${Number(store.operationId) || 0}-${store.nextBlockId + 1}`,
    blockElement,
    state: 'original',
    operationId: store.operationId,
    pageChangeRetryCount: 0,
    repair: null,
    ...values,
  };
  store.nextBlockId += 1;
  stampInlineViewportRecordSettings(store, record);
  store.byBlock.set(blockElement, record);
  store.records.push(record);
  return record;
}

function createQueuedInlineBlockRecordFromSerialized(
  store,
  blockElement,
  serialized,
  options = {}
) {
  return createInlineViewportBlockRecord(store, blockElement, {
    template: serialized.template,
    atoms: serialized.atoms,
    contract: serialized.contract,
    snapshot: serialized.snapshot,
    cacheKey: `block:${serialized.cacheKey}`,
    pageChangeRetryCount: Number(options.pageChangeRetryCount) || 0,
    retryOf: options.retryOf || null,
    repair: options.repair || null,
    state: 'queued',
  });
}

function cacheInlineViewportBlockTranslation(store, record) {
  if (
    !store?.translationByOriginal ||
    !isInlineTranslatedState(record?.state) ||
    !record.cacheKey ||
    typeof record.translatedTemplate !== 'string' ||
    hasInlineViewportSettingsSignatureMismatch(store, record)
  ) {
    return false;
  }
  store.translationByOriginal.set(record.cacheKey, {
    codecVersion: inlineBlockCodec.CODEC_VERSION,
    translatedTemplate: record.translatedTemplate,
    state: record.state,
    terminalCode: record.terminalCode || null,
    attemptCount: Math.min(2, Math.max(1, Number(record.attemptCount) || 1)),
  });
  return true;
}

function applyCachedInlineViewportBlock(store, record) {
  const cached = store?.translationByOriginal?.get(record?.cacheKey);
  if (
    cached?.codecVersion !== inlineBlockCodec.CODEC_VERSION ||
    typeof cached?.translatedTemplate !== 'string'
  ) {
    return false;
  }
  const plan = inlineBlockCodec.createPatchPlan(
    record.snapshot,
    cached.translatedTemplate
  );
  if (!plan.ok) return false;
  const applied = inlineBlockCodec.applyPatchPlan(record.snapshot, plan);
  if (!applied.ok) return false;
  record.state = cached.state === 'translated_with_warning'
    ? 'translated_with_warning'
    : 'translated';
  record.terminalCode = record.state === 'translated_with_warning'
    ? cached.terminalCode || 'quality.target_language_uncertain'
    : null;
  record.attemptCount = Math.min(2, Math.max(1, Number(cached.attemptCount) || 1));
  record.translatedTemplate = cached.translatedTemplate;
  record.translation = cached.translatedTemplate;
  if (record.state === 'translated_with_warning') markInlineTerminalTransition(store, record);
  return true;
}

function queueInlineViewportBlock(store, blockElement, options = {}) {
  if (!store?.byBlock || !blockElement?.isConnected || !inlineBlockCodec) {
    return null;
  }
  const existing = store.byBlock.get(blockElement);
  if (existing) {
    if (isInlineTranslatedState(existing.state)) {
      if (inlineBlockCodec.matchesAppliedOwnership(existing.snapshot)) {
        return null;
      }
      existing.state = 'stale';
      existing.errorCode = 'block_changed';
      markInlineTerminalTransition(store, existing);
      store.byBlock.delete(blockElement);
    } else if (
      ['queued', 'translating', 'failed', 'stale'].includes(existing.state)
    ) {
      return null;
    }
  }

  const serialized = inlineBlockCodec.serializeBlock(blockElement);
  if (!serialized.ok) {
    const failedRecord = createInlineViewportBlockRecord(store, blockElement, {
      state: 'failed',
      errorCode: serialized.errorCode || 'unsupported_block',
    });
    markInlineTerminalTransition(store, failedRecord);
    queueInlineLocalDiagnostic(store, failedRecord, 'runtime.unsupported_block');
    return failedRecord;
  }
  const record = createQueuedInlineBlockRecordFromSerialized(
    store,
    blockElement,
    serialized,
    options
  );
  if (applyCachedInlineViewportBlock(store, record)) return null;
  store.queue.push(record);
  return record;
}

function takeInlineViewportBlockBatch(
  store,
  maxChars = INLINE_BLOCK_BATCH_MAX_CHARS
) {
  if (!store || store.stopped || store.inFlight >= INLINE_VIEWPORT_MAX_IN_FLIGHT) {
    return [];
  }
  const limit = Number(maxChars) || INLINE_BLOCK_BATCH_MAX_CHARS;
  const batch = [];
  let batchCost = 0;

  while (store.queue.length) {
    if (batch.length >= INLINE_MAX_RECORDS) break;
    const record = store.queue[0];
    const cost = getInlineBlockRecordCost(record);
    if (cost > limit) {
      store.queue.shift();
      record.state = 'failed';
      record.errorCode = 'block_too_large';
      markInlineTerminalTransition(store, record);
      queueInlineLocalDiagnostic(store, record, 'runtime.block_too_large', {
        recordCost: cost,
        limit,
      });
      continue;
    }
    const reservedCost = getInlineBlockReservedRecordCost(record);
    if (reservedCost > limit) {
      store.queue.shift();
      record.state = 'failed';
      record.errorCode = 'block_too_large';
      markInlineTerminalTransition(store, record);
      queueInlineLocalDiagnostic(store, record, 'runtime.block_too_large', {
        recordCost: reservedCost,
        limit,
      });
      continue;
    }
    // The session budget is charged in actual cost while the caps above stay on reserved
    // cost. Two units for the same record in adjacent lines is deliberate: reserved cost
    // over-counts so one request can never exceed the cap it was checked against, and a
    // cumulative budget needs no such guarantee. See ADR-0007.
    if (store.sessionRecordCost + cost > INLINE_BLOCK_SESSION_MAX_RECORD_COST) {
      store.queue.shift();
      record.state = 'failed';
      record.errorCode = 'session_too_large';
      markInlineTerminalTransition(store, record);
      queueInlineLocalDiagnostic(store, record, 'runtime.session_too_large', {
        recordCost: cost,
        sessionCost: store.sessionRecordCost,
        limit: INLINE_BLOCK_SESSION_MAX_RECORD_COST,
      });
      continue;
    }
    if (batch.length && batchCost + reservedCost > limit) break;

    store.queue.shift();
    record.state = 'translating';
    batch.push(record);
    batchCost += reservedCost;
    store.sessionRecordCost += cost;
    if (batchCost >= limit) break;
  }
  if (batch.length) store.inFlight += 1;
  return batch;
}

function queueInlineViewportBlockRetry(
  store,
  parentRecord,
  retryKind
) {
  if (
    !store ||
    store.stopped ||
    !parentRecord?.blockElement?.isConnected ||
    store.byBlock?.get(parentRecord.blockElement) !== parentRecord
  ) {
    return null;
  }
  const pageChangeRetryCount =
    Number(parentRecord.pageChangeRetryCount) || 0;
  if (retryKind === 'page-change' && pageChangeRetryCount >= 1) return null;
  if (retryKind !== 'page-change') return null;

  const serialized = inlineBlockCodec.serializeBlock(parentRecord.blockElement);
  if (!serialized.ok) return null;
  const retryRecord = createQueuedInlineBlockRecordFromSerialized(
    store,
    parentRecord.blockElement,
    serialized,
    {
      pageChangeRetryCount:
        pageChangeRetryCount + (retryKind === 'page-change' ? 1 : 0),
      retryOf: parentRecord.id,
      repair: null,
    }
  );
  parentRecord.supersededByRetryId = retryRecord.id;
  if (!applyCachedInlineViewportBlock(store, retryRecord)) {
    store.queue.push(retryRecord);
  }
  return retryRecord;
}

function applyInlineViewportBlockResults(
  records,
  results,
  operationId,
  store = null
) {
  const byId = new Map((results || []).map((result) => [result.id, result]));
  const summary = {
    applied: 0,
    stale: 0,
    retried: 0,
    failed: 0,
    ignored: 0,
  };

  function queuePageRetry(record) {
    record.state = 'stale';
    record.errorCode = 'block_changed';
    markInlineTerminalTransition(store, record);
    summary.stale += 1;
    if (queueInlineViewportBlockRetry(store, record, 'page-change')) {
      summary.retried += 1;
      return true;
    }
    return false;
  }

  for (const record of records || []) {
    const result = byId.get(record.id);
    // Charged ahead of everything this loop decides, including the record whose operation the
    // page has already replaced: the repair request was sent whatever the answer turned out
    // to be worth, and there is no refund for what was sent. `store.sessionRecordCost` spans
    // the page visit rather than the operation, so the charge lands on the right accumulator
    // even when the answer arrives for an operation that is over.
    chargeInlineBlockRepairRequest(store, record, result);
    if (record.operationId !== operationId) {
      summary.ignored += 1;
      continue;
    }
    if (!result) {
      record.state = 'failed';
      record.errorCode = 'request_failed';
      markInlineTerminalTransition(store, record);
      summary.failed += 1;
      continue;
    }
    record.correlationToken = result.correlationToken || null;
    if (result.disposition === 'reject' || typeof result.template !== 'string') {
      if (!inlineBlockCodec.matchesOriginalOwnership(record.snapshot)) {
        queuePageRetry(record);
        continue;
      }
      record.state = 'failed';
      record.errorCode = result.terminalCode || 'runtime.request_failed';
      record.terminalCode = record.errorCode;
      record.attemptCount = result.attemptCount || 1;
      markInlineTerminalTransition(store, record);
      summary.failed += 1;
      continue;
    }

    const plan = inlineBlockCodec.createPatchPlan(
      record.snapshot,
      result.template
    );
    if (!plan.ok) {
      if (plan.errorCode === 'block_changed') queuePageRetry(record);
      else {
        record.state = 'failed';
        record.errorCode = `runtime.${plan.errorCode || 'apply_failed'}`;
        markInlineTerminalTransition(store, record);
        summary.failed += 1;
      }
      continue;
    }
    const applied = inlineBlockCodec.applyPatchPlan(record.snapshot, plan);
    if (!applied.ok) {
      if (applied.errorCode === 'block_changed') queuePageRetry(record);
      else {
        record.state = 'failed';
        record.errorCode = `runtime.${applied.errorCode || 'apply_failed'}`;
        markInlineTerminalTransition(store, record);
        summary.failed += 1;
      }
      continue;
    }

    record.state = result.disposition === 'apply_with_warning'
      ? 'translated_with_warning'
      : 'translated';
    record.terminalCode = result.terminalCode || null;
    record.attemptCount = result.attemptCount || 1;
    record.translatedTemplate = result.template;
    record.translation = result.template;
    if (record.state === 'translated_with_warning') markInlineTerminalTransition(store, record);
    stampInlineViewportRecordSettings(store, record);
    cacheInlineViewportBlockTranslation(store, record);
    summary.applied += 1;
  }
  return summary;
}

function findInlineViewportRecordById(store, id) {
  if (!id) return null;
  return (store?.records || []).find((record) => record?.id === id) || null;
}

function clearInlineViewportRetrySupersession(store, retryRecord) {
  if (!retryRecord?.retryOf) return false;
  const parent = findInlineViewportRecordById(store, retryRecord.retryOf);
  if (!parent || parent.supersededByRetryId !== retryRecord.id) return false;
  delete parent.supersededByRetryId;
  return true;
}

function clearCanceledInlineViewportRetrySupersessions(
  store,
  canceledStates = ['queued']
) {
  const states = new Set(canceledStates);
  for (const record of store?.records || []) {
    if (record?.retryOf && states.has(record.state)) {
      clearInlineViewportRetrySupersession(store, record);
    }
  }
}

function resetQueuedInlineViewportRecords(store) {
  if (!store?.queue?.length) return;

  const retained = [];
  for (const record of store.queue) {
    if (record?.state === 'queued') {
      // `retryOf` is what makes a queued record a page-change retry, and a retry is kept
      // rather than reset: the block it superseded is still waiting on it.
      if (record.retryOf) {
        retained.push(record);
        continue;
      }
      clearInlineViewportRetrySupersession(store, record);
      record.state = 'original';
      record.translation = null;
      continue;
    }
    retained.push(record);
  }
  store.queue = retained;
}

function markInlineViewportBatchFailed(records, operationId, store = null) {
  for (const record of records || []) {
    if (record.operationId === operationId && record.state === 'translating') {
      record.state = 'failed';
      markInlineTerminalTransition(store, record);
    }
  }
}

function getInlineViewportStatusCounts(records) {
  const counts = { translated: 0, partial: 0, pending: 0, changed: 0, failed: 0 };
  for (const record of records || []) {
    if (record.state === 'translated') counts.translated += 1;
    if (record.state === 'translated_with_warning') counts.partial += 1;
    if (record.state === 'queued' || record.state === 'translating') {
      counts.pending += 1;
    }
    if (record.state === 'stale' && !record.supersededByRetryId) {
      counts.changed += 1;
    }
    if (record.state === 'failed' && !record.supersededByRetryId) {
      counts.failed += 1;
    }
  }
  return counts;
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

function getInlineTerminalReason(records) {
  const candidates = (records || []).filter(
    (record) =>
      !record.supersededByRetryId &&
      ['translated_with_warning', 'failed', 'stale'].includes(record.state)
  );
  const record = candidates.reduce((latest, candidate) =>
    !latest || (Number(candidate.terminalSequence) || 0) >= (Number(latest.terminalSequence) || 0)
      ? candidate
      : latest
  , null);
  if (!record) return '';
  const code = String(record.terminalCode || record.errorCode || '');
  if (record.state === 'translated_with_warning') {
    return 'Partial translation: Some source-language prose remained after one repair attempt.';
  }
  if (record.state === 'stale' || code === 'runtime.page_changed') {
    return 'Page changed before translation could be applied.';
  }
  if (code.startsWith('structure.')) {
    return 'Translation failed: Protected page structure could not be preserved, so the original was kept.';
  }
  if (code.startsWith('protocol.')) {
    return 'Translation failed: The model response was malformed or incomplete.';
  }
  if (code === 'runtime.apply_failed') {
    return 'Translation failed: The page rejected the translated update, so the original was kept.';
  }
  if (code === 'runtime.unsupported_block' || code === 'unsupported_block') {
    return 'Translation failed: This page block has unsupported structure, so no request was sent.';
  }
  if (code === 'runtime.block_too_large' || code === 'block_too_large') {
    return 'Translation failed: This page block exceeds the 12,000-character request limit, so no request was sent.';
  }
  if (code === 'runtime.session_too_large' || code === 'session_too_large') {
    return 'Translation failed: The visible translation reached this page visit\'s limit, so no request was sent. Reload the page to continue.';
  }
  return 'Translation failed: The translation request could not be completed.';
}

// What the Floating Translate Button shows. Progress and errors are deliberately absent:
// they are single-sourced in the Inline Translation Section, so the button carries the
// controls alone and there is no two-way synchronisation to maintain.
function getInlineTranslatorUiModel(
  state = inlineState,
  settings = state?.translationSettings || INLINE_TRANSLATION_SETTINGS_DEFAULTS
) {
  const status = state?.status || 'original';
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
  const sessionRecordCost = Math.max(
    0,
    Number(viewport?.sessionRecordCost) || 0
  );
  if (viewport?.observer) {
    viewport.observer.disconnect();
  }
  if (viewport?.scanTimer) {
    clearTimeout(viewport.scanTimer);
  }

  const restoredBlocks = new Set();
  for (const record of getInlineViewportRestoreRecords(state)) {
    // A record with no snapshot never reached the page — a block that could not be
    // serialized is one — so there is nothing to put back, but it still goes back to
    // `original` along with the rest.
    const blockElement = record.snapshot?.blockElement;
    if (
      blockElement &&
      isInlineTranslatedState(record.state) &&
      blockElement.isConnected &&
      !restoredBlocks.has(blockElement)
    ) {
      const restored = inlineBlockCodec.restoreBlock(record.snapshot);
      if (!restored.ok) {
        record.state = 'stale';
        continue;
      }
      restoredBlocks.add(blockElement);
    }
    record.state = 'original';
  }

  state.status = 'original';
  state.restorableRecords = [];
  state.operationId = (Number(state.operationId) || 0) + 1;
  state.viewport = createInlineViewportStore(
    state.operationId,
    state.translationCache,
    null,
    sessionRecordCost
  );
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
  const translationDocument = fullPageMarkdown.serializeMarkdownDocument(
    root,
    metadata
  );
  return {
    ...metadata,
    contentMarkdown: fullPageMarkdown.renderOriginalMarkdown(
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

function collectVisibleInlineBlocks(
  root,
  store,
  maxTextNodes = INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES
) {
  const limit = normalizeInlineViewportScanLimit(maxTextNodes);
  const startIndex = Math.max(0, Number(store?.scanStartIndex) || 0);
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
          const record = queueInlineViewportBlock(store, block);
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
    status: state?.status || 'original',
    progress: state?.message || '',
    error: state?.error || '',
  };
}

// Why part of a run will not finish. This is an error, not progress: it belongs on the
// line the panel raises rather than the one it keeps muted, which is what telling the two
// apart in the state was for.
function formatInlineViewportErrorText(records, diagnosticsUnavailable = false) {
  const reasons = [];
  const terminalReason = getInlineTerminalReason(records);
  if (terminalReason) reasons.push(terminalReason);
  if (diagnosticsUnavailable) reasons.push('Diagnostics could not be saved.');
  return reasons.join('\n');
}

// The counts are progress. A reason that has been reached is not withdrawn by a later
// scan, so this only ever sets one — the reader's next attempt is what clears it.
function updateInlineViewportMessage(state = inlineState) {
  const records = state.viewport?.records || [];
  const counts = getInlineViewportStatusCounts(records);
  state.message = formatInlineViewportStatusMessage(counts, state.status);
  const errorText = formatInlineViewportErrorText(
    records,
    Boolean(state.viewport?.diagnosticsUnavailable)
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
  if (!store || store.stopped || state.status !== 'active') return;
  const root = store.root || pickArticleRoot();
  if (!root) {
    setInlineErrorMessage('No article content found.', state);
    return;
  }
  store.root = root;
  collectVisibleInlineBlocks(root, store);
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
  if (!store || store.stopped || state.status !== 'active') return;
  if (options?.resetScanStartIndex) {
    store.scanStartIndex = 0;
    resetQueuedInlineViewportRecords(store);
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

function releaseInlineRuntimeTokensFromStaleResponse(resp, operationId) {
  const releaseTokens = Array.isArray(resp?.results)
    ? resp.results.map((result) => result?.correlationToken).filter(Boolean)
    : [];
  if (!releaseTokens.length) return false;
  chrome.runtime.sendMessage({
    type: inlineDiagnosticsProtocol.messages.recordRuntime,
    operationId,
    outcomes: [],
    releaseTokens,
  }).catch(() => {});
  return true;
}

async function drainInlineViewportQueue(state = inlineState) {
  const store = state.viewport;
  if (!store || store.stopped || state.status !== 'active') return;
  const operationId = store.operationId;
  flushInlineLocalDiagnostics(store, state);

  while (
    isInlineViewportOperationCurrent(state, store, operationId) &&
    store.inFlight < INLINE_VIEWPORT_MAX_IN_FLIGHT &&
    store.queue.length
  ) {
    const batch = takeInlineViewportBlockBatch(store);
    flushInlineLocalDiagnostics(store, state);
    if (!batch.length) {
      updateInlineViewportMessage(state);
      return;
    }
    updateInlineViewportMessage(state);

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
      .then((resp) => {
        if (!isInlineViewportOperationCurrent(state, store, operationId)) {
          releaseInlineRuntimeTokensFromStaleResponse(resp, operationId);
          return;
        }
        if (!resp?.ok || !Array.isArray(resp.results)) {
          markInlineViewportBatchFailed(batch, operationId, store);
          return;
        }
        applyInlineViewportBlockResults(
          batch,
          resp.results,
          operationId,
          store
        );
        const runtimeOutcomes = batch
          .filter((record) =>
            (record.state === 'failed' && !record.terminalCode && String(record.errorCode || '').startsWith('runtime.')) ||
            (record.state === 'stale' && !record.supersededByRetryId)
          )
          .map((record) => ({
            code: record.state === 'stale'
              ? 'runtime.page_changed'
              : record.terminalCode || record.errorCode || 'runtime.apply_failed',
            correlationToken: record.correlationToken,
          }));
        const runtimeTokens = new Set(runtimeOutcomes.map((outcome) => outcome.correlationToken));
        const releaseTokens = batch
          .map((record) => record.correlationToken)
          .filter((token) => token && !runtimeTokens.has(token));
        if (runtimeOutcomes.length || releaseTokens.length) {
          chrome.runtime.sendMessage({
            type: inlineDiagnosticsProtocol.messages.recordRuntime,
            operationId,
            outcomes: runtimeOutcomes,
            releaseTokens,
          }).then((diagnosticResponse) => {
            if (diagnosticResponse?.ok !== true) {
              store.diagnosticsUnavailable = true;
              if (isInlineViewportOperationCurrent(state, store, operationId)) {
                updateInlineViewportMessage(state);
              }
            }
          }).catch(() => {
            store.diagnosticsUnavailable = true;
            if (isInlineViewportOperationCurrent(state, store, operationId)) {
              updateInlineViewportMessage(state);
            }
          });
        }
        if (resp.results.some((result) => result.diagnosticsUnavailable)) {
          store.diagnosticsUnavailable = true;
        }
        addInlineRestorableRecords(state, batch);
      })
      .catch(() => {
        if (isInlineViewportOperationCurrent(state, store, operationId)) {
          markInlineViewportBatchFailed(batch, operationId, store);
        }
      })
      .finally(() => {
        if (!isInlineViewportOperationCurrent(state, store, operationId)) {
          return;
        }
        store.inFlight = Math.max(0, store.inFlight - 1);
        updateInlineViewportMessage(state);
        drainInlineViewportQueue(state).catch((error) =>
          setInlineErrorMessage(error?.message || String(error), state)
        );
      });
  }
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
  addInlineRestorableRecords(state, state.viewport?.records || []);
  const settingsSnapshot = createInlineTranslationSettingsSnapshot(
    settingsResponse.settings
  );
  state.translationSettings = settingsSnapshot;
  const translationCache = activateInlineTranslationCacheBucket(
    state,
    settingsSnapshot
  );
  const sessionRecordCost = Math.max(
    0,
    Number(state.viewport?.sessionRecordCost) || 0
  );
  state.operationId = (Number(state.operationId) || 0) + 1;
  state.status = 'active';
  state.viewport = createInlineViewportStore(
    state.operationId,
    translationCache,
    settingsSnapshot,
    sessionRecordCost
  );
  state.viewport.root = root;
  seedInlineViewportStoreWithRestorableRecords(
    state.viewport,
    state.restorableRecords
  );

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
    createInlineTranslationSettingsSnapshot,
    getInlineTranslationCacheBucket,
    seedInlineViewportStoreWithRestorableRecords,
    createInlineViewportStore,
    findInlineSemanticBlock,
    getInlineBlockRecordCost,
    getInlineBlockReservedRecordCost,
    queueInlineViewportBlock,
    takeInlineViewportBlockBatch,
    applyInlineViewportBlockResults,
    releaseInlineRuntimeTokensFromStaleResponse,
    flushInlineLocalDiagnostics,
    markInlineViewportBatchFailed,
    getInlineViewportStatusCounts,
    formatInlineViewportStatusMessage,
    formatInlineViewportErrorText,
    getInlineTerminalReason,
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
