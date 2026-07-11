const assert = require('node:assert/strict');
const { decideBlockDisposition } = require('../extension/translation-policy.js');

exports.name = 'translation policy';
exports.tests = [
  {
    name: 'implements the exhaustive two-attempt disposition table',
    fn() {
      const cases = [
        [1, 'safe', 'complete', 'apply', null],
        [1, 'safe', 'partial', 'retry', 'quality'],
        [1, 'safe', 'uncertain', 'retry', 'quality'],
        [1, 'unsafe', 'complete', 'retry', 'structure'],
        [2, 'safe', 'complete', 'apply', null],
        [2, 'safe', 'partial', 'apply_with_warning', null],
        [2, 'safe', 'uncertain', 'apply_with_warning', null],
        [2, 'unsafe', 'complete', 'reject', null],
      ];
      for (const [attempt, structure, quality, disposition, repairKind] of cases) {
        const result = decideBlockDisposition({
          structure: { status: structure, codes: structure === 'unsafe' ? ['structure.token_missing'] : [] },
          quality: { status: quality, codes: quality === 'complete' ? [] : ['quality.english_residue'] },
        }, attempt);
        assert.equal(result.disposition, disposition);
        assert.equal(result.repairKind, repairKind);
      }
    },
  },
  {
    name: 'never applies structurally unsafe output',
    fn() {
      for (const attempt of [1, 2]) {
        const result = decideBlockDisposition({
          structure: { status: 'unsafe', codes: ['structure.token_missing'] },
          quality: { status: 'complete', codes: [] },
        }, attempt);
        assert.equal(result.disposition === 'apply' || result.disposition === 'apply_with_warning', false);
      }
    },
  },
];
