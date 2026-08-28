const assert = require('node:assert/strict');
const validation = require('../extension/translation-validation.js');
const { createReasoningFixture } = require('./inline-block.test');

function plainRecord(id = 'b1', template = 'This is source prose.') {
  return {
    id,
    template,
    atoms: [],
    contract: {
      codecVersion: 1,
      namespace: 'CAT_PLAIN',
      entries: [],
      maxOutputChars: 2000,
      requiresText: true,
      literalTokens: [],
    },
  };
}

// A block whose contract has an atom token to lose, so a structure verdict can be told
// apart from a protocol one. The plain record above has no entries and therefore no way
// to fail structurally.
function reasoningRecord(id = 'reasoning') {
  const { serialized } = createReasoningFixture();
  return {
    id,
    template: serialized.template,
    atoms: serialized.atoms,
    contract: serialized.contract,
  };
}

function atomToken(record) {
  return record.contract.entries.find((entry) => entry.kind === 'atom').token;
}

exports.name = 'translation validation';
exports.tests = [
  {
    // Each protocol failure is a different shape of translations array, not a
    // paraphrase of the same one. The eight-block missing-id report is only
    // this first case: a parsed array that simply lacks a requested id.
    name: 'distinguishes an omitted response id from the other protocol failures',
    fn() {
      const record = plainRecord('b1');
      const sibling = plainRecord('b2');
      const cases = [
        ['not-json', '{', 'protocol.invalid_json'],
        [
          'missing translations key',
          JSON.stringify({ records: [] }),
          'protocol.missing_translations',
        ],
        [
          'empty translations',
          JSON.stringify({ translations: [] }),
          'protocol.missing_id',
        ],
        [
          'omitted id',
          JSON.stringify({
            translations: [{ id: 'b1', template: '번역문.' }],
          }),
          'protocol.missing_id',
        ],
        [
          'unexpected id',
          JSON.stringify({
            translations: [{ id: 'never-asked', template: '번역문.' }],
          }),
          'protocol.unexpected_id',
        ],
        [
          'duplicate id',
          JSON.stringify({
            translations: [
              { id: 'b1', template: '하나.' },
              { id: 'b1', template: '둘.' },
            ],
          }),
          'protocol.duplicate_id',
        ],
        [
          'missing template',
          JSON.stringify({ translations: [{ id: 'b1' }] }),
          'protocol.missing_template',
        ],
      ];
      for (const [label, output, code] of cases) {
        const records = label === 'omitted id' ? [record, sibling] : [record];
        assert.throws(
          () => validation.validateBlockResponse(output, records, {
            targetLanguage: 'Korean',
          }),
          (error) => error.code === code,
          label
        );
      }
    },
  },
  {
    // The batch is the unit of the request and the record is the unit of the verdict: one
    // block dropping a token has to fail on its own rather than take the batch with it,
    // which is only visible with a sibling that survives the same response.
    name: 'confines a lost token to the one record that dropped it',
    fn() {
      const first = reasoningRecord('b1');
      const second = reasoningRecord('b2');
      const result = validation.validateBlockResponse(
        JSON.stringify({
          translations: [
            { id: 'b1', template: first.template },
            {
              id: 'b2',
              template: second.template.split(atomToken(second)).join(''),
            },
          ],
        }),
        [first, second],
        { targetLanguage: 'Korean' }
      );

      assert.deepEqual(
        result.records.map((record) => [record.id, record.structure.status]),
        [
          ['b1', 'safe'],
          ['b2', 'unsafe'],
        ]
      );
      assert.deepEqual(result.records[1].structure.codes, [
        'structure.token_missing',
      ]);
      assert.equal(result.records[1].quality.status, 'uncertain');
    },
  },
  {
    name: 'separates safe structure from partial translation quality',
    fn() {
      const record = plainRecord();
      const result = validation.validateBlockResponse(
        JSON.stringify({
          translations: [{ id: record.id, template: 'This is source prose.' }],
        }),
        [record],
        { targetLanguage: 'Japanese' }
      );
      assert.equal(result.records[0].structure.status, 'safe');
      assert.equal(result.records[0].quality.status, 'partial');
      assert.deepEqual(result.records[0].quality.codes, [
        'quality.english_residue',
      ]);
      assert.equal(JSON.stringify(result.records[0].quality).includes(record.template), false);
    },
  },
  {
    name: 'does not mistake protected Claude documentation names for prose residue',
    fn() {
      const source = 'Claude Code reads CLAUDE.md, not AGENTS.md.';
      const record = plainRecord('claude-docs', source);
      const result = validation.validateBlockResponse(
        JSON.stringify({
          translations: [{
            id: record.id,
            template: 'Claude Code는 CLAUDE.md를 읽으며 AGENTS.md는 읽지 않습니다.',
          }],
        }),
        [record],
        { targetLanguage: 'Korean' }
      );
      assert.equal(result.records[0].quality.status, 'complete');
    },
  },
  {
    name: 'does not count protected token syntax as English residue',
    fn() {
      const record = reasoningRecord('tokenized');
      const translated = record.template
        .replace('Reasoning models', '추론 모델')
        .replace(' like ', '와 같은 ')
        .replace(' use internal reasoning tokens.', '은 내부 추론 토큰을 사용합니다.');
      const result = validation.validateBlockResponse(
        JSON.stringify({ translations: [{ id: record.id, template: translated }] }),
        [record],
        { targetLanguage: 'Korean' }
      );
      assert.equal(result.records[0].quality.status, 'complete');
    },
  },
  {
    name: 'retains page-owned bracket prose in quality assessment',
    fn() {
      const prose = '⟦Read the safety instructions carefully⟧';
      const result = validation.assessTranslationQuality(
        prose,
        prose,
        'Japanese'
      );
      assert.equal(result.status, 'partial');
      assert.deepEqual(result.codes, ['quality.english_residue']);
    },
  },
  {
    name: 'rejects clearly non-Korean output for a Korean target',
    fn() {
      for (const translated of [
        'Ceci est une phrase traduite.',
        'Completely different English prose.',
      ]) {
        const result = validation.assessTranslationQuality(
          'This is source prose.',
          translated,
          'Korean'
        );
        assert.equal(result.status, 'partial');
        assert.deepEqual(result.codes, ['quality.target_language_missing']);
        assert.equal(result.evidence.outputHangulCount, 0);
      }
    },
  },
  {
    name: 'accepts Korean evidence and avoids technical-only false positives',
    fn() {
      assert.equal(
        validation.assessTranslationQuality(
          'This is source prose.',
          '이것은 번역된 문장입니다.',
          'Korean'
        ).status,
        'complete'
      );
      assert.notEqual(
        validation.assessTranslationQuality('GPT API', 'GPT API', 'Korean')
          .codes[0],
        'quality.target_language_missing'
      );
    },
  },
];
