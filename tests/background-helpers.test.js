const assert = require('node:assert/strict');
const helpers = require('../extension/background.js');

exports.name = 'background helpers';
exports.tests = [
  {
    name: 'defaults to GPT-5.4 mini with no reasoning effort',
    fn() {
      const settings = helpers.mergeSettingsWithExisting({}, {});

      assert.equal(settings.model, 'gpt-5.4-mini');
      assert.equal(settings.reasoningEffort, 'none');
    },
  },
  {
    name: 'clamps unsafe chunk sizes from saved settings',
    fn() {
      assert.equal(
        helpers.mergeSettingsWithExisting({}, { chunkMaxChars: -1 }).chunkMaxChars,
        2000
      );
      assert.equal(
        helpers.mergeSettingsWithExisting({}, { chunkMaxChars: Infinity })
          .chunkMaxChars,
        12000
      );
      assert.equal(
        helpers.mergeSettingsWithExisting({}, { chunkMaxChars: 900000 })
          .chunkMaxChars,
        60000
      );
    },
  },
  {
    name: 'rejects full-page translations over the total character budget',
    fn() {
      assert.throws(
        () => helpers.assertFullPageTranslationBudget('x'.repeat(60001)),
        /Full-page translation has too much text/
      );
      assert.doesNotThrow(() =>
        helpers.assertFullPageTranslationBudget('x'.repeat(60000))
      );
    },
  },
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
    name: 'sends reasoning none in Responses API requests',
    async fn() {
      const previousFetch = global.fetch;
      let requestBody = null;

      global.fetch = async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { output_text: '번역 결과' };
          },
        };
      };

      try {
        const output = await helpers.openaiTranslateChunk({
          apiKey: 'sk-test',
          model: 'gpt-5.4-mini',
          instructions: 'Translate.',
          input: 'Hello.',
        });

        assert.equal(output, '번역 결과');
        assert.deepEqual(requestBody.reasoning, { effort: 'none' });
      } finally {
        global.fetch = previousFetch;
      }
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
    name: 'serializes concurrent inline auto-show content script registration',
    async fn() {
      const previousChrome = global.chrome;
      const registered = new Map();

      global.chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async unregisterContentScripts({ ids }) {
            for (const id of ids || []) {
              registered.delete(id);
            }
          },
          async registerContentScripts(scripts) {
            await Promise.resolve();
            for (const script of scripts || []) {
              if (registered.has(script.id)) {
                throw new Error(`Duplicate script ID '${script.id}'`);
              }
            }
            for (const script of scripts || []) {
              registered.set(script.id, { ...script });
            }
          },
        },
      };

      try {
        await Promise.all([
          helpers.syncInlineAutoShowRegistration({ inlineAutoShow: true }),
          helpers.syncInlineAutoShowRegistration({ inlineAutoShow: true }),
        ]);

        assert.equal(registered.size, 1);
        assert.deepEqual(
          registered.get('inline-translator-auto-show')?.matches,
          ['http://*/*', 'https://*/*']
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'updates existing inline auto-show content script after duplicate registration',
    async fn() {
      const previousChrome = global.chrome;
      const registered = new Map([
        [
          'inline-translator-auto-show',
          {
            id: 'inline-translator-auto-show',
            matches: ['https://old.example/*'],
            js: ['old-content.js'],
            runAt: 'document_start',
          },
        ],
      ]);

      global.chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async unregisterContentScripts() {
            throw new Error('temporary unregister failure');
          },
          async registerContentScripts(scripts) {
            for (const script of scripts || []) {
              if (registered.has(script.id)) {
                throw new Error(`Duplicate script ID '${script.id}'`);
              }
            }
          },
          async updateContentScripts(scripts) {
            for (const script of scripts || []) {
              registered.set(script.id, {
                ...(registered.get(script.id) || {}),
                ...script,
              });
            }
          },
        },
      };

      try {
        await helpers.syncInlineAutoShowRegistration({ inlineAutoShow: true });

        assert.deepEqual(
          registered.get('inline-translator-auto-show'),
          {
            id: 'inline-translator-auto-show',
            matches: ['http://*/*', 'https://*/*'],
            js: ['content.js'],
            runAt: 'document_idle',
          }
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'updates registered inline auto-show content script without duplicate registration',
    async fn() {
      const previousChrome = global.chrome;
      const registered = new Map([
        [
          'inline-translator-auto-show',
          {
            id: 'inline-translator-auto-show',
            matches: ['https://old.example/*'],
            js: ['old-content.js'],
            runAt: 'document_start',
          },
        ],
      ]);

      global.chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts({ ids }) {
            return (ids || [])
              .map((id) => registered.get(id))
              .filter(Boolean);
          },
          async unregisterContentScripts({ ids }) {
            for (const id of ids || []) {
              registered.delete(id);
            }
          },
          async registerContentScripts() {
            throw new Error('register should not be called for existing script');
          },
          async updateContentScripts(scripts) {
            for (const script of scripts || []) {
              registered.set(script.id, {
                ...(registered.get(script.id) || {}),
                ...script,
              });
            }
          },
        },
      };

      try {
        await helpers.syncInlineAutoShowRegistration({ inlineAutoShow: true });

        assert.deepEqual(
          registered.get('inline-translator-auto-show'),
          {
            id: 'inline-translator-auto-show',
            matches: ['http://*/*', 'https://*/*'],
            js: ['content.js'],
            runAt: 'document_idle',
          }
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'does not throw when inline auto-show duplicate recovery fails',
    async fn() {
      const previousChrome = global.chrome;

      global.chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts() {
            throw new Error('temporary lookup failure');
          },
          async unregisterContentScripts() {
            throw new Error('temporary unregister failure');
          },
          async registerContentScripts() {
            throw new Error("Duplicate script ID 'inline-translator-auto-show'");
          },
          async updateContentScripts() {
            throw new Error("Duplicate script ID 'inline-translator-auto-show'");
          },
        },
      };

      try {
        await helpers.syncInlineAutoShowRegistration({ inlineAutoShow: true });
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'safely ignores inline auto-show registration failures from runtime events',
    async fn() {
      const previousChrome = global.chrome;

      global.chrome = {
        permissions: {
          async contains() {
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts() {
            return [];
          },
          async registerContentScripts() {
            throw new Error('Unexpected scripting API failure');
          },
        },
      };

      try {
        assert.equal(
          await helpers.syncInlineAutoShowRegistrationSafely({
            inlineAutoShow: true,
          }),
          false
        );
      } finally {
        global.chrome = previousChrome;
      }
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
    name: 'redacts secret-shaped values from inline translation log errors',
    fn() {
      const sanitized = helpers.sanitizeLogError(
        new Error(
          [
            'OpenAI rejected sk-live123',
            'sk-proj-service_secret123',
            'sk-svcacct-team_secret456',
            'with Bearer live.token_123; retry later',
          ].join(' ')
        )
      );

      assert.equal(sanitized.includes('sk-live123'), false);
      assert.equal(sanitized.includes('sk-proj-service_secret123'), false);
      assert.equal(sanitized.includes('sk-svcacct-team_secret456'), false);
      assert.equal(sanitized.includes('Bearer live.token_123'), false);
      assert.equal(sanitized.includes('OpenAI rejected'), true);
      assert.equal(sanitized.includes('retry later'), true);
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
  {
    name: 'accepts visible inline batch records at the character budget',
    fn() {
      assert.deepEqual(
        helpers.normalizeVisibleTextBatchRecords([
          { id: 'v1', text: 'x'.repeat(2000) },
        ]),
        [{ id: 'v1', text: 'x'.repeat(2000) }]
      );
    },
  },
  {
    name: 'rejects visible inline batch records over the character budget',
    fn() {
      assert.throws(
        () =>
          helpers.normalizeVisibleTextBatchRecords([
            { id: 'v1', text: 'x'.repeat(2001) },
          ]),
        /Visible inline translation batch is too large/
      );
    },
  },
];
