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
const elButtonVisibility = hasDocument
  ? Array.from(document.querySelectorAll('input[name="buttonVisibility"]'))
  : [];

const elStatus = hasDocument ? document.getElementById('status') : null;
const elError = hasDocument ? document.getElementById('errorBox') : null;
const elInlineLogs = hasDocument ? document.getElementById('inlineDiagnostics') : null;
const btnCopyDiagnostics = hasDocument ? document.getElementById('btnCopyDiagnostics') : null;
const btnSaveDiagnostics = hasDocument ? document.getElementById('btnSaveDiagnostics') : null;
const diagnosticsApi = globalThis.ChromeAiTranslatorDiagnostics ||
  (typeof module !== 'undefined' && module.exports
    ? require('./translation-diagnostics.js')
    : null);
const { ALL_SITES_ORIGINS, BUTTON_VISIBILITY, readButtonVisibility } =
  globalThis.ChromeAiTranslatorButtonVisibility ||
  (typeof module !== 'undefined' && module.exports
    ? require('./button-visibility.js')
    : {});
const { DEFAULT_MODEL } =
  globalThis.ChromeAiTranslatorDefaultModel ||
  (typeof module !== 'undefined' && module.exports
    ? require('./default-model.js')
    : {});

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
  elModel.value = s.model || DEFAULT_MODEL;
  elChunkMaxChars.value = s.chunkMaxChars || 12000;
  checkChoice(elButtonVisibility, readButtonVisibility(s));
}

function readCheckedChoice(inputs, fallback) {
  const checked = (inputs || []).find((input) => input?.checked);
  return checked ? checked.value : fallback;
}

function checkChoice(inputs, value) {
  for (const input of inputs || []) {
    input.checked = input.value === value;
  }
}

// Only the all-pages choice needs access to every site. Choosing either of the others gives
// that access back, which is what unchecking the old checkbox did.
//
// The answer is whether the save may go ahead, which is not the same as whether the access
// changed. A refused request stops it, because the choice cannot be honoured. A revocation
// that reports otherwise does not: the worker unregisters the content script for both of
// those choices regardless, so the button stays off the page either way.
async function applyButtonVisibilityAccess(chromeApi, visibility) {
  if (visibility === BUTTON_VISIBILITY.ALL_PAGES) {
    return Boolean(
      await chromeApi.permissions.request({ origins: ALL_SITES_ORIGINS })
    );
  }
  await chromeApi.permissions.remove({ origins: ALL_SITES_ORIGINS });
  return true;
}

function formatDiagnosticRun(run) {
  const summary = run?.summary || {};
  const codes = (run?.blocks || []).map((block) => block.terminalCode).filter(Boolean);
  return [
    `${run?.startedAt || '(unknown time)'} ${run?.outcome || 'interrupted'} model=${run?.model || '(unset)'}`,
    `  Translated ${summary.translated || 0} · Partial ${summary.translatedWithWarning || 0} · Changed ${summary.changed || 0} · Failed ${summary.failed || 0} · Repairs ${summary.repairs || 0}`,
    ...(codes.length ? [`  codes=${codes.join(',')}`] : []),
  ].join('\n');
}

async function loadInlineLogs() {
  const payload = await diagnosticsApi.loadDiagnostics(chrome);
  elInlineLogs.textContent = payload.runs.length
    ? payload.runs.map(formatDiagnosticRun).join('\n\n')
    : 'No inline diagnostics yet.';
  return payload;
}

async function copyDiagnostics() {
  const payload = await diagnosticsApi.loadDiagnostics(chrome);
  await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  setStatus('Diagnostics copied.');
}

async function saveDiagnostics() {
  const payload = await diagnosticsApi.loadDiagnostics(chrome);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = `chrome-ai-translator-diagnostics-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

async function save() {
  setError(null);
  setStatus('Saving...');

  // Asking for access to all sites needs the reader's gesture, which the first await would
  // spend — the same constraint ADR-0001 records for opening the side panel. So the request
  // is started before anything is awaited, and its answer is collected further down.
  const buttonVisibility = readCheckedChoice(
    elButtonVisibility,
    BUTTON_VISIBILITY.NEVER
  );
  const accessApplied = applyButtonVisibilityAccess(chrome, buttonVisibility);

  const stored = await chrome.storage.local.get(['settings']);
  const prev = stored.settings || {};

  if (!(await accessApplied)) {
    checkChoice(elButtonVisibility, readButtonVisibility(prev));
    setError(
      'Showing the floating translate button on every web page needs access to all sites. Nothing was saved.'
    );
    setStatus('');
    return;
  }

  const next = {
    ...prev,
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || DEFAULT_MODEL,
    chunkMaxChars: Number(elChunkMaxChars.value) || 12000,
    buttonVisibility,
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
  // The markup names no model of its own: a placeholder still naming the model the
  // extension defaulted to yesterday is the same quiet lie as a stale fallback.
  elModel.placeholder = DEFAULT_MODEL;

  document.getElementById('btnSave').addEventListener('click', handleSaveClick);
  document.getElementById('btnClear').addEventListener('click', clearKey);
  btnCopyDiagnostics.addEventListener('click', () => copyDiagnostics().catch((error) => setError(error?.message || String(error))));
  btnSaveDiagnostics.addEventListener('click', () => saveDiagnostics().catch((error) => setError(error?.message || String(error))));

  load()
    .then(loadInlineLogs)
    .catch((e) => setError(e?.message || String(e)));
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    applyButtonVisibilityAccess,
    checkChoice,
    clearStoredApiKey,
    readCheckedChoice,
    formatDiagnosticRun,
    shouldClearStoredApiKey,
  };
}
