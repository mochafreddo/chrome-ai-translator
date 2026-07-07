// content.js

var INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
var INLINE_MAX_RECORDS = 500;
var INLINE_MAX_TOTAL_CHARS = 60000;
var INLINE_TRANSLATION_AUTH_MS = 5 * 60 * 1000;
var INLINE_VIEWPORT_BATCH_MAX_CHARS = 2000;
var INLINE_VIEWPORT_MAX_IN_FLIGHT = 2;
var INLINE_VIEWPORT_SCAN_DEBOUNCE_MS = 250;
var INLINE_VIEWPORT_PREFETCH_RATIO = 0.5;
var INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES = 1200;
var INLINE_TRANSLATION_SETTINGS_DEFAULTS = {
  targetLanguage: 'Korean',
  tone: 'technical',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'none',
};
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
  translationSettings = null
) {
  const translationSettingsSnapshot = translationSettings
    ? createInlineTranslationSettingsSnapshot(translationSettings)
    : null;
  const translationSettingsSignature = translationSettingsSnapshot
    ? getInlineTranslationCacheSignature(translationSettingsSnapshot)
    : null;
  return {
    operationId,
    byNode: new WeakMap(),
    records: [],
    queue: [],
    inFlight: 0,
    nextId: 0,
    translationByOriginal:
      translationByOriginal instanceof Map ? translationByOriginal : new Map(),
    scanTimer: null,
    observer: null,
    scrollTargets: [],
    root: null,
    stopped: false,
    scanStartIndex: 0,
    translationSettings: translationSettingsSnapshot,
    translationSettingsSignature,
  };
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

  addInlineRestorableRecords(state, store.records);
  clearCanceledInlineViewportRetrySupersessions(store, ['translating']);
  resetQueuedInlineViewportRecords(store);
  store.stopped = true;
  store.queue = [];
  if (store.scanTimer) {
    clearTimeout(store.scanTimer);
    store.scanTimer = null;
  }
  if (state.operationId === store.operationId) {
    state.operationId = (Number(state.operationId) || 0) + 1;
  }
  state.status = 'stopped';
  state.records = store.records;
  return state.operationId;
}

function canRestartInlineViewportTranslation(state = inlineState) {
  return state.status === 'stopped' || Boolean(state.viewport?.stopped);
}

function hasInlineSettingsApiKey(settings) {
  return Boolean(settings?.apiKey);
}

async function getInlineAutoShowEnabled(chromeApi = globalThis.chrome) {
  if (!chromeApi?.runtime?.sendMessage) return false;
  const response = await chromeApi.runtime.sendMessage({ type: 'GET_SETTINGS' });
  return Boolean(response?.ok && response.settings?.inlineAutoShow);
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
    if (record?.state === 'translated' && !seen.has(record)) {
      restorableRecords.push(record);
      seen.add(record);
    }
  }
  return restorableRecords;
}

function seedInlineViewportStoreWithRestorableRecords(store, records = []) {
  if (!store?.byNode) return store;
  const seenRecords = new Set(store.records);
  for (const record of records || []) {
    if (record?.state !== 'translated' || !record.node?.isConnected) continue;
    if (hasInlineViewportSettingsSignatureMismatch(store, record)) {
      if (
        typeof record.translation === 'string' &&
        record.node.nodeValue === record.translation
      ) {
        record.node.nodeValue = record.original;
        record.state = 'original';
      }
      continue;
    }
    if (
      typeof record.translation === 'string' &&
      record.node.nodeValue !== record.translation
    ) {
      continue;
    }
    if (!store.byNode.get(record.node)) {
      store.byNode.set(record.node, record);
    }
    if (!seenRecords.has(record)) {
      store.records.push(record);
      seenRecords.add(record);
    }
    cacheInlineViewportRecordTranslation(store, record);
  }
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

var inlineState = globalThis.__chromeAiTranslatorInlineState || {
  status: 'original',
  records: [],
  menuOpen: false,
  message: '',
  operationId: 0,
  authorizedUntil: 0,
  restorableRecords: [],
};
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

function isCodeLikeInlineText(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/^https?:\/\//i.test(value)) return true;
  if (
    /^[\w./-]+\.(md|js|ts|tsx|jsx|json|ya?ml|css|html|py|rb|go|rs|java|kt|swift|sh)$/i.test(
      value
    )
  ) {
    return true;
  }
  if (/^--?[a-z0-9][a-z0-9-]*(=.*)?$/i.test(value)) return true;
  if (
    /^(npm|pnpm|yarn|node|git|gh|curl|cd|ls|cat|grep|rg|mkdir|rm|cp|mv)\b/.test(
      value
    )
  ) {
    return true;
  }
  if (/^[A-Z0-9_./-]{1,24}$/.test(value)) return true;
  if (/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*){1,}$/.test(value)) {
    return true;
  }
  return false;
}

function isTranslatableInlineText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 4) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (isCodeLikeInlineText(value)) return false;
  return true;
}

function isTrustedInlineUiEvent(event) {
  return event?.isTrusted === true;
}

function resetInlineTranslationAfterFailure(state = inlineState) {
  state.status = 'original';
  state.records = [];
}

function beginInlineTranslationOperation(state, records) {
  const operationId = (Number(state.operationId) || 0) + 1;
  state.operationId = operationId;
  state.status = 'translating';
  state.records = records.map((record) => ({
    id: record.id,
    node: record.node,
    original: record.text,
    translation: null,
  }));
  return { operationId, records: state.records };
}

function isCurrentInlineOperation(state, operationId) {
  return state.status === 'translating' && state.operationId === operationId;
}

function cancelInlineTranslationOperation(state = inlineState, operationId = state.operationId) {
  if (state.operationId !== operationId) return false;
  state.status = 'original';
  state.records = [];
  return true;
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

function getInlineRecordPayloadSize(record) {
  return String(record.id || '').length + String(record.original || record.text || '').length + 20;
}

function getInlineRecordTextSize(record) {
  return String(record.original || record.text || '').length;
}

function getInlineOriginalTextCacheKey(text) {
  return typeof text === 'string' ? text : '';
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

function cacheInlineViewportRecordTranslation(store, record) {
  if (!store?.translationByOriginal || record?.state !== 'translated') {
    return false;
  }
  if (hasInlineViewportSettingsSignatureMismatch(store, record)) return false;
  const key = getInlineOriginalTextCacheKey(record.original);
  if (!key || typeof record.translation !== 'string') return false;
  store.translationByOriginal.set(key, {
    original: record.original,
    translation: record.translation,
  });
  return true;
}

function getInlineBoundaryPreservedTranslation(
  record,
  translation = record?.translation
) {
  return preserveInlineBoundaryWhitespace(record?.original, translation);
}

function createInlineViewportRecord(store, node, values = {}) {
  const record = {
    id: `v${store.nextId + 1}`,
    node,
    translation: null,
    state: 'original',
    operationId: store.operationId,
    ...values,
  };
  stampInlineViewportRecordSettings(store, record);
  store.nextId += 1;
  store.byNode.set(node, record);
  store.records.push(record);
  return record;
}

function applyCachedInlineViewportTranslation(store, node, text) {
  const key = getInlineOriginalTextCacheKey(text);
  const cached = key ? store?.translationByOriginal?.get(key) : null;
  if (!cached || typeof cached.translation !== 'string') return null;
  if (!node?.isConnected || node.nodeValue !== cached.original) return null;
  const preservedTranslation = getInlineBoundaryPreservedTranslation(cached);

  const record = createInlineViewportRecord(store, node, {
    original: cached.original,
    translation: preservedTranslation,
    state: 'translated',
  });
  node.nodeValue = preservedTranslation;
  cached.translation = preservedTranslation;
  return record;
}

function queueInlineViewportRecord(store, node, text) {
  if (!store || !node) return null;
  const existing = store.byNode.get(node);
  if (
    existing?.state === 'translated' &&
    typeof existing.translation === 'string' &&
    node.isConnected &&
    node.nodeValue === existing.original
  ) {
    node.nodeValue = existing.translation;
    cacheInlineViewportRecordTranslation(store, existing);
    return null;
  }
  if (
    existing &&
    ['queued', 'translating', 'translated', 'failed', 'stale'].includes(
      existing.state
    )
  ) {
    return null;
  }

  if (!existing) {
    const cached = applyCachedInlineViewportTranslation(store, node, text);
    if (cached) return null;
  }

  const record =
    existing ||
    createInlineViewportRecord(store, node, {
      original: text,
    });

  record.original = text;
  record.translation = null;
  record.state = 'queued';
  record.operationId = store.operationId;
  stampInlineViewportRecordSettings(store, record);
  markInlineViewportRetrySuperseded(store, record);
  store.queue.push(record);
  return record;
}

function getInlineViewportRetryCount(record) {
  const parsed = Number(record?.retryCount);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function findInlineViewportRecordById(store, id) {
  if (!id) return null;
  return (store?.records || []).find((record) => record?.id === id) || null;
}

function markInlineViewportRetrySuperseded(store, retryRecord) {
  if (!retryRecord?.retryOf) return false;
  const parent = findInlineViewportRecordById(store, retryRecord.retryOf);
  if (!parent) return false;
  parent.supersededByRetryId = retryRecord.id;
  return true;
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

function queueInlineViewportRetryRecord(
  store,
  staleRecord,
  currentText,
  rejectedTranslation = ''
) {
  if (!store || store.stopped || !staleRecord?.node) return null;
  const node = staleRecord.node;
  const text = String(currentText || '');
  if (!node.isConnected || node.nodeValue !== text) return null;
  if (store.byNode?.get(node) !== staleRecord) return null;
  if (getInlineViewportRetryCount(staleRecord) >= 1) return null;
  if (!isTranslatableInlineText(text)) return null;
  if (text === staleRecord.original || text === rejectedTranslation) return null;

  const retryRecord = createInlineViewportRecord(store, node, {
    original: text,
    retryOf: staleRecord.id,
    retryCount: getInlineViewportRetryCount(staleRecord) + 1,
  });
  markInlineViewportRetrySuperseded(store, retryRecord);

  const key = getInlineOriginalTextCacheKey(text);
  const cached = key ? store.translationByOriginal?.get(key) : null;
  if (
    cached &&
    typeof cached.translation === 'string' &&
    node.nodeValue === cached.original
  ) {
    retryRecord.translation = getInlineBoundaryPreservedTranslation(cached);
    retryRecord.state = 'translated';
    node.nodeValue = retryRecord.translation;
    cached.translation = retryRecord.translation;
    cacheInlineViewportRecordTranslation(store, retryRecord);
    return retryRecord;
  }

  retryRecord.state = 'queued';
  store.queue.push(retryRecord);
  return retryRecord;
}

function resetQueuedInlineViewportRecords(store) {
  if (!store?.queue?.length) return;

  const retained = [];
  for (const record of store.queue) {
    if (record?.state === 'queued') {
      clearInlineViewportRetrySupersession(store, record);
      record.state = 'original';
      record.translation = null;
      continue;
    }
    retained.push(record);
  }
  store.queue = retained;
}

function takeInlineViewportBatch(
  store,
  maxChars = INLINE_VIEWPORT_BATCH_MAX_CHARS
) {
  if (!store || store.stopped || store.inFlight >= INLINE_VIEWPORT_MAX_IN_FLIGHT) {
    return [];
  }

  const limit = Number(maxChars) || INLINE_VIEWPORT_BATCH_MAX_CHARS;
  const batch = [];
  let total = 0;

  while (store.queue.length) {
    const record = store.queue[0];
    const size = getInlineRecordPayloadSize(record);
    if (getInlineRecordTextSize(record) > limit) {
      store.queue.shift();
      record.state = 'failed';
      continue;
    }
    if (batch.length && total + size > limit) break;

    store.queue.shift();
    record.state = 'translating';
    batch.push(record);
    total += size;

    if (total >= limit) break;
  }

  if (batch.length) {
    store.inFlight += 1;
  }
  return batch;
}

function applyInlineViewportBatchTranslations(records, translations, operationId, store = null) {
  const byId = new Map((translations || []).map((item) => [item.id, item.translation]));
  const result = { applied: 0, stale: 0, retried: 0, ignored: 0 };

  for (const record of records || []) {
    if (record.operationId !== operationId) {
      result.ignored += 1;
      continue;
    }

    const translation = byId.get(record.id);
    if (typeof translation !== 'string') {
      record.state = 'failed';
      continue;
    }

    if (!record.node?.isConnected || record.node.nodeValue !== record.original) {
      const currentText = record.node?.nodeValue;
      record.state = 'stale';
      result.stale += 1;
      const preservedRejectedTranslation = getInlineBoundaryPreservedTranslation(
        record,
        translation
      );
      if (
        typeof currentText === 'string' &&
        queueInlineViewportRetryRecord(
          store,
          record,
          currentText,
          preservedRejectedTranslation
        )
      ) {
        result.retried += 1;
      }
      continue;
    }

    const preservedTranslation = getInlineBoundaryPreservedTranslation(
      record,
      translation
    );
    record.node.nodeValue = preservedTranslation;
    record.translation = preservedTranslation;
    record.state = 'translated';
    stampInlineViewportRecordSettings(store, record);
    cacheInlineViewportRecordTranslation(store, record);
    result.applied += 1;
  }

  return result;
}

function markInlineViewportBatchFailed(records, operationId) {
  for (const record of records || []) {
    if (record.operationId === operationId && record.state === 'translating') {
      record.state = 'failed';
    }
  }
}

function getInlineViewportStatusCounts(records) {
  const counts = { translated: 0, pending: 0, changed: 0, failed: 0 };
  for (const record of records || []) {
    if (record.state === 'translated') counts.translated += 1;
    if (record.state === 'queued' || record.state === 'translating') {
      counts.pending += 1;
    }
    if (record.state === 'stale' && !record.supersededByRetryId) {
      counts.changed += 1;
    }
    if (record.state === 'failed') counts.failed += 1;
  }
  return counts;
}

function formatInlineViewportStatusMessage(counts, status = 'active') {
  const safe = counts || {};
  const stopped = status === 'stopped';
  return [
    stopped ? 'Visible translation stopped' : 'Visible translation on',
    `Translated ${Number(safe.translated) || 0} · Pending ${
      stopped ? 0 : Number(safe.pending) || 0
    } · Changed ${Number(safe.changed) || 0} · Failed ${
      Number(safe.failed) || 0
    }`,
  ].join('\n');
}

function getInlineTranslatorUiModel(
  state = inlineState,
  settings = state?.translationSettings || INLINE_TRANSLATION_SETTINGS_DEFAULTS
) {
  const status = state?.status || 'original';
  const targetLanguage =
    settings?.targetLanguage || INLINE_TRANSLATION_SETTINGS_DEFAULTS.targetLanguage;
  const menuOpen = Boolean(state?.menuOpen);
  const isActive = status === 'active';
  const isTranslating = status === 'translating';
  const canRestore = isActive || status === 'translated' || status === 'stopped';

  return {
    toggleText: isActive
      ? 'Translated'
      : isTranslating
      ? 'Translating...'
      : status === 'stopped'
      ? 'Stopped'
      : 'Translate',
    menuOpen,
    message: state?.message || '',
    translateText: isActive ? 'Scan visible text' : `Page in ${targetLanguage}`,
    stopDisabled: !isActive,
    restoreDisabled: !canRestore,
    translateDisabled: isTranslating,
    expanded: String(menuOpen),
  };
}

async function toggleInlineTranslatorMenu(
  chromeApi = globalThis.chrome,
  state = inlineState,
  renderUi = state === inlineState ? updateInlineTranslatorUi : null
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
  if (viewport?.observer) {
    viewport.observer.disconnect();
  }
  if (viewport?.scanTimer) {
    clearTimeout(viewport.scanTimer);
  }

  const restoredNodes = new Set();
  for (const record of getInlineViewportRestoreRecords(state)) {
    if (
      record.state === 'translated' &&
      record.node?.isConnected &&
      !restoredNodes.has(record.node)
    ) {
      if (
        typeof record.translation !== 'string' ||
        record.node.nodeValue !== record.translation
      ) {
        record.state = 'stale';
        continue;
      }
      record.node.nodeValue = record.original;
      restoredNodes.add(record.node);
    }
    record.state = 'original';
  }

  state.status = 'original';
  state.records = [];
  state.restorableRecords = [];
  state.operationId = (Number(state.operationId) || 0) + 1;
  state.viewport = createInlineViewportStore(
    state.operationId,
    state.translationCache
  );
}

function getInlineTextRecordBudgetError(records) {
  if (records.length > INLINE_MAX_RECORDS) {
    return `Too many text nodes for inline translation (${records.length}/${INLINE_MAX_RECORDS})`;
  }

  const totalChars = records.reduce(
    (sum, record) => sum + String(record.text || '').length,
    0
  );
  if (totalChars > INLINE_MAX_TOTAL_CHARS) {
    return `Inline translation has too much text (${totalChars}/${INLINE_MAX_TOTAL_CHARS} characters)`;
  }

  return '';
}

function pluralizeInline(count, singular, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

function formatInlineProgressMessage(progress) {
  if (!progress) return '';
  if (progress.stage === 'queued') {
    const recordCount = Number(progress.recordCount) || 0;
    const chunkCount = Number(progress.chunkCount) || 0;
    return `Preparing ${recordCount} ${pluralizeInline(
      recordCount,
      'text node'
    )} across ${chunkCount} ${pluralizeInline(chunkCount, 'chunk')}...`;
  }
  if (progress.stage === 'chunk') {
    const current = Number(progress.current) || 0;
    const total = Number(progress.total) || 0;
    const recordCount = Number(progress.recordCount) || 0;
    const charCount = Number(progress.charCount) || 0;
    return `Chunk ${current}/${total}: ${recordCount} ${pluralizeInline(
      recordCount,
      'text node'
    )}, ${charCount} ${pluralizeInline(charCount, 'char')}`;
  }
  if (progress.stage === 'chunk_done') {
    const current = Number(progress.current) || 0;
    const total = Number(progress.total) || 0;
    return `Completed ${current}/${total} ${pluralizeInline(total, 'chunk')}...`;
  }
  if (progress.stage === 'applying') {
    return 'Applying translated text...';
  }
  return String(progress.message || '');
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

function preserveInlineBoundaryWhitespace(original, translation) {
  const originalText = String(original || '');
  const translatedText = String(translation || '');
  if (!translatedText) return translatedText;

  const leading = originalText.match(/^\s*/)?.[0] || '';
  const trailing = originalText.match(/\s*$/)?.[0] || '';
  const core = translatedText.replace(/^\s+|\s+$/g, '');
  if (!core) return translatedText;
  return `${leading}${core}${trailing}`;
}

function applyInlineTranslationRecords(records) {
  const applied = [];
  let skipped = 0;

  for (const record of records) {
    if (!record.node?.isConnected) continue;
    if (record.node.nodeValue !== record.original) {
      skipped += 1;
      continue;
    }
    record.translation = getInlineBoundaryPreservedTranslation(record);
    record.node.nodeValue = record.translation;
    applied.push(record);
  }

  return { applied, skipped };
}

function cleanupRoot(root) {
  const clone = root.cloneNode(true);

  // Remove noisy elements
  const selectors = [
    'script',
    'style',
    'noscript',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'button',
    'input',
    'textarea',
    'select',
    'svg',
    'canvas',
  ];
  for (const sel of selectors) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }
  return clone;
}

function detectCodeLang(codeEl) {
  // Typical patterns: class="language-js" or "lang-js" etc.
  const cls =
    (codeEl.getAttribute('class') || '') +
    ' ' +
    (codeEl.parentElement?.getAttribute('class') || '');
  const m =
    cls.match(/language-([a-z0-9_-]+)/i) || cls.match(/lang-([a-z0-9_-]+)/i);
  return m ? m[1] : '';
}

function normalizeMarkdownInlineText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function wrapMarkdownInlineCode(text) {
  const code = normalizeMarkdownInlineText(text);
  if (!code) return '';
  const maxBacktickRun = (code.match(/`+/g) || []).reduce(
    (max, run) => Math.max(max, run.length),
    0
  );
  const delimiter = '`'.repeat(maxBacktickRun + 1);
  if (maxBacktickRun > 0) return `${delimiter} ${code} ${delimiter}`;
  return `${delimiter}${code}${delimiter}`;
}

function getMarkdownTextWithInlineCode(node) {
  const parts = [];

  function walk(current) {
    if (!current) return;
    if (current.nodeType === 3) {
      parts.push(current.nodeValue || '');
      return;
    }

    const tag = String(current.tagName || '').toLowerCase();
    if (tag === 'br') {
      parts.push(' ');
      return;
    }
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') {
      parts.push(wrapMarkdownInlineCode(current.textContent));
      return;
    }

    const children = Array.from(current.childNodes || []);
    if (children.length) {
      for (const child of children) walk(child);
      return;
    }

    if (typeof current.textContent === 'string') {
      parts.push(current.textContent);
    }
  }

  walk(node);
  return normalizeMarkdownInlineText(parts.join(''));
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

function toMarkdown(root) {
  const title = (document.title || '').trim();
  const url = location.href;
  const langHint = document.documentElement?.lang || '';

  const clean = cleanupRoot(root);

  // Walk in DOM order and capture a subset of block-level elements
  const walker = document.createTreeWalker(clean, NodeFilter.SHOW_ELEMENT);

  const out = [];

  function pushPara(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }

  // Title (always include once)
  if (title) out.push(`# ${title}`);
  out.push('');

  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!(el instanceof HTMLElement)) continue;

    const tag = el.tagName.toLowerCase();

    // Avoid common duplicates. Example: <li><p>Text</p></li>
    // We emit the <li> and skip nested <p>.
    if (tag === 'p' && el.closest('li')) {
      continue;
    }

    // Skip nested list-items (rare, but can cause repeats)
    if (tag === 'li') {
      const parentLi = el.parentElement?.closest?.('li');
      if (parentLi && parentLi !== el) continue;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = el.innerText?.trim();
      if (text) out.push(`${'#'.repeat(Math.min(level + 1, 6))} ${text}`);
      out.push('');
      continue;
    }

    // Code blocks
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const codeText = (code ? code.textContent : el.textContent) || '';
      const trimmed = codeText.replace(/\n+$/g, '');
      if (trimmed.trim()) {
        const lang = code ? detectCodeLang(code) : '';
        out.push('```' + lang);
        out.push(trimmed);
        out.push('```');
        out.push('');
      }
      continue;
    }

    // Paragraphs
    if (tag === 'p') {
      const text = getMarkdownTextWithInlineCode(el);
      pushPara(text);
      out.push('');
      continue;
    }

    // List items (simple)
    if (tag === 'li') {
      const t = getMarkdownTextWithInlineCode(el);
      if (t) out.push(`- ${t}`);
      continue;
    }
  }

  // Collapse multiple blank lines
  const md =
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';

  return {
    title,
    url,
    langHint,
    contentMarkdown: md,
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

function shouldSkipInlineTextNode(textNode) {
  const parent = textNode.parentElement;
  if (!parent) return true;
  if (parent.closest(`#${INLINE_TRANSLATOR_ID}`)) return true;
  for (let el = parent; el; el = el.parentElement) {
    if (isInlineTranslationExcludedElement(el)) return true;
    if (isElementHidden(el)) return true;
  }
  return !isTranslatableInlineText(textNode.nodeValue);
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
  if (isInlineTranslationExcludedElement(node) || isElementHidden(node)) {
    return true;
  }
  const rect = node.getBoundingClientRect?.();
  return rect ? !isInlineRectInViewport(rect, viewport) : false;
}

function getInlineChildNodes(node) {
  return Array.from(node?.childNodes || []);
}

function collectVisibleInlineTextNodesFromDom(root, store, maxTextNodes) {
  const limit = normalizeInlineViewportScanLimit(maxTextNodes);
  const startIndex = Math.max(0, Number(store?.scanStartIndex) || 0);
  const viewport = getInlineViewportInfo();
  const queued = [];
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
        !shouldSkipInlineTextNode(node) &&
        isInlineTextNodeInViewport(node, viewport)
      ) {
        const record = queueInlineViewportRecord(store, node, node.nodeValue);
        if (record) queued.push(record);
      }
      continue;
    }

    if (shouldSkipInlineElementSubtree(node, viewport)) continue;

    const children = getInlineChildNodes(node);
    for (let i = children.length - 1; i >= 0; i -= 1) {
      stack.push(children[i]);
    }
  }

  if (store) {
    store.scanStartIndex = truncated ? textIndex : 0;
  }
  return queued;
}

function collectVisibleInlineTextNodesWithTreeWalker(root, store, maxTextNodes) {
  const limit = normalizeInlineViewportScanLimit(maxTextNodes);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (shouldSkipInlineTextNode(node)) return NodeFilter.FILTER_REJECT;
      if (!isInlineTextNodeInViewport(node)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const queued = [];
  let inspected = 0;
  while (walker.nextNode()) {
    if (inspected >= limit) break;
    inspected += 1;
    const node = walker.currentNode;
    const record = queueInlineViewportRecord(store, node, node.nodeValue);
    if (record) queued.push(record);
  }
  return queued;
}

function collectInlineTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldSkipInlineTextNode(node)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const records = [];
  let index = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    records.push({
      id: `n${index + 1}`,
      node,
      text: node.nodeValue,
    });
    index += 1;
  }
  return records;
}

function collectVisibleInlineTextNodes(
  root,
  store,
  maxTextNodes = INLINE_VIEWPORT_SCAN_MAX_TEXT_NODES
) {
  if (root?.childNodes) {
    return collectVisibleInlineTextNodesFromDom(root, store, maxTextNodes);
  }
  return collectVisibleInlineTextNodesWithTreeWalker(root, store, maxTextNodes);
}

function setInlineMessage(message) {
  inlineState.message = message || '';
  updateInlineTranslatorUi();
}

function updateInlineViewportMessage() {
  const counts = getInlineViewportStatusCounts(inlineState.viewport?.records || []);
  inlineState.message = formatInlineViewportStatusMessage(
    counts,
    inlineState.status
  );
  updateInlineTranslatorUi();
}

function ensureInlineTranslatorUi() {
  let host = document.getElementById(INLINE_TRANSLATOR_ID);
  if (host && inlineUiRoot) {
    refreshInlineTranslatorSettings()
      .then(() => updateInlineTranslatorUi())
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
    [data-role="message"] {
      max-width: 220px;
      color: #b91c1c;
      font-size: 12px;
    }
    </style>
    <div data-role="container">
      <button type="button" data-role="toggle" aria-expanded="false">Translate</button>
      <div data-role="menu" hidden>
        <button type="button" data-action="translate">Page in Korean</button>
        <button type="button" data-action="stop">Stop</button>
        <button type="button" data-action="restore">Original text</button>
        <div data-role="message"></div>
      </div>
    </div>
  `;

  inlineUiRoot.querySelector('[data-role="toggle"]').addEventListener('click', (event) => {
    if (!isTrustedInlineUiEvent(event)) return;
    toggleInlineTranslatorMenu().catch(() => updateInlineTranslatorUi());
  });
  inlineUiRoot
    .querySelector('[data-action="translate"]')
    .addEventListener('click', (event) => {
      if (!authorizeInlineTranslationFromUiEvent(event)) return;
      translateInlinePage().catch((error) =>
        setInlineMessage(error?.message || String(error))
      );
    });
  inlineUiRoot
    .querySelector('[data-action="stop"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      stopInlineViewportTranslation();
      detachInlineViewportWatchers();
      updateInlineViewportMessage();
    });
  inlineUiRoot
    .querySelector('[data-action="restore"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      restoreInlineOriginal();
    });

  updateInlineTranslatorUi();
  refreshInlineTranslatorSettings()
    .then(() => updateInlineTranslatorUi())
    .catch(() => {});
  return host;
}

function updateInlineTranslatorUi() {
  if (!inlineUiRoot) return;
  const toggle = inlineUiRoot.querySelector('[data-role="toggle"]');
  const menu = inlineUiRoot.querySelector('[data-role="menu"]');
  const message = inlineUiRoot.querySelector('[data-role="message"]');
  const translate = inlineUiRoot.querySelector('[data-action="translate"]');
  const stop = inlineUiRoot.querySelector('[data-action="stop"]');
  const restore = inlineUiRoot.querySelector('[data-action="restore"]');
  const model = getInlineTranslatorUiModel(inlineState);

  toggle.textContent = model.toggleText;
  toggle.setAttribute('aria-expanded', model.expanded);
  menu.hidden = !model.menuOpen;
  message.textContent = model.message;
  translate.textContent = model.translateText;
  translate.disabled = model.translateDisabled;
  stop.disabled = model.stopDisabled;
  restore.disabled = model.restoreDisabled;
}

function runInlineViewportScan() {
  const store = inlineState.viewport;
  if (!store || store.stopped || inlineState.status !== 'active') return;
  const root = store.root || pickArticleRoot();
  if (!root) {
    setInlineMessage('No article content found.');
    return;
  }
  store.root = root;
  collectVisibleInlineTextNodes(root, store);
  if (store.scanStartIndex > 0) {
    scheduleInlineViewportScan();
  }
  updateInlineViewportMessage();
  drainInlineViewportQueue().catch((error) =>
    setInlineMessage(error?.message || String(error))
  );
}

function scheduleInlineViewportScan(options = {}) {
  const store = inlineState.viewport;
  if (!store || store.stopped || inlineState.status !== 'active') return;
  if (options?.resetScanStartIndex) {
    store.scanStartIndex = 0;
    resetQueuedInlineViewportRecords(store);
  }
  if (store.scanTimer) clearTimeout(store.scanTimer);
  store.scanTimer = setTimeout(() => {
    store.scanTimer = null;
    runInlineViewportScan();
  }, INLINE_VIEWPORT_SCAN_DEBOUNCE_MS);
}

function scheduleInlineViewportScanFromViewportChange() {
  scheduleInlineViewportScan({ resetScanStartIndex: true });
}

function addUniqueInlineViewportEventTarget(targets, seen, target) {
  if (!target || seen.has(target) || !target.addEventListener) return;
  targets.push(target);
  seen.add(target);
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

  addUniqueInlineViewportEventTarget(targets, seen, window);
  addUniqueInlineViewportEventTarget(targets, seen, document);
  addUniqueInlineViewportEventTarget(targets, seen, document.scrollingElement);
  addUniqueInlineViewportEventTarget(targets, seen, document.documentElement);
  addUniqueInlineViewportEventTarget(targets, seen, document.body);

  for (let el = root; el; el = el.parentElement) {
    if (isInlineScrollableElement(el)) {
      addUniqueInlineViewportEventTarget(targets, seen, el);
    }
  }

  return targets;
}

function attachInlineViewportWatchers(root) {
  const scrollTargets = getInlineViewportScrollTargets(root);
  for (const target of scrollTargets) {
    target.addEventListener(
      'scroll',
      scheduleInlineViewportScanFromViewportChange,
      { passive: true }
    );
  }
  window.addEventListener('resize', scheduleInlineViewportScanFromViewportChange);

  const observer = new MutationObserver(scheduleInlineViewportScanFromViewportChange);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  inlineState.viewport.observer = observer;
  inlineState.viewport.scrollTargets = scrollTargets;
}

function detachInlineViewportWatchers() {
  const scrollTargets = inlineState.viewport?.scrollTargets?.length
    ? inlineState.viewport.scrollTargets
    : [window];
  for (const target of scrollTargets) {
    target?.removeEventListener?.(
      'scroll',
      scheduleInlineViewportScanFromViewportChange
    );
  }
  window.removeEventListener('resize', scheduleInlineViewportScanFromViewportChange);
  if (inlineState.viewport) {
    inlineState.viewport.scrollTargets = [];
  }
  if (inlineState.viewport?.observer) {
    inlineState.viewport.observer.disconnect();
    inlineState.viewport.observer = null;
  }
}

async function drainInlineViewportQueue() {
  const store = inlineState.viewport;
  if (!store || store.stopped || inlineState.status !== 'active') return;
  const operationId = store.operationId;

  while (
    isInlineViewportOperationCurrent(inlineState, store, operationId) &&
    store.inFlight < INLINE_VIEWPORT_MAX_IN_FLIGHT &&
    store.queue.length
  ) {
    const batch = takeInlineViewportBatch(store);
    if (!batch.length) {
      updateInlineViewportMessage();
      return;
    }
    updateInlineViewportMessage();

    chrome.runtime
      .sendMessage({
        type: 'TRANSLATE_VISIBLE_TEXT_BATCH',
        operationId,
        settingsSnapshot: store.translationSettings,
        records: batch.map((record) => ({
          id: record.id,
          text: record.original,
        })),
      })
      .then((resp) => {
        if (!isInlineViewportOperationCurrent(inlineState, store, operationId)) {
          return;
        }
        if (!resp?.ok || !Array.isArray(resp.translations)) {
          markInlineViewportBatchFailed(batch, operationId);
          return;
        }
        applyInlineViewportBatchTranslations(
          batch,
          resp.translations,
          operationId,
          store
        );
        addInlineRestorableRecords(inlineState, batch);
      })
      .catch(() => {
        if (isInlineViewportOperationCurrent(inlineState, store, operationId)) {
          markInlineViewportBatchFailed(batch, operationId);
        }
      })
      .finally(() => {
        if (!isInlineViewportOperationCurrent(inlineState, store, operationId)) {
          return;
        }
        store.inFlight = Math.max(0, store.inFlight - 1);
        updateInlineViewportMessage();
        drainInlineViewportQueue().catch((error) =>
          setInlineMessage(error?.message || String(error))
        );
      });
  }
}

async function translateInlinePage() {
  if (
    inlineState.status === 'active' &&
    !canRestartInlineViewportTranslation(inlineState)
  ) {
    scheduleInlineViewportScan();
    updateInlineViewportMessage();
    return;
  }
  if (!hasInlineTranslationAuthorization()) {
    setInlineMessage(
      'Use the extension toolbar or shortcut first to authorize inline translation.'
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
    setInlineMessage('Open Options and paste your OpenAI API key.');
    return;
  }

  const root = pickArticleRoot();
  if (!root) throw new Error('No article content found.');

  detachInlineViewportWatchers();
  addInlineRestorableRecords(inlineState, inlineState.viewport?.records || []);
  const settingsSnapshot = createInlineTranslationSettingsSnapshot(
    settingsResponse.settings
  );
  inlineState.translationSettings = settingsSnapshot;
  const translationCache = activateInlineTranslationCacheBucket(
    inlineState,
    settingsSnapshot
  );
  inlineState.operationId = (Number(inlineState.operationId) || 0) + 1;
  inlineState.status = 'active';
  inlineState.viewport = createInlineViewportStore(
    inlineState.operationId,
    translationCache,
    settingsSnapshot
  );
  inlineState.viewport.root = root;
  seedInlineViewportStoreWithRestorableRecords(
    inlineState.viewport,
    inlineState.restorableRecords
  );
  inlineState.records = inlineState.viewport.records;

  attachInlineViewportWatchers(root);
  runInlineViewportScan();
}

function restoreInlineOriginal() {
  detachInlineViewportWatchers();
  restoreInlineViewportRecords(inlineState);
  setInlineMessage('');
  updateInlineTranslatorUi();
}

async function initInlineTranslator() {
  try {
    if (await getInlineAutoShowEnabled()) {
      ensureInlineTranslatorUi();
    }
  } catch {}
}

function handleExtractArticle(sendResponse) {
  try {
    const root = pickArticleRoot();
    const data = toMarkdown(root);

    // Basic sanity check: if too small, fall back to body
    if ((data.contentMarkdown || '').length < 300 && root !== document.body) {
      const data2 = toMarkdown(document.body);
      sendResponse({ ok: true, data: data2 });
      return;
    }

    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: { message: e?.message || String(e) } });
  }
}

if (
  typeof chrome !== 'undefined' &&
  chrome.runtime?.onMessage &&
  !globalThis.__chromeAiTranslatorContentInitialized
) {
  globalThis.__chromeAiTranslatorContentInitialized = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EXTRACT_ARTICLE') {
      handleExtractArticle(sendResponse);
      return true;
    }

    if (msg?.type === 'SHOW_INLINE_TRANSLATOR') {
      try {
        if (msg.allowInlineTranslation) {
          authorizeInlineTranslation();
        }
        ensureInlineTranslatorUi();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({
          ok: false,
          error: { message: e?.message || String(e) },
        });
      }
      return true;
    }

    if (msg?.type === 'INLINE_TRANSLATION_PROGRESS') {
      if (isCurrentInlineOperation(inlineState, msg.operationId)) {
        setInlineMessage(formatInlineProgressMessage(msg.progress));
      }
      return false;
    }
  });

  initInlineTranslator();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isInlineTranslationExcludedTag,
    isInlineTranslationExcludedElement,
    isCodeLikeInlineText,
    isTranslatableInlineText,
    getMarkdownTextWithInlineCode,
    isTrustedInlineUiEvent,
    resetInlineTranslationAfterFailure,
    getInlineTextRecordBudgetError,
    formatInlineProgressMessage,
    authorizeInlineTranslation,
    authorizeInlineTranslationFromUiEvent,
    hasInlineTranslationAuthorization,
    applyInlineTranslationRecords,
    beginInlineTranslationOperation,
    isCurrentInlineOperation,
    cancelInlineTranslationOperation,
    getInlineShadowMode,
    getInlineHostStyleText,
    isInlineRectInViewport,
    getInlineViewportInfo,
    getInlineTextNodeRect,
    isInlineTextNodeInViewport,
    collectVisibleInlineTextNodes,
    isInlineViewportOperationCurrent,
    stopInlineViewportTranslation,
    canRestartInlineViewportTranslation,
    hasInlineSettingsApiKey,
    getInlineAutoShowEnabled,
    refreshInlineTranslatorSettings,
    createInlineTranslationSettingsSnapshot,
    getInlineTranslationCacheSignature,
    getInlineTranslationCacheBucket,
    activateInlineTranslationCacheBucket,
    seedInlineViewportStoreWithRestorableRecords,
    createInlineViewportStore,
    queueInlineViewportRecord,
    queueInlineViewportRetryRecord,
    takeInlineViewportBatch,
    applyInlineViewportBatchTranslations,
    markInlineViewportBatchFailed,
    getInlineViewportStatusCounts,
    formatInlineViewportStatusMessage,
    getInlineTranslatorUiModel,
    toggleInlineTranslatorMenu,
    runInlineViewportScan,
    scheduleInlineViewportScanFromViewportChange,
    getInlineViewportScrollTargets,
    restoreInlineViewportRecords,
    restoreInlineOriginal,
  };
}
