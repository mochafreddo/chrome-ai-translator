const elApiKey = document.getElementById('apiKey');
const elTargetLanguage = document.getElementById('targetLanguage');
const elTone = document.getElementById('tone');
const elModel = document.getElementById('model');
const elChunkMaxChars = document.getElementById('chunkMaxChars');
const elInlineAutoShow = document.getElementById('inlineAutoShow');

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
  elInlineAutoShow.checked = Boolean(s.inlineAutoShow);
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
    model: elModel.value.trim() || 'gpt-5-mini',
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
