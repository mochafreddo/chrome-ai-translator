'use strict';

// Regression: ISSUE-003 — token-valid semantic block output remained untranslated
// Found by /qa on 2026-07-10
// Report: .gstack/qa-reports/qa-report-developers-openai-com-2026-07-10.md

const assert = require('node:assert/strict');
const background = require('../extension/background.js');
const content = require('../extension/content.js');
const validation = require('../extension/translation-validation.js');
const policy = require('../extension/translation-policy.js');
const { createReasoningFixture } = require('./inline-block.test.js');

function createCompletedResponse(outputText) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: outputText }],
    }],
  };
}

function createReasoningRecord(id = 'reasoning') {
  const { serialized } = createReasoningFixture();
  return {
    id,
    template: serialized.template,
    atoms: serialized.atoms,
    contract: serialized.contract,
    repair: null,
  };
}

function createPlainRecord(template, id) {
  return {
    id,
    template,
    atoms: [],
    contract: {
      codecVersion: 1,
      namespace: `CAT_${id}`,
      entries: [],
      literalTokens: [],
      maxOutputChars: 2000,
      requiresText: true,
    },
    repair: null,
  };
}

// The verdict Inline Translation actually reaches for one template: what
// `validateBlockResponse` says about it, and what the block disposition policy then
// does with that on each of the two attempts a block gets. Both halves matter — a
// quality code on its own says nothing about whether the reader sees the answer.
//
// The live loop judges attempt 2 against the *repaired* answer, so asking both
// attempts about one template models a repair that came back no better than the
// original. That is the ISSUE-003 case exactly — the block whose English survived a
// second ask — and it is the only reading under which a fixed template has two
// attempts to describe.
function judgeTemplate(record, template, targetLanguage = 'Korean') {
  const { records } = validation.validateBlockResponse(
    JSON.stringify({
      translations: [{ id: record.id, template }],
    }),
    [record],
    { targetLanguage }
  );
  const [result] = records;
  assert.equal(result.id, record.id);
  assert.equal(result.template, template);
  return {
    structure: result.structure.status,
    quality: result.quality.status,
    qualityCode: result.quality.codes[0] || null,
    firstAttempt: policy.decideBlockDisposition(result, 1).disposition,
    secondAttempt: policy.decideBlockDisposition(result, 2).disposition,
  };
}

// What a refused answer costs the reader, per quality code: output that never arrived
// in the target language is dropped, and residue a reader can read past is applied
// with a warning. This is `decideBlockDisposition`'s own second-attempt rule, held as
// a table rather than restated as a branch so that a call site names only its code.
//
// The duplication is deliberate and the ticket asked for it: these checks are supposed
// to fail when the disposition a Semantic Block reaches changes, which is exactly what
// they could not do while they drove a path nothing calls. The policy's full table is
// pinned separately by `tests/translation-policy.test.js`.
const SECOND_ATTEMPT_BY_QUALITY_CODE = Object.freeze({
  'quality.target_language_missing': 'reject',
  'quality.english_residue': 'apply_with_warning',
});

// A refused answer: judged partial, with the first attempt buying a repair and the
// second reaching whatever the code above earns.
function assertRefused(record, template, qualityCode, targetLanguage = 'Korean') {
  assert.ok(
    Object.hasOwn(SECOND_ATTEMPT_BY_QUALITY_CODE, qualityCode),
    `no second-attempt disposition recorded for ${qualityCode}`
  );
  assert.deepEqual(judgeTemplate(record, template, targetLanguage), {
    structure: 'safe',
    quality: 'partial',
    qualityCode,
    firstAttempt: 'retry',
    secondAttempt: SECOND_ATTEMPT_BY_QUALITY_CODE[qualityCode],
  });
}

function assertApplied(record, template, targetLanguage = 'Korean') {
  assert.deepEqual(judgeTemplate(record, template, targetLanguage), {
    structure: 'safe',
    quality: 'complete',
    qualityCode: null,
    firstAttempt: 'apply',
    secondAttempt: 'apply',
  });
}

// The two below are the same assertions under names that say the retired guard judged
// this input the other way. That guard was `parseAndValidateBlockTranslations`, deleted
// from the worker on issue #38, so read it out of git rather than looking for it in the
// tree. Every one of these is a coverage gap recorded on issue #37, not a rule this repo
// wants: closing a gap turns its check red, which is how the gap gets noticed again.
//
// `assertUnguarded` is ISSUE-003 itself, still live — the live path applies English
// the retired guard refused. `assertOverguarded` is the inverse: the live path
// complains about output the retired guard was happy with.
// Both forward their arguments rather than restate a signature, so neither can drift
// out of step with the assertion it names.
function assertUnguarded(...args) {
  assertApplied(...args);
}

function assertOverguarded(...args) {
  assertRefused(...args);
}

exports.name = 'qa ISSUE-003 regression';
exports.tests = [
  {
    name: 'refuses unchanged and partially copied English outside protected atoms',
    fn() {
      const record = createReasoningRecord();
      assertRefused(record, record.template, 'quality.target_language_missing');

      const wrapper = record.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = record.contract.entries.find((entry) => entry.kind === 'atom');
      const partialTemplate = `${wrapper.openToken}Reasoning models!${wrapper.closeToken}와 ${atom.token}은 내부 추론 토큰을 사용합니다.`;
      assertRefused(record, partialTemplate, 'quality.english_residue');

      const translatedTemplate = `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
      assertApplied(record, translatedTemplate);

      for (const [id, source, output, qualityCode] of [
        [
          'punctuation',
          'This is source prose.',
          'This is source prose!',
          'quality.target_language_missing',
        ],
        [
          'appended-target',
          'This is source prose.',
          'This is source prose. 나머지는 번역했습니다.',
          'quality.english_residue',
        ],
        [
          'title-two',
          'Powerful Models',
          'Powerful Models',
          'quality.target_language_missing',
        ],
        [
          'title-three',
          'Powerful Language Models',
          'Powerful Language Models',
          'quality.target_language_missing',
        ],
        [
          'long-two',
          'This is a longer source sentence.',
          '번역문 This is',
          'quality.english_residue',
        ],
        [
          'long-three',
          'This is a longer source sentence.',
          '번역문 This is a',
          'quality.english_residue',
        ],
        [
          'technical-prefix',
          'AI Model Performance',
          'AI Model Performance',
          'quality.target_language_missing',
        ],
        [
          'technical-prefix-api',
          'HTTP API Reference Guide',
          'HTTP API Reference Guide',
          'quality.target_language_missing',
        ],
      ]) {
        assertRefused(createPlainRecord(source, id), output, qualityCode);
      }

      // Gap: an all-caps heading comes back untranslated and the live path applies it.
      // `sourceProseWordCount` drops every all-caps word before the target-language
      // check, and `sharedEnglishEvidence` needs three words, a function word, or a
      // lowercase continuation before it will call two words prose — a two-word caps
      // heading has none. `Powerful Models` above is the same heading in title case
      // and is refused, so the hole is the casing rather than the length.
      assertUnguarded(
        createPlainRecord('POWERFUL MODELS', 'all-caps'),
        'POWERFUL MODELS'
      );
    },
  },
  {
    name: 'applies all-caps technical names and refuses every other protected name',
    fn() {
      // Gap: the retired path protected technical product names; the live path has no
      // notion of them. Only names whose every word is all-caps survive, because that
      // is the one filter `assessTranslationQuality` applies before deciding no
      // Hangul arrived. The rest are refused outright on the second attempt — a
      // proper name with nothing to translate is treated as a wrong-language answer.
      // The two paths agree here, but not for the same reason: this one survives
      // through the all-caps hole above rather than through any exemption of its own.
      assertApplied(createPlainRecord('API SDK', 'api-sdk'), 'API SDK');

      for (const [id, technicalName] of [
        ['product', 'OpenAI Platform'],
        ['long-sdk', 'Model Context Protocol SDK'],
        ['parenthetical-sdk', 'Model Context Protocol (MCP) SDK'],
        ['parenthetical-api', 'OpenAI Chat Completions (API)'],
      ]) {
        const record = createPlainRecord(technicalName, id);
        assertOverguarded(
          record,
          technicalName,
          'quality.target_language_missing'
        );
      }

      // Gap: a correct Korean translation that keeps a product name verbatim reads as
      // English residue, because the name is a shared three-word sequence and nothing
      // exempts it. That costs a repair round trip and then applies with a warning.
      const technicalSentence = createPlainRecord(
        'Model Context Protocol (SDK) Improves Performance',
        'technical-sentence'
      );
      assertOverguarded(
        technicalSentence,
        'Model Context Protocol (SDK)는 성능을 개선합니다.',
        'quality.english_residue'
      );
      assertRefused(
        technicalSentence,
        technicalSentence.template,
        'quality.target_language_missing'
      );

      const productSentence = createPlainRecord(
        'Use the OpenAI Chat Completions API.',
        'product-sentence'
      );
      assertOverguarded(
        productSentence,
        'OpenAI Chat Completions API를 사용하세요.',
        'quality.english_residue'
      );

      // Gap: `removeContractTokens` strips the contract's own entry tokens and never
      // `contract.literalTokens`, so a token the source owns stays in both halves and
      // its four words count as a shared English sequence. The retired path was
      // handed the literal tokens and dropped them.
      const literalRecord = createPlainRecord(
        'Use literal ⟦FORGED:OPEN:WRAPPER:TOKEN⟧ here.',
        'literal-token'
      );
      literalRecord.contract.literalTokens = [
        { value: '⟦FORGED:OPEN:WRAPPER:TOKEN⟧', count: 1 },
      ];
      assertOverguarded(
        literalRecord,
        '리터럴 ⟦FORGED:OPEN:WRAPPER:TOKEN⟧을 사용하세요.',
        'quality.english_residue'
      );
    },
  },
  {
    name: 'recognizes only the bare English target name and scopes Korean-only instructions',
    fn() {
      const record = createReasoningRecord();
      assertApplied(record, record.template, 'English');

      // Gap: the live path decides a target is English with a bare `/^en(glish)?\b/`,
      // so every other name for the same language falls through to the residue check
      // and an untouched English answer is refused for staying English. The retired
      // path routed the same names through `getTargetLanguageCode`, which knows all
      // five. Nothing here reopens ISSUE-003 — it is the opposite mistake — but
      // choosing any of these targets buys a repair the reader did not need.
      for (const targetLanguage of [
        'British English',
        '영어',
        '미국 영어',
        '영국식 영어',
      ]) {
        assertOverguarded(
          record,
          record.template,
          'quality.english_residue',
          targetLanguage
        );
      }

      assertRefused(
        record,
        record.template,
        'quality.target_language_missing',
        'Korean with English technical terms'
      );

      const koreanInstructions = background.buildBlockInstructions({
        targetLanguage: '한국말',
        tone: 'natural',
      });
      assert.match(koreanInstructions, /wrapper tokens preserve formatting/i);
      assert.match(koreanInstructions, /source word order is not a constraint/i);
      assert.match(koreanInstructions, /empty example parenthesis/i);
      assert.match(
        koreanInstructions,
        /do not guess a particle after an opaque technical/i
      );
      assert.doesNotMatch(
        background.buildBlockInstructions({
          targetLanguage: 'Japanese',
          tone: 'natural',
        }),
        /For Korean/i
      );
    },
  },
  {
    name: 'uses merged settings when production completeness validation is enabled',
    async fn() {
      const record = createReasoningRecord();
      // The batch is handed a worker rather than left to find one: `storage.local` for the
      // settings the snapshot is merged into and the diagnostics run it writes, and the
      // network for the two requests a repair makes. Correlations stay in this worker's own
      // state, which is what leaves the token below on every result.
      const worker = background.createBackgroundWorker({
        chrome: {
          storage: {
            local: {
              async get() {
                return {
                  settings: {
                    apiKey: 'test-key',
                    model: 'gpt-5.4-mini',
                    reasoningEffort: 'none',
                    targetLanguage: 'Korean',
                    tone: 'natural',
                  },
                };
              },
              async set() {},
            },
          },
        },
        // The correlation token asserted below is minted from this, and so is the
        // fingerprint on the run behind it.
        crypto: globalThis.crypto,
        fetch: async () => ({
          ok: true,
          async json() {
            return createCompletedResponse(JSON.stringify({
              translations: [{ id: record.id, template: record.template }],
            }));
          },
        }),
      });

      for (const settingsSnapshot of [null, { tone: 'formal' }]) {
        const results = await worker.translateVisibleBlockBatch(
          [record],
          settingsSnapshot,
          { validateTranslationCompleteness: true }
        );
        assert.equal(results.length, 1);
        assert.equal(results[0].id, record.id);
        assert.equal(results[0].disposition, 'reject');
        assert.equal(
          results[0].terminalCode,
          'quality.target_language_missing'
        );
        assert.equal(results[0].messageKey, 'wrong_target_language_rejected');
        assert.equal(results[0].attemptCount, 2);
        assert.match(
          results[0].correlationToken,
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        );
        assert.equal(Object.hasOwn(results[0], 'template'), false);
      }
    },
  },
  {
    name: 'does not requeue a terminal repaired wrong-language rejection',
    fn() {
      const { block } = createReasoningFixture();
      const store = content.createInlineViewportStore(303);
      content.queueInlineViewportBlock(store, block);

      const firstBatch = content.takeInlineViewportBlockBatch(store);
      // The rejection handed to the content script is the one the live path really
      // produces for this block, rather than a hand-written stand-in: the English
      // template comes back unchanged twice, so validation calls it partial and the
      // policy's second attempt refuses it. Deriving it is what couples the two halves
      // — the code validation emits has to be the code the content side treats as
      // terminal, and a break in either end shows up here.
      const [validated] = validation.validateBlockResponse(
        JSON.stringify({
          translations: [
            { id: firstBatch[0].id, template: firstBatch[0].template },
          ],
        }),
        [firstBatch[0]],
        { targetLanguage: 'Korean' }
      ).records;
      const repairedDecision = policy.decideBlockDisposition(validated, 2);
      assert.equal(repairedDecision.disposition, 'reject');
      assert.equal(
        repairedDecision.terminalCode,
        'quality.target_language_missing'
      );

      const firstSummary = content.applyInlineViewportBlockResults(
        firstBatch,
        [
          {
            id: firstBatch[0].id,
            disposition: repairedDecision.disposition,
            terminalCode: repairedDecision.terminalCode,
            attemptCount: 2,
          },
        ],
        303,
        store
      );
      assert.equal(firstSummary.retried, 0);
      assert.equal(firstSummary.failed, 1);
      assert.equal(store.queue.length, 0);
      assert.equal(firstBatch[0].state, 'failed');
      assert.equal(
        firstBatch[0].terminalCode,
        'quality.target_language_missing'
      );
      assert.equal(firstBatch[0].attemptCount, 2);
    },
  },
];
