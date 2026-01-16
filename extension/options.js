const elApiKey = document.getElementById('apiKey');
const elTargetLanguage = document.getElementById('targetLanguage');
const elTone = document.getElementById('tone');
const elModel = document.getElementById('model');
const elChunkMaxChars = document.getElementById('chunkMaxChars');

const elStatus = document.getElementById('status');
const elError = document.getElementById('errorBox');

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
  elModel.value = s.model || 'gpt-5-mini';
  elChunkMaxChars.value = s.chunkMaxChars || 12000;
}

async function save() {
  setError(null);
  setStatus('Saving...');

  const stored = await chrome.storage.local.get(['settings']);
  const prev = stored.settings || {};

  const next = {
    ...prev,
    targetLanguage: elTargetLanguage.value.trim() || 'Korean',
    tone: elTone.value,
    model: elModel.value.trim() || 'gpt-5-mini',
    chunkMaxChars: Number(elChunkMaxChars.value) || 12000,
  };

  const key = elApiKey.value.trim();
  if (key) next.apiKey = key;

  await chrome.storage.local.set({ settings: next });
  setStatus('Saved.');
  setTimeout(() => setStatus(''), 1200);
}

async function clearKey() {
  const stored = await chrome.storage.local.get(['settings']);
  const next = { ...(stored.settings || {}) };
  delete next.apiKey;
  await chrome.storage.local.set({ settings: next });
  elApiKey.value = '';
  setStatus('Key cleared.');
  setTimeout(() => setStatus(''), 1200);
}

document.getElementById('btnSave').addEventListener('click', save);
document.getElementById('btnClear').addEventListener('click', clearKey);

load().catch((e) => setError(e?.message || String(e)));
