const assert = require('node:assert/strict');
const { decideBlockDisposition } = require('../extension/translation-policy.js');

exports.name = 'translation policy';
exports.tests = [
  {
    name: 'implements the exhaustive two-attempt disposition table',
    fn() {
      // Every combination, which is what pins README's "structurally unsafe output is
      // never applied": unsafe decides on its own and never reaches the quality branch,
      // so the unsafe rows have to span all three qualities. Listing only the complete
      // one leaves a policy that applies unsafe output at partial quality — a change the
      // rest of this suite cannot see.
      const cases = [
        [1, 'safe', 'complete', 'apply', null],
        [1, 'safe', 'partial', 'retry', 'quality'],
        [1, 'safe', 'uncertain', 'retry', 'quality'],
        [1, 'unsafe', 'complete', 'retry', 'structure'],
        [1, 'unsafe', 'partial', 'retry', 'structure'],
        [1, 'unsafe', 'uncertain', 'retry', 'structure'],
        [2, 'safe', 'complete', 'apply', null],
        [2, 'safe', 'partial', 'apply_with_warning', null],
        [2, 'safe', 'uncertain', 'apply_with_warning', null],
        [2, 'unsafe', 'complete', 'reject', null],
        [2, 'unsafe', 'partial', 'reject', null],
        [2, 'unsafe', 'uncertain', 'reject', null],
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
    name: 'rejects a repaired translation that still misses the target language',
    fn() {
      const stillWrongLanguage = {
        structure: { status: 'safe', codes: [] },
        quality: {
          status: 'partial',
          codes: ['quality.target_language_missing'],
        },
      };
      assert.equal(
        decideBlockDisposition(stillWrongLanguage, 1).disposition,
        'retry'
      );
      assert.deepEqual(
        decideBlockDisposition(stillWrongLanguage, 2),
        {
          disposition: 'reject',
          repairKind: null,
          terminalCode: 'quality.target_language_missing',
          messageKey: 'wrong_target_language_rejected',
        }
      );
    },
  },
];
