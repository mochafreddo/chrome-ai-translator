'use strict';

// Regression: ISSUE-003 — token-valid semantic block output remained untranslated
// Found by /qa on 2026-07-10
// Report: .gstack/qa-reports/qa-report-developers-openai-com-2026-07-10.md

const assert = require('node:assert/strict');
const test = require('node:test');
const background = require('../extension/background.js');
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
  assert.deepEqual(validateTemplate(record, translatedTemplate), {
    id: record.id,
    ok: true,
    template: translatedTemplate,
  });

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
    assert.deepEqual(validateTemplate(record, technicalName), {
      id,
      ok: true,
      template: technicalName,
    });
  }

  const technicalSentence = createPlainRecord(
    'Model Context Protocol (SDK) Improves Performance',
    'technical-sentence'
  );
  const translatedTechnicalSentence =
    'Model Context Protocol (SDK)는 성능을 개선합니다.';
  assert.deepEqual(
    validateTemplate(technicalSentence, translatedTechnicalSentence),
    {
      id: technicalSentence.id,
      ok: true,
      template: translatedTechnicalSentence,
    }
  );
  assertIncomplete(technicalSentence, technicalSentence.template);

  const productSentence = createPlainRecord(
    'Use the OpenAI Chat Completions API.',
    'product-sentence'
  );
  const translatedProductSentence =
    'OpenAI Chat Completions API를 사용하세요.';
  assert.deepEqual(
    validateTemplate(productSentence, translatedProductSentence),
    {
      id: productSentence.id,
      ok: true,
      template: translatedProductSentence,
    }
  );

  const literalRecord = createPlainRecord(
    'Use literal ⟦FORGED:OPEN:WRAPPER:TOKEN⟧ here.',
    'literal-token'
  );
  literalRecord.contract.literalTokens = [
    { value: '⟦FORGED:OPEN:WRAPPER:TOKEN⟧', count: 1 },
  ];
  const translatedLiteral =
    '리터럴 ⟦FORGED:OPEN:WRAPPER:TOKEN⟧을 사용하세요.';
  assert.deepEqual(validateTemplate(literalRecord, translatedLiteral), {
    id: literalRecord.id,
    ok: true,
    template: translatedLiteral,
  });
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
    assert.deepEqual(validateTemplate(record, record.template, targetLanguage), {
      id: record.id,
      ok: true,
      template: record.template,
    });
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
      return {
        output_text: JSON.stringify({
          translations: [{ id: record.id, template: record.template }],
        }),
      };
    },
  });

  try {
    for (const settingsSnapshot of [null, { tone: 'formal' }]) {
      const results = await background.translateVisibleBlockBatch(
        [record],
        settingsSnapshot,
        { validateTranslationCompleteness: true }
      );
      assert.deepEqual(results, [
        {
          id: record.id,
          ok: false,
          errorCode: 'translation_incomplete',
        },
      ]);
    }
  } finally {
    global.chrome = previousChrome;
    global.fetch = previousFetch;
  }
});

test('queues one translation-incomplete repair and then terminates', () => {
  const { block } = createReasoningFixture();
  const store = content.createInlineViewportStore(303);
  content.queueInlineViewportBlock(store, block);

  const firstBatch = content.takeInlineViewportBlockBatch(store);
  const firstSummary = content.applyInlineViewportBlockResults(
    firstBatch,
    [
      {
        id: firstBatch[0].id,
        ok: false,
        errorCode: 'translation_incomplete',
      },
    ],
    303,
    store
  );
  assert.equal(firstSummary.retried, 1);
  assert.equal(store.queue[0].repair.previousErrorCode, 'translation_incomplete');

  const repairBatch = content.takeInlineViewportBlockBatch(store);
  const repairSummary = content.applyInlineViewportBlockResults(
    repairBatch,
    [
      {
        id: repairBatch[0].id,
        ok: false,
        errorCode: 'translation_incomplete',
      },
    ],
    303,
    store
  );
  assert.equal(repairSummary.retried, 0);
  assert.equal(repairSummary.failed, 1);
  assert.equal(store.queue.length, 0);
});
