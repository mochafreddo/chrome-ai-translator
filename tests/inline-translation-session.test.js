const assert = require('node:assert/strict');
const session = require('../extension/inline-translation-session.js');
const { execute } = require('../extension/inline-model-execution.js');
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

// Restated deliberately: importing the cap would hide an accidental limit change.
const SESSION_BUDGET = 150000;

function paragraph(length) {
  const { document, element, text } = createTestDocument();
  const block = element('p', text('word '.repeat(Math.ceil(length / 5)).slice(0, length - 1) + '.'));
  document.body.appendChild(block);
  return block;
}

// Spend through the same serialized paragraphs as the page, settling each request so the
// next can run. A failed request still costs its initial submission and populates no cache.
function spend(visit, cost) {
  while (cost > 0) {
    const next = Math.min(4000, cost);
    visit.admit(paragraph(next - 6)); // empty atoms and null repair contribute six bytes
    const batch = visit.takeBatch();
    assert.equal(batch.length, 1, 'a paragraph within the remaining budget is admitted');
    visit.settle(batch, null);
    cost -= next;
  }
}

function assertRemainingBudget(visit, cost) {
  // End the operation to isolate the probe from pending records and cached results.
  visit.stop();
  visit.begin(JAPANESE);
  if (cost > 0) spend(visit, cost);
  visit.admit(paragraph(20));
  assert.deepEqual(visit.takeBatch(), [], 'no budget is refunded or silently reset');
  const refusal = visit.outbox.at(-1);
  assert.equal(refusal.code, 'runtime.session_too_large');
  assert.equal(refusal.evidence.sessionCost, SESSION_BUDGET);
}

function drain(visit, attemptCount = 1) {
  const taken = [];
  for (let batch; (batch = visit.takeBatch()).length;) {
    taken.push(...batch);
    visit.settle(batch, { ok: true, results: batch.map(({ id }) => ({
      id, disposition: 'apply', template: '번역한 문장입니다.', attemptCount,
    })) });
  }
  return taken;
}

exports.name = 'inline translation session';
exports.tests = [
  {
    name: 'exposes only allowlisted rejection metadata from unsupported page content',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { document, element, text } = createTestDocument();
      for (const [tag, attributes] of [
        ['private-widget', {}],
        ['button', { 'aria-label': 'private label' }],
        ['span', { hidden: '' }],
        ['span', { contenteditable: 'true' }],
        ['p', {}],
      ]) {
        const child = element(tag, text('private page prose'));
        for (const [key, value] of Object.entries(attributes)) child.setAttribute(key, value);
        if (tag === 'span' && 'hidden' in attributes) child.hidden = true;
        const block = element('p', text('Visible article prose. '), child,
          text(' Article prose continues.'));
        block.setAttribute('id', 'private-selector');
        document.body.appendChild(block);
        visit.admit(block);
      }
      assert.deepEqual(visit.takeBatch(), []);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, failed: 5 });
      assert.deepEqual(visit.outbox, [
        { reason: 'custom_element' },
        { reason: 'interactive_content', tag: 'BUTTON' },
        { reason: 'hidden_content', tag: 'SPAN' },
        { reason: 'editable_content', tag: 'SPAN' },
        { reason: 'nested_semantic_block', tag: 'P' },
      ].map(localRejection => ({ code: 'runtime.unsupported_block', evidence: {}, localRejection })));
      assert.equal(JSON.stringify(visit.outbox).includes('private'), false);
    },
  },
  {
    name: 'admits a Semantic Block once across repeated scans',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block } = createReasoningFixture();
      visit.admit(block);
      assert.equal(visit.admit(block), null);
      const batch = visit.takeBatch();
      assert.equal(batch.length, 1);
      assert.equal(batch[0].template.includes('GPT-5.5'), false);
      assert.equal(batch[0].atoms[0].label, 'GPT-5.5');
      assert.deepEqual(visit.progress().counts, { ...NOTHING, pending: 1 });
      assert.deepEqual(visit.takeBatch(), []);
    },
  },
  {
    name: 'charges actual record cost while reserving space for each request and repair',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      for (let index = 0; index < 500; index++) visit.admit(paragraph(40));
      const taken = drain(visit);
      assert.equal(taken.length, 500);
      assert.equal(taken.reduce((sum, record) => sum + session.getReservedRecordCost(record), 0) > SESSION_BUDGET, true);
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, translated: 500 }, reason: '' });
      assertRemainingBudget(visit, SESSION_BUDGET - 23000);
    },
  },
  {
    name: 'translates the ADR-0007 page reconstruction whole even when every block is repaired',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      // Synthetic reconstruction of the measured page's approximate shape, using real paragraphs.
      const lengths = [...Array(213).fill(36), ...Array(29).fill(30), ...Array(23).fill(55), ...Array(91).fill(303)];
      const blocks = lengths.map(paragraph);
      for (const block of blocks) visit.admit(block);
      const taken = drain(visit, 2);
      assert.equal(taken.length, 356);
      assert.equal(taken.reduce((sum, record) => sum + record.template.length, 0), 37376);
      assert.equal(taken.reduce((sum, record) => sum + session.getRecordCost(record), 0), 39512);
      assert.equal(taken.reduce((sum, record) => sum + session.getReservedRecordCost(record), 0), 162824);
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, translated: 356 }, reason: '' });
      assert.equal(blocks.every(block => block.textContent === '번역한 문장입니다.'), true);
      assertRemainingBudget(visit, SESSION_BUDGET - 79024);
    },
  },
  {
    name: 'refuses a full Session Budget and tells the reader to reload without naming a figure',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      spend(visit, SESSION_BUDGET);
      visit.restore();
      visit.begin(KOREAN);
      const block = paragraph(20);
      visit.admit(block);
      assert.deepEqual(visit.takeBatch(), []);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, failed: 1 });
      assert.equal(block.textContent, 'word word word word.');
      const reason = visit.progress().reason;
      assert.match(reason, /reached this page visit's limit, so no request was sent. Reload the page to continue/);
      assert.doesNotMatch(reason.split(': ')[1], /\d/);
      assert.deepEqual(visit.outbox.map(({ code, evidence }) => ({ code, limit: evidence.limit })), [
        { code: 'runtime.session_too_large', limit: SESSION_BUDGET },
      ]);
    },
  },
  {
    name: 'splits requests on reserved cost while retaining every admitted paragraph',
    async fn() {
      for (const [length, sizes] of [[4000, [1, 1, 1]], [2500, [2, 1]]]) {
        const visit = session.createInlineTranslationSession();
        visit.begin(KOREAN);
        const admitted = Array.from({ length: 3 }, () => visit.admit(paragraph(length)).id);
        const sent = [];
        for (const size of sizes) {
          const batch = visit.takeBatch();
          assert.equal(batch.length, size);
          const inputs = [];
          const results = await execute(batch, KOREAN, async ({ input }) => {
            inputs.push(input);
            const records = JSON.parse(input).records;
            if (inputs.length === 1) sent.push(...records.map(({ id }) => id));
            return JSON.stringify({ translations: records.map(({ id, template }) => ({
              id, template: inputs.length === 1 ? template : '번역한 문장입니다.',
            })) });
          });
          assert.equal(inputs.length, 2);
          assert.equal(inputs[0].length + inputs[1].length <= 12000, true);
          assert.deepEqual(JSON.parse(inputs[1]).records.map(({ id }) => id), batch.map(({ id }) => id));
          assert.equal(results.every(({ disposition, attemptCount }) => disposition === 'apply' && attemptCount === 2), true);
          visit.settle(batch, { ok: true, results });
        }
        assert.deepEqual(visit.takeBatch(), []);
        assert.deepEqual(sent, admitted);
        assert.deepEqual(visit.progress().counts, { ...NOTHING, translated: 3 });
      }
    },
  },
  {
    name: 'retains a queued page-change retry when a viewport rescan resets ordinary queued work',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { strong, batch, block } = sendBlock(visit);
      strong.childNodes[0].nodeValue = 'Updated reasoning models';
      visit.settle(batch, answer(batch));
      const control = paragraph(40);
      visit.admit(control);
      visit.resetQueue();
      assert.equal(visit.admit(block), null);
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, pending: 1 }, reason: '' });
      const retry = visit.takeBatch();
      assert.equal(retry.length, 1);
      assert.match(retry[0].template, /Updated reasoning models/);
      visit.settle(retry, answer(retry));
      assert.equal(block.textContent, TRANSLATED_TEXT);
      assert.deepEqual(visit.takeBatch(), []);
      visit.admit(control);
      assert.equal(visit.takeBatch().length, 1);
    },
  },
  {
    name: 'keeps a restarted operation retry distinct from its carried translation when stopped',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      translateBlock(visit);
      visit.stop();
      visit.begin(KOREAN);
      const { strong, batch } = sendBlock(visit, otherReasoningFixture('New reasoning models'));
      strong.childNodes[0].nodeValue = 'Updated reasoning models';
      visit.settle(batch, answer(batch));
      visit.stop();
      assert.deepEqual(visit.progress(), {
        counts: { ...NOTHING, translated: 1, pending: 1, changed: 1 },
        reason: 'Changed (1 block): Page changed before translation could be applied.',
      });
      assert.deepEqual(visit.takeBatch(), []);
    },
  },
  {
    name: 'restores and replays a cached partial translation as partial without a request',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block } = translateBlock(visit, undefined, {
        disposition: 'apply_with_warning', terminalCode: 'quality.english_residue', attemptCount: 2,
      });
      const progress = visit.progress();
      assert.deepEqual(progress.counts, { ...NOTHING, partial: 1 });
      assert.match(progress.reason, /Partial translation \(1 block\)/);
      visit.restore();
      assert.equal(block.textContent, ORIGINAL_TEXT);
      assert.deepEqual(visit.progress().counts, NOTHING);
      visit.begin(KOREAN);
      assert.equal(visit.admit(block), null);
      assert.deepEqual(visit.takeBatch(), []);
      assert.equal(block.textContent, TRANSLATED_TEXT);
      assert.deepEqual(visit.progress(), progress);
    },
  },
  {
    name: 'isolates an application failure from its valid sibling and files its runtime code',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const failed = createReasoningFixture();
      const sibling = otherReasoningFixture('Other reasoning models');
      visit.admit(failed.block);
      visit.admit(sibling.block);
      const batch = visit.takeBatch();
      // Fault at the DOM boundary: the page refuses the codec's replacement.
      failed.block.replaceChildren = () => { throw new Error('page refused update'); };
      const settled = visit.settle(batch, answer(batch, { correlationToken: 'apply-token' }));
      assert.deepEqual(settled.runtimeOutcomes, [{ code: 'runtime.apply_failed', correlationToken: 'apply-token' }]);
      assert.equal(failed.block.textContent, ORIGINAL_TEXT);
      assert.equal(sibling.block.textContent, TRANSLATED_TEXT);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, translated: 1, failed: 1 });
      assert.match(visit.progress().reason, /page rejected the translated update/);
    },
  },
  {
    name: 'readmits a translated block whose page-owned nodes were replaced',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { block, document } = translateBlock(visit);
      const previous = block.childNodes[1];
      const replacement = document.createTextNode(previous.nodeValue);
      block.childNodes.splice(1, 1, replacement);
      previous.parentNode = null;
      replacement.parentNode = block;
      visit.admit(block);
      assert.equal(visit.takeBatch().length, 1);
      assert.deepEqual(visit.progress().counts, { ...NOTHING, pending: 1, changed: 1 });
      assert.match(visit.progress().reason, /Page changed/);
    },
  },
  {
    name: 'aggregates terminal reasons from real transitions in stable reader-facing order',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      spend(visit, SESSION_BUDGET - 6000);
      visit.restore();
      visit.begin(KOREAN);
      // Produce the categories out of display order, including two partial translations.
      for (const terminalCode of ['protocol.invalid_json', 'structure.token_missing', 'quality.target_language_missing', 'quality.english_residue', 'quality.english_residue']) {
        const fixture = sendBlock(visit, otherReasoningFixture(`${terminalCode} ${visit.progress().counts.partial}`));
        visit.settle(fixture.batch, answer(fixture.batch, {
          disposition: terminalCode === 'quality.english_residue' ? 'apply_with_warning' : 'reject', terminalCode,
        }));
      }
      const application = sendBlock(visit, otherReasoningFixture('DOM failure'));
      application.block.replaceChildren = () => { throw new Error('page refused update'); };
      visit.settle(application.batch, answer(application.batch));
      const changed = sendBlock(visit, otherReasoningFixture('Detached block'));
      changed.document.body.replaceChildren();
      visit.settle(changed.batch, answer(changed.batch));
      const { document, element, text } = createTestDocument();
      const unsupported = element('li', text('Outer prose'), element('p', text('Nested prose')),
        text(' Outer prose continues.'));
      document.body.appendChild(unsupported);
      visit.admit(unsupported);
      visit.admit(paragraph(7000));
      visit.admit(paragraph(5000)); // exceeds the remaining Session Budget
      visit.takeBatch();
      visit.settle(sendBlock(visit, otherReasoningFixture('Failed request')).batch, null);
      assert.equal(visit.progress().reason, [
        'Translation failed (1 block): The model did not return the target language, so the original was kept.',
        'Partial translation (2 blocks): Some source-language prose remained after one repair attempt.',
        'Translation failed (1 block): Protected page structure could not be preserved, so the original was kept.',
        'Translation failed (1 block): The model response was malformed or incomplete.',
        'Translation failed (1 block): The page rejected the translated update, so the original was kept.',
        'Translation failed (1 block): This page block has unsupported structure, so no request was sent.',
        'Translation failed (1 block): This page block exceeds the 12,000-character request limit, so no request was sent.',
        "Translation failed (1 block): The visible translation reached this page visit's limit, so no request was sent. Reload the page to continue.",
        'Changed (1 block): Page changed before translation could be applied.',
        'Translation failed (1 block): The translation request could not be completed.',
      ].join('\n'));
    },
  },

  {
    name: 'keeps the Session Budget across stop, Start and Original text',
    fn() {
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      spend(visit, 1200);
      visit.stop();
      visit.begin(KOREAN);
      spend(visit, 300);
      visit.restore();
      visit.begin(JAPANESE);
      assertRemainingBudget(visit, SESSION_BUDGET - 1500);

      const fresh = session.createInlineTranslationSession();
      fresh.begin(KOREAN);
      assertRemainingBudget(fresh, SESSION_BUDGET);
    },
  },
  {
    name: 'advances the operation id on begin, stop and restore',
    fn() {
      const visit = session.createInlineTranslationSession();
      assert.equal(visit.status, 'original');
      const initial = visit.operationId;

      const first = visit.begin(KOREAN);
      assert.equal(first > initial, true);
      assert.equal(visit.operationId, first);
      assert.equal(visit.status, 'active');

      const stopped = visit.stop();
      assert.equal(stopped > first, true);
      assert.equal(visit.operationId, stopped);
      assert.equal(visit.status, 'stopped');
      // A second Stop has no operation left to end.
      assert.equal(visit.stop(), stopped);

      const second = visit.begin(KOREAN);
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
        visit.admit(block);
        assert.equal(visit.takeBatch().length, 1, JSON.stringify(settings));
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
      const spent = session.getRecordCost(require('../extension/inline-block.js').serializeBlock(createReasoningFixture().block)) * 2;

      visit.begin(KOREAN);

      assert.equal(visit.admit(block), null);
      assert.deepEqual(visit.takeBatch(), []);
      assert.equal(block.textContent, TRANSLATED_TEXT);
      assert.deepEqual(visit.progress(), { counts: { ...NOTHING, translated: 1 }, reason: '' });
      assertRemainingBudget(visit, SESSION_BUDGET - spent);
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
      const { counts, reason } = visit.progress();
      assert.deepEqual(counts, { ...NOTHING, failed: 1 });
      assert.match(reason, /exceeds the 12,000-character request limit, so no request was sent/);
      assert.deepEqual(
        visit.outbox.map(({ code, evidence }) => ({ code, limit: evidence.limit })),
        [{ code: 'runtime.block_too_large', limit: 12000 }]
      );
      assert.equal(visit.outbox[0].evidence.recordCost > 12000, true);
      assertRemainingBudget(visit, SESSION_BUDGET);
    },
  },
  {
    name: 'refuses a block it cannot serialize without sending it',
    fn() {
      const { document, element, text } = createTestDocument();
      const block = element('li', text('Outer item text.'), element('p', text('Nested paragraph.')),
        text(' Outer item continues.'));
      document.body.appendChild(block);
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);

      visit.admit(block);

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
        const recordCost = session.getRecordCost(batch[0]);
        assert.equal(recordCost > 0, true);

        visit.settle(batch, answer(batch, { attemptCount }));

        assertRemainingBudget(visit, SESSION_BUDGET - recordCost * attemptCount);
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
      const recordCost = session.getRecordCost(batch[0]);
      end(visit);
      const progress = visit.progress();

      const settled = visit.settle(
        batch,
        answer(batch, { attemptCount: 2, correlationToken: 'late-token' })
      );

      // The repair was sent whatever the reader did since, so the page visit pays for it.
      assert.deepEqual(settled, {
        runtimeOutcomes: [],
        releaseTokens: ['late-token'],
        diagnosticsUnavailable: false,
      });
      assert.equal(block.textContent, ORIGINAL_TEXT);
      assert.deepEqual(visit.progress(), progress);
      assert.deepEqual(visit.takeBatch(), []);
      assertRemainingBudget(visit, SESSION_BUDGET - recordCost * 2);
    },
  })),
  {
    name: 'fails a batch whose request came back with nothing, without refunding it',
    fn() {
      for (const response of [null, { ok: false, results: [] }, { ok: true }]) {
        const visit = session.createInlineTranslationSession();
        visit.begin(KOREAN);
        const { block, batch } = sendBlock(visit);
        const spent = session.getRecordCost(batch[0]);

        const settled = visit.settle(batch, response);

        assert.deepEqual(settled, {
          runtimeOutcomes: [],
          releaseTokens: [],
          diagnosticsUnavailable: false,
        });
        assert.equal(block.textContent, ORIGINAL_TEXT);
        assert.deepEqual(visit.progress(), {
          counts: { ...NOTHING, failed: 1 },
          reason: 'Translation failed (1 block): The translation request could not be completed.',
        });
        assertRemainingBudget(visit, SESSION_BUDGET - spent);
      }
    },
  },
  {
    name: 'fails a batch whose answer the page could not settle, rather than leaving it pending',
    fn() {
      const codec = require('../extension/inline-block.js');
      const previousApplyTranslatedTemplate = codec.applyTranslatedTemplate;
      const visit = session.createInlineTranslationSession();
      visit.begin(KOREAN);
      const { batch } = sendBlock(visit);
      codec.applyTranslatedTemplate = () => {
        throw new Error('synthetic codec failure');
      };
      try {
        assert.deepEqual(visit.settle(batch, answer(batch, { correlationToken: 'token' })), {
          runtimeOutcomes: [],
          releaseTokens: [],
          diagnosticsUnavailable: false,
        });
      } finally {
        codec.applyTranslatedTemplate = previousApplyTranslatedTemplate;
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
