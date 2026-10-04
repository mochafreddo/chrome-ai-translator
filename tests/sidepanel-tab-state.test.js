const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const helpers = require('../extension/sidepanel.js');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
async function settle() {
  for (let i = 0; i < 64; i += 1) await Promise.resolve();
}
function state(label) {
  return { status: 'error', extracted: { contentMarkdown: `original ${label}` },
    translated: `translated ${label}`, progress: { current: 2, total: 3 },
    error: { message: `panel ${label}` }, inlineTranslationError: { message: `shortcut ${label}` } };
}
function response(type, label) {
  return type === 'GET_STATE' ? { ok: true, state: state(label) }
    : { ok: true, snapshot: { status: 'active', progress: `inline ${label}`, error: '' } };
}
function domPanel() {
  const elements = new Map();
  const sent = [];
  let active = 1;
  let poll;
  let activated;
  let notified;
  let send = (message) => response(message.type, String(message.tabId));
  function element(id) {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: false,
      disabled: false, listeners: {}, addEventListener(type, listener) { this.listeners[type] = listener; } });
    return elements.get(id);
  }
  const chrome = {
    windows: { getCurrent: async () => ({ id: 10 }) },
    tabs: { query: async () => [{ id: active, windowId: 10 }],
      onActivated: { addListener(listener) { activated = listener; } } },
    runtime: { onMessage: { addListener(listener) { notified = listener; } },
      async sendMessage(message) {
        sent.push(message);
        if (message.type === 'GET_SETTINGS') return { ok: true, settings: {} };
        return send(message);
      } },
  };
  const context = vm.createContext({ chrome, document: { getElementById: element, querySelectorAll: () => [] },
    setInterval(callback, delay) { assert.equal(delay, 1000); poll = callback; },
    ChromeAiTranslatorInlineTranslationControls: require('../extension/inline-translation-controls.js'),
    ChromeAiTranslatorPageAccess: require('../extension/page-access.js'),
    ChromeAiTranslatorDefaultModel: require('../extension/default-model.js'),
    ChromeAiTranslatorSidePanelFailure: require('../extension/sidepanel-failure.js') });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/sidepanel.js'), 'utf8'), context);
  return { element, sent, setSend(fn) { send = fn; }, poll() { poll(); },
    activate(id, windowId = 10) { active = windowId === 10 ? id : active; activated?.({ tabId: id, windowId }); },
    notify(msg) { notified(msg); } };
}
exports.name = 'sidepanel tab state';
exports.tests = [
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
      assert.equal(panel.element('original').textContent, 'original 2');
      assert.equal(panel.element('translated').textContent, 'translated 2');
      assert.equal(panel.element('inlineStatus').textContent, 'inline 2');
      assert.equal(panel.element('inlineError').textContent, 'shortcut 2');
      assert.equal(panel.element('errorBox').textContent, 'panel 2');
    },
  })),
];

function modulePanel() {
  let active = 1;
  let displayed;
  let query = async () => ({ id: active });
  let send = (message) => response(message.type, String(message.tabId));
  const sent = [];
  const controller = helpers.createTabStateController({
    queryActiveTab: () => query(),
    sendMessage(message) { sent.push(message); return send(message); },
    render(display) { displayed = display; },
  });
  return { controller, sent, display: () => displayed,
    setQuery(fn) { query = fn; }, setSend(fn) { send = fn; },
    activate(id, windowId = 10) { if (windowId === 10) active = id; return controller.activate({ tabId: id, windowId }); } };
}

exports.tests.push(
  {
    name: 'actual activation immediately clears both displays while access is unconfirmed',
    async fn() {
      const panel = domPanel();
      await settle();
      panel.element('targetLanguage').value = 'French';
      panel.element('saveStatus').textContent = 'Saved.';
      panel.element('saveError').textContent = 'save feedback';
      const pending = deferred();
      panel.setSend(() => pending.promise);
      panel.activate(2);
      assert.doesNotMatch(panel.element('original').textContent, /original 1/);
      assert.doesNotMatch(panel.element('translated').textContent, /translated 1/);
      assert.equal(panel.element('progress').textContent, '');
      assert.equal(panel.element('errorBox').textContent, '');
      assert.equal(panel.element('inlineError').textContent, '');
      assert.equal(panel.element('inlineStatus').textContent, 'Checking access to this tab...');
      for (const id of ['btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore']) {
        assert.equal(panel.element(id).disabled, true);
      }
      assert.equal(panel.element('targetLanguage').value, 'French');
      assert.equal(panel.element('saveStatus').textContent, 'Saved.');
      assert.equal(panel.element('saveError').textContent, 'save feedback');
      assert.equal(panel.sent.some((msg) => ['TRANSLATE_TAB', 'RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)), false);
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
      assert.equal(panel.display().state.translated, 'translated new A');
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
      assert.equal(panel.element('translated').textContent, 'translated new A');
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
      assert.equal(panel.display().state.translated, 'translated 2');
      const beforeActivation = deferred();
      panel.setQuery(() => beforeActivation.promise);
      const second = panel.controller.refresh();
      await panel.activate(3);
      beforeActivation.resolve({ id: 2 });
      await second;
      assert.equal(panel.display().tabId, 3);
      assert.equal(panel.display().state.translated, 'translated 3');
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
      assert.equal(panel.element('translated').textContent, 'translated 1');
      panel.notify({ type: 'STATE_UPDATED', tabId: 1, state: state('notified') });
      assert.equal(panel.element('translated').textContent, 'translated notified');
    },
  },
  {
    name: 'normal module responses render both translations and preserve controls and recovery',
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      assert.equal(panel.display().state.translated, 'translated 1');
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
      panel.setSend((msg) => msg.type === 'GET_STATE' ? { ok: true, state: { status: 'idle' } } : response(msg.type, 'recovered'));
      await panel.controller.refresh();
      assert.equal(panel.display().inline.controlError, '');
      assert.equal(helpers.getInlineTranslationPanelViewModel(panel.display().inline).startDisabled, false);
      panel.setSend(() => ({ ok: false, error: { code: 'markdown.token_missing', message: 'markdown.token_missing' } }));
      await panel.controller.translate({ targetLanguage: 'Korean' });
      assert.match(panel.display().panelError, /lost a link or code marker/);
      const control = panel.sent.find((msg) => msg.type === 'RUN_INLINE_TRANSLATION_CONTROL');
      assert.deepEqual(control, { type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 1, control: 'STOP' });
      const translation = panel.sent.find((msg) => msg.type === 'TRANSLATE_TAB');
      assert.deepEqual(translation, { type: 'TRANSLATE_TAB', tabId: 1, settingsOverride: { targetLanguage: 'Korean' } });
    },
  },
  {
    name: 'actual polling refreshes both states and Translate button uses settings',
    async fn() {
      const panel = domPanel();
      await settle();
      panel.setSend((msg) => msg.type === 'TRANSLATE_TAB' ? { ok: false, error: { message: 'cannot translate' } } : response(msg.type, 'polled'));
      panel.poll();
      await settle();
      assert.equal(panel.element('translated').textContent, 'translated polled');
      assert.equal(panel.element('inlineStatus').textContent, 'inline polled');
      panel.element('targetLanguage').value = 'French';
      panel.element('btnTranslate').listeners.click();
      await settle();
      assert.equal(panel.sent.find((msg) => msg.type === 'TRANSLATE_TAB').settingsOverride.targetLanguage, 'French');
      assert.equal(panel.element('errorBox').textContent, 'cannot translate');
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
      assert.equal(panel.element('original').textContent, 'original notified');
      assert.equal(panel.element('translated').textContent, 'translated notified');
      assert.equal(panel.element('progress').textContent, 'Chunk 2/3');
      assert.equal(panel.element('errorBox').textContent, 'panel notified');
      assert.equal(panel.element('inlineError').textContent, 'shortcut notified');
      assert.equal(panel.element('inlineStatus').textContent, 'inline valid inline');
    } else {
      assert.deepEqual(panel.display().state, state('notified'));
      assert.equal(panel.display().inline.invocationError, 'shortcut notified');
      assert.equal(panel.display().inline.snapshot.progress, 'inline valid inline');
    }
    panel.setSend((msg) => response(msg.type, 'after notification'));
    if (actual) { panel.poll(); await settle(); }
    else await panel.controller.refresh();
    assert.equal(actual ? panel.element('translated').textContent : panel.display().state.translated,
      'translated after notification');
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
      assert.equal(panel.element('original').textContent, 'original current');
      assert.equal(panel.element('translated').textContent, 'translated current');
      assert.equal(panel.element('progress').textContent, 'Chunk 2/3');
      assert.equal(panel.element('errorBox').textContent, 'panel current');
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
        assert.equal(panel.display().state.translated, 'translated 1');
      } else {
        assert.equal(panel.display().state.translated, 'translated second');
        assert.equal(panel.display().inline.snapshot.progress, 'inline 1');
      }
      next.resolve(response(waitingType, 'second'));
      await second;
      pending.resolve(response(waitingType, 'first'));
      await first;
      assert.equal(panel.display().state.translated, 'translated second');
      assert.equal(panel.display().inline.snapshot.progress, 'inline second');
    }
  },
}, {
  name: 'same-tab polling does not invalidate a delayed user action failure',
  async fn() {
    for (const action of ['translate', 'control']) {
      const panel = modulePanel();
      await panel.controller.start(10);
      const pending = deferred();
      panel.setSend((msg) => ['TRANSLATE_TAB', 'RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)
        ? pending.promise : response(msg.type, 'polled'));
      const button = action === 'translate' ? panel.controller.translate({}) : panel.controller.runInlineControl('STOP');
      await settle();
      await panel.controller.refresh();
      pending.resolve({ ok: false, error: { message: 'action failed' } });
      await button;
      assert.equal(action === 'translate' ? panel.display().panelError : panel.display().inline.controlError,
        'action failed');
    }
  },
});

exports.tests.push({
  name: 'polling during a button tab query does not discard an action on the same tab',
  async fn() {
    for (const action of ['translate', 'control']) {
      const panel = modulePanel();
      await panel.controller.start(10);
      const waiting = deferred();
      panel.setQuery(() => waiting.promise);
      panel.setSend(() => ({ ok: true }));
      const button = action === 'translate'
        ? panel.controller.translate({ targetLanguage: 'French' })
        : panel.controller.runInlineControl('STOP');
      panel.setQuery(async () => ({ id: 1 }));
      await panel.controller.refresh();
      waiting.resolve({ id: 1 });
      await button;
      const message = panel.sent.find((msg) => msg.type ===
        (action === 'translate' ? 'TRANSLATE_TAB' : 'RUN_INLINE_TRANSLATION_CONTROL'));
      assert.ok(message, `${action} button action was lost during polling`);
      assert.equal(message.tabId, 1);
    }
  },
});

exports.tests.push(...['control', 'translate'].flatMap((action) =>
  ['failure', 'rejection'].flatMap((outcome) => [false, true].flatMap((actual) =>
    [false, true].map((returnToA) => ({
      name: `${actual ? 'actual button' : 'module'} ${action} ignores late ${outcome} after ${returnToA ? 'A to B to A' : 'A to B'}`,
      async fn() {
        const panel = actual ? domPanel() : modulePanel();
        if (actual) await settle();
        else await panel.controller.start(10);
        const pending = deferred();
        const actionType = action === 'control' ? 'RUN_INLINE_TRANSLATION_CONTROL' : 'TRANSLATE_TAB';
        panel.setSend((msg) => msg.type === actionType ? pending.promise
          : response(msg.type, 'current'));
        const running = actual
          ? panel.element(action === 'control' ? 'btnInlineStop' : 'btnTranslate').listeners.click()
          : action === 'control' ? panel.controller.runInlineControl('STOP')
            : panel.controller.translate({ targetLanguage: 'French' });
        await settle();
        assert.equal(panel.sent.filter((msg) => msg.type === actionType).length, 1);
        assert.equal(panel.sent.find((msg) => msg.type === actionType).tabId, 1);
        await panel.activate(2);
        await settle();
        if (returnToA) { await panel.activate(1); await settle(); }
        const readDisplay = () => actual
          ? ['original', 'translated', 'progress', 'errorBox', 'inlineStatus', 'inlineError',
            'btnInlineTranslate', 'btnInlineStop', 'btnInlineRestore', 'btnTranslate']
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
          ['TRANSLATE_TAB', 'RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)).length, 1);
      },
    }))))));

exports.tests.push(...['control', 'translate'].map((action) => ({
  name: `${action} completion and its follow-up queries stay with the requesting visit`,
  async fn() {
    for (const switchDuringFollowUp of [false, true]) {
      const panel = modulePanel();
      await panel.controller.start(10);
      const pending = deferred();
      const followUp = deferred();
      const actionType = action === 'control' ? 'RUN_INLINE_TRANSLATION_CONTROL' : 'TRANSLATE_TAB';
      panel.setSend((msg) => msg.type === actionType ? pending.promise
        : followUp.promise);
      const running = action === 'control' ? panel.controller.runInlineControl('START')
        : panel.controller.translate({});
      await settle();
      const before = panel.sent.length;
      if (switchDuringFollowUp) {
        pending.resolve({ ok: true, skipped: true });
        await settle();
        assert.deepEqual(panel.sent.slice(before), [
          { type: 'GET_STATE', tabId: 1 },
          { type: 'GET_INLINE_TRANSLATION_STATE', tabId: 1 },
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
        ['TRANSLATE_TAB', 'RUN_INLINE_TRANSLATION_CONTROL'].includes(msg.type)).length, 1);
    }
  },
})));

exports.tests.push(...['control', 'translate'].flatMap((action) =>
  ['failure', 'rejection', 'success', ...(action === 'translate' ? ['skipped'] : [])].map((outcome) => ({
    name: `current ${action} ${outcome} remains valid across repeated polling`,
    async fn() {
      const panel = modulePanel();
      await panel.controller.start(10);
      const pending = deferred();
      const actionType = action === 'control' ? 'RUN_INLINE_TRANSLATION_CONTROL' : 'TRANSLATE_TAB';
      panel.setSend((msg) => msg.type === actionType ? pending.promise : response(msg.type, 'polled'));
      const running = action === 'control' ? panel.controller.runInlineControl('STOP')
        : panel.controller.translate({});
      await settle();
      for (let i = 0; i < 3; i += 1) await panel.controller.refresh();
      if (outcome === 'success' || outcome === 'skipped') {
        panel.setSend((msg) => response(msg.type, 'completed'));
        if (action === 'translate' && outcome === 'success') panel.controller.receive({ type: 'STATE_UPDATED',
          tabId: 1, state: { status: 'done', translated: 'completed translation' } });
        pending.resolve({ ok: true, skipped: outcome === 'skipped' });
      } else if (outcome === 'rejection') pending.reject(new Error('current action failed'));
      else pending.resolve({ ok: false, error: { message: 'current action failed' } });
      await running;
      if (outcome === 'success' || outcome === 'skipped') {
        assert.equal(panel.display().panelError, '');
        assert.equal(panel.display().inline.controlError, '');
        if (action === 'control' || outcome === 'skipped') {
          assert.equal(panel.display().inline.snapshot.progress, 'inline completed');
          assert.equal(panel.display().state.translated, 'translated completed');
        } else {
          assert.equal(panel.display().state.status, 'done');
          assert.equal(panel.display().state.translated, 'completed translation');
        }
      } else {
        assert.equal(action === 'control' ? panel.display().inline.controlError : panel.display().panelError,
          'current action failed');
        if (action === 'translate') assert.equal(panel.display().state.status, 'idle');
      }
    },
  }))));
