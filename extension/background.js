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
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorFullPageMarkdown
) {
  importScripts('full-page-markdown.js');
}
const fullPageMarkdown =
  globalThis.ChromeAiTranslatorFullPageMarkdown ||
  (typeof module !== 'undefined' && module.exports
    ? require('./full-page-markdown.js')
    : null);
if (typeof importScripts === 'function') {
  if (!globalThis.ChromeAiTranslatorValidation) {
    importScripts('translation-validation.js');
  }
  if (!globalThis.ChromeAiTranslatorPolicy) {
    importScripts('translation-policy.js');
  }
  if (!globalThis.ChromeAiTranslatorButtonVisibility) {
    importScripts('button-visibility.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineTranslationControls) {
    importScripts('inline-translation-controls.js');
  }
  if (!globalThis.ChromeAiTranslatorPageAccess) {
    importScripts('page-access.js');
  }
  if (!globalThis.ChromeAiTranslatorDiagnostics) {
    importScripts('translation-diagnostics.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineDiagnosticsProtocol) {
    importScripts('inline-diagnostics-protocol.js');
  }
  if (!globalThis.ChromeAiTranslatorInlineDiagnosticsController) {
    importScripts('inline-diagnostics-controller.js');
  }
  if (!globalThis.ChromeAiTranslatorDefaultModel) {
    importScripts('default-model.js');
  }
}
const translationValidation =
  globalThis.ChromeAiTranslatorValidation || require('./translation-validation.js');
const translationPolicy =
  globalThis.ChromeAiTranslatorPolicy || require('./translation-policy.js');
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
const translationDiagnostics =
  globalThis.ChromeAiTranslatorDiagnostics || require('./translation-diagnostics.js');
const inlineDiagnosticsProtocol =
  globalThis.ChromeAiTranslatorInlineDiagnosticsProtocol || require('./inline-diagnostics-protocol.js');
const inlineDiagnosticsController =
  globalThis.ChromeAiTranslatorInlineDiagnosticsController || require('./inline-diagnostics-controller.js');
const { DEFAULT_MODEL } =
  globalThis.ChromeAiTranslatorDefaultModel || require('./default-model.js');

const DEFAULT_SETTINGS = {
  apiKey: '',
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
const FULL_PAGE_TRANSLATION_MAX_TOTAL_CHARS = 60000;
// Named after the setting that used to govern it. Chrome keeps a registration under this id
// across restarts, so renaming it would strand the old one on installs that already have it.
const INLINE_CONTENT_SCRIPT_ID = 'inline-translator-auto-show';
const INLINE_MAX_RECORDS = 500;
const INLINE_BLOCK_MAX_RECORD_COST = 12000;
const INLINE_BLOCK_MAX_BATCH_COST = 12000;
// There is deliberately no session cap here: the Semantic Block session is the content
// script's, and only it knows when one starts, resets, or resumes. See ADR-0003.
const INLINE_BLOCK_MIN_OUTPUT_TOKENS = 4096;
const INLINE_BLOCK_MAX_OUTPUT_TOKENS = 16000;
const INLINE_RUNTIME_CORRELATION_TTL_MS = 5 * 60 * 1000;
const INLINE_RUNTIME_CORRELATION_LIMIT = 1000;
const INLINE_RUNTIME_CORRELATION_STORAGE_KEY = 'inlineRuntimeCorrelations:v1';
const inlineRuntimeCorrelations = new Map();
let inlineRuntimeCorrelationMutation = Promise.resolve();

function normalizeInlineRuntimeCorrelationEntries(value) {
  const normalized = Object.create(null);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const [token, entry] of Object.entries(value)) {
    const runId = typeof entry?.runId === 'string' ? entry.runId : '';
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token) ||
      !entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !Number.isFinite(entry.expiresAt) || entry.expiresAt <= 0 ||
      !/^run-\d+-[a-z0-9]{1,12}$/.test(runId) ||
      typeof entry.diagnosticId !== 'string' || !entry.diagnosticId.startsWith(`${runId}/`) ||
      !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(entry.sourceFingerprint) ||
      !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(entry.contractFingerprint) ||
      !/^[A-Za-z0-9._:/-]{1,80}$/.test(entry.model) ||
      !(entry.targetLanguageCode === '' || /^[a-z]{2,16}$/i.test(entry.targetLanguageCode)) ||
      !/^[0-9A-Za-z.-]{0,40}$/.test(entry.extensionVersion) ||
      !(entry.tabId === null || Number.isInteger(entry.tabId)) ||
      !(entry.operationId === null || Number.isInteger(entry.operationId))
    ) continue;
    normalized[token] = entry;
  }
  return normalized;
}
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 128000;
const TONE_INSTRUCTIONS = {
  technical: 'Use a clear, technical tone suitable for docs.',
  natural: 'Use natural, fluent tone.',
  formal: 'Use formal and polite tone.',
};

// Per-tab in-memory state (lost when service worker sleeps; UI can re-trigger)
const stateByTab = new Map();
const activeTranslationsByTab = new Map();
let buttonVisibilityRegistrationSync = Promise.resolve();

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
  const merged = { ...DEFAULT_SETTINGS };
  for (const key of SETTINGS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(partial || {}, key)) {
      merged[key] = partial[key];
    }
  }
  merged.chunkMaxChars = normalizeChunkMaxChars(merged.chunkMaxChars);
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
  await chrome.storage.local.set({ settings: mergeSettings(settings) });
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
  // The message is the whole of it: what the reader is told has already been chosen by the
  // time it is recorded, so the failure's own name would add nothing to read.
  if (publicState.inlineTranslationError != null) {
    publicState.inlineTranslationError = copyAllowedFields(
      publicState.inlineTranslationError,
      ['message']
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

function setTabState(tabId, patch) {
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

function createRuntimeDiagnosticId(startedAt, cryptoApi = globalThis.crypto) {
  const suffix = typeof cryptoApi?.randomUUID === 'function'
    ? cryptoApi.randomUUID()
    : Math.random().toString(36).slice(2, 12);
  return `runtime-${startedAt}-${suffix}`;
}

// ADR-0001. Applied on install and on startup, and never re-enabled from a translation path.
async function releaseActionClickToExtension() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
  } catch {}
}

async function ensureSidePanel(tabId) {
  // ADR-0001: open() has to come before any other await. Chrome only honours it while
  // the user gesture that started this invocation is still live, and awaiting anything
  // first forfeits it. setOptions merely reasserts the manifest default, so it can wait.
  // Both calls fail silently on older versions or where the panel is unsupported.
  try {
    await chrome.sidePanel.open({ tabId });
  } catch {}

  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel.html',
      enabled: true,
    });
  } catch {}
}

function getInlineContentScriptFiles() {
  return [
    'default-model.js',
    'inline-block.js',
    'inline-diagnostics-protocol.js',
    'inline-translation-controls.js',
    'full-page-markdown.js',
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

async function getTabUrl(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab?.url === 'string' ? tab.url : '';
  } catch {
    return '';
  }
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

// Steps the content script carries out. The background worker decides; the content script
// executes, so the step name is also the instruction sent over the wire.
const INLINE_INSTRUCTION_MESSAGE = 'RUN_INLINE_INSTRUCTION';

// The content script answers whether it carried the instruction out, and an instruction it
// refused is as much a failure as one that never arrived — a caller told otherwise would
// report a gesture that did nothing as done.
async function sendInlineInstruction(tabId, instruction) {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: INLINE_INSTRUCTION_MESSAGE,
    instruction,
  });
  if (!response?.ok) {
    throw new Error(
      response?.error?.message || `The page could not carry out ${instruction}`
    );
  }
}

const INVOCATION_STEPS = Object.freeze({
  OPEN_SIDE_PANEL: 'openSidePanel',
  INJECT_CONTENT_SCRIPTS: 'injectContentScripts',
  GRANT_INLINE_TRANSLATION_AUTHORIZATION: 'grantInlineTranslationAuthorization',
  MOUNT_FLOATING_TRANSLATE_BUTTON: 'mountFloatingTranslateButton',
  START_INLINE_TRANSLATION: 'startInlineTranslation',
});

const INLINE_INVOCATION_STEPS = Object.freeze([
  INVOCATION_STEPS.GRANT_INLINE_TRANSLATION_AUTHORIZATION,
  INVOCATION_STEPS.MOUNT_FLOATING_TRANSLATE_BUTTON,
  INVOCATION_STEPS.START_INLINE_TRANSLATION,
]);

// The command key in `manifest.json`, which the worker recognizes by name. Chrome offers
// the reader whatever shortcut the manifest declares, so a key that drifts from this name
// leaves them one the worker quietly ignores.
const INLINE_TRANSLATION_SHORTCUT_COMMAND = 'translate-inline';

function isInvocationTrigger(trigger) {
  return trigger === 'action' || trigger === 'command';
}

// Every control in the Inline Translation Section grants Inline Translation Authorization
// before it runs. The section is extension-owned UI a page cannot forge, and the
// authorization exists to stop a page from triggering translation, not to stop the reader
// — so a panel left open past the expiry keeps answering its own controls.
function planInlineTranslationControl(control) {
  const step = getInlineTranslationControlStep(control);
  const steps = step
    ? [INVOCATION_STEPS.GRANT_INLINE_TRANSLATION_AUTHORIZATION, step]
    : [];
  return Object.freeze({ control, steps: Object.freeze(steps) });
}

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
  for (const step of steps) {
    await send(tabId, step);
  }
  // A control the tab has just carried out disproves a recorded failure to reach it, and
  // the Inline Translation Shortcut is only one of three ways into this feature. The
  // panel reports the control's own outcome itself, from the click it is still holding.
  clearInlineTranslationError(tabId);
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

// Whether the Floating Translate Button should be on the page. This is the background
// worker's call, not the content script's: injecting the content scripts and granting
// Inline Translation Authorization are separate steps that must be able to happen without
// the button appearing — which is exactly what the never choice asks for.
//
// The reader's Button Visibility choice decides it: never keeps the button off an invoked
// page too, on invocation mounts it only where the reader invoked the extension, and all
// pages mounts it on a plain page load as well.
function shouldMountFloatingTranslateButton(context = {}) {
  const visibility = readButtonVisibility(context.settings);
  if (visibility === BUTTON_VISIBILITY.NEVER) return false;
  if (isInvocationTrigger(context.trigger)) return true;
  return (
    context.trigger === 'pageLoad' && visibility === BUTTON_VISIBILITY.ALL_PAGES
  );
}

// What one invocation of the extension should do, decided without touching any browser
// API so the rules are testable. Two rules live here: the side panel is opened first
// (ADR-0001), and reaching the panel does not itself spend tokens — only the Inline
// Translation Shortcut starts a translation, which is why the toolbar icon and the
// shortcut deliberately differ.
//
// What the shortcut starts is Inline Translation (ADR-0004), the feature the steps above
// it have just finished preparing the page for. Side Panel Translation is started from the
// side panel's own Translate button, which sends TRANSLATE_TAB straight to the worker and
// so needs no step here. The start step sits outside the Button Visibility rule on
// purpose: that choice governs when the Floating Translate Button may appear, not whether
// the feature runs, and the panel the shortcut opens carries the same controls.
function planInvocation(context = {}) {
  const trigger = context?.trigger;
  const steps = [];
  if (isInvocationTrigger(trigger)) {
    steps.push(
      INVOCATION_STEPS.OPEN_SIDE_PANEL,
      INVOCATION_STEPS.INJECT_CONTENT_SCRIPTS,
      INVOCATION_STEPS.GRANT_INLINE_TRANSLATION_AUTHORIZATION
    );
  }
  if (shouldMountFloatingTranslateButton(context)) {
    steps.push(INVOCATION_STEPS.MOUNT_FLOATING_TRANSLATE_BUTTON);
  }
  if (trigger === 'command') {
    steps.push(INVOCATION_STEPS.START_INLINE_TRANSLATION);
  }
  return Object.freeze({ trigger, steps: Object.freeze(steps) });
}

// The steps of an invocation plan that the content script, rather than this worker,
// carries out — the boundary of what an invocation may send over the wire. The Inline
// Translation Section's controls travel the same wire, but they are the reader's own
// gestures rather than steps of an invocation, so they are planned separately. The
// page-load path hands these over in one answer, having no invocation to push them from.
function getInlineInstructions(plan) {
  return (plan?.steps || []).filter((step) =>
    INLINE_INVOCATION_STEPS.includes(step)
  );
}

function getDefaultInvocationHandlers() {
  return {
    [INVOCATION_STEPS.OPEN_SIDE_PANEL]: ensureSidePanel,
    [INVOCATION_STEPS.INJECT_CONTENT_SCRIPTS]: ensureContentScript,
    [INVOCATION_STEPS.GRANT_INLINE_TRANSLATION_AUTHORIZATION]: (tabId) =>
      sendInlineInstruction(
        tabId,
        INVOCATION_STEPS.GRANT_INLINE_TRANSLATION_AUTHORIZATION
      ),
    [INVOCATION_STEPS.MOUNT_FLOATING_TRANSLATE_BUTTON]: (tabId) =>
      sendInlineInstruction(
        tabId,
        INVOCATION_STEPS.MOUNT_FLOATING_TRANSLATE_BUTTON
      ),
    [INVOCATION_STEPS.START_INLINE_TRANSLATION]: (tabId) =>
      sendInlineInstruction(tabId, INVOCATION_STEPS.START_INLINE_TRANSLATION),
  };
}

// What an invocation tells the reader, which is one step's outcome and no other's.
//
// The steps ahead of it prepare the page, and the reader is not waiting on any of them: a
// Floating Translate Button that failed to mount is not what the Inline Translation
// Shortcut was pressed for, and saying so would bury what was. Starting Inline Translation
// is what they pressed for, and on a chrome:// tab, a PDF, or a page the extension cannot
// reach, its silence is indistinguishable from a translation about to appear.
//
// The failure travels in Inline Translation's own field of the tab state, which reaches
// the Inline Translation Section over the STATE_UPDATED broadcast every change already
// sends. It is not `state.error`: that one is Side Panel Translation's.
function recordInvocationStepOutcome(tabId, step, failure) {
  // What a recorded failure asks the reader for is a click on the extension icon, and this
  // is the step that click makes succeed. So its success speaks, by withdrawing a message
  // whose reason has been put right; its failure stays silent like every other step's,
  // which is what keeps the message standing on a page no click can grant.
  if (step === INVOCATION_STEPS.INJECT_CONTENT_SCRIPTS) {
    if (!failure) clearInlineTranslationError(tabId);
    return;
  }
  if (step !== INVOCATION_STEPS.START_INLINE_TRANSLATION) return;
  if (failure) {
    setTabState(tabId, {
      inlineTranslationError: {
        message: describeInlineTranslationControlFailure(failure),
      },
    });
    return;
  }
  clearInlineTranslationError(tabId);
}

// A run that started leaves nothing for an earlier failure to still be true of. The guard
// keeps a tab that was never told anything from being sent an update saying so.
function clearInlineTranslationError(tabId) {
  if (!stateByTab.get(tabId)?.inlineTranslationError) return;
  setTabState(tabId, { inlineTranslationError: null });
}

// Two properties matter here and both are covered by tests.
//
// The first step must run before this function awaits anything, because ADR-0001's
// gesture window is spent by the first await on the path from the listener to
// chrome.sidePanel.open(). Adding an await above the loop is the regression to fear.
// `runInvocation` below now starts that step itself, and holds the same line; keeping the
// property here as well costs nothing and keeps a plan run on its own honest.
//
// Steps are otherwise independent: content script injection legitimately fails on pages
// extensions cannot touch, and that must not stop a command invocation from translating.
async function runInvocationPlan(
  plan,
  tabId,
  handlers = getDefaultInvocationHandlers()
) {
  for (const step of plan?.steps || []) {
    const handler = handlers?.[step];
    if (!handler) continue;
    let failure = null;
    try {
      await handler(tabId);
    } catch (error) {
      failure = error || new Error('Unknown error');
    }
    // Independence covers the report as well: a worker that cannot record the outcome
    // must not cost the invocation the steps that were still to come.
    try {
      recordInvocationStepOutcome(tabId, step, failure);
    } catch {}
  }
}

// An invocation's plan needs the reader's Button Visibility choice, which only storage can
// answer and only asynchronously — yet ADR-0001's gesture is spent by the first await ahead
// of chrome.sidePanel.open(). So the panel-opening step is started here, in the event's own
// task, and the plan that follows adopts it instead of opening a second panel.
//
// Only the two invocation triggers belong here, because the panel opens before the plan is
// known. A page load has no gesture to spend and asks the worker for its instructions.
async function runInvocation(
  trigger,
  tabId,
  handlers = getDefaultInvocationHandlers()
) {
  const openedSidePanel = startSidePanelStep(handlers, tabId);
  const settings = await getSettings();
  return runInvocationPlan(planInvocation({ trigger, settings }), tabId, {
    ...handlers,
    [INVOCATION_STEPS.OPEN_SIDE_PANEL]: () => openedSidePanel,
  });
}

function startSidePanelStep(handlers, tabId) {
  const handler = handlers?.[INVOCATION_STEPS.OPEN_SIDE_PANEL];
  const started = (async () => handler?.(tabId))();
  // The plan observes the failure a moment later, when it reaches the step. Marking the
  // promise handled now keeps that gap from being reported as an unhandled rejection.
  started.catch(() => {});
  return started;
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
    store: false,
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

  return openAiResponse.parseCompletedResponse(json);
}

async function translateFullPageChunk(chunk, settings) {
  try {
    const output = await openaiTranslateChunk({
      apiKey: settings.apiKey,
      model: settings.model,
      reasoningEffort: settings.reasoningEffort,
      instructions: buildInstructions(settings),
      input: chunk.template,
      maxOutputTokens: getFullPageMaxOutputTokens(chunk.template),
    });
    return fullPageMarkdown.validateAndRehydrateChunk(output, chunk);
  } catch (error) {
    if (
      error?.code !== 'response.incomplete.max_output_tokens' ||
      (Number(chunk.recoveryDepth) || 0) >= 1
    ) {
      throw error;
    }
    const children = fullPageMarkdown.splitChunkForRecovery(chunk);
    const translated = [];
    for (const child of children) {
      translated.push(await translateFullPageChunk(child, settings));
    }
    return translated.join('\n\n');
  }
}

async function mutateInlineRuntimeCorrelations(mutator) {
  const operation = inlineRuntimeCorrelationMutation.catch(() => {}).then(async () => {
    const session = globalThis.chrome?.storage?.session;
    const storedValue = session
      ? (await session.get([INLINE_RUNTIME_CORRELATION_STORAGE_KEY]))[INLINE_RUNTIME_CORRELATION_STORAGE_KEY] || {}
      : Object.fromEntries(inlineRuntimeCorrelations);
    const stored = normalizeInlineRuntimeCorrelationEntries(storedValue);
    const result = await mutator(stored);
    if (session) await session.set({ [INLINE_RUNTIME_CORRELATION_STORAGE_KEY]: stored });
    else {
      inlineRuntimeCorrelations.clear();
      for (const [token, entry] of Object.entries(stored)) inlineRuntimeCorrelations.set(token, entry);
    }
    return result;
  });
  inlineRuntimeCorrelationMutation = operation;
  return operation;
}

async function issueInlineRuntimeCorrelations(items, context = {}) {
  return mutateInlineRuntimeCorrelations((entries) => {
    const now = Date.now();
    for (const [token, entry] of Object.entries(entries)) {
      if (entry.expiresAt <= now) delete entries[token];
    }
    if (Object.keys(entries).length + items.length > INLINE_RUNTIME_CORRELATION_LIMIT) {
      throw new Error('Inline runtime correlation capacity exceeded');
    }
    const issued = new Map();
    for (const { id, metadata } of items) {
      const token = createInlineRuntimeCorrelationToken();
      entries[token] = {
        ...metadata,
        tabId: Number.isInteger(context.tabId) ? context.tabId : null,
        operationId: context.operationId ?? null,
        expiresAt: now + INLINE_RUNTIME_CORRELATION_TTL_MS,
      };
      issued.set(id, token);
    }
    return issued;
  });
}

function createInlineRuntimeCorrelationToken() {
  return inlineDiagnosticsProtocol.createUuidV4();
}

async function consumeInlineRuntimeCorrelations(outcomes, releaseTokens, context = {}) {
  return mutateInlineRuntimeCorrelations((entries) => {
    const now = Date.now();
    const resolved = [];
    const tokens = new Set();
    const validated = [];
    const requested = [
      ...outcomes.map((outcome) => ({ token: outcome?.correlationToken, outcome })),
      ...releaseTokens.map((token) => ({ token, outcome: null })),
    ];
    for (const item of requested) {
      const token = String(item.token || '');
      const entry = Object.hasOwn(entries, token) ? entries[token] : null;
      if (
        !token || tokens.has(token) || !entry || entry.expiresAt <= now || entry.reservedAt ||
        entry.tabId !== (Number.isInteger(context.tabId) ? context.tabId : null) ||
        entry.operationId !== (context.operationId ?? null)
      ) return null;
      tokens.add(token);
      validated.push({ token, outcome: item.outcome, entry });
    }
    if (validated.some(({ entry }) => entry.runId !== validated[0].entry.runId)) return null;
    for (const item of validated) {
      if (item.outcome) {
        item.entry.reservedAt = now;
        resolved.push(item);
      } else delete entries[item.token];
    }
    return resolved;
  });
}

async function finalizeInlineRuntimeCorrelations(resolved, persisted) {
  return mutateInlineRuntimeCorrelations((entries) => {
    for (const { token } of resolved) {
      if (persisted) delete entries[token];
      else if (entries[token]) delete entries[token].reservedAt;
    }
  });
}

async function translateVisibleBlockBatch(
  records,
  settingsSnapshot = null,
  options = {}
) {
  const startedAtMs = Date.now();
  const runId = `run-${startedAtMs}-${Math.random().toString(36).slice(2, 8)}`;
  let diagnosticsPersisted = true;
  // Named by the failure diagnostics below, which run after the request that would have
  // reported them itself.
  let requestedModel = '';
  let requestedCount = 0;

  try {
    const normalized = normalizeVisibleBlockBatchRecords(records);
    requestedCount = normalized.length;

    if (!normalized.length) {
      return [];
    }

    const settings = mergeVisibleBatchSettingsSnapshot(
      await getSettings(),
      settingsSnapshot
    );
    requestedModel = settings.model;
    if (!settings.apiKey) {
      throw new Error('OpenAI API key is not set. Open Options and paste your key.');
    }
    const preflight = await translationDiagnostics.persistRun(chrome, {
      runId,
      startedAt: new Date(startedAtMs).toISOString(),
      model: settings.model,
      targetLanguageCode: getTargetLanguageCode(settings.targetLanguage),
      outcome: 'interrupted',
      summary: { requested: normalized.length },
      blocks: [],
    });
    diagnosticsPersisted = preflight.persisted;

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
    const initialById = new Map(initial.map((result) => [result.id, result]));
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
        terminalById.set(result.id, {
          result,
          decision,
          attemptCount: 1,
          timeline: [{
            stage: 'initial_validation',
            disposition: decision.disposition,
            codes: [decision.terminalCode].filter(Boolean),
          }],
        });
      }
    }
    if (repairs.length) {
      try {
        const repaired = await requestAndValidate(repairs);
        for (const result of repaired) {
          const initialResult = initialById.get(result.id);
          const initialDecision = translationPolicy.decideBlockDisposition(initialResult, 1);
          const decision = translationPolicy.decideBlockDisposition(result, 2);
          terminalById.set(result.id, {
            result,
            decision,
            attemptCount: 2,
            timeline: [
              { stage: 'initial_validation', disposition: 'retry', codes: [initialDecision.terminalCode].filter(Boolean) },
              { stage: 'repair_validation', disposition: decision.disposition, codes: [decision.terminalCode].filter(Boolean) },
            ],
          });
        }
      } catch (error) {
        const repairCode = String(error?.code || '').startsWith('protocol.')
          ? error.code
          : 'runtime.repair_request_failed';
        for (const repair of repairs) {
          const initialResult = initialById.get(repair.id);
          const initialDecision = translationPolicy.decideBlockDisposition(initialResult, 1);
          terminalById.set(repair.id, {
            result: initialResult,
            decision: {
              disposition: 'reject',
              terminalCode: repairCode,
              messageKey: 'repair_request_failed',
            },
            attemptCount: 2,
            timeline: [
              { stage: 'initial_validation', disposition: 'retry', codes: [initialDecision.terminalCode].filter(Boolean) },
              { stage: 'repair_validation', disposition: 'reject', codes: [repairCode] },
            ],
          });
        }
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
        diagnostic: {
          structure: terminal.result.structure,
          quality: terminal.result.quality,
          timeline: terminal.timeline,
        },
      };
    });
    const finalOutcome = results.some((result) => result.disposition === 'reject')
      ? 'failed'
      : results.some((result) => result.disposition === 'apply_with_warning')
        ? 'partial'
        : 'done';
    const finalSummary = {
      requested: results.length,
      translated: results.filter((result) => result.disposition === 'apply').length,
      translatedWithWarning: results.filter((result) => result.disposition === 'apply_with_warning').length,
      failed: results.filter((result) => result.disposition === 'reject').length,
      repairs: results.filter((result) => result.attemptCount === 2).length,
    };
    async function persistCompactFinal() {
      const persistence = await translationDiagnostics.persistRun(chrome, {
        runId,
        startedAt: new Date(startedAtMs).toISOString(),
        finishedAt: new Date().toISOString(),
        extensionVersion: chrome.runtime?.getManifest?.().version || '',
        model: settings.model,
        targetLanguageCode: getTargetLanguageCode(settings.targetLanguage),
        outcome: finalOutcome,
        summary: finalSummary,
        blocks: [],
      });
      if (!persistence.persisted) await translationDiagnostics.discardRun(chrome, runId);
      return persistence;
    }
    const correlationsById = new Map();
    const normalizedById = new Map(normalized.map((record) => [record.id, record]));
    try {
      const correlationEntries = await Promise.all(results.map(async (result) => {
        const record = normalizedById.get(result.id);
        const fingerprints = await translationDiagnostics.fingerprintBlock(
          chrome,
          record?.template,
          record?.contract
        );
        return [result.id, {
          runId,
          diagnosticId: `${runId}/${result.id}`,
          ...fingerprints,
          extensionVersion: chrome.runtime?.getManifest?.().version || '',
          model: settings.model,
          targetLanguageCode: getTargetLanguageCode(settings.targetLanguage),
        }];
      }));
      for (const [id, correlation] of correlationEntries) correlationsById.set(id, correlation);
    const problemResults = results.filter(
      (result) => result.attemptCount === 2 || result.disposition !== 'apply'
    );
    const diagnosticBlocks = problemResults.map((result) => {
      const correlation = correlationsById.get(result.id) || {};
      return {
        diagnosticId: correlation.diagnosticId,
        sourceFingerprint: correlation.sourceFingerprint,
        contractFingerprint: correlation.contractFingerprint,
        terminalCode: result.terminalCode,
        terminalDisposition: result.disposition,
        attemptCount: result.attemptCount,
        structure: result.diagnostic.structure,
        quality: result.diagnostic.quality,
        timeline: result.diagnostic.timeline,
      };
    });
      const persistence = await translationDiagnostics.persistRun(chrome, {
      runId,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      extensionVersion: chrome.runtime?.getManifest?.().version || '',
      model: settings.model,
      targetLanguageCode: getTargetLanguageCode(settings.targetLanguage),
      outcome: finalOutcome,
      summary: finalSummary,
        blocks: diagnosticBlocks,
      });
      diagnosticsPersisted = persistence.persisted;
      if (!persistence.persisted) await persistCompactFinal();
    } catch {
      // Diagnostics must never change an otherwise valid translation result.
      await persistCompactFinal();
      diagnosticsPersisted = false;
    }
    let issuedTokens = new Map();
    if (diagnosticsPersisted) {
      try {
        issuedTokens = await issueInlineRuntimeCorrelations(
          results
            .filter((result) => correlationsById.has(result.id))
            .map((result) => ({ id: result.id, metadata: correlationsById.get(result.id) })),
          options.correlationContext
        );
      } catch {
        diagnosticsPersisted = false;
      }
    }
    return results.map(({ diagnostic, ...result }) => ({
      ...result,
      ...(issuedTokens.has(result.id)
        ? { correlationToken: issuedTokens.get(result.id) }
        : {}),
      ...(!diagnosticsPersisted ? { diagnosticsUnavailable: true } : {}),
    }));
  } catch (error) {
    await translationDiagnostics.persistRun(chrome, {
      runId,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date().toISOString(),
      model: requestedModel,
      outcome: 'failed',
      summary: { requested: requestedCount, failed: requestedCount },
      blocks: [{
        diagnosticId: `${runId}/request`,
        terminalCode: error?.code || 'runtime.request_failed',
        terminalDisposition: 'reject',
        attemptCount: 1,
        timeline: [{
          stage: 'initial_validation',
          disposition: 'reject',
          codes: [error?.code || 'runtime.request_failed'],
        }],
      }],
    });
    throw error;
  }
}

async function hasAllSitesAccess() {
  if (!chrome.permissions?.contains) return false;
  return chrome.permissions.contains({ origins: ALL_SITES_ORIGINS });
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

async function getRegisteredAllPagesContentScript() {
  if (!chrome.scripting.getRegisteredContentScripts) return null;
  const scripts = await chrome.scripting.getRegisteredContentScripts({
    ids: [INLINE_CONTENT_SCRIPT_ID],
  });
  return (scripts || []).find((script) => script?.id === INLINE_CONTENT_SCRIPT_ID);
}

async function updateAllPagesContentScript(script) {
  if (!chrome.scripting.updateContentScripts) return false;
  try {
    await chrome.scripting.updateContentScripts([script]);
    return true;
  } catch (error) {
    if (isDuplicateInlineContentScriptError(error)) return false;
    throw error;
  }
}

async function syncButtonVisibilityRegistration(settings = null) {
  const previousSync = buttonVisibilityRegistrationSync.catch(() => {});
  const nextSync = previousSync.then(() =>
    syncButtonVisibilityRegistrationNow(settings)
  );
  buttonVisibilityRegistrationSync = nextSync;
  return nextSync;
}

async function syncButtonVisibilityRegistrationSafely(settings = null) {
  try {
    await syncButtonVisibilityRegistration(settings);
    return true;
  } catch {
    return false;
  }
}

async function unregisterAllPagesContentScript() {
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [INLINE_CONTENT_SCRIPT_ID],
    });
  } catch {}
}

// Brings both things the all-pages choice needs — access to every site and a content script
// registered across pages — into line with the choice the reader has made.
async function syncButtonVisibilityRegistrationNow(settings = null) {
  const effective = settings || (await getSettings());
  const visibility = readButtonVisibility(effective);

  if (visibility !== BUTTON_VISIBILITY.ALL_PAGES) {
    await unregisterAllPagesContentScript();
    // Giving the access back belongs here as well as on the options page: an install
    // migrating off the old checkbox reaches never without the reader opening options at
    // all, and the access that checkbox asked for would otherwise outlive it.
    try {
      if (chrome.permissions?.remove) {
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

    setTabState(tabId, {
      status: 'extracting',
      error: null,
      extracted: null,
      translated: null,
      progress: null,
    });
    await ensureSidePanel(tabId);

    try {
      await ensureContentScript(tabId);
    } catch (e) {
      const failure = classifyContentScriptFailure(e, await getTabUrl(tabId));
      setTabState(tabId, {
        status: 'error',
        error: { message: failure.message },
      });
      return { skipped: true, reason: 'content_script_unavailable' };
    }

    let translationDocument;
    let displayExtraction;
    let chunks;
    try {
      const extracted = await extractArticle(tabId);
      if (
        !extracted ||
        typeof extracted !== 'object' ||
        Array.isArray(extracted)
      ) {
        throw new Error('Article extraction is malformed.');
      }
      const { title, url, langHint, contentMarkdown } = extracted;
      if (
        typeof title !== 'string' ||
        typeof url !== 'string' ||
        typeof langHint !== 'string' ||
        typeof contentMarkdown !== 'string'
      ) {
        throw new Error('Article extraction is malformed.');
      }
      translationDocument = extracted.translationDocument;
      if (!translationDocument || !Array.isArray(translationDocument.blocks)) {
        throw new Error(
          'Article extraction did not include a translation document.'
        );
      }
      assertFullPageTranslationBudget(contentMarkdown);
      chunks = fullPageMarkdown.createTranslationChunks(
        translationDocument,
        settings.chunkMaxChars
      );
      displayExtraction = { title, url, langHint, contentMarkdown };
    } catch (e) {
      setTabState(tabId, {
        status: 'error',
        error: safeError(e),
        extracted: null,
        translated: null,
        progress: null,
      });
      return { skipped: true, reason: 'extract_failed' };
    }

    setTabState(tabId, {
      status: 'translating',
      extracted: displayExtraction,
      translated: null,
      settingsUsed: createPublicSettingsUsed(settings),
    });

    try {
      const translatedChunks = [];

      for (let i = 0; i < chunks.length; i++) {
        setTabState(tabId, {
          status: 'translating',
          progress: { current: i + 1, total: chunks.length },
        });
        const out = await translateFullPageChunk(chunks[i], settings);
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
      setTabState(tabId, {
        status: 'error',
        error: safeError(e),
        translated: null,
        progress: null,
      });
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
    await syncButtonVisibilityRegistrationSafely(settings);
    await releaseActionClickToExtension();
  });

  chrome.runtime.onStartup.addListener(async () => {
    await releaseActionClickToExtension();
    await syncButtonVisibilityRegistrationSafely();
  });

  // Deliberately not async: the first step opens the side panel, and awaiting anything
  // before it would forfeit the user gesture Chrome requires (ADR-0001).
  chrome.action.onClicked.addListener((tab) => {
    if (!tab?.id) return;
    runInvocation('action', tab.id);
  });

  chrome.commands.onCommand.addListener(async (command) => {
    if (command !== INLINE_TRANSLATION_SHORTCUT_COMMAND) return;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs?.[0]?.id;
    if (!tabId) return;
    await runInvocation('command', tabId);
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
            const resp = await chrome.tabs.sendMessage(msg.tabId, {
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
              validateTranslationCompleteness:
                msg.validateTranslationCompleteness === true,
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
          const outcomes = Array.isArray(msg.outcomes)
            ? msg.outcomes.slice(0, inlineDiagnosticsProtocol.limits.maxRecords)
            : [];
          const releaseTokens = Array.isArray(msg.releaseTokens)
            ? msg.releaseTokens.slice(0, inlineDiagnosticsProtocol.limits.maxRecords)
            : [];
          const startedAt = Date.now();
          const runtimeRunId = createRuntimeDiagnosticId(startedAt);
          const changedCount = outcomes.filter(
            (outcome) => outcome?.code === 'runtime.page_changed'
          ).length;
          const failedCount = outcomes.length - changedCount;
          const resolvedOutcomes = await consumeInlineRuntimeCorrelations(outcomes, releaseTokens, {
            tabId: sender?.tab?.id,
            operationId: msg.operationId ?? null,
          });
          if (!resolvedOutcomes) {
            sendResponse({ ok: false });
            return;
          }
          if (!resolvedOutcomes.length) {
            sendResponse({ ok: true });
            return;
          }
          const firstEntry = resolvedOutcomes[0].entry;
          const persistence = await translationDiagnostics.persistRun(chrome, {
            runId: runtimeRunId,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: new Date().toISOString(),
            extensionVersion: firstEntry.extensionVersion,
            model: firstEntry.model,
            targetLanguageCode: firstEntry.targetLanguageCode,
            outcome: failedCount > 0 ? 'failed' : 'changed',
            summary: {
              requested: outcomes.length,
              failed: failedCount,
              changed: changedCount,
            },
            blocks: resolvedOutcomes.map(({ outcome, entry }, index) => ({
              diagnosticId: `${runtimeRunId}/${index}`,
              parentRunId: entry.runId,
              parentDiagnosticId: entry.diagnosticId,
              sourceFingerprint: entry.sourceFingerprint,
              contractFingerprint: entry.contractFingerprint,
              terminalCode: outcome?.code,
              terminalDisposition: outcome?.code === 'runtime.page_changed' ? 'changed' : 'reject',
              attemptCount: 1,
              timeline: [{
                stage: 'runtime_application',
                disposition: outcome?.code === 'runtime.page_changed' ? 'changed' : 'reject',
                codes: [outcome?.code],
              }],
            })),
          });
          await finalizeInlineRuntimeCorrelations(resolvedOutcomes, persistence.persisted);
          sendResponse({ ok: persistence.persisted });
          return;
        }
        if (msg?.type === inlineDiagnosticsProtocol.messages.recordLocal) {
          const diagnosticBatchId = String(msg.diagnosticBatchId || '');
          const senderTabId = sender?.tab?.id;
          const operationId = msg.operationId;
          if (
            !inlineDiagnosticsProtocol.uuidV4Pattern.test(diagnosticBatchId) ||
            !Number.isInteger(senderTabId) || !Number.isInteger(operationId)
          ) {
            sendResponse({ ok: false });
            return;
          }
          const diagnostics = inlineDiagnosticsController.normalizeLocalDiagnostics(
            msg.diagnostics,
            inlineDiagnosticsProtocol
          );
          if (!diagnostics.length) {
            sendResponse({ ok: false });
            return;
          }
          const settings = mergeVisibleBatchSettingsSnapshot(
            await getSettings(),
            msg.settingsSnapshot || null
          );
          const startedAt = Date.now();
          const runId = `local-${senderTabId}-${operationId}-${diagnosticBatchId}`.slice(0, 80);
          const extensionVersion = chrome.runtime?.getManifest?.().version || '';
          const targetLanguageCode = getTargetLanguageCode(settings.targetLanguage);
          const idempotencyFingerprint = (await translationDiagnostics.fingerprintBlock(
            chrome,
            JSON.stringify({
              diagnostics,
              model: settings.model,
              targetLanguageCode,
              extensionVersion,
            }),
            {}
          )).sourceFingerprint;
          const blocks = await Promise.all(diagnostics.slice(0, 100).map(async (entry, index) => {
            let fingerprints = {};
            if (typeof entry.template === 'string' && entry.contract) {
              try {
                fingerprints = await translationDiagnostics.fingerprintBlock(
                  chrome,
                  entry.template,
                  entry.contract
                );
              } catch {}
            }
            return {
              diagnosticId: `${runId}/${index}`,
              ...fingerprints,
              terminalCode: entry.code,
              terminalDisposition: 'reject',
              attemptCount: 1,
              quality: { status: 'uncertain', codes: [], evidence: entry.evidence || {} },
              timeline: [{
                stage: 'runtime_application',
                disposition: 'reject',
                codes: [entry.code],
              }],
            };
          }));
          const persistence = await translationDiagnostics.persistRunIdempotent(chrome, {
            runId,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: new Date().toISOString(),
            extensionVersion,
            model: settings.model,
            targetLanguageCode,
            idempotencyFingerprint,
            outcome: 'failed',
            summary: { requested: diagnostics.length, failed: diagnostics.length },
            blocks,
          });
          sendResponse({ ok: persistence.persisted });
          return;
        }
        if (msg?.type === 'GET_INLINE_STARTUP_INSTRUCTIONS') {
          // A content script that loaded on its own asks what it should do. The answer is
          // decided here so the content script never reads settings to decide whether its
          // own UI belongs on the page.
          const settings = await getSettings();
          sendResponse({
            ok: true,
            instructions: getInlineInstructions(
              planInvocation({ trigger: 'pageLoad', settings })
            ),
          });
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
          await syncButtonVisibilityRegistrationSafely(next);
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
    safeError,
    sanitizePublicTabState,
    mergeVisibleBatchSettingsSnapshot,
    normalizeChunkMaxChars,
    assertFullPageTranslationBudget,
    buildBlockInstructions,
    buildBlockResponseFormat,
    getBlockBatchMaxOutputTokens,
    getBlockRecordCost,
    getInlineContentScriptFiles,
    classifyContentScriptFailure,
    ensureSidePanel,
    INLINE_TRANSLATION_SHORTCUT_COMMAND,
    planInvocation,
    planInlineTranslationControl,
    runInlineTranslationControl,
    sendInlineInstruction,
    describeInlineTranslationControlFailure,
    getInlineInstructions,
    runInvocation,
    runInvocationPlan,
    normalizeVisibleBlockBatchRecords,
    normalizeMaxOutputTokens,
    parseAndValidateBlockTranslations,
    openaiTranslateChunk,
    translateFullPageChunk,
    syncButtonVisibilityRegistration,
    syncButtonVisibilityRegistrationSafely,
    translateVisibleBlockBatch,
    createRuntimeDiagnosticId,
  };
}
