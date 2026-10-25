// background.js (MV3 service worker)
// Personal use only: API key is stored locally by the user.

// The two modules below that read a translation back — the inline-block codec and Side Panel
// Translation's rehydration half — take the Placeholder Token contract off the global scope as
// they load, so it goes in ahead of them rather than beside them.
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorPlaceholderTokens
) {
  importScripts('placeholder-tokens.js');
}
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
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorOpenAiResponse
) {
  importScripts('openai-response.js');
}
const openAiResponse =
  globalThis.ChromeAiTranslatorOpenAiResponse ||
  (typeof module !== 'undefined' && module.exports
    ? require('./openai-response.js')
    : null);
// Side Panel Translation's execution dependencies load before its module. The document
// serializer runs in the content script and is not imported here.
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorMarkdownEntries
) {
  importScripts('markdown-entries.js');
}
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorMarkdownRehydration
) {
  importScripts('markdown-rehydration.js');
}
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorTranslationChunks
) {
  importScripts('translation-chunks.js');
}
if (typeof importScripts === 'function') {
  if (!globalThis.ChromeAiTranslatorTranslationSettings) {
    importScripts('translation-settings.js');
  }
  if (!globalThis.ChromeAiTranslatorSidePanelTranslationExecution) {
    importScripts('sidepanel-translation-execution.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineModelExecution) {
    importScripts('inline-model-execution.js');
  }
  if (!globalThis.ChromeAiTranslatorButtonVisibility) {
    importScripts('button-visibility.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineTranslationControls) {
    importScripts('inline-translation-controls.js');
  }
  if (!globalThis.ChromeAiTranslatorWorkerInvocation) {
    importScripts('worker-invocation.js');
  }
  if (!globalThis.ChromeAiTranslatorPageAccess) {
    importScripts('page-access.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineDiagnosticsProtocol) {
    importScripts('inline-diagnostics-protocol.js');
  }
  if (!globalThis.ChromeAiTranslatorDiagnostics) {
    importScripts('translation-diagnostics.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineDiagnosticsController) {
    importScripts('inline-diagnostics-controller.js');
  }
  if (!globalThis.ChromeAiTranslatorDefaultModel) {
    importScripts('default-model.js');
  }
}
const { getTargetLanguageCode } =
  globalThis.ChromeAiTranslatorTranslationSettings || require('./translation-settings.js');
const sidePanelTranslationExecution =
  globalThis.ChromeAiTranslatorSidePanelTranslationExecution ||
  require('./sidepanel-translation-execution.js');
const inlineModelExecution =
  globalThis.ChromeAiTranslatorInlineModelExecution || require('./inline-model-execution.js');
const { ALL_SITES_ORIGINS, BUTTON_VISIBILITY, readButtonVisibility } =
  globalThis.ChromeAiTranslatorButtonVisibility || require('./button-visibility.js');
const {
  INLINE_TRANSLATION_CONTROLS,
  getInlineTranslationControlStep,
} =
  globalThis.ChromeAiTranslatorInlineTranslationControls ||
  require('./inline-translation-controls.js');
const { MISSING_PAGE_ACCESS_MESSAGES } =
  globalThis.ChromeAiTranslatorPageAccess || require('./page-access.js');
const inlineDiagnosticsProtocol =
  globalThis.ChromeAiTranslatorInlineDiagnosticsProtocol || require('./inline-diagnostics-protocol.js');
const inlineDiagnosticsController =
  globalThis.ChromeAiTranslatorInlineDiagnosticsController || require('./inline-diagnostics-controller.js');
const { DEFAULT_MODEL, OPENROUTER_MODEL, getEffectiveModelSettings, getOpenRouterFailureMessage } =
  globalThis.ChromeAiTranslatorDefaultModel || require('./default-model.js');

const workerInvocation = globalThis.ChromeAiTranslatorWorkerInvocation ||
  require('./worker-invocation.js');

const DEFAULT_SETTINGS = {
  service: 'openai',
  apiKey: '',
  openrouterApiKey: '',
  model: DEFAULT_MODEL,
  reasoningEffort: 'none',
  targetLanguage: 'Korean',
  tone: 'technical',
  viewMode: 'translation', // translation | bilingual
  chunkMaxChars: 12000,
  cacheEnabled: false,
  cacheTtlDays: 7,
  buttonVisibility: BUTTON_VISIBILITY.NEVER,
};
const SETTINGS_KEYS = Object.freeze(Object.keys(DEFAULT_SETTINGS));
const PUBLIC_SETTINGS_USED_KEYS = Object.freeze([
  'service',
  'model',
  'reasoningEffort',
  'targetLanguage',
  'tone',
  'viewMode',
  'chunkMaxChars',
]);
// Everything the panel is allowed to see of a tab's state. The two translations keep
// separate failures here on purpose: `error` is Side Panel Translation's, and merging
// Inline Translation's into it would tell the reader the wrong feature is talking at the
// one moment they most need to know which.
const PUBLIC_TAB_STATE_KEYS = Object.freeze([
  'status',
  'error',
  'inlineTranslationError',
  'extracted',
  'translated',
  'progress',
  'settingsUsed',
  'updatedAt',
]);

const MIN_CHUNK_MAX_CHARS = 2000;
const MAX_CHUNK_MAX_CHARS = 60000;
// Named after the setting that used to govern it. Chrome keeps a registration under this id
// across restarts, so renaming it would strand the old one on installs that already have it.
const INLINE_CONTENT_SCRIPT_ID = 'inline-translator-auto-show';
const INLINE_MAX_RECORDS = 500;
const INLINE_BLOCK_MAX_RECORD_COST = 12000;
const INLINE_BLOCK_MAX_BATCH_COST = 12000;
// There is deliberately no session cap here: the Semantic Block session is the content
// script's, and only it knows when one starts, resets, or resumes. See ADR-0003.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 128000;
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

function mergeSettings(partial) {
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial || {}, key)) {
      merged[key] = partial[key];
    }
  }
  merged.chunkMaxChars = normalizeChunkMaxChars(merged.chunkMaxChars);
  merged.service = getEffectiveModelSettings(merged).service;
  // Reading settings is the one place the older `inlineAutoShow` boolean can still arrive
  // from storage, so it is the place it stops being visible: nothing downstream, and
  // nothing written back, knows about it.
  merged.buttonVisibility = readButtonVisibility(partial);
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
  const snapshot = settingsSnapshot && typeof settingsSnapshot === 'object' ? settingsSnapshot : {};

  for (const key of [
    'service',
    'targetLanguage',
    'tone',
    'model',
    'reasoningEffort',
  ]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, key)) {
      merged[key] = key === 'service' ? snapshot[key] : String(snapshot[key] || DEFAULT_SETTINGS[key]);
    }
  }

  return { ...merged, ...getEffectiveModelSettings(merged) };
}

function copyAllowedFields(value, keys) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = value[key];
  }
  return result;
}

function sanitizePublicTabState(state) {
  const publicState = copyAllowedFields(state, PUBLIC_TAB_STATE_KEYS);
  if (publicState.error != null) {
    // The code is the panel's to read, so it travels; see safeError below for why.
    publicState.error = copyAllowedFields(publicState.error, [
      'message',
      'name',
      'code',
    ]);
  }
  if (publicState.inlineTranslationError != null) {
    publicState.inlineTranslationError = copyAllowedFields(
      publicState.inlineTranslationError,
      ['message', 'code']
    );
  }
  if (publicState.extracted != null) {
    publicState.extracted = copyAllowedFields(publicState.extracted, [
      'title',
      'url',
      'langHint',
      'contentMarkdown',
    ]);
  }
  if (publicState.progress != null) {
    publicState.progress = copyAllowedFields(publicState.progress, [
      'current',
      'total',
    ]);
  }
  if (publicState.settingsUsed != null) {
    publicState.settingsUsed = copyAllowedFields(
      publicState.settingsUsed,
      PUBLIC_SETTINGS_USED_KEYS
    );
  }
  return publicState;
}

function createPublicSettingsUsed(settings) {
  return copyAllowedFields(settings, PUBLIC_SETTINGS_USED_KEYS);
}

function safeError(err) {
  if (!err) return { message: 'Unknown error' };
  if (typeof err === 'string') return { message: err };
  const safe = {
    message: err.message || String(err),
    name: err.name,
  };
  // The code is kept beside the message rather than folded into it: what the reader reads is
  // the panel's to decide, and only the panel has the words. See extension/sidepanel-failure.js.
  if (typeof err.code === 'string' && err.code) safe.code = err.code;
  return safe;
}

function getInlineContentScriptFiles() {
  return [
    'default-model.js',
    'placeholder-tokens.js',
    'inline-block.js',
    'inline-diagnostics-protocol.js',
    'inline-translation-session.js',
    'inline-viewport.js',
    'inline-local-diagnostic-transport.js',
    'inline-translation-operation.js',
    'inline-translation-controls.js',
    'markdown-entries.js',
    'markdown-document.js',
    'content.js',
  ];
}

// The only pages this extension can ever be granted are the ones its optional host
// permissions name. Recognising that one shape is what keeps the classification honest:
// enumerating refused schemes instead would quietly mis-sort every scheme left off the
// list, and Chrome has many (chrome-error:, data:, blob:, and more).
const ORDINARY_WEB_PAGE_URL_PATTERN = /^https?:\/\//i;
const WEB_STORE_URL_PATTERN =
  /^https?:\/\/(?:chromewebstore\.google\.com|chrome\.google\.com\/webstore)(?:[/?#]|$)/i;
const LOCAL_FILE_URL_PATTERN = /^file:/i;
// Chrome's own phrasing, taken from the failures executeScript throws. The first names a
// page it will not script whatever the extension holds; the second is the generic refusal
// it gives for everything else, which is why the address decides what that one means.
const UNSUPPORTED_PAGE_FAILURE_PATTERN =
  /cannot be scripted|extensions gallery|cannot access a [a-z-]+:\/\/ url/i;
const REFUSED_ACCESS_FAILURE_PATTERN =
  /cannot access contents of|must request permission/i;

const CONTENT_SCRIPT_FAILURE_MESSAGES = Object.freeze({
  missing_access: MISSING_PAGE_ACCESS_MESSAGES.afterFailedAttempt,
  unsupported_page:
    'Chrome does not allow extensions to run on this page. Open an ordinary web page and try again.',
  file_access:
    'Chrome keeps extensions out of local files. Turn on "Allow access to file URLs" for this extension on chrome://extensions, then try again.',
});

function getFailureMessage(failure) {
  if (typeof failure === 'string') return failure.trim();
  return typeof failure?.message === 'string' ? failure.message.trim() : '';
}

// Chrome names the page it refused in most of these failures, and that name is better
// evidence than the address we were passed — which is blank exactly when access is missing,
// and can be a navigation behind by the time the failure arrives.
function getRefusedUrl(message) {
  return /url "([^"]+)"/i.exec(message)?.[1] || '';
}

// Why the content scripts could not be injected, in the reader's terms. One message used
// to blame chrome:// pages for every failure, which cost the parent spec's diagnosis two
// symptoms and an afternoon. Guessing would repeat that, so a failure Chrome has not told
// us is a refusal is reported as itself rather than assigned to a reason.
function classifyContentScriptFailure(failure, url = '') {
  const message = getFailureMessage(failure);
  const refusesAccess =
    UNSUPPORTED_PAGE_FAILURE_PATTERN.test(message) ||
    REFUSED_ACCESS_FAILURE_PATTERN.test(message);

  if (!refusesAccess) {
    return {
      reason: 'unknown',
      message: message
        ? `Could not reach this page: ${message}`
        : 'Could not reach this page.',
    };
  }

  const address = getRefusedUrl(message) || String(url || '').trim();

  // A local file is neither of the two: the reader can grant it, but not by invoking the
  // extension on the page, so both other messages would send them somewhere useless.
  if (LOCAL_FILE_URL_PATTERN.test(address)) {
    return {
      reason: 'file_access',
      message: CONTENT_SCRIPT_FAILURE_MESSAGES.file_access,
    };
  }

  if (
    UNSUPPORTED_PAGE_FAILURE_PATTERN.test(message) ||
    (address &&
      (!ORDINARY_WEB_PAGE_URL_PATTERN.test(address) ||
        WEB_STORE_URL_PATTERN.test(address)))
  ) {
    return {
      reason: 'unsupported_page',
      message: CONTENT_SCRIPT_FAILURE_MESSAGES.unsupported_page,
    };
  }

  return {
    reason: 'missing_access',
    message: CONTENT_SCRIPT_FAILURE_MESSAGES.missing_access,
  };
}

// The command key in `manifest.json`, which the worker recognizes by name. Chrome offers
// the reader whatever shortcut the manifest declares, so a key that drifts from this name
// leaves them one the worker quietly ignores.
const INLINE_TRANSLATION_SHORTCUT_COMMAND = 'translate-inline';

// Every control in the Inline Translation Section grants Inline Translation Authorization
// before it runs. The section is extension-owned UI a page cannot forge, and the
// authorization exists to stop a page from triggering translation, not to stop the reader
// — so a panel left open past the expiry keeps answering its own controls.
function planInlineTranslationControl(control) {
  const step = getInlineTranslationControlStep(control);
  const steps = step
    ? ['grantInlineTranslationAuthorization', step]
    : [];
  return Object.freeze({ control, steps: Object.freeze(steps) });
}

const UNREACHABLE_CONTENT_SCRIPT_PATTERN =
  /receiving end does not exist|could not establish connection|message port closed/i;

// Chrome's answer when nothing in the tab is listening names no action the reader can
// take, and the action they need is the one the missing-access failure already asks for.
function describeInlineTranslationControlFailure(failure) {
  const message = getFailureMessage(failure);
  if (UNREACHABLE_CONTENT_SCRIPT_PATTERN.test(message)) {
    return CONTENT_SCRIPT_FAILURE_MESSAGES.missing_access;
  }
  return message || 'Inline translation could not be reached on this tab.';
}

const INLINE_BLOCK_REPAIRABLE_ERROR_CODES = new Set([
  'token_missing',
  'token_duplicate',
  'token_unknown',
  'token_nesting_invalid',
  'token_parent_changed',
  'output_too_long',
  'output_parse_failed',
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

const getBlockRecordCost = inlineBlockCodec.getRecordCost;

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
    // A source template carries every token it lists; ADR-0010's allowance is for answers.
    if (!validation?.ok || validation.droppedWrappers.length) {
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

function getAllPagesContentScript() {
  return {
    id: INLINE_CONTENT_SCRIPT_ID,
    matches: ALL_SITES_ORIGINS,
    js: getInlineContentScriptFiles(),
    runAt: 'document_idle',
  };
}

function isDuplicateInlineContentScriptError(error) {
  return String(error?.message || error).includes(
    `Duplicate script ID '${INLINE_CONTENT_SCRIPT_ID}'`
  );
}

// The worker the extension runs, with the platform it runs on handed to it.
//
// `platform` names the three things the worker cannot reach on its own: Chrome's extension
// namespaces, the network, and the crypto that names a diagnostics run, signs the
// fingerprints in it, and mints the tokens a batch reports under. What an instance was
// handed is all it can reach — there is no global scope behind this. A path that reaches for
// a namespace its platform does not carry fails saying so, which is the whole point of
// building the worker rather than letting it find the browser by name: the service worker
// hands over the platform Chrome gave it at the foot of this file, and a check hands over the
// namespaces the one path it drives touches and can be certain nothing else was in play.
//
// The state below is this instance's rather than the module's — the three long-lived maps,
// the promise chains that serialize mutations, and the diagnostics module it
// signs and writes runs through — so a second construction is a second worker carrying
// nothing over. That is what a restarting service worker is, and what a caller wanting a
// clean one used to have to delete the require cache to get.
function createBackgroundWorker(platform = {}) {
  const givenChrome = platform.chrome ?? null;
  const givenFetch = platform.fetch ?? null;
  const givenCrypto = platform.crypto ?? null;

  // Reached through an accessor rather than used directly, so that a path reaching for a
  // namespace its platform does not carry says which piece it was built without, rather than
  // failing on an undefined property several frames further in.
  function missingPlatform(what) {
    return new Error(`This worker was built without ${what}`);
  }

  function getChrome() {
    if (!givenChrome) throw missingPlatform('chrome');
    return givenChrome;
  }

  // Named `fetch` so the one request in this worker reads as it always has.
  function fetch(...args) {
    if (!givenFetch) throw missingPlatform('a network');
    return givenFetch(...args);
  }

  const inlineDiagnostics = inlineDiagnosticsController.createInlineDiagnostics({
    chrome: givenChrome,
    crypto: givenCrypto,
  });

  // Per-tab in-memory state (lost when service worker sleeps; UI can re-trigger)
  const stateByTab = new Map();
  const activeTranslationsByTab = new Map();
  const inlineControlsByTab = new Map();
  let buttonVisibilityRegistrationSync = Promise.resolve();
  let settingsMutation = Promise.resolve();
  let settingsChangeGeneration = 0;
  let allPagesAccessGeneration = 0;

  async function getSettings() {
    const chrome = getChrome();
    const stored = await chrome.storage.local.get(['settings', 'openai_api_key']);
    // Backward/compat: allow apiKey in openai_api_key
    const settings = stored.settings || {};
    const apiKey = settings.apiKey || stored.openai_api_key || '';
    return mergeSettings({ ...settings, apiKey });
  }

  function changeSettings({ settings = {}, clearApiKey = false, service = 'openai' } = {}) {
    const keyService = getEffectiveModelSettings({ service }).service;
    const generation = ++settingsChangeGeneration;
    if (readButtonVisibility(settings) === BUTTON_VISIBILITY.ALL_PAGES) {
      allPagesAccessGeneration = generation;
    }
    // Read inside the ordered mutation: queued saves and install normalization must see
    // completed writes, and a failed storage operation must leave later requests usable.
    const nextMutation = settingsMutation.catch(() => {}).then(async () => {
      const current = await getSettings();
      const next = mergeSettingsWithExisting(current, settings);
      if (clearApiKey) delete next[keyService === 'openrouter' ? 'openrouterApiKey' : 'apiKey'];
      await getChrome().storage.local.set({ settings: next });
      if (clearApiKey && keyService === 'openai') await getChrome().storage.local.remove('openai_api_key');
      await syncButtonVisibilityRegistrationSafely(next, generation);
    });
    settingsMutation = nextMutation;
    return nextMutation;
  }

  function setTabState(tabId, patch) {
    const chrome = getChrome();
    const prev = stateByTab.get(tabId) || { status: 'idle' };
    const next = sanitizePublicTabState({
      ...prev,
      ...patch,
      updatedAt: nowIso(),
    });
    stateByTab.set(tabId, next);
    chrome.runtime
      .sendMessage({ type: 'STATE_UPDATED', tabId, state: next })
      .catch(() => {});
  }

  // ADR-0001. Applied on install and on startup, and never re-enabled from a translation path.
  async function releaseActionClickToExtension() {
    const chrome = getChrome();
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
    } catch {}
  }

  async function getTabUrl(tabId) {
    const chrome = getChrome();
    try {
      const tab = await chrome.tabs.get(tabId);
      return typeof tab?.url === 'string' ? tab.url : '';
    } catch {
      return '';
    }
  }

  const invocation = workerInvocation.createWorkerInvocation({
    getChrome,
    getSettings,
    contentScriptFiles: getInlineContentScriptFiles(),
    inlineErrors: {
      get: (tabId) => stateByTab.get(tabId)?.inlineTranslationError,
      set: (tabId, error) => setTabState(tabId, { inlineTranslationError: error }),
    },
    describeFailure: describeInlineTranslationControlFailure,
  });
  const sendInlineInstruction = invocation.sendInstruction;
  const clearInlineTranslationError = invocation.clearError;

  // Unlike an invocation, whose steps are independent, a control is a single gesture: a
  // refused step stops the rest, because carrying on would run the control unauthorized and
  // leave the reader with a click that silently did nothing.
  async function runInlineTranslationControl(
    tabId,
    control,
    send = sendInlineInstruction
  ) {
    const { steps } = planInlineTranslationControl(control);
    if (!steps.length) {
      throw new Error(`Unknown inline translation control: ${control}`);
    }
    const requestedControl = {};
    inlineControlsByTab.set(tabId, requestedControl);
    try {
      for (const step of steps) {
        await send(tabId, step);
        if (inlineControlsByTab.get(tabId) !== requestedControl) return;
      }
      // A control the tab has just carried out disproves a recorded failure to reach it, and
      // the Inline Translation Shortcut is only one of three ways into this feature. The
      // panel reports the control's own outcome itself, from the click it is still holding.
      clearInlineTranslationError(tabId);
    } finally {
      if (inlineControlsByTab.get(tabId) === requestedControl) inlineControlsByTab.delete(tabId);
    }
  }

  async function extractArticle(tabId) {
    const chrome = getChrome();
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: 'EXTRACT_ARTICLE',
    });
    if (!resp || !resp.ok) {
      throw new Error(resp?.error?.message || 'Failed to extract article');
    }
    return resp.data;
  }

  async function openaiTranslateChunk({
    service = 'openai',
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
      store: false,
    };
    if (reasoningEffort) {
      body.reasoning = { effort: reasoningEffort };
    }
    if (textFormat) {
      body.text = { format: textFormat };
    }

    const openrouter = service === 'openrouter';
    if (openrouter) {
      body.model = OPENROUTER_MODEL;
      body.reasoning = { effort: 'none' };
      body.provider = { require_parameters: true, data_collection: 'deny', zdr: true };
    }

    let res;
    try {
      res = await fetch(openrouter ? 'https://openrouter.ai/api/v1/responses' : 'https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (!openrouter) throw error;
      throw Object.assign(new Error(getOpenRouterFailureMessage('openrouter.transport')), { code: 'openrouter.transport' });
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      if (openrouter) {
        const failures = {
          401: 'authentication', 402: 'credits', 403: 'access', 404: 'model',
          429: 'rate_limit', 503: 'unavailable',
        };
        const code = `openrouter.${failures[res.status] || 'request'}`;
        throw Object.assign(new Error(getOpenRouterFailureMessage(code)), { code });
      }
      const msg = json?.error?.message || `OpenAI API error (${res.status})`;
      throw new Error(msg);
    }

    try {
      return openAiResponse.parseCompletedResponse(json);
    } catch (error) {
      if (openrouter) error.message = `OpenRouter: ${error.message}`;
      throw error;
    }
  }

  async function translateVisibleBlockBatch(
    records,
    settingsSnapshot = null,
    options = {}
  ) {
    getChrome();
    const run = inlineDiagnostics.beginTranslation(options.correlationContext);

    try {
      const normalized = normalizeVisibleBlockBatchRecords(records);
      run.describe({ records: normalized });

      if (!normalized.length) {
        return [];
      }

      const settings = mergeVisibleBatchSettingsSnapshot(
        await getSettings(),
        settingsSnapshot
      );
      run.describe({ model: settings.model });
      const apiKey = settings.service === 'openrouter' ? settings.openrouterApiKey : settings.apiKey;
      if (!apiKey) {
        throw new Error(`${settings.service === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key is not set. Open Options and paste your key.`);
      }
      run.describe({ targetLanguageCode: getTargetLanguageCode(settings.targetLanguage) });
      await run.preflight();

      const results = await inlineModelExecution.execute(normalized, {
        model: settings.model,
        reasoningEffort: settings.reasoningEffort,
        targetLanguage: settings.targetLanguage,
        tone: settings.tone,
      }, (request) => {
        run.modelAttempt();
        return openaiTranslateChunk({ ...request, service: settings.service, apiKey });
      });
      return await run.complete(results);
    } catch (error) {
      await run.fail(error);
      throw error;
    }
  }

  async function hasAllSitesAccess() {
    const chrome = getChrome();
    if (!chrome.permissions?.contains) return false;
    return chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
  }

  async function getRegisteredAllPagesContentScript() {
    const chrome = getChrome();
    if (!chrome.scripting.getRegisteredContentScripts) return null;
    const scripts = await chrome.scripting.getRegisteredContentScripts({
      ids: [INLINE_CONTENT_SCRIPT_ID],
    });
    return (scripts || []).find((script) => script?.id === INLINE_CONTENT_SCRIPT_ID);
  }

  async function updateAllPagesContentScript(script) {
    const chrome = getChrome();
    if (!chrome.scripting.updateContentScripts) return false;
    try {
      await chrome.scripting.updateContentScripts([script]);
      return true;
    } catch (error) {
      if (isDuplicateInlineContentScriptError(error)) return false;
      throw error;
    }
  }

  async function syncButtonVisibilityRegistration(settings = null, generation = settingsChangeGeneration) {
    // Startup reads after accepted writes, before joining the registration queue. Waiting
    // inside that queue would deadlock a settings write awaiting its own registration.
    if (!settings) await settingsMutation.catch(() => {});
    const previousSync = buttonVisibilityRegistrationSync.catch(() => {});
    const nextSync = previousSync.then(() =>
      syncButtonVisibilityRegistrationNow(settings, generation)
    );
    buttonVisibilityRegistrationSync = nextSync;
    return nextSync;
  }

  async function syncButtonVisibilityRegistrationSafely(settings = null, generation = settingsChangeGeneration) {
    try {
      await syncButtonVisibilityRegistration(settings, generation);
      return true;
    } catch {
      return false;
    }
  }

  async function unregisterAllPagesContentScript() {
    const chrome = getChrome();
    try {
      await chrome.scripting.unregisterContentScripts({
        ids: [INLINE_CONTENT_SCRIPT_ID],
      });
    } catch {}
  }

  // Brings both things the all-pages choice needs — access to every site and a content script
  // registered across pages — into line with the choice the reader has made.
  async function syncButtonVisibilityRegistrationNow(settings = null, generation = settingsChangeGeneration) {
    const chrome = getChrome();
    const effective = settings || (await getSettings());
    const visibility = readButtonVisibility(effective);

    if (visibility !== BUTTON_VISIBILITY.ALL_PAGES) {
      await unregisterAllPagesContentScript();
      // Giving the access back belongs here as well as on the options page: an install
      // migrating off the old checkbox reaches never without the reader opening options at
      // all, and the access that checkbox asked for would otherwise outlive it.
      try {
        // A newer Options gesture may have granted access while this older write waited.
        // Keep registration ordered even if that newer write fails, but do not revoke its grant.
        if (generation >= allPagesAccessGeneration && chrome.permissions?.remove) {
          await chrome.permissions.remove({ origins: ALL_SITES_ORIGINS });
        }
      } catch {}
      return;
    }

    // Registering the content script across pages is what lets the button appear without the
    // reader invoking the extension. It needs the access the choice asked for, which Chrome's
    // own UI can revoke without the options page ever hearing about it.
    if (!(await hasAllSitesAccess())) {
      await unregisterAllPagesContentScript();
      return;
    }

    const allPagesContentScript = getAllPagesContentScript();
    try {
      if (
        chrome.scripting.updateContentScripts &&
        (await getRegisteredAllPagesContentScript())
      ) {
        if (await updateAllPagesContentScript(allPagesContentScript)) return;
      }
    } catch {}

    try {
      await chrome.scripting.registerContentScripts([allPagesContentScript]);
    } catch (error) {
      if (isDuplicateInlineContentScriptError(error)) {
        if (await updateAllPagesContentScript(allPagesContentScript)) return;
        try {
          await chrome.scripting.unregisterContentScripts({
            ids: [INLINE_CONTENT_SCRIPT_ID],
          });
          await chrome.scripting.registerContentScripts([allPagesContentScript]);
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
      const saved = mergeSettings({
        ...(await getSettings()),
        ...(overrideSettings || {}),
      });
      const settings = { ...saved, ...getEffectiveModelSettings(saved) };

      const apiKey = settings.service === 'openrouter' ? settings.openrouterApiKey : settings.apiKey;
      if (!apiKey) {
        setTabState(tabId, {
          status: 'error',
          error: {
            message: `${settings.service === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key is not set. Open Options and paste your key.`,
          },
        });
        return { skipped: true, reason: 'missing_api_key' };
      }

      setTabState(tabId, {
        status: 'extracting',
        error: null,
        extracted: null,
        translated: null,
        progress: null,
      });
      try {
        await invocation.preparePage(tabId);
      } catch (e) {
        const failure = classifyContentScriptFailure(e, await getTabUrl(tabId));
        setTabState(tabId, {
          status: 'error',
          error: { message: failure.message },
        });
        return { skipped: true, reason: 'content_script_unavailable' };
      }

      let translationStarted = false;
      try {
        const extraction = await extractArticle(tabId);
        const translated = await sidePanelTranslationExecution.execute(
          extraction,
          createPublicSettingsUsed(settings),
          (request) => openaiTranslateChunk({ ...request, service: settings.service, apiKey }),
          ({ progress }) => {
            if (!translationStarted) {
              translationStarted = true;
              setTabState(tabId, {
                status: 'translating',
                extracted: extraction,
                translated: null,
                settingsUsed: createPublicSettingsUsed(settings),
                progress,
              });
              return;
            }
            setTabState(tabId, { status: 'translating', progress });
          }
        );
        setTabState(tabId, {
          status: 'done',
          translated,
          progress: null,
        });
        return { skipped: false };
      } catch (e) {
        const failureState = {
          status: 'error',
          error: safeError(e),
          translated: null,
          progress: null,
        };
        if (!translationStarted) failureState.extracted = null;
        setTabState(tabId, failureState);
        return {
          skipped: true,
          reason: translationStarted ? 'translate_failed' : 'extract_failed',
        };
      }
    } finally {
      if (activeTranslationsByTab.get(tabId) === operationToken) {
        activeTranslationsByTab.delete(tabId);
      }
    }
  }

  // What the browser calls this worker with, and the only way in for a caller holding
  // nothing but this instance. Registering them is the entry point's, at the foot of this
  // file, so each one names the event it serves: that name is all that still links a handler
  // to its registration now that the two are apart.

  // chrome.runtime.onInstalled.
  async function onInstalled() {
    await changeSettings();
    await releaseActionClickToExtension();
  }

  // chrome.runtime.onStartup.
  async function onStartup() {
    await releaseActionClickToExtension();
    await syncButtonVisibilityRegistrationSafely();
  }

  // chrome.action.onClicked. Deliberately not async: the first step opens the side panel,
  // and awaiting anything before it would forfeit the user gesture Chrome requires
  // (ADR-0001).
  function onActionClicked(tab) {
    if (!tab?.id) return;
    invocation.invoke('action', tab.id);
  }

  // The Inline Translation Shortcut, registered on chrome.commands.onCommand.addListener.
  // Chrome offers that listener every command the manifest declares, so
  // INLINE_TRANSLATION_SHORTCUT_COMMAND is what decides which of them reaches the worker.
  async function onCommand(command) {
    if (command !== INLINE_TRANSLATION_SHORTCUT_COMMAND) return;
    const chrome = getChrome();
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (!tabId) return;
    await invocation.invoke('command', tabId);
  }

  // chrome.runtime.onMessage.
  //
  // The platform is reached inside the branch that needs it rather than here: most messages
  // are answered out of this instance's own state, and a message this worker does not serve
  // has to be turned away before anything is reached at all.
  function onMessage(msg, sender, sendResponse) {
    (async () => {
      try {
        if (msg?.type === 'GET_STATE') {
          const tabId = msg.tabId;
          sendResponse({
            ok: true,
            state: sanitizePublicTabState(
              stateByTab.get(tabId) || { status: 'idle' }
            ),
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
        if (msg?.type === 'RUN_INLINE_TRANSLATION_CONTROL') {
          try {
            await runInlineTranslationControl(msg.tabId, msg.control);
            sendResponse({ ok: true });
          } catch (e) {
            sendResponse({
              ok: false,
              error: { message: describeInlineTranslationControlFailure(e) },
            });
          }
          return;
        }
        if (msg?.type === 'GET_INLINE_TRANSLATION_STATE') {
          // A tab with no content script has no Inline Translation state to report. That
          // is not a failure worth showing: the panel polls, and only a control the reader
          // pressed has an outcome they are waiting on.
          try {
            const resp = await getChrome().tabs.sendMessage(msg.tabId, {
              type: 'GET_INLINE_TRANSLATION_STATE',
            });
            sendResponse({
              ok: Boolean(resp?.ok),
              snapshot: resp?.snapshot || null,
            });
          } catch {
            sendResponse({ ok: false, snapshot: null });
          }
          return;
        }
        if (msg?.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH') {
          const results = await translateVisibleBlockBatch(
            msg.records || [],
            msg.settingsSnapshot || null,
            {
              correlationContext: {
                tabId: sender?.tab?.id,
                operationId: msg.operationId ?? null,
              },
            }
          );
          sendResponse({ ok: true, results });
          return;
        }
        if (msg?.type === inlineDiagnosticsProtocol.messages.recordRuntime) {
          sendResponse(await inlineDiagnostics.recordRuntime({
            tabId: sender?.tab?.id,
            operationId: msg.operationId ?? null,
            outcomes: msg.outcomes,
            releaseTokens: msg.releaseTokens,
          }));
          return;
        }
        if (msg?.type === inlineDiagnosticsProtocol.messages.recordLocal) {
          const report = inlineDiagnostics.prepareLocal({
            tabId: sender?.tab?.id,
            operationId: msg.operationId,
            diagnosticBatchId: msg.diagnosticBatchId,
            diagnostics: msg.diagnostics,
          });
          if (!report) {
            sendResponse({ ok: false });
            return;
          }
          const settings = mergeVisibleBatchSettingsSnapshot(
            await getSettings(),
            msg.settingsSnapshot || null
          );
          sendResponse(await report.persist({
            model: settings.model,
            targetLanguageCode: getTargetLanguageCode(settings.targetLanguage),
          }));
          return;
        }
        if (msg?.type === 'GET_INLINE_STARTUP_INSTRUCTIONS') {
          // A content script that loaded on its own asks what it should do. The answer is
          // decided here so the content script never reads settings to decide whether its
          // own UI belongs on the page.
          sendResponse({
            ok: true,
            instructions: await invocation.startupInstructions(),
          });
          return;
        }
        if (msg?.type === 'GET_SETTINGS') {
          const settings = await getSettings();
          settings.apiKey = settings.apiKey ? '***' : '';
          settings.openrouterApiKey = settings.openrouterApiKey ? '***' : '';
          sendResponse({ ok: true, settings });
          return;
        }
        if (msg?.type === 'SAVE_SETTINGS') {
          await changeSettings({ settings: msg.settings || {} });
          sendResponse({ ok: true });
          return;
        }
        if (msg?.type === 'CLEAR_API_KEY') {
          await changeSettings({ clearApiKey: true, service: msg.service });
          sendResponse({ ok: true });
          return;
        }

        sendResponse({ ok: false, error: { message: 'Unknown message' } });
      } catch (e) {
        const error = ['GET_SETTINGS', 'SAVE_SETTINGS', 'CLEAR_API_KEY'].includes(msg?.type)
          ? { message: 'Settings request failed' }
          : safeError(e);
        sendResponse({ ok: false, error });
      }
    })();

    // Keep the message channel open for async response
    return true;
  }

  return {
    // What the browser calls, and what a caller holding only this instance drives it by.
    handlers: {
      onInstalled,
      onStartup,
      onActionClicked,
      onCommand,
      onMessage,
    },
    // Everything below is what this file already exported, backed by this instance so that an
    // export and the worker the browser is running are the same thing.
    openaiTranslateChunk,
    runInlineTranslationControl,
    sendInlineInstruction,
    syncButtonVisibilityRegistration,
    syncButtonVisibilityRegistrationSafely,
    translateVisibleBlockBatch,
  };
}

// The entry point: the one worker the browser runs, and the platform the service worker has
// to hand it. Building it here rather than at module scope is what lets the platform be
// explicit — there is nowhere else in this file where Chrome, the network and crypto are
// known to exist, and a worker built where they are not would have nothing to be given.
//
// `fetch` is wrapped rather than passed by reference because a detached `fetch` loses the
// receiver the browser's own binding requires.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const backgroundWorker = createBackgroundWorker({
    chrome,
    fetch: (...args) => globalThis.fetch(...args),
    crypto: globalThis.crypto,
  });
  chrome.runtime.onInstalled.addListener(backgroundWorker.handlers.onInstalled);
  chrome.runtime.onStartup.addListener(backgroundWorker.handlers.onStartup);
  chrome.action.onClicked.addListener(backgroundWorker.handlers.onActionClicked);
  chrome.commands.onCommand.addListener(backgroundWorker.handlers.onCommand);
  chrome.runtime.onMessage.addListener(backgroundWorker.handlers.onMessage);
}

// What a CommonJS loader gets: the factory, and the functions that only reason and so belong
// to the module rather than to any one worker. A worker's own surface — every function that
// touches the browser, the network, or an instance's state — is reached by building one,
// because there is no instance here to hand out.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createBackgroundWorker,
    mergeSettingsWithExisting,
    safeError,
    sanitizePublicTabState,
    mergeVisibleBatchSettingsSnapshot,
    normalizeChunkMaxChars,
    getBlockRecordCost,
    getInlineContentScriptFiles,
    classifyContentScriptFailure,
    INLINE_TRANSLATION_SHORTCUT_COMMAND,
    planInlineTranslationControl,
    describeInlineTranslationControlFailure,
    normalizeVisibleBlockBatchRecords,
    normalizeMaxOutputTokens,
  };
}
