const assert = require('node:assert/strict');
const { createTestDocument } = require('./inline-block.test');
const sessions = require('../extension/inline-translation-session');
const { createInlineLocalDiagnosticTransport } = require('../extension/inline-local-diagnostic-transport');
async function flushMicrotasks() { for (let i = 0; i < 8; i += 1) await Promise.resolve(); }
function admitUnsupported(state) {
  const { document, element, text } = createTestDocument();
  const block = element('li', text('Outer prose.'), element('p', text('Nested prose.')),
    text(' Outer prose continues.'));
  document.body.appendChild(block);
  state.session.admit(block);
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
  const session = sessions.createInlineTranslationSession();
  session.begin({});
  let unavailable = false;
  let stopped = false;
  const transport = createInlineLocalDiagnosticTransport({
    outbox: session.outbox, operationId: session.operationId,
    settingsSnapshot: sessions.createSettingsSnapshot({}), ...adapters,
    onUnavailable() { unavailable = true; },
  });
  return {
    ...adapters,
    admit: () => admitUnsupported({ session }),
    flush: transport.flush,
    stop() { stopped = true; transport.stop(); },
    stopped: () => stopped,
    feedback: () => unavailable ? 'Diagnostics could not be saved.' : '',
  };
}
exports.name = 'inline local diagnostic transport';
exports.tests = [
  {
    name: 'sends the Session outbox through the local diagnostic transport interface',
    async fn() {
      const adapters = createLocalDiagnosticAdapters();
      const state = { session: sessions.createInlineTranslationSession() };
      state.session.begin({});
      const settingsSnapshot = sessions.createSettingsSnapshot({});
      const transport = createInlineLocalDiagnosticTransport({
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
      assert.equal(run.stopped(), true);
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
      assert.match(run.feedback(), /Diagnostics could not be saved/, 'final failure still notifies its owner');
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
      assert.equal(run.stopped(), true, 'Stop completes with both responses pending');
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
      assert.doesNotMatch(run.feedback(), /Diagnostics could not be saved/);
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
      assert.match(run.feedback(), /Diagnostics could not be saved/);
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
      assert.doesNotMatch(run.feedback(), /Diagnostics could not be saved/);
      run.advance();
      assert.deepEqual(run.requests[1].message, run.requests[0].message);
      run.requests[1].resolve({ ok: true });
      await flushMicrotasks();
      assert.doesNotMatch(run.feedback(), /Diagnostics could not be saved/);
      assert.equal(run.timers.size, 0);
    },
  },
];
