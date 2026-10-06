const assert = require('node:assert/strict');
const helpers = require('../extension/content.js');
const {
  createReasoningFixture,
  createTestDocument,
} = require('./inline-block.test');
const inlineBlockCodec = require('../extension/inline-block.js');
const inlineTranslationSession = require('../extension/inline-translation-session.js');
const sidepanel = require('../extension/sidepanel.js');
const background = require('../extension/background.js');

function getReasoningTranslatedTemplate(record) {
  const wrapper = record.contract.entries.find(
    (entry) => entry.kind === 'wrapper'
  );
  const atom = record.contract.entries.find((entry) => entry.kind === 'atom');
  return `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
}

// A state with an Inline Translation Operation begun under `settings`, the way Start begins
// one once it has the settings.
function createActiveInlineTranslationState(overrides = {}, settings = {}, diagnosticAdapters) {
  const state = helpers.createInlineTranslationState(overrides);
  helpers.beginInlineTranslationOperation(
    state,
    inlineTranslationSession.createSettingsSnapshot(settings),
    diagnosticAdapters
  );
  return state;
}

// The Session Budget limit is an independent expectation, never imported from runtime.
const INLINE_SESSION_BUDGET = 150000;

function admitUnsupported(state) {
  const { document, element, text } = createTestDocument();
  const block = element('li', text('Outer prose.'), element('p', text('Nested prose.')),
    text(' Outer prose continues.'));
  document.body.appendChild(block);
  state.session.admit(block);
}

exports.name = 'content helpers';

function withFakeViewportDom(fn, options = {}) {
  const previous = {
    MutationObserver: global.MutationObserver,
    chrome: global.chrome,
    clearTimeout: global.clearTimeout,
    document: global.document,
    HTMLElement: global.HTMLElement,
    setTimeout: global.setTimeout,
    window: global.window,
  };
  const defaultRect = {
    top: 20,
    bottom: 44,
    left: 10,
    right: 300,
    width: 290,
    height: 24,
    ...(options.defaultRect || {}),
  };

  class FakeElement {
    constructor(children = [], rect = {}) {
      this.nodeType = 1;
      this.tagName = 'P';
      this.childNodes = children;
      this.hidden = false;
      this.parentElement = null;
      this.rect = { ...defaultRect, ...rect };
      for (const child of children) {
        child.parentElement = this;
      }
    }

    closest() {
      return null;
    }

    getAttribute() {
      return null;
    }

    getBoundingClientRect() {
      return this.rect;
    }
  }

  function text(value) {
    return {
      nodeType: 3,
      nodeValue: value,
      isConnected: true,
      parentElement: null,
    };
  }

  global.MutationObserver = class { observe() {} disconnect() {} };
  global.HTMLElement = FakeElement;
  global.window = {
    addEventListener() {}, removeEventListener() {},
    innerWidth: 500,
    innerHeight: 300,
    getComputedStyle() {
      return {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
      };
    },
  };
  global.document = {
    documentElement: {
      clientWidth: 0,
      clientHeight: 0,
    },
    createRange() {
      throw new Error('range unavailable');
    },
  };
  if ('chrome' in options) global.chrome = options.chrome;
  if ('clearTimeout' in options) global.clearTimeout = options.clearTimeout;
  if ('setTimeout' in options) global.setTimeout = options.setTimeout;

  const restore = () => {
    global.MutationObserver = previous.MutationObserver;
    global.chrome = previous.chrome;
    global.clearTimeout = previous.clearTimeout;
    global.document = previous.document;
    global.HTMLElement = previous.HTMLElement;
    global.setTimeout = previous.setTimeout;
    global.window = previous.window;
  };

  try {
    const result = fn({ FakeElement, text });
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

function createLocalDiagnosticAdapters() {
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  return {
    requests,
    timers,
    sendMessage(message) {
      return new Promise((resolve, reject) => requests.push({ message, resolve, reject }));
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance() {
      assert.equal(timers.size, 1, 'one diagnostic task is scheduled');
      const [id, task] = timers.entries().next().value;
      timers.delete(id);
      task.callback();
    },
  };
}

function createLocalDiagnosticLifecycle() {
  const adapters = createLocalDiagnosticAdapters();
  const state = createActiveInlineTranslationState({}, {}, adapters);
  return {
    ...adapters,
    state,
    admit: () => admitUnsupported(state),
    flush: () => state.viewport.localDiagnosticTransport.flush(),
    stop: () => helpers.stopInlineViewportTranslation(state),
  };
}

function holdInlineSettings() {
  const requests = [];
  const send = global.chrome.runtime.sendMessage;
  global.chrome.runtime.sendMessage = (message) => message.type === 'GET_SETTINGS'
    ? new Promise((resolve, reject) => requests.push({ resolve, reject }))
    : send(message);
  return requests;
}

// Drive the production controls, scan, and Chrome request caller with the codec's DOM
// fixture. Only browser services are substituted; responses stay pending across controls.
async function withInlineRequestLifecycle(fn, { headroom = null } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  function advanceScans() {
    const tasks = [...timers.values()];
    timers.clear();
    for (const task of tasks) task();
  }
  function rescan(state) {
    state.viewport.scanner.rescan();
    advanceScans();
  }
  return withFakeViewportDom(async () => {
    const fixture = createReasoningFixture();
    const { document, block } = fixture;
    const state = helpers.createInlineTranslationState();
    const messages = [];
    const pending = [];
    let warming = true;
    const previousObserver = global.MutationObserver;
    const observers = new Set();
    const viewportListeners = new Map();
    global.MutationObserver = class {
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    };
    global.document = document;
    global.HTMLElement = block.constructor;
    document.querySelector = () => document.body;
    document.documentElement = { clientWidth: 0, clientHeight: 0 };
    document.createRange = () => { throw new Error('range unavailable'); };
    global.window.addEventListener = (type, listener) => {
      if (!viewportListeners.has(type)) viewportListeners.set(type, new Set());
      viewportListeners.get(type).add(listener);
    };
    global.window.removeEventListener = (type, listener) => viewportListeners.get(type)?.delete(listener);
    global.chrome = { runtime: { sendMessage(message) {
      messages.push(message);
      if (message.type === 'GET_SETTINGS') {
        return Promise.resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
      }
      if (message.type !== 'TRANSLATE_VISIBLE_BLOCK_BATCH') {
        return Promise.resolve({ ok: true });
      }
      if (warming) {
        return Promise.resolve({ ok: true, results: message.records.map(({ id }) => ({
          id, disposition: 'reject', terminalCode: 'protocol.invalid_json', attemptCount: 1,
        })) });
      }
      return new Promise((resolve, reject) => pending.push({ message, resolve, reject }));
    } } };

    async function instruct(instruction, target = state) {
      const replies = [];
      helpers.handleInlineContentMessage(
        { type: 'RUN_INLINE_INSTRUCTION', instruction },
        (reply) => replies.push(reply),
        target
      );
      assert.deepEqual(replies, [{ ok: true }]);
      await flushMicrotasks(256);
    }

    function paragraph(cost) {
      const node = document.createElement('p');
      const overhead = inlineTranslationSession.getRecordCost({ template: '', atoms: [] });
      const length = cost - overhead;
      node.textContent = 'An article sentence with ordinary prose. '.repeat(
        Math.ceil(length / 40)
      ).slice(0, length - 1) + '.';
      return node;
    }

    try {
      // Spend through real admission first, leaving room for a chosen number of copies
      // of the fixture. Paired one-attempt cases prove that later admission really fits.
      const recordCost = inlineTranslationSession.getRecordCost(fixture.serialized);
      document.body.replaceChildren();
      let remaining = headroom === null ? 0 : INLINE_SESSION_BUDGET - headroom * recordCost;
      while (remaining > 0) {
        const cost = Math.min(4000, remaining);
        document.body.appendChild(paragraph(cost));
        remaining -= cost;
      }
      await instruct('grantInlineTranslationAuthorization');
      await instruct('startInlineTranslation');
      assert.equal(state.session.status, 'active', state.error);
      assert.equal(state.session.progress().counts.pending, 0);
      if (headroom !== null) assert.match(state.session.progress().reason, /malformed or incomplete/);
      warming = false;
      document.body.replaceChildren(block);
      rescan(state);
      await flushMicrotasks();
      assert.equal(pending.length, 1, 'the original Semantic Block request is admitted');
      await fn({ ...fixture, state, messages, pending, instruct, paragraph, recordCost, rescan, advanceScans, timers, observers, viewportListeners });
    } finally {
      state.viewport.scanner.stop();
      if (previousObserver === undefined) delete global.MutationObserver;
      else global.MutationObserver = previousObserver;
    }
  }, {
    setTimeout(task) { const id = ++nextTimer; timers.set(id, task); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
}

exports.tests = [
  {
    name: 'sends the Session outbox through the local diagnostic transport interface',
    async fn() {
      const adapters = createLocalDiagnosticAdapters();
      const state = createActiveInlineTranslationState();
      const settingsSnapshot = state.viewport.translationSettings;
      const transport = helpers.createInlineLocalDiagnosticTransport({
        outbox: state.session.outbox,
        operationId: state.session.operationId,
        settingsSnapshot,
        ...adapters,
      });
      admitUnsupported(state);
      transport.flush();
      assert.equal(adapters.requests.length, 1);
      assert.deepEqual(adapters.requests[0].message, {
        type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
        diagnosticBatchId: adapters.requests[0].message.diagnosticBatchId,
        operationId: state.session.operationId,
        settingsSnapshot,
        diagnostics: [{ code: 'runtime.unsupported_block', evidence: {},
          localRejection: { reason: 'nested_semantic_block', tag: 'P' } }],
      });
      assert.match(adapters.requests[0].message.diagnosticBatchId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      adapters.requests[0].resolve({ ok: true });
      await flushMicrotasks();
      transport.flush();
      assert.equal(adapters.requests.length, 1);
      assert.equal(adapters.timers.size, 0);
    },
  },
  ...['stop', 'restore'].map((control) => ({
    name: `panel to worker to content control wiring discards pending Start after ${control}`,
    async fn() {
      await withInlineRequestLifecycle(async ({ state, pending }) => {
        const instructions = [];
        const worker = background.createBackgroundWorker({ chrome: { tabs: {
          sendMessage(tabId, message) {
            assert.equal(tabId, 9);
            if (message.type === 'RUN_INLINE_INSTRUCTION') instructions.push(message);
            return new Promise((resolve) => {
              assert.equal(helpers.handleInlineContentMessage(message, resolve, state), true);
            });
          },
        } } });
        let displayed;
        const controller = sidepanel.createTabStateController({
          queryActiveTab: async () => ({ id: 9 }),
          sendMessage: (message) => new Promise((resolve) => worker.handlers.onMessage(message, {}, resolve)),
          render(display) { displayed = display; },
        });
        await controller.start(10);
        await controller.runInlineControl('restore');
        instructions.length = 0;
        const settings = holdInlineSettings();
        await controller.runInlineControl('start');
        assert.equal(settings.length, 1);
        await controller.runInlineControl(control);
        const before = displayed;
        settings[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
        await flushMicrotasks(256);
        await controller.refresh();
        assert.deepEqual(displayed, before);
        assert.equal(displayed.inline.snapshot.status, control === 'stop' ? 'stopped' : 'original');
        assert.equal(pending.length, 1, 'superseded preparation cannot send a model request');
        assert.deepEqual(instructions, [
          { type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' },
          { type: 'RUN_INLINE_INSTRUCTION', instruction: 'startInlineTranslation' },
          { type: 'RUN_INLINE_INSTRUCTION', instruction: 'grantInlineTranslationAuthorization' },
          { type: 'RUN_INLINE_INSTRUCTION', instruction: control === 'stop'
            ? 'stopInlineTranslation' : 'restoreInlineOriginal' },
        ]);
      });
    },
  })),
  ...['stopInlineTranslation', 'restoreInlineOriginal', 'startInlineTranslation'].flatMap((control) =>
    ['failure', 'rejection'].map((outcome) => ({
      name: `discards superseded Start settings ${outcome} after ${control}`,
      async fn() {
        await withInlineRequestLifecycle(async ({ state, pending, instruct }) => {
          await instruct('restoreInlineOriginal');
          const settings = holdInlineSettings();
          await instruct('startInlineTranslation');
          await instruct(control);
          if (control === 'startInlineTranslation') {
            settings[1].resolve({ ok: false, error: { message: 'latest preparation failed' } });
            await flushMicrotasks(256);
            assert.equal(helpers.getInlineTranslationStatusSnapshot(state).error, 'latest preparation failed');
          }
          const before = helpers.getInlineTranslationStatusSnapshot(state);
          if (outcome === 'rejection') settings[0].reject(new Error('old preparation failed'));
          else settings[0].resolve({ ok: false, error: { message: 'old preparation failed' } });
          await flushMicrotasks(256);
          assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(state), before);
          assert.equal(pending.length, 1);
        });
      },
    }))),
  ...['stopInlineTranslation', 'restoreInlineOriginal'].map((control) => ({
    name: `discards pending Start settings after ${control}`,
    async fn() {
      await withInlineRequestLifecycle(async ({ state, pending, instruct }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdInlineSettings();
        const listeners = [];
        global.window.addEventListener = (type) => listeners.push(type);
        await instruct('startInlineTranslation');
        assert.equal(settings.length, 1);
        await instruct(control);
        const before = helpers.getInlineTranslationStatusSnapshot(state);
        settings[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
        await flushMicrotasks(256);
        assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(state), before);
        assert.deepEqual(listeners, [], 'superseded preparation cannot attach viewport watchers');
        assert.equal(pending.length, 1, 'superseded preparation cannot send another model request');
      });
    },
  })),
  {
    name: 'only the latest pending Start settings may begin an Inline Translation Operation',
    async fn() {
      await withInlineRequestLifecycle(async ({ state, pending, instruct }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdInlineSettings();
        await instruct('startInlineTranslation');
        await instruct('startInlineTranslation');
        assert.equal(settings.length, 2);
        const before = helpers.getInlineTranslationStatusSnapshot(state);
        settings[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
        await flushMicrotasks(256);
        assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(state), before);
        assert.equal(pending.length, 1);
        settings[1].resolve({ ok: true, settings: {
          apiKey: 'synthetic-test-key', targetLanguage: 'Japanese',
        } });
        await flushMicrotasks(256);
        assert.equal(helpers.getInlineTranslationStatusSnapshot(state).status, 'active');
        assert.equal(pending.length, 2);
        assert.equal(pending[1].message.settingsSnapshot.targetLanguage, 'Japanese');
      });
    },
  },
  ...['success', 'missing key'].map((outcome) => ({
    name: `superseded Start settings ${outcome} preserves the latest preparation error`,
    async fn() {
      await withInlineRequestLifecycle(async ({ state, pending, instruct }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdInlineSettings();
        await instruct('startInlineTranslation');
        await instruct('startInlineTranslation');
        settings[1].resolve({ ok: false, error: { message: 'latest preparation failed' } });
        await flushMicrotasks(256);
        const before = helpers.getInlineTranslationStatusSnapshot(state);
        assert.equal(before.error, 'latest preparation failed');
        settings[0].resolve({ ok: true, settings: outcome === 'success'
          ? { apiKey: 'synthetic-test-key' } : {} });
        await flushMicrotasks(256);
        assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(state), before);
        assert.equal(pending.length, 1);
      });
    },
  })),
  ...['failure', 'rejection', 'missing key'].map((outcome) => ({
    name: `latest Start settings ${outcome} remains visible`,
    async fn() {
      await withInlineRequestLifecycle(async ({ state, pending, instruct }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdInlineSettings();
        await instruct('startInlineTranslation');
        if (outcome === 'rejection') settings[0].reject(new Error('latest preparation failed'));
        else settings[0].resolve(outcome === 'missing key' ? { ok: true, settings: {} }
          : { ok: false, error: { message: 'latest preparation failed' } });
        await flushMicrotasks(256);
        const snapshot = helpers.getInlineTranslationStatusSnapshot(state);
        assert.equal(snapshot.status, 'original');
        assert.equal(snapshot.error, outcome === 'missing key'
          ? 'Open Options and paste your OpenAI API key.' : 'latest preparation failed');
        assert.equal(pending.length, 1);
      });
    },
  })),
  {
    name: 'an active Start rescans and keeps its submitted Semantic Block response eligible',
    async fn() {
      await withInlineRequestLifecycle(async ({ state, block, pending, instruct, document, paragraph, recordCost, advanceScans, timers }) => {
        const settings = holdInlineSettings();
        document.body.appendChild(paragraph(recordCost));
        await instruct('startInlineTranslation');
        assert.equal(settings.length, 0);
        assert.equal(timers.size, 1);
        assert.equal(pending.length, 1);
        advanceScans();
        await flushMicrotasks();
        assert.equal(pending.length, 2);
        const request = pending[0];
        request.resolve({ ok: true, results: [{
          id: request.message.records[0].id, disposition: 'apply', attemptCount: 1,
          template: getReasoningTranslatedTemplate(request.message.records[0]),
        }] });
        await flushMicrotasks(256);
        assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
        assert.equal(state.session.progress().counts.translated, 1);
        assert.equal(pending.length, 2);
      });
    },
  },
  ...['stopInlineTranslation', 'restoreInlineOriginal', 'replace'].map((control) => ({
    name: `content ${control} closes the scanner before the next operation`,
    async fn() {
      await withInlineRequestLifecycle(async ({ state, instruct, timers, observers, viewportListeners, pending }) => {
        assert.equal(observers.size, 1);
        for (const listeners of viewportListeners.values()) assert.equal(listeners.size, 1);
        await instruct('startInlineTranslation');
        assert.equal(timers.size, 1);
        const lateScan = [...timers.values()][0];
        const lateChange = [...viewportListeners.get('scroll')][0];
        if (control === 'replace') helpers.beginInlineTranslationOperation(state, {});
        else await instruct(control);
        assert.equal(timers.size, 0);
        assert.equal(observers.size, 0);
        for (const listeners of viewportListeners.values()) assert.equal(listeners.size, 0);
        const progress = state.session.progress();
        lateScan(); lateChange();
        await flushMicrotasks();
        assert.equal(pending.length, 1);
        assert.deepEqual(state.session.progress(), progress);
        if (control !== 'replace') {
          await instruct('startInlineTranslation');
          assert.equal(observers.size, 1);
          for (const listeners of viewportListeners.values()) assert.equal(listeners.size, 1);
        }
      });
    },
  })),
  ...[
    { name: 'current one-attempt response', attemptCount: 1, controls: [] },
    { name: 'current repaired response', attemptCount: 2, controls: [] },
    { name: 'current repair charged exactly once', attemptCount: 2, controls: [], headroom: 3 },
    { name: 'repair exceeds the submitted budget', attemptCount: 2, controls: [], headroom: 1 },
    { name: 'Original text then one-attempt response', attemptCount: 1, controls: ['restoreInlineOriginal'] },
    { name: 'Original text then repaired response', attemptCount: 2, controls: ['restoreInlineOriginal'] },
    { name: 'Stop then repaired response', attemptCount: 2, controls: ['stopInlineTranslation'] },
    { name: 'Stop and Start then repaired response', attemptCount: 2, controls: ['stopInlineTranslation', 'startInlineTranslation'] },
    { name: 'Original text and Start then repaired response', attemptCount: 2, controls: ['restoreInlineOriginal', 'startInlineTranslation'] },
    { name: 'repeated replacements then repaired response', attemptCount: 2, controls: ['restoreInlineOriginal', 'startInlineTranslation', 'stopInlineTranslation', 'startInlineTranslation', 'restoreInlineOriginal', 'startInlineTranslation'] },
  ].map(({ name, attemptCount, controls, headroom = 2 }) => ({
    name: `settles Session Budget through controls: ${name}`,
    async fn() {
      await withInlineRequestLifecycle(async ({ block, strong, link, document, state, messages, pending, instruct, paragraph, recordCost, rescan }) => {
        const originalText = block.textContent;
        const originalChildren = [...block.childNodes];
        const request = pending[0];
        const record = request.message.records[0];
        // Keep the old block offscreen so restarting cannot submit it a second time.
        block.rect = { top: 2000, bottom: 2024, left: 10, right: 300, width: 290, height: 24 };
        for (const control of controls) await instruct(control);
        const before = state.session.progress();
        const statusBefore = helpers.getInlineTranslationStatusSnapshot(state);
        request.resolve({ ok: true, results: [{
          id: record.id,
          disposition: 'apply',
          template: getReasoningTranslatedTemplate(record),
          attemptCount,
          correlationToken: 'lifecycle-token',
        }] });
        await flushMicrotasks(32);

        if (controls.length) {
          assert.equal(block.textContent, originalText);
          assert.deepEqual(block.childNodes, originalChildren);
          assert.deepEqual(state.session.progress(), before);
          assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(state), statusBefore);
          assert.equal(pending.length, 1, 'obsolete work cannot re-enter the queue');
        } else {
          assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
          assert.equal(state.session.progress().counts.translated, 1);
          assert.equal(strong.parentElement, block);
          assert.equal(link.parentElement, block);
          assert.equal(link.getAttribute('href'), '/api/docs/models/gpt-5.5');
        }
        assert.deepEqual(messages.filter((message) => message.releaseTokens?.includes('lifecycle-token')), [{
          type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
          operationId: request.message.operationId,
          outcomes: [],
          releaseTokens: ['lifecycle-token'],
        }]);

        if (state.session.status !== 'active') await instruct('startInlineTranslation');
        const next = paragraph(recordCost);
        document.body.appendChild(next);
        rescan(state);
        await flushMicrotasks(32);
        if (headroom <= attemptCount) {
          assert.equal(pending.length, 1, 'reported repair must refuse the next request');
          assert.match(helpers.getInlineTranslationStatusSnapshot(state).error, /reached this page visit's limit/);
        } else {
          assert.equal(pending.length, 2, 'only reported attempts consume the remaining room');
          // Its initial charge must consume the remaining room, even before a response.
          document.body.appendChild(paragraph(recordCost));
          rescan(state);
          await flushMicrotasks();
          assert.equal(pending.length, 2, 'initial requests are charged at assembly');
        }
      }, { headroom });
    },
  })),
  {
    name: 'settles only originating records once despite duplicate and unrelated repair results',
    async fn() {
      await withInlineRequestLifecycle(async ({ document, state, pending, paragraph, recordCost, rescan }) => {
        const request = pending[0];
        const { id } = request.message.records[0];
        const repaired = { id, disposition: 'reject', terminalCode: 'protocol.invalid_json', attemptCount: 2 };
        request.resolve({ ok: true, results: [
          { ...repaired, id: 'unrelated-record' }, repaired, repaired,
        ] });
        await flushMicrotasks(32);
        document.body.appendChild(paragraph(recordCost));
        rescan(state);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'one reported repair leaves room for one more record');
        document.body.appendChild(paragraph(recordCost));
        rescan(state);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'the matching rejected repair still costs one attempt');
      }, { headroom: 3 });
    },
  },
  ...['request error', 'unsuccessful batch', 'missing results'].map((failure) => ({
    name: `retains initial Session Budget through the request caller after ${failure}`,
    async fn() {
      await withInlineRequestLifecycle(async ({ block, document, state, pending, instruct, paragraph, recordCost, rescan }) => {
        if (failure === 'request error') pending[0].reject(new Error('synthetic transport failure'));
        else pending[0].resolve(failure === 'unsuccessful batch'
          ? { ok: false, results: [{ id: pending[0].message.records[0].id, attemptCount: 2 }] }
          : { ok: true });
        await flushMicrotasks(32);
        assert.match(state.session.progress().reason, /translation request could not be completed/);
        assert.equal(state.session.progress().counts.pending, 0);
        block.rect = { top: 2000, bottom: 2024, left: 10, right: 300, width: 290, height: 24 };
        await instruct('restoreInlineOriginal');
        await instruct('startInlineTranslation');
        document.body.appendChild(paragraph(recordCost));
        rescan(state);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'failure retains the initial cost without guessing a repair');
        document.body.appendChild(paragraph(recordCost));
        rescan(state);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'the failed request is not refunded');
      }, { headroom: 2 });
    },
  })),
  // What the page files after a batch, per outcome. The worker has already recorded its own
  // verdicts and the results it could not produce, so those only release their tokens; the
  // page files an application failure and a change that no retry supersedes.
  ...[
    {
      name: 'an application failure',
      result: () => ({ disposition: 'apply', template: 'no tokens survive', attemptCount: 1 }),
      sent: [{ outcomes: [{ code: 'runtime.token_missing', correlationToken: 'outcome-token' }], releaseTokens: [] }],
    },
    {
      name: 'a worker verdict',
      result: () => ({ disposition: 'reject', terminalCode: 'structure.token_missing', attemptCount: 2 }),
      sent: [{ outcomes: [], releaseTokens: ['outcome-token'] }],
    },
    {
      name: 'a missing result',
      result: null,
      sent: [],
    },
    {
      name: 'a changed block a retry supersedes',
      change: ({ block, document }) => block.appendChild(document.createTextNode(' Edited.')),
      result: (record) => ({ disposition: 'apply', template: getReasoningTranslatedTemplate(record), attemptCount: 1 }),
      sent: [{ outcomes: [], releaseTokens: ['outcome-token'] }],
    },
    {
      name: 'a changed block no retry supersedes',
      change: ({ document }) => document.body.replaceChildren(),
      result: (record) => ({ disposition: 'apply', template: getReasoningTranslatedTemplate(record), attemptCount: 1 }),
      sent: [{ outcomes: [{ code: 'runtime.page_changed', correlationToken: 'outcome-token' }], releaseTokens: [] }],
    },
  ].map(({ name, change, result, sent }) => ({
    name: `files runtime outcomes through the request caller after ${name}`,
    async fn() {
      await withInlineRequestLifecycle(async (context) => {
        const { messages, pending } = context;
        const request = pending[0];
        const record = request.message.records[0];
        change?.(context);
        request.resolve({ ok: true, results: result
          ? [{ id: record.id, correlationToken: 'outcome-token', ...result(record) }]
          : [] });
        await flushMicrotasks(32);
        assert.deepEqual(
          messages.filter((message) => message.type === 'RECORD_INLINE_RUNTIME_DIAGNOSTIC'),
          sent.map((expected) => ({
            type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
            operationId: request.message.operationId,
            ...expected,
          }))
        );
      });
    },
  })),
  {
    name: 'reuses repaired cache output at an exhausted budget and gives a fresh content instance its own budget',
    async fn() {
      await withInlineRequestLifecycle(async ({ block, state, pending, instruct }) => {
        const record = pending[0].message.records[0];
        pending[0].resolve({ ok: true, results: [{
          id: record.id, disposition: 'apply', attemptCount: 2,
          template: getReasoningTranslatedTemplate(record),
        }] });
        await flushMicrotasks(32);
        const translated = block.textContent;
        assert.match(translated, /추론 모델/);
        await instruct('restoreInlineOriginal');
        await instruct('startInlineTranslation');
        assert.equal(pending.length, 1, 'historical repair metadata sends no new request');
        assert.equal(block.textContent, translated);
        await instruct('restoreInlineOriginal');
        const fresh = helpers.createInlineTranslationState();
        try {
          await instruct('grantInlineTranslationAuthorization', fresh);
          await instruct('startInlineTranslation', fresh);
          assert.equal(pending.length, 2, 'a fresh content-side lifetime admits the same page');
        } finally {
          fresh.viewport.scanner.stop();
        }
      }, { headroom: 2 });
    },
  },
  {
    name: 'detects code-like text conservatively',
    fn() {
      // The predicate has one home, in the codec that already owns what a protected atom is.
      // Asserting the identity — not just matching behaviour — is what makes every assertion
      // below cover the codec's link-label call site as well as the content script's scan.
      assert.equal(
        helpers.isCodeLikeInlineText,
        inlineBlockCodec.isCodeLikeInlineText
      );
      assert.equal(helpers.isCodeLikeInlineText('npm run build'), true);
      assert.equal(helpers.isCodeLikeInlineText('README.md'), true);
      assert.equal(helpers.isCodeLikeInlineText('https://example.com'), true);
      assert.equal(
        helpers.isCodeLikeInlineText(
          'This article explains browser translation.'
        ),
        false
      );
    },
  },
  {
    name: 'builds display Markdown and a protected translation document',
    fn() {
      const { element, text } = createTestDocument();
      const link = element('a', text('private guide'));
      link.setAttribute('href', 'https://private.test/path?token=secret');
      const root = element(
        'main',
        element(
          'p',
          text('Read '),
          link,
          text(' and run '),
          element('code', text('private-command --secret')),
          text('.')
        )
      );

      const extraction = helpers.buildArticleExtraction(root, {
        title: 'Guide',
        url: 'https://page.test/article',
        langHint: 'en',
      });

      assert.equal(extraction.title, 'Guide');
      assert.equal(extraction.langHint, 'en');
      assert.match(
        extraction.contentMarkdown,
        /\[private guide\]\(<https:\/\/private\.test\/path\?token=secret>\)/
      );
      assert.match(extraction.contentMarkdown, /```private-command --secret```/);
      const templates = extraction.translationDocument.blocks
        .map((block) => block.template)
        .join('\n');
      assert.equal(templates.includes('token=secret'), false);
      assert.equal(templates.includes('private-command --secret'), false);
    },
  },
  {
    name: 'rejects synthetic inline UI events',
    fn() {
      assert.equal(helpers.isTrustedInlineUiEvent({ isTrusted: true }), true);
      assert.equal(helpers.isTrustedInlineUiEvent({ isTrusted: false }), false);
      assert.equal(helpers.isTrustedInlineUiEvent({}), false);
    },
  },
  {
    name: 'requires extension authorization for inline translation',
    fn() {
      const state = { authorizedUntil: 0 };

      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        false
      );

      helpers.authorizeInlineTranslation(state, 1000);

      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        true
      );
      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000 + 5 * 60 * 1000),
        false
      );
    },
  },
  {
    name: 'authorizes inline translation from trusted inline UI events',
    fn() {
      const state = { authorizedUntil: 0 };

      assert.equal(
        helpers.authorizeInlineTranslationFromUiEvent(
          { isTrusted: false },
          state,
          1000
        ),
        false
      );
      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        false
      );

      assert.equal(
        helpers.authorizeInlineTranslationFromUiEvent(
          { isTrusted: true },
          state,
          1000
        ),
        true
      );
      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        true
      );
    },
  },
  {
    name: 'detects masked settings API key for inline preflight',
    fn() {
      assert.equal(helpers.hasInlineSettingsApiKey({ apiKey: '***' }), true);
      assert.equal(helpers.hasInlineSettingsApiKey({ apiKey: '' }), false);
      assert.equal(helpers.hasInlineSettingsApiKey({}), false);
      assert.equal(helpers.hasInlineSettingsApiKey(null), false);
    },
  },
  {
    name: 'asks the background worker what to do on startup instead of reading settings',
    async fn() {
      let message = null;
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            message = value;
            if (value?.type === 'GET_SETTINGS') {
              throw new Error('the mount decision is not the content script to make');
            }
            return { ok: true, instructions: ['mountFloatingTranslateButton'] };
          },
        },
        storage: {
          local: {
            async get() {
              throw new Error('content script must not read raw settings');
            },
          },
        },
      };

      assert.deepEqual(await helpers.requestInlineStartupInstructions(fakeChrome), [
        'mountFloatingTranslateButton',
      ]);
      assert.deepEqual(message, { type: 'GET_INLINE_STARTUP_INSTRUCTIONS' });
    },
  },
  {
    name: 'treats an unusable startup answer as no instructions',
    async fn() {
      const answers = [
        { ok: false, error: { message: 'Unknown message' } },
        { ok: true },
        undefined,
      ];
      for (const answer of answers) {
        const fakeChrome = {
          runtime: {
            async sendMessage() {
              return answer;
            },
          },
        };
        assert.deepEqual(
          await helpers.requestInlineStartupInstructions(fakeChrome),
          []
        );
      }
      assert.deepEqual(await helpers.requestInlineStartupInstructions({}), []);
    },
  },
  {
    name: 'grants inline translation authorization when instructed to',
    fn() {
      const state = {};
      assert.equal(
        helpers.runInlineInstruction(
          'grantInlineTranslationAuthorization',
          helpers.getDefaultInlineInstructionHandlers(state)
        ),
        true
      );
      assert.equal(helpers.hasInlineTranslationAuthorization(state), true);
    },
  },
  {
    name: 'runs inline instructions in order and ignores ones it does not know',
    fn() {
      const calls = [];
      const handlers = {
        grantInlineTranslationAuthorization: () =>
          calls.push('grantInlineTranslationAuthorization'),
        mountFloatingTranslateButton: () => calls.push('mountFloatingTranslateButton'),
      };

      helpers.runInlineInstructions(
        [
          'grantInlineTranslationAuthorization',
          'startSidePanelTranslation',
          'mountFloatingTranslateButton',
        ],
        handlers
      );
      assert.deepEqual(calls, [
        'grantInlineTranslationAuthorization',
        'mountFloatingTranslateButton',
      ]);
      assert.equal(helpers.runInlineInstruction('openSidePanel', handlers), false);
    },
  },
  {
    name: 'carries out the panel Inline Translation controls as instructions',
    fn() {
      // The side panel drives Inline Translation through the same channel the worker uses,
      // so a control has one implementation whatever pressed it.
      const handlers = helpers.getDefaultInlineInstructionHandlers();

      for (const control of [
        'startInlineTranslation',
        'stopInlineTranslation',
        'restoreInlineOriginal',
      ]) {
        assert.equal(typeof handlers[control], 'function', control);
      }
    },
  },
  {
    name: 'reports Inline Translation progress and errors as separate fields',
    fn() {
      // The panel is the only place either is shown, and it has a line for each: mixing
      // them into one string would leave the panel guessing which it had been handed.
      assert.deepEqual(
        helpers.getInlineTranslationStatusSnapshot(
          createActiveInlineTranslationState({
            message: 'Translated 3 blocks.',
            error: '',
          })
        ),
        { status: 'active', progress: 'Translated 3 blocks.', error: '' }
      );

      assert.deepEqual(
        helpers.getInlineTranslationStatusSnapshot(
          helpers.createInlineTranslationState({
            error: 'Open Options and paste your OpenAI API key.',
          })
        ),
        {
          status: 'original',
          progress: '',
          error: 'Open Options and paste your OpenAI API key.',
        }
      );

      assert.deepEqual(helpers.getInlineTranslationStatusSnapshot({}), {
        status: 'original',
        progress: '',
        error: '',
      });
    },
  },
  {
    name: 'reports a run that will not finish as an error, not as progress',
    fn() {
      // The panel keeps its progress line muted and raises its error line. A translation
      // that failed reaching the reader as muted status was what the split was for.
      const visit = inlineTranslationSession.createInlineTranslationSession();
      visit.begin({});
      visit.admit(createReasoningFixture().block);
      visit.settle(visit.takeBatch(), null);
      const failed = visit.progress().reason;

      assert.match(
        helpers.formatInlineViewportReasons(failed),
        /Translation failed/
      );
      assert.equal(
        helpers.formatInlineViewportReasons(failed, true),
        `${failed}\nDiagnostics could not be saved.`
      );
      assert.equal(
        helpers.formatInlineViewportReasons('', true),
        'Diagnostics could not be saved.'
      );
      assert.equal(
        helpers.formatInlineViewportReasons(''),
        ''
      );
      assert.equal(helpers.formatInlineViewportReasons(''), '');
    },
  },
  {
    name: 'leaves Inline Translation progress and errors to the side panel',
    fn() {
      // Single-sourced in the panel: the Floating Translate Button carries the controls
      // and nothing else, so there is no two-way synchronisation to maintain.
      const model = helpers.getInlineTranslatorUiModel(
        createActiveInlineTranslationState({
          menuOpen: true,
          message: 'Translated 3 blocks.',
          error: 'Translation failed.',
        })
      );

      assert.equal('message' in model, false);
      assert.doesNotMatch(JSON.stringify(model), /Translated 3 blocks|failed/);
    },
  },
  {
    // `INLINE_TRANSLATION_PROGRESS` was the half of the retired message pair that lived
    // here: the service worker sent it and this script wrote it onto the progress line.
    // The worker suite guards the producer; this guards the receiver, because re-adding
    // the receiver alone is the natural way to "restore progress reporting" and it is
    // exactly how the pair survived unnoticed the first time. Progress is now written by
    // `updateInlineViewportMessage`, from Semantic Block counts, and by nothing else.
    //
    // The handler takes the state it answers for, so this drives it with a state of its
    // own. Reaching the registered listener instead would mean re-requiring this script
    // with the module singleton deleted, and the singleton a check leaves behind is
    // whatever the check ran next then reads.
    name: 'does not act on the retired inline progress message',
    fn() {
      const state = createActiveInlineTranslationState({
        message: 'Visible translation on',
      });
      const responses = [];

      const handled = helpers.handleInlineContentMessage(
        {
          type: 'INLINE_TRANSLATION_PROGRESS',
          operationId: state.session.operationId,
          progress: { stage: 'queued', recordCount: 3, chunkCount: 1 },
        },
        (response) => responses.push(response),
        state
      );

      assert.equal(handled, undefined);
      assert.deepEqual(responses, []);
      assert.equal(state.message, 'Visible translation on');
    },
  },
  {
    name: 'brings the Floating Translate Button back with its menu down, not open',
    fn() {
      // The re-mount half of the cycle: mounting renders whatever the state says, so a
      // button closed with its menu open would come back mid-menu if closing left it that
      // way. This is the whole of what closing has to remember.
      const state = helpers.createInlineTranslationState({ menuOpen: true });
      helpers.closeFloatingTranslateButton(state);
      const remounted = helpers.getInlineTranslatorUiModel(state);
      assert.equal(remounted.menuOpen, false);
      assert.equal(remounted.expanded, 'false');
    },
  },
  {
    name: 'keeps a running Inline Translation running when the button is closed',
    fn() {
      // Closing takes the UI, not the work: the run stays active on the same operation, so
      // the Semantic Blocks already under way keep being translated against it.
      const scanning = createActiveInlineTranslationState({
        menuOpen: true,
        message: 'Visible translation on',
      });
      const { operationId } = scanning.session;
      helpers.closeFloatingTranslateButton(scanning);
      assert.equal(scanning.session.status, 'active');
      assert.equal(scanning.session.operationId, operationId);
    },
  },
  {
    name: 'records nothing about a closed button that could outlive the page view',
    fn() {
      // A reload brings the button back subject to the reader's visibility choice, so
      // closing must leave nothing behind to restore from. It adds no state at all: the
      // button is closed exactly while its UI is detached.
      const state = createActiveInlineTranslationState({ menuOpen: true });
      const before = Object.keys(state).sort();
      helpers.closeFloatingTranslateButton(state);
      assert.deepEqual(Object.keys(state).sort(), before);
    },
  },
  {
    name: 'carries out the remaining inline instructions when one of them fails',
    fn() {
      const calls = [];
      helpers.runInlineInstructions(
        ['grantInlineTranslationAuthorization', 'mountFloatingTranslateButton'],
        {
          grantInlineTranslationAuthorization: () => {
            throw new Error('no page to authorize');
          },
          mountFloatingTranslateButton: () => calls.push('mountFloatingTranslateButton'),
        }
      );
      assert.deepEqual(calls, ['mountFloatingTranslateButton']);
    },
  },
  {
    name: 'loads inline menu target language through masked runtime settings',
    async fn() {
      const messages = [];
      const state = helpers.createInlineTranslationState({ menuOpen: true });
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            messages.push(value);
            return {
              ok: true,
              settings: {
                targetLanguage: 'Japanese',
                tone: 'technical',
                model: 'gpt-5.4-mini',
                apiKey: '***',
              },
            };
          },
        },
      };

      const snapshot = await helpers.refreshInlineTranslatorSettings(
        fakeChrome,
        state
      );

      assert.deepEqual(messages, [{ type: 'GET_SETTINGS' }]);
      assert.equal(snapshot.targetLanguage, 'Japanese');
      assert.equal(
        helpers.getInlineTranslatorUiModel(state).translateText,
        'Page in Japanese'
      );
    },
  },
  {
    name: 'requires closed shadow UI isolation',
    fn() {
      assert.equal(helpers.getInlineShadowMode(), 'closed');
      assert.match(helpers.getInlineHostStyleText(), /all: initial !important/);
      assert.match(
        helpers.getInlineHostStyleText(),
        /position: fixed !important/
      );
      assert.match(
        helpers.getInlineHostStyleText(),
        /pointer-events: auto !important/
      );
    },
  },
  {
    name: 'drains semantic block page-change retries through the runtime loop',
    async fn() {
      const state = createActiveInlineTranslationState();
      const previous = {
        MutationObserver: global.MutationObserver,
        chrome: global.chrome,
        document: global.document,
        HTMLElement: global.HTMLElement,
        window: global.window,
      };
      const fixture = createReasoningFixture();
      const calls = [];
      fixture.document.documentElement = {
        clientWidth: 0,
        clientHeight: 0,
      };
      fixture.document.createRange = () => {
        throw new Error('range unavailable');
      };
      global.document = fixture.document;
      global.HTMLElement = fixture.block.constructor;
      global.MutationObserver = class { observe() {} disconnect() {} };
      global.window = {
        addEventListener() {}, removeEventListener() {},
        innerWidth: 500,
        innerHeight: 300,
        getComputedStyle() {
          return {
            display: 'block',
            visibility: 'visible',
            opacity: '1',
          };
        },
      };
      global.chrome = {
        runtime: {
          async sendMessage(message) {
            calls.push(message);
            if (message.type === 'RECORD_INLINE_RUNTIME_DIAGNOSTIC') {
              return { ok: true };
            }
            const activeRecord = message.records[0];
            if (calls.length === 1) {
              fixture.strong.childNodes[0].nodeValue = 'Updated reasoning models';
            }
            return {
              ok: true,
              results: [
                {
                  id: activeRecord.id,
                  ok: true,
                  template: getReasoningTranslatedTemplate(activeRecord),
                },
              ],
            };
          },
        },
      };

      try {
        state.viewport.scanner.start(fixture.block);
        await flushMicrotasks(16);

        const translationCalls = calls.filter(
          (message) => message.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH'
        );
        assert.equal(translationCalls.length, 2);
        assert.deepEqual(
          translationCalls.map((message) => message.type),
          ['TRANSLATE_VISIBLE_BLOCK_BATCH', 'TRANSLATE_VISIBLE_BLOCK_BATCH']
        );
        assert.match(translationCalls[0].records[0].template, /Reasoning models/);
        assert.match(translationCalls[1].records[0].template, /Updated reasoning models/);
        assert.equal(calls[0].records[0].text, undefined);
        assert.equal(fixture.block.childNodes[0], fixture.link);
        assert.equal(
          fixture.block.textContent,
          'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.'
        );
        assert.deepEqual(state.session.progress().counts, {
          translated: 1,
          partial: 0,
          pending: 0,
          changed: 0,
          failed: 0,
        });
      } finally {
        state.viewport.scanner.stop();
        global.MutationObserver = previous.MutationObserver;
        global.chrome = previous.chrome;
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.window = previous.window;
      }
    },
  },
  {
    name: 'makes a final local diagnostic persistence attempt when stopping during retry backoff',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.requests[0].reject(new Error('transient'));
      await flushMicrotasks();
      assert.equal(run.timers.size, 1);
      run.admit();
      run.stop();
      assert.equal(run.state.session.status, 'stopped');
      assert.equal(run.requests.length, 3);
      assert.deepEqual(run.requests[1].message, run.requests[0].message);
      assert.notEqual(run.requests[2].message.diagnosticBatchId, run.requests[0].message.diagnosticBatchId);
      assert.equal(run.timers.size, 0);
      run.stop();
      assert.equal(run.requests.length, 3, 'repeated Stop does not resend final batches');
      run.requests[1].resolve({ ok: false });
      run.requests[2].reject(new Error('final failure'));
      await flushMicrotasks();
      assert.equal(run.timers.size, 0, 'Stop prevents subsequent retries');
      assert.doesNotMatch(helpers.getInlineTranslationStatusSnapshot(run.state).error, /Diagnostics could not be saved/);
    },
  },
  {
    name: 'flushes queued local diagnostics when stopping before a deferred flush',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.admit();
      run.requests[0].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal(run.timers.size, 1);
      run.stop();
      assert.equal(run.requests.length, 2);
      assert.equal(run.requests[1].message.diagnostics[0].code, 'runtime.unsupported_block');
      assert.equal(run.timers.size, 0);
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal(run.timers.size, 0);
    },
  },
  {
    name: 'drains queued local diagnostics without waiting for an active request on Stop',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.admit();
      run.stop();
      assert.equal(run.state.session.status, 'stopped', 'Stop completes with both responses pending');
      assert.equal(run.requests.length, 2, 'the active request is not resent');
      assert.notEqual(run.requests[0].message.diagnosticBatchId, run.requests[1].message.diagnosticBatchId);
      run.stop();
      assert.equal(run.requests.length, 2);
      run.requests[0].resolve({ ok: true });
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal(run.timers.size, 0);
    },
  },
  {
    name: 'does not resend an active diagnostic batch after a scan consumes a deferred flush',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.admit();
      run.requests[0].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal(run.timers.size, 1);
      await run.flush();
      assert.equal(run.requests.length, 2);
      run.stop();
      assert.equal(run.requests.length, 2, 'Stop leaves the already sent request alone');
      assert.equal(run.timers.size, 0);
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal(run.timers.size, 0);
    },
  },
  {
    name: 'sends diagnostics added during a request after that request succeeds',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.admit();
      await run.flush();
      assert.equal(run.requests.length, 1);
      run.requests[0].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal([...run.timers.values()][0].delay, 0);
      run.advance();
      assert.equal(run.requests.length, 2);
      assert.notEqual(run.requests[0].message.diagnosticBatchId, run.requests[1].message.diagnosticBatchId);
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.equal(run.timers.size, 0);
      assert.doesNotMatch(helpers.getInlineTranslationStatusSnapshot(run.state).error, /Diagnostics could not be saved/);
    },
  },
  ...['success', 'failure', 'rejection'].map((outcome) => ({
    name: `late local diagnostic ${outcome} preserves the new Operation display`,
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      const original = run.requests[0].message;
      run.stop();
      helpers.beginInlineTranslationOperation(run.state,
        inlineTranslationSession.createSettingsSnapshot({ targetLanguage: 'Japanese' }), run);
      run.state.message = 'Current operation progress';
      run.state.error = 'Current operation feedback';
      run.admit();
      await run.flush();
      const current = run.requests[1].message;
      assert.notEqual(original.operationId, current.operationId);
      assert.equal(original.settingsSnapshot.targetLanguage, 'Korean');
      assert.equal(current.settingsSnapshot.targetLanguage, 'Japanese');
      const before = helpers.getInlineTranslationStatusSnapshot(run.state);
      if (outcome === 'rejection') run.requests[0].reject(new Error('old send failed'));
      else run.requests[0].resolve({ ok: outcome === 'success' });
      await flushMicrotasks();
      assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(run.state), before);
      assert.equal(run.timers.size, 0);
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.deepEqual(helpers.getInlineTranslationStatusSnapshot(run.state), before);
    },
  })),
  {
    name: 'scanner and content Stop instruction use the local diagnostic transport',
    async fn() {
      await withFakeViewportDom(async () => {
        const run = createLocalDiagnosticLifecycle();
        const { document, element, text } = createTestDocument();
        const block = element('p', text('Visible prose before an interactive element.'),
          element('button', text('Action')));
        document.body.appendChild(block);
        document.documentElement = { clientWidth: 0, clientHeight: 0 };
        document.createRange = () => { throw new Error('range unavailable'); };
        global.document = document;
        global.HTMLElement = block.constructor;
        run.state.viewport.scanner.start(block);
        await flushMicrotasks();
        assert.equal(run.requests.length, 1, 'the scanner sends its local preflight rejection');
        assert.equal(run.requests[0].message.diagnostics[0].code, 'runtime.unsupported_block');
        run.requests[0].resolve({ ok: false });
        await flushMicrotasks();
        assert.equal([...run.timers.values()][0].delay, 250);
        const replies = [];
        helpers.handleInlineContentMessage(
          { type: 'RUN_INLINE_INSTRUCTION', instruction: 'stopInlineTranslation' },
          (reply) => replies.push(reply), run.state);
        assert.deepEqual(replies, [{ ok: true }]);
        assert.equal(run.state.session.status, 'stopped');
        assert.deepEqual(run.requests[1].message, run.requests[0].message);
        assert.equal(run.timers.size, 0);
        run.requests[1].resolve({ ok: true });
        await flushMicrotasks();
        assert.equal(block.textContent, 'Visible prose before an interactive element.Action');
      });
    },
  },
  {
    name: 'rejects stale viewport operation after stop or replacement',
    fn() {
      const state = createActiveInlineTranslationState();
      const store = state.viewport;
      const { operationId } = store;

      assert.equal(
        helpers.isInlineViewportOperationCurrent(state, store, operationId),
        true
      );

      helpers.stopInlineViewportTranslation(state);
      assert.equal(
        helpers.isInlineViewportOperationCurrent(state, store, operationId),
        false
      );

      helpers.beginInlineTranslationOperation(
        state,
        inlineTranslationSession.createSettingsSnapshot({})
      );
      assert.equal(
        helpers.isInlineViewportOperationCurrent(state, store, operationId),
        false
      );
    },
  },
  {
    name: 'reads a live run as one Start must rescan rather than start again',
    fn() {
      // Pressing Start on a run that is already under way is the only thing the reader can
      // do that would pay for the same page twice, so `translateInlinePage` rescans instead
      // whenever this holds. A stopped run no longer admits work; Start begins a new
      // operation while already submitted requests can still settle.
      const live = createActiveInlineTranslationState();
      assert.equal(helpers.isInlineTranslationRunLive(live), true);

      helpers.stopInlineViewportTranslation(live);
      assert.equal(helpers.isInlineTranslationRunLive(live), false);

      const stopped = createActiveInlineTranslationState();
      helpers.stopInlineViewportTranslation(stopped);
      assert.equal(helpers.isInlineTranslationRunLive(stopped), false);
      assert.equal(
        helpers.isInlineTranslationRunLive(helpers.createInlineTranslationState()),
        false
      );
    },
  },
  {
    name: 'grants each local diagnostic batch an independent retry',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.requests[0].reject(new Error('transient'));
      await flushMicrotasks();
      run.admit();
      await run.flush();
      assert.equal(run.requests.length, 1, 'queued work waits during retry backoff');
      run.advance();
      assert.deepEqual(run.requests[1].message, run.requests[0].message);
      run.requests[1].resolve({ ok: false });
      await flushMicrotasks();
      assert.match(helpers.getInlineTranslationStatusSnapshot(run.state).error, /Diagnostics could not be saved/);
      run.advance();
      assert.equal(run.requests.length, 3, 'the next batch follows a final failure');
      assert.notEqual(run.requests[2].message.diagnosticBatchId, run.requests[0].message.diagnosticBatchId);
      run.requests[2].resolve({ ok: false });
      await flushMicrotasks();
      run.advance();
      assert.equal(run.requests.length, 4, 'the next batch has its own retry');
      assert.deepEqual(run.requests[3].message, run.requests[2].message);
      run.requests[3].resolve({ ok: true });
      await flushMicrotasks();
      await run.flush();
      assert.equal(run.requests.length, 4);
      assert.equal(run.timers.size, 0);
    },
  },
  {
    name: 'does not warn when a local diagnostic retry succeeds',
    async fn() {
      const run = createLocalDiagnosticLifecycle();
      run.admit();
      await run.flush();
      run.requests[0].resolve({ ok: false });
      await flushMicrotasks();
      assert.doesNotMatch(helpers.getInlineTranslationStatusSnapshot(run.state).error, /Diagnostics could not be saved/);
      run.advance();
      assert.deepEqual(run.requests[1].message, run.requests[0].message);
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.doesNotMatch(helpers.getInlineTranslationStatusSnapshot(run.state).error, /Diagnostics could not be saved/);
      assert.equal(run.timers.size, 0);
    },
  },
  {
    name: 'formats viewport active status counts',
    fn() {
      const message = helpers.formatInlineViewportStatusMessage({
        translated: 18,
        partial: 0,
        pending: 4,
        changed: 3,
        failed: 1,
      });

      assert.equal(
        message,
        'Visible translation on\nTranslated 18 · Partial 0 · Pending 4 · Changed 3 · Failed 1'
      );
    },
  },
  {
    name: 'builds inline menu model from status and target language',
    fn() {
      assert.deepEqual(
        helpers.getInlineTranslatorUiModel(
          helpers.createInlineTranslationState({ menuOpen: true }),
          { targetLanguage: 'Japanese' }
        ),
        {
          toggleText: 'Translate',
          menuOpen: true,
          translateText: 'Page in Japanese',
          stopDisabled: true,
          restoreDisabled: true,
          expanded: 'true',
        }
      );

      assert.deepEqual(
        helpers.getInlineTranslatorUiModel(
          createActiveInlineTranslationState({ message: 'Visible translation on' }),
          { targetLanguage: 'Korean' }
        ),
        {
          toggleText: 'Translated',
          menuOpen: false,
          translateText: 'Scan visible text',
          stopDisabled: false,
          restoreDisabled: false,
          expanded: 'false',
        }
      );
    },
  },
  {
    name: 'keeps inline menu target language after restoring original text',
    fn() {
      const state = createActiveInlineTranslationState(
        { message: 'Visible translation on' },
        {
          targetLanguage: 'Japanese',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        }
      );

      helpers.restoreInlineOriginal(state);

      assert.equal(state.session.status, 'original');
      assert.equal(
        helpers.getInlineTranslatorUiModel(state).translateText,
        'Page in Japanese'
      );
    },
  },
  {
    name: 'refreshes inline menu target language when opening menu',
    async fn() {
      const messages = [];
      const state = helpers.createInlineTranslationState({
        translationSettings: {
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        },
      });
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            messages.push(value);
            return {
              ok: true,
              settings: {
                targetLanguage: 'Japanese',
                tone: 'technical',
                model: 'gpt-5.4-mini',
                apiKey: '***',
              },
            };
          },
        },
      };

      await helpers.toggleInlineTranslatorMenu(fakeChrome, state);

      assert.equal(state.menuOpen, true);
      assert.deepEqual(messages, [{ type: 'GET_SETTINGS' }]);
      assert.equal(
        helpers.getInlineTranslatorUiModel(state).translateText,
        'Page in Japanese'
      );
    },
  },
  {
    name: 'opens inline menu before target language refresh completes',
    async fn() {
      let resolveSettings;
      const state = helpers.createInlineTranslationState({
        translationSettings: {
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        },
      });
      const updates = [];
      const fakeChrome = {
        runtime: {
          async sendMessage() {
            return new Promise((resolve) => {
              resolveSettings = resolve;
            });
          },
        },
      };

      const toggle = helpers.toggleInlineTranslatorMenu(
        fakeChrome,
        state,
        () => updates.push(helpers.getInlineTranslatorUiModel(state))
      );

      assert.equal(state.menuOpen, true);
      assert.equal(updates.length, 1);
      assert.equal(updates[0].menuOpen, true);
      assert.equal(updates[0].translateText, 'Page in Korean');

      resolveSettings({
        ok: true,
        settings: {
          targetLanguage: 'Japanese',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          apiKey: '***',
        },
      });
      await toggle;

      assert.equal(updates.length, 2);
      assert.equal(updates[1].translateText, 'Page in Japanese');
    },
  },
  {
    name: 'formats stopped viewport status without pending work',
    fn() {
      const message = helpers.formatInlineViewportStatusMessage(
        {
          translated: 3,
          partial: 0,
          pending: 2,
          changed: 4,
          failed: 1,
        },
        'stopped'
      );

      assert.equal(
        message,
        'Visible translation stopped\nTranslated 3 · Partial 0 · Pending 0 · Changed 4 · Failed 1'
      );
    },
  },

];
