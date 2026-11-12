const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const helpers = require('../extension/sidepanel.js');
const { createTestDocument } = require('./inline-block.test');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 64; i += 1) await Promise.resolve();
}
function wireState(value, stateSequence = 1, workerEpoch = 'worker-fixture') {
  return { workerEpoch, stateSequence, ...value };
}
function state(label) {
  return { workerEpoch: 'worker-fixture', stateSequence: 1,
    inlineTranslationError: { message: 'shortcut ' + label } };
}
function response(type, label) {
  return type === 'GET_STATE' ? { ok: true, state: state(label) }
    : { ok: true, snapshot: { status: 'active', progress: `inline ${label}`, error: '' } };
}
function domPanel() {
  const { document } = createTestDocument();
  const elements = new Map();
  const sent = [];
  let active = 1;
  let committed;
  let settingsChanged;
  let settings = {};
  let frameId = 'doc-1';
  let getFrame = async () => ({ documentId: frameId });
  let poll;
  let activated;
  let notified;
  let focused;
  let send = (message) => response(message.type, String(message.tabId));
  function element(id) {
    if (!elements.has(id)) elements.set(id, Object.assign(document.createElement('div'), { value: '', hidden: false,
      disabled: false, listeners: {}, attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { focused = id; },
      addEventListener(type, listener) { this.listeners[type] = listener; } }));
    return elements.get(id);
  }
  const chrome = {
    webNavigation: { getFrame: (...args) => getFrame(...args),
      onCommitted: { addListener(fn) { committed = fn; } } },
    storage: { onChanged: { addListener(fn) { settingsChanged = fn; } } },
    windows: { getCurrent: async () => ({ id: 10 }) },
    tabs: { query: async () => [{ id: active, windowId: 10 }],
      onActivated: { addListener(listener) { activated = listener; } } },
    runtime: { onMessage: { addListener(listener) { notified = listener; } },
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'GET_SETTINGS') return { ok: true, settings };
        return send(message);
      } },
  };
  const tabs = ['translated', 'original'].map((name) => {
    const tab = element(`tab-${name}`);
    tab.dataset = { tab: name };
    return tab;
  });
  const context = vm.createContext({ chrome, document: { getElementById: element, querySelectorAll: () => tabs,
    createElement: tag => document.createElement(tag) },
    setInterval(callback, delay) { assert.equal(delay, 1000); poll = callback; },
    ChromeAiTranslatorInlineTranslationControls: require('../extension/inline-translation-controls.js'),
    ChromeAiTranslatorPageAccess: require('../extension/page-access.js'),
    ChromeAiTranslatorDefaultModel: require('../extension/default-model.js'),
 });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/sidepanel.js'), 'utf8'), context);
  return { element, sent, focused: () => focused, setSend(fn) { send = fn; }, poll() { poll(); },
    activate(id, windowId = 10) { active = windowId === 10 ? id : active; activated?.({ tabId: id, windowId }); },
    setFrame(fn) { getFrame = fn; },
    changeSettings(value, notify = true) { settings = value; if (notify) settingsChanged?.({ settings: {} }, 'local'); },
    navigate(id) { frameId = id; committed?.({ tabId: active, frameId: 0, documentId: id }); },
    notify(msg) { notified({ ...msg, state: { documentId: frameId, ...msg.state } }); } };
}
exports.name = 'sidepanel tab state';
exports.tests = [
{
    name: 'activation cannot publish an old Inline error or forward a click while its document is unknown',
    async fn() {
      const panel = domPanel();
      await settle();
      const activation = deferred();
      let reads = 0;
      panel.setFrame(() => ++reads === 1 ? activation.promise : Promise.resolve({ documentId: 'replacement' }));
      panel.activate(2);
      panel.notify({ type: 'STATE_UPDATED', tabId: 2, state: { ...state('departed'), documentId: 'old-document' } });
      await settle();
      assert.doesNotMatch(panel.element('inlineError').textContent, /departed/);
      panel.element('btnInlineTranslate').listeners.click();
      panel.element('btnInlineTranslate').listeners.click();
      await settle();
      assert.equal(panel.sent.some(msg => ['RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)), false);
      activation.resolve({ documentId: 'replacement' });
      await settle();
      panel.element('btnInlineTranslate').listeners.click();
      await settle();
      assert.equal(panel.sent.find(msg => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL').documentId, 'replacement');
    },
  },
{
    name: 'same-tab document replacement clears the old Inline error and ignores old document notifications',
    async fn() {
      const panel = domPanel();
      await settle();
      const next = deferred();
      panel.setSend(() => next.promise);
      panel.navigate('doc-2');
      assert.doesNotMatch(panel.element('inlineError').textContent, /shortcut 1/);
      panel.notify({ type: 'STATE_UPDATED', tabId: 1, state: { ...state('departed'), documentId: 'doc-1' } });
      assert.doesNotMatch(panel.element('inlineError').textContent, /departed/);
      next.resolve({ ok: false });
      await settle();
    },
  },
{
    name: 'a poll preserves both inline live region text nodes when their messages are unchanged',
    async fn() {
      const panel = domPanel();
      await settle();
      const ids = ['inlineStatus', 'inlineError'];
      const nodes = ids.map(id => panel.element(id).childNodes[0]);
      assert.ok(nodes.every(Boolean));
      panel.poll();
      await settle();
      ids.forEach((id, index) => assert.equal(panel.element(id).childNodes[0], nodes[index]));
    },
  },
{
    name: 'actual panel shows initialization recovery instead of asking for page access',
    async fn() {
      const panel = domPanel();
      await settle();
      const message = 'Initialization failed. Reload the extension and this page.';
      panel.setSend((request) => request.type === 'GET_STATE'
        ? { ok: true, state: wireState({ status: 'idle', inlineTranslationError: {
          code: 'content_script_not_ready', message,
        } }) }
        : { ok: false, snapshot: null });

      panel.poll();
      await settle();

      assert.equal(panel.element('inlineError').textContent, message);
      assert.equal(panel.element('inlineStatus').textContent, '');
      assert.equal(panel.element('btnInlineTranslate').disabled, true);

      panel.setSend((request) => request.type === 'GET_STATE'
        ? { ok: true, state: wireState({ status: 'idle', inlineTranslationError: null }) }
        : { ok: true, snapshot: { status: 'original', progress: '', error: '' } });
      panel.poll();
      await settle();
      assert.equal(panel.element('inlineError').textContent, '');
      assert.equal(panel.element('btnInlineTranslate').disabled, false);
    },
  },
...['GET_STATE', 'GET_INLINE_TRANSLATION_STATE'].map((type) => ({
    name: `actual panel rejects delayed ${type} from the previous tab`,
    async fn() {
      const panel = domPanel();
      await settle();
      const old = deferred();
      panel.setSend((message) => message.type === type && message.tabId === 1
        ? old.promise : response(message.type, String(message.tabId)));
      panel.poll();
      await settle();
      panel.activate(2);
      panel.poll();
      await settle();
      old.resolve(response(type, 'old A'));
      await settle();
      assert.equal(panel.element('inlineError').textContent, 'shortcut 2');
      assert.equal(panel.element('inlineStatus').textContent, 'inline 2');
      assert.equal(panel.element('inlineError').textContent, 'shortcut 2');

    },
  }))
];

function modulePanel() {
  let active = 1;
  let displayed;
  let renders = 0;
  let query = async () => ({ id: active });
  let send = (message) => response(message.type, String(message.tabId));
  const sent = [];
  const controller = helpers.createTabStateController({
    queryActiveTab: async () => {
      const tab = await query();
      return tab ? { ...tab, documentId: 'doc-' + tab.id } : null;
    },
    readDocumentId: async tabId => 'doc-' + tabId,
    sendMessage(message) { sent.push(message); return send(message); },
    render(display) { displayed = display; renders += 1; },
  });
  const receive = controller.receive;
  controller.receive = msg => receive({ ...msg, state: { documentId: 'doc-' + msg.tabId, ...msg.state } });
  return { controller, sent, display: () => displayed, renderCount: () => renders,
    setQuery(fn) { query = fn; }, setSend(fn) { send = fn; },
    activate(id, windowId = 10) { if (windowId === 10) active = id; return controller.activate({ tabId: id, windowId }); } };
}

exports.tests.push({
  name: 'Inline control requires another click when its query discovers a different tab',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    panel.setQuery(async () => ({ id: 2 }));
    panel.setSend(msg => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { ok: false, error: { message: 'new tab control failed' } }
      : response(msg.type, '2'));
    await panel.controller.runInlineControl('START');
    assert.deepEqual(panel.sent.filter(msg => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'), []);
    await panel.controller.runInlineControl('START');
    assert.equal(panel.sent.find(msg => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL').documentId, 'doc-2');
    assert.equal(panel.display().tabId, 2);
    assert.equal(panel.display().inline.controlError, 'new tab control failed');
  },
});

;

exports.tests.push(
{
  name: 'an accepted same-worker notification renders the panel once',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const before = panel.renderCount();
    panel.controller.receive({ type: 'STATE_UPDATED', tabId: 1,
      state: wireState({ status: 'done', inlineTranslationError: { message: 'current result' } }, 2) });
    assert.equal(panel.renderCount() - before, 1);
    assert.equal(panel.display().state.inlineTranslationError?.message, 'current result');
  },
},
{
  name: 'uses worker sequence for same-epoch replies even when requests started in reverse order',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const old = deferred();
    panel.setSend(msg => msg.type === 'GET_STATE' ? old.promise : response(msg.type, 'inline'));
    const pending = panel.controller.refresh();
    await settle();
    panel.setSend(msg => msg.type === 'GET_STATE'
      ? { ok: true, state: wireState({ status: 'done', inlineTranslationError: { message: 'third' } }, 3) } : response(msg.type, 'inline'));
    await panel.controller.refresh();
    old.resolve({ ok: true, state: wireState({ status: 'done', inlineTranslationError: { message: 'fourth' } }, 4) });
    await pending;
    assert.equal(panel.display().state.inlineTranslationError?.message, 'fourth');
  },
},
{
  name: 'confirms an unseen worker epoch and never readmits retired worker replies or notifications',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const old = deferred();
    const fresh = deferred();
    let calls = 0;
    panel.setSend(msg => msg.type === 'GET_STATE'
      ? (++calls === 1 ? old.promise : fresh.promise) : response(msg.type, 'independent'));
    const poll = panel.controller.refresh();
    await settle();
    panel.controller.receive({ type: 'STATE_UPDATED', tabId: 1,
      state: { status: 'translating', workerEpoch: 'worker-new', stateSequence: 1 } });
    await settle();
    assert.equal(calls, 2);
    assert.equal(panel.display().state.workerEpoch, 'worker-fixture');
    fresh.resolve({ ok: true, state: wireState({ status: 'done', inlineTranslationError: { message: 'new worker result' } }, 2, 'worker-new') });
    await settle();
    old.resolve({ ok: true, state: wireState({ status: 'done', inlineTranslationError: { message: 'late old reply' } }, 999) });
    await poll;
    panel.controller.receive({ type: 'STATE_UPDATED', tabId: 1,
      state: wireState({ status: 'done', inlineTranslationError: { message: 'late old notification' } }, 1000) });
    assert.equal(calls, 2);
    assert.equal(panel.display().state.inlineTranslationError?.message, 'new worker result');
    panel.setSend(msg => msg.type === 'GET_STATE'
      ? { ok: true, state: wireState({ status: 'done', inlineTranslationError: { message: 'new worker result' } }, 2, 'worker-new') }
      : response(msg.type, 'independent'));
    panel.controller.receive({ type: 'STATE_UPDATED', tabId: 1,
      state: wireState({ status: 'done', inlineTranslationError: { message: 'unseen old notification' } }, 9000, 'worker-unseen') });
    await settle();
    assert.equal(panel.display().state.workerEpoch, 'worker-new');
    assert.equal(panel.display().state.inlineTranslationError?.message, 'new worker result');
  },
},
{
  name: 'new control clears its predecessor error before its tab query answers',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    panel.setSend(() => ({ ok: false, error: { message: 'previous control failed' } }));
    await panel.controller.runInlineControl('START');
    assert.equal(panel.display().inline.controlError, 'previous control failed');
    const query = deferred();
    panel.setQuery(() => query.promise);
    const next = panel.controller.runInlineControl('STOP');
    assert.equal(panel.display().inline.controlError, '');
    query.resolve({ id: 1 });
    await next;
  },
}
);

exports.tests.push(...['failure', 'rejection'].flatMap((outcome) =>
  ['tab query', 'response', 'success'].map((waiting) => ({
    name: `old control ${outcome} cannot alter the latest control during ${waiting}`,
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      const old = deferred();
      panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
        ? old.promise : response(msg.type, 'current'));
      const first = panel.controller.runInlineControl('START');
      await settle();
      const next = deferred();
      if (waiting === 'tab query') panel.setQuery(() => next.promise);
      panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
        ? waiting === 'success' ? { ok: true } : next.promise
        : response(msg.type, 'latest'));
      // Repeated Start must have distinct ownership just like Start then Stop.
      const latest = panel.controller.runInlineControl(waiting === 'success' ? 'START' : 'STOP');
      await settle();
      if (waiting === 'success') await latest;
      const before = panel.display();
      if (outcome === 'rejection') old.reject(new Error('old control failed'));
      else old.resolve({ ok: false, error: { message: 'old control failed' } });
      await first;
      assert.deepEqual(panel.display(), before);
      next.resolve(waiting === 'tab query' ? { id: 1 } : { ok: true });
      await latest;
    },
  }))));

exports.tests.push({
  name: 'old control success cannot erase the latest failure through access recovery',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    panel.setSend((msg) => msg.type === 'GET_INLINE_TRANSLATION_STATE'
      ? { ok: false } : response(msg.type, 'unreachable'));
    await panel.controller.refresh();
    const old = deferred();
    panel.setSend(() => old.promise);
    const first = panel.controller.runInlineControl('START');
    await settle();
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { ok: false, error: { message: 'latest control failed' } }
      : response(msg.type, 'old success'));
    await panel.controller.runInlineControl('STOP');
    const before = panel.display();
    const messages = panel.sent.length;
    old.resolve({ ok: true });
    await first;
    assert.deepEqual(panel.display(), before);
    assert.equal(panel.sent.length, messages);
  },
});

exports.tests.push(...['GET_STATE', 'GET_INLINE_TRANSLATION_STATE'].flatMap((type) =>
  ['tab query', 'failure', 'success'].map((latestStage) => ({
    name: `old control follow-up ${type} cannot alter the latest control during ${latestStage}`,
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      panel.setSend((msg) => msg.type === 'GET_INLINE_TRANSLATION_STATE'
        ? { ok: false } : response(msg.type, 'unreachable'));
      await panel.controller.refresh();
      const followUp = deferred();
      panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
        ? { ok: true } : msg.type === type ? followUp.promise : response(msg.type, 'first'));
      const first = panel.controller.runInlineControl('START');
      await settle();
      const query = deferred();
      if (latestStage === 'tab query') panel.setQuery(() => query.promise);
      panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
        ? latestStage === 'success' ? { ok: true }
          : { ok: false, error: { message: 'latest control failed' } }
        : response(msg.type, 'latest'));
      const latest = panel.controller.runInlineControl('STOP');
      await settle();
      if (latestStage !== 'tab query') await latest;
      const before = panel.display();
      followUp.resolve(response(type, 'old success'));
      await first;
      assert.deepEqual(panel.display(), before);
      query.resolve({ id: 1 });
      await latest;
    },
  }))));

exports.tests.push(...['failure', 'rejection'].map((outcome) => ({
  name: `actual Inline Translation buttons ignore superseded same-tab ${outcome}`,
  async fn() {
    const panel = domPanel();
    await settle();
    const old = deferred();
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? old.promise : response(msg.type, 'current'));
    panel.element('btnInlineTranslate').listeners.click();
    await settle();
    const latest = deferred();
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? latest.promise : response(msg.type, 'latest'));
    panel.element('btnInlineRestore').listeners.click();
    await settle();
    latest.resolve({ ok: false, error: { message: 'latest control failed' } });
    await settle();
    const before = ['inlineStatus', 'inlineError', 'btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore']
      .map((id) => ({ ...panel.element(id) }));
    if (outcome === 'rejection') old.reject(new Error('old control failed'));
    else old.resolve({ ok: false, error: { message: 'old control failed' } });
    await settle();
    assert.deepEqual(['inlineStatus', 'inlineError', 'btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore']
      .map((id) => ({ ...panel.element(id) })), before);
    assert.equal(panel.element('inlineError').textContent, 'latest control failed');
    assert.deepEqual(panel.sent.filter((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL')
      .map((msg) => msg.control), ['start', 'restore']);
  },
})));

exports.tests.push({
  name: 'latest control error survives ordinary polling until invocation or access recovery or tab change',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { ok: false, error: { message: 'latest control failed' } } : response(msg.type, 'current'));
    await panel.controller.runInlineControl('STOP');
    for (let i = 0; i < 3; i += 1) await panel.controller.refresh();
    assert.equal(panel.display().inline.controlError, 'latest control failed');
    assert.equal(helpers.getInlineTranslationPanelViewModel(panel.display().inline).errorText, 'latest control failed');
    panel.setSend((msg) => msg.type === 'GET_INLINE_TRANSLATION_STATE'
      ? { ok: false } : response(msg.type, 'unreachable'));
    await panel.controller.refresh();
    assert.equal(panel.display().inline.controlError, 'latest control failed');
    panel.setSend((msg) => response(msg.type, 'recovered'));
    await panel.controller.refresh();
    assert.equal(panel.display().inline.controlError, '');
    assert.equal(helpers.getInlineTranslationPanelViewModel(panel.display().inline).errorText, 'shortcut recovered');
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { ok: false, error: { message: 'next control failed' } } : response(msg.type, 'current'));
    await panel.controller.runInlineControl('START');
    await panel.activate(2);
    assert.equal(panel.display().inline.controlError, '');
    assert.deepEqual(panel.sent.filter((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL')
      .map((msg) => msg.control), ['STOP', 'START']);
    assert.equal(panel.sent.some((msg) => msg.type === 'TRANSLATE_TAB'), false);
  },
});

exports.tests.push(
{
    name: 'actual activation clears Inline errors and disables controls while access is unconfirmed',
    async fn() {
      const panel = domPanel();
      await settle();
      const pending = deferred();
      panel.setSend(() => pending.promise);
      panel.activate(2);
      assert.doesNotMatch(panel.element('inlineError').textContent, /shortcut 1/);

      assert.equal(panel.element('inlineError').textContent, '');
      assert.equal(panel.element('inlineStatus').textContent, 'Checking access to this tab...');
      for (const id of ['btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore']) {
        assert.equal(panel.element(id).disabled, true);
      }

      assert.equal(panel.sent.some((msg) => ['RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)), false);
      pending.resolve({ ok: false });
      await settle();
      assert.match(panel.element('inlineStatus').textContent, /Click the extension icon/);
    },
  },
...['GET_STATE', 'GET_INLINE_TRANSLATION_STATE'].map((type) => ({
    name: `module rejects first A visit ${type} after A to B to A`,
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      const old = deferred();
      let hold = true;
      panel.setSend((msg) => hold && msg.type === type && msg.tabId === 1
        ? old.promise : response(msg.type, 'new A'));
      const first = panel.controller.refresh();
      await settle();
      hold = false;
      await panel.activate(2);
      await panel.activate(1);
      old.resolve(response(type, 'old A'));
      await first;
      assert.equal(panel.display().tabId, 1);
      assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut new A');
      assert.equal(panel.display().inline.snapshot.progress, 'inline new A');
    },
  })),
{
    name: 'actual panel rejects first A visit after activation through B back to A',
    async fn() {
      const panel = domPanel();
      await settle();
      const old = deferred();
      let hold = true;
      panel.setSend((msg) => hold && msg.tabId === 1 ? old.promise : response(msg.type, 'new A'));
      panel.poll();
      await settle();
      hold = false;
      panel.activate(2);
      await settle();
      panel.activate(1);
      await settle();
      old.resolve({ ok: true, state: state('old A'), snapshot: { status: 'active', progress: 'old A' } });
      await settle();
      assert.equal(panel.element('inlineError').textContent, 'shortcut new A');
      assert.equal(panel.element('inlineStatus').textContent, 'inline new A');
    },
  },
{
    name: 'older active tab queries cannot undo a newer query or activation',
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      const old = deferred();
      panel.setQuery(() => old.promise);
      const first = panel.controller.refresh();
      panel.setQuery(async () => ({ id: 2 }));
      await panel.controller.refresh();
      old.resolve({ id: 1 });
      await first;
      assert.equal(panel.display().tabId, 2);
      assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut 2');
      const beforeActivation = deferred();
      panel.setQuery(() => beforeActivation.promise);
      const second = panel.controller.refresh();
      await panel.activate(3);
      beforeActivation.resolve({ id: 2 });
      await second;
      assert.equal(panel.display().tabId, 3);
      assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut 3');
    },
  },
{
    name: 'actual panel ignores other windows and other tabs notifications',
    async fn() {
      const panel = domPanel();
      await settle();
      const before = panel.sent.length;
      panel.activate(9, 99);
      await settle();
      assert.equal(panel.sent.length, before);
      panel.notify({ type: 'STATE_UPDATED', tabId: 9, state: state('other') });
      assert.equal(panel.element('inlineError').textContent, 'shortcut 1');
      panel.notify({ type: 'STATE_UPDATED', tabId: 1, state: state('notified') });
      assert.equal(panel.element('inlineError').textContent, 'shortcut notified');
    },
  },
{
    name: 'normal module responses render Inline feedback and preserve controls and recovery',
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut 1');
      assert.equal(panel.display().inline.snapshot.progress, 'inline 1');
      let model = helpers.getInlineTranslationPanelViewModel(panel.display().inline);
      assert.equal(model.stopDisabled, false);
      panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
        ? { ok: false, error: { message: 'control failed' } } : response(msg.type, '1'));
      await panel.controller.runInlineControl('STOP');
      assert.equal(helpers.getInlineTranslationPanelViewModel(panel.display().inline).errorText, 'control failed');
      panel.setSend((msg) => msg.type === 'GET_INLINE_TRANSLATION_STATE' ? { ok: false } : response(msg.type, '1'));
      await panel.controller.refresh();
      model = helpers.getInlineTranslationPanelViewModel(panel.display().inline);
      assert.match(model.statusText, /then try again/);
      panel.setSend((msg) => msg.type === 'GET_STATE' ? { ok: true, state: wireState({ status: 'idle' }) } : response(msg.type, 'recovered'));
      await panel.controller.refresh();
      assert.equal(panel.display().inline.controlError, '');
      assert.equal(helpers.getInlineTranslationPanelViewModel(panel.display().inline).startDisabled, false);
      const control = panel.sent.find((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL');
      assert.deepEqual(control, { type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 1, documentId: 'doc-1', control: 'STOP' });
    },
  }
);

exports.tests.push(...[false, true].map((actual) => ({
  name: `state notifications supersede earlier queries in the ${actual ? 'actual polling' : 'module'} display`,
  async fn() {
    const panel = actual ? domPanel() : modulePanel();
    if (actual) await settle();
    else await panel.controller.start(10);
    const old = deferred();
    const inline = deferred();
    panel.setSend((msg) => msg.type === 'GET_STATE' ? old.promise : inline.promise);
    const first = actual ? panel.poll() : panel.controller.refresh();
    await settle();
    const notify = (msg) => actual ? panel.notify(msg) : panel.controller.receive(msg);
    notify({ type: 'STATE_UPDATED', tabId: 1, state: state('notified') });
    old.resolve(response('GET_STATE', 'old'));
    inline.resolve(response('GET_INLINE_TRANSLATION_STATE', 'valid inline'));
    if (actual) await settle();
    else await first;
    if (actual) {
      assert.equal(panel.element('inlineError').textContent, 'shortcut notified');
      assert.equal(panel.element('inlineError').textContent, 'shortcut notified');

      assert.equal(panel.element('inlineError').textContent, 'shortcut notified');
      assert.equal(panel.element('inlineStatus').textContent, 'inline valid inline');
    } else {
      assert.deepEqual(panel.display().state, { ...state('notified'), documentId: 'doc-1' });
      assert.equal(panel.display().inline.invocationError, 'shortcut notified');
      assert.equal(panel.display().inline.snapshot.progress, 'inline valid inline');
    }
    panel.setSend((msg) => response(msg.type, 'after notification'));
    if (actual) { panel.poll(); await settle(); }
    else await panel.controller.refresh();
    assert.equal(actual ? panel.element('inlineError').textContent : panel.display().state.inlineTranslationError?.message,
      'shortcut after notification');
  },
})));

exports.tests.push(...[false, true].flatMap((actual) => [false, true].map((oldHasAccess) => ({
  name: `same-tab inline queries with old access ${oldHasAccess} cannot roll back the ${actual ? 'actual polling' : 'module'} display`,
  async fn() {
    const panel = actual ? domPanel() : modulePanel();
    if (actual) await settle();
    else await panel.controller.start(10);
    const old = deferred();
    panel.setSend((msg) => msg.type === 'GET_INLINE_TRANSLATION_STATE' ? old.promise : response(msg.type, 'current'));
    const first = actual ? panel.poll() : panel.controller.refresh();
    await settle();
    panel.setSend((msg) => response(msg.type, 'current'));
    if (actual) { panel.poll(); await settle(); }
    else await panel.controller.refresh();
    old.resolve(oldHasAccess
      ? { ok: true, snapshot: { status: 'idle', progress: 'old inline' } } : { ok: false });
    if (actual) await settle();
    else await first;
    if (actual) {
      assert.equal(panel.element('inlineStatus').textContent, 'inline current');
      assert.equal(panel.element('btnInlineStop').disabled, false);
    } else {
      assert.equal(panel.display().inline.hasPageAccess, true);
      assert.deepEqual(panel.display().inline.snapshot, response('GET_INLINE_TRANSLATION_STATE', 'current').snapshot);
      assert.equal(helpers.getInlineTranslationPanelViewModel(panel.display().inline).stopDisabled, false);
    }
  },
}))));

exports.tests.push(...[false, true].map((actual) => ({
  name: `same-tab state queries cannot roll back the ${actual ? 'actual polling' : 'module'} display`,
  async fn() {
    const panel = actual ? domPanel() : modulePanel();
    if (actual) await settle();
    else await panel.controller.start(10);
    const old = deferred();
    panel.setSend((msg) => msg.type === 'GET_STATE' ? old.promise : response(msg.type, 'current'));
    const first = actual ? panel.poll() : panel.controller.refresh();
    await settle();
    panel.setSend((msg) => msg.type === 'GET_STATE'
      ? { ok: true, state: { ...state('current'), updatedAt: 100 } } : response(msg.type, 'current'));
    if (actual) { panel.poll(); await settle(); }
    else await panel.controller.refresh();
    old.resolve({ ok: true, state: { ...state('old'), updatedAt: 900, progress: { current: 1, total: 3 } } });
    if (actual) await settle();
    else await first;
    if (actual) {
      assert.equal(panel.element('inlineError').textContent, 'shortcut current');
      assert.equal(panel.element('inlineError').textContent, 'shortcut current');

      assert.equal(panel.element('inlineError').textContent, 'shortcut current');
    } else {
      assert.deepEqual(panel.display().state, { ...state('current'), updatedAt: 100 });
      assert.equal(panel.display().inline.invocationError, 'shortcut current');
    }
  },
})));

exports.tests.push({
  name: 'state and inline response paths update independently while the other query waits',
  async fn() {
    for (const waitingType of ['GET_STATE', 'GET_INLINE_TRANSLATION_STATE']) {
      const panel = modulePanel();
      await panel.controller.start(10);
      const pending = deferred();
      panel.setSend((msg) => msg.type === waitingType ? pending.promise : response(msg.type, 'first'));
      const first = panel.controller.refresh();
      await settle();
      const next = deferred();
      panel.setSend((msg) => msg.type === waitingType ? next.promise : response(msg.type, 'second'));
      const second = panel.controller.refresh();
      await settle();
      if (waitingType === 'GET_STATE') {
        assert.equal(panel.display().inline.snapshot.progress, 'inline second');
        assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut 1');
      } else {
        assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut second');
        assert.equal(panel.display().inline.snapshot.progress, 'inline 1');
      }
      next.resolve(response(waitingType, 'second'));
      await second;
      pending.resolve(response(waitingType, 'first'));
      await first;
      assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut second');
      assert.equal(panel.display().inline.snapshot.progress, 'inline second');
    }
  },
}, {
  name: 'same-tab polling does not invalidate a delayed user action failure',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const pending = deferred();
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? pending.promise : response(msg.type, 'polled'));
    const button = panel.controller.runInlineControl('STOP');
    await settle();
    await panel.controller.refresh();
    pending.resolve({ ok: false, error: { message: 'action failed' } });
    await button;
    assert.equal(panel.display().inline.controlError, 'action failed');
  },
});

exports.tests.push({
  name: 'polling during a button tab query does not discard an action on the same tab',
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const waiting = deferred();
    panel.setQuery(() => waiting.promise);
    panel.setSend(() => ({ ok: true }));
    const button = panel.controller.runInlineControl('STOP');
    panel.setQuery(async () => ({ id: 1 }));
    await panel.controller.refresh();
    waiting.resolve({ id: 1 });
    await button;
    const message = panel.sent.find((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL');
    assert.ok(message, 'control button action was lost during polling');
    assert.equal(message.tabId, 1);
  },
});

exports.tests.push(...['stop', 'restore', 'start'].map((control) => ({
  name: `discards a superseded Start before its tab query returns after ${control}`,
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const waiting = deferred();
    panel.setQuery(() => waiting.promise);
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { ok: true } : response(msg.type, 'current'));
    const old = panel.controller.runInlineControl('start');
    panel.setQuery(async () => ({ id: 1 }));
    await panel.controller.runInlineControl(control);
    await panel.controller.refresh();
    waiting.resolve({ id: 1 });
    await old;
    assert.deepEqual(panel.sent.filter((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'), [
      { type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 1, documentId: 'doc-1', control },
    ]);
  },
})));

exports.tests.push(...[false, true].map((returnToA) => ({
  name: `discards a waiting control from the first visit after ${returnToA ? 'A to B to A' : 'A to B'}`,
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const waiting = deferred();
    panel.setQuery(() => waiting.promise);
    const old = panel.controller.runInlineControl('start');
    await panel.activate(2);
    if (returnToA) await panel.activate(1);
    const display = panel.display();
    waiting.resolve({ id: 1 });
    await old;
    assert.deepEqual(panel.sent.filter((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'), []);
    assert.deepEqual(panel.display(), display);
  },
})));

exports.tests.push({
  name: 'an initial control waits for an identified document before sending',
  async fn() {
    const panel = modulePanel();
    panel.setSend((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL'
      ? { ok: true } : response(msg.type, 'current'));
    await panel.controller.runInlineControl('start');
    assert.deepEqual(panel.sent, []);
  },
});

exports.tests.push(...['failure', 'rejection'].flatMap((outcome) => [false, true].flatMap((actual) =>
  [false, true].map((returnToA) => ({
    name: `${actual ? 'actual button' : 'module'} control ignores late ${outcome} after ${returnToA ? 'A to B to A' : 'A to B'}`,
    async fn() {
      const panel = actual ? domPanel() : modulePanel();
      if (actual) await settle();
      else await panel.controller.start(10);
      const pending = deferred();
      const actionType = 'RUN_INLINE_TRANSLATION_CONTROL';
      panel.setSend((msg) => msg.type === actionType ? pending.promise
        : response(msg.type, 'current'));
      const running = actual
        ? panel.element('btnInlineStop').listeners.click()
        : panel.controller.runInlineControl('STOP');
      await settle();
      assert.equal(panel.sent.filter((msg) => msg.type === actionType).length, 1);
      assert.equal(panel.sent.find((msg) => msg.type === actionType).tabId, 1);
      await panel.activate(2);
      await settle();
      if (returnToA) { await panel.activate(1); await settle(); }
      const readDisplay = () => actual
        ? ['inlineStatus', 'inlineError',
          'btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore']
          .map((id) => {
            const { textContent, hidden, disabled } = panel.element(id);
            return { textContent, hidden, disabled };
          })
        : panel.display();
      const before = readDisplay();
      if (outcome === 'rejection') pending.reject(new Error('old action failed'));
      else pending.resolve({ ok: false, error: { message: 'old action failed' } });
      await running;
      await settle();
      assert.deepEqual(readDisplay(), before);
      assert.equal(panel.sent.filter((msg) =>
        ['RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)).length, 1);
    },
  })))));

exports.tests.push({
  name: 'control completion and its follow-up queries stay with the requesting visit',
  async fn() {
    for (const switchDuringFollowUp of [false, true]) {
      const panel = modulePanel();
      await panel.controller.start(10);
      const pending = deferred();
      const followUp = deferred();
      const actionType = 'RUN_INLINE_TRANSLATION_CONTROL';
      panel.setSend((msg) => msg.type === actionType ? pending.promise
        : followUp.promise);
      const running = panel.controller.runInlineControl('START');
      await settle();
      const before = panel.sent.length;
      if (switchDuringFollowUp) {
        pending.resolve({ ok: true, skipped: true });
        await settle();
        assert.deepEqual(panel.sent.slice(before), [
          { type: 'GET_STATE', tabId: 1, documentId: 'doc-1',  },
          { type: 'GET_INLINE_TRANSLATION_STATE', tabId: 1, documentId: 'doc-1' },
        ]);
      }
      panel.setSend((msg) => response(msg.type, 'new visit'));
      await panel.activate(2);
      await panel.activate(1);
      const display = panel.display();
      const afterSwitch = panel.sent.length;
      if (!switchDuringFollowUp) pending.resolve({ ok: true, skipped: true });
      else followUp.resolve({ ok: true, state: state('old'),
        snapshot: { status: 'active', progress: 'old' } });
      await running;
      assert.deepEqual(panel.display(), display);
      assert.equal(panel.sent.length, afterSwitch);
      assert.equal(panel.sent.filter((msg) =>
        ['RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)).length, 1);
    }
  },
});

exports.tests.push(...['failure', 'rejection', 'success'].map((outcome) => ({
  name: `current control ${outcome} remains valid across repeated polling`,
  async fn() {
    const panel = modulePanel();
    await panel.controller.start(10);
    const pending = deferred();
    const actionType = 'RUN_INLINE_TRANSLATION_CONTROL';
    panel.setSend((msg) => msg.type === actionType ? pending.promise : response(msg.type, 'polled'));
    const running = panel.controller.runInlineControl('STOP');
    await settle();
    for (let i = 0; i < 3; i += 1) await panel.controller.refresh();
    if (outcome === 'success') {
      panel.setSend((msg) => {
        const result = response(msg.type, 'completed');
        if (result.state) Object.assign(result.state, { stateSequence: 2 });
        return result;
      });
      pending.resolve({ ok: true, skipped: false });
    } else if (outcome === 'rejection') pending.reject(new Error('current action failed'));
    else pending.resolve({ ok: false, error: { message: 'current action failed' } });
    await running;
    if (outcome === 'success') {
      assert.equal(panel.display().inline.controlError, '');
      assert.equal(panel.display().inline.snapshot.progress, 'inline completed');
      assert.equal(panel.display().state.inlineTranslationError?.message, 'shortcut completed');
    } else {
      assert.equal(panel.display().inline.controlError,
        'current action failed');
    }
  },
})));
