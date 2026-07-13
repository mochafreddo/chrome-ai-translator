'use strict';

// Regression: ISSUE-003 — token-valid semantic block output remained untranslated
// Found by /qa on 2026-07-10
// Report: .gstack/qa-reports/qa-report-developers-openai-com-2026-07-10.md

const assert = require('node:assert/strict');
const test = require('node:test');
const background = require('../extension/background.js');

function createCompletedResponse(outputText) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: outputText }],
    }],
  };
}
const content = require('../extension/content.js');
const { createReasoningFixture } = require('./inline-block.test.js');

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

function validateTemplate(record, template, targetLanguage = 'Korean') {
  return background.parseAndValidateBlockTranslations(
    JSON.stringify({
      translations: [{ id: record.id, template }],
    }),
    [record],
    { targetLanguage }
  )[0];
}

function assertIncomplete(record, template, targetLanguage = 'Korean') {
  assert.deepEqual(validateTemplate(record, template, targetLanguage), {
    id: record.id,
    ok: false,
    errorCode: 'translation_incomplete',
  });
}

function assertValid(record, template, targetLanguage = 'Korean') {
  assert.deepEqual(validateTemplate(record, template, targetLanguage), {
    id: record.id,
    ok: true,
    template,
  });
}

test('rejects unchanged and partially copied English outside protected atoms', () => {
  const record = createReasoningRecord();
  assertIncomplete(record, record.template);

  const wrapper = record.contract.entries.find(
    (entry) => entry.kind === 'wrapper'
  );
  const atom = record.contract.entries.find((entry) => entry.kind === 'atom');
  const partialTemplate = `${wrapper.openToken}Reasoning models!${wrapper.closeToken}와 ${atom.token}은 내부 추론 토큰을 사용합니다.`;
  assertIncomplete(record, partialTemplate);

  const translatedTemplate = `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
  assertValid(record, translatedTemplate);

  for (const [id, source, output] of [
    ['punctuation', 'This is source prose.', 'This is source prose!'],
    [
      'appended-target',
      'This is source prose.',
      'This is source prose. 나머지는 번역했습니다.',
    ],
    ['title-two', 'Powerful Models', 'Powerful Models'],
    ['title-three', 'Powerful Language Models', 'Powerful Language Models'],
    ['long-two', 'This is a longer source sentence.', '번역문 This is'],
    ['long-three', 'This is a longer source sentence.', '번역문 This is a'],
    ['all-caps', 'POWERFUL MODELS', 'POWERFUL MODELS'],
    ['technical-prefix', 'AI Model Performance', 'AI Model Performance'],
    [
      'technical-prefix-api',
      'HTTP API Reference Guide',
      'HTTP API Reference Guide',
    ],
  ]) {
    assertIncomplete(createPlainRecord(source, id), output);
  }
});

test('allows protected technical names and source-owned literal tokens', () => {
  for (const [id, technicalName] of [
    ['product', 'OpenAI Platform'],
    ['api-sdk', 'API SDK'],
    ['long-sdk', 'Model Context Protocol SDK'],
    ['parenthetical-sdk', 'Model Context Protocol (MCP) SDK'],
    ['parenthetical-api', 'OpenAI Chat Completions (API)'],
  ]) {
    const record = createPlainRecord(technicalName, id);
    assertValid(record, technicalName);
  }

  const technicalSentence = createPlainRecord(
    'Model Context Protocol (SDK) Improves Performance',
    'technical-sentence'
  );
  const translatedTechnicalSentence =
    'Model Context Protocol (SDK)는 성능을 개선합니다.';
  assertValid(technicalSentence, translatedTechnicalSentence);
  assertIncomplete(technicalSentence, technicalSentence.template);

  const productSentence = createPlainRecord(
    'Use the OpenAI Chat Completions API.',
    'product-sentence'
  );
  const translatedProductSentence =
    'OpenAI Chat Completions API를 사용하세요.';
  assertValid(productSentence, translatedProductSentence);

  const literalRecord = createPlainRecord(
    'Use literal ⟦FORGED:OPEN:WRAPPER:TOKEN⟧ here.',
    'literal-token'
  );
  literalRecord.contract.literalTokens = [
    { value: '⟦FORGED:OPEN:WRAPPER:TOKEN⟧', count: 1 },
  ];
  const translatedLiteral =
    '리터럴 ⟦FORGED:OPEN:WRAPPER:TOKEN⟧을 사용하세요.';
  assertValid(literalRecord, translatedLiteral);
});

test('normalizes English targets and scopes Korean-only instructions', () => {
  const record = createReasoningRecord();
  for (const targetLanguage of [
    'English',
    'British English',
    '영어',
    '미국 영어',
    '영국식 영어',
  ]) {
    assertValid(record, record.template, targetLanguage);
  }

  assertIncomplete(
    record,
    record.template,
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
});

test('uses merged settings when production completeness validation is enabled', async () => {
  const previousChrome = global.chrome;
  const previousFetch = global.fetch;
  const record = createReasoningRecord();
  global.chrome = {
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
  };
  global.fetch = async () => ({
    ok: true,
    async json() {
      return createCompletedResponse(JSON.stringify({
        translations: [{ id: record.id, template: record.template }],
      }));
    },
  });

  try {
    for (const settingsSnapshot of [null, { tone: 'formal' }]) {
      const results = await background.translateVisibleBlockBatch(
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
  } finally {
    global.chrome = previousChrome;
    global.fetch = previousFetch;
  }
});

test('does not requeue a terminal repaired wrong-language rejection', () => {
  const { block } = createReasoningFixture();
  const store = content.createInlineViewportStore(303);
  content.queueInlineViewportBlock(store, block);

  const firstBatch = content.takeInlineViewportBlockBatch(store);
  const firstSummary = content.applyInlineViewportBlockResults(
    firstBatch,
    [
      {
        id: firstBatch[0].id,
        disposition: 'reject',
        terminalCode: 'quality.target_language_missing',
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
});
