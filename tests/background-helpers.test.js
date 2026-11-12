const requestPreparation = require('../extension/inline-request.js');
const assert = require('node:assert/strict');
const helpers = require('../extension/background.js');
const contentHelpers = require('../extension/content.js');
const { createReasoningFixture } = require('./inline-block.test');

const TEXT_SENDER = { tab: { id: 90 }, frameId: 0, documentId: 'document-90',
  url: 'chrome-extension://test/text-translation.html' };
const TEXT_SETTINGS = { service: 'openrouter', model: 'ignored', reasoningEffort: 'high',
  sourceLanguage: 'auto', targetLanguage: 'Korean', tone: 'natural' };

async function sendTextMessage(worker, message, sender = TEXT_SENDER) {
  return new Promise(resolve => worker.handlers.onMessage(message, sender, resolve));
}

function assertIdleResponse(response) {
  assert.equal(response.ok, true);
  const { workerEpoch, ...state } = response.state;
  assert.match(workerEpoch, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(state, {
    stateSequence: 0,
  });
}

function createCompletedResponse(outputText) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: outputText }],
    }],
  };
}

function createIncompleteResponse() {
  return {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [],
  };
}

// Drives one request and hands back the body it carried. The two checks that use it are about
// what goes out rather than what comes back, so the answer is fixed and the request is what is
// kept. The network is the whole platform, because building a request reaches no Chrome
// namespace.
async function runTranslationRequest(request) {
  let requestBody = null;
  const worker = helpers.createBackgroundWorker({
    fetch: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return createCompletedResponse('번역 결과');
        },
      };
    },
  });

  const output = await worker.requestTranslation(request);
  return { requestBody, output };
}

function createBlockApiRecord(id = 'b1') {
  const { serialized } = createReasoningFixture();
  return {
    id,
    template: serialized.template,
    atoms: serialized.atoms,
    contract: serialized.contract,
    repair: null,
  };
}

function createTestPlainBlockRecord(id = 'b1') {
  return {
    id,
    template: 'a',
    atoms: [],
    contract: {
      codecVersion: 1,
      namespace: 'CAT_PLAIN',
      entries: [],
      maxOutputChars: 2000,
      requiresText: true,
    },
    repair: null,
  };
}

// The settings a Semantic Block batch translates under. Every check that drives one wants the
// same three fields — a key to send, a model to name in the run it writes, and a target
// language its answers are judged against — so those are the default, and a check spells the
// settings out only where the difference is its subject.
const BLOCK_BATCH_SETTINGS = Object.freeze({
  apiKey: 'sk-test',
  model: 'gpt-5.4-mini',
  targetLanguage: 'Korean',
});

// The platform a Semantic Block batch reaches, and nothing else: `storage.local` for the
// settings it translates under, the key its fingerprints are signed with, and the diagnostics
// run it leaves behind, plus `runtime.getManifest` for the version that run is stamped with.
// A batch is handed its records and hands its results straight back, so there is no tab to
// broadcast to and no panel to open — the network is the only other thing it touches, and the
// worker takes that as `fetch`.
//
// `stored` is the caller's own object, which is how a check reads back the run that was
// written; one that only cares about the results it got lets this keep a throwaway. `session`
// is absent unless a check is about session storage, because a worker without one holds its
// correlations in instance state instead — see the restart below, where the difference is the
// whole point.
function createBlockBatchChrome({
  stored = {},
  settings = BLOCK_BATCH_SETTINGS,
  session = null,
} = {}) {
  return {
    webNavigation: { async getFrame({ tabId }) { return { documentId: `document-${tabId}` }; } },
    runtime: { getManifest() { return { version: 'test' }; }, async getContexts({ tabIds: [tabId] }) {
      return [{ tabId, frameId: 0, documentId: `document-${tabId}`,
        documentUrl: 'chrome-extension://test/text-translation.html' }];
    } },
    storage: {
      ...(session ? { session } : {}),
      local: {
        async get(keys) {
          if (keys === null) return { ...stored };
          const requested = Array.isArray(keys) ? keys : [keys];
          if (requested.includes('settings')) return { settings };
          const result = {};
          for (const key of requested) {
            if (Object.hasOwn(stored, key)) result[key] = stored[key];
          }
          return result;
        },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
        },
      },
    },
  };
}

// Hands messages to a worker the way Chrome does and collects the answers. The handler
// returns before the work it started finishes — it returns `true` to keep the channel open
// and calls `sendResponse` later — so a caller waits on the callback rather than on the
// call. Every message is delivered before the wait begins, because a duplicate arriving
// while the first is still running is itself something checked below.
//
// The tick bound is a deadlock guard rather than a timeout worth tuning: everything the
// worker does under these fake platforms resolves in microtasks and immediate timers, so a
// message unanswered after this many turns of the loop is not going to be answered. Coming
// back short is asserted rather than returned, because a check reading only the broadcasts
// would otherwise pass on a message that never got that far.
//
// The sender is where the worker reads the tab out of, so a message whose answer depends on
// which tab sent it passes one. The panel's own messages carry no tab, which is the default.
async function collectWorkerResponses(worker, messages, sender = {}) {
  const responses = [];
  for (const message of messages) {
    const pageSender = message.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH'
      ? { tab: { id: 4201 }, frameId: 0, documentId: `document-${sender.tab?.id || 4201}`, ...sender }
      : sender;
    const boundMessage = message.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { documentId: `document-${message.tabId}`,
        ...message } : message;
    worker.handlers.onMessage(boundMessage, pageSender, (response) => responses.push(response));
  }
  for (let i = 0; i < 40 && responses.length < messages.length; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(responses.length, messages.length, 'a worker message went unanswered');
  return responses;
}

function createSettingsWorker({ settings = {}, legacyKey, get, set, remove, chrome = {} } = {}) {
  let persisted = { ...settings };
  const worker = helpers.createBackgroundWorker({
    chrome: {
      webNavigation: { async getFrame({ tabId }) { return { documentId: `document-${tabId}` }; } },
      ...chrome,
      storage: { local: {
        async get() {
          if (get) await get();
          return { settings: { ...persisted }, openai_api_key: legacyKey };
        },
        async set(value) {
          if (set) await set(value.settings);
          persisted = { ...value.settings };
        },
        async remove(key) {
          assert.equal(key, 'openai_api_key');
          if (remove) await remove();
          legacyKey = undefined;
        },
      } },
    },
  });
  const send = (message) => new Promise((resolve) =>
    worker.handlers.onMessage(message, message.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH'
      ? { tab: { id: 4201 }, frameId: 0, documentId: 'document-4201' } : {}, resolve)
  );
  return { worker, send, snapshot: () => ({ settings: { ...persisted }, openai_api_key: legacyKey }) };
}

async function completeSettingsWork(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('settings event work did not complete')), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function createPageChrome({
  settings,
  onStateMessage = () => {},
}) {
  return {
    webNavigation: { async getFrame({ tabId }) { return { documentId: `document-${tabId}` }; } },
    runtime: {
      sendMessage(message) {
        if (message.type === 'STATE_UPDATED') onStateMessage(message);
        return Promise.resolve();
      },
    },
    sidePanel: {
      async setOptions() {},
      async open() {},
    },
    scripting: { async executeScript() {} },
    storage: {
      local: {
        async get() {
          return { settings };
        },
        async set() {},
      },
    },
    tabs: {
      async get(tabId) { return { id: tabId }; },
      async sendMessage(tabId, message) {
        if (message.type === 'GET_INLINE_TRANSLATION_STATE') {
          return { ok: true, snapshot: { status: 'original', progress: '', error: '' } };
        }
        return { ok: true };
      },
    },
  };
}

function createInvocationWorker(settings = {}) {
  const calls = [];
  const broadcasts = [];
  const chrome = createPageChrome({ settings,
    onStateMessage: (message) => broadcasts.push(message) });
  chrome.sidePanel.open = async (options) => calls.push(['open', options]);
  chrome.sidePanel.setOptions = async (options) => calls.push(['options', options]);
  chrome.storage.local.get = async () => { calls.push(['settings']); return { settings }; };
  chrome.scripting.executeScript = async (options) => calls.push(['inject', options]);
  chrome.tabs.query = async (options) => { calls.push(['query', options]); return [{ id: 4201 }]; };
  const answer = chrome.tabs.sendMessage;
  chrome.tabs.sendMessage = async (tabId, message) => {
    calls.push(['message', tabId, message]);
    return answer(tabId, message);
  };
  const worker = helpers.createBackgroundWorker({ chrome, fetch: async () => {
    calls.push(['model']);
    throw new Error('Unexpected model request');
  } });
  return { worker, chrome, calls, broadcasts, async invoke(trigger) {
    if (trigger === 'command') await worker.handlers.onCommand('translate-inline', { id: 4201 });
    else {
      worker.handlers.onActionClicked({ id: 4201 });
      await require('./inline-translation-operation.test').flushMicrotasks();
    }
  } };
}

exports.name = 'background helpers';
exports.tests = [
  {
    name: 'shortcut binds the event tab before a delayed active-tab query could select a replacement',
    async fn() {
      const { worker, chrome, calls } = createInvocationWorker();
      let releaseQuery;
      let currentDocument = 'document-4201';
      const captures = [];
      chrome.tabs.query = () => new Promise(resolve => { releaseQuery = resolve; });
      chrome.webNavigation.getFrame = async ({ tabId }) => {
        captures.push({ tabId, documentId: currentDocument });
        return { documentId: currentDocument };
      };
      const pending = worker.handlers.onCommand('translate-inline', { id: 4201 });
      const capturedAtGesture = captures[0];
      const openedAtGesture = calls[0];
      currentDocument = 'replacement-4201';
      worker.handlers.onNavigationCommitted({ tabId: 4201, frameId: 0, documentId: currentDocument });
      releaseQuery?.([{ id: 4201 }]);
      await pending;
      assert.deepEqual(capturedAtGesture, { tabId: 4201, documentId: 'document-4201' });
      assert.deepEqual(openedAtGesture, ['open', { tabId: 4201 }]);
      assert.equal(typeof releaseQuery, 'undefined');
      assert.equal(calls.some(call => call[0] === 'message'), false);
    },
  },
  {
    name: 'shortcut without an event tab never authorizes a later active tab',
    async fn() {
      const { worker, calls } = createInvocationWorker();
      await worker.handlers.onCommand('translate-inline');
      assert.equal(calls.length, 0);
    },
  },
  {
    name: 'shortcut on a valid restricted tab opens the panel and exposes a metadata-only failure without injection',
    async fn() {
      const { worker, chrome, calls } = createInvocationWorker();
      chrome.webNavigation.getFrame = async () => null;
      chrome.tabs.get = async () => ({ id: 4201, url: 'chrome://settings/' });
      const pending = worker.handlers.onCommand('translate-inline', { id: 4201, url: 'chrome://settings/' });
      const openedAtGesture = calls[0];
      await pending;
      assert.deepEqual(openedAtGesture, ['open', { tabId: 4201 }]);
      assert.equal(calls.some(call => ['inject', 'message', 'model'].includes(call[0])), false);
      const [response] = await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201, documentId: null }]);
      assert.equal(response.ok, true);
      assert.equal(response.state.documentId, null);
      assert.equal(response.state.inlineTranslationError.code, 'document.unavailable');
      assert.match(response.state.inlineTranslationError.message, /Chrome does not allow extensions/);
      assert.equal(Object.hasOwn(response.state, 'extracted'), false);
      assert.equal(Object.hasOwn(response.state, 'translated'), false);
    },
  },
  {
    name: 'unknown-document metadata reads never expose the previous document inline error',
    async fn() {
      const { worker, chrome } = createInvocationWorker();
      chrome.tabs.sendMessage = async () => { throw new Error('previous document failure'); };
      await worker.handlers.onCommand('translate-inline', { id: 4201 });
      const [response] = await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201, documentId: null }]);
      assert.equal(response.ok, true);
      assert.equal(response.state.documentId, null);
      assert.equal(Object.hasOwn(response.state, 'inlineTranslationError'), false);
      assert.equal(JSON.stringify(response).includes('previous document failure'), false);
    },
  },
  {
    name: 'a late unavailable-document lookup cannot attach its error to a replacement document',
    async fn() {
      const { worker, chrome } = createInvocationWorker();
      let release;
      let entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      chrome.webNavigation.getFrame = async () => null;
      chrome.tabs.get = async () => { entered(); await gate; return { id: 4201, url: 'chrome://settings/' }; };
      const pending = worker.handlers.onCommand('translate-inline', { id: 4201 });
      await ready;
      chrome.webNavigation.getFrame = async () => ({ documentId: 'replacement-4201' });
      worker.handlers.onNavigationCommitted({ tabId: 4201, frameId: 0, documentId: 'replacement-4201' });
      release();
      await pending;
      const [response] = await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201,
        documentId: 'replacement-4201' }]);
      assert.equal(response.state.documentId, 'replacement-4201');
      assert.equal(response.state.inlineTranslationError, null);
    },
  },
  {
    name: 'a departed Inline request lookup cannot invalidate the replacement document owner',
    async fn() {
      let releaseLookup, lookupEntered, releaseModel, modelEntered;
      const lookupReady = new Promise(resolve => { lookupEntered = resolve; });
      const lookupGate = new Promise(resolve => { releaseLookup = resolve; });
      const modelReady = new Promise(resolve => { modelEntered = resolve; });
      const modelGate = new Promise(resolve => { releaseModel = resolve; });
      let currentDocument = 'document-42';
      let lookups = 0;
      let replacementSignal;
      const chrome = createBlockBatchChrome();
      chrome.runtime.sendMessage = async () => {};
      chrome.webNavigation.getFrame = async () => {
        if (++lookups === 2) { lookupEntered(); await lookupGate; return { documentId: 'departed-lookup-result' }; }
        return { documentId: currentDocument };
      };
      const worker = helpers.createBackgroundWorker({ chrome, crypto: globalThis.crypto, fetch: async (_url, options) => {
        replacementSignal = options.signal; modelEntered(); await modelGate;
        return { ok: true, async json() { return createCompletedResponse(JSON.stringify({ translations: [
          { id: 'b1', template: '새 문서 번역' },
        ] })); } };
      } });
      const request = () => collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        records: [createTestPlainBlockRecord()] }], { tab: { id: 42 }, frameId: 0, documentId: currentDocument });
      const old = request();
      await lookupReady;
      currentDocument = 'replacement-42';
      worker.handlers.onNavigationCommitted({ tabId: 42, frameId: 0, documentId: currentDocument });
      const replacement = request();
      await modelReady;
      releaseLookup();
      await old;
      assert.equal(replacementSignal.aborted, false);
      releaseModel();
      const [response] = await replacement;
      assert.equal(response.ok, true);
      assert.equal(response.results[0].disposition, 'apply');
    },
  },
  {
    name: 'unrelated navigation and closed-tab navigation create no extension state or broadcasts',
    async fn() {
      const broadcasts = [];
      const worker = helpers.createBackgroundWorker({ chrome: createPageChrome({ settings: {},
        onStateMessage: message => broadcasts.push(message) }) });
      for (let tabId = 100; tabId < 200; tabId += 1) {
        worker.handlers.onNavigationCommitted({ tabId, frameId: 0, documentId: `unrelated-${tabId}` });
        worker.handlers.onTabRemoved(tabId);
      }
      const [response] = await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 100 }]);
      assertIdleResponse(response);
      assert.equal(broadcasts.length, 0);
      const invoked = createInvocationWorker();
      await invoked.invoke('action');
      invoked.worker.handlers.onTabRemoved(4201);
      invoked.worker.handlers.onNavigationCommitted({ tabId: 4201, frameId: 0, documentId: 'after-close' });
      assert.equal(invoked.broadcasts.length, 0);
    },
  },
  {
    name: 'an Inline document capture resolving after tab closure cannot recreate its deleted lifetime',
    async fn() {
      let release, entered;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const broadcasts = [];
      const chrome = createPageChrome({ settings: { apiKey: 'synthetic' },
        onStateMessage: message => broadcasts.push(message) });
      chrome.webNavigation.getFrame = async () => { entered(); await gate; return { documentId: 'document-42' }; };
      const worker = helpers.createBackgroundWorker({ chrome, fetch: () => assert.fail('closed capture cannot send') });
      const pending = collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        records: [createTestPlainBlockRecord()] }], { tab: { id: 42 }, frameId: 0, documentId: 'document-42' });
      await ready;
      worker.handlers.onTabRemoved(42);
      release();
      const [response] = await pending;
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'document.departed');
      assertIdleResponse((await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 42 }]))[0]);
      worker.handlers.onNavigationCommitted({ tabId: 42, frameId: 0, documentId: 'after-close' });
      assert.equal(broadcasts.length, 0);
    },
  },
  {
    name: 'shortcut captures the event document before awaiting settings',
    async fn() {
      const { worker, chrome, calls } = createInvocationWorker();
      let releaseTab;
      let tabEntered;
      const tabReady = new Promise(resolve => { tabEntered = resolve; });
      const tabGate = new Promise(resolve => { releaseTab = resolve; });
      let captured = false;
      chrome.webNavigation.getFrame = async () => { captured = true; return { documentId: 'document-4201' }; };
      chrome.storage.local.get = async () => { tabEntered(); await tabGate; return { settings: {} }; };
      const pending = worker.handlers.onCommand('translate-inline', { id: 4201 });
      await tabReady;
      const capturedBeforeTab = captured;
      chrome.webNavigation.getFrame = async () => ({ documentId: 'replacement-4201' });
      worker.handlers.onNavigationCommitted({ tabId: 4201, frameId: 0, documentId: 'replacement-4201' });
      releaseTab();
      await pending;
      assert.equal(capturedBeforeTab, true);
      assert.equal(calls.some(call => call[0] === 'message'), false);
    },
  },
  {
    name: 'diagnostic transport codes are exact allowlisted values',
    fn() {
      const { serializeProblemBlock } = require('../extension/translation-diagnostics.js');
      for (const code of ['openai.authentication', 'openrouter.transport', 'response.output_missing', 'document.departed']) {
        assert.equal(serializeProblemBlock({ terminalCode: code }).terminalCode, code);
      }
      for (const code of ['openai.secret-payload', 'openrouter.transport.secret-payload', 'response.secret-payload']) {
        assert.equal(serializeProblemBlock({ terminalCode: code }).terminalCode, 'runtime.request_failed');
      }
    },
  },
  ...['openai', 'openrouter'].map(service => ({
    name: `${service} transport refuses redirects and redacts upstream failures`,
    async fn() {
      let options;
      const worker = helpers.createBackgroundWorker({ fetch: async (_url, request) => {
        options = request;
        return { ok: false, status: 401, async json() { return { error: { message: 'secret upstream body' } }; } };
      } });
      await assert.rejects(worker.requestTranslation({ service, apiKey: 'synthetic', model: 'm', input: 'A' }),
        error => error.code === `${service}.authentication` && !error.message.includes('secret'));
      assert.equal(options.redirect, 'error');
    },
  })),
  ...['command', 'control'].map(trigger => ({
    name: `${trigger} navigation between preparation and start cannot authorize a replacement document`,
    async fn() {
      const { worker, chrome } = createInvocationWorker();
      let entered;
      let release;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      const sent = [];
      const answer = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = async (tabId, message, options) => {
        sent.push({ ...message, documentId: options.documentId });
        if ((trigger === 'command' && message.type === 'GET_INLINE_TRANSLATION_STATE') ||
            (trigger === 'control' && message.instruction === 'grantInlineTranslationAuthorization')) {
          entered(); await gate;
        }
        return answer(tabId, message);
      };
      const pending = trigger === 'command' ? worker.handlers.onCommand('translate-inline', { id: 4201 }) :
        collectWorkerResponses(worker, [{ type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 4201,
          documentId: 'document-4201', control: 'start' }]);
      await ready;
      chrome.webNavigation.getFrame = async () => ({ documentId: 'replacement' });
      worker.handlers.onNavigationCommitted({ tabId: 4201, frameId: 0, documentId: 'replacement' });
      release();
      await pending;
      assert.equal(sent.some(message => message.instruction === 'startInlineTranslation'), false);
      assert.equal(sent.every(message => message.documentId === 'document-4201'), true);
      assert.equal(sent.filter(message => message.instruction === 'grantInlineTranslationAuthorization').length,
        trigger === 'control' ? 1 : 0);
    },
  })),
  ...['navigation', 'closure'].map(departure => ({
    name: `Inline ${departure} aborts pending transport and discards its repair and result`,
    async fn() {
      let entered;
      let release;
      const ready = new Promise(resolve => { entered = resolve; });
      const gate = new Promise(resolve => { release = resolve; });
      let requests = 0;
      let signal;
      const chrome = createBlockBatchChrome();
      chrome.runtime.sendMessage = async () => {};
      const worker = helpers.createBackgroundWorker({ chrome, fetch: async (_url, options) => {
        requests += 1; signal = options.signal; entered(); await gate;
        return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [{ id: 'b1', template: 'English remains untranslated.' }],
        })); } };
      } });
      const pending = collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        records: [{ ...createTestPlainBlockRecord(), template: 'English remains untranslated.' }] }]);
      await ready;
      if (departure === 'closure') worker.handlers.onTabRemoved(4201);
      else {
        chrome.webNavigation.getFrame = async () => ({ documentId: 'replacement' });
        worker.handlers.onNavigationCommitted({ tabId: 4201, frameId: 0, documentId: 'replacement' });
      }
      const aborted = signal.aborted;
      release();
      const [response] = await pending;
      assert.equal(aborted, true);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, 'document.departed');
      assert.equal(requests, 1);
    },
  })),
  {
    name: 'full initial state distinguishes restarted worker epochs without retaining article bodies',
    async fn() {
      const first = helpers.createBackgroundWorker();
      const restarted = helpers.createBackgroundWorker();
      const [a] = await collectWorkerResponses(first, [{ type: 'GET_STATE', tabId: 42 }]);
      const [b] = await collectWorkerResponses(restarted, [{ type: 'GET_STATE', tabId: 42 }]);
      assert.notEqual(a.state.workerEpoch, b.state.workerEpoch);
      assert.deepEqual({ ...a.state, workerEpoch: '' }, {
        workerEpoch: '', stateSequence: 0,
      });
    },
  },
  {
    name: 'ignores a late unavailable-document lookup after removal without suppressing another tab failure',
    async fn() {
      for (const closedId of [4201, 999]) {
        const { worker, chrome, calls, broadcasts } = createInvocationWorker();
        let release;
        let lookupStarted = false;
        const gate = new Promise(resolve => { release = resolve; });
        chrome.webNavigation.getFrame = async () => null;
        chrome.tabs.get = async tabId => { lookupStarted = true; await gate; return { id: tabId }; };
        const pending = worker.handlers.onCommand('translate-inline', { id: 4201 });
        await require('./inline-translation-operation.test').flushMicrotasks();
        assert.equal(lookupStarted, true);
        worker.handlers.onTabRemoved(closedId);
        release();
        await pending;
        assert.equal(broadcasts.length, closedId === 4201 ? 0 : 1);
        assert.equal(calls.some(call => call[0] === 'open'), true);
        assert.equal(calls.some(call => call[0] === 'message'), false);
      }
    },
  },
  {
    name: 'ignores a document-capture result after the event tab closes before invocation',
    async fn() {
      const { worker, chrome, calls, broadcasts } = createInvocationWorker();
      let resolveFrame;
      chrome.webNavigation.getFrame = () => new Promise(resolve => { resolveFrame = resolve; });
      chrome.tabs.get = async () => { throw new Error('No tab with id: 4201.'); };
      chrome.tabs.sendMessage = async () => ({ ok: false, error: { message: 'The tab was closed.' } });
      const pending = worker.handlers.onCommand('translate-inline', { id: 4201 });
      assert.equal(typeof resolveFrame, 'function');
      worker.handlers.onTabRemoved(4201);
      resolveFrame({ documentId: 'document-4201' });
      await pending;
      assertIdleResponse((await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201 }]))[0]);
      assert.deepEqual(broadcasts, []);
      assert.equal(calls.some(call => call[0] === 'message'), false);
    },
  },
  ...['action', 'command'].map(trigger => ({
    name: `does not restore a closed tab error after a late ${trigger} invocation failure`,
    async fn() {
      const { worker, chrome, broadcasts } = createInvocationWorker();
      let release;
      let entered;
      const gate = new Promise(resolve => { release = resolve; });
      const ready = new Promise(resolve => { entered = resolve; });
      const send = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = async (tabId, message) => {
        if ((trigger === 'action' && message.type === 'GET_INLINE_TRANSLATION_STATE') ||
            (trigger === 'command' && message.instruction === 'startInlineTranslation')) {
          entered();
          await gate;
          return { ok: false, error: { message: 'The tab was closed.' } };
        }
        return send(tabId, message);
      };
      const pending = trigger === 'command'
        ? worker.handlers.onCommand('translate-inline', { id: 4201 })
        : worker.handlers.onActionClicked({ id: 4201 });
      await ready;
      assert.equal(typeof worker.handlers.onTabRemoved, 'function');
      worker.handlers.onTabRemoved(4201);
      release();
      await pending;
      await require('./inline-translation-operation.test').flushMicrotasks();
      assertIdleResponse((await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201 }]))[0]);
      assert.deepEqual(broadcasts, []);
    },
  })),
  {
    name: 'an unsupported explicit service refuses settings and translation before HTTP',
    async fn() {
      const { send, snapshot } = createSettingsWorker({ settings: { apiKey: 'sk-openai-synthetic' } });
      const saved = await send({ type: 'SAVE_SETTINGS', settings: { service: 'unsupported-synthetic' } });
      assert.equal(saved.ok, false);
      assert.equal(snapshot().settings.service, undefined);
      assert.equal(JSON.stringify(saved).includes('unsupported-synthetic'), false);
      assert.equal((await send({ type: 'CLEAR_API_KEY', service: 'unsupported-synthetic' })).ok, false);
      assert.equal(snapshot().settings.apiKey, 'sk-openai-synthetic');

    },
  },
  {
    name: 'OpenRouter Inline worker sends strict structured output to its selected service',
    async fn() {
      const requests = [];
      const worker = helpers.createBackgroundWorker({ chrome: createBlockBatchChrome({ settings: {
        ...BLOCK_BATCH_SETTINGS, service: 'openrouter', openrouterApiKey: 'sk-or-synthetic',
      } }), fetch: async (url, options) => {
        requests.push({ url, authorization: options.headers.Authorization, body: JSON.parse(options.body) });
        return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [{ id: 'b1', template: '번역입니다.' }],
        })); } };
      } });
      const [response] = await collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        records: [createTestPlainBlockRecord()], settingsSnapshot: { service: 'openrouter' },
      }]);
      assert.equal(response.ok, true);
      assert.equal(response.results[0].disposition, 'apply');
      assert.equal(response.results[0].template, '번역입니다.');
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/responses');
      assert.equal(requests[0].authorization, 'Bearer sk-or-synthetic');
      const body = requests[0].body;
      assert.equal(body.model, 'deepseek/deepseek-v4.1-flash-1017');
      assert.deepEqual(body.reasoning, { effort: 'none' });
      assert.deepEqual(body.provider, { require_parameters: true, data_collection: 'deny', zdr: true });
      assert.equal(body.text.format.type, 'json_schema');
      assert.equal(body.text.format.strict, true);
      assert.equal(body.max_output_tokens, 4096);
      assert.equal(body.store, false);
      assert.doesNotMatch(JSON.stringify(response), /sk-or-synthetic|sk-test/);
    },
  },
  ...[
    [401, 'openrouter.authentication'], [402, 'openrouter.credits'],
    [429, 'openrouter.rate_limit'], [503, 'openrouter.unavailable'],
    ['network', 'openrouter.transport'], [null, 'response.not_completed'],
    [createCompletedResponse(''), 'response.output_missing'],
    [createIncompleteResponse(), 'response.incomplete.max_output_tokens'],
    [createCompletedResponse('malformed synthetic payload'), 'protocol.invalid_json'],
  ].map(([answer, code]) => ({
    name: `OpenRouter Inline ${code} fails safely without fallback or another request`,
    async fn() {
      const requests = [];
      const stored = {};
      const worker = helpers.createBackgroundWorker({ chrome: createBlockBatchChrome({ stored, settings: {
        ...BLOCK_BATCH_SETTINGS, service: 'openrouter', openrouterApiKey: 'sk-or-synthetic',
      } }), fetch: async (url, options) => {
        requests.push({ url, authorization: options.headers.Authorization });
        if (answer === 'network') throw new Error('sk-or-synthetic private source payload');
        return { ok: typeof answer !== 'number', status: answer,
          async json() { return typeof answer === 'number'
            ? { error: { message: 'sk-or-synthetic private source payload' } } : answer; } };
      } });
      const [response] = await collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        operationId: 'openrouter-failure', records: [createTestPlainBlockRecord()],
      }]);
      assert.equal(response.ok, false);
      assert.equal(response.error.code, code);
      assert.equal(requests.length, 1);
      const failedRun = Object.values(stored).find(value => value?.outcome === 'failed');
      assert.equal(failedRun.blocks[0].terminalCode, code);
      assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/responses');
      assert.equal(requests[0].authorization, 'Bearer sk-or-synthetic');
      assert.doesNotMatch(JSON.stringify([response, stored]), /sk-or-synthetic|sk-test|private source payload|malformed synthetic payload/);
    },
  })),
  {
    name: 'OpenRouter Inline missing key never uses the saved OpenAI key',
    async fn() {
      const worker = helpers.createBackgroundWorker({ chrome: createBlockBatchChrome({ settings: {
        ...BLOCK_BATCH_SETTINGS, service: 'openrouter',
      } }), fetch: () => assert.fail('missing selected key cannot send HTTP') });
      const [response] = await collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        records: [createTestPlainBlockRecord()],
      }]);
      assert.equal(response.ok, false);
      assert.match(response.error.message, /OpenRouter.*key/);
    },
  },
  {
    name: 'an active OpenAI Inline settings snapshot survives a saved service switch',
    async fn() {
      const requests = [];
      const worker = helpers.createBackgroundWorker({ chrome: createBlockBatchChrome({ settings: {
        ...BLOCK_BATCH_SETTINGS, service: 'openrouter', openrouterApiKey: 'sk-or-synthetic',
      } }), fetch: async (url, options) => {
        requests.push({ url, authorization: options.headers.Authorization });
        return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
          blocks: [{ id: 'b1', text: '번역', sourceLanguage: 'en', targetLanguage: 'ko' }],
        })); } };
      } });
      await collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        settingsSnapshot: { service: 'openai', model: 'custom-openai', targetLanguage: 'Korean' },
        records: [createTestPlainBlockRecord()],
      }]);
      assert.ok(requests.length > 0);
      assert.ok(requests.every(request => request.url === 'https://api.openai.com/v1/responses' &&
        request.authorization === 'Bearer sk-test'));
    },
  },
  ...[
    [401, 'authentication'], [402, 'credits'], [403, 'access'], [404, 'model'],
    [429, 'rate_limit'], [503, 'unavailable'], [400, 'request'], ['network', 'transport'],
  ].map(([status, code]) => ({
    name: 'OpenRouter ' + code + ' failure is attributed and redacted without fallback',
    async fn() {
      const requests = [];
      const worker = helpers.createBackgroundWorker({ fetch: async (url) => {
        requests.push(url);
        if (status === 'network') throw new Error('synthetic private-payload');
        return { ok: false, status, async json() { return { error: { message: 'synthetic private-payload' } }; } };
      } });
      await assert.rejects(worker.requestTranslation({ service: 'openrouter', apiKey: 'synthetic',
        model: 'ignored', input: 'source-private-payload' }), error => {
        assert.equal(error.code, 'openrouter.' + code);
        assert.match(error.message, /OpenRouter/);
        assert.doesNotMatch(error.message, /synthetic|private-payload/);
        return true;
      });
      assert.deepEqual(requests, ['https://openrouter.ai/api/v1/responses']);
    },
  })),
  {
    name: 'service settings preserve and clear independent credentials without exposing them',
    async fn() {
      const { send, snapshot } = createSettingsWorker({
        legacyKey: 'sk-legacy-synthetic', settings: { model: 'custom-openai' },
      });
      assert.equal((await send({ type: 'GET_SETTINGS' })).settings.service, 'openai');
      await send({ type: 'SAVE_SETTINGS', settings: {
        service: 'openrouter', openrouterApiKey: 'sk-or-synthetic',
      } });
      await send({ type: 'SAVE_SETTINGS', settings: { tone: 'formal' } });
      const publicSettings = (await send({ type: 'GET_SETTINGS' })).settings;
      assert.equal(publicSettings.apiKey, '***');
      assert.equal(publicSettings.openrouterApiKey, '***');
      assert.equal(publicSettings.model, 'custom-openai');
      assert.equal(JSON.stringify(publicSettings).includes('synthetic'), false);
      await send({ type: 'CLEAR_API_KEY', service: 'openrouter' });
      assert.equal(snapshot().settings.apiKey, 'sk-legacy-synthetic');
      assert.equal(snapshot().settings.openrouterApiKey, undefined);
      assert.equal(snapshot().openai_api_key, 'sk-legacy-synthetic');
      await send({ type: 'SAVE_SETTINGS', settings: { openrouterApiKey: 'sk-or-new-synthetic' } });
      await send({ type: 'CLEAR_API_KEY', service: 'openai' });
      assert.equal(snapshot().settings.openrouterApiKey, 'sk-or-new-synthetic');
      assert.equal(snapshot().settings.apiKey, undefined);
      assert.equal(snapshot().openai_api_key, undefined);
    },
  },
  {
    name: 'toolbar opens once before settings resolve and prepares the page without translating',
    async fn() {
      const calls = [];
      let releaseSettings;
      const chrome = createPageChrome({ settings: {} });
      chrome.sidePanel.open = async (options) => calls.push(['open', options]);
      chrome.sidePanel.setOptions = async (options) => calls.push(['options', options]);
      chrome.storage.local.get = () => {
        calls.push(['settings']);
        return new Promise((resolve) => {
          releaseSettings = () => resolve({ settings: { buttonVisibility: 'onInvocation' } });
        });
      };
      chrome.scripting.executeScript = async (options) => calls.push(['inject', options]);
      const answer = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = async (tabId, message) => {
        calls.push(['message', tabId, message]);
        return answer(tabId, message);
      };
      const worker = helpers.createBackgroundWorker({ chrome, fetch: async () => {
        assert.fail('toolbar must not send a model request');
      } });

      worker.handlers.onActionClicked({ id: 9 });
      assert.deepEqual(calls, [['open', { tabId: 9 }], ['settings']]);
      releaseSettings();
      await require('./inline-translation-operation.test').flushMicrotasks();

      assert.deepEqual(calls, [
        ['open', { tabId: 9 }],
        ['settings'],
        ['options', { tabId: 9, path: 'sidepanel.html', enabled: true }],
        ['inject', { target: { tabId: 9, documentIds: ['document-9'] }, files: helpers.getInlineContentScriptFiles() }],
        ['message', 9, { type: 'GET_INLINE_TRANSLATION_STATE' }],
        ['message', 9, { type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' }],
        ['message', 9, { type: 'RUN_INLINE_INSTRUCTION', instruction: 'mountFloatingTranslateButton' }],
      ]);
    },
  },
  {
    name: 'shortcut waits for panel preparation before injecting the page',
    async fn() {
      const { chrome, calls, invoke } = createInvocationWorker();
      let releasePanel;
      chrome.sidePanel.setOptions = (options) => {
        calls.push(['options', options]);
        return new Promise((resolve) => { releasePanel = resolve; });
      };
      const running = invoke('command');
      await require('./inline-translation-operation.test').flushMicrotasks();
      assert.equal(typeof releasePanel, 'function');
      assert.equal(calls.some(([kind]) => kind === 'inject'), false);
      releasePanel();
      await running;
      assert.equal(calls.some(([kind]) => kind === 'inject'), true);
    },
  },
  {
    name: 'toolbar reports unsuccessful content initialization after script injection',
    async fn() {
      const broadcasts = [];
      const pageMessages = [];
      const chrome = createPageChrome({
        settings: { buttonVisibility: 'never' },
        onStateMessage: (message) => broadcasts.push(message),
      });
      chrome.tabs.sendMessage = async (tabId, message) => {
        pageMessages.push({ tabId, ...message });
        return undefined;
      };
      const worker = helpers.createBackgroundWorker({ chrome });

      worker.handlers.onActionClicked({ id: 4201 });
      await require('./inline-translation-operation.test').flushMicrotasks();

      assert.equal(broadcasts.at(-1)?.state.inlineTranslationError?.code,
        'content_script_not_ready');
      assert.match(broadcasts.at(-1).state.inlineTranslationError.message,
        /Reload the extension.*reload this page/);
      assert.equal(broadcasts.at(-1).state.error, undefined);
      assert.deepEqual(pageMessages, [{ tabId: 4201, type: 'GET_INLINE_TRANSLATION_STATE' }]);
    },
  },
  {
    name: 'shortcut waits for valid content readiness and clears the failure on a later invocation',
    async fn() {
      const broadcasts = [];
      const pageMessages = [];
      const chrome = createPageChrome({
        settings: { buttonVisibility: 'never' },
        onStateMessage: (message) => broadcasts.push(message),
      });
      chrome.tabs.query = async () => [{ id: 4201 }];
      let readiness;
      chrome.tabs.sendMessage = async (tabId, message) => {
        pageMessages.push({ tabId, ...message });
        return message.type === 'GET_INLINE_TRANSLATION_STATE' ? readiness : { ok: true };
      };
      const worker = helpers.createBackgroundWorker({ chrome });
      const invalid = [undefined, { ok: false }, { ok: true },
        { ok: false, snapshot: { status: 'original', progress: '', error: '' } },
        { ok: true, snapshot: { status: 'active' } },
        { ok: true, snapshot: { status: 'unknown', progress: '', error: '' } },
        { ok: true, snapshot: { status: 'original', progress: 0, error: '' } },
        { ok: true, snapshot: { status: 'original', progress: '', error: null } }];
      for (readiness of invalid) {
        pageMessages.length = 0;
        await worker.handlers.onCommand('translate-inline', { id: 4201 });
        assert.equal(broadcasts.at(-1)?.state.inlineTranslationError?.code,
          'content_script_not_ready');
        assert.deepEqual(pageMessages, [{ tabId: 4201, type: 'GET_INLINE_TRANSLATION_STATE' }]);
      }

      readiness = { ok: true, snapshot: { status: 'original', progress: '', error: '' } };
      pageMessages.length = 0;
      await worker.handlers.onCommand('translate-inline', { id: 4201 });

      assert.equal(broadcasts.at(-1).state.inlineTranslationError, null);
      assert.deepEqual(pageMessages, [
        { tabId: 4201, type: 'GET_INLINE_TRANSLATION_STATE' },
        { tabId: 4201, type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' },
        { tabId: 4201, type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation' },
      ]);
    },
  },
  {
    name: 'startup waits for the pending all-pages save before checking its permission',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let granted = true;
      let registered = false;
      const { worker, send } = createSettingsWorker({
        settings: { buttonVisibility: 'never' },
        async set() { started(); await gate; },
        chrome: {
          sidePanel: { setPanelBehavior: async () => {} },
          permissions: { contains: async () => granted, remove: async () => { granted = false; } },
          scripting: {
            registerContentScripts: async () => { registered = true; },
            unregisterContentScripts: async () => { registered = false; },
          },
        },
      });
      const save = send({ type: 'SAVE_SETTINGS', settings: { buttonVisibility: 'allPages' } });
      await completeSettingsWork(ready);
      const startup = worker.handlers.onStartup();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(granted, true);
      release();
      await completeSettingsWork(Promise.all([save, startup]));
      assert.equal(granted, true);
      assert.equal(registered, true);
    },
  },
  ...['onStartup', 'onInstalled'].map((event) => ({
    name: `${event} overlapping visibility saves completes with the latest all-pages grant`,
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      let granted = false;
      let registered = false;
      const { worker, send } = createSettingsWorker({
        async set() { if (++writes === 1) { started(); await gate; } },
        chrome: {
          sidePanel: { setPanelBehavior: async () => {} },
          permissions: { contains: async () => granted, remove: async () => { granted = false; } },
          scripting: {
            registerContentScripts: async () => { registered = true; },
            unregisterContentScripts: async () => { registered = false; },
          },
        },
      });
      const first = event === 'onInstalled' ? worker.handlers.onInstalled()
        : send({ type: 'SAVE_SETTINGS', settings: { buttonVisibility: 'never' } });
      await completeSettingsWork(ready);
      const startup = event === 'onStartup' ? worker.handlers.onStartup() : Promise.resolve();
      await Promise.resolve();
      granted = true;
      const second = send({ type: 'SAVE_SETTINGS', settings: { buttonVisibility: 'allPages' } });
      release();
      await completeSettingsWork(Promise.all([first, startup, second]));
      assert.equal((await send({ type: 'GET_SETTINGS' })).settings.buttonVisibility, 'allPages');
      assert.equal(granted, true);
      assert.equal(registered, true);
    },
  })),
  ...[true, false].map((clearFirst) => ({
    name: `${clearFirst ? 'key removal then installation' : 'installation then key removal'} leaves no stored key`,
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      const { worker, send } = createSettingsWorker({
        settings: { model: 'retained-model' }, legacyKey: 'sk-legacy-synthetic',
        async set() { if (++writes === 1) { started(); await gate; } },
        chrome: { sidePanel: { setPanelBehavior: async () => {} } },
      });
      const first = clearFirst ? send({ type: 'CLEAR_API_KEY' }) : worker.handlers.onInstalled();
      await ready;
      const second = clearFirst ? worker.handlers.onInstalled() : send({ type: 'CLEAR_API_KEY' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await Promise.all([first, second]);
      const result = await send({ type: 'GET_SETTINGS' });
      assert.equal(result.settings.apiKey, '');
      assert.equal(result.settings.model, 'retained-model');
    },
  })),
  ...['get', 'set', 'remove'].map((failure) => ({
    name: `key removal ${failure} failure remains private without retry and later changes recover`,
    async fn() {
      let fail = true;
      let attempts = 0;
      const { send, snapshot } = createSettingsWorker({
        settings: { apiKey: 'sk-current-synthetic', model: 'retained-model' },
        legacyKey: 'sk-legacy-synthetic',
        async [failure]() {
          attempts += 1;
          if (fail) { fail = false; throw new Error('sk-current-synthetic sk-legacy-synthetic'); }
        },
      });
      const clear = send({ type: 'CLEAR_API_KEY' });
      const save = send({ type: 'SAVE_SETTINGS', settings: { tone: 'formal' } });
      const [failed, saved] = await Promise.all([clear, save]);
      assert.equal(failed.ok, false);
      assert.doesNotMatch(JSON.stringify(failed), /sk-current|sk-legacy/);
      assert.deepEqual(saved, { ok: true });
      assert.equal(attempts, failure === 'remove' ? 1 : 2);
      assert.deepEqual(await send({ type: 'CLEAR_API_KEY' }), { ok: true });
      const result = await send({ type: 'GET_SETTINGS' });
      assert.equal(result.settings.apiKey, '');
      assert.equal(result.settings.model, 'retained-model');
      assert.equal(result.settings.tone, 'formal');
      assert.equal(snapshot().settings.apiKey, undefined);
      assert.equal(snapshot().openai_api_key, undefined);
    },
  })),
  {
    name: 'clears both API key locations without changing other settings or permitting new translation',
    async fn() {
      const { send } = createSettingsWorker({
        settings: { apiKey: 'sk-current-synthetic', model: 'retained-model', tone: 'formal',
          targetLanguage: 'Japanese', buttonVisibility: 'onInvocation', chunkMaxChars: 9000, viewMode: 'bilingual' },
        legacyKey: 'sk-legacy-synthetic',
      });
      assert.deepEqual(await send({ type: 'CLEAR_API_KEY' }), { ok: true });
      const { settings } = await send({ type: 'GET_SETTINGS' });
      assert.equal(settings.apiKey, '');
      assert.equal(settings.model, 'retained-model');
      assert.equal(settings.tone, 'formal');
      assert.equal(settings.targetLanguage, 'Japanese');
      assert.equal(settings.buttonVisibility, 'onInvocation');
      assert.equal(Object.hasOwn(settings, 'chunkMaxChars'), false);
      assert.equal(Object.hasOwn(settings, 'viewMode'), false);
      const translated = await send({ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH', operationId: 'after-delete',
        records: [createTestPlainBlockRecord('b1')] });
      assert.equal(translated.ok, false);
      assert.match(translated.error.message, /API key is not set/);
    },
  },
  {
    name: 'installation normalization cannot overwrite an overlapping user save',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      const { worker, send } = createSettingsWorker({
        settings: { model: 'initial-model', inlineAutoShow: true },
        async set() { if (++writes === 1) { started(); await gate; } },
        chrome: { sidePanel: { setPanelBehavior: async () => {} } },
      });
      const install = worker.handlers.onInstalled();
      await ready;
      const save = send({ type: 'SAVE_SETTINGS', settings: { model: 'user-model' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await install;
      assert.deepEqual(await save, { ok: true });
      const result = await send({ type: 'GET_SETTINGS' });
      assert.equal(result.settings.model, 'user-model');
      assert.equal(result.settings.buttonVisibility, 'allPages');
    },
  },
  ...['get', 'set'].map((failure) => ({
    name: `settings ${failure} failure stays private and does not retry or block the next save`,
    async fn() {
      let fail = true;
      let attempts = 0;
      const { send } = createSettingsWorker({
        settings: { model: 'initial', apiKey: 'sk-synthetic' },
        async [failure]() {
          attempts += 1;
          if (fail) { fail = false; throw new Error('Storage rejected sk-synthetic'); }
        },
      });
      const first = send({ type: 'SAVE_SETTINGS', settings: { model: 'failed' } });
      const second = send({ type: 'SAVE_SETTINGS', settings: { tone: 'formal' } });
      const [failed, saved] = await Promise.all([first, second]);
      assert.equal(failed.ok, false);
      assert.doesNotMatch(JSON.stringify(failed), /sk-synthetic/);
      assert.deepEqual(saved, { ok: true });
      assert.equal(attempts, 2);
      const result = await send({ type: 'GET_SETTINGS' });
      assert.equal(result.settings.model, 'initial');
      assert.equal(result.settings.tone, 'formal');
      assert.equal(result.settings.apiKey, '***');
    },
  })),
  {
    name: 'registration failure leaves settings saved and public reads conceal storage errors',
    async fn() {
      let failRead = false;
      const { send } = createSettingsWorker({
        get: async () => { if (failRead) throw new Error('sk-synthetic'); },
        chrome: {
          permissions: { contains: async () => true },
          scripting: { registerContentScripts: async () => { throw new Error('registration failure'); } },
        },
      });
      assert.deepEqual(await send({ type: 'SAVE_SETTINGS', settings: { model: 'saved', buttonVisibility: 'allPages' } }), { ok: true });
      assert.equal((await send({ type: 'GET_SETTINGS' })).settings.model, 'saved');
      failRead = true;
      const response = await send({ type: 'GET_SETTINGS' });
      assert.equal(response.ok, false);
      assert.doesNotMatch(JSON.stringify(response), /sk-synthetic/);
    },
  },
  {
    // The platform contract, and the reason every check below can name the namespaces its
    // path touches and be believed: what a worker was handed is all it can reach. There is
    // no global scope behind it, so a namespace left out of a platform is not quietly
    // supplied by the one this suite happens to run in — the call fails saying which piece
    // it was built without. Before that, a worker built with no network made this suite's
    // one real request to api.openai.com, and a worker built with no `chrome` read whatever
    // `global.chrome` a check in another file had left behind.
    //
    // This is the whole reason the platform is an argument, so it is asserted rather than
    // assumed. Restoring either fallback fails here and nowhere else.
    name: 'reaches no platform beyond the one it was constructed with',
    async fn() {
      const worker = helpers.createBackgroundWorker();

      await assert.rejects(
        () => worker.requestTranslation({
          apiKey: 'sk-test',
          model: 'gpt-5.4-mini',
          instructions: 'Translate.',
          input: 'Hello world.',
        }),
        /built without a network/
      );
      await worker.handlers.onCommand('translate-inline');
      await assert.rejects(
        () => worker.sendInlineInstruction(11, 'translate'),
        /built without chrome/
      );

      // Nor is there a worker to reach without building one. Eleven of the functions this
      // module exported were an instance's, backed by one built at import against whatever
      // global scope it found — the same fallback, in the one place no check could hand a
      // platform to instead. So the export surface is stated whole rather than by the names
      // that left it: everything below either builds a worker or only reasons, and an export
      // arriving here that needs a platform is an ambient worker come back.
      assert.deepEqual(Object.keys(helpers).sort(), [
        'INLINE_TRANSLATION_SHORTCUT_COMMAND',
        'classifyContentScriptFailure',
        'createBackgroundWorker',
        'describeInlineTranslationControlFailure',
        'getInlineContentScriptFiles',
        'mergeVisibleBatchSettingsSnapshot',
        'normalizeMaxOutputTokens',
        'planInlineTranslationControl',
        'safeError',
        'sanitizePublicTabState',
      ]);
    },
  },
  {
    name: 'public tab state exposes sanitized Inline errors and freshness metadata only',
    fn() {
      const state = helpers.sanitizePublicTabState({
        inlineTranslationError: { message: 'bounded', code: 'document.unavailable', secret: 'secret' },
        documentId: 'document-42', workerEpoch: 'worker-fixture', stateSequence: 3, updatedAt: 'fixture-time',
        extracted: { contentMarkdown: 'private source' }, translated: 'private answer',
        settingsUsed: { apiKey: 'secret' }, progress: { current: 1, total: 2 },
        error: { message: 'removed article error' }, bodyVersion: 4, arbitraryPatchSibling: 'secret',
      });
      assert.deepEqual(state, {
        inlineTranslationError: { message: 'bounded', code: 'document.unavailable' },
        updatedAt: 'fixture-time', workerEpoch: 'worker-fixture', stateSequence: 3, documentId: 'document-42',
      });
      assert.doesNotMatch(JSON.stringify(state), /secret|private|article/);
    },
  },
  {
    name: 'merges visible batch settings snapshot without accepting api key',
    fn() {
      const settings = helpers.mergeVisibleBatchSettingsSnapshot(
        {
          apiKey: 'sk-current',
          chunkMaxChars: 9000,
          buttonVisibility: 'allPages',
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          viewMode: 'translation',
        },
        {
          apiKey: 'sk-from-content',
          chunkMaxChars: 24000,
          buttonVisibility: 'never',
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          viewMode: 'bilingual',
        }
      );

      assert.equal(settings.apiKey, 'sk-current');
      assert.equal(Object.hasOwn(settings, 'chunkMaxChars'), false);
      assert.equal(settings.buttonVisibility, 'allPages');
      assert.equal(Object.hasOwn(settings, 'viewMode'), false);
      assert.equal(settings.targetLanguage, 'Japanese');
      assert.equal(settings.tone, 'natural');
      assert.equal(settings.model, 'gpt-5.4');
      assert.equal(settings.reasoningEffort, 'low');
    },
  },
  {
    name: 'sends reasoning none in Responses API requests',
    async fn() {
      const { requestBody, output } = await runTranslationRequest({
        apiKey: 'sk-test',
        model: 'gpt-5.4-mini',
        instructions: 'Translate.',
        input: 'Hello.',
      });

      assert.equal(output, '번역 결과');
      assert.deepEqual(requestBody.reasoning, { effort: 'none' });
      assert.equal(requestBody.max_output_tokens, 8192);
      assert.equal(requestBody.store, false);
    },
  },
  {
    name: 'allows a lower output token cap for small translation batches',
    async fn() {
      const { requestBody } = await runTranslationRequest({
        apiKey: 'sk-test',
        model: 'gpt-5.4-mini',
        instructions: 'Translate.',
        input: 'Hello.',
        maxOutputTokens: 2048,
      });

      assert.equal(requestBody.max_output_tokens, 2048);
    },
  },
  {
    // Ranked hypotheses, each changed one boundary at a time:
    // 1. Request assembly dropped an id — falsified: the body still lists all eight.
    // 2. Response text collection truncated JSON — falsified at parseCompletedResponse.
    // 3. The validator mis-codes another protocol failure as missing_id — falsified
    //    by the protocol-shape table in inline-model-execution.test.js.
    // 4. Duplicate request ids shrink the expected set — never reaches validation;
    //    normalizeSourceBatch refuses them first.
    // 5. The structured-output schema does not name the batch length, so a
    //    completed response may legally omit ids — confirmed: minItems and
    //    maxItems now equal the batch size. A mock fetch still bypasses that
    //    constraint, which is why this check can still go red on the original
    //    missing-id symptom.
    // Smallest load-bearing shape is one requested record whose translations
    // array lacks that id (see inline-model-execution.test.js); eight is the
    // reported size.
    name: 'fails an eight-block batch when one completed translation id is omitted',
    async fn() {
      const records = Array.from({ length: 8 }, (_, index) =>
        createTestPlainBlockRecord(`b1-${index + 1}`)
      );
      const stored = {};
      let requestBody = null;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        fetch: async (_url, options) => {
          requestBody = JSON.parse(options.body);
          const requested = JSON.parse(requestBody.input).records.map((record) => record.id);
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: requested.slice(0, -1).map((id) => ({
                  id,
                  template: '번역문입니다.',
                })),
              }));
            },
          };
        },
      });

      await assert.rejects(
        worker.translateVisibleBlockBatch(records),
        (error) => error.code === 'protocol.missing_id'
      );

      const requestedIds = JSON.parse(requestBody.input).records.map((record) => record.id);
      assert.deepEqual(requestedIds, records.map((record) => record.id));
      const translationsSchema = requestBody.text.format.schema.properties.translations;
      assert.equal(translationsSchema.minItems, 8);
      assert.equal(translationsSchema.maxItems, 8);
      const failedRun = Object.values(stored).find((value) => value?.outcome === 'failed');
      assert.equal(failedRun.summary.attemptedBlocks, 8);
      assert.equal(failedRun.summary.failedBlocks, 8);
      assert.equal(failedRun.summary.modelRequestAttempts, 1);
      assert.equal(failedRun.blocks[0].terminalCode, 'protocol.missing_id');
      assert.equal(failedRun.blocks[0].timeline[0].stage, 'initial_validation');
    },
  },
  {
    name: 'records one model request attempt for an initial batch of several Semantic Blocks',
    async fn() {
      const stored = {};
      const records = ['a', 'b', 'c'].map((id) => {
        const record = createTestPlainBlockRecord(id);
        record.template = 'Hello world.';
        return record;
      });
      let calls = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        crypto: globalThis.crypto,
        fetch: async () => {
          calls += 1;
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: records.map((record) => ({
                  id: record.id,
                  template: '한국어 문장입니다.',
                })),
              }));
            },
          };
        },
      });

      const results = await worker.translateVisibleBlockBatch(records);
      const run = Object.values(stored).find((value) => value?.outcome === 'done');

      assert.equal(calls, 1);
      assert.equal(results.length, 3);
      assert.ok(results.every((result) => result.disposition === 'apply'));
      assert.equal(run.summary.attemptedBlocks, 3);
      assert.equal(run.summary.translatedBlocks, 3);
      assert.equal(run.summary.translatedWithWarningBlocks, 0);
      assert.equal(run.summary.failedBlocks, 0);
      assert.equal(run.summary.changedBlocks, 0);
      assert.equal(run.summary.repairAttemptedBlocks, 0);
      assert.equal(run.summary.modelRequestAttempts, 1);
      assert.equal(
        run.summary.attemptedBlocks,
        run.summary.translatedBlocks +
          run.summary.translatedWithWarningBlocks +
          run.summary.failedBlocks +
          run.summary.changedBlocks
      );
    },
  },
  {
    name: 'rejects duplicate block ids with different sources before any model request',
    async fn() {
      let requests = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        fetch: async () => {
          requests += 1;
          return { ok: true, async json() {
            return createCompletedResponse(JSON.stringify({ translations: [{ id: 'duplicate', template: '번역문입니다.' }] }));
          } };
        },
      });
      const records = [
        { ...createTestPlainBlockRecord('duplicate'), template: 'The first source sentence.' },
        { ...createTestPlainBlockRecord('duplicate'), template: 'The second source sentence.' },
      ];
      await assert.rejects(worker.translateVisibleBlockBatch(records), /Duplicate inline block record id: duplicate/);
      assert.equal(requests, 0);
    },
  },
  {
    name: 'normalizes block records without allowing DOM attributes',
    fn() {
      const record = createBlockApiRecord();
      const normalized = requestPreparation.normalizeSourceBatch([record]);

      assert.equal(normalized.length, 1);
      assert.equal(normalized[0].id, 'b1');
      assert.equal(normalized[0].template, record.template);
      assert.deepEqual(normalized[0].atoms, record.atoms);
      assert.deepEqual(normalized[0].contract, record.contract);
      assert.equal(normalized[0].repair, null);
      assert.equal(
        requestPreparation.measureRecord(normalized[0]).actualCost,
        record.template.length +
          JSON.stringify(record.atoms).length +
          JSON.stringify(null).length
      );

      assert.throws(
        () =>
          requestPreparation.normalizeSourceBatch([
            {
              ...record,
              atoms: [{ ...record.atoms[0], href: 'https://example.com' }],
            },
          ]),
        /Unexpected atom field/
      );
      assert.throws(
        () =>
          requestPreparation.normalizeSourceBatch([
            {
              ...record,
              repair: { attempt: 2, previousErrorCode: 'token_missing' },
            },
          ]),
        /repair attempt/
      );
    },
  },
  {
    name: 'enforces semantic block record and batch budgets',
    fn() {
      const record = createBlockApiRecord();
      const oversized = {
        ...record,
        template: `${'x'.repeat(12000)}${record.template}`,
        contract: { ...record.contract, maxOutputChars: 48000 },
      };

      assert.throws(
        () => requestPreparation.normalizeSourceBatch([oversized]),
        /block record is too large/i
      );
      const plainFixture = createTestPlainBlockRecord();
      assert.throws(
        () =>
          requestPreparation.normalizeSourceBatch(
            Array.from({ length: 501 }, (_item, index) => ({
              ...plainFixture,
              id: `b${index + 1}`,
            }))
          ),
        /Too many semantic blocks/
      );
    },
  },
  {
    // The worker used to carry an `assertInlineBlockSessionBudget` and a 60,000-character
    // `INLINE_BLOCK_MAX_SESSION_COST` that nothing called, and this suite's green check on
    // them was the only thing making them look live. ADR-0003 gave the session cap to the
    // content script, where `tests/content-helpers.test.js` checks it holds. What kept the
    // pair out until now was a read of `background.js`'s own source text for their two
    // names, because a worker that found its platform by name offered nothing else to ask:
    // an assert kept out of `module.exports` was invisible to any assertion about the
    // module. A worker is built now, so the guarantee is stated as behaviour instead — one
    // worker translates six batches that cost more together than the retired cap, and every
    // one of them is translated. A session cap re-added anywhere on this path fails here,
    // whether it is a module constant, this instance's own accounting, or exported at all.
    //
    // Six batches rather than one over-long one, because the per-batch and per-record caps
    // of 12,000 are real and stay. It is the session across batches that the worker does not
    // account for, and one worker is what makes these six batches one session.
    name: 'leaves the Semantic Block session cap to the content script',
    async fn() {
      const RETIRED_SESSION_COST_CAP = 60000;
      // Just under the 12,000-character record cap, so six batches cost past the retired one
      // together and no single batch is refused for a reason this check is not about.
      const template = `Hello world. ${'word '.repeat(2377)}`.trim();
      // One block per batch, under the same id every time: ids are unique within a batch, and
      // six batches that differ in nothing but being six is exactly the subject here.
      const record = {
        id: 'b1',
        template,
        atoms: [],
        contract: {
          codecVersion: 1,
          namespace: 'CAT_SESSION',
          entries: [],
          // What the codec would have written for a template this long, so the answer below
          // is not refused for overrunning a contract the page never would have sent.
          maxOutputChars: Math.min(48000, Math.max(2000, template.length * 4)),
          requiresText: true,
        },
        repair: null,
      };
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        // Every batch below signs a fingerprint per block and mints a correlation token, so
        // a worker driving this path needs the crypto for both. Node's own is handed over
        // rather than a stand-in: what these checks care about is that the run is written
        // and correlated, not what the signature comes out as.
        crypto: globalThis.crypto,
        // In the target language the settings name, so every batch below is applied on its
        // merits rather than repaired for saying nothing Korean.
        fetch: async () => ({ ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [{ id: record.id, template: `한국어 문장입니다. ${'단어 '.repeat(200)}`.trim() }],
        })); } }),
      });

      let spent = 0;
      for (let batch = 1; batch <= 6; batch += 1) {
        spent += requestPreparation.measureRecord(record).actualCost;

        const [result] = await worker.translateVisibleBlockBatch([record]);

        assert.equal(
          result.disposition,
          'apply',
          `batch ${batch} was refused ${spent} characters into the session`
        );
      }

      // The batches only say something about the retired cap if they cost more than it did.
      assert.ok(
        spent > RETIRED_SESSION_COST_CAP,
        `six batches cost ${spent} characters, under the retired ${RETIRED_SESSION_COST_CAP}`
      );
    },
  },
  {
    name: 'rejects repaired non-Korean output without exposing block internals',
    async fn() {
      const record = createBlockApiRecord();
      const requestBodies = [];
      const worker = helpers.createBackgroundWorker({
        // Session storage that refuses the write is what leaves this batch with no
        // correlation token to hand back: the tokens are minted into it, and a batch that
        // cannot record where a block came from does not offer the page one to report under.
        // Everything else about the platform is whole, so that refusal is the only thing the
        // absent token can be blamed on - the diagnostics run itself is written and readable.
        chrome: createBlockBatchChrome({
          settings: {
            apiKey: 'sk-test',
            model: 'gpt-5.4-mini',
            reasoningEffort: 'none',
            targetLanguage: 'Korean',
            tone: 'technical',
          },
          session: {
            async get() { return {}; },
            async set() { throw new Error('session unavailable'); },
          },
        }),
        crypto: globalThis.crypto,
        fetch: async (_url, options) => {
          requestBodies.push(JSON.parse(options.body));
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: [{ id: record.id, template: record.template }],
              }));
            },
          };
        },
      });

      const results = await worker.translateVisibleBlockBatch([record]);
      const input = JSON.parse(requestBodies[1].input);

      assert.equal(results[0].correlationToken, undefined);
      const result = results[0];
      assert.equal(result.disposition, 'reject');
      assert.equal('template' in result, false);
      assert.equal(result.terminalCode, 'quality.target_language_missing');
      assert.equal(requestBodies.length, 2);
      assert.equal(input.records[0].contract, undefined);
      assert.equal(input.records[0].atoms[0].href, undefined);
      assert.equal(requestBodies[1].text.format.name, 'inline_block_translations');
      assert.equal(requestBodies[1].max_output_tokens, 4096);
    },
  },
  {
    name: 'loads the semantic block codec before the content script',
    fn() {
      assert.deepEqual(helpers.getInlineContentScriptFiles(), [
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
      ]);
    },
  },
  {
    // The correlation token a batch hands back has to outlive the worker that minted it: the
    // DOM outcome it is reported under arrives after the service worker has been allowed to
    // sleep and come back up. So this drives one worker to get a token and a second one,
    // built on the same platform, to answer for it — which is what an MV3 restart is, and it
    // says so directly: the second worker starts with none of the first one's instance state
    // and only what session storage kept.
    name: 'handles semantic block viewport translation messages',
    async fn() {
      const record = createBlockApiRecord();
      const stored = {};
      // Already in session storage before either worker starts, and never referenced again.
      // Every field a run is stamped with has to come from what the worker itself wrote about
      // the block it translated, so a planted entry claiming otherwise has to go unread.
      const sessionStored = {
        'inlineRuntimeCorrelations:v1': {
          '00000000-0000-4000-8000-000000000000': {
            expiresAt: Date.now() + 60000,
            runId: 'run-1-bad',
            diagnosticId: 'run-1-bad/b1',
            sourceFingerprint: 'raw secret must not persist',
            contractFingerprint: 'raw source must not persist',
            model: 'gpt-5.4-mini',
            targetLanguageCode: 'ko',
            extensionVersion: 'test',
            tabId: 7,
            operationId: 42,
          },
        },
      };

      // Session storage is what makes the restart below mean anything: a worker that has one
      // keeps its correlations there rather than in the map it loses on the way down.
      const chrome = createBlockBatchChrome({
        stored,
        settings: {
          apiKey: 'sk-test',
          model: 'ft:gpt_custom/model',
          reasoningEffort: 'none',
          targetLanguage: 'Japanese',
          tone: 'technical',
        },
        session: {
          async get(keys) {
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(sessionStored, key)) result[key] = sessionStored[key];
            }
            return result;
          },
          async set(values) { Object.assign(sessionStored, values); },
        },
      });
      const platform = {
        chrome,
        crypto: globalThis.crypto,
        fetch: async () => ({
          ok: true,
          async json() {
            return createCompletedResponse(JSON.stringify({
              translations: [{ id: record.id, template: record.template }],
            }));
          },
        }),
      };
      // Every message here comes from the page, so every one of them carries the tab the
      // correlation is scoped to. A token answered under any other tab is refused.
      const sender = { tab: { id: 7 } };

      const worker = helpers.createBackgroundWorker(platform);
      const [batchResponse] = await collectWorkerResponses(worker, [{
        type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
        operationId: 42,
        records: [record],
      }], sender);

      assert.equal(batchResponse.ok, true);
      const translated = batchResponse.results[0];
      assert.equal(translated.id, record.id);
      assert.equal(typeof translated.correlationToken, 'string');

      // The MV3 service-worker restart between the translation and the DOM outcome: a second
      // construction on the same platform. It has its own empty correlation map and its own
      // per-tab state, so anything it answers below it read back out of session storage.
      const restarted = helpers.createBackgroundWorker(platform);

      const [runtimeResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
        operationId: 42,
        outcomes: [{
          code: 'runtime.apply_failed',
          correlationToken: translated.correlationToken,
          diagnosticCorrelation: {
            sourceFingerprint: 'must not persist forged fingerprint',
            model: 'must not persist forged model',
            extensionVersion: 'must not persist forged version',
          },
          source: 'must not persist',
          template: 'must not persist',
        }],
      }], sender);

      assert.deepEqual(runtimeResponse, { ok: true });
      const runtimeRun = Object.values(stored).find((value) =>
        value?.blocks?.[0]?.terminalCode === 'runtime.apply_failed'
      );
      assert.equal(runtimeRun.model, 'ft:gpt_custom/model');
      assert.equal(runtimeRun.targetLanguageCode, '');
      assert.match(runtimeRun.blocks[0].parentRunId, /^run-/);
      assert.match(runtimeRun.blocks[0].parentDiagnosticId, /^run-.*\/b1$/);
      assert.match(runtimeRun.blocks[0].sourceFingerprint, /^hmac-sha256:/);
      assert.equal(JSON.stringify(runtimeRun).includes('must not persist'), false);
      assert.equal(runtimeRun.summary.attemptedBlocks, 1);
      assert.equal(runtimeRun.summary.failedBlocks, 1);
      assert.equal(runtimeRun.summary.changedBlocks, 0);
      assert.equal(runtimeRun.summary.modelRequestAttempts, null);
      assert.equal('requested' in runtimeRun.summary, false);

      const [replayResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
        operationId: 42,
        outcomes: [{ code: 'runtime.apply_failed', correlationToken: translated.correlationToken }],
      }], sender);
      assert.deepEqual(replayResponse, { ok: false });

      const bulkEntries = {};
      const bulkOutcomes = [];
      for (let index = 0; index < 500; index += 1) {
        const token = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        bulkEntries[token] = {
          expiresAt: Date.now() + 60000,
          runId: 'run-123-bulk',
          diagnosticId: `run-123-bulk/b${index}`,
          sourceFingerprint: `hmac-sha256:${'A'.repeat(43)}`,
          contractFingerprint: `hmac-sha256:${'B'.repeat(43)}`,
          model: 'gpt-5.4-mini',
          targetLanguageCode: 'ko',
          extensionVersion: 'test',
          tabId: 7,
          operationId: 99,
        };
        bulkOutcomes.push({ code: 'runtime.apply_failed', correlationToken: token });
      }
      sessionStored['inlineRuntimeCorrelations:v1'] = bulkEntries;
      const [bulkResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
        operationId: 99,
        outcomes: bulkOutcomes,
      }], sender);
      assert.deepEqual(bulkResponse, { ok: true });
      const bulkRun = Object.values(stored).find((value) => value?.summary?.failedBlocks === 500);
      assert.equal(bulkRun.blocks.length, 100);
      assert.equal(Object.keys(sessionStored['inlineRuntimeCorrelations:v1']).length, 0);

      const [localResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
        operationId: 123,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [
          {
            code: 'runtime.block_too_large',
            template: 'x'.repeat(8000),
            contract: {
              codecVersion: 1,
              literalTokens: Array.from({ length: 24 }, (_, index) => ({
                value: `${index}-${'y'.repeat(195)}`,
                count: 1,
              })),
            },
          },
          {
            code: 'runtime.block_too_large',
            template: record.template,
            contract: record.contract,
            evidence: { recordCost: 13000, limit: 12000, raw: 'ignored' },
          },
        ],
      }], sender);
      assert.deepEqual(localResponse, { ok: true });
      const localRun = Object.values(stored).find((value) =>
        value?.blocks?.[0]?.terminalCode === 'runtime.block_too_large'
      );
      assert.equal(localRun.summary.attemptedBlocks, 1);
      assert.equal(localRun.blocks[0].quality.evidence.recordCost, 13000);
      assert.equal(localRun.blocks[0].quality.evidence.limit, 12000);
      // A diagnostics module of this check's own, built with the same crypto and reading
      // through the same Chrome, arrives at the same fingerprints: the installation secret
      // is what Chrome kept rather than what either construction happened to hold.
      const expectedFingerprints = await require('../extension/translation-diagnostics.js')
        .createTranslationDiagnostics(globalThis.crypto)
        .fingerprintBlock(chrome, record.template, record.contract);
      assert.equal(localRun.blocks[0].sourceFingerprint, expectedFingerprints.sourceFingerprint);
      assert.equal(localRun.blocks[0].contractFingerprint, expectedFingerprints.contractFingerprint);
      assert.equal(JSON.stringify(localRun).includes(record.template), false);

      const [duplicateResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
        operationId: 123,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [{
          code: 'runtime.block_too_large',
          template: record.template,
          contract: record.contract,
          evidence: { recordCost: 13000, limit: 12000 },
        }],
      }], sender);
      assert.deepEqual(duplicateResponse, { ok: true });
      const localRunId = 'local-7-123-11111111-1111-4111-8111-111111111111';
      assert.equal(stored['inlineDiagnostics:v3:index'].filter((id) => id === localRunId).length, 1);
      assert.equal(Object.keys(stored).filter((key) => key === `inlineDiagnostics:v3:run:${localRunId}`).length, 1);

      const [conflictResponse] = await collectWorkerResponses(restarted, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
        operationId: 123,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [{
          code: 'runtime.session_too_large',
          evidence: { sessionCost: 60000, limit: 60000 },
        }],
      }], sender);
      assert.deepEqual(conflictResponse, { ok: false });
      assert.equal(stored[`inlineDiagnostics:v3:run:${localRunId}`].blocks[0].terminalCode, 'runtime.block_too_large');
    },
  },
  {
    name: 'records a local preflight rejection in v3 count units',
    async fn() {
      const stored = {};
      let fetchCount = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        crypto: globalThis.crypto,
        fetch: async () => {
          fetchCount += 1;
          throw new Error('model must not be reached');
        },
      });

      const [response] = await collectWorkerResponses(worker, [{
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: '22222222-2222-4222-8222-222222222222',
        operationId: 7,
        settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
        diagnostics: [{
          code: 'runtime.unsupported_block',
          localRejection: {
            reason: 'nested_semantic_block',
            tag: 'P',
            source: 'Nested paragraph text.',
            selector: 'li > p',
          },
        }, {
          code: 'runtime.block_too_large',
          evidence: { recordCost: 13000, limit: 12000 },
        }, {
          code: 'runtime.session_too_large',
          evidence: { sessionCost: 150000, limit: 150000 },
        }],
      }], { tab: { id: 3 } });

      assert.deepEqual(response, { ok: true });
      assert.equal(fetchCount, 0);
      const run = stored['inlineDiagnostics:v3:run:local-3-7-22222222-2222-4222-8222-222222222222'];
      assert.equal(run.summary.attemptedBlocks, 3);
      assert.equal(run.summary.failedBlocks, 3);
      assert.equal(run.summary.modelRequestAttempts, 0);
      assert.equal(run.blocks.length, 3);
      assert.deepEqual(run.blocks.map(block => block.timeline[0].stage), [
        'local_preflight', 'local_preflight', 'local_preflight',
      ]);
      assert.deepEqual(run.blocks[0].localRejection, {
        reason: 'nested_semantic_block',
        tag: 'P',
      });
      assert.equal(JSON.stringify(run).includes('Nested paragraph text.'), false);
      assert.equal(JSON.stringify(run).includes('li > p'), false);
    },
  },
  {
    // The text-node path outlived its only caller for 62 commits because nothing asserted
    // that a retired name stays retired. Every message the text-node path used is listed
    // here, so reviving one half of it fails loudly instead of sitting in the tree.
    //
    // A worker with nothing but a network is the point rather than an economy: each of these
    // messages has to be turned away before anything is reached, so an answer that took any
    // other path would fail on the namespace it went looking for instead of quietly passing.
    name: 'does not answer any retired text-node translation message',
    async fn() {
      let fetchCount = 0;
      const worker = helpers.createBackgroundWorker({
        fetch: async () => {
          fetchCount += 1;
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: [{ id: 'n1', translation: '안녕하세요.' }],
              }));
            },
          };
        },
      });

      const retiredMessages = [
        {
          type: 'TRANSLATE_TEXT_NODES',
          records: [{ id: 'n1', text: 'Hello world.' }],
        },
        {
          type: 'TRANSLATE_VISIBLE_TEXT_BATCH',
          records: [{ id: 'v1', text: 'Hello world.' }],
          settingsSnapshot: null,
        },
        {
          type: 'INLINE_TRANSLATION_PROGRESS',
          operationId: 1,
          progress: { stage: 'queued', recordCount: 1, chunkCount: 1 },
        },
      ];

      // One message at a time, because the assertion names the message it failed on and three
      // identical answers collected together could only be matched back to it by position.
      for (const message of retiredMessages) {
        const [response] = await collectWorkerResponses(worker, [message]);

        assert.deepEqual(
          response,
          { ok: false, error: { message: 'Unknown message' } },
          `${message.type} is answered again`
        );
      }

      assert.equal(fetchCount, 0);
    },
  },
  {
    name: 'isolates a malformed repair response and preserves its protocol code',
    async fn() {
      const first = createBlockApiRecord('first');
      const second = createBlockApiRecord('second');
      const firstTranslation = first.template
        .replace('Reasoning models', '추론 모델')
        .replace(' like ', '와 같은 ')
        .replace(' use internal reasoning tokens.', '은 내부 추론 토큰을 사용합니다.');
      let call = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        crypto: globalThis.crypto,
        fetch: async () => {
          call += 1;
          if (call === 2) {
            return { ok: true, async json() { return createCompletedResponse('{invalid'); } };
          }
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [
              { id: first.id, template: firstTranslation },
              { id: second.id, template: second.template },
            ],
          })); } };
        },
      });

      const results = await worker.translateVisibleBlockBatch([first, second]);
      assert.equal(results.find((result) => result.id === first.id).disposition, 'apply');
      assert.equal(results.find((result) => result.id === second.id).terminalCode, 'protocol.invalid_json');
    },
  },
  {
    // The content script charges the Session Budget a second time for a block whose
    // `attemptCount` comes back as 2, so this field is what a repair request costs the
    // reader. It is produced here, and until now it was only ever asserted where it is
    // consumed — the shape of failure ADR-0003 was written about.
    name: 'reports the second real request a repair makes as attemptCount 2',
    async fn() {
      const repaired = createTestPlainBlockRecord('needs-repair');
      repaired.template = 'Hello world.';
      const clean = createTestPlainBlockRecord('first-time');
      clean.template = 'Hello world.';

      const repairStored = {};
      let repairCalls = 0;
      const repairWorker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored: repairStored }),
        crypto: globalThis.crypto,
        fetch: async () => {
          repairCalls += 1;
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [{
              id: repaired.id,
              template: repairCalls === 1 ? repaired.template : '한국어 문장입니다.',
            }],
          })); } };
        },
      });

      const repairedResults = await repairWorker.translateVisibleBlockBatch([repaired]);

      assert.equal(repairCalls, 2);
      assert.equal(repairedResults[0].disposition, 'apply');
      assert.equal(repairedResults[0].attemptCount, 2);
      const repairedRun = Object.values(repairStored).find((value) => value?.outcome === 'done');
      assert.equal(repairedRun.summary.attemptedBlocks, 1);
      assert.equal(repairedRun.summary.translatedBlocks, 1);
      assert.equal(repairedRun.summary.repairAttemptedBlocks, 1);
      assert.equal(repairedRun.summary.modelRequestAttempts, 2);

      // The control: one request, and nothing for the content script to charge twice. What
      // separates it from the case above is the answers, and the network a worker translates
      // against is fixed when the worker is built, so the control gets a worker of its own.
      let cleanCalls = 0;
      const cleanWorker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome(),
        crypto: globalThis.crypto,
        fetch: async () => {
          cleanCalls += 1;
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [{ id: clean.id, template: '한국어 문장입니다.' }],
          })); } };
        },
      });

      const cleanResults = await cleanWorker.translateVisibleBlockBatch([clean]);

      assert.equal(cleanCalls, 1);
      assert.equal(cleanResults[0].disposition, 'apply');
      assert.equal(cleanResults[0].attemptCount, 1);
    },
  },
  {
    name: 'counts one repair batch as one model request and each repaired Semantic Block once',
    async fn() {
      const stored = {};
      const first = createTestPlainBlockRecord('repair-a');
      const second = createTestPlainBlockRecord('repair-b');
      first.template = 'Hello world.';
      second.template = 'Hello world.';
      let calls = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        crypto: globalThis.crypto,
        fetch: async () => {
          calls += 1;
          const template = calls === 1 ? 'Hello world.' : '한국어 문장입니다.';
          return {
            ok: true,
            async json() {
              return createCompletedResponse(JSON.stringify({
                translations: [
                  { id: first.id, template },
                  { id: second.id, template },
                ],
              }));
            },
          };
        },
      });

      const results = await worker.translateVisibleBlockBatch([first, second]);
      const run = Object.values(stored).find((value) => value?.outcome === 'done');

      assert.equal(calls, 2);
      assert.ok(results.every((result) => result.disposition === 'apply'));
      assert.ok(results.every((result) => result.attemptCount === 2));
      assert.equal(run.summary.attemptedBlocks, 2);
      assert.equal(run.summary.translatedBlocks, 2);
      assert.equal(run.summary.repairAttemptedBlocks, 2);
      assert.equal(run.summary.modelRequestAttempts, 2);
    },
  },
  {
    name: 'counts a failed multi-block repair request while preserving the successful sibling',
    async fn() {
      const stored = {};
      const records = ['success', 'repair-a', 'repair-b'].map((id) => ({
        ...createTestPlainBlockRecord(id), template: 'Hello world.',
      }));
      const requests = [];
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        crypto: globalThis.crypto,
        fetch: async (_url, options) => {
          const request = JSON.parse(options.body);
          requests.push(request);
          if (requests.length === 2) {
            assert.deepEqual(JSON.parse(request.input).records.map(({ id }) => id), ['repair-a', 'repair-b']);
            throw new Error('repair network failed');
          }
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: records.map((record) => ({
              id: record.id,
              template: record.id === 'success' ? '성공한 번역입니다.' : record.template,
            })),
          })); } };
        },
      });
      const results = await worker.translateVisibleBlockBatch(records);
      assert.equal(requests.length, 2);
      assert.deepEqual(results.map(({ disposition, attemptCount }) => [disposition, attemptCount]), [
        ['apply', 1], ['reject', 2], ['reject', 2],
      ]);
      assert.equal(results[0].template, '성공한 번역입니다.');
      for (const result of results.slice(1)) {
        assert.equal(result.terminalCode, 'runtime.repair_request_failed');
        assert.equal(result.messageKey, 'repair_request_failed');
        assert.equal('template' in result, false);
      }
      assert.ok(results.every((result) => !Object.hasOwn(result, 'diagnostic')));
      const run = Object.values(stored).find((value) => value?.outcome === 'failed');
      assert.equal(run.summary.attemptedBlocks, 3);
      assert.equal(run.summary.translatedBlocks, 1);
      assert.equal(run.summary.failedBlocks, 2);
      assert.equal(run.summary.repairAttemptedBlocks, 2);
      assert.equal(run.summary.modelRequestAttempts, 2);
      for (const block of run.blocks.filter((block) => block.attemptCount === 2)) {
        assert.equal(block.timeline[1].stage, 'repair_validation');
        assert.equal(block.timeline[1].disposition, 'reject');
      }
    },
  },
  {
    name: 'persists repaired detail and falls back to compact final when fingerprints fail',
    async fn() {
      const stored = {};
      let record = createTestPlainBlockRecord('repair-success');
      record.template = 'Hello world.';
      let call = 0;
      // Fingerprinting fails here by handing the worker a crypto that stops signing, which
      // is the whole reason the diagnostics module is built with one: the same batch runs
      // twice against the same worker, once with a crypto that signs and once without, and
      // nothing outside this platform is touched to arrange it. Signing rather than key
      // import is what gives way, because a key already imported for this installation's
      // secret is cached and would never be asked for a second time.
      let signing = true;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        crypto: {
          getRandomValues: (bytes) => globalThis.crypto.getRandomValues(bytes),
          randomUUID: () => globalThis.crypto.randomUUID(),
          subtle: {
            importKey: (...args) => globalThis.crypto.subtle.importKey(...args),
            sign: (...args) => (signing
              ? globalThis.crypto.subtle.sign(...args)
              : Promise.reject(new Error('fingerprint unavailable'))),
          },
        },
        fetch: async () => {
          call += 1;
          return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
            translations: [{ id: record.id, template: call === 1 ? record.template : '한국어 문장입니다.' }],
          })); } };
        },
      });

      const detailedResults = await worker.translateVisibleBlockBatch([record]);
      const detailedRun = Object.values(stored).find((value) => value?.blocks?.length === 1);
      assert.equal(detailedResults[0].disposition, 'apply');
      assert.equal(detailedResults[0].diagnosticsUnavailable, undefined);
      assert.equal(detailedRun.outcome, 'done');
      assert.equal(detailedRun.blocks[0].terminalDisposition, 'apply');
      assert.equal(detailedRun.blocks[0].terminalCode, '');
      assert.equal(detailedRun.blocks[0].timeline[1].disposition, 'apply');

      record = createTestPlainBlockRecord('fingerprint-failure');
      record.template = 'Hello world.';
      call = 0;
      signing = false;
      const fallbackResults = await worker.translateVisibleBlockBatch([record]);
      const compactRun = Object.values(stored).find((value) =>
        value?.outcome === 'done' && Array.isArray(value.blocks) && value.blocks.length === 0
      );
      assert.equal(fallbackResults[0].disposition, 'apply');
      assert.equal(fallbackResults[0].diagnosticsUnavailable, true);
      assert.ok(compactRun);
    },
  },
  {
    // The borrow #46 left standing, stated as behaviour: a worker built with no crypto has
    // no fingerprints and no correlation token, and says so. Until the diagnostics module
    // was built with a crypto it would have found the global one instead and this batch
    // would have come back claiming diagnostics it never signed.
    name: 'reports diagnostics as unavailable to a worker built with no crypto',
    async fn() {
      const stored = {};
      const record = createTestPlainBlockRecord('no-crypto');
      record.template = 'Hello world.';
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        fetch: async () => ({ ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [{ id: record.id, template: '한국어 문장입니다.' }],
        })); } }),
      });

      const results = await worker.translateVisibleBlockBatch([record]);

      // The translation itself is untouched: diagnostics never change a valid result.
      assert.equal(results[0].disposition, 'apply');
      assert.equal(results[0].diagnosticsUnavailable, true);
      assert.equal(results[0].correlationToken, undefined);
      const run = Object.values(stored).find((value) => value?.outcome === 'done');
      assert.equal(run.blocks.length, 0);
    },
  },
  {
    name: 'names the model and the batch size in the run a failed request leaves behind',
    async fn() {
      const stored = {};
      const first = createTestPlainBlockRecord('failed-first');
      const second = createTestPlainBlockRecord('failed-second');
      first.template = 'Hello world.';
      second.template = 'Goodbye world.';
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({ stored }),
        fetch: async () => { throw new Error('network is down'); },
      });

      await assert.rejects(
        worker.translateVisibleBlockBatch([first, second]),
        /OpenAI request could not reach the service/
      );
      const failedRun = Object.values(stored).find((value) => value?.outcome === 'failed');
      assert.ok(failedRun, 'the failed request is written to diagnostics');
      assert.equal(failedRun.model, 'gpt-5.4-mini');
      assert.equal(failedRun.summary.attemptedBlocks, 2);
      assert.equal(failedRun.summary.failedBlocks, 2);
      assert.equal(failedRun.summary.modelRequestAttempts, 1);
    },
  },
  {
    name: 'records zero model request attempts when a batch fails before a request',
    async fn() {
      const stored = {};
      const record = createTestPlainBlockRecord('no-key');
      record.template = 'Hello world.';
      let calls = 0;
      const worker = helpers.createBackgroundWorker({
        chrome: createBlockBatchChrome({
          stored,
          settings: { ...BLOCK_BATCH_SETTINGS, apiKey: '' },
        }),
        fetch: async () => {
          calls += 1;
          throw new Error('network must not be reached');
        },
      });

      await assert.rejects(
        worker.translateVisibleBlockBatch([record]),
        /OpenAI API key is not set/
      );
      const failedRun = Object.values(stored).find((value) => value?.outcome === 'failed');
      assert.ok(failedRun, 'the pre-request failure is written to diagnostics');
      assert.equal(calls, 0);
      assert.equal(failedRun.summary.attemptedBlocks, 1);
      assert.equal(failedRun.summary.failedBlocks, 1);
      assert.equal(failedRun.summary.modelRequestAttempts, 0);
    },
  },
  {
    name: 'leaves model request attempts unproven on the interrupted preflight write',
    async fn() {
      const stored = {};
      const runWrites = [];
      const chrome = createBlockBatchChrome({ stored });
      const originalSet = chrome.storage.local.set;
      chrome.storage.local.set = async (values) => {
        await originalSet(values);
        for (const value of Object.values(values)) {
          if (value && typeof value === 'object' && value.outcome) {
            runWrites.push({
              outcome: value.outcome,
              modelRequestAttempts: value.summary?.modelRequestAttempts,
            });
          }
        }
      };
      const record = createTestPlainBlockRecord('preflight');
      record.template = 'Hello world.';
      const worker = helpers.createBackgroundWorker({
        chrome,
        crypto: globalThis.crypto,
        fetch: async () => ({
          ok: true,
          async json() {
            return createCompletedResponse(JSON.stringify({
              translations: [{ id: record.id, template: '한국어 문장입니다.' }],
            }));
          },
        }),
      });

      await worker.translateVisibleBlockBatch([record]);
      assert.equal(runWrites[0].outcome, 'interrupted');
      assert.equal(runWrites[0].modelRequestAttempts, null);
      assert.equal(runWrites.at(-1).outcome, 'done');
      assert.equal(runWrites.at(-1).modelRequestAttempts, 1);
    },
  },
  ...['never', 'onInvocation', 'allPages'].flatMap((buttonVisibility) =>
    ['action', 'command', 'pageLoad'].map((trigger) => ({
      name: `${trigger} honors ${buttonVisibility} Button Visibility through the worker entry`,
      async fn() {
        const { worker, calls, broadcasts, invoke } = createInvocationWorker({ buttonVisibility });
        if (trigger === 'pageLoad') {
          const responses = await collectWorkerResponses(worker, [{ type: 'GET_INLINE_STARTUP_INSTRUCTIONS' }]);
          assert.deepEqual(responses, [{ ok: true, instructions: buttonVisibility === 'allPages'
            ? ['mountFloatingTranslateButton'] : [] }]);
          assert.deepEqual(calls, [['settings']]);
        } else {
          await invoke(trigger);
          const messages = [
            { type: 'GET_INLINE_TRANSLATION_STATE' },
            { type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' },
          ];
          if (buttonVisibility !== 'never') messages.push({
            type: 'RUN_INLINE_INSTRUCTION', instruction: 'mountFloatingTranslateButton',
          });
          if (trigger === 'command') messages.push({
            type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation',
          });
          assert.deepEqual(calls, [
            ['open', { tabId: 4201 }], ['settings'],
            ['options', { tabId: 4201, path: 'sidepanel.html', enabled: true }],
            ['inject', { target: { tabId: 4201, documentIds: ['document-4201'] }, files: helpers.getInlineContentScriptFiles() }],
            ...messages.map((message) => ['message', 4201, message]),
          ]);
        }
        assert.deepEqual(broadcasts, []);
      },
    }))
  ),
  {
    name: 'page-load instructions honor migrated Button Visibility without invoking translation',
    async fn() {
      for (const inlineAutoShow of [false, true]) {
        const { worker, calls } = createInvocationWorker({ inlineAutoShow });
        assert.deepEqual(await collectWorkerResponses(worker, [
          { type: 'GET_INLINE_STARTUP_INSTRUCTIONS' },
        ]), [{ ok: true, instructions: inlineAutoShow ? ['mountFloatingTranslateButton'] : [] }]);
        assert.deepEqual(calls, [['settings']]);
      }
    },
  },
  {
    name: 'ignores unrelated shortcuts and a shortcut without its event tab under ADR0014',
    async fn() {
      const { worker, chrome, calls } = createInvocationWorker();
      await worker.handlers.onCommand('translate-current-tab');
      assert.deepEqual(calls, []);
      chrome.tabs.query = async () => [];
      await worker.handlers.onCommand('translate-inline');
      worker.handlers.onActionClicked({});
      assert.deepEqual(calls, []);
    },
  },
  {
    name: 'authorizes Inline Translation ahead of every control in the section',
    fn() {
      // A control in the Inline Translation Section is a deliberate reader gesture through
      // extension-owned UI a page cannot forge, so it grants the authorization rather than
      // requiring one. That is also what keeps a panel left open past the expiry working.
      assert.deepEqual(helpers.planInlineTranslationControl('start').steps, [
        'grantInlineTranslationAuthorization',
        'startInlineTranslation',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('stop').steps, [
        'grantInlineTranslationAuthorization',
        'stopInlineTranslation',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('restore').steps, [
        'grantInlineTranslationAuthorization',
        'restoreInlineOriginal',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('translateTab').steps, []);
      assert.deepEqual(helpers.planInlineTranslationControl().steps, []);
    },
  },
  {
    name: 'only asks the content script for section controls it can carry out',
    fn() {
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const control of ['start', 'stop', 'restore']) {
        for (const step of helpers.planInlineTranslationControl(control).steps) {
          assert.ok(
            understood.includes(step),
            `content script cannot run ${step}`
          );
        }
      }
    },
  },
  {
    name: 'stops a section control at the first step the tab refuses',
    async fn() {
      // Unlike an invocation, whose steps are independent, a control is one gesture: if
      // the authorization did not land, carrying on would run it unauthorized, and the
      // reader has to be told their click did nothing.
      const sent = [];
      const worker = helpers.createBackgroundWorker({ chrome: createPageChrome({ settings: {} }) });
      await assert.rejects(
        worker.runInlineTranslationControl(9, 'start', async (tabId, step) => {
          sent.push(`${step}:${tabId}`);
          throw new Error('Could not establish connection.');
        }),
        /Could not establish connection/
      );
      assert.deepEqual(sent, ['grantInlineTranslationAuthorization:9']);

      await assert.rejects(
        worker.runInlineTranslationControl(9, 'nonsense', async () => {}),
        /nonsense/
      );
    },
  },
  {
    name: 'treats an instruction the page refused as a failure, not a success',
    async fn() {
      // The content script answers whether it carried the instruction out, and it catches
      // its own throw to do so. A sender that read only the transport would report a
      // gesture the page declined as done, and the panel would render success.
      const refusingPage = helpers.createBackgroundWorker({
        chrome: {
          tabs: {
            async sendMessage() {
              return { ok: false, error: { message: 'no page to authorize' } };
            },
          },
        },
      });
      await assert.rejects(
        refusingPage.sendInlineInstruction(5, 'grantInlineTranslationAuthorization'),
        /no page to authorize/
      );

      const silentPage = helpers.createBackgroundWorker({
        chrome: { tabs: { async sendMessage() {} } },
      });
      await assert.rejects(
        silentPage.sendInlineInstruction(5, 'startInlineTranslation'),
        /startInlineTranslation/
      );
    },
  },
  {
    name: 'stops a control at the step the page refuses, before it runs unauthorized',
    async fn() {
      const sent = [];
      const chrome = {
        webNavigation: { async getFrame({ tabId }) { return { documentId: `document-${tabId}` }; } },
        tabs: {
          async sendMessage(tabId, message) {
            sent.push(message.instruction);
            return message.instruction === 'grantInlineTranslationAuthorization'
              ? { ok: false, error: { message: 'no page to authorize' } }
              : { ok: true };
          },
        },
      };
      const worker = helpers.createBackgroundWorker({ chrome });
      await assert.rejects(
        worker.runInlineTranslationControl(5, 'start'),
        /no page to authorize/
      );
      assert.deepEqual(sent, ['grantInlineTranslationAuthorization']);
    },
  },
  {
    name: 'tells the reader what to do when no content script answers a control',
    fn() {
      // Chrome's own answer names no action the reader can take, and the action they need
      // is the one the missing-access failure already asks for.
      const missingAccess = helpers.classifyContentScriptFailure(
        new Error('Cannot access contents of the page at url "https://example.com/"'),
        'https://example.com/'
      ).message;

      assert.equal(
        helpers.describeInlineTranslationControlFailure(
          new Error(
            'Could not establish connection. Receiving end does not exist.'
          )
        ),
        missingAccess
      );
      assert.match(
        helpers.describeInlineTranslationControlFailure(
          new Error('Unknown inline translation control: nonsense')
        ),
        /nonsense/
      );
      assert.ok(
        helpers.describeInlineTranslationControlFailure(null).length > 0
      );
    },
  },
  {
    name: 'shortcut continues ordinary preparation failures and reports only its refused start',
    async fn() {
      const { worker, chrome, calls, broadcasts, invoke } = createInvocationWorker({ buttonVisibility: 'onInvocation' });
      chrome.scripting.executeScript = async (options) => {
        calls.push(['inject', options]);
        throw new Error('Cannot access contents of the page');
      };
      chrome.tabs.sendMessage = async (tabId, message) => {
        calls.push(['message', tabId, message]);
        throw new Error('Could not establish connection. Receiving end does not exist.');
      };
      await invoke('command');
      assert.deepEqual(calls.filter(([kind]) => kind === 'message'), [
        ['message', 4201, { type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' }],
        ['message', 4201, { type: 'RUN_INLINE_INSTRUCTION', instruction: 'mountFloatingTranslateButton' }],
        ['message', 4201, { type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation' }],
      ]);
      assert.equal(broadcasts.length, 1);
      assert.match(broadcasts[0].state.inlineTranslationError.message, /Click the extension icon on this tab/);
      assert.equal(broadcasts[0].state.error, undefined);
      assert.deepEqual((await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201 }]))[0].state,
        broadcasts[0].state);
      broadcasts.length = 0;
      await invoke('action');
      assert.deepEqual(broadcasts, []);
    },
  },
  ...['grantInlineTranslationAuthorization', 'mountFloatingTranslateButton'].map((refusedInstruction) => ({
    name: `shortcut still starts after the page refuses ${refusedInstruction}`,
    async fn() {
      const { chrome, calls, broadcasts, invoke } = createInvocationWorker({ buttonVisibility: 'allPages' });
      const answer = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = async (tabId, message) => {
        const response = await answer(tabId, message);
        return message.instruction === refusedInstruction ? { ok: false } : response;
      };
      await invoke('command');
      assert.deepEqual(calls.at(-1), ['message', 4201,
        { type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation' }]);
      assert.deepEqual(broadcasts, []);
    },
  })),
  ...['start', 'action', 'control'].map((recovery) => ({
    name: `${recovery} clears a reported shortcut failure only after the page answers`,
    async fn() {
      const { worker, chrome, broadcasts, invoke } = createInvocationWorker();
      const answer = chrome.tabs.sendMessage;
      let refuseStart = true;
      chrome.tabs.sendMessage = async (tabId, message) => {
        const response = await answer(tabId, message);
        return message.instruction === 'startInlineTranslation' && refuseStart
          ? { ok: false, error: { message: 'Could not establish connection.' } } : response;
      };
      await invoke('command');
      assert.equal(broadcasts.length, 1);
      const inject = chrome.scripting.executeScript;
      chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page'); };
      await invoke('action');
      assert.equal(broadcasts.length, 1);
      if (recovery !== 'start') chrome.scripting.executeScript = inject;
      refuseStart = false;
      if (recovery === 'control') {
        assert.deepEqual(await collectWorkerResponses(worker, [
          { type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 4201, control: 'start' },
        ]), [{ ok: true }]);
      } else await invoke(recovery === 'start' ? 'command' : 'action');
      assert.equal(broadcasts.at(-1).state.inlineTranslationError, null);
      const count = broadcasts.length;
      await invoke('action');
      assert.equal(broadcasts.length, count);
    },
  })),
  {
    name: 'shortcut still starts when panel opening or tab-state reporting fails',
    async fn() {
      const { worker, chrome, calls, invoke } = createInvocationWorker();
      chrome.sidePanel.open = async () => { throw new Error('Panel unavailable'); };
      chrome.sidePanel.setOptions = async () => { throw new Error('Panel unavailable'); };
      chrome.runtime.sendMessage = () => { throw new Error('Cannot broadcast'); };
      const answer = chrome.tabs.sendMessage;
      chrome.tabs.sendMessage = async (tabId, message) => {
        const response = await answer(tabId, message);
        return message.instruction === 'startInlineTranslation' ? { ok: false } : response;
      };
      await invoke('command');
      assert.deepEqual(calls.at(-1), ['message', 4201,
        { type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation' }]);
      chrome.tabs.sendMessage = answer;
      await invoke('command');
      assert.deepEqual(calls.at(-1), ['message', 4201,
        { type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation' }]);
      assert.equal((await collectWorkerResponses(worker, [{ type: 'GET_STATE', tabId: 4201 }]))[0]
        .state.inlineTranslationError, null);
    },
  },
  {
    name: 'tells a reader without tab access to click the extension icon',
    fn() {
      // Chrome's wording when neither activeTab nor a host permission covers the tab.
      const classified = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
        ),
        'https://example.com/article'
      );
      assert.equal(classified.reason, 'missing_access');
      assert.match(classified.message, /extension icon/i);
      assert.doesNotMatch(classified.message, /chrome:\/\//i);
    },
  },
  {
    name: 'tells a reader on a page extensions cannot run on that the page is the problem',
    fn() {
      for (const [failure, url] of [
        [new Error('Cannot access a chrome:// URL'), ''],
        [
          new Error('Cannot access contents of url "chrome://settings/".'),
          '',
        ],
        [new Error('The extensions gallery cannot be scripted.'), ''],
        [
          new Error('Cannot access contents of the page.'),
          'https://chromewebstore.google.com/detail/abc',
        ],
        [new Error('Cannot access contents of the page.'), 'about:blank'],
      ]) {
        const classified = helpers.classifyContentScriptFailure(failure, url);
        assert.equal(
          classified.reason,
          'unsupported_page',
          `expected an unsupported page for: ${failure.message} @ ${url || '(unknown)'}`
        );
        assert.match(classified.message, /this page/i);
      }
    },
  },
  {
    name: 'does not read a refused scheme it has never heard of as missing access',
    fn() {
      // Chrome gives one generic sentence for nearly every page it refuses, so the scheme
      // it names is what separates them. Enumerating the refused schemes would mis-sort
      // every one left off the list; only the grantable shape — an ordinary web page — is
      // enumerable, and these are not it. An SSL interstitial is the everyday case.
      for (const refused of [
        'chrome-error://chromewebdata/',
        'data:text/html,hello',
        'blob:https://example.com/9a1f',
        'devtools://devtools/bundled/devtools_app.html',
      ]) {
        const classified = helpers.classifyContentScriptFailure(
          new Error(
            `Cannot access contents of url "${refused}". Extension manifest must request permission to access this host.`
          ),
          ''
        );
        assert.equal(
          classified.reason,
          'unsupported_page',
          `expected an unsupported page for ${refused}`
        );
      }
    },
  },
  {
    name: 'sends a reader blocked on a local file to the switch that unblocks it',
    fn() {
      // Neither of the two reasons fits: file access is grantable, but not by invoking the
      // extension on the page, so both other messages would send the reader nowhere.
      const classified = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access this host.'
        ),
        'file:///Users/reader/article.html'
      );
      assert.equal(classified.reason, 'file_access');
      assert.match(classified.message, /Allow access to file URLs/i);
    },
  },
  {
    name: 'never blames the page when access is the actual problem',
    fn() {
      // The message this replaces blamed chrome:// pages for every failure, which is what
      // sent the diagnosis behind the parent spec down the wrong path for two symptoms.
      const missingAccess = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of url "https://example.com/". Extension manifest must request permission to access this host.'
        ),
        'https://example.com/'
      );
      const unsupported = helpers.classifyContentScriptFailure(
        new Error('Cannot access a chrome:// URL'),
        'chrome://settings/'
      );
      assert.equal(missingAccess.reason, 'missing_access');
      assert.equal(unsupported.reason, 'unsupported_page');
      assert.notEqual(missingAccess.message, unsupported.message);
    },
  },
  {
    name: 'reports a failure it cannot classify as itself',
    fn() {
      // Guessing between the two known reasons is how the old message misled. An
      // unrecognised failure says what happened instead of picking one.
      const classified = helpers.classifyContentScriptFailure(
        new Error('Frame with ID 0 is showing error page'),
        'https://example.com/'
      );
      assert.equal(classified.reason, 'unknown');
      assert.match(classified.message, /Frame with ID 0 is showing error page/);

      // The address can be a navigation behind the failure, so it is only ever read once
      // Chrome has said it refused the page. On its own it settles nothing.
      const stale = helpers.classifyContentScriptFailure(
        new Error('The tab was closed.'),
        'about:blank'
      );
      assert.equal(stale.reason, 'unknown');

      const empty = helpers.classifyContentScriptFailure(null, '');
      assert.equal(empty.reason, 'unknown');
      assert.ok(empty.message.length > 0);
      assert.doesNotMatch(empty.message, /\[object Object\]/);
    },
  },
];

exports.tests.push(...['stop', 'restore', 'start'].map((control) => ({
  name: `discards a superseded control after Authorization waits for ${control}`,
  async fn() {
    const sent = [];
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const worker = helpers.createBackgroundWorker({ chrome: { webNavigation: { async getFrame({ tabId }) {
      return { documentId: `document-${tabId}` };
    } }, tabs: {
      sendMessage(tabId, message) {
        sent.push({ tabId, ...message });
        return sent.length === 1 ? waiting : Promise.resolve({ ok: true });
      },
    } } });
    function command(next) {
      return new Promise((resolve) => worker.handlers.onMessage({
        type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 9, documentId: 'document-9', control: next,
      }, {}, resolve));
    }
    const old = command('start');
    await require('./inline-translation-operation.test').flushMicrotasks();
    assert.deepEqual(await command(control), { ok: true });
    release({ ok: true });
    assert.deepEqual(await old, { ok: true });
    assert.deepEqual(sent, [
      { tabId: 9, type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' },
      { tabId: 9, type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' },
      { tabId: 9, type: 'RUN_INLINE_INSTRUCTION', instruction: {
        start: 'startInlineTranslation', stop: 'stopInlineTranslation', restore: 'restoreInlineOriginal',
      }[control] },
    ]);
  },
})));

exports.tests.push({
  name: 'Text Translation survives worker replacement with only allowlisted state and no automatic transport',
  async fn() {
    const values = {};
    const chrome = createBlockBatchChrome({ session: {
      async get(key) { return { [key]: structuredClone(values[key]) }; },
      async set(value) { Object.assign(values, structuredClone(value)); },
    } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    let requests = 0;
    const platform = { chrome, fetch() { requests += 1; throw new Error('Unexpected request'); } };
    const settings = { service: 'openai', model: 'retained-model', reasoningEffort: 'low',
      sourceLanguage: 'auto', targetLanguage: 'Korean', tone: 'natural' };
    const first = 'A'.repeat(8000) + '\n\n';
    const second = 'B'.repeat(8000);
    const state = { source: first + second, settings: { ...settings, apiKey: 'sk-forbidden' },
      openaiModel: 'retained-model', openaiReasoningEffort: 'low', apiKey: 'sk-forbidden',
      job: { source: first + second, settings, units: [first, second],
        results: [{ translation: '완료\n\n', sourceLanguage: 'English' }], status: 'running' } };
    const original = helpers.createBackgroundWorker(platform);
    assert.equal((await sendTextMessage(original, { type: 'GET_TEXT_TRANSLATION_STATE' })).ok, true);
    assert.equal((await sendTextMessage(original, { type: 'SAVE_TEXT_TRANSLATION_STATE', revision: 1, state })).ok, true);
    const replacement = helpers.createBackgroundWorker(platform);
    const restored = await sendTextMessage(replacement, { type: 'GET_TEXT_TRANSLATION_STATE' });
    assert.equal(restored.ok, true);
    assert.equal(restored.state.source, first + second);
    assert.equal(restored.state.job.status, 'stopped');
    assert.deepEqual(restored.state.job.results, [{ translation: '완료\n\n', sourceLanguage: 'English' }]);
    assert.equal(JSON.stringify(values).includes('sk-'), false);
    assert.equal(requests, 0);
  },
});

exports.tests.push({
  name: 'fresh Text Translation worker refuses stale or unregistered documents without storage writes or transport',
  async fn() {
    let current = 'new-document';
    const chrome = createBlockBatchChrome({ settings: { openrouterApiKey: 'sk-test-synthetic' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    chrome.webNavigation.getFrame = async () => current ? { documentId: current } : null;
    chrome.runtime.getContexts = async () => current ? [{ tabId: 90, frameId: 0, documentId: current,
      documentUrl: 'chrome-extension://test/text-translation.html' }] : [];
    let storageReads = 0;
    let storageWrites = 0;
    chrome.storage.session = { async get() { storageReads += 1; return {}; },
      async set() { storageWrites += 1; } };
    let requests = 0;
    for (const live of ['new-document', null]) {
      current = live;
      for (const type of ['SAVE_TEXT_TRANSLATION_STATE', 'GET_TEXT_TRANSLATION_STATE', 'TRANSLATE_TEXT']) {
        storageReads = 0;
        const worker = helpers.createBackgroundWorker({ chrome, fetch() { requests += 1; throw new Error('Unexpected transport'); } });
        const response = await sendTextMessage(worker, { type, operationId: 'stale', revision: 1,
          source: 'Original', settings: TEXT_SETTINGS, state: { source: 'Draft', settings: TEXT_SETTINGS,
            openaiModel: 'test-model', openaiReasoningEffort: 'low', job: null } });
        assert.equal(response.ok, false, `${type}:${live}`);
        assert.equal(requests, 0, `${type}:${live}`);
        assert.equal(storageReads, type === 'SAVE_TEXT_TRANSLATION_STATE' ? 1 : 0, `${type}:${live}`);
        assert.equal(storageWrites, 0, `${type}:${live}`);
      }
    }
  },
});

exports.tests.push({
  name: 'Text Translation sends the explicit snapshot through the selected fixed transport',
  async fn() {
    const requests = [];
    const chrome = createBlockBatchChrome({ settings: { apiKey: 'sk-other-synthetic',
      openrouterApiKey: 'sk-text-synthetic', service: 'openai' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const worker = helpers.createBackgroundWorker({ chrome, fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
      return { ok: true, json: async () => createCompletedResponse(JSON.stringify({
        translation: '<b>번역</b>\n\n두 번째 문단', sourceLanguage: null,
      })) };
    } });
    const response = await sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'first',
      source: '<b>Source</b>\n\nSecond paragraph', settings: TEXT_SETTINGS });
    assert.deepEqual(response, { ok: true, result: { translation: '<b>번역</b>\n\n두 번째 문단',
      sourceLanguage: null } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(requests[0].authorization, 'Bearer sk-text-synthetic');
    assert.equal(requests[0].body.model, 'deepseek/deepseek-v4.1-flash-1017');
    assert.deepEqual(requests[0].body.reasoning, { effort: 'none' });
    assert.deepEqual(requests[0].body.provider, { require_parameters: true, data_collection: 'deny', zdr: true });
    assert.equal(requests[0].body.store, false);
    assert.equal(requests[0].body.input, '<b>Source</b>\n\nSecond paragraph');
    assert.match(requests[0].body.instructions, /Korean/);
    assert.match(requests[0].body.instructions, /natural/);
    assert.equal(JSON.stringify(response).includes('sk-'), false);
  },
});

exports.tests.push({
  name: 'all Text Translation messages share the top-level extension sender boundary',
  async fn() {
    const chrome = createBlockBatchChrome();
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const calls = [];
    const readLocal = chrome.storage.local.get;
    chrome.storage.local.get = async keys => {
      calls.push({ type: 'local.get', keys });
      return readLocal(keys);
    };
    chrome.storage.session = {
      async get(key) { calls.push({ type: 'get', key }); return {}; },
      async set(value) { calls.push({ type: 'set', value }); },
    };
    const worker = helpers.createBackgroundWorker({ chrome, async fetch(url, options) {
      calls.push({ type: 'fetch', url, options });
      return { ok: true, json: async () => createCompletedResponse(JSON.stringify({ translation: '결과', sourceLanguage: null })) };
    } });
    for (const type of ['GET_TEXT_TRANSLATION_STATE', 'SAVE_TEXT_TRANSLATION_STATE',
      'CLEAR_TEXT_TRANSLATION_STATE', 'TRANSLATE_TEXT', 'STOP_TEXT_TRANSLATION']) {
      for (const sender of [{ ...TEXT_SENDER, tab: undefined }, { ...TEXT_SENDER, frameId: 1 },
        { ...TEXT_SENDER, documentId: undefined }, { ...TEXT_SENDER, url: 'https://example.test/text-translation.html' }]) {
        const response = await sendTextMessage(worker, { type, operationId: 'untrusted', revision: 1,
          source: 'Original', settings: TEXT_SETTINGS }, sender);
        assert.deepEqual(calls, [], type);
        assert.equal(response.ok, false, type);
      }
    }
    for (const type of ['TRANSLATE_TEXT', 'STOP_TEXT_TRANSLATION']) {
      for (const operationId of [null, '', 'x'.repeat(101)]) {
        const response = await sendTextMessage(worker, { type, operationId, source: 'Original',
          settings: TEXT_SETTINGS });
        assert.deepEqual(calls, [], type);
        assert.equal(response.ok, false, type);
      }
    }
  },
});

exports.tests.push({
  name: 'Text Translation rejects untrusted senders, empty and oversized input before sending',
  async fn() {
    const chrome = createBlockBatchChrome({ settings: { apiKey: 'sk-other-synthetic',
      openrouterApiKey: 'sk-text-synthetic' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const requests = [];
    const worker = helpers.createBackgroundWorker({ chrome, fetch: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body), authorization: options.headers.Authorization });
      return { ok: true, json: async () => createCompletedResponse(JSON.stringify({
        translation: '번역', sourceLanguage: null,
      })) };
    } });
    const valid = await sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'valid',
      source: 'hello', settings: TEXT_SETTINGS });
    assert.deepEqual(valid, { ok: true, result: { translation: '번역', sourceLanguage: null } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(requests[0].authorization, 'Bearer sk-text-synthetic');
    assert.equal(requests[0].body.input, 'hello');
    requests.length = 0;
    for (const [source, sender, settings] of [
      ['hello', { ...TEXT_SENDER, url: 'https://example.test/text-translation.html' }, TEXT_SETTINGS],
      ['hello', { ...TEXT_SENDER, frameId: 1 }, TEXT_SETTINGS],
      ['', TEXT_SENDER, TEXT_SETTINGS], ['  \n', TEXT_SENDER, TEXT_SETTINGS],
      ['😀'.repeat(12001), TEXT_SENDER, TEXT_SETTINGS],
      ['hello', TEXT_SENDER, { ...TEXT_SETTINGS, apiKey: 'forbidden' }],
      ['hello', TEXT_SENDER, { ...TEXT_SETTINGS, service: 'other' }],
    ]) {
      const result = await sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'invalid', source, settings }, sender);
      assert.equal(requests.length, 0, 'invalid input cannot send');
      assert.equal(result.ok, false);
    }
  },
}, {
  name: 'Text Translation tab departure aborts transport and refuses a delayed response',
  async fn() {
    let release;
    let signal;
    const chrome = createBlockBatchChrome({ settings: { openrouterApiKey: 'sk-text-synthetic' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const worker = helpers.createBackgroundWorker({ chrome, fetch: async (_url, options) => {
      signal = options.signal;
      await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => createCompletedResponse(JSON.stringify({
        translation: '오래된 응답', sourceLanguage: null,
      })) };
    } });
    const pending = sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'departed',
      source: 'hello', settings: TEXT_SETTINGS });
    await new Promise(resolve => setImmediate(resolve));
    worker.handlers.onTabRemoved(90);
    assert.equal(signal.aborted, true);
    release();
    assert.equal((await pending).ok, false);
  },
}, {
  name: 'Text Translation rejects duplicate work, scopes Stop, and keeps snapshot settings',
  async fn() {
    let release;
    let signal;
    const requests = [];
    const settings = { ...TEXT_SETTINGS, service: 'openai', model: 'starting-model', reasoningEffort: 'low' };
    const chrome = createBlockBatchChrome({ settings: { apiKey: 'sk-text-synthetic' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const worker = helpers.createBackgroundWorker({ chrome, fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      signal = options.signal;
      await new Promise(resolve => { release = resolve; });
      return { ok: true, json: async () => createCompletedResponse(JSON.stringify({
        translation: '번역', sourceLanguage: null,
      })) };
    } });
    const pending = sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'snapshot',
      source: '😀'.repeat(12000), settings });
    settings.model = 'later-model';
    settings.targetLanguage = 'French';
    await new Promise(resolve => setImmediate(resolve));
    const duplicate = await sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'duplicate',
      source: 'second', settings: TEXT_SETTINGS });
    assert.equal(duplicate.ok, false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].model, 'starting-model');
    assert.match(requests[0].instructions, /Korean/);
    assert.equal(Array.from(requests[0].input).length, 12000);
    await sendTextMessage(worker, { type: 'STOP_TEXT_TRANSLATION', operationId: 'other' });
    assert.equal(signal.aborted, false);
    await sendTextMessage(worker, { type: 'STOP_TEXT_TRANSLATION', operationId: 'snapshot' },
      { ...TEXT_SENDER, documentId: 'another-document' });
    assert.equal(signal.aborted, false);
    await sendTextMessage(worker, { type: 'STOP_TEXT_TRANSLATION', operationId: 'snapshot' });
    assert.equal(signal.aborted, true);
    release();
    assert.equal((await pending).ok, false);
  },
}, {
  name: 'Text Translation refuses malformed model output without retrying',
  async fn() {
    let requests = 0;
    const chrome = createBlockBatchChrome({ settings: { openrouterApiKey: 'sk-text-synthetic' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const worker = helpers.createBackgroundWorker({ chrome, fetch: async () => {
      requests += 1;
      return { ok: true, json: async () => createCompletedResponse('<b>not the response contract</b>') };
    } });
    const response = await sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'malformed',
      source: 'hello', settings: TEXT_SETTINGS });
    assert.equal(response.ok, false);
    assert.equal(requests, 1);
    assert.equal(Object.hasOwn(response, 'result'), false);
  },
});

exports.tests.push({
  name: 'Text Translation refuses completed output that loses internal line boundaries without retrying',
  async fn() {
    const requests = [];
    const chrome = createBlockBatchChrome({ settings: { openrouterApiKey: 'sk-text-synthetic' } });
    chrome.runtime.getURL = path => `chrome-extension://test/${path}`;
    const worker = helpers.createBackgroundWorker({ chrome, fetch: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => createCompletedResponse(JSON.stringify({
        translation: '첫 줄과 두 번째 줄', sourceLanguage: 'English',
      })) };
    } });
    const response = await sendTextMessage(worker, { type: 'TRANSLATE_TEXT', operationId: 'lost-lines',
      source: 'First line\n\nSecond line', settings: TEXT_SETTINGS });
    assert.equal(response.ok, false);
    assert.equal(Object.hasOwn(response, 'result'), false);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].input, 'First line\n\nSecond line');
  },
});

exports.tests.push({
  name: 'controls on separate tabs retain their Authorization and execution order',
  async fn() {
    const sent = [];
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    const worker = helpers.createBackgroundWorker({ chrome: { webNavigation: { async getFrame({ tabId }) {
      return { documentId: `document-${tabId}` };
    } }, tabs: {
      sendMessage(tabId, message) {
        sent.push({ tabId, instruction: message.instruction });
        return sent.length === 1 ? waiting : Promise.resolve({ ok: true });
      },
    } } });
    function command(tabId, control) {
      return new Promise((resolve) => worker.handlers.onMessage({
        type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId, documentId: `document-${tabId}`, control,
      }, {}, resolve));
    }
    const old = command(9, 'start');
    await require('./inline-translation-operation.test').flushMicrotasks();
    assert.deepEqual(await command(8, 'stop'), { ok: true });
    release({ ok: true });
    assert.deepEqual(await old, { ok: true });
    assert.deepEqual(sent, [
      { tabId: 9, instruction: 'grantInlineTranslationAuthorization' },
      { tabId: 8, instruction: 'grantInlineTranslationAuthorization' },
      { tabId: 8, instruction: 'stopInlineTranslation' },
      { tabId: 9, instruction: 'startInlineTranslation' },
    ]);
  },
});

exports.tests.push({
  name: 'OpenRouter Inline preserves safe siblings and repairs an unsafe block only once',
  async fn() {
    const requests = [];
    const worker = helpers.createBackgroundWorker({ chrome: createBlockBatchChrome({ settings: {
      ...BLOCK_BATCH_SETTINGS, service: 'openrouter', openrouterApiKey: 'sk-or-synthetic',
    } }), fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, authorization: options.headers.Authorization, body });
      return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
        translations: requests.length === 1
          ? [{ id: 'b1', template: '토큰이 빠진 번역입니다.' }, { id: 'b2', template: '안전한 번역입니다.' }]
          : [{ id: 'b1', template: '여전히 토큰이 빠졌습니다.' }],
      })); } };
    } });
    const [response] = await collectWorkerResponses(worker, [{ type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
      records: [createBlockApiRecord('b1'), createTestPlainBlockRecord('b2')],
    }]);
    assert.equal(response.ok, true);
    assert.equal(requests.length, 2);
    assert.equal(response.results[0].disposition, 'reject');
    assert.equal(response.results[0].attemptCount, 2);
    assert.equal(response.results[1].disposition, 'apply');
    assert.equal(response.results[1].attemptCount, 1);
    assert.ok(requests.every(request => request.url === 'https://openrouter.ai/api/v1/responses' &&
      request.authorization === 'Bearer sk-or-synthetic' && request.body.reasoning.effort === 'none' &&
      request.body.provider.zdr === true));
    const repair = JSON.parse(requests[1].body.input);
    assert.deepEqual(repair.records.map(record => record.id), ['b1']);
  },
});

exports.tests.push({
  name: 'floating controls open only the sender tab panel without settings or instructions',
  async fn() {
    const calls = [];
    const worker = helpers.createBackgroundWorker({ chrome: { sidePanel: {
      open(options) { calls.push(options); return Promise.resolve(); },
    } } });
    const response = await new Promise(resolve => worker.handlers.onMessage(
      { type: 'OPEN_INLINE_TRANSLATION_CONTROLS', tabId: 99 },
      { tab: { id: 7 }, frameId: 0 }, resolve));
    assert.deepEqual(response, { ok: true });
    assert.deepEqual(calls, [{ tabId: 7 }]);
    for (const sender of [{}, { tab: { id: 7 }, frameId: 1 }, { tab: { id: '7' }, frameId: 0 }]) {
      const rejected = await new Promise(resolve => worker.handlers.onMessage(
        { type: 'OPEN_INLINE_TRANSLATION_CONTROLS', tabId: 99 }, sender, resolve));
      assert.equal(rejected.ok, false);
    }
    assert.equal(calls.length, 1);
  },
}, {
  name: 'floating panel opening preserves browser failure without starting translation',
  async fn() {
    const worker = helpers.createBackgroundWorker({ chrome: { sidePanel: {
      open() { return Promise.reject(new Error('Panel opening refused')); },
    } } });
    const response = await new Promise(resolve => worker.handlers.onMessage(
      { type: 'OPEN_INLINE_TRANSLATION_CONTROLS' }, { tab: { id: 7 }, frameId: 0 }, resolve));
    assert.equal(response.ok, false);
    assert.equal(response.error.message, 'Panel opening refused');
  },
});
