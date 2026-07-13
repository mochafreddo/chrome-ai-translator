const assert = require('node:assert/strict');
const validation = require('../extension/translation-validation.js');

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

exports.name = 'translation validation';
exports.tests = [
  {
    name: 'reports missing response ids with a stable protocol code',
    fn() {
      assert.throws(
        () => validation.validateBlockResponse(
          JSON.stringify({ translations: [] }),
          [plainRecord()],
          { targetLanguage: 'Korean' }
        ),
        (error) => error.code === 'protocol.missing_id'
      );
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
      const { serialized } = require('./inline-block.test').createReasoningFixture();
      const translated = serialized.template
        .replace('Reasoning models', '추론 모델')
        .replace(' like ', '와 같은 ')
        .replace(' use internal reasoning tokens.', '은 내부 추론 토큰을 사용합니다.');
      const result = validation.validateBlockResponse(
        JSON.stringify({ translations: [{ id: 'tokenized', template: translated }] }),
        [{ id: 'tokenized', ...serialized }],
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
