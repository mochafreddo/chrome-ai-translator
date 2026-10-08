const assert = require('node:assert/strict');
const { createReasoningFixture } = require('./inline-block.test');
const sessionModule = require('../extension/inline-translation-session');

async function flushMicrotasks(count = 256) {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function translatedTemplate(record) {
  const wrapper = record.contract.entries.find(entry => entry.kind === 'wrapper');
  const atom = record.contract.entries.find(entry => entry.kind === 'atom');
  return `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
}

// Only page DOM, messages, time and viewport events cross this adapter. Session and
// scanner state stay behind the same controls used by the production content adapter.
function createOperationFixture(options = {}) {
  const { createInlineTranslationOperation } = require('../extension/inline-translation-operation');
  const fixture = createReasoningFixture();
  const { document, block } = fixture;
  const timers = new Map();
  const listeners = new Map();
  const observers = new Set();
  const messages = [];
  const pending = [];
  const settingsRequests = [];
  const diagnosticRequests = [];
  const displaySettings = [];
  let nextTimer = 0;
  let clock = 1000;
  let settings = { apiKey: 'synthetic-test-key', ...(options.settings || {}) };
  let holdSettings = false;
  let holdDiagnostics = false;
  let warming = false;
  let root = document.body;
  document.documentElement = { clientWidth: 0, clientHeight: 0 };
  document.createRange = () => { throw new Error('range unavailable'); };
  const platform = {
    document, HTMLElement: block.constructor,
    window: {
      innerWidth: 500, innerHeight: 300,
      getComputedStyle: document.defaultView.getComputedStyle,
      addEventListener(type, callback) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(callback);
      },
      removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
    },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  };
  const adapters = {
    viewportPlatform: platform,
    now: () => clock,
    pickArticleRoot: () => root,
    onSettings: snapshot => displaySettings.push(snapshot),
    sendMessage(message) {
      messages.push(message);
      if (message.type === 'GET_SETTINGS') return holdSettings
        ? new Promise((resolve, reject) => settingsRequests.push({ resolve, reject }))
        : Promise.resolve({ ok: true, settings });
      if (message.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH') {
        if (warming) return Promise.resolve({ ok: true, results: message.records.map(({ id }) => ({
          id, disposition: 'reject', terminalCode: 'protocol.invalid_json', attemptCount: 1,
        })) });
        return new Promise((resolve, reject) => pending.push({ message, resolve, reject }));
      }
      return holdDiagnostics
        ? new Promise((resolve, reject) => diagnosticRequests.push({ message, resolve, reject }))
        : Promise.resolve({ ok: true });
    },
  };
  const operation = createInlineTranslationOperation(adapters);
  function advance() {
    const tasks = [...timers.values()];
    timers.clear();
    for (const task of tasks) task.callback();
  }
  function paragraph(cost) {
    const node = document.createElement('p');
    const length = cost - sessionModule.getRecordCost({ template: '', atoms: [] });
    node.textContent = 'An article sentence with ordinary prose. '.repeat(
      Math.ceil(length / 40)
    ).slice(0, length - 1) + '.';
    return node;
  }
  return {
    ...fixture, operation, adapters,
    createAnotherOperation: () => createInlineTranslationOperation(adapters), platform, timers, listeners, observers, messages,
    pending, settingsRequests, diagnosticRequests, displaySettings, paragraph, advance,
    setSettings(value) { settings = value; },
    holdSettings() { holdSettings = true; },
    holdDiagnostics() { holdDiagnostics = true; },
    setTime(value) { clock = value; },
    setRoot(value) { root = value; },
    setWarming(value) { warming = value; },
    async control(control, target = operation) { target[control](); await flushMicrotasks(); },
    async rescan() { operation.start(); advance(); await flushMicrotasks(); },
    viewportEvent(type = 'scroll') { for (const callback of listeners.get(type) || []) callback(); },
    async settle(index = 0, result = {}) {
      const request = pending[index];
      request.resolve({ ok: true, results: request.message.records.map(record => ({
        id: record.id, disposition: 'apply', attemptCount: 1,
        template: translatedTemplate(record), ...result,
      })) });
      await flushMicrotasks();
    },
  };
}

exports.name = 'inline translation operation';
exports.tests = [{
  name: 'Stop invalidates a pending Start without waiting for settings',
  async fn() {
    const f = createOperationFixture();
    f.holdSettings();
    f.operation.authorize();
    f.operation.start();
    assert.equal(f.settingsRequests.length, 1);
    f.operation.stop();
    const stopped = f.operation.getStatus();
    f.settingsRequests[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
    await flushMicrotasks();
    assert.deepEqual(f.operation.getStatus(), stopped);
    assert.equal(stopped.status, 'stopped');
    assert.equal(f.pending.length, 0);
    assert.equal(f.observers.size, 0);
  },
}];

exports.tests.push({
  name: 'Start sends admitted Semantic Blocks and applies the current response',
  async fn() {
    const f = createOperationFixture();
    try {
      await f.control('authorize');
      await f.control('start');
      assert.equal(f.pending.length, 1);
      assert.match(f.operation.getStatus().progress, /Pending 1/);
      await f.settle();
      assert.equal(f.block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
      assert.match(f.operation.getStatus().progress, /Translated 1/);
    } finally { f.operation.stop(); }
  },
});

exports.tests.push({
  name: 'Original text restores eligible DOM and retains cache on the next Start',
  async fn() {
    const f = createOperationFixture();
    const original = f.block.textContent;
    try {
      await f.control('authorize');
      await f.control('start');
      await f.settle();
      f.operation.restore();
      assert.equal(f.block.textContent, original);
      assert.deepEqual(f.operation.getStatus(), { status: 'original', progress: '', error: '' });
      await f.control('start');
      assert.equal(f.pending.length, 1);
      assert.match(f.block.textContent, /추론 모델/);
    } finally { f.operation.stop(); }
  },
});

async function withInlineRequestLifecycle(fn, { headroom = null } = {}) {
  const f = createOperationFixture();
  const operation = f.operation;
  const recordCost = sessionModule.getRecordCost(f.serialized);
  async function instruct(instruction, target = operation) {
    const control = {
      grantInlineTranslationAuthorization: 'authorize', startInlineTranslation: 'start',
      stopInlineTranslation: 'stop', restoreInlineOriginal: 'restore',
    }[instruction];
    await f.control(control, target);
  }
  try {
    f.setWarming(true);
    f.document.body.replaceChildren();
    let remaining = headroom === null ? 0 : 150000 - headroom * recordCost;
    while (remaining > 0) {
      const cost = Math.min(4000, remaining);
      f.document.body.appendChild(f.paragraph(cost));
      remaining -= cost;
    }
    await instruct('grantInlineTranslationAuthorization');
    await instruct('startInlineTranslation');
    assert.equal(operation.getStatus().status, 'active', operation.getStatus().error);
    assert.match(operation.getStatus().progress, /Pending 0/);
    if (headroom !== null) assert.match(operation.getStatus().error, /malformed or incomplete/);
    f.setWarming(false);
    f.document.body.replaceChildren(f.block);
    await f.rescan();
    assert.equal(f.pending.length, 1, 'the original Semantic Block request is admitted');
    await fn({ ...f, instruct, recordCost,
      viewportListeners: f.listeners, advanceScans: f.advance,
      holdSettings() { f.holdSettings(); return f.settingsRequests; },
    });
  } finally { operation.stop(); }
}

exports.tests.push(
  ...['stopInlineTranslation', 'restoreInlineOriginal', 'startInlineTranslation'].flatMap((control) =>
    ['failure', 'rejection'].map((outcome) => ({
      name: `discards superseded Start settings ${outcome} after ${control}`,
      async fn() {
        await withInlineRequestLifecycle(async ({ operation, pending, instruct, holdSettings, listeners }) => {
          await instruct('restoreInlineOriginal');
          const settings = holdSettings();
          await instruct('startInlineTranslation');
          await instruct(control);
          if (control === 'startInlineTranslation') {
            settings[1].resolve({ ok: false, error: { message: 'latest preparation failed' } });
            await flushMicrotasks(256);
            assert.equal(operation.getStatus().error, 'latest preparation failed');
          }
          const before = operation.getStatus();
          if (outcome === 'rejection') settings[0].reject(new Error('old preparation failed'));
          else settings[0].resolve({ ok: false, error: { message: 'old preparation failed' } });
          await flushMicrotasks(256);
          assert.deepEqual(operation.getStatus(), before);
          assert.equal(pending.length, 1);
        });
      },
    }))),
  ...['stopInlineTranslation', 'restoreInlineOriginal'].map((control) => ({
    name: `discards pending Start settings after ${control}`,
    async fn() {
      await withInlineRequestLifecycle(async ({ operation, pending, instruct, holdSettings, listeners }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdSettings();
        await instruct('startInlineTranslation');
        assert.equal(settings.length, 1);
        await instruct(control);
        const before = operation.getStatus();
        settings[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
        await flushMicrotasks(256);
        assert.deepEqual(operation.getStatus(), before);
        for (const registered of listeners.values()) assert.equal(registered.size, 0);
        assert.equal(pending.length, 1, 'superseded preparation cannot send another model request');
      });
    },
  })),
  {
    name: 'only the latest pending Start settings may begin an Inline Translation Operation',
    async fn() {
      await withInlineRequestLifecycle(async ({ operation, pending, instruct, holdSettings, listeners }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdSettings();
        await instruct('startInlineTranslation');
        await instruct('startInlineTranslation');
        assert.equal(settings.length, 2);
        const before = operation.getStatus();
        settings[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
        await flushMicrotasks(256);
        assert.deepEqual(operation.getStatus(), before);
        assert.equal(pending.length, 1);
        settings[1].resolve({ ok: true, settings: {
          apiKey: 'synthetic-test-key', targetLanguage: 'Japanese',
        } });
        await flushMicrotasks(256);
        assert.equal(operation.getStatus().status, 'active');
        assert.equal(pending.length, 2);
        assert.equal(pending[1].message.settingsSnapshot.targetLanguage, 'Japanese');
      });
    },
  },
  ...['success', 'missing key'].map((outcome) => ({
    name: `superseded Start settings ${outcome} preserves the latest preparation error`,
    async fn() {
      await withInlineRequestLifecycle(async ({ operation, pending, instruct, holdSettings, listeners }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdSettings();
        await instruct('startInlineTranslation');
        await instruct('startInlineTranslation');
        settings[1].resolve({ ok: false, error: { message: 'latest preparation failed' } });
        await flushMicrotasks(256);
        const before = operation.getStatus();
        assert.equal(before.error, 'latest preparation failed');
        settings[0].resolve({ ok: true, settings: outcome === 'success'
          ? { apiKey: 'synthetic-test-key' } : {} });
        await flushMicrotasks(256);
        assert.deepEqual(operation.getStatus(), before);
        assert.equal(pending.length, 1);
      });
    },
  })),
  ...['failure', 'rejection', 'missing key'].map((outcome) => ({
    name: `latest Start settings ${outcome} remains visible`,
    async fn() {
      await withInlineRequestLifecycle(async ({ operation, pending, instruct, holdSettings, listeners }) => {
        await instruct('restoreInlineOriginal');
        const settings = holdSettings();
        await instruct('startInlineTranslation');
        if (outcome === 'rejection') settings[0].reject(new Error('latest preparation failed'));
        else settings[0].resolve(outcome === 'missing key' ? { ok: true, settings: {} }
          : { ok: false, error: { message: 'latest preparation failed' } });
        await flushMicrotasks(256);
        const snapshot = operation.getStatus();
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
      await withInlineRequestLifecycle(async ({ operation, block, pending, instruct, document, paragraph, recordCost, advanceScans, timers, holdSettings }) => {
        const settings = holdSettings();
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
          template: translatedTemplate(request.message.records[0]),
        }] });
        await flushMicrotasks(256);
        assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
        assert.equal(operation.getStatus().progress.includes('Translated 1'), true);
        assert.equal(pending.length, 2);
      });
    },
  },
  ...['stopInlineTranslation', 'restoreInlineOriginal'].map((control) => ({
    name: `content ${control} closes the scanner before the next operation`,
    async fn() {
      await withInlineRequestLifecycle(async ({ operation, instruct, timers, observers, viewportListeners, pending }) => {
        assert.equal(observers.size, 1);
        for (const listeners of viewportListeners.values()) assert.equal(listeners.size, 1);
        await instruct('startInlineTranslation');
        assert.equal(timers.size, 1);
        const lateScan = [...timers.values()][0].callback;
        const lateChange = [...viewportListeners.get('scroll')][0];
        await instruct(control);
        assert.equal(timers.size, 0);
        assert.equal(observers.size, 0);
        for (const listeners of viewportListeners.values()) assert.equal(listeners.size, 0);
        const progress = operation.getStatus();
        lateScan(); lateChange();
        await flushMicrotasks();
        assert.equal(pending.length, 1);
        assert.deepEqual(operation.getStatus(), progress);
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
      await withInlineRequestLifecycle(async ({ block, strong, link, document, operation, messages, pending, instruct, paragraph, recordCost, rescan }) => {
        const originalText = block.textContent;
        const originalChildren = [...block.childNodes];
        const request = pending[0];
        const record = request.message.records[0];
        // Keep the old block offscreen so restarting cannot submit it a second time.
        block.rect = { top: 2000, bottom: 2024, left: 10, right: 300, width: 290, height: 24 };
        for (const control of controls) await instruct(control);
        const before = operation.getStatus();
        const statusBefore = operation.getStatus();
        request.resolve({ ok: true, results: [{
          id: record.id,
          disposition: 'apply',
          template: translatedTemplate(record),
          attemptCount,
          correlationToken: 'lifecycle-token',
        }] });
        await flushMicrotasks(32);

        if (controls.length) {
          assert.equal(block.textContent, originalText);
          assert.deepEqual(block.childNodes, originalChildren);
          assert.deepEqual(operation.getStatus(), before);
          assert.deepEqual(operation.getStatus(), statusBefore);
          assert.equal(pending.length, 1, 'obsolete work cannot re-enter the queue');
        } else {
          assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
          assert.equal(operation.getStatus().progress.includes('Translated 1'), true);
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

        if (operation.getStatus().status !== 'active') await instruct('startInlineTranslation');
        const next = paragraph(recordCost);
        document.body.appendChild(next);
        rescan(operation);
        await flushMicrotasks(32);
        if (headroom <= attemptCount) {
          assert.equal(pending.length, 1, 'reported repair must refuse the next request');
          assert.match(operation.getStatus().error, /reached this page visit's limit/);
        } else {
          assert.equal(pending.length, 2, 'only reported attempts consume the remaining room');
          // Its initial charge must consume the remaining room, even before a response.
          document.body.appendChild(paragraph(recordCost));
          rescan(operation);
          await flushMicrotasks();
          assert.equal(pending.length, 2, 'initial requests are charged at assembly');
        }
      }, { headroom });
    },
  })),
  {
    name: 'settles only originating records once despite duplicate and unrelated repair results',
    async fn() {
      await withInlineRequestLifecycle(async ({ document, operation, pending, paragraph, recordCost, rescan }) => {
        const request = pending[0];
        const { id } = request.message.records[0];
        const repaired = { id, disposition: 'reject', terminalCode: 'protocol.invalid_json', attemptCount: 2 };
        request.resolve({ ok: true, results: [
          { ...repaired, id: 'unrelated-record' }, repaired, repaired,
        ] });
        await flushMicrotasks(32);
        document.body.appendChild(paragraph(recordCost));
        rescan(operation);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'one reported repair leaves room for one more record');
        document.body.appendChild(paragraph(recordCost));
        rescan(operation);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'the matching rejected repair still costs one attempt');
      }, { headroom: 3 });
    },
  },
  ...['request error', 'unsuccessful batch', 'missing results'].map((failure) => ({
    name: `retains initial Session Budget through the request caller after ${failure}`,
    async fn() {
      await withInlineRequestLifecycle(async ({ block, document, operation, pending, instruct, paragraph, recordCost, rescan }) => {
        if (failure === 'request error') pending[0].reject(new Error('synthetic transport failure'));
        else pending[0].resolve(failure === 'unsuccessful batch'
          ? { ok: false, results: [{ id: pending[0].message.records[0].id, attemptCount: 2 }] }
          : { ok: true });
        await flushMicrotasks(32);
        assert.match(operation.getStatus().error, /translation request could not be completed/);
        assert.equal(operation.getStatus().progress.includes('Pending 0'), true);
        block.rect = { top: 2000, bottom: 2024, left: 10, right: 300, width: 290, height: 24 };
        await instruct('restoreInlineOriginal');
        await instruct('startInlineTranslation');
        document.body.appendChild(paragraph(recordCost));
        rescan(operation);
        await flushMicrotasks();
        assert.equal(pending.length, 2, 'failure retains the initial cost without guessing a repair');
        document.body.appendChild(paragraph(recordCost));
        rescan(operation);
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
      result: (record) => ({ disposition: 'apply', template: translatedTemplate(record), attemptCount: 1 }),
      sent: [{ outcomes: [], releaseTokens: ['outcome-token'] }],
    },
    {
      name: 'a changed block no retry supersedes',
      change: ({ document }) => document.body.replaceChildren(),
      result: (record) => ({ disposition: 'apply', template: translatedTemplate(record), attemptCount: 1 }),
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
      await withInlineRequestLifecycle(async ({ block, operation, pending, instruct, createAnotherOperation }) => {
        const record = pending[0].message.records[0];
        pending[0].resolve({ ok: true, results: [{
          id: record.id, disposition: 'apply', attemptCount: 2,
          template: translatedTemplate(record),
        }] });
        await flushMicrotasks(32);
        const translated = block.textContent;
        assert.match(translated, /추론 모델/);
        await instruct('restoreInlineOriginal');
        await instruct('startInlineTranslation');
        assert.equal(pending.length, 1, 'historical repair metadata sends no new request');
        assert.equal(block.textContent, translated);
        await instruct('restoreInlineOriginal');
        const fresh = createAnotherOperation();
        try {
          await instruct('grantInlineTranslationAuthorization', fresh);
          await instruct('startInlineTranslation', fresh);
          assert.equal(pending.length, 2, 'a fresh content-side lifetime admits the same page');
        } finally {
          fresh.stop();
        }
      }, { headroom: 2 });
    },
  },
);

exports.createOperationFixture = createOperationFixture;
exports.flushMicrotasks = flushMicrotasks;

exports.tests.push(
  {
    name: 'expired Authorization rejects a new Start but permits an active rescan',
    async fn() {
      const f = createOperationFixture();
      try {
        f.operation.start();
        assert.match(f.operation.getStatus().error, /authorize inline translation/);
        assert.equal(f.messages.length, 0);
        f.operation.authorize();
        f.setTime(1000 + 5 * 60 * 1000);
        f.operation.start();
        assert.equal(f.messages.length, 0, 'the grant is expired at its exact boundary');
        await f.control('authorize');
        await f.control('start');
        f.setTime(1000 + 10 * 60 * 1000);
        f.holdSettings();
        f.document.body.appendChild(f.paragraph(300));
        await f.rescan();
        assert.equal(f.settingsRequests.length, 0);
        assert.equal(f.pending.length, 2);
        await f.settle();
        assert.match(f.block.textContent, /추론 모델/);
        f.operation.stop();
        f.operation.start();
        assert.match(f.operation.getStatus().error, /authorize inline translation/);
        assert.equal(f.settingsRequests.length, 0);
      } finally { f.operation.stop(); }
    },
  },
  {
    name: 'a missing article root reports startup failure before admitting work',
    async fn() {
      const f = createOperationFixture();
      f.setRoot(null);
      await f.control('authorize');
      await f.control('start');
      assert.deepEqual(f.operation.getStatus(), {
        status: 'original', progress: '', error: 'No article content found.',
      });
      assert.equal(f.pending.length, 0);
      assert.equal(f.observers.size, 0);
    },
  },
  ...['success', 'failure', 'rejection'].map(outcome => ({
    name: `an older settings ${outcome} cannot replace an already active latest Start`,
    async fn() {
      const f = createOperationFixture();
      try {
        f.holdSettings();
        f.operation.authorize();
        f.operation.start();
        f.operation.start();
        f.settingsRequests[1].resolve({ ok: true, settings: {
          apiKey: 'synthetic-test-key', targetLanguage: 'Japanese',
        } });
        await flushMicrotasks();
        const before = f.operation.getStatus();
        if (outcome === 'rejection') f.settingsRequests[0].reject(new Error('obsolete settings failed'));
        else f.settingsRequests[0].resolve(outcome === 'failure'
          ? { ok: false, error: { message: 'obsolete settings failed' } }
          : { ok: true, settings: { apiKey: 'synthetic-test-key', targetLanguage: 'Korean' } });
        await flushMicrotasks();
        assert.deepEqual(f.operation.getStatus(), before);
        assert.equal(f.pending.length, 1);
        assert.equal(f.pending[0].message.settingsSnapshot.targetLanguage, 'Japanese');
        assert.equal(f.observers.size, 1);
        assert.equal(f.displaySettings.length, 1);
      } finally { f.operation.stop(); }
    },
  })),
  ...['local', 'runtime'].flatMap(kind => ['success', 'failure', 'rejection'].map(outcome => ({
    name: `late ${kind} diagnostic ${outcome} leaves the latest Operation feedback intact`,
    async fn() {
      const f = createOperationFixture();
      f.holdDiagnostics();
      try {
        if (kind === 'local') {
          const button = f.document.createElement('button');
          button.textContent = 'Action';
          f.block.appendChild(button);
        }
        await f.control('authorize');
        await f.control('start');
        if (kind === 'runtime') await f.settle(0, { correlationToken: 'runtime-test-token' });
        assert.equal(f.diagnosticRequests.length, 1);
        await f.control('stop');
        await f.control('start');
        const before = f.operation.getStatus();
        const old = f.diagnosticRequests[0];
        if (outcome === 'rejection') old.reject(new Error('old diagnostics failed'));
        else old.resolve({ ok: outcome === 'success' });
        await flushMicrotasks();
        assert.deepEqual(f.operation.getStatus(), before);
        assert.equal(f.timers.size, 0);
        if (kind === 'runtime') {
          assert.equal(f.pending.length, 1, 'diagnostic failure cannot requeue settled work');
          assert.match(f.block.textContent, /추론 모델/);
        }
      } finally { f.operation.stop(); }
    },
  }))),
  {
    name: 'Stop cancels a diagnostic retry timer and sends its final attempt',
    async fn() {
      const f = createOperationFixture();
      f.holdDiagnostics();
      const button = f.document.createElement('button');
      button.textContent = 'Action';
      f.block.appendChild(button);
      await f.control('authorize');
      await f.control('start');
      f.diagnosticRequests[0].resolve({ ok: false });
      await flushMicrotasks();
      assert.equal(f.timers.size, 1);
      const scanCallbacks = [...f.observers].map(observer => observer.callback);
      f.operation.stop();
      const before = f.operation.getStatus();
      assert.equal(f.timers.size, 0);
      assert.equal(f.observers.size, 0);
      assert.deepEqual(f.diagnosticRequests[1].message, f.diagnosticRequests[0].message);
      for (const callback of scanCallbacks) callback();
      f.diagnosticRequests[1].reject(new Error('final diagnostic attempt failed'));
      await flushMicrotasks();
      assert.deepEqual(f.operation.getStatus(), before);
      assert.equal(f.pending.length, 0);
      assert.equal(f.timers.size, 0);
    },
  },
  {
    name: 'current runtime diagnostic failure reports feedback without retrying settled work',
    async fn() {
      const f = createOperationFixture();
      f.holdDiagnostics();
      try {
        await f.control('authorize');
        await f.control('start');
        await f.settle(0, { correlationToken: 'current-runtime-token' });
        f.diagnosticRequests[0].resolve({ ok: false });
        await flushMicrotasks();
        assert.match(f.operation.getStatus().error, /Diagnostics could not be saved/);
        assert.match(f.operation.getStatus().progress, /Translated 1.*Pending 0/);
        assert.equal(f.pending.length, 1);
        assert.match(f.block.textContent, /추론 모델/);
      } finally { f.operation.stop(); }
    },
  },
);

exports.tests.push({
  name: 'Original text preserves an existing diagnostic retry without restoring its feedback ownership',
  async fn() {
    const f = createOperationFixture();
    f.holdDiagnostics();
    const button = f.document.createElement('button');
    button.textContent = 'Action';
    f.block.appendChild(button);
    await f.control('authorize');
    await f.control('start');
    f.diagnosticRequests[0].resolve({ ok: false });
    await flushMicrotasks();
    f.operation.restore();
    const original = f.operation.getStatus();
    assert.equal(f.diagnosticRequests.length, 1, 'Original text does not send a Stop-time final attempt');
    f.advance();
    await flushMicrotasks();
    assert.equal(f.diagnosticRequests.length, 2, 'the existing diagnostic retry still executes');
    assert.deepEqual(f.diagnosticRequests[1].message, f.diagnosticRequests[0].message);
    f.diagnosticRequests[1].reject(new Error('old diagnostic retry failed'));
    await flushMicrotasks();
    assert.deepEqual(f.operation.getStatus(), original);
    assert.deepEqual(original, { status: 'original', progress: '', error: '' });
    assert.equal(f.pending.length, 0);
  },
});
