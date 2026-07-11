// background.js (MV3 service worker)
// Personal use only: API key is stored locally by the user.

if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorInlineBlock
) {
  importScripts('inline-block.js');
}
const inlineBlockCodec =
  globalThis.ChromeAiTranslatorInlineBlock ||
  (typeof module !== 'undefined' && module.exports
    ? require('./inline-block.js')
    : null);
if (typeof importScripts === 'function') {
  if (!globalThis.ChromeAiTranslatorValidation) {
    importScripts('translation-validation.js');
  }
  if (!globalThis.ChromeAiTranslatorPolicy) {
    importScripts('translation-policy.js');
  }
  if (!globalThis.ChromeAiTranslatorDiagnostics) {
    importScripts('translation-diagnostics.js');
  }
}
const translationValidation =
  globalThis.ChromeAiTranslatorValidation || require('./translation-validation.js');
const translationPolicy =
  globalThis.ChromeAiTranslatorPolicy || require('./translation-policy.js');
const translationDiagnostics =
  globalThis.ChromeAiTranslatorDiagnostics || require('./translation-diagnostics.js');

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
const INLINE_BLOCK_MAX_RECORD_COST = 12000;
const INLINE_BLOCK_MAX_BATCH_COST = 12000;
const INLINE_BLOCK_MAX_SESSION_COST = 60000;
const INLINE_BLOCK_MIN_OUTPUT_TOKENS = 4096;
const INLINE_BLOCK_MAX_OUTPUT_TOKENS = 16000;
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

function getInlineContentScriptFiles() {
  return ['inline-block.js', 'content.js'];
}

async function ensureContentScript(tabId) {
  // Programmatic injection: requires "scripting" + "activeTab" (or host permissions)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: getInlineContentScriptFiles(),
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

function getTargetLanguageCode(targetLanguage) {
  const normalized = String(targetLanguage || '')
    .normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) return '';
  if (
    /^en(?:[-_][a-z0-9]+)*$/i.test(normalized) ||
    /^english\b/i.test(normalized) ||
    /^(?:american|british|us|uk|australian|canadian|new zealand) english\b/i.test(
      normalized
    ) ||
    /^(?:(?:미국|영국|호주|캐나다|뉴질랜드)(?:식)?\s*)?(?:영어|영문)(?:\s|$|\()/.test(
      normalized
    )
  ) {
    return 'en';
  }
  if (
    /^ko(?:[-_][a-z0-9]+)*$/i.test(normalized) ||
    /^(?:korean|south korean|north korean)\b/i.test(normalized) ||
    /^(?:한국어|한국말|조선어|조선말)(?:\s|$|\()/.test(normalized)
  ) {
    return 'ko';
  }
  return '';
}

function isKoreanTargetLanguage(targetLanguage) {
  return getTargetLanguageCode(targetLanguage) === 'ko';
}

function buildBlockInstructions({ targetLanguage, tone }) {
  const instructions = [
    `Translate each complete semantic block into ${targetLanguage}.`,
    getToneInstruction(tone),
    'Return one translation object for every input record and preserve every id exactly.',
    'Preserve every token byte-for-byte and emit each token exactly once.',
    'Translate all source-language prose, including text between wrapper OPEN and CLOSE tokens; wrapper tokens preserve formatting, not wording.',
    'Use atom labels only as context; atomic visible text remains represented by its token and only atom text marked preserveText may remain unchanged.',
    'Reorder and rewrite grammar naturally for the target language; source word order is not a constraint, but token parent relationships must not change.',
    'Never return the source template unchanged or partially copy source-language prose.',
  ];
  if (isKoreanTargetLanguage(targetLanguage)) {
    instructions.push(
      'For Korean, place a preserved atom before the translated noun phrase when natural. Example: “Reasoning models like [GPT-5.5] use ...” becomes “[GPT-5.5]와 같은 추론 모델은 ...”; write “모델은”, never “모델는”, choose particles from the visible label, and never emit empty example parenthesis.',
      'For Korean, do not guess a particle after an opaque technical or model atom. Add an appropriate classifier and attach the particle there, such as “[gpt-5.4] 모델을 고려하세요,” never “[gpt-5.4]을 고려하세요,” or rewrite the sentence to avoid a direct particle.'
    );
  }
  instructions.push(
    'When repair is non-null, redo the translation and correct previousErrorCode, including any translation_incomplete result.',
    'Do not output HTML, Markdown, commentary, or any field not required by the schema.'
  );
  return instructions.join('\n');
}

function buildBlockResponseFormat() {
  return {
    type: 'json_schema',
    name: 'inline_block_translations',
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
              template: { type: 'string' },
            },
            required: ['id', 'template'],
          },
        },
      },
      required: ['translations'],
    },
  };
}

const INLINE_BLOCK_REPAIRABLE_ERROR_CODES = new Set([
  'token_missing',
  'token_duplicate',
  'token_unknown',
  'token_nesting_invalid',
  'token_parent_changed',
  'output_too_long',
  'output_parse_failed',
  'translation_incomplete',
]);
const INLINE_BLOCK_ATOM_FIELDS = new Set([
  'token',
  'kind',
  'label',
  'preserveText',
]);

function normalizeBlockAtom(atom, recordId, atomIndex) {
  if (!atom || typeof atom !== 'object' || Array.isArray(atom)) {
    throw new Error(`Invalid atom ${atomIndex} for block ${recordId}`);
  }
  for (const key of Object.keys(atom)) {
    if (!INLINE_BLOCK_ATOM_FIELDS.has(key)) {
      throw new Error(`Unexpected atom field '${key}' for block ${recordId}`);
    }
  }
  if (typeof atom.token !== 'string' || !atom.token) {
    throw new Error(`Invalid atom token for block ${recordId}`);
  }
  if (typeof atom.kind !== 'string' || !atom.kind) {
    throw new Error(`Invalid atom kind for block ${recordId}`);
  }
  if (typeof atom.preserveText !== 'boolean') {
    throw new Error(`Invalid atom preserveText for block ${recordId}`);
  }
  const normalized = {
    token: atom.token,
    kind: atom.kind,
    preserveText: atom.preserveText,
  };
  if ('label' in atom) {
    if (typeof atom.label !== 'string') {
      throw new Error(`Invalid atom label for block ${recordId}`);
    }
    normalized.label = atom.label;
  }
  return normalized;
}

function normalizeBlockRepair(repair, recordId) {
  if (repair == null) return null;
  if (!repair || typeof repair !== 'object' || Array.isArray(repair)) {
    throw new Error(`Invalid repair metadata for block ${recordId}`);
  }
  if (repair.attempt !== 1) {
    throw new Error(`Invalid repair attempt for block ${recordId}`);
  }
  if (!INLINE_BLOCK_REPAIRABLE_ERROR_CODES.has(repair.previousErrorCode)) {
    throw new Error(`Invalid repair error code for block ${recordId}`);
  }
  return {
    attempt: 1,
    previousErrorCode: repair.previousErrorCode,
  };
}

function getBlockRecordCost(record) {
  return (
    String(record?.template || '').length +
    JSON.stringify(record?.atoms || []).length +
    JSON.stringify(record?.repair ?? null).length
  );
}

function getBlockBatchMaxOutputTokens(recordCost) {
  const scaled = Math.ceil((Number(recordCost) || 0) * 1.25);
  return Math.min(
    INLINE_BLOCK_MAX_OUTPUT_TOKENS,
    Math.max(INLINE_BLOCK_MIN_OUTPUT_TOKENS, scaled)
  );
}

function assertInlineBlockSessionBudget(currentCost, additionalCost) {
  const total = (Number(currentCost) || 0) + (Number(additionalCost) || 0);
  if (total > INLINE_BLOCK_MAX_SESSION_COST) {
    throw new Error(
      `Inline block translation session is too large (${total}/${INLINE_BLOCK_MAX_SESSION_COST} characters)`
    );
  }
  return total;
}

function normalizeVisibleBlockBatchRecords(records) {
  if (!Array.isArray(records)) {
    throw new Error('Inline block translation records must be an array');
  }
  if (records.length > INLINE_MAX_RECORDS) {
    throw new Error(
      `Too many semantic blocks for inline translation (${records.length}/${INLINE_MAX_RECORDS})`
    );
  }
  const seen = new Set();
  const normalized = records.map((record, index) => {
    const id = record?.id;
    if (typeof id !== 'string' || !id) {
      throw new Error(`Invalid inline block record id at index ${index}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate inline block record id: ${id}`);
    seen.add(id);
    if (typeof record.template !== 'string' || !record.template.trim()) {
      throw new Error(`Invalid inline block template for id: ${id}`);
    }
    if (!record.contract || typeof record.contract !== 'object') {
      throw new Error(`Missing inline block token contract for id: ${id}`);
    }
    const atoms = Array.isArray(record.atoms)
      ? record.atoms.map((atom, atomIndex) =>
          normalizeBlockAtom(atom, id, atomIndex)
        )
      : (() => {
          throw new Error(`Invalid inline block atoms for id: ${id}`);
        })();
    const normalizedRecord = {
      id,
      template: record.template,
      atoms,
      contract: record.contract,
      repair: normalizeBlockRepair(record.repair, id),
    };
    const validation = inlineBlockCodec?.validateTranslatedTemplate(
      normalizedRecord.template,
      normalizedRecord.contract
    );
    if (!validation?.ok) {
      throw new Error(
        `Invalid source token contract for block ${id}: ${validation?.errorCode || 'output_parse_failed'}`
      );
    }
    const cost = getBlockRecordCost(normalizedRecord);
    if (cost > INLINE_BLOCK_MAX_RECORD_COST) {
      throw new Error(
        `Inline block record is too large (${cost}/${INLINE_BLOCK_MAX_RECORD_COST} characters)`
      );
    }
    return normalizedRecord;
  });
  const totalCost = normalized.reduce(
    (sum, record) => sum + getBlockRecordCost(record),
    0
  );
  if (totalCost > INLINE_BLOCK_MAX_BATCH_COST) {
    throw new Error(
      `Visible inline block batch is too large (${totalCost}/${INLINE_BLOCK_MAX_BATCH_COST} characters)`
    );
  }
  return normalized;
}

function normalizeBlockContainerText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeBlockLiteralTokens(value, literalTokens) {
  let text = String(value || '');
  for (const literal of literalTokens || []) {
    if (typeof literal?.value !== 'string' || !literal.value) continue;
    text = text.split(literal.value).join(' ');
  }
  return text;
}

function collectBlockContainerProseText(tree, literalTokens = []) {
  const proseTextById = new Map();

  function visit(container) {
    const pieces = [];
    for (const child of container.children || []) {
      if (child.type === 'text') pieces.push(child.value);
      if (child.type === 'wrapper') pieces.push(visit(child));
    }
    const proseText = normalizeBlockContainerText(
      removeBlockLiteralTokens(pieces.join(' '), literalTokens)
    );
    proseTextById.set(container.id, proseText);
    return proseText;
  }

  visit(tree);
  return proseTextById;
}

function getEnglishWordEntries(value) {
  const text = String(value || '');
  return Array.from(
    text.matchAll(/[A-Za-z]+(?:['’\u2019-][A-Za-z]+)*/g),
    (match) => ({
      word: match[0],
      start: match.index,
      end: match.index + match[0].length,
    })
  );
}

const ENGLISH_PROSE_MARKERS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'get',
  'getting',
  'go',
  'how',
  'in',
  'is',
  'learn',
  'more',
  'of',
  'on',
  'or',
  'read',
  'start',
  'started',
  'the',
  'this',
  'to',
  'use',
  'using',
  'view',
  'with',
  'you',
  'your',
]);
const TECHNICAL_NAME_SUFFIXES = new Set(['API', 'SDK', 'CLI', 'IDE']);
const NAMED_TECHNICAL_WORDS = new Set([
  ...TECHNICAL_NAME_SUFFIXES,
  'AI',
  'GPT',
  'HTTP',
  'HTTPS',
  'JSON',
  'LLM',
  'REST',
  'SQL',
  'UI',
  'UX',
  'XML',
]);

function isTechnicalEnglishWord(word) {
  return (
    NAMED_TECHNICAL_WORDS.has(String(word || '').toUpperCase()) ||
    /[a-z][A-Z]/.test(word)
  );
}

function isTechnicalTitleSeparator(value) {
  return /^\s+$/.test(value) || /^\s*[()]\s*$/.test(value);
}

function isEnglishTitleWord(word) {
  return /^[A-Z][A-Za-z]*$/.test(word);
}

function getProtectedTechnicalTitleRangeIds(sourceText, sourceEntries) {
  const rangeIds = new Array(sourceEntries.length).fill(-1);
  let rangeId = 0;
  let index = 0;

  while (index < sourceEntries.length) {
    if (!isEnglishTitleWord(sourceEntries[index].word)) {
      index += 1;
      continue;
    }

    const start = index;
    index += 1;
    while (
      index < sourceEntries.length &&
      !TECHNICAL_NAME_SUFFIXES.has(sourceEntries[index - 1].word) &&
      isTechnicalTitleSeparator(
        sourceText.slice(
          sourceEntries[index - 1].end,
          sourceEntries[index].start
        )
      ) &&
      isEnglishTitleWord(sourceEntries[index].word)
    ) {
      index += 1;
    }

    if (!TECHNICAL_NAME_SUFFIXES.has(sourceEntries[index - 1].word)) {
      continue;
    }
    for (let member = start; member < index; member += 1) {
      rangeIds[member] = rangeId;
    }
    rangeId += 1;
  }

  return rangeIds;
}

function isProtectedTechnicalTitleSequence(
  sourceSequence,
  sourceIndex,
  protectedRangeIds
) {
  if (!sourceSequence.every((word) => isEnglishTitleWord(word))) {
    return false;
  }
  if (
    sourceSequence.some((word) =>
      ENGLISH_PROSE_MARKERS.has(word.toLowerCase())
    )
  ) {
    return false;
  }
  const rangeId = protectedRangeIds[sourceIndex];
  return (
    rangeId >= 0 &&
    protectedRangeIds[sourceIndex + sourceSequence.length - 1] === rangeId
  );
}

function isLikelyEnglishProse(words) {
  if (words.length < 2) return false;
  if (words.slice(1).some((word) => /^[a-z]/.test(word))) return true;
  const normalizedWords = words.map((word) => word.toLowerCase());
  if (normalizedWords.some((word) => ENGLISH_PROSE_MARKERS.has(word))) {
    return true;
  }
  if (words.some((word) => /(?:ing|ed)$/i.test(word))) return true;
  if (words.every((word) => /^[A-Z][a-z]+$/.test(word))) return true;
  if (words.every((word) => /^[A-Z]+$/.test(word))) {
    return words.some((word) => !isTechnicalEnglishWord(word));
  }
  if (words.length < 4) return false;
  return words.filter(isTechnicalEnglishWord).length < 2;
}

function getWordSequenceSet(words, sequenceLength) {
  const sequences = new Set();
  for (
    let index = 0;
    index <= words.length - sequenceLength;
    index += 1
  ) {
    sequences.add(words.slice(index, index + sequenceLength).join('\u0000'));
  }
  return sequences;
}

function hasSharedEnglishWordSequence(sourceText, translatedText) {
  const sourceEntries = getEnglishWordEntries(sourceText);
  const sourceWords = sourceEntries.map((entry) => entry.word);
  const normalizedSourceWords = sourceWords.map((word) => word.toLowerCase());
  const protectedRangeIds = getProtectedTechnicalTitleRangeIds(
    sourceText,
    sourceEntries
  );
  const translatedWords = getEnglishWordEntries(translatedText).map((entry) =>
    entry.word.toLowerCase()
  );
  for (
    let sequenceLength = Math.min(4, sourceWords.length);
    sequenceLength >= 2;
    sequenceLength -= 1
  ) {
    const translatedSequences = getWordSequenceSet(
      translatedWords,
      sequenceLength
    );
    for (
      let sourceIndex = 0;
      sourceIndex <= sourceWords.length - sequenceLength;
      sourceIndex += 1
    ) {
      const sourceSequence = sourceWords.slice(
        sourceIndex,
        sourceIndex + sequenceLength
      );
      if (
        isLikelyEnglishProse(sourceSequence) &&
        !isProtectedTechnicalTitleSequence(
          sourceSequence,
          sourceIndex,
          protectedRangeIds
        ) &&
        translatedSequences.has(
          normalizedSourceWords
            .slice(sourceIndex, sourceIndex + sequenceLength)
            .join('\u0000')
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function shouldCheckEnglishTranslationResidue(targetLanguage) {
  if (!String(targetLanguage || '').trim()) return false;
  return getTargetLanguageCode(targetLanguage) !== 'en';
}

function hasUntranslatedEnglishContainer(
  sourceValidation,
  translatedValidation,
  literalTokens = []
) {
  const sourceTextById = collectBlockContainerProseText(
    sourceValidation.tree,
    literalTokens
  );
  const translatedTextById = collectBlockContainerProseText(
    translatedValidation.tree,
    literalTokens
  );
  for (const [containerId, sourceText] of sourceTextById) {
    if (
      hasSharedEnglishWordSequence(
        sourceText,
        translatedTextById.get(containerId) || ''
      )
    ) {
      return true;
    }
  }
  return false;
}

function parseAndValidateBlockTranslations(outputText, records, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error('Inline block translation response was not valid JSON');
  }
  if (!Array.isArray(parsed?.translations)) {
    throw new Error(
      'Inline block translation response did not include translations'
    );
  }

  const expected = new Map((records || []).map((record) => [record.id, record]));
  const returned = new Map();
  for (const item of parsed.translations) {
    const id = item?.id;
    if (!expected.has(id)) throw new Error(`Unexpected translation id: ${id}`);
    if (returned.has(id)) throw new Error(`Duplicate translation id: ${id}`);
    if (typeof item.template !== 'string') {
      throw new Error(`Missing translation template for id: ${id}`);
    }
    returned.set(id, item.template);
  }
  for (const record of records || []) {
    if (!returned.has(record.id)) {
      throw new Error(`Missing translation id: ${record.id}`);
    }
  }

  return (records || []).map((record) => {
    const template = returned.get(record.id);
    const validation = inlineBlockCodec.validateTranslatedTemplate(
      template,
      record.contract
    );
    if (!validation.ok) {
      return { id: record.id, ok: false, errorCode: validation.errorCode };
    }
    if (shouldCheckEnglishTranslationResidue(options.targetLanguage)) {
      const sourceValidation = inlineBlockCodec.validateTranslatedTemplate(
        record.template,
        record.contract
      );
      if (
        sourceValidation.ok &&
        hasUntranslatedEnglishContainer(
          sourceValidation,
          validation,
          record.contract.literalTokens
        )
      ) {
        return {
          id: record.id,
          ok: false,
          errorCode: 'translation_incomplete',
        };
      }
    }
    return { id: record.id, ok: true, template };
  });
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

async function translateVisibleBlockBatch(
  records,
  settingsSnapshot = null,
  options = {}
) {
  const startedAtMs = Date.now();
  const logEntry = createInlineTranslationLogEntry(startedAtMs);
  let completed = false;

  try {
    const normalized = normalizeVisibleBlockBatchRecords(records);
    const totalCost = normalized.reduce(
      (sum, record) => sum + getBlockRecordCost(record),
      0
    );
    logEntry.recordCount = normalized.length;
    logEntry.totalChars = totalCost;
    logEntry.chunkCount = normalized.length ? 1 : 0;
    logEntry.chunkMaxChars = INLINE_BLOCK_MAX_BATCH_COST;
    logEntry.chunks = normalized.length
      ? [
          {
            index: 1,
            recordCount: normalized.length,
            charCount: totalCost,
          },
        ]
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
    async function requestAndValidate(batch) {
      const modelRecords = batch.map((record) => ({
        id: record.id,
        template: record.template,
        atoms: record.atoms,
        repair: record.repair || null,
      }));
      const output = await openaiTranslateChunk({
        apiKey: settings.apiKey,
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        instructions: buildBlockInstructions(settings),
        input: JSON.stringify({ records: modelRecords }),
        textFormat: buildBlockResponseFormat(),
        maxOutputTokens: getBlockBatchMaxOutputTokens(
          batch.reduce((sum, record) => sum + getBlockRecordCost(record), 0)
        ),
      });
      return translationValidation.validateBlockResponse(output, batch, {
        targetLanguage: settings.targetLanguage,
      }).records;
    }

    const initial = await requestAndValidate(normalized);
    const terminalById = new Map();
    const repairs = [];
    for (const result of initial) {
      const decision = translationPolicy.decideBlockDisposition(result, 1);
      if (decision.disposition === 'retry') {
        const source = normalized.find((record) => record.id === result.id);
        repairs.push({
          ...source,
          repair: { attempt: 1, previousErrorCode: decision.terminalCode },
        });
      } else {
        terminalById.set(result.id, { result, decision, attemptCount: 1 });
      }
    }
    if (repairs.length) {
      const repaired = await requestAndValidate(repairs);
      for (const result of repaired) {
        terminalById.set(result.id, {
          result,
          decision: translationPolicy.decideBlockDisposition(result, 2),
          attemptCount: 2,
        });
      }
    }
    const results = normalized.map((record) => {
      const terminal = terminalById.get(record.id);
      const apply = terminal.decision.disposition !== 'reject';
      return {
        id: record.id,
        disposition: terminal.decision.disposition,
        ...(apply ? { template: terminal.result.template } : {}),
        terminalCode: terminal.decision.terminalCode,
        messageKey: terminal.decision.messageKey,
        attemptCount: terminal.attemptCount,
      };
    });
    const runId = `run-${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`;
    const problemResults = results.filter(
      (result) => result.attemptCount === 2 || result.disposition !== 'apply'
    );
    const diagnosticBlocks = await Promise.all(problemResults.map(async (result) => {
      const record = normalized.find((candidate) => candidate.id === result.id);
      const fingerprints = await translationDiagnostics.fingerprintBlock(
        chrome,
        record?.template,
        record?.contract
      );
      return {
        diagnosticId: `${runId}/${result.id}`,
        ...fingerprints,
        terminalCode: result.terminalCode,
        terminalDisposition: result.disposition,
        attemptCount: result.attemptCount,
      };
    }));
    await translationDiagnostics.persistRun(chrome, {
      runId,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime?.getManifest?.().version || '',
      model: settings.model,
      targetLanguageCode: getTargetLanguageCode(settings.targetLanguage),
      outcome: results.some((result) => result.disposition === 'reject')
        ? 'failed'
        : results.some((result) => result.disposition === 'apply_with_warning')
          ? 'partial'
          : 'done',
      summary: {
        requested: results.length,
        translated: results.filter((result) => result.disposition === 'apply').length,
        translatedWithWarning: results.filter((result) => result.disposition === 'apply_with_warning').length,
        failed: results.filter((result) => result.disposition === 'reject').length,
        repairs: results.filter((result) => result.attemptCount === 2).length,
      },
      blocks: diagnosticBlocks,
    });
    if (logEntry.chunks[0]) {
      logEntry.chunks[0].durationMs = Date.now() - chunkStartedAtMs;
      logEntry.chunks[0].ok = true;
      logEntry.chunks[0].failedRecordCount = results.filter(
        (result) => !result.ok
      ).length;
    }
    completed = true;
    return results;
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
    js: getInlineContentScriptFiles(),
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
        if (msg?.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH') {
          const results = await translateVisibleBlockBatch(
            msg.records || [],
            msg.settingsSnapshot || null,
            {
              validateTranslationCompleteness:
                msg.validateTranslationCompleteness === true,
            }
          );
          sendResponse({ ok: true, results });
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
    assertInlineBlockSessionBudget,
    buildBlockInstructions,
    buildBlockResponseFormat,
    buildTextNodeResponseFormat,
    getBlockBatchMaxOutputTokens,
    getBlockRecordCost,
    getTextRecordStats,
    getTextRecordChunkStats,
    getInlineTranslationConcurrency,
    getInlineContentScriptFiles,
    getInlineTranslationLogStorageKey,
    collectInlineTranslationLogsFromStorage,
    getVisibleInlineBatchMaxChars,
    normalizeVisibleTextBatchRecords,
    normalizeVisibleBlockBatchRecords,
    normalizeMaxOutputTokens,
    parseAndValidateBlockTranslations,
    sanitizeLogError,
    splitTextRecordsIntoChunks,
    parseAndValidateTextNodeTranslations,
    assertTextRecordBudget,
    openaiTranslateChunk,
    syncInlineAutoShowRegistration,
    syncInlineAutoShowRegistrationSafely,
    translateVisibleBlockBatch,
  };
}
