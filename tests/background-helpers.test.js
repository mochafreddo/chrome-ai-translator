const assert = require('node:assert/strict');
const helpers = require('../extension/background.js');

exports.name = 'background helpers';
exports.tests = [
  {
    name: 'merges partial settings without dropping existing values',
    fn() {
      const next = helpers.mergeSettingsWithExisting(
        {
          apiKey: 'sk-existing',
          chunkMaxChars: 9000,
          inlineAutoShow: true,
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5-mini',
          viewMode: 'translation',
        },
        {
          targetLanguage: 'Japanese',
          tone: 'formal',
          model: 'gpt-5',
          viewMode: 'bilingual',
        }
      );

      assert.equal(next.apiKey, 'sk-existing');
      assert.equal(next.chunkMaxChars, 9000);
      assert.equal(next.inlineAutoShow, true);
      assert.equal(next.targetLanguage, 'Japanese');
      assert.equal(next.tone, 'formal');
      assert.equal(next.model, 'gpt-5');
      assert.equal(next.viewMode, 'bilingual');
    },
  },
  {
    name: 'splits text records without losing IDs',
    fn() {
      const chunks = helpers.splitTextRecordsIntoChunks(
        [
          { id: 'n1', text: 'alpha beta gamma' },
          { id: 'n2', text: 'delta epsilon zeta' },
          { id: 'n3', text: 'eta theta iota' },
        ],
        30
      );

      assert.deepEqual(
        chunks.flat().map((record) => record.id),
        ['n1', 'n2', 'n3']
      );
      assert.equal(chunks.length > 1, true);
    },
  },
  {
    name: 'validates exact JSON translation IDs',
    fn() {
      const records = [
        { id: 'n1', text: 'Hello world.' },
        { id: 'n2', text: 'Read the article.' },
      ];
      const parsed = helpers.parseAndValidateTextNodeTranslations(
        JSON.stringify({
          translations: [
            { id: 'n1', translation: 'Hello translated.' },
            { id: 'n2', translation: 'Read translated.' },
          ],
        }),
        records
      );

      assert.deepEqual(parsed, [
        { id: 'n1', translation: 'Hello translated.' },
        { id: 'n2', translation: 'Read translated.' },
      ]);
    },
  },
  {
    name: 'rejects unexpected JSON translation IDs',
    fn() {
      assert.throws(
        () =>
          helpers.parseAndValidateTextNodeTranslations(
            JSON.stringify({
              translations: [{ id: 'other', translation: 'Wrong.' }],
            }),
            [{ id: 'n1', text: 'Hello.' }]
          ),
        /Unexpected translation id/
      );
    },
  },
  {
    name: 'rejects too many text records before API calls',
    fn() {
      assert.throws(
        () =>
          helpers.assertTextRecordBudget(
            Array.from({ length: 501 }, (_, index) => ({
              id: `n${index + 1}`,
              text: 'Hello world.',
            }))
          ),
        /Too many text nodes/
      );
    },
  },
  {
    name: 'rejects too much text before API calls',
    fn() {
      assert.throws(
        () =>
          helpers.assertTextRecordBudget([
            { id: 'n1', text: 'x'.repeat(60001) },
          ]),
        /too much text/
      );
    },
  },
];
