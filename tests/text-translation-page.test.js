const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createBackgroundWorker } = require('../extension/background.js');

async function openPage({ previous, tabId = 90, documentId = 'test-document', beforeReady } = {}) {
  const elements = new Map();
  const requests = previous?.requests || [];
  const messages = previous?.messages || [];
  const deliveries = [];
  let holdDelivery = false;
  let serial = 0;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: true, disabled: false,
      listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, focus() {} });
    return elements.get(id);
  };
  element('sourceLanguage').value = 'auto';
  const stored = { apiKey: 'sk-test-synthetic', openrouterApiKey: 'sk-router-synthetic',
    service: 'openai', model: 'test-model', reasoningEffort: 'low', targetLanguage: 'Korean', tone: 'natural' };
  const session = previous?.session || {};
  const frames = previous?.frames || new Map();
  frames.set(tabId, documentId);
  const storage = previous?.storage || { writes: [], held: [] };
  const platform = previous?.platform || { chrome: {
    runtime: { getURL: path => `chrome-extension://test/${path}`, async sendMessage() {},
      async getContexts({ tabIds: [tabId] }) {
      const documentId = frames.get(tabId);
      if (frames.hold) await new Promise(resolve => {
        frames.release = resolve;
        (frames.pending ||= []).push(resolve);
      });
      return documentId ? [{ tabId, frameId: 0, documentId,
        documentUrl: 'chrome-extension://test/text-translation.html' }] : [];
    } },
    webNavigation: { async getFrame() { return null; } },
    storage: { local: { async get() { return { settings: stored }; } }, session: {
      async get(key) { return { [key]: structuredClone(session[key]) }; },
      async set(value) {
        storage.writes.push(structuredClone(value));
        if (storage.hold) await new Promise(resolve => storage.held.push(resolve));
        Object.assign(session, structuredClone(value));
      },
      async remove(key) { delete session[key]; },
    } },
  }, fetch: (url, options) => new Promise(resolve => {
    requests.push({ url, body: JSON.parse(options.body), signal: options.signal,
      respond(translation, status = 'completed', sourceLanguage = 'English') {
        resolve({ ok: true, json: async () => ({ status, output: [{ type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ translation, sourceLanguage }) }] }] }) });
      } });
  }) };
  const workerRef = previous?.workerRef || { current: createBackgroundWorker(platform) };
  const chrome = { runtime: { sendMessage(message) {
    messages.push(message);
    return new Promise(resolve => workerRef.current.handlers.onMessage(message,
      { tab: { id: tabId }, frameId: 0, documentId, url: 'chrome-extension://test/text-translation.html' },
      response => {
        if (holdDelivery && message.type === 'TRANSLATE_TEXT') deliveries.push(() => resolve(response));
        else resolve(response);
      }));
  } } };
  const windowEvents = {};
  const context = vm.createContext({ chrome, document: { getElementById: element, addEventListener() {} },
    window: { addEventListener(type, callback) { windowEvents[type] = callback; } }, crypto: { randomUUID: () => `operation-${++serial}` },
    navigator: { clipboard: { async writeText() {} } },
    ChromeAiTranslatorTextTranslationRequest: require('../extension/text-translation-request.js'),
    ChromeAiTranslatorDefaultModel: require('../extension/default-model.js') });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/text-translation.js'), 'utf8'), context);
  await beforeReady?.({ element, event, flush });
  async function flush() { for (let i = 0; i < 64; i += 1) await Promise.resolve(); }
  function event(id, type) { element(id).listeners[type]?.({ preventDefault() {} }); }
  await flush();
  assert.equal(element('btnTranslate').disabled, false);
  return { element, event, requests, messages, flush, session, frames, storage, platform, workerRef,
    get worker() { return workerRef.current; },
    replaceWorker() { workerRef.current = createBackgroundWorker(platform); },
    send: chrome.runtime.sendMessage,
    async close() { windowEvents.pagehide?.(); frames.delete(tabId); workerRef.current.handlers.onTabRemoved(tabId); await flush(); },
    async reload(options = {}) {
      windowEvents.pagehide?.();
      return openPage({ previous: this, tabId, documentId: documentId + '-reload', ...options });
    },
    source(value) { element('sourceText').value = value; event('sourceText', 'input'); },
    async start() { event('translationForm', 'submit'); await flush(); },
    async resume() { event('btnResume', 'click'); await flush(); },
    async stop() { event('btnStop', 'click'); await flush(); },
    holdDelivery(value) { holdDelivery = value; },
    async releaseDelivery() { for (const deliver of deliveries.splice(0)) deliver(); await flush(); },
  };
}

exports.name = 'Text Translation page';
exports.tests = [{
  name: 'Clear stays disabled until restoration finishes and stays available during an active job',
  async fn() {
    const page = await openPage({ beforeReady: async ({ element, event }) => {
      assert.equal(element('btnClear').disabled, true);
      event('btnClear', 'click');
    } });
    assert.equal(page.messages.some(message => message.type === 'CLEAR_TEXT_TRANSLATION_STATE'), false);
    page.source('Original');
    await page.start();
    assert.equal(page.element('btnClear').disabled, false);
  },
}, {
  name: 'uncertain language requires a manual choice and incomplete work cannot be swapped',
  async fn() {
    const page = await openPage();
    page.source('Hello');
    await page.start();
    assert.equal(page.element('btnSwap').disabled, true);
    page.event('btnSwap', 'click');
    assert.equal(page.element('sourceText').value, 'Hello');
    page.requests[0].respond('안녕', 'completed', null);
    await page.flush();
    page.event('btnSwap', 'click');
    assert.equal(page.element('sourceText').value, 'Hello');
    assert.equal(page.element('errorBox').hidden, false);
    page.element('sourceLanguage').value = 'English';
    page.event('translationSettings', 'change');
    page.event('btnSwap', 'click');
    await page.flush();
    assert.equal(page.element('sourceText').value, '안녕');
    assert.equal(page.element('sourceLanguage').value, 'Korean');
    assert.equal(page.element('targetLanguage').value, 'English');
    assert.equal(page.requests.length, 1);
    const restored = await page.reload();
    assert.equal(restored.element('sourceText').value, '안녕');
    assert.ok(restored.element('resultRelationship').textContent);
    assert.equal(restored.requests.length, 1);
  },
}, {
  name: 'previous result remains associated with its old input until a valid new run',
  async fn() {
    const page = await openPage();
    page.source('Hello');
    await page.start();
    page.requests[0].respond('안녕');
    await page.flush();
    assert.equal(page.element('resultRelationship').textContent, '');
    page.source('');
    assert.ok(page.element('resultRelationship').textContent);
    page.source('Hello');
    assert.equal(page.element('resultRelationship').textContent, '');
    page.source('');
    await page.start();
    assert.equal(page.element('translatedText').value, '안녕');
    assert.equal(page.requests.length, 1);
    page.source('Next');
    await page.start();
    assert.equal(page.element('translatedText').value, '');
    assert.equal(page.element('resultRelationship').textContent, '');
    assert.equal(page.requests[1].body.input, 'Next');
  },
}, {
  name: 'completed result swaps using its original language snapshot without a request',
  async fn() {
    const page = await openPage();
    page.element('sourceLanguage').value = 'English';
    page.source('Hello');
    await page.start();
    page.requests[0].respond('안녕');
    await page.flush();
    page.element('targetLanguage').value = 'Japanese';
    page.element('sourceLanguage').value = 'French';
    page.event('translationSettings', 'input');
    page.event('btnSwap', 'click');
    await page.flush();
    assert.equal(page.element('sourceText').value, '안녕');
    assert.equal(page.element('sourceLanguage').value, 'Korean');
    assert.equal(page.element('targetLanguage').value, 'English');
    assert.equal(page.element('translatedText').value, '안녕');
    assert.equal(page.requests.length, 1);
  },
}, {
  name: 'reload restores idle input and page settings without requesting a translation',
  async fn() {
    const page = await openPage();
    page.source('Retained draft');
    page.element('targetLanguage').value = 'Japanese';
    page.event('translationSettings', 'input');
    await page.flush();
    const restored = await page.reload();
    assert.equal(restored.element('sourceText').value, 'Retained draft');
    assert.equal(restored.element('targetLanguage').value, 'Japanese');
    assert.equal(restored.requests.length, 0);
  },
}, {
  name: 'worker replacement cannot let immediate reload overtake Clear or replay an older save',
  async fn() {
    const page = await openPage();
    page.source('Delete after worker replacement');
    await page.flush();
    const oldSave = structuredClone(page.messages.find(message => message.type === 'SAVE_TEXT_TRANSLATION_STATE'));
    page.replaceWorker();
    page.frames.hold = true;
    page.event('btnClear', 'click');
    await page.flush();
    page.frames.hold = false;
    const restored = await page.reload({ beforeReady: async () => {
      await page.flush();
      page.frames.pending?.splice(0).forEach(release => release());
    } });
    assert.equal(restored.element('sourceText').value, '');
    assert.equal(restored.element('translatedText').value, '');
    restored.replaceWorker();
    await page.send(oldSave);
    const again = await restored.reload();
    assert.equal(again.element('sourceText').value, '');
  },
}, {
  name: 'old document Clear cannot delete a new document draft after ownership changes',
  async fn() {
    const page = await openPage();
    page.source('Old draft');
    page.event('btnClear', 'click');
    await page.flush();
    const oldClear = structuredClone(page.messages.find(message => message.type === 'CLEAR_TEXT_TRANSLATION_STATE'));
    const restored = await page.reload();
    restored.source('New document draft');
    await restored.flush();
    restored.replaceWorker();
    assert.equal((await page.send({ ...oldClear, revision: oldClear.revision + 100 })).ok, false);
    const again = await restored.reload();
    assert.equal(again.element('sourceText').value, 'New document draft');
  },
}, {
  name: 'Clear revision survives worker replacement and refuses an older save from the same document',
  async fn() {
    const page = await openPage();
    page.source('Deleted old draft');
    await page.flush();
    const oldSave = structuredClone(page.messages.find(message => message.type === 'SAVE_TEXT_TRANSLATION_STATE'));
    page.event('btnClear', 'click');
    await page.flush();
    page.replaceWorker();
    await page.send(oldSave);
    const restored = await page.reload();
    assert.equal(restored.element('sourceText').value, '');
    assert.equal(restored.element('translatedText').value, '');
  },
}, {
  name: 'Clear accepted before reload deletes the draft even when its native context lookup is delayed',
  async fn() {
    const page = await openPage();
    page.source('Delete before immediate reload');
    await page.flush();
    page.frames.hold = true;
    page.event('btnClear', 'click');
    await page.flush();
    page.frames.hold = false;
    const pending = page.reload({ beforeReady: async () => {
      await page.flush();
      page.frames.pending.splice(0).forEach(release => release());
    } });
    const restored = await pending;
    assert.equal(restored.element('sourceText').value, '');
    assert.equal(restored.element('translatedText').value, '');
  },
}, {
  name: 'reload preserves the newest accepted draft queued behind an earlier storage write',
  async fn() {
    const page = await openPage();
    page.storage.hold = true;
    page.source('Earlier draft');
    await page.flush();
    page.source('Newest draft');
    await page.flush();
    const restored = await page.reload({ beforeReady: async () => {
      await page.flush();
      page.storage.hold = false;
      page.storage.held.splice(0).forEach(release => release());
    } });
    assert.equal(restored.element('sourceText').value, 'Newest draft');
    assert.equal(restored.requests.length, 0);
  },
}, {
  name: 'tab closure during deferred frame lookup cannot recreate deleted retained state',
  async fn() {
    const page = await openPage();
    page.frames.hold = true;
    page.source('Late draft');
    await page.flush();
    await page.close();
    page.frames.hold = false;
    page.frames.release();
    await page.flush();
    assert.equal(Object.hasOwn(page.session, 'text-translation:90'), false);
  },
}, {
  name: 'reload waits for already-issued storage and refuses old document writes and changed-setting resume',
  async fn() {
    const page = await openPage();
    page.source('Original');
    await page.start();
    await page.stop();
    page.storage.hold = true;
    page.element('model').value = 'new-model';
    page.event('translationSettings', 'input');
    await page.flush();
    const oldSave = structuredClone(page.messages.filter(message => message.type === 'SAVE_TEXT_TRANSLATION_STATE').at(-1));
    const pending = page.reload();
    page.storage.hold = false;
    page.storage.held.splice(0).forEach(release => release());
    const restored = await pending;
    assert.equal(restored.element('model').value, 'new-model');
    assert.equal(restored.element('btnResume').disabled, true);
    await restored.resume();
    assert.equal(restored.requests.length, 1);
    oldSave.revision += 100;
    assert.equal((await page.send(oldSave)).ok, false);
    const again = await restored.reload();
    assert.equal(again.element('model').value, 'new-model');
    assert.equal(again.requests.length, 1);
    assert.equal(JSON.stringify(page.storage.writes).includes('sk-test-synthetic'), false);
    assert.equal(JSON.stringify(page.storage.writes).includes('sk-router-synthetic'), false);
  },
}, {
  name: 'tabs own separate drafts, completed results and cancellation while duplicated pages start empty',
  async fn() {
    const first = await openPage();
    first.source('First tab');
    await first.start();
    const second = await openPage({ previous: first, tabId: 91, documentId: 'second' });
    assert.equal(second.element('sourceText').value, '');
    second.source('Second tab');
    await second.start();
    await first.close();
    assert.equal(first.requests[0].signal.aborted, true);
    assert.equal(first.requests[1].signal.aborted, false);
    first.requests[0].respond('닫힌 탭');
    first.requests[1].respond('둘째 결과');
    await second.flush();
    const restored = await second.reload();
    assert.equal(restored.element('sourceText').value, 'Second tab');
    assert.equal(restored.element('translatedText').value, '둘째 결과');
    const reopened = await openPage({ previous: restored, tabId: 92, documentId: 'reopened' });
    assert.equal(reopened.element('sourceText').value, '');
    assert.equal(reopened.element('translatedText').value, '');
    assert.equal(Object.hasOwn(first.session, 'text-translation:90'), false);
  },
}, {
  name: 'Clear and tab closure follow pending writes and reject stale document saves',
  async fn() {
    for (const action of ['clear', 'close']) {
      const page = await openPage();
      page.storage.hold = true;
      page.source('Delete this draft');
      await page.flush();
      assert.equal(page.storage.held.length, 1);
      const oldSave = structuredClone(page.messages.find(message => message.type === 'SAVE_TEXT_TRANSLATION_STATE'));
      if (action === 'clear') page.event('btnClear', 'click');
      else await page.close();
      page.storage.hold = false;
      page.storage.held.splice(0).forEach(release => release());
      await page.flush();
      const checkpoint = { documentId: 'test-document',
        revision: page.messages.filter(message => message.type === 'CLEAR_TEXT_TRANSLATION_STATE').at(-1)?.revision,
        state: null };
      if (action === 'clear') assert.deepEqual(page.session['text-translation:90'], checkpoint);
      else assert.equal(Object.hasOwn(page.session, 'text-translation:90'), false, action);
      const stale = await page.send(oldSave);
      if (action === 'close') assert.equal(stale.ok, false);
      await page.flush();
      if (action === 'clear') assert.deepEqual(page.session['text-translation:90'], checkpoint);
      else assert.equal(Object.hasOwn(page.session, 'text-translation:90'), false, action);
      const restored = action === 'clear' ? await page.reload() :
        await openPage({ previous: page, tabId: 91, documentId: 'new-tab' });
      assert.equal(restored.element('sourceText').value, '', action);
      assert.equal(restored.element('translatedText').value, '', action);
    }
  },
}, {
  name: 'reload interrupts running work and restores completed portions for explicit resume only',
  async fn() {
    for (const status of ['running', 'stopped', 'failed', 'complete']) {
      const page = await openPage();
      const first = 'A'.repeat(8000) + '\n\n';
      const second = 'B'.repeat(8000);
      page.source(first + second);
      await page.start();
      page.requests[0].respond('앞부분');
      await page.flush();
      if (status === 'stopped') await page.stop();
      if (status === 'failed') {
        page.requests[1].respond('실패', 'incomplete');
        await page.flush();
      }
      if (status === 'complete') {
        page.requests[1].respond('끝부분');
        await page.flush();
      }
      const restored = await page.reload();
      assert.equal(restored.element('sourceText').value, first + second, status);
      assert.equal(restored.element('translatedText').value, status === 'complete' ? '앞부분\n\n끝부분' : '앞부분\n\n', status);
      assert.equal(restored.requests.length, 2, status);
      assert.equal(restored.element('btnResume').disabled, status === 'complete', status);
      page.requests[1].respond('오래된 응답');
      await page.flush();
      if (status !== 'complete') {
        await restored.resume();
        assert.deepEqual(restored.requests.map(request => request.body.input), [first, second, second]);
        restored.requests[2].respond('새 끝부분');
        await restored.flush();
        assert.equal(restored.element('translatedText').value, '앞부분\n\n새 끝부분');
      }
      const again = await restored.reload();
      assert.equal(again.element('translatedText').value, status === 'complete' ? '앞부분\n\n끝부분' : '앞부분\n\n새 끝부분');
    }
  },
}, {
  name: '60,000 Unicode code points run once in bounded sequential units and invalid input preserves results',
  async fn() {
    const page = await openPage();
    page.source('😀'.repeat(60000));
    assert.deepEqual(page.element('inputHint').textContent.match(/\d[\d,]*/g), ['60,000', '60,000']);
    await page.start();
    for (let index = 0; index < 5; index += 1) {
      assert.equal(page.requests.length, index + 1);
      assert.equal(page.requests[index].body.input, '😀'.repeat(12000));
      page.requests[index].respond(['하나', '둘', '셋', '넷', '다섯'][index]);
      await page.flush();
    }
    assert.equal(page.element('translatedText').value, '하나둘셋넷다섯');
    assert.equal(page.element('btnResume').disabled, true);
    for (const invalid of ['', ' \n ', '😀'.repeat(60001)]) {
      page.source(invalid);
      await page.start();
      assert.equal(page.requests.length, 5);
      assert.equal(page.element('sourceText').value, invalid);
      assert.equal(page.element('translatedText').value, '하나둘셋넷다섯');
      assert.equal(page.element('errorBox').hidden, false);
    }
  },
}, {
  name: 'paragraph boundaries survive partial completion, Stop and resume without re-requesting completed source',
  async fn() {
    const page = await openPage();
    const first = 'A'.repeat(8000) + '\n\n';
    const second = 'B'.repeat(8000);
    page.source(first + second);
    await page.start();
    assert.equal(page.requests[0].body.input, first);
    page.requests[0].respond('첫 문단');
    await page.flush();
    assert.equal(page.requests.length, 2);
    assert.equal(page.element('translatedText').value, '첫 문단\n\n');
    await page.stop();
    assert.equal(page.requests[1].signal.aborted, true);
    assert.equal(page.element('btnResume').disabled, false);
    assert.equal(page.element('btnSwap').disabled, true);
    page.event('btnSwap', 'click');
    assert.equal(page.element('sourceText').value, first + second);
    page.requests[1].respond('오래된 응답');
    await page.flush();
    assert.equal(page.element('translatedText').value, '첫 문단\n\n');
    await page.resume();
    assert.equal(page.requests.length, 3);
    assert.deepEqual(page.requests.map(request => request.body.input), [first, second, second]);
    page.requests[2].respond('나머지');
    await page.flush();
    assert.equal(page.element('translatedText').value, '첫 문단\n\n나머지');
  },
}, {
  name: 'incomplete or malformed units retain the completed prefix until explicit resume',
  async fn() {
    for (const status of ['incomplete', 'failed', 'in_progress']) {
      const page = await openPage();
      page.source('A'.repeat(8000) + '\n\n' + 'B'.repeat(8000));
      await page.start();
      page.requests[0].respond('앞부분');
      await page.flush();
      page.requests[1].respond('잘린 응답', status);
      await page.flush();
      assert.equal(page.requests.length, 2);
      assert.equal(page.element('translatedText').value, '앞부분\n\n');
      assert.equal(page.element('btnResume').disabled, false);
      assert.equal(page.element('errorBox').hidden, false);
      await page.resume();
      assert.equal(page.requests.length, 3);
      assert.equal(page.requests[2].body.input, 'B'.repeat(8000));
      page.requests[2].respond('뒷부분');
      await page.flush();
      assert.equal(page.element('translatedText').value, '앞부분\n\n뒷부분');
    }
  },
}, {
  name: 'every effective source and translation setting must match before resume',
  async fn() {
    for (const [field, value] of [['sourceText', 'changed'], ['sourceLanguage', 'French'],
      ['targetLanguage', 'Japanese'], ['tone', 'formal'], ['service', 'openrouter'],
      ['model', 'another-model'], ['reasoningEffort', 'high']]) {
      const page = await openPage();
      page.source('Original');
      await page.start();
      await page.stop();
      page.element(field).value = value;
      if (field === 'service') page.event(field, 'change');
      page.event(field === 'sourceText' ? field : 'translationSettings', 'input');
      assert.equal(page.element('btnResume').disabled, true, field);
      await page.resume();
      assert.equal(page.requests.length, 1, field);
    }
  },
}, {
  name: 'late Chrome delivery from a completed old request cannot overwrite a resumed generation',
  async fn() {
    const page = await openPage();
    const first = 'A'.repeat(8000) + '\n\n';
    const second = 'B'.repeat(8000);
    page.source(first + second);
    await page.start();
    page.requests[0].respond('앞부분');
    await page.flush();
    page.holdDelivery(true);
    page.requests[1].respond('오래된 뒷부분');
    await page.flush();
    await page.stop();
    await page.resume();
    assert.deepEqual(page.requests.map(request => request.body.input), [first, second, second]);
    page.holdDelivery(false);
    page.requests[2].respond('새 뒷부분');
    await page.flush();
    await page.releaseDelivery();
    assert.equal(page.element('translatedText').value, '앞부분\n\n새 뒷부분');
    assert.equal(page.element('btnResume').disabled, true);
    assert.equal(page.requests.length, 3);
  },
}, {
  name: 'paragraph splitting prefers a blank line over a later single CRLF',
  async fn() {
    const page = await openPage();
    const first = 'A'.repeat(4000) + '\n\n';
    const rest = 'B'.repeat(4000) + '\r\n' + 'C'.repeat(8000);
    page.source(first + rest);
    await page.start();
    assert.equal(page.requests[0].body.input, first);
    page.requests[0].respond('문단');
    await page.flush();
    assert.equal(page.requests[1].body.input, 'B'.repeat(4000) + '\r\n' + 'C'.repeat(7998));
    page.requests[1].respond('첫 줄\r\n둘째 줄');
    await page.flush();
    assert.equal(page.requests[2].body.input, 'CC');
    page.requests[2].respond('끝');
    await page.flush();
    assert.equal(page.element('translatedText').value, '문단\n\n첫 줄\r\n둘째 줄끝');
    assert.equal(page.requests.map(request => request.body.input).join(''), first + rest);
  },
}, {
  name: 'a CRLF at a request boundary and whitespace-only units remain lossless',
  async fn() {
    const page = await openPage();
    page.source('A'.repeat(11999) + '\r\n' + 'B');
    await page.start();
    assert.equal(page.requests[0].body.input, 'A'.repeat(11999));
    page.requests[0].respond('앞');
    await page.flush();
    assert.equal(page.requests[1].body.input, '\r\nB');
    page.requests[1].respond('뒤');
    await page.flush();
    assert.equal(page.element('translatedText').value, '앞\r\n뒤');
    assert.equal(page.requests.map(request => request.body.input).join(''), 'A'.repeat(11999) + '\r\nB');
  },
}, {
  name: 'oversized whitespace is preserved locally and internal line loss cannot complete a unit',
  async fn() {
    const page = await openPage();
    page.source(' '.repeat(12000) + 'Hello\n\nWorld\n');
    await page.start();
    assert.equal(page.requests.length, 1);
    assert.equal(page.requests[0].body.input, 'Hello\n\nWorld\n');
    page.requests[0].respond('줄이 사라진 응답');
    await page.flush();
    assert.equal(page.element('translatedText').value, ' '.repeat(12000));
    assert.equal(page.element('btnResume').disabled, false);
    await page.resume();
    page.requests[1].respond('안녕\n\n세상');
    await page.flush();
    assert.equal(page.element('translatedText').value, ' '.repeat(12000) + '안녕\n\n세상\n');
  },
}];
