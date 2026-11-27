// background.js (MV3 service worker)
// Personal use only: API key is stored locally by the user.

if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorPlaceholderTokens
) {
  importScripts('placeholder-tokens.js');
}
if (
  typeof importScripts === 'function' &&
  !globalThis.ChromeAiTranslatorInlineTemplate
) {
  importScripts('inline-template.js');
}
if (typeof importScripts === 'function' && !globalThis.ChromeAiTranslatorInlineRequest) {
  importScripts('inline-request.js');
}
const inlineRequest =
  globalThis.ChromeAiTranslatorInlineRequest ||
  (typeof module !== 'undefined' && module.exports ? require('./inline-request.js') : null);
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
if (typeof importScripts === 'function') {
  if (!globalThis.ChromeAiTranslatorTranslationSettings) {
    importScripts('translation-settings.js');
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
  if (!globalThis.ChromeAiTranslatorInlineDocumentLifetime) {
    importScripts('inline-document-lifetime.js');
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
  if (!globalThis.ChromeAiTranslatorSettingsLifecycle) {
    importScripts('settings-lifecycle.js');
  }
  if (!globalThis.ChromeAiTranslatorTextTranslationRequest) {
    importScripts('text-translation-request.js');
    importScripts('text-translation-progress.js');
  }
  if (!globalThis.ChromeAiTranslatorTextTranslationRetention) {
    importScripts('text-translation-retention.js');
  }
}
const textTranslationRequest = globalThis.ChromeAiTranslatorTextTranslationRequest || require('./text-translation-request.js');
const { createTextTranslationRetention } =
  globalThis.ChromeAiTranslatorTextTranslationRetention || require('./text-translation-retention.js');
const { getTargetLanguageCode } =
  globalThis.ChromeAiTranslatorTranslationSettings || require('./translation-settings.js');
const inlineModelExecution =
  globalThis.ChromeAiTranslatorInlineModelExecution || require('./inline-model-execution.js');
const {
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
const { OPENROUTER_MODEL, getEffectiveModelSettings, getServiceFailureMessage } =
  globalThis.ChromeAiTranslatorDefaultModel || require('./default-model.js');

const { createInlineDocumentLifetime } = globalThis.ChromeAiTranslatorInlineDocumentLifetime ||
  require('./inline-document-lifetime.js');

const workerInvocation = globalThis.ChromeAiTranslatorWorkerInvocation ||
  require('./worker-invocation.js');

const { createSettingsLifecycle, DEFAULT_SETTINGS, mergeSettings } =
  globalThis.ChromeAiTranslatorSettingsLifecycle || require('./settings-lifecycle.js');

const PUBLIC_TAB_STATE_KEYS = Object.freeze([
  'inlineTranslationError',
  'updatedAt',
  'workerEpoch',
  'stateSequence',
  'documentId',
]);

// There is deliberately no session cap here: the Semantic Block session is the content
// script's, and only it knows when one starts, resets, or resumes. See ADR-0003.
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
const MIN_MAX_OUTPUT_TOKENS = 256;
const MAX_MAX_OUTPUT_TOKENS = 128000;
function nowIso() {
  return new Date().toISOString();
}

function normalizeMaxOutputTokens(value, fallback = DEFAULT_MAX_OUTPUT_TOKENS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(
    MAX_MAX_OUTPUT_TOKENS,
    Math.max(MIN_MAX_OUTPUT_TOKENS, Math.floor(parsed))
  );
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
  if (publicState.inlineTranslationError != null) {
    publicState.inlineTranslationError = copyAllowedFields(
      publicState.inlineTranslationError,
      ['message', 'code']
    );
  }
  return publicState;
}

function safeError(err) {
  if (!err) return { message: 'Unknown error' };
  if (typeof err === 'string') return { message: err };
  const safe = {
    message: err.message || String(err),
    name: err.name,
  };
  if (typeof err.code === 'string' && err.code) safe.code = err.code;
  return safe;
}

function getInlineContentScriptFiles() {
  return [
    'default-model.js',
    'placeholder-tokens.js',
    'inline-template.js',
    'inline-block.js',
    'inline-request.js',
    'inline-diagnostics-protocol.js',
    'inline-translation-session.js',
    'inline-viewport.js',
    'inline-local-diagnostic-transport.js',
    'inline-translation-operation.js',
    'inline-translation-controls.js',
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

  const inlineDiagnostics = inlineDiagnosticsController.createInlineDiagnostics({
    chrome: givenChrome,
    crypto: givenCrypto,
  });

  // Per-tab in-memory state (lost when service worker sleeps; UI can re-trigger)
  const stateByTab = new Map();
  const workerEpoch = inlineDiagnosticsProtocol.createUuidV4(givenCrypto || globalThis.crypto);
  let stateSequence = 0;
  const inlineDocuments = createInlineDocumentLifetime({
    getDocumentId,
    documentEnded,
    clearTabState: tabId => stateByTab.delete(tabId),
  });
  const textExecution = createTextTranslationExecution();
  const textRetention = createTextTranslationRetention({
    getStorage: () => getChrome().storage.session,
    getCurrentDocumentId: getTextDocumentId,
    documentEnded,
    onDocumentConfirmed: textExecution.cancelDeparted,
  });

  function documentEnded() {
    return Object.assign(new Error('The original document is no longer open.'), { code: 'document.departed' });
  }

  async function getDocumentId(tabId) {
    let frame;
    try { frame = await getChrome().webNavigation.getFrame({ tabId, frameId: 0 }); } catch {}
    if (!frame?.documentId) throw Object.assign(new Error('The extension could not identify this page’s document. Reload the page and try again.'),
      { code: 'document.unavailable' });
    return frame.documentId;
  }

  async function getTextDocumentId(tabId) {
    const url = getChrome().runtime.getURL('text-translation.html');
    const contexts = await getChrome().runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tabId] });
    const matches = contexts.filter(context => context.tabId === tabId && context.frameId === 0 &&
      context.documentUrl === url && typeof context.documentId === 'string' && context.documentId);
    if (matches.length !== 1) throw documentEnded();
    return matches[0].documentId;
  }

  function createTextTranslationExecution() {
    const activeRequests = new Map();

    function cancelDeparted(tabId, currentDocumentId = null) {
      for (const [owner, request] of activeRequests) {
        if (owner.startsWith(`${tabId}:`) && owner !== `${tabId}:${currentDocumentId}`) {
          request.controller.abort();
          activeRequests.delete(owner);
        }
      }
    }

    function stop(tabId, documentId, operationId) {
      textRetention.assertKnownDocument(tabId, documentId);
      const owner = `${tabId}:${documentId}`;
      const request = activeRequests.get(owner);
      if (request?.operationId === operationId) {
        request.controller.abort();
        activeRequests.delete(owner);
      }
    }

    async function translate(tabId, documentId, { operationId, source, settings }) {
      textRetention.assertKnownDocument(tabId, documentId);
      const owner = `${tabId}:${documentId}`;
      if (activeRequests.has(owner)) throw new Error('A text translation is already running.');
      const prepared = textTranslationRequest.prepare(source, settings);
      const controller = new AbortController();
      const request = { operationId, controller };
      const isCurrent = () => activeRequests.get(owner) === request;
      activeRequests.set(owner, request);
      try {
        if (await getTextDocumentId(tabId) !== documentId) throw documentEnded();
        const stored = await settingsLifecycle.read();
        if (!isCurrent()) throw documentEnded();
        const apiKey = prepared.service === 'openrouter' ? stored.openrouterApiKey : stored.apiKey;
        if (!apiKey) throw new Error(`${prepared.service === 'openrouter' ? 'OpenRouter' : 'OpenAI'} API key is not set. Open Options and paste your key.`);
        const output = await requestTranslation({ ...prepared, apiKey, signal: controller.signal,
          beforeRequest: async () => {
            if (await getTextDocumentId(tabId) !== documentId || !isCurrent()) throw documentEnded();
          } });
        if (!isCurrent()) throw new Error('Text Translation stopped.');
        return textTranslationRequest.parseResult(output, prepared.input);
      } finally {
        if (isCurrent()) activeRequests.delete(owner);
      }
    }

    return { translate, stop, cancelDeparted };
  }

  const settingsLifecycle = createSettingsLifecycle({
    chrome: givenChrome,
    contentScriptFiles: getInlineContentScriptFiles(),
  });

  function setTabState(tabId, patch) {
    const chrome = getChrome();
    const documentId = inlineDocuments.currentDocumentId(tabId);
    const next = sanitizePublicTabState({
      ...(stateByTab.get(tabId) || {}),
      ...patch,
      ...(documentId ? { documentId } : {}),
      updatedAt: nowIso(),
      workerEpoch,
      stateSequence: ++stateSequence,
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

  const invocationOptions = {
    getChrome,
    getSettings: settingsLifecycle.read,
    contentScriptFiles: getInlineContentScriptFiles(),
    inlineErrors: {
      get: (tabId) => stateByTab.get(tabId)?.inlineTranslationError,
      set: (tabId, error) => setTabState(tabId, { inlineTranslationError: error }),
    },
    describeFailure: describeInlineTranslationControlFailure,
    captureDocument: inlineDocuments.captureDocument,
  };
  const invocation = workerInvocation.createWorkerInvocation(invocationOptions);
  async function invokeForTab(trigger, tabId) {
    const invocationWork = inlineDocuments.beginInvocation(tabId);
    const currentInvocation = workerInvocation.createWorkerInvocation({
      ...invocationOptions,
      isCurrent: invocationWork.isCurrent,
      async documentUnavailable() {
        let tab;
        try { tab = await getChrome().tabs.get(tabId); } catch { return; }
        if (!invocationWork.isCurrent()) return;
        const url = String(tab?.url || '');
        const restricted = url && (!ORDINARY_WEB_PAGE_URL_PATTERN.test(url) || WEB_STORE_URL_PATTERN.test(url));
        const message = restricted
          ? classifyContentScriptFailure(new Error('Cannot access contents of this page.'), url).message
          : 'The extension could not identify this page’s document. Reload the page and try again.';
        inlineDocuments.markUnavailable(tabId);
        setTabState(tabId, { documentId: null,
          inlineTranslationError: { code: 'document.unavailable', message } });
      },
      inlineErrors: {
        get: invocationOptions.inlineErrors.get,
        set: (id, error) => {
          if (invocationWork.isCurrent()) {
            setTabState(id, { inlineTranslationError: error });
          }
        },
      },
    });
    try {
      await currentInvocation.invoke(trigger, tabId);
    } finally {
      invocationWork.release();
    }
  }
  const sendInlineInstruction = invocation.sendInstruction;
  const clearInlineTranslationError = invocation.clearError;

  // Unlike an invocation, whose steps are independent, a control is a single gesture: a
  // refused step stops the rest, because carrying on would run the control unauthorized and
  // leave the reader with a click that silently did nothing.
  async function runInlineTranslationControl(
    tabId,
    control,
    send = sendInlineInstruction,
    expectedDocumentId = null
  ) {
    const { steps } = planInlineTranslationControl(control);
    if (!steps.length) {
      throw new Error(`Unknown inline translation control: ${control}`);
    }
    const controlWork = inlineDocuments.beginControl(tabId);
    try {
      const documentId = await inlineDocuments.captureDocument(tabId, expectedDocumentId);
      for (const step of steps) {
        if (!controlWork.isCurrent()) return;
        await send(tabId, step, documentId);
      }
      if (!controlWork.isCurrent()) return;
      // A control the tab has just carried out disproves a recorded failure to reach it, and
      // the Inline Translation Shortcut is only one of three ways into this feature. The
      // panel reports the control's own outcome itself, from the click it is still holding.
      clearInlineTranslationError(tabId);
    } finally {
      controlWork.release();
    }
  }

  async function requestTranslation({
    service = 'openai',
    apiKey,
    model,
    reasoningEffort = DEFAULT_SETTINGS.reasoningEffort,
    instructions,
    input,
    textFormat = null,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    signal,
    beforeRequest,
  }) {
    if (!givenFetch) throw missingPlatform('a network');
    if (beforeRequest) await beforeRequest();
    if (signal?.aborted) throw documentEnded();
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
      res = await givenFetch(openrouter ? 'https://openrouter.ai/api/v1/responses' : 'https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal,
      });
    } catch {
      if (signal?.aborted) throw documentEnded();
      const code = `${openrouter ? 'openrouter' : 'openai'}.transport`;
      throw Object.assign(new Error(getServiceFailureMessage(service, code)), { code });
    }

    const json = await res.json().catch(() => null);
    if (signal?.aborted) throw documentEnded();
    if (!res.ok) {
      const failures = {
        401: 'authentication', 403: 'access', 404: 'model', 429: 'rate_limit', 503: 'unavailable',
      };
      const failure = openrouter && res.status === 402 ? 'credits' : failures[res.status] || 'request';
      const code = `${service}.${failure}`;
      throw Object.assign(new Error(getServiceFailureMessage(service, code)), { code });
    }

    try {
      return openAiResponse.parseCompletedResponse(json);
    } catch (error) {
      error.message = `${openrouter ? 'OpenRouter' : 'OpenAI'} returned an invalid or incomplete translation response.`;
      throw error;
    }
  }

  async function translateVisibleBlockBatch(
    records,
    settingsSnapshot = null,
    options = {}
  ) {
    getChrome();
    const documentRequest = Number.isInteger(options.tabId)
      ? await inlineDocuments.beginRequest(options.tabId, options.documentId)
      : null;
    const run = inlineDiagnostics.beginTranslation(options.correlationContext);

    try {
      const normalized = inlineRequest.normalizeSourceBatch(records);
      run.describe({ records: normalized });

      if (!normalized.length) {
        return [];
      }

      const settings = mergeVisibleBatchSettingsSnapshot(
        await settingsLifecycle.read(),
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
      }, (request) => requestTranslation({ ...request, service: settings.service, apiKey,
        signal: documentRequest?.signal, beforeRequest: async () => {
          if (documentRequest) await documentRequest.beforeRequest();
          run.modelAttempt();
        } }));
      documentRequest?.assertCurrent();
      const completed = await run.complete(results);
      documentRequest?.assertCurrent();
      return completed;
    } catch (error) {
      await run.fail(error);
      throw error;
    } finally {
      documentRequest?.release();
    }
  }

  async function onInstalled() {
    await settingsLifecycle.save({});
    await releaseActionClickToExtension();
  }

  // chrome.runtime.onStartup.
  async function onStartup() {
    await releaseActionClickToExtension();
    await settingsLifecycle.reconcile();
  }

  function onTabRemoved(tabId) {
    textExecution.cancelDeparted(tabId);
    void textRetention.close(tabId).catch(() => {});
    inlineDocuments.close(tabId);
  }

  function onNavigationCommitted(details) {
    if (details.frameId !== 0) return;
    textExecution.cancelDeparted(details.tabId, details.documentId);
    textRetention.observeDocument(details.tabId, details.documentId);
    if (inlineDocuments.observeNavigation(details.tabId, details.documentId)) {
      setTabState(details.tabId, { inlineTranslationError: null });
    }
  }

  // chrome.action.onClicked. Deliberately not async: the first step opens the side panel,
  // and awaiting anything before it would forfeit the user gesture Chrome requires
  // (ADR-0001).
  function onActionClicked(tab) {
    if (!tab?.id) return;
    invokeForTab('action', tab.id);
  }

  // The Inline Translation Shortcut, registered on chrome.commands.onCommand.addListener.
  // Chrome offers that listener every command the manifest declares, so
  // INLINE_TRANSLATION_SHORTCUT_COMMAND is what decides which of them reaches the worker.
  async function onCommand(command, tab) {
    if (command !== INLINE_TRANSLATION_SHORTCUT_COMMAND) return;
    if (!Number.isInteger(tab?.id) || tab.id < 0) return;
    await invokeForTab('command', tab.id);
  }

  // chrome.runtime.onMessage.
  //
  // The platform is reached inside the branch that needs it rather than here: most messages
  // are answered out of this instance's own state, and a message this worker does not serve
  // has to be turned away before anything is reached at all.
  function onMessage(msg, sender, sendResponse) {
    (async () => {
      try {
        if (['GET_TEXT_TRANSLATION_STATE', 'SAVE_TEXT_TRANSLATION_STATE', 'CLEAR_TEXT_TRANSLATION_STATE',
          'TRANSLATE_TEXT', 'STOP_TEXT_TRANSLATION'].includes(msg?.type) &&
            (!Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId ||
              sender.url !== getChrome().runtime.getURL('text-translation.html'))) {
          throw new Error('Text Translation requires its own extension page.');
        }
        if (msg?.type === 'GET_TEXT_TRANSLATION_STATE') {
          const state = await textRetention.restore(sender.tab.id, sender.documentId);
          sendResponse({ ok: true, state });
          return;
        }
        if (msg?.type === 'SAVE_TEXT_TRANSLATION_STATE') {
          await textRetention.save(sender.tab.id, sender.documentId, msg.revision, msg.state);
          sendResponse({ ok: true });
          return;
        }
        if (msg?.type === 'CLEAR_TEXT_TRANSLATION_STATE') {
          await textRetention.clear(sender.tab.id, sender.documentId, msg.revision);
          sendResponse({ ok: true });
          return;
        }
        if (['TRANSLATE_TEXT', 'STOP_TEXT_TRANSLATION'].includes(msg?.type)) {
          if (typeof msg.operationId !== 'string' || !msg.operationId || msg.operationId.length > 100) {
            throw new Error('Text Translation requires its own extension page.');
          }
          if (msg.type === 'STOP_TEXT_TRANSLATION') {
            textExecution.stop(sender.tab.id, sender.documentId, msg.operationId);
            sendResponse({ ok: true });
            return;
          }
          const result = await textExecution.translate(sender.tab.id, sender.documentId, msg);
          sendResponse({ ok: true, result });
          return;
        }
        if (msg?.type === 'OPEN_INLINE_TRANSLATION_CONTROLS') {
          if (!Number.isInteger(sender?.tab?.id) || sender.frameId !== 0) {
            throw new Error('Inline controls require a top-level page sender.');
          }
          await getChrome().sidePanel.open({ tabId: sender.tab.id });
          sendResponse({ ok: true });
          return;
        }
        if (msg?.type === 'GET_STATE') {
          const tabId = msg.tabId;
          const stored = stateByTab.get(tabId);
          const state = sanitizePublicTabState(
            (msg.documentId === null ? {
              documentId: null,
              workerEpoch, stateSequence: stored?.stateSequence || 0,
              ...(stored?.documentId === null ? { inlineTranslationError: stored.inlineTranslationError } : {}),
            } : msg.documentId && stored?.documentId !== msg.documentId ? null : stored) || {
              workerEpoch, stateSequence: 0,
              ...(msg.documentId ? { documentId: msg.documentId } : {}),
            }
          );
          sendResponse({
            ok: true,
            state,
          });
          return;
        }
        if (msg?.type === 'RUN_INLINE_TRANSLATION_CONTROL') {
          try {
            if (sender?.tab || typeof msg.documentId !== 'string' || !msg.documentId) throw documentEnded();
            await runInlineTranslationControl(msg.tabId, msg.control, sendInlineInstruction, msg.documentId);
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
            }, { documentId: await inlineDocuments.captureDocument(msg.tabId, msg.documentId) });
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
          if (!Number.isInteger(sender?.tab?.id) || sender.frameId !== 0 || !sender.documentId) {
            throw documentEnded();
          }
          const results = await translateVisibleBlockBatch(
            msg.records || [],
            msg.settingsSnapshot || null,
            {
              tabId: sender.tab.id,
              documentId: sender.documentId,
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
            await settingsLifecycle.read(),
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
          const settings = await settingsLifecycle.read();
          settings.apiKey = settings.apiKey ? '***' : '';
          settings.openrouterApiKey = settings.openrouterApiKey ? '***' : '';
          sendResponse({ ok: true, settings });
          return;
        }
        if (msg?.type === 'SAVE_SETTINGS') {
          await settingsLifecycle.save(msg.settings || {});
          sendResponse({ ok: true });
          return;
        }
        if (msg?.type === 'CLEAR_API_KEY') {
          await settingsLifecycle.clearKey(msg.service);
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
      onTabRemoved,
      onNavigationCommitted,
      onActionClicked,
      onCommand,
      onMessage,
    },
    // Everything below is what this file already exported, backed by this instance so that an
    // export and the worker the browser is running are the same thing.
    requestTranslation,
    runInlineTranslationControl,
    sendInlineInstruction,
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
  chrome.tabs.onRemoved.addListener(backgroundWorker.handlers.onTabRemoved);
  chrome.webNavigation.onCommitted.addListener(backgroundWorker.handlers.onNavigationCommitted);
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
    safeError,
    sanitizePublicTabState,
    mergeVisibleBatchSettingsSnapshot,
    getInlineContentScriptFiles,
    classifyContentScriptFailure,
    INLINE_TRANSLATION_SHORTCUT_COMMAND,
    planInlineTranslationControl,
    describeInlineTranslationControlFailure,
    normalizeMaxOutputTokens,
  };
}
