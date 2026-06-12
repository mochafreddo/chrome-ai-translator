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
    name: 'builds strict structured output format for text-node translations',
    fn() {
      const format = helpers.buildTextNodeResponseFormat();

      assert.equal(format.type, 'json_schema');
      assert.equal(format.name, 'inline_translations');
      assert.equal(format.strict, true);
      assert.deepEqual(format.schema.required, ['translations']);
      assert.equal(
        format.schema.properties.translations.items.additionalProperties,
        false
      );
      assert.deepEqual(
        format.schema.properties.translations.items.required,
        ['id', 'translation']
      );
    },
  },
  {
    name: 'summarizes text record chunks without retaining raw text',
    fn() {
      const records = [
        { id: 'n1', text: 'alpha' },
        { id: 'n2', text: 'beta gamma' },
      ];

      assert.deepEqual(helpers.getTextRecordStats(records), {
        recordCount: 2,
        totalChars: 15,
      });
      assert.deepEqual(helpers.getTextRecordChunkStats(records, 3), {
        index: 3,
        recordCount: 2,
        charCount: 15,
      });
      assert.equal(
        JSON.stringify(helpers.getTextRecordChunkStats(records, 3)).includes(
          'alpha'
        ),
        false
      );
    },
  },
  {
    name: 'caps inline translation chunk concurrency',
    fn() {
      assert.equal(helpers.getInlineTranslationConcurrency(1), 1);
      assert.equal(helpers.getInlineTranslationConcurrency(2), 2);
      assert.equal(helpers.getInlineTranslationConcurrency(9), 3);
    },
  },
  {
    name: 'collects inline logs from per-run storage keys',
    fn() {
      const logs = helpers.collectInlineTranslationLogsFromStorage({
        inlineTranslationLogs: [
          {
            id: 'legacy',
            startedAt: '2026-06-12T00:00:00.000Z',
            status: 'done',
          },
        ],
        'inlineTranslationLogs:current-a': {
          id: 'current-a',
          startedAt: '2026-06-12T00:02:00.000Z',
          status: 'done',
        },
        'inlineTranslationLogs:current-b': {
          id: 'current-b',
          startedAt: '2026-06-12T00:01:00.000Z',
          status: 'error',
        },
      });

      assert.deepEqual(
        logs.map((log) => log.id),
        ['current-a', 'current-b', 'legacy']
      );
      assert.equal(
        helpers.getInlineTranslationLogStorageKey('current-a'),
        'inlineTranslationLogs:current-a'
      );
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
  {
    name: 'uses a small visible inline batch character budget',
    fn() {
      assert.equal(helpers.getVisibleInlineBatchMaxChars(), 2000);
    },
  },
  {
    name: 'normalizes visible inline batch records with existing validation',
    fn() {
      assert.deepEqual(
        helpers.normalizeVisibleTextBatchRecords([
          { id: 'v1', text: 'Hello world.' },
        ]),
        [{ id: 'v1', text: 'Hello world.' }]
      );
      assert.throws(
        () =>
          helpers.normalizeVisibleTextBatchRecords([
            { id: '', text: 'Hello.' },
          ]),
        /Invalid inline translation record id/
      );
    },
  },
];
