// background.js (MV3 service worker)
// Personal use only: API key is stored locally by the user.

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gpt-5-mini',
  targetLanguage: 'Korean',
  tone: 'technical',
  viewMode: 'translation', // translation | bilingual
  chunkMaxChars: 12000,
  cacheEnabled: false,
  cacheTtlDays: 7,
  inlineAutoShow: false,
};

const INLINE_CONTENT_SCRIPT_ID = 'inline-translator-auto-show';
const INLINE_ORIGINS = ['http://*/*', 'https://*/*'];
const INLINE_MAX_RECORDS = 500;
const INLINE_MAX_TOTAL_CHARS = 60000;
const INLINE_VISIBLE_BATCH_MAX_CHARS = 2000;
const INLINE_LOG_STORAGE_KEY = 'inlineTranslationLogs';
const INLINE_LOG_STORAGE_KEY_PREFIX = `${INLINE_LOG_STORAGE_KEY}:`;
const INLINE_LOG_LIMIT = 20;
const INLINE_TRANSLATION_MAX_CONCURRENCY = 3;

// Per-tab in-memory state (lost when service worker sleeps; UI can re-trigger)
const stateByTab = new Map();

function nowIso() {
  return new Date().toISOString();
}

function mergeSettings(partial) {
  return { ...DEFAULT_SETTINGS, ...(partial || {}) };
}

function mergeSettingsWithExisting(existing, partial) {
  return mergeSettings({
    ...(existing || {}),
    ...(partial || {}),
  });
}

async function getSettings() {
  const stored = await chrome.storage.local.get(['settings', 'openai_api_key']);
  // Backward/compat: allow apiKey in openai_api_key
  const settings = stored.settings || {};
  const apiKey = settings.apiKey || stored.openai_api_key || '';
  return mergeSettings({ ...settings, apiKey });
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

function setTabState(tabId, patch) {
  const prev = stateByTab.get(tabId) || { status: 'idle' };
  const next = { ...prev, ...patch, updatedAt: nowIso() };
  stateByTab.set(tabId, next);
  chrome.runtime
    .sendMessage({ type: 'STATE_UPDATED', tabId, state: next })
    .catch(() => {});
}

function safeError(err) {
  if (!err) return { message: 'Unknown error' };
  if (typeof err === 'string') return { message: err };
  return {
    message: err.message || String(err),
    name: err.name,
  };
}

async function ensureSidePanel(tabId) {
  // Allow clicking extension icon to open the side panel
  // (Fails silently on older versions or if not supported)
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}

  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true,
    });
  } catch {}

  try {
    await chrome.sidePanel.open({ tabId });
  } catch {}
}

async function ensureContentScript(tabId) {
  // Programmatic injection: requires "scripting" + "activeTab" (or host permissions)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    // If already injected, executeScript can still succeed; on some pages it may fail (e.g., chrome://)
    throw e;
  }
}

async function showInlineTranslator(tabId, options = {}) {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, {
    type: 'SHOW_INLINE_TRANSLATOR',
    allowInlineTranslation: Boolean(options.allowInlineTranslation),
  });
}

async function extractArticle(tabId) {
  const resp = await chrome.tabs.sendMessage(tabId, {
    type: 'EXTRACT_ARTICLE',
  });
  if (!resp || !resp.ok) {
    throw new Error(resp?.error?.message || 'Failed to extract article');
  }
  return resp.data;
}

function splitMarkdownIntoChunks(md, maxChars) {
  if (!md || md.length <= maxChars) return [md];

  // Prefer splitting by headings, then paragraphs.
  const lines = md.split(/\n/);
  const chunks = [];
  let buf = [];
  let bufLen = 0;

  function flush() {
    if (!buf.length) return;
    chunks.push(buf.join('\n').trim());
    buf = [];
    bufLen = 0;
  }

  for (const line of lines) {
    const isHeading = /^#{1,6}\s+/.test(line);
    const isHardBreak = line.trim() === '';

    // If we are crossing a heading and buffer is already sizeable, flush.
    if (isHeading && bufLen > Math.floor(maxChars * 0.6)) flush();

    buf.push(line);
    bufLen += line.length + 1;

    // If too big, flush on paragraph boundaries if possible.
    if (bufLen >= maxChars && isHardBreak) flush();
  }
  flush();

  // Last resort: if any chunk is still too large, hard-split.
  const hard = [];
  for (const c of chunks) {
    if (c.length <= maxChars) {
      hard.push(c);
      continue;
    }
    for (let i = 0; i < c.length; i += maxChars) {
      hard.push(c.slice(i, i + maxChars));
    }
  }
  return hard;
}

function buildInstructions({ targetLanguage, tone }) {
  const toneMap = {
    technical: 'Use a clear, technical tone suitable for docs.',
    natural: 'Use natural, fluent tone.',
    formal: 'Use formal and polite tone.',
  };
  const toneLine = toneMap[tone] || toneMap.technical;

  return [
    `Translate the user's input into ${targetLanguage}.`,
    toneLine,
    'Preserve Markdown structure (headings, lists, links).',
    'Do NOT translate code blocks fenced by ``` or inline code wrapped by backticks. Keep them exactly as-is.',
    'Do NOT add extra commentary. Output ONLY the translated Markdown.',
  ].join('\n');
}

function buildTextNodeInstructions({ targetLanguage, tone }) {
  const toneMap = {
    technical: 'Use a clear, technical tone suitable for docs.',
    natural: 'Use natural, fluent tone.',
    formal: 'Use formal and polite tone.',
  };
  const toneLine = toneMap[tone] || toneMap.technical;

  return [
    `Translate each record's text into ${targetLanguage}.`,
    toneLine,
    'Return one translation object for every input record.',
    'Preserve every id exactly.',
    'Do not translate code, commands, identifiers, URLs, filenames, product API names, or version strings.',
    'Do not add commentary.',
  ].join('\n');
}

function buildTextNodeResponseFormat() {
  return {
    type: 'json_schema',
    name: 'inline_translations',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        translations: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              translation: { type: 'string' },
            },
            required: ['id', 'translation'],
          },
        },
      },
      required: ['translations'],
    },
  };
}

async function openaiTranslateChunk({
  apiKey,
  model,
  instructions,
  input,
  textFormat = null,
}) {
  const body = {
    model,
    instructions,
    input,
  };
  if (textFormat) {
    body.text = { format: textFormat };
  }

  const res = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = json?.error?.message || `OpenAI API error (${res.status})`;
    throw new Error(msg);
  }

  // Per docs, the SDK exposes response.output_text; API response also includes output_text.
  const outputText = json?.output_text;
  if (typeof outputText === 'string' && outputText.trim()) return outputText;

  // Fallback: attempt to read from output array
  try {
    const outputs = json?.output || [];
    const parts = [];
    for (const o of outputs) {
      const content = o?.content || [];
      for (const c of content) {
        if (c?.type === 'output_text' && typeof c.text === 'string')
          parts.push(c.text);
        if (c?.type === 'text' && typeof c.text === 'string')
          parts.push(c.text);
      }
    }
    const joined = parts.join('\n').trim();
    if (joined) return joined;
  } catch {}

  throw new Error('Could not extract output_text from OpenAI response');
}

function getTextRecordStats(records) {
  return {
    recordCount: (records || []).length,
    totalChars: (records || []).reduce(
      (sum, record) => sum + String(record.text || '').length,
      0
    ),
  };
}

function getTextRecordChunkStats(records, index) {
  return {
    index,
    recordCount: (records || []).length,
    charCount: (records || []).reduce(
      (sum, record) => sum + String(record.text || '').length,
      0
    ),
  };
}

function getInlineTranslationConcurrency(chunkCount) {
  return Math.min(
    INLINE_TRANSLATION_MAX_CONCURRENCY,
    Math.max(1, Number(chunkCount) || 1)
  );
}

function getInlineTranslationLogStorageKey(logId) {
  return `${INLINE_LOG_STORAGE_KEY_PREFIX}${logId}`;
}

function isInlineTranslationLogStorageKey(key) {
  return String(key || '').startsWith(INLINE_LOG_STORAGE_KEY_PREFIX);
}

function normalizeInlineTranslationLog(log) {
  if (!log || typeof log !== 'object' || !log.id) return null;
  return log;
}

function collectInlineTranslationLogsFromStorage(
  stored,
  limit = INLINE_LOG_LIMIT
) {
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
    .slice(0, limit);
}

function getInlineTranslationLogRemovalKeys(stored, limit = INLINE_LOG_LIMIT) {
  return Object.entries(stored || {})
    .filter(
      ([key, value]) =>
        isInlineTranslationLogStorageKey(key) &&
        normalizeInlineTranslationLog(value)
    )
    .sort(
      ([, a], [, b]) =>
        (Date.parse(b.startedAt || b.finishedAt || '') || 0) -
        (Date.parse(a.startedAt || a.finishedAt || '') || 0)
    )
    .slice(limit)
    .map(([key]) => key);
}

function splitTextRecordsIntoChunks(records, maxChars) {
  const chunks = [];
  let current = [];
  let currentLen = 0;
  const limit = Number(maxChars) || DEFAULT_SETTINGS.chunkMaxChars;

  for (const record of records || []) {
    const size =
      String(record.id || '').length + String(record.text || '').length + 20;
    if (current.length && currentLen + size > limit) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(record);
    currentLen += size;
  }

  if (current.length) chunks.push(current);
  return chunks;
}

function parseAndValidateTextNodeTranslations(outputText, records) {
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error('Inline translation response was not valid JSON');
  }

  const translations = parsed?.translations;
  if (!Array.isArray(translations)) {
    throw new Error('Inline translation response did not include translations');
  }

  const expected = new Set(records.map((record) => record.id));
  const seen = new Set();
  const normalized = [];

  for (const item of translations) {
    const id = item?.id;
    if (!expected.has(id)) {
      throw new Error(`Unexpected translation id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate translation id: ${id}`);
    }
    if (typeof item.translation !== 'string') {
      throw new Error(`Missing translation for id: ${id}`);
    }
    seen.add(id);
    normalized.push({ id, translation: item.translation });
  }

  for (const record of records) {
    if (!seen.has(record.id)) {
      throw new Error(`Missing translation id: ${record.id}`);
    }
  }

  return normalized;
}

function normalizeTextNodeRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('Inline translation records must be an array');
  }

  return records.map((record, index) => {
    const id = record?.id;
    const text = record?.text;
    if (typeof id !== 'string' || !id) {
      throw new Error(`Invalid inline translation record id at index ${index}`);
    }
    if (typeof text !== 'string' || !text.trim()) {
      throw new Error(`Invalid inline translation text for id: ${id}`);
    }
    return { id, text };
  });
}

function getVisibleInlineBatchMaxChars() {
  return INLINE_VISIBLE_BATCH_MAX_CHARS;
}

function normalizeVisibleTextBatchRecords(records) {
  const normalized = normalizeTextNodeRecords(records);
  const totalChars = normalized.reduce(
    (sum, record) => sum + String(record.text || '').length,
    0
  );
  if (totalChars > INLINE_VISIBLE_BATCH_MAX_CHARS) {
    throw new Error(
      `Visible inline translation batch is too large (${totalChars}/${INLINE_VISIBLE_BATCH_MAX_CHARS} characters)`
    );
  }
  return normalized;
}

function assertTextRecordBudget(records) {
  if (records.length > INLINE_MAX_RECORDS) {
    throw new Error(`Too many text nodes for inline translation (${records.length}/${INLINE_MAX_RECORDS})`);
  }

  const totalChars = records.reduce(
    (sum, record) => sum + String(record.text || '').length,
    0
  );
  if (totalChars > INLINE_MAX_TOTAL_CHARS) {
    throw new Error(`Inline translation has too much text (${totalChars}/${INLINE_MAX_TOTAL_CHARS} characters)`);
  }
}

function createInlineTranslationLogEntry(startedAtMs) {
  return {
    id: `inline-${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date(startedAtMs).toISOString(),
    status: 'started',
    model: '',
    recordCount: 0,
    totalChars: 0,
    chunkCount: 0,
    chunkMaxChars: 0,
    chunks: [],
  };
}

function sanitizeLogError(error) {
  return safeError(error).message.slice(0, 300);
}

async function appendInlineTranslationLog(entry) {
  if (
    !entry ||
    typeof chrome === 'undefined' ||
    !chrome.storage?.local?.get ||
    !chrome.storage?.local?.set
  ) {
    return;
  }

  try {
    await chrome.storage.local.set({
      [getInlineTranslationLogStorageKey(entry.id)]: entry,
    });
    const stored = await chrome.storage.local.get(null);
    const keysToRemove = getInlineTranslationLogRemovalKeys(stored);
    if (keysToRemove.length && chrome.storage.local.remove) {
      await chrome.storage.local.remove(keysToRemove);
    }
  } catch {}
}

async function sendInlineTranslationProgress(tabId, operationId, progress) {
  if (
    !tabId ||
    operationId == null ||
    typeof chrome === 'undefined' ||
    !chrome.tabs?.sendMessage
  ) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'INLINE_TRANSLATION_PROGRESS',
      operationId,
      progress,
    });
  } catch {}
}

async function translateTextNodeRecords(records, context = {}) {
  const startedAtMs = Date.now();
  const logEntry = createInlineTranslationLogEntry(startedAtMs);
  const { tabId = null, operationId = null } = context;
  let completed = false;

  try {
    const normalized = normalizeTextNodeRecords(records);
    Object.assign(logEntry, getTextRecordStats(normalized));
    assertTextRecordBudget(normalized);
    if (!normalized.length) {
      completed = true;
      return [];
    }

    const settings = await getSettings();
    logEntry.model = settings.model;
    logEntry.chunkMaxChars = settings.chunkMaxChars;
    if (!settings.apiKey) {
      throw new Error('OpenAI API key is not set. Open Options and paste your key.');
    }

    const instructions = buildTextNodeInstructions(settings);
    const chunks = splitTextRecordsIntoChunks(
      normalized,
      settings.chunkMaxChars
    );
    logEntry.chunkCount = chunks.length;
    logEntry.chunks = chunks.map((chunk, index) =>
      getTextRecordChunkStats(chunk, index + 1)
    );

    await sendInlineTranslationProgress(tabId, operationId, {
      stage: 'queued',
      recordCount: logEntry.recordCount,
      totalChars: logEntry.totalChars,
      chunkCount: logEntry.chunkCount,
    });

    const translatedByChunk = new Array(chunks.length);
    const concurrency = getInlineTranslationConcurrency(chunks.length);
    let nextChunkIndex = 0;
    let completedChunks = 0;
    let firstError = null;

    async function processNextChunk() {
      while (!firstError) {
        const chunkIndex = nextChunkIndex;
        nextChunkIndex += 1;
        if (chunkIndex >= chunks.length) return;

        const chunk = chunks[chunkIndex];
        const chunkLog = logEntry.chunks[chunkIndex];
        await sendInlineTranslationProgress(tabId, operationId, {
          stage: 'chunk',
          current: chunkIndex + 1,
          total: chunks.length,
          recordCount: chunkLog.recordCount,
          charCount: chunkLog.charCount,
        });

        const chunkStartedAtMs = Date.now();
        try {
          const output = await openaiTranslateChunk({
            apiKey: settings.apiKey,
            model: settings.model,
            instructions,
            input: JSON.stringify({ records: chunk }),
            textFormat: buildTextNodeResponseFormat(),
          });
          translatedByChunk[chunkIndex] =
            parseAndValidateTextNodeTranslations(output, chunk);
          chunkLog.durationMs = Date.now() - chunkStartedAtMs;
          chunkLog.ok = true;
          completedChunks += 1;
          await sendInlineTranslationProgress(tabId, operationId, {
            stage: 'chunk_done',
            current: completedChunks,
            total: chunks.length,
          });
        } catch (error) {
          chunkLog.durationMs = Date.now() - chunkStartedAtMs;
          chunkLog.ok = false;
          chunkLog.error = sanitizeLogError(error);
          firstError = firstError || error;
        }
      }
    }

    await Promise.all(
      Array.from({ length: concurrency }, () => processNextChunk())
    );
    if (firstError) throw firstError;

    const translated = translatedByChunk.flat();

    await sendInlineTranslationProgress(tabId, operationId, {
      stage: 'applying',
    });
    completed = true;
    return translated;
  } catch (error) {
    logEntry.error = sanitizeLogError(error);
    throw error;
  } finally {
    const finishedAtMs = Date.now();
    logEntry.status = completed ? 'done' : 'error';
    logEntry.finishedAt = new Date(finishedAtMs).toISOString();
    logEntry.durationMs = finishedAtMs - startedAtMs;
    await appendInlineTranslationLog(logEntry);
  }
}

async function translateVisibleTextBatch(records) {
  const startedAtMs = Date.now();
  const logEntry = createInlineTranslationLogEntry(startedAtMs);
  let completed = false;

  try {
    const normalized = normalizeVisibleTextBatchRecords(records);
    Object.assign(logEntry, getTextRecordStats(normalized));
    logEntry.chunkCount = normalized.length ? 1 : 0;
    logEntry.chunkMaxChars = INLINE_VISIBLE_BATCH_MAX_CHARS;
    logEntry.chunks = normalized.length
      ? [getTextRecordChunkStats(normalized, 1)]
      : [];

    if (!normalized.length) {
      completed = true;
      return [];
    }

    const settings = await getSettings();
    logEntry.model = settings.model;
    if (!settings.apiKey) {
      throw new Error('OpenAI API key is not set. Open Options and paste your key.');
    }

    const chunkStartedAtMs = Date.now();
    const output = await openaiTranslateChunk({
      apiKey: settings.apiKey,
      model: settings.model,
      instructions: buildTextNodeInstructions(settings),
      input: JSON.stringify({ records: normalized }),
      textFormat: buildTextNodeResponseFormat(),
    });

    const translations = parseAndValidateTextNodeTranslations(output, normalized);
    if (logEntry.chunks[0]) {
      logEntry.chunks[0].durationMs = Date.now() - chunkStartedAtMs;
      logEntry.chunks[0].ok = true;
    }
    completed = true;
    return translations;
  } catch (error) {
    logEntry.error = sanitizeLogError(error);
    if (logEntry.chunks[0]) {
      logEntry.chunks[0].ok = false;
      logEntry.chunks[0].error = sanitizeLogError(error);
    }
    throw error;
  } finally {
    const finishedAtMs = Date.now();
    logEntry.status = completed ? 'done' : 'error';
    logEntry.finishedAt = new Date(finishedAtMs).toISOString();
    logEntry.durationMs = finishedAtMs - startedAtMs;
    await appendInlineTranslationLog(logEntry);
  }
}

async function hasInlineAutoShowPermission() {
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins: INLINE_ORIGINS });
}

async function syncInlineAutoShowRegistration(settings = null) {
  const effective = settings || (await getSettings());
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [INLINE_CONTENT_SCRIPT_ID],
    });
  } catch {}

  if (!effective.inlineAutoShow) return;
  if (!(await hasInlineAutoShowPermission())) return;

  await chrome.scripting.registerContentScripts([
    {
      id: INLINE_CONTENT_SCRIPT_ID,
      matches: INLINE_ORIGINS,
      js: ['content.js'],
      runAt: 'document_idle',
    },
  ]);
}

async function translateTab(tabId, overrideSettings = null) {
  const settings = mergeSettings({
    ...(await getSettings()),
    ...(overrideSettings || {}),
  });

  if (!settings.apiKey) {
    setTabState(tabId, {
      status: 'error',
      error: {
        message: 'OpenAI API key is not set. Open Options and paste your key.',
      },
    });
    return;
  }

  setTabState(tabId, { status: 'extracting', error: null });
  await ensureSidePanel(tabId);

  try {
    await ensureContentScript(tabId);
  } catch (e) {
    setTabState(tabId, {
      status: 'error',
      error: {
        message:
          'Cannot run on this page (e.g., chrome:// pages). Open a normal website tab.',
      },
    });
    return;
  }

  let extracted;
  try {
    extracted = await extractArticle(tabId);
  } catch (e) {
    setTabState(tabId, { status: 'error', error: safeError(e) });
    return;
  }

  setTabState(tabId, {
    status: 'translating',
    extracted,
    translated: null,
    settingsUsed: { ...settings, apiKey: '***' },
  });

  try {
    const instructions = buildInstructions(settings);
    const chunks = splitMarkdownIntoChunks(
      extracted.contentMarkdown,
      settings.chunkMaxChars
    );
    const translatedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
      setTabState(tabId, {
        status: 'translating',
        progress: { current: i + 1, total: chunks.length },
      });
      const out = await openaiTranslateChunk({
        apiKey: settings.apiKey,
        model: settings.model,
        instructions,
        input: chunks[i],
      });
      translatedChunks.push(out.trim());
    }

    const translated = translatedChunks.join('\n\n');
    setTabState(tabId, {
      status: 'done',
      translated,
      progress: null,
    });
  } catch (e) {
    setTabState(tabId, { status: 'error', error: safeError(e) });
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    await saveSettings(settings);
    await syncInlineAutoShowRegistration(settings);
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {}
  });

  chrome.runtime.onStartup.addListener(async () => {
    await syncInlineAutoShowRegistration();
  });

  chrome.action.onClicked.addListener(async (tab) => {
    if (!tab?.id) return;
    try {
      await showInlineTranslator(tab.id, { allowInlineTranslation: true });
    } catch {}
    await translateTab(tab.id);
  });

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== 'translate-current-tab') return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (!tabId) return;
    try {
      await showInlineTranslator(tabId, { allowInlineTranslation: true });
    } catch {}
    await translateTab(tabId);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      try {
        if (msg?.type === 'GET_STATE') {
          const tabId = msg.tabId;
          sendResponse({
            ok: true,
            state: stateByTab.get(tabId) || { status: 'idle' },
          });
          return;
        }
        if (msg?.type === 'TRANSLATE_TAB') {
          const { tabId, settingsOverride } = msg;
          await translateTab(tabId, settingsOverride || null);
          sendResponse({ ok: true });
          return;
        }
        if (msg?.type === 'TRANSLATE_TEXT_NODES') {
          const translations = await translateTextNodeRecords(
            msg.records || [],
            {
              tabId: sender.tab?.id,
              operationId: msg.operationId,
            }
          );
          sendResponse({ ok: true, translations });
          return;
        }
        if (msg?.type === 'TRANSLATE_VISIBLE_TEXT_BATCH') {
          const translations = await translateVisibleTextBatch(msg.records || []);
          sendResponse({ ok: true, translations });
          return;
        }
        if (msg?.type === 'GET_SETTINGS') {
          const settings = await getSettings();
          settings.apiKey = settings.apiKey ? '***' : '';
          sendResponse({ ok: true, settings });
          return;
        }
        if (msg?.type === 'SAVE_SETTINGS') {
          const current = await getSettings();
          const next = mergeSettingsWithExisting(current, msg.settings || {});
          await saveSettings(next);
          await syncInlineAutoShowRegistration(next);
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: { message: 'Unknown message' } });
      } catch (e) {
        sendResponse({ ok: false, error: safeError(e) });
      }
    })();

    // Keep the message channel open for async response
    return true;
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    mergeSettingsWithExisting,
    buildTextNodeResponseFormat,
    getTextRecordStats,
    getTextRecordChunkStats,
    getInlineTranslationConcurrency,
    getInlineTranslationLogStorageKey,
    collectInlineTranslationLogsFromStorage,
    getVisibleInlineBatchMaxChars,
    normalizeVisibleTextBatchRecords,
    splitTextRecordsIntoChunks,
    parseAndValidateTextNodeTranslations,
    assertTextRecordBudget,
  };
}
