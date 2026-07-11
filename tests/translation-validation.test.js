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
        { targetLanguage: 'Korean' }
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
];
