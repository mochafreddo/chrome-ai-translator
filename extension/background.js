// background.js (MV3 service worker)
// Personal use only: API key is stored locally by the user.

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'none',
  targetLanguage: 'Korean',
  tone: 'technical',
  viewMode: 'translation', // translation | bilingual
  chunkMaxChars: 12000,
  cacheEnabled: false,
  cacheTtlDays: 7,
  inlineAutoShow: false,
};

const MIN_CHUNK_MAX_CHARS = 2000;
const MAX_CHUNK_MAX_CHARS = 60000;
const FULL_PAGE_TRANSLATION_MAX_TOTAL_CHARS = 60000;
const INLINE_CONTENT_SCRIPT_ID = 'inline-translator-auto-show';
const INLINE_ORIGINS = ['http://*/*', 'https://*/*'];
const INLINE_MAX_RECORDS = 500;
const INLINE_MAX_TOTAL_CHARS = 60000;
const INLINE_VISIBLE_BATCH_MAX_CHARS = 2000;
const INLINE_LOG_STORAGE_KEY = 'inlineTranslationLogs';
const INLINE_LOG_STORAGE_KEY_PREFIX = `${INLINE_LOG_STORAGE_KEY}:`;
const INLINE_LOG_LIMIT = 20;
const INLINE_TRANSLATION_MAX_CONCURRENCY = 3;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const INLINE_VISIBLE_BATCH_MAX_OUTPUT_TOKENS = 2048;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 128000;
const INLINE_TRANSLATION_MIN_MAX_CHARS = 1000;
const INLINE_TRANSLATION_EXPANSION_RATIO = 4;
const TONE_INSTRUCTIONS = {
  technical: 'Use a clear, technical tone suitable for docs.',
  natural: 'Use natural, fluent tone.',
  formal: 'Use formal and polite tone.',
};

// Per-tab in-memory state (lost when service worker sleeps; UI can re-trigger)
const stateByTab = new Map();
const activeTranslationsByTab = new Map();
let inlineAutoShowRegistrationSync = Promise.resolve();

function nowIso() {
  return new Date().toISOString();
}

function normalizeChunkMaxChars(value, fallback = DEFAULT_SETTINGS.chunkMaxChars) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(
    MAX_CHUNK_MAX_CHARS,
    Math.max(MIN_CHUNK_MAX_CHARS, Math.floor(parsed))
  );
}

function normalizeMaxOutputTokens(value, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(
    MAX_MAX_OUTPUT_TOKENS,
    Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(parsed))
  );
}

function getFullPageMaxOutputTokens(markdownChunk) {
  return normalizeMaxOutputTokens(
    Math.max(DEFAULT_MAX_OUTPUT_TOKENS, String(markdownChunk || '').length)
  );
}

function mergeSettings(partial) {
  const merged = { ...DEFAULT_SETTINGS, ...(partial || {}) };
  merged.chunkMaxChars = normalizeChunkMaxChars(merged.chunkMaxChars);
  return merged;
}

function mergeSettingsWithExisting(existing, partial) {
  return mergeSettings({
    ...(existing || {}),
    ...(partial || {}),
  });
}

function mergeVisibleBatchSettingsSnapshot(currentSettings, settingsSnapshot = null) {
  const merged = mergeSettings(currentSettings || {});
  if (!settingsSnapshot || typeof settingsSnapshot !== 'object') return merged;

  for (const key of [
    'targetLanguage',
    'tone',
    'model',
    'reasoningEffort',
  ]) {
    if (Object.prototype.hasOwnProperty.call(settingsSnapshot, key)) {
      merged[key] = String(settingsSnapshot[key] || DEFAULT_SETTINGS[key]);
    }
  }

  return merged;
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

function assertFullPageTranslationBudget(
  markdown,
  maxChars = FULL_PAGE_TRANSLATION_MAX_TOTAL_CHARS
) {
  const totalChars = String(markdown || '').length;
  if (totalChars > maxChars) {
    throw new Error(
      `Full-page translation has too much text (${totalChars}/${maxChars} characters)`
    );
  }
}

function buildInstructions({ targetLanguage, tone }) {
  return [
    `Translate the user's input into ${targetLanguage}.`,
    getToneInstruction(tone),
    'Preserve Markdown structure (headings, lists, links).',
    'Do NOT translate code blocks fenced by ``` or inline code wrapped by backticks. Keep them exactly as-is.',
    'Do NOT add extra commentary. Output ONLY the translated Markdown.',
  ].join('\n');
}

function getToneInstruction(tone) {
  return TONE_INSTRUCTIONS[tone] || TONE_INSTRUCTIONS.technical;
}

function buildTextNodeInstructions({ targetLanguage, tone }) {
  return [
    `Translate each record's text into ${targetLanguage}.`,
    getToneInstruction(tone),
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
  reasoningEffort = DEFAULT_SETTINGS.reasoningEffort,
  instructions,
  input,
  textFormat = null,
  maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
}) {
  const body = {
    model,
    instructions,
    input,
    max_output_tokens: normalizeMaxOutputTokens(maxOutputTokens),
  };
  if (reasoningEffort) {
    body.reasoning = { effort: reasoningEffort };
  }
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

  const expected = new Map(records.map((record) => [record.id, record]));
  const seen = new Set();
  const normalized = [];

  for (const item of translations) {
    const id = item?.id;
    const expectedRecord = expected.get(id);
    if (!expectedRecord) {
      throw new Error(`Unexpected translation id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate translation id: ${id}`);
    }
    if (typeof item.translation !== 'string') {
      throw new Error(`Missing translation for id: ${id}`);
    }
    assertInlineTranslationOutputBudget(item.translation, expectedRecord);
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

function getInlineTranslationMaxChars(record) {
  const originalLength = String(record?.text || '').length;
  return Math.max(
    INLINE_TRANSLATION_MIN_MAX_CHARS,
    originalLength * INLINE_TRANSLATION_EXPANSION_RATIO
  );
}

function assertInlineTranslationOutputBudget(translation, record) {
  const maxChars = getInlineTranslationMaxChars(record);
  if (String(translation || '').length > maxChars) {
    throw new Error(
      `Inline translation for id ${record?.id || '(unknown)'} is too long (${String(translation || '').length}/${maxChars} characters)`
    );
  }
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

function redactSecretText(value) {
  return String(value || '')
    .replace(
      /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]+|\bsk-[A-Za-z0-9_-]+/g,
      '[REDACTED_OPENAI_KEY]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function sanitizeLogError(error) {
  return redactSecretText(safeError(error).message).slice(0, 300);
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
            reasoningEffort: settings.reasoningEffort,
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

async function translateVisibleTextBatch(records, settingsSnapshot = null) {
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

    const settings = mergeVisibleBatchSettingsSnapshot(
      await getSettings(),
      settingsSnapshot
    );
    logEntry.model = settings.model;
    if (!settings.apiKey) {
      throw new Error('OpenAI API key is not set. Open Options and paste your key.');
    }

    const chunkStartedAtMs = Date.now();
    const output = await openaiTranslateChunk({
      apiKey: settings.apiKey,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      instructions: buildTextNodeInstructions(settings),
      input: JSON.stringify({ records: normalized }),
      textFormat: buildTextNodeResponseFormat(),
      maxOutputTokens: INLINE_VISIBLE_BATCH_MAX_OUTPUT_TOKENS,
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

function getInlineAutoShowContentScript() {
  return {
    id: INLINE_CONTENT_SCRIPT_ID,
    matches: INLINE_ORIGINS,
    js: ['content.js'],
    runAt: 'document_idle',
  };
}

function isDuplicateInlineContentScriptError(error) {
  return String(error?.message || error).includes(
    `Duplicate script ID '${INLINE_CONTENT_SCRIPT_ID}'`
  );
}

async function getRegisteredInlineAutoShowContentScript() {
  if (!chrome.scripting.getRegisteredContentScripts) return null;
  const scripts = await chrome.scripting.getRegisteredContentScripts({
    ids: [INLINE_CONTENT_SCRIPT_ID],
  });
  return (scripts || []).find((script) => script?.id === INLINE_CONTENT_SCRIPT_ID);
}

async function updateInlineAutoShowContentScript(script) {
  if (!chrome.scripting.updateContentScripts) return false;
  try {
    await chrome.scripting.updateContentScripts([script]);
    return true;
  } catch (error) {
    if (isDuplicateInlineContentScriptError(error)) return false;
    throw error;
  }
}

async function syncInlineAutoShowRegistration(settings = null) {
  const previousSync = inlineAutoShowRegistrationSync.catch(() => {});
  const nextSync = previousSync.then(() =>
    syncInlineAutoShowRegistrationNow(settings)
  );
  inlineAutoShowRegistrationSync = nextSync;
  return nextSync;
}

async function syncInlineAutoShowRegistrationSafely(settings = null) {
  try {
    await syncInlineAutoShowRegistration(settings);
    return true;
  } catch {
    return false;
  }
}

async function syncInlineAutoShowRegistrationNow(settings = null) {
  const effective = settings || (await getSettings());
  const canAutoShow =
    effective.inlineAutoShow && (await hasInlineAutoShowPermission());

  if (!canAutoShow) {
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: [INLINE_CONTENT_SCRIPT_ID],
      });
    } catch {}
    return;
  }

  const inlineContentScript = getInlineAutoShowContentScript();
  try {
    if (
      chrome.scripting.updateContentScripts &&
      (await getRegisteredInlineAutoShowContentScript())
    ) {
      if (await updateInlineAutoShowContentScript(inlineContentScript)) return;
    }
  } catch {}

  try {
    await chrome.scripting.registerContentScripts([inlineContentScript]);
  } catch (error) {
    if (isDuplicateInlineContentScriptError(error)) {
      if (await updateInlineAutoShowContentScript(inlineContentScript)) return;
      try {
        await chrome.scripting.unregisterContentScripts({
          ids: [INLINE_CONTENT_SCRIPT_ID],
        });
        await chrome.scripting.registerContentScripts([inlineContentScript]);
      } catch {}
      return;
    }
    throw error;
  }
}

async function translateTab(tabId, overrideSettings = null) {
  if (activeTranslationsByTab.has(tabId)) {
    return { skipped: true, reason: 'already_running' };
  }

  const operationToken = Symbol(`translate-tab-${tabId}`);
  activeTranslationsByTab.set(tabId, operationToken);

  try {
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
      return { skipped: true, reason: 'missing_api_key' };
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
      return { skipped: true, reason: 'content_script_unavailable' };
    }

    let extracted;
    try {
      extracted = await extractArticle(tabId);
    } catch (e) {
      setTabState(tabId, { status: 'error', error: safeError(e) });
      return { skipped: true, reason: 'extract_failed' };
    }

    setTabState(tabId, {
      status: 'translating',
      extracted,
      translated: null,
      settingsUsed: { ...settings, apiKey: '***' },
    });

    try {
      const instructions = buildInstructions(settings);
      assertFullPageTranslationBudget(extracted.contentMarkdown);
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
          reasoningEffort: settings.reasoningEffort,
          instructions,
          input: chunks[i],
          maxOutputTokens: getFullPageMaxOutputTokens(chunks[i]),
        });
        translatedChunks.push(out.trim());
      }

      const translated = translatedChunks.join('\n\n');
      setTabState(tabId, {
        status: 'done',
        translated,
        progress: null,
      });
      return { skipped: false };
    } catch (e) {
      setTabState(tabId, { status: 'error', error: safeError(e) });
      return { skipped: true, reason: 'translate_failed' };
    }
  } finally {
    if (activeTranslationsByTab.get(tabId) === operationToken) {
      activeTranslationsByTab.delete(tabId);
    }
  }
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    await saveSettings(settings);
    await syncInlineAutoShowRegistrationSafely(settings);
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {}
  });

  chrome.runtime.onStartup.addListener(async () => {
    await syncInlineAutoShowRegistrationSafely();
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
          const result = await translateTab(tabId, settingsOverride || null);
          sendResponse({
            ok: true,
            ...(result?.skipped
              ? { skipped: true, reason: result.reason }
              : {}),
          });
          return;
        }
        if (msg?.type === 'TRANSLATE_VISIBLE_TEXT_BATCH') {
          const translations = await translateVisibleTextBatch(
            msg.records || [],
            msg.settingsSnapshot || null
          );
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
          await syncInlineAutoShowRegistrationSafely(next);
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
    mergeVisibleBatchSettingsSnapshot,
    normalizeChunkMaxChars,
    assertFullPageTranslationBudget,
    buildTextNodeResponseFormat,
    getTextRecordStats,
    getTextRecordChunkStats,
    getInlineTranslationConcurrency,
    getInlineTranslationLogStorageKey,
    collectInlineTranslationLogsFromStorage,
    getVisibleInlineBatchMaxChars,
    normalizeVisibleTextBatchRecords,
    normalizeMaxOutputTokens,
    sanitizeLogError,
    splitTextRecordsIntoChunks,
    parseAndValidateTextNodeTranslations,
    assertTextRecordBudget,
    openaiTranslateChunk,
    syncInlineAutoShowRegistration,
    syncInlineAutoShowRegistrationSafely,
  };
}
