const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { createBackgroundWorker } = require('../extension/background.js');
const { createInlineTranslationSession } = require('../extension/inline-translation-session.js');
const { createTestDocument, createReasoningFixture } = require('./inline-block.test.js');
const protocol = require('../extension/inline-diagnostics-protocol.js');

const SETTINGS = { service: 'openai', model: 'gpt-5.4-mini', reasoningEffort: 'none', targetLanguage: 'Korean', tone: 'technical' };

function createWorker(answer) {
  const stored = { settings: { ...SETTINGS, apiKey: 'synthetic-request-flow-key' } };
  const requests = [];
  const worker = createBackgroundWorker({
    crypto: webcrypto,
    chrome: {
      runtime: { getManifest: () => ({ version: 'test' }) },
      storage: { local: {
        async get(keys) {
          return Object.fromEntries(keys.map(key => [key, stored[key]]));
        },
        async set(values) { Object.assign(stored, values); },
        async remove(keys) { for (const key of keys) delete stored[key]; },
      } },
    },
    async fetch(url, options) {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      const translations = answer(JSON.parse(body.input).records, requests.length);
      return { ok: true, async json() {
        return { status: 'completed', output: [{ type: 'message', content: [
          { type: 'output_text', text: JSON.stringify({ translations }) },
        ] }] };
      } };
    },
  });
  return {
    requests,
    send(message) {
      return new Promise(resolve => worker.handlers.onMessage(message, { tab: { id: 71 } }, resolve));
    },
  };
}

async function translateBatch(visit, worker) {
  const batch = visit.takeBatch();
  const response = await worker.send({
    type: 'TRANSLATE_VISIBLE_BLOCK_BATCH', records: batch,
    settingsSnapshot: SETTINGS, operationId: visit.operationId,
  });
  assert.equal(response.ok, true, JSON.stringify(response.error));
  const runtime = visit.settle(batch, response);
  const reported = await worker.send({ type: protocol.messages.recordRuntime, operationId: visit.operationId, ...runtime });
  assert.equal(reported.ok, true);
  return { batch, response };
}

exports.name = 'inline request flow';
exports.tests = [{
  name: 'characterizes Session to worker repair requests with quoted prose and cache restoration',
  async fn() {
    const cases = [
      ['Read the "Setup guide" section.', '"Setup guide" 절을 읽으세요.', '설정 안내 절을 읽으세요.', ['Setup guide']],
      ['Use the Spawned session block.', 'Spawned session 블록을 사용하세요.', '생성된 세션 블록을 사용하세요.', ['Spawned session']],
    ];
    const { document, element, text } = createTestDocument();
    const blocks = cases.map(([source]) => element('p', text(source)));
    blocks.forEach(block => document.body.appendChild(block));
    const originals = blocks.map(block => [...block.childNodes]);
    const visit = createInlineTranslationSession();
    visit.begin(SETTINGS);
    blocks.forEach(block => visit.admit(block));
    const worker = createWorker((records, attempt) => records.map((record, index) => ({
      id: record.id, template: cases[index][attempt === 1 ? 1 : 2],
    })));
    const { batch, response } = await translateBatch(visit, worker);
    assert.equal(batch.length, 2);
    assert.equal(worker.requests.length, 2);
    for (const [index, request] of worker.requests.entries()) {
      assert.equal(request.url, 'https://api.openai.com/v1/responses');
      assert.equal(request.options.headers.Authorization, 'Bearer synthetic-request-flow-key');
      assert.equal(request.body.store, false);
      assert.ok(request.body.input.length <= 12000);
      assert.deepEqual(JSON.parse(request.body.input).records, cases.map(([source, initial, , phrases], i) => ({
        id: batch[i].id, template: source, atoms: [], repair: index === 0 ? null : {
          attempt: 1, previousErrorCode: 'quality.english_residue', previousTemplate: initial, untranslatedPhrases: phrases,
        },
      })));
    }
    assert.deepEqual(response.results.map(result => result.attemptCount), [2, 2]);
    assert.equal(response.results.every(result => Number.isSafeInteger(result.repairRecordCost) && result.repairRecordCost > 35), true);
    assert.deepEqual(blocks.map(block => block.textContent), cases.map(values => values[2]));
    assert.deepEqual(visit.progress().counts, { translated: 2, partial: 0, pending: 0, changed: 0, failed: 0 });
    visit.restore();
    blocks.forEach((block, index) => {
      assert.equal(block.textContent, cases[index][0]);
      assert.deepEqual([...block.childNodes], originals[index]);
    });
    visit.begin(SETTINGS);
    blocks.forEach(block => visit.admit(block));
    assert.deepEqual(visit.takeBatch(), []);
    assert.deepEqual(blocks.map(block => block.textContent), cases.map(values => values[2]));
    assert.equal(worker.requests.length, 2);
    visit.restore();
  },
}];

exports.tests.push({
  name: 'characterizes actual-cost worker admission separately from Session reservation',
  async fn() {
    const { document, element, text } = createTestDocument();
    const source = 'Read this guide carefully. '.repeat(240).trim();
    const block = element('p', text(source));
    document.body.appendChild(block);
    const visit = createInlineTranslationSession();
    visit.begin(SETTINGS);
    const record = visit.admit(block);
    assert.deepEqual(visit.takeBatch(), []);
    assert.equal(visit.outbox.at(-1).code, 'runtime.block_too_large');
    const worker = createWorker(records => records.map(({ id }) => ({ id, template: '안내서를 주의 깊게 읽으세요.' })));
    const response = await worker.send({
      type: 'TRANSLATE_VISIBLE_BLOCK_BATCH', records: [record], settingsSnapshot: SETTINGS,
      operationId: visit.operationId,
    });
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.equal(worker.requests.length, 1);
    assert.equal(JSON.parse(worker.requests[0].body.input).records[0].template, source);
    assert.equal(response.results[0].disposition, 'apply');
  },
}, {
  name: 'rejects a source missing its droppable emphasis pair before model transport',
  async fn() {
    const fixture = createReasoningFixture();
    const visit = createInlineTranslationSession();
    visit.begin(SETTINGS);
    visit.admit(fixture.block);
    const [record] = visit.takeBatch();
    const wrapper = record.contract.entries.find(entry => entry.kind === 'wrapper' && entry.droppable);
    assert.ok(wrapper);
    const worker = createWorker(records => records.map(({ id }) => ({ id, template: '안전한 번역입니다.' })));
    const response = await worker.send({
      type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
      records: [{ ...record, template: record.template.replace(wrapper.openToken, '').replace(wrapper.closeToken, '') }],
      settingsSnapshot: SETTINGS, operationId: visit.operationId,
    });
    assert.equal(response.ok, false);
    assert.match(response.error.message, /Invalid source token contract/);
    assert.equal(worker.requests.length, 0);
  },
});
