const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createBackgroundWorker } = require('../extension/background.js');

async function openPage() {
  const elements = new Map();
  const requests = [];
  const messages = [];
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
  const worker = createBackgroundWorker({ chrome: {
    runtime: { getURL: path => `chrome-extension://test/${path}` },
    storage: { local: { async get() { return { settings: stored }; } } },
  }, fetch: (url, options) => new Promise(resolve => {
    requests.push({ url, body: JSON.parse(options.body), signal: options.signal,
      respond(translation, status = 'completed', sourceLanguage = 'English') {
        resolve({ ok: true, json: async () => ({ status, output: [{ type: 'message',
          content: [{ type: 'output_text', text: JSON.stringify({ translation, sourceLanguage }) }] }] }) });
      } });
  }) });
  const chrome = { runtime: { sendMessage(message) {
    messages.push(message);
    return new Promise(resolve => worker.handlers.onMessage(message,
      { tab: { id: 90 }, frameId: 0, documentId: 'test-document', url: 'chrome-extension://test/text-translation.html' },
      response => {
        if (holdDelivery && message.type === 'TRANSLATE_TEXT') deliveries.push(() => resolve(response));
        else resolve(response);
      }));
  } } };
  const context = vm.createContext({ chrome, document: { getElementById: element, addEventListener() {} },
    window: { addEventListener() {} }, crypto: { randomUUID: () => `operation-${++serial}` },
    navigator: { clipboard: { async writeText() {} } },
    ChromeAiTranslatorTextTranslationRequest: require('../extension/text-translation-request.js'),
    ChromeAiTranslatorDefaultModel: require('../extension/default-model.js') });
  vm.runInContext(fs.readFileSync(require.resolve('../extension/text-translation.js'), 'utf8'), context);
  async function flush() { for (let i = 0; i < 64; i += 1) await Promise.resolve(); }
  function event(id, type) { element(id).listeners[type]?.({ preventDefault() {} }); }
  await flush();
  assert.equal(element('btnTranslate').disabled, false);
  return { element, event, requests, messages, flush,
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
