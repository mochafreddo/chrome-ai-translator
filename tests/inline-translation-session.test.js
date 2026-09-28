const assert = require('node:assert/strict');
const session = require('../extension/inline-translation-session.js');
const { createReasoningFixture, createTestDocument } = require('./inline-block.test');
const { DEFAULT_MODEL } = require('../extension/default-model.js');

const KOREAN = {
  targetLanguage: 'Korean',
  tone: 'technical',
  model: 'gpt-5.4-mini',
  reasoningEffort: 'none',
};
const JAPANESE = { ...KOREAN, targetLanguage: 'Japanese' };
const ORIGINAL_TEXT = 'Reasoning models like GPT-5.5 use internal reasoning tokens.';
const TRANSLATED_TEXT = 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.';
const NOTHING = { translated: 0, partial: 0, pending: 0, changed: 0, failed: 0 };

// A translation of the reasoning fixture that keeps every token its batch record was sent
// with, the way a well-behaved model answers.
function translate(record) {
  const wrapper = record.contract.entries.find((entry) => entry.kind === 'wrapper');
  const atom = record.contract.entries.find((entry) => entry.kind === 'atom');
  return `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
}

// The worker's answer to a batch: one applied result per record, each overridable.
function answer(batch, result = {}) {
  return {
    ok: true,
    results: batch.map((record) => ({
      id: record.id,
      disposition: 'apply',
      template: translate(record),
      attemptCount: 1,
      ...result,
    })),
  };
}

// A reasoning fixture whose text differs from the default one, so a cache that answers for
// one does not answer for the other.
function otherReasoningFixture(label) {
  const fixture = createReasoningFixture();
  fixture.strong.childNodes[0].nodeValue = label;
  return { ...fixture, originalText: fixture.block.textContent };
}

// A block admitted and sent, with its answer still outstanding.
function sendBlock(visit, fixture = createReasoningFixture()) {
  visit.admit(fixture.block);
  const batch = visit.takeBatch();
  assert.equal(batch.length, 1);
  return { ...fixture, batch };
}

// A block admitted, sent and translated through the session's own operations.
function translateBlock(visit, fixture = createReasoningFixture(), result = {}) {
  const { batch } = sendBlock(visit, fixture);
  visit.settle(batch, answer(batch, result));
  assert.notEqual(fixture.block.textContent, fixture.originalText || ORIGINAL_TEXT);
  return fixture;
}

exports.name = 'inline translation session';
exports.tests = [
  {
    name: 'keeps the Session Budget across stop, Start and Original text',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      visit.charge(1200);
      visit.stop();
      assert.equal(visit.spent, 1200);
      visit.begin(KOREAN);
      visit.charge(300);
      visit.restore();
      assert.equal(visit.spent, 1500);
      visit.begin(JAPANESE);
      assert.equal(visit.spent, 1500);

      // Only a new page visit starts counting again.
      assert.equal(session.createInlineTranslationSession().spent, 0);
    },
  },
  {
    name: 'advances the operation id on begin, stop and restore',
    fn() {
      const visit = session.createInlineTranslationSession();
      assert.equal(visit.status, 'original');
      const initial = visit.operationId;

      const { operationId: first } = visit.begin(KOREAN);
      assert.equal(first > initial, true);
      assert.equal(visit.operationId, first);
      assert.equal(visit.status, 'active');

      const stopped = visit.stop();
      assert.equal(stopped > first, true);
      assert.equal(visit.operationId, stopped);
      assert.equal(visit.status, 'stopped');
      // A second Stop has no operation left to end.
      assert.equal(visit.stop(), stopped);

      const { operationId: second } = visit.begin(KOREAN);
      assert.equal(second > stopped, true);

      const restored = visit.restore();
      assert.equal(restored > second, true);
      assert.equal(visit.operationId, restored);
      assert.equal(visit.status, 'original');
    },
  },
  {
    name: 'carries translated blocks into the next operation under unchanged settings',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block } = translateBlock(visit);
      visit.stop();

      // The API key is not a translation setting, so it does not change what carries over.
      visit.begin({ ...KOREAN, apiKey: 'other' });

      assert.deepEqual(visit.progress().counts, { ...NOTHING, translated: 1 });
      assert.equal(block.textContent, TRANSLATED_TEXT);
      // Already translated, so a rescan that reaches it again sends nothing.
      assert.equal(visit.admit(block), null);
      assert.deepEqual(visit.takeBatch(), []);
    },
  },
  {
    name: 'restores carried blocks when the settings change',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block, strong, link } = translateBlock(visit);
      visit.stop();

      visit.begin(JAPANESE);

      assert.deepEqual(visit.progress().counts, NOTHING);
      assert.equal(block.textContent, ORIGINAL_TEXT);
      assert.equal(block.childNodes[0], strong);
      assert.equal(block.childNodes[2], link);
      // The Korean translation is not the answer under Japanese, so the block is sent again.
      visit.admit(block);
      assert.equal(visit.takeBatch().length, 1);
    },
  },
  {
    name: 'restores through Original text every block the visit translated',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const earlier = translateBlock(visit);
      visit.stop();
      visit.begin(KOREAN);
      const current = translateBlock(visit, otherReasoningFixture('Other reasoning models'));
      const queued = otherReasoningFixture('Queued reasoning models');
      visit.admit(queued.block);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, translated: 2, pending: 1 });

      visit.restore();

      assert.equal(earlier.block.textContent, ORIGINAL_TEXT);
      assert.equal(current.block.textContent, current.originalText);
      assert.equal(queued.block.textContent, queued.originalText);
      assert.deepEqual(visit.progress().counts, NOTHING);
      // Nothing restored is carried into the next operation.
      visit.begin(KOREAN);
      assert.deepEqual(visit.progress().counts, NOTHING);
    },
  },
  {
    name: 'keeps one translation cache per translation settings',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin({ ...KOREAN, apiKey: 'secret-one' });
      const { block } = translateBlock(visit);
      visit.restore();

      // Only the settings the translation was made under answer for it from the cache.
      for (const settings of [
        { ...KOREAN, targetLanguage: 'Japanese' },
        { ...KOREAN, tone: 'natural' },
        { ...KOREAN, model: 'gpt-5.4' },
        { ...KOREAN, reasoningEffort: 'low' },
      ]) {
        visit.begin(settings);
        assert.equal(visit.admit(block).state, 'queued', JSON.stringify(settings));
        assert.equal(block.textContent, ORIGINAL_TEXT);
        visit.restore();
      }
      visit.begin({ ...KOREAN, apiKey: 'secret-two' });
      assert.equal(visit.admit(block), null);
      assert.equal(block.textContent, TRANSLATED_TEXT);
    },
  },
  {
    name: 'applies a cached translation without a request or a charge',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      // A repaired answer: the cache replays its attempt count, but nothing is sent for it now.
      const { block } = translateBlock(visit, undefined, { attemptCount: 2 });
      visit.restore();
      assert.equal(block.textContent, ORIGINAL_TEXT);
      const spent = visit.spent;

      visit.begin(KOREAN);

      assert.equal(visit.admit(block), null);
      assert.deepEqual(visit.takeBatch(), []);
      assert.equal(block.textContent, TRANSLATED_TEXT);
      assert.equal(visit.spent, spent);
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, translated: 1 }, reason: '' });
    },
  },
  {
    name: 'refuses a block too large for one request without sending it',
    fn() {
      const { document, element, text } = createTestDocument();
      // Under the request cap in actual cost, over it once the repair is reserved.
      const block = element('p', text('An article sentence with ordinary prose. '.repeat(175)));
      document.body.appendChild(block);
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);

      visit.admit(block);

      assert.deepEqual(visit.takeBatch(), []);
      assert.equal(visit.spent, 0);
      const { counts, reason } = visit.progress();
      assert.deepEqual(counts, { ...NOTHING, failed: 1 });
      assert.match(reason, /exceeds the 12,000-character request limit, so no request was sent/);
      assert.deepEqual(
        visit.outbox.map(({ code, evidence }) => ({ code, limit: evidence.limit })),
        [{ code: 'runtime.block_too_large', limit: 12000 }]
      );
      assert.equal(visit.outbox[0].evidence.recordCost > 12000, true);
    },
  },
  {
    name: 'refuses a block it cannot serialize without sending it',
    fn() {
      const { document, element, text } = createTestDocument();
      const block = element('li', text('Outer item text.'), element('p', text('Nested paragraph.')));
      document.body.appendChild(block);
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);

      assert.equal(visit.admit(block).state, 'failed');

      assert.deepEqual(visit.takeBatch(), []);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, failed: 1 });
      assert.match(visit.progress().reason, /unsupported structure, so no request was sent/);
      assert.deepEqual(visit.outbox, [{
        code: 'runtime.unsupported_block',
        evidence: {},
        localRejection: { reason: 'nested_semantic_block', tag: 'P' },
      }]);
      // A rescan that reaches the block again does not refuse it a second time.
      assert.equal(visit.admit(block), null);
      assert.equal(visit.outbox.length, 1);
    },
  },
  {
    name: 'charges a repair the current operation reports, and only a repair',
    fn() {
      for (const attemptCount of [1, 2]) {
        const visit = session.createInlineTranslationSession();
        visit.begin(KOREAN);
        const { batch } = sendBlock(visit);
        // A fresh visit has been charged for exactly this one record so far.
        const recordCost = visit.spent;
        assert.equal(recordCost > 0, true);

        visit.settle(batch, answer(batch, { attemptCount }));

        assert.equal(visit.spent, recordCost * attemptCount, `attemptCount ${attemptCount}`);
      }
    },
  },
  ...[
    { name: 'Stop', end: (visit) => visit.stop() },
    { name: 'Original text', end: (visit) => visit.restore() },
    { name: 'Stop and Start', end: (visit) => { visit.stop(); visit.begin(KOREAN); } },
    { name: 'Original text and Start', end: (visit) => { visit.restore(); visit.begin(KOREAN); } },
  ].map(({ name, end }) => ({
    name: `charges a late repair after ${name} and only releases its token`,
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block, batch } = sendBlock(visit);
      const recordCost = visit.spent;
      end(visit);
      const progress = visit.progress();

      const settled = visit.settle(
        batch,
        answer(batch, { attemptCount: 2, correlationToken: 'late-token' })
      );

      // The repair was sent whatever the reader did since, so the page visit pays for it.
      assert.equal(visit.spent, recordCost * 2);
      assert.deepEqual(settled, {
        runtimeOutcomes: [],
        releaseTokens: ['late-token'],
        diagnosticsUnavailable: false,
      });
      assert.equal(block.textContent, ORIGINAL_TEXT);
      assert.deepEqual(visit.progress(), progress);
      assert.deepEqual(visit.takeBatch(), []);
    },
  })),
  {
    name: 'fails a batch whose request came back with nothing, without refunding it',
    fn() {
      for (const response of [null, { ok: false, results: [] }, { ok: true }]) {
        const visit = session.createInlineTranslationSession();
        visit.begin(KOREAN);
        const { block, batch } = sendBlock(visit);
        const spent = visit.spent;

        const settled = visit.settle(batch, response);

        assert.deepEqual(settled, {
          runtimeOutcomes: [],
          releaseTokens: [],
          diagnosticsUnavailable: false,
        });
        assert.equal(visit.spent, spent);
        assert.equal(block.textContent, ORIGINAL_TEXT);
        assert.deepEqual(visit.progress(), {
          counts: { ...NOTHING, failed: 1 },
          reason: 'Translation failed (1 block): The translation request could not be completed.',
        });
      }
    },
  },
  {
    name: 'fails a batch whose answer the page could not settle, rather than leaving it pending',
    fn() {
      const codec = require('../extension/inline-block.js');
      const previousCreatePatchPlan = codec.createPatchPlan;
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { batch } = sendBlock(visit);
      codec.createPatchPlan = () => {
        throw new Error('synthetic codec failure');
      };
      try {
        assert.deepEqual(visit.settle(batch, answer(batch, { correlationToken: 'token' })), {
          runtimeOutcomes: [],
          releaseTokens: [],
          diagnosticsUnavailable: false,
        });
      } finally {
        codec.createPatchPlan = previousCreatePatchPlan;
      }
      assert.deepEqual(visit.progress().counts, { ...NOTHING, failed: 1 });
      // The request it ended no longer holds one of the two places in flight.
      sendBlock(visit, otherReasoningFixture('Next reasoning models'));
      sendBlock(visit, otherReasoningFixture('Last reasoning models'));
    },
  },
  {
    name: 'holds at most two requests in flight, and settling one frees its place',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const first = sendBlock(visit, otherReasoningFixture('First reasoning models'));
      sendBlock(visit, otherReasoningFixture('Second reasoning models'));
      visit.admit(otherReasoningFixture('Third reasoning models').block);

      assert.deepEqual(visit.takeBatch(), []);

      // A malformed entry among the results settles like any other answer.
      visit.settle(first.batch, { ok: true, results: [null] });
      assert.equal(visit.takeBatch().length, 1);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, pending: 2, failed: 1 });
    },
  },
  {
    name: 'retries a block the page changed once, and lets the retry answer for the change',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block, strong, batch } = sendBlock(visit);
      strong.childNodes[0].nodeValue = 'Updated reasoning models';

      const first = visit.settle(batch, answer(batch, { correlationToken: 'first' }));

      // The retry answers for the change, so the page files nothing for it.
      assert.deepEqual(first, { runtimeOutcomes: [], releaseTokens: ['first'], diagnosticsUnavailable: false });
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, pending: 1 }, reason: '' });
      const retry = visit.takeBatch();
      assert.equal(retry.length, 1);
      assert.match(retry[0].template, /Updated reasoning models/);

      visit.settle(retry, answer(retry));

      assert.equal(block.textContent, TRANSLATED_TEXT);
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, translated: 1 }, reason: '' });
    },
  },
  {
    name: 'files a change its one retry did not survive',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { strong, batch } = sendBlock(visit);
      strong.childNodes[0].nodeValue = 'Updated reasoning models';
      visit.settle(batch, answer(batch));
      const retry = visit.takeBatch();
      strong.childNodes[0].nodeValue = 'Updated again';

      const settled = visit.settle(retry, answer(retry, { correlationToken: 'retry' }));

      assert.deepEqual(settled.runtimeOutcomes, [
        { code: 'runtime.page_changed', correlationToken: 'retry' },
      ]);
      assert.deepEqual(settled.releaseTokens, []);
      assert.deepEqual(visit.takeBatch(), []);
      assert.deepEqual(visit.progress(), {
        counts: { ...NOTHING, changed: 1 },
        reason: 'Changed (1 block): Page changed before translation could be applied.',
      });
    },
  },
  ...['queued', 'translating'].map((retryState) => ({
    name: `stopping a ${retryState} retry leaves the change it superseded unresolved`,
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { strong, batch } = sendBlock(visit);
      strong.childNodes[0].nodeValue = 'Updated reasoning models';
      visit.settle(batch, answer(batch));
      if (retryState === 'translating') assert.equal(visit.takeBatch().length, 1);

      visit.stop();

      assert.deepEqual(visit.progress(), {
        counts: { ...NOTHING, pending: 1, changed: 1 },
        reason: 'Changed (1 block): Page changed before translation could be applied.',
      });
    },
  })),
  // What settling returns for the page to file, per outcome. The worker has already recorded
  // its own verdicts and the results it could not produce, so those only release their
  // tokens; the page files an application failure and a change no retry supersedes.
  ...[
    {
      name: 'an application failure',
      result: { template: 'no tokens survive' },
      settled: { runtimeOutcomes: [{ code: 'runtime.token_missing', correlationToken: 'token' }], releaseTokens: [] },
      counts: { failed: 1 },
    },
    {
      name: 'a worker verdict',
      result: { disposition: 'reject', template: undefined, terminalCode: 'structure.token_missing', attemptCount: 2 },
      settled: { runtimeOutcomes: [], releaseTokens: ['token'] },
      counts: { failed: 1 },
    },
    {
      name: 'a partial translation',
      result: { disposition: 'apply_with_warning', terminalCode: 'quality.english_residue' },
      settled: { runtimeOutcomes: [], releaseTokens: ['token'] },
      counts: { partial: 1 },
    },
    {
      name: 'a changed block no retry supersedes',
      change: ({ document }) => document.body.replaceChildren(),
      settled: { runtimeOutcomes: [{ code: 'runtime.page_changed', correlationToken: 'token' }], releaseTokens: [] },
      counts: { changed: 1 },
    },
    {
      name: 'a missing result',
      results: [],
      settled: { runtimeOutcomes: [], releaseTokens: [] },
      counts: { failed: 1 },
    },
  ].map(({ name, result = {}, results, change, settled, counts }) => ({
    name: `returns the runtime outcomes to file after ${name}`,
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const fixture = sendBlock(visit);
      change?.(fixture);
      const response = answer(fixture.batch, { correlationToken: 'token', ...result });
      if (results) response.results = results;

      assert.deepEqual(visit.settle(fixture.batch, response), {
        ...settled,
        diagnosticsUnavailable: false,
      });
      assert.deepEqual(visit.progress().counts, { ...NOTHING, ...counts });
    },
  })),
  {
    name: 'says when the worker could not save diagnostics for a batch',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { batch } = sendBlock(visit);

      const settled = visit.settle(batch, answer(batch, { diagnosticsUnavailable: true }));

      assert.equal(settled.diagnosticsUnavailable, true);
    },
  },
  {
    name: 'builds inline translation settings snapshot without api key',
    fn() {
      assert.deepEqual(
        session.createSettingsSnapshot({
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          apiKey: 'sk-secret',
          viewMode: 'bilingual',
          chunkMaxChars: 24000,
        }),
        {
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
        }
      );
      assert.deepEqual(session.createSettingsSnapshot({}), {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: DEFAULT_MODEL,
        reasoningEffort: 'none',
      });
    },
  },
];
