const hasDocument = typeof document !== 'undefined';

const elApiKey = hasDocument ? document.getElementById('apiKey') : null;
const elTargetLanguage = hasDocument
  ? document.getElementById('targetLanguage')
  : null;
const elTone = hasDocument ? document.getElementById('tone') : null;
const elModel = hasDocument ? document.getElementById('model') : null;
const elChunkMaxChars = hasDocument
  ? document.getElementById('chunkMaxChars')
  : null;
const elInlineAutoShow = hasDocument
  ? document.getElementById('inlineAutoShow')
  : null;

const elStatus = hasDocument ? document.getElementById('status') : null;
const elError = hasDocument ? document.getElementById('errorBox') : null;
const elInlineLogs = hasDocument ? document.getElementById('inlineLogs') : null;
const btnRefreshInlineLogs = hasDocument
  ? document.getElementById('btnRefreshInlineLogs')
  : null;

const INLINE_LOG_STORAGE_KEY = 'inlineTranslationLogs';
const INLINE_LOG_STORAGE_KEY_PREFIX = `${INLINE_LOG_STORAGE_KEY}:`;
const INLINE_LOG_LIMIT = 20;

function setStatus(text) {
  elStatus.textContent = text || '';
}

function setError(text) {
  if (!text) {
    elError.hidden = true;
    elError.textContent = '';
    return;
  }
  elError.hidden = false;
  elError.textContent = text;
}

async function load() {
  const stored = await chrome.storage.local.get(['settings']);
  const s = stored.settings || {};

  // We never show the existing key in plain text.
  elApiKey.value = '';
  elTargetLanguage.value = s.targetLanguage || 'Korean';
  elTone.value = s.tone || 'technical';
  elModel.value = s.model || 'gpt-5.4-mini';
  elChunkMaxChars.value = s.chunkMaxChars || 12000;
  elInlineAutoShow.checked = Boolean(s.inlineAutoShow);
}

function formatDuration(ms) {
  const value = Number(ms) || 0;
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

function formatInlineLog(log) {
  const chunks = Array.isArray(log.chunks) ? log.chunks : [];
  const chunkSummary = chunks
    .map((chunk) => {
      const status = chunk.ok === false ? 'failed' : 'ok';
      const duration = chunk.durationMs == null ? '' : ` ${formatDuration(chunk.durationMs)}`;
      const error = chunk.error ? ` error=${chunk.error}` : '';
      return `  chunk ${chunk.index}: ${status}${duration}, ${chunk.recordCount} records, ${chunk.charCount} chars${error}`;
    })
    .join('\n');
  const lines = [
    `${log.startedAt || '(unknown time)'} ${log.status || 'unknown'} ${formatDuration(log.durationMs)}`,
    `  model=${log.model || '(unset)'} records=${log.recordCount || 0} chars=${log.totalChars || 0} chunks=${log.chunkCount || 0} chunkMax=${log.chunkMaxChars || 0}`,
  ];
  if (log.error) lines.push(`  error=${log.error}`);
  if (chunkSummary) lines.push(chunkSummary);
  return lines.join('\n');
}

function isInlineTranslationLogStorageKey(key) {
  return String(key || '').startsWith(INLINE_LOG_STORAGE_KEY_PREFIX);
}

function normalizeInlineTranslationLog(log) {
  if (!log || typeof log !== 'object' || !log.id) return null;
  return log;
}

function collectInlineTranslationLogsFromStorage(stored) {
  const byId = new Map();
  const legacy = Array.isArray(stored?.[INLINE_LOG_STORAGE_KEY])
    ? stored[INLINE_LOG_STORAGE_KEY]
    : [];

  for (const log of legacy) {
    const normalized = normalizeInlineTranslationLog(log);
    if (normalized) byId.set(normalized.id, normalized);
  }

  for (const [key, value] of Object.entries(stored || {})) {
    if (!isInlineTranslationLogStorageKey(key)) continue;
    const normalized = normalizeInlineTranslationLog(value);
    if (normalized) byId.set(normalized.id, normalized);
  }

  return Array.from(byId.values())
    .sort(
      (a, b) =>
        (Date.parse(b.startedAt || b.finishedAt || '') || 0) -
        (Date.parse(a.startedAt || a.finishedAt || '') || 0)
    )
    .slice(0, INLINE_LOG_LIMIT);
}

async function loadInlineLogs() {
  const stored = await chrome.storage.local.get(null);
  const logs = collectInlineTranslationLogsFromStorage(stored);
  elInlineLogs.textContent = logs.length
    ? logs.map(formatInlineLog).join('\n\n')
    : 'No inline translation logs yet.';
}

async function save() {
  setError(null);
  setStatus('Saving...');

  if (elInlineAutoShow.checked) {
    const granted = await chrome.permissions.request({
      origins: ['http://*/*', 'https://*/*'],
    });
    if (!granted) {
      elInlineAutoShow.checked = false;
      setError('Automatic inline button display needs website access permission.');
      setStatus('');
      return;
    }
  } else {
    await chrome.permissions.remove({
      origins: ['http://*/*', 'https://*/*'],
    });
  }

  const stored = await chrome.storage.local.get(['settings']);
  const prev = stored.settings || {};

  const next = {
    ...prev,
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || 'gpt-5.4-mini',
    chunkMaxChars: Number(elChunkMaxChars.value) || 12000,
    inlineAutoShow: elInlineAutoShow.checked,
  };

  const key = elApiKey.value.trim();
  if (key) next.apiKey = key;

  const resp = await chrome.runtime.sendMessage({
    type: 'SAVE_SETTINGS',
    settings: next,
  });
  if (!resp?.ok) {
    throw new Error(resp?.error?.message || 'Failed to save settings');
  }
  setStatus('Saved.');
  setTimeout(() => setStatus(''), 1200);
}

async function clearKey() {
  if (
    !shouldClearStoredApiKey(() =>
      window.confirm('Clear the stored OpenAI API key? This cannot be undone here.')
    )
  ) {
    setStatus('Key not changed.');
    setTimeout(() => setStatus(''), 1200);
    return;
  }
  await clearStoredApiKey(chrome);
  elApiKey.value = '';
  setStatus('Key cleared.');
  setTimeout(() => setStatus(''), 1200);
}

function shouldClearStoredApiKey(confirmFn) {
  return Boolean(confirmFn());
}

async function clearStoredApiKey(chromeApi) {
  const stored = await chromeApi.storage.local.get(['settings']);
  const next = { ...(stored.settings || {}) };
  delete next.apiKey;
  await chromeApi.storage.local.set({ settings: next });
  if (chromeApi.storage.local.remove) {
    await chromeApi.storage.local.remove('openai_api_key');
  }
}

function handleSaveClick() {
  save().catch((error) => {
    setError(error?.message || String(error));
    setStatus('');
  });
}

if (hasDocument) {
  document.getElementById('btnSave').addEventListener('click', handleSaveClick);
  document.getElementById('btnClear').addEventListener('click', clearKey);
  btnRefreshInlineLogs.addEventListener('click', () => {
    loadInlineLogs().catch((error) => setError(error?.message || String(error)));
  });

  load()
    .then(loadInlineLogs)
    .catch((e) => setError(e?.message || String(e)));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    clearStoredApiKey,
    collectInlineTranslationLogsFromStorage,
    formatInlineLog,
    shouldClearStoredApiKey,
  };
}
