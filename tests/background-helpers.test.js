const assert = require('node:assert/strict');
const helpers = require('../extension/background.js');
const { createReasoningFixture } = require('./inline-block.test');

function createBlockApiRecord(id = 'b1') {
  const { serialized } = createReasoningFixture();
  return {
    id,
    template: serialized.template,
    atoms: serialized.atoms,
    contract: serialized.contract,
    repair: null,
  };
}

function createTestPlainBlockRecord(id = 'b1') {
  return {
    id,
    template: 'a',
    atoms: [],
    contract: {
      codecVersion: 1,
      namespace: 'CAT_PLAIN',
      entries: [],
      maxOutputChars: 2000,
      requiresText: true,
    },
    repair: null,
  };
}

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
    name: 'merges visible batch settings snapshot without accepting api key',
    fn() {
      const settings = helpers.mergeVisibleBatchSettingsSnapshot(
        {
          apiKey: 'sk-current',
          chunkMaxChars: 9000,
          inlineAutoShow: true,
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          viewMode: 'translation',
        },
        {
          apiKey: 'sk-from-content',
          chunkMaxChars: 24000,
          inlineAutoShow: false,
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          viewMode: 'bilingual',
        }
      );

      assert.equal(settings.apiKey, 'sk-current');
      assert.equal(settings.chunkMaxChars, 9000);
      assert.equal(settings.inlineAutoShow, true);
      assert.equal(settings.viewMode, 'translation');
      assert.equal(settings.targetLanguage, 'Japanese');
      assert.equal(settings.tone, 'natural');
      assert.equal(settings.model, 'gpt-5.4');
      assert.equal(settings.reasoningEffort, 'low');
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
        assert.equal(requestBody.max_output_tokens, 8192);
      } finally {
        global.fetch = previousFetch;
      }
    },
  },
  {
    name: 'allows a lower output token cap for small translation batches',
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
        await helpers.openaiTranslateChunk({
          apiKey: 'sk-test',
          model: 'gpt-5.4-mini',
          instructions: 'Translate.',
          input: 'Hello.',
          maxOutputTokens: 2048,
        });

        assert.equal(requestBody.max_output_tokens, 2048);
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
    name: 'builds the strict semantic block response format and instructions',
    fn() {
      const format = helpers.buildBlockResponseFormat();
      const instructions = helpers.buildBlockInstructions({
        targetLanguage: 'Korean',
        tone: 'technical',
      });

      assert.equal(format.type, 'json_schema');
      assert.equal(format.name, 'inline_block_translations');
      assert.equal(format.strict, true);
      assert.deepEqual(
        format.schema.properties.translations.items.required,
        ['id', 'template']
      );
      assert.match(instructions, /complete semantic block/i);
      assert.match(instructions, /token.*byte-for-byte/i);
      assert.match(instructions, /Do not output HTML/i);
      assert.match(instructions, /repair.*previousErrorCode/i);
    },
  },
  {
    name: 'normalizes block records without allowing DOM attributes',
    fn() {
      const record = createBlockApiRecord();
      const normalized = helpers.normalizeVisibleBlockBatchRecords([record]);

      assert.equal(normalized.length, 1);
      assert.equal(normalized[0].id, 'b1');
      assert.equal(normalized[0].template, record.template);
      assert.deepEqual(normalized[0].atoms, record.atoms);
      assert.deepEqual(normalized[0].contract, record.contract);
      assert.equal(normalized[0].repair, null);
      assert.equal(
        helpers.getBlockRecordCost(normalized[0]),
        record.template.length +
          JSON.stringify(record.atoms).length +
          JSON.stringify(null).length
      );

      assert.throws(
        () =>
          helpers.normalizeVisibleBlockBatchRecords([
            {
              ...record,
              atoms: [{ ...record.atoms[0], href: 'https://example.com' }],
            },
          ]),
        /Unexpected atom field/
      );
      assert.throws(
        () =>
          helpers.normalizeVisibleBlockBatchRecords([
            {
              ...record,
              repair: { attempt: 2, previousErrorCode: 'token_missing' },
            },
          ]),
        /repair attempt/
      );
    },
  },
  {
    name: 'enforces semantic block record and batch budgets',
    fn() {
      const record = createBlockApiRecord();
      const oversized = {
        ...record,
        template: `${'x'.repeat(12000)}${record.template}`,
        contract: { ...record.contract, maxOutputChars: 48000 },
      };

      assert.throws(
        () => helpers.normalizeVisibleBlockBatchRecords([oversized]),
        /block record is too large/i
      );
      assert.equal(helpers.getBlockBatchMaxOutputTokens(100), 4096);
      assert.equal(helpers.getBlockBatchMaxOutputTokens(12000), 15000);
      assert.equal(helpers.getBlockBatchMaxOutputTokens(20000), 16000);
      assert.doesNotThrow(() => helpers.assertInlineBlockSessionBudget(48000, 12000));
      assert.throws(
        () => helpers.assertInlineBlockSessionBudget(48001, 12000),
        /session.*too large/i
      );
      const plainFixture = createTestPlainBlockRecord();
      assert.throws(
        () =>
          helpers.normalizeVisibleBlockBatchRecords(
            Array.from({ length: 501 }, (_item, index) => ({
              ...plainFixture,
              id: `b${index + 1}`,
            }))
          ),
        /Too many semantic blocks/
      );
    },
  },
  {
    name: 'returns per-record token failures after exact block ID validation',
    fn() {
      const first = createBlockApiRecord('b1');
      const second = createBlockApiRecord('b2');
      const atom = second.contract.entries.find((entry) => entry.kind === 'atom');
      const parsed = helpers.parseAndValidateBlockTranslations(
        JSON.stringify({
          translations: [
            { id: 'b1', template: first.template },
            { id: 'b2', template: second.template.replace(atom.token, '') },
          ],
        }),
        [first, second]
      );

      assert.deepEqual(parsed, [
        { id: 'b1', ok: true, template: first.template },
        { id: 'b2', ok: false, errorCode: 'token_missing' },
      ]);
      assert.throws(
        () =>
          helpers.parseAndValidateBlockTranslations(
            JSON.stringify({
              translations: [{ id: 'other', template: first.template }],
            }),
            [first]
          ),
        /Unexpected translation id/
      );
    },
  },
  {
    name: 'sends semantic block payloads without token contracts or attributes',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const record = createBlockApiRecord();
      let requestBody = null;
      let requestCount = 0;
      global.chrome = {
        storage: {
          session: {
            async get() { return {}; },
            async set() { throw new Error('session unavailable'); },
          },
          local: {
            async get(key) {
              if (key === 'settings' || key?.includes?.('settings')) {
                return {
                  settings: {
                    apiKey: 'sk-test',
                    model: 'gpt-5.4-mini',
                    reasoningEffort: 'none',
                    targetLanguage: 'Korean',
                    tone: 'technical',
                  },
                };
              }
              return {};
            },
            async set() {},
          },
        },
      };
      global.fetch = async (_url, options) => {
        requestCount += 1;
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return {
              output_text: JSON.stringify({
                translations: [{ id: record.id, template: record.template }],
              }),
            };
          },
        };
      };

      try {
        const results = await helpers.translateVisibleBlockBatch([record]);
        const input = JSON.parse(requestBody.input);

        assert.equal(results[0].correlationToken, undefined);

        assert.deepEqual(results, [{
          id: record.id,
          disposition: 'apply_with_warning',
          template: record.template,
          terminalCode: 'quality.english_residue',
          messageKey: 'partial_translation_applied',
          attemptCount: 2,
          diagnosticsUnavailable: true,
        }]);
        assert.equal(requestCount, 2);
        assert.equal(input.records[0].contract, undefined);
        assert.equal(input.records[0].atoms[0].href, undefined);
        assert.equal(requestBody.text.format.name, 'inline_block_translations');
        assert.equal(
          requestBody.max_output_tokens,
          helpers.getBlockBatchMaxOutputTokens(
            helpers.getBlockRecordCost(record)
          )
        );
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
      }
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
    name: 'loads the semantic block codec before the content script',
    fn() {
      assert.deepEqual(helpers.getInlineContentScriptFiles(), [
        'inline-block.js',
        'content.js',
      ]);
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
            js: ['inline-block.js', 'content.js'],
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
            js: ['inline-block.js', 'content.js'],
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
    name: 'rejects inline translations that expand far beyond the original text',
    fn() {
      assert.throws(
        () =>
          helpers.parseAndValidateTextNodeTranslations(
            JSON.stringify({
              translations: [
                { id: 'n1', translation: 'x'.repeat(1001) },
              ],
            }),
            [{ id: 'n1', text: 'Hello.' }]
          ),
        /too long/
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
  {
    name: 'skips duplicate full-tab translations while one is running',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      let messageListener = null;
      let fetchCount = 0;

      global.fetch = async () => {
        fetchCount += 1;
        await Promise.resolve();
        return {
          ok: true,
          async json() {
            return { output_text: '번역 결과' };
          },
        };
      };

      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: {
            addListener(listener) {
              messageListener = listener;
            },
          },
          sendMessage() {
            return Promise.resolve();
          },
        },
        action: { onClicked: { addListener() {} } },
        commands: { onCommand: { addListener() {} } },
        sidePanel: {
          async setPanelBehavior() {},
          async setOptions() {},
          async open() {},
        },
        scripting: {
          async executeScript() {},
        },
        storage: {
          local: {
            async get() {
              return {
                settings: {
                  apiKey: 'sk-test',
                  model: 'ft:gpt_custom/model',
                  targetLanguage: 'Japanese',
                  tone: 'technical',
                  chunkMaxChars: 12000,
                },
              };
            },
            async set() {},
          },
        },
        tabs: {
          async sendMessage(_tabId, message) {
            if (message.type === 'EXTRACT_ARTICLE') {
              return {
                ok: true,
                data: {
                  title: 'Article',
                  url: 'https://example.test',
                  contentMarkdown: 'Hello world.',
                },
              };
            }
            return { ok: true };
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/background.js');
        assert.equal(typeof messageListener, 'function');

        const responses = [];
        messageListener(
          { type: 'TRANSLATE_TAB', tabId: 10 },
          {},
          (response) => responses.push(response)
        );
        messageListener(
          { type: 'TRANSLATE_TAB', tabId: 10 },
          {},
          (response) => responses.push(response)
        );

        for (let i = 0; i < 10 && responses.length < 2; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.equal(fetchCount, 1);
        assert.equal(responses.length, 2);
        assert.deepEqual(responses.find((response) => response.skipped), {
          ok: true,
          skipped: true,
          reason: 'already_running',
        });
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'uses a full-page output token cap scaled to the chunk size',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      let messageListener = null;
      const requestBodies = [];
      const markdown = 'A'.repeat(20000);

      global.fetch = async (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          async json() {
            return { output_text: '번역 결과' };
          },
        };
      };

      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: {
            addListener(listener) {
              messageListener = listener;
            },
          },
          sendMessage() {
            return Promise.resolve();
          },
        },
        action: { onClicked: { addListener() {} } },
        commands: { onCommand: { addListener() {} } },
        sidePanel: {
          async setPanelBehavior() {},
          async setOptions() {},
          async open() {},
        },
        scripting: {
          async executeScript() {},
        },
        storage: {
          local: {
            async get() {
              return {
                settings: {
                  apiKey: 'sk-test',
                  model: 'gpt-5.4-mini',
                  targetLanguage: 'Korean',
                  tone: 'technical',
                  chunkMaxChars: 60000,
                },
              };
            },
            async set() {},
          },
        },
        tabs: {
          async sendMessage(_tabId, message) {
            if (message.type === 'EXTRACT_ARTICLE') {
              return {
                ok: true,
                data: {
                  title: 'Article',
                  url: 'https://example.test',
                  contentMarkdown: markdown,
                },
              };
            }
            return { ok: true };
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/background.js');
        assert.equal(typeof messageListener, 'function');

        const responses = [];
        messageListener(
          { type: 'TRANSLATE_TAB', tabId: 11 },
          {},
          (response) => responses.push(response)
        );

        for (let i = 0; i < 10 && responses.length < 1; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.deepEqual(responses, [{ ok: true }]);
        assert.equal(requestBodies.length, 1);
        assert.equal(requestBodies[0].max_output_tokens, markdown.length);
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'handles semantic block viewport translation messages',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      const record = createBlockApiRecord();
      let messageListener = null;
      const stored = {};
      const sessionStored = {
        'inlineRuntimeCorrelations:v1': {
          '00000000-0000-4000-8000-000000000000': {
            expiresAt: Date.now() + 60000,
            runId: 'run-1-bad',
            diagnosticId: 'run-1-bad/b1',
            sourceFingerprint: 'raw secret must not persist',
            contractFingerprint: 'raw source must not persist',
            model: 'gpt-5.4-mini',
            targetLanguageCode: 'ko',
            extensionVersion: 'test',
            tabId: 7,
            operationId: 42,
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
      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: {
            addListener(listener) {
              messageListener = listener;
            },
          },
          sendMessage() {
            return Promise.resolve();
          },
        },
        action: { onClicked: { addListener() {} } },
        commands: { onCommand: { addListener() {} } },
        sidePanel: {
          async setPanelBehavior() {},
          async setOptions() {},
          async open() {},
        },
        scripting: { async executeScript() {} },
        storage: {
          session: {
            async get(keys) {
              const result = {};
              for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(sessionStored, key)) result[key] = sessionStored[key];
              }
              return result;
            },
            async set(values) { Object.assign(sessionStored, values); },
          },
          local: {
            async get(keys) {
              if (keys === null) return { ...stored };
              if (keys === 'settings' || keys?.includes?.('settings')) return {
                settings: {
                  apiKey: 'sk-test',
                  model: 'ft:gpt_custom/model',
                  reasoningEffort: 'none',
                  targetLanguage: 'Japanese',
                  tone: 'technical',
                },
              };
              const result = {};
              for (const key of Array.isArray(keys) ? keys : [keys]) {
                if (Object.hasOwn(stored, key)) result[key] = stored[key];
              }
              return result;
            },
            async set(values) { Object.assign(stored, values); },
            async remove(keys) {
              for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
            },
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/background.js');
        const responses = [];
        messageListener(
          {
            type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
            operationId: 42,
            records: [record],
          },
          { tab: { id: 7 } },
          (response) => responses.push(response)
        );
        for (let index = 0; index < 10 && !responses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.equal(responses[0].ok, true);
        const translated = responses[0].results[0];
        assert.equal(translated.id, record.id);
        assert.equal(typeof translated.correlationToken, 'string');

        // Simulate an MV3 service-worker restart between translation and DOM outcome.
        delete require.cache[modulePath];
        messageListener = null;
        require('../extension/background.js');
        assert.equal(typeof messageListener, 'function');

        const runtimeResponses = [];
        messageListener({
          type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
          operationId: 42,
          outcomes: [{
            code: 'runtime.apply_failed',
            correlationToken: translated.correlationToken,
            diagnosticCorrelation: {
              sourceFingerprint: 'must not persist forged fingerprint',
              model: 'must not persist forged model',
              extensionVersion: 'must not persist forged version',
            },
            source: 'must not persist',
            template: 'must not persist',
          }],
        }, { tab: { id: 7 } }, (response) => runtimeResponses.push(response));
        for (let index = 0; index < 10 && !runtimeResponses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.deepEqual(runtimeResponses, [{ ok: true }]);
        const runtimeRun = Object.values(stored).find((value) =>
          value?.blocks?.[0]?.terminalCode === 'runtime.apply_failed'
        );
        assert.equal(runtimeRun.model, 'ft:gpt_custom/model');
        assert.equal(runtimeRun.targetLanguageCode, '');
        assert.match(runtimeRun.blocks[0].parentRunId, /^run-/);
        assert.match(runtimeRun.blocks[0].parentDiagnosticId, /^run-.*\/b1$/);
        assert.match(runtimeRun.blocks[0].sourceFingerprint, /^hmac-sha256:/);
        assert.equal(JSON.stringify(runtimeRun).includes('must not persist'), false);

        const replayResponses = [];
        messageListener({
          type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
          operationId: 42,
          outcomes: [{ code: 'runtime.apply_failed', correlationToken: translated.correlationToken }],
        }, { tab: { id: 7 } }, (response) => replayResponses.push(response));
        for (let index = 0; index < 10 && !replayResponses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.deepEqual(replayResponses, [{ ok: false }]);

        const bulkEntries = {};
        const bulkOutcomes = [];
        for (let index = 0; index < 500; index += 1) {
          const token = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
          bulkEntries[token] = {
            expiresAt: Date.now() + 60000,
            runId: 'run-123-bulk',
            diagnosticId: `run-123-bulk/b${index}`,
            sourceFingerprint: `hmac-sha256:${'A'.repeat(43)}`,
            contractFingerprint: `hmac-sha256:${'B'.repeat(43)}`,
            model: 'gpt-5.4-mini',
            targetLanguageCode: 'ko',
            extensionVersion: 'test',
            tabId: 7,
            operationId: 99,
          };
          bulkOutcomes.push({ code: 'runtime.apply_failed', correlationToken: token });
        }
        sessionStored['inlineRuntimeCorrelations:v1'] = bulkEntries;
        const bulkResponses = [];
        messageListener({
          type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
          operationId: 99,
          outcomes: bulkOutcomes,
        }, { tab: { id: 7 } }, (response) => bulkResponses.push(response));
        for (let index = 0; index < 10 && !bulkResponses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.deepEqual(bulkResponses, [{ ok: true }]);
        const bulkRun = Object.values(stored).find((value) => value?.summary?.failed === 500);
        assert.equal(bulkRun.blocks.length, 100);
        assert.equal(Object.keys(sessionStored['inlineRuntimeCorrelations:v1']).length, 0);

        const localResponses = [];
        messageListener({
          type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
          settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
          diagnostics: [
            {
              code: 'runtime.block_too_large',
              template: 'x'.repeat(8000),
              contract: {
                codecVersion: 1,
                literalTokens: Array.from({ length: 24 }, (_, index) => ({
                  value: `${index}-${'y'.repeat(195)}`,
                  count: 1,
                })),
              },
            },
            {
              code: 'runtime.block_too_large',
              template: record.template,
              contract: record.contract,
              evidence: { recordCost: 13000, limit: 12000, raw: 'ignored' },
            },
          ],
        }, { tab: { id: 7 } }, (response) => localResponses.push(response));
        for (let index = 0; index < 10 && !localResponses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.deepEqual(localResponses, [{ ok: true }]);
        const localRun = Object.values(stored).find((value) =>
          value?.blocks?.[0]?.terminalCode === 'runtime.block_too_large'
        );
        assert.equal(localRun.summary.requested, 1);
        assert.equal(localRun.blocks[0].quality.evidence.recordCost, 13000);
        assert.equal(localRun.blocks[0].quality.evidence.limit, 12000);
        const expectedFingerprints = await require('../extension/translation-diagnostics.js')
          .fingerprintBlock(global.chrome, record.template, record.contract);
        assert.equal(localRun.blocks[0].sourceFingerprint, expectedFingerprints.sourceFingerprint);
        assert.equal(localRun.blocks[0].contractFingerprint, expectedFingerprints.contractFingerprint);
        assert.equal(JSON.stringify(localRun).includes(record.template), false);
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'does not expose legacy full-page text-node translation endpoint',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      let messageListener = null;
      let fetchCount = 0;

      global.fetch = async () => {
        fetchCount += 1;
        return {
          ok: true,
          async json() {
            return {
              output_text: JSON.stringify({
                translations: [{ id: 'n1', translation: '안녕하세요.' }],
              }),
            };
          },
        };
      };

      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: {
            addListener(listener) {
              messageListener = listener;
            },
          },
          sendMessage() {
            return Promise.resolve();
          },
        },
        action: { onClicked: { addListener() {} } },
        commands: { onCommand: { addListener() {} } },
        sidePanel: {
          async setPanelBehavior() {},
          async setOptions() {},
          async open() {},
        },
        scripting: {
          async executeScript() {},
        },
        storage: {
          local: {
            async get() {
              return {
                settings: {
                  apiKey: 'sk-test',
                  model: 'gpt-5.4-mini',
                  targetLanguage: 'Korean',
                  tone: 'technical',
                  chunkMaxChars: 12000,
                },
              };
            },
            async set() {},
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/background.js');
        assert.equal(typeof messageListener, 'function');

        const responses = [];
        messageListener(
          {
            type: 'TRANSLATE_TEXT_NODES',
            records: [{ id: 'n1', text: 'Hello world.' }],
          },
          {},
          (response) => responses.push(response)
        );

        for (let i = 0; i < 10 && responses.length < 1; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.equal(fetchCount, 0);
        assert.deepEqual(responses, [
          { ok: false, error: { message: 'Unknown message' } },
        ]);
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'isolates a malformed repair response and preserves its protocol code',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const first = createBlockApiRecord('first');
      const second = createBlockApiRecord('second');
      const firstTranslation = first.template
        .replace('Reasoning models', '추론 모델')
        .replace(' like ', '와 같은 ')
        .replace(' use internal reasoning tokens.', '은 내부 추론 토큰을 사용합니다.');
      let call = 0;
      global.chrome = {
        storage: { local: { async get(key) {
          if (Array.isArray(key) && key.includes('settings')) return { settings: { apiKey: 'sk-test', model: 'gpt-5.4-mini', targetLanguage: 'Korean' } };
          return {};
        }, async set() {}, async remove() {} } },
        runtime: { getManifest() { return { version: 'test' }; } },
      };
      global.fetch = async () => {
        call += 1;
        if (call === 2) {
          return { ok: true, async json() { return { output_text: '{invalid' }; } };
        }
        return { ok: true, async json() { return { output_text: JSON.stringify({
          translations: [
            { id: first.id, template: firstTranslation },
            { id: second.id, template: second.template },
          ],
        }) }; } };
      };
      try {
        const results = await helpers.translateVisibleBlockBatch([first, second]);
        assert.equal(results.find((result) => result.id === first.id).disposition, 'apply');
        assert.equal(results.find((result) => result.id === second.id).terminalCode, 'protocol.invalid_json');
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
      }
    },
  },
  {
    name: 'persists repaired detail and falls back to compact final when fingerprints fail',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const diagnostics = require('../extension/translation-diagnostics.js');
      const previousFingerprintBlock = diagnostics.fingerprintBlock;
      const stored = {};
      let record = createTestPlainBlockRecord('repair-success');
      record.template = 'Hello world.';
      let call = 0;
      global.chrome = {
        storage: { local: {
          async get(keys) {
            if (Array.isArray(keys) && keys.includes('settings')) {
              return { settings: { apiKey: 'sk-test', model: 'gpt-5.4-mini', targetLanguage: 'Korean' } };
            }
            if (keys === null) return { ...stored };
            const result = {};
            for (const key of Array.isArray(keys) ? keys : [keys]) {
              if (Object.hasOwn(stored, key)) result[key] = stored[key];
            }
            return result;
          },
          async set(values) { Object.assign(stored, values); },
          async remove(keys) {
            for (const key of Array.isArray(keys) ? keys : [keys]) delete stored[key];
          },
        } },
        runtime: { getManifest() { return { version: 'test' }; } },
      };
      global.fetch = async () => {
        call += 1;
        return { ok: true, async json() { return { output_text: JSON.stringify({
          translations: [{ id: record.id, template: call === 1 ? record.template : '한국어 문장입니다.' }],
        }) }; } };
      };
      try {
        const detailedResults = await helpers.translateVisibleBlockBatch([record]);
        const detailedRun = Object.values(stored).find((value) => value?.blocks?.length === 1);
        assert.equal(detailedResults[0].disposition, 'apply');
        assert.equal(detailedResults[0].diagnosticsUnavailable, undefined);
        assert.equal(detailedRun.outcome, 'done');
        assert.equal(detailedRun.blocks[0].terminalDisposition, 'apply');
        assert.equal(detailedRun.blocks[0].terminalCode, '');
        assert.equal(detailedRun.blocks[0].timeline[1].disposition, 'apply');

        record = createTestPlainBlockRecord('fingerprint-failure');
        record.template = 'Hello world.';
        call = 0;
        diagnostics.fingerprintBlock = async () => { throw new Error('fingerprint unavailable'); };
        const fallbackResults = await helpers.translateVisibleBlockBatch([record]);
        const compactRun = Object.values(stored).find((value) =>
          value?.outcome === 'done' && Array.isArray(value.blocks) && value.blocks.length === 0
        );
        assert.equal(fallbackResults[0].disposition, 'apply');
        assert.equal(fallbackResults[0].diagnosticsUnavailable, true);
        assert.ok(compactRun);
      } finally {
        diagnostics.fingerprintBlock = previousFingerprintBlock;
        global.chrome = previousChrome;
        global.fetch = previousFetch;
      }
    },
  },
  {
    name: 'creates collision-resistant runtime diagnostic ids within one millisecond',
    fn() {
      const first = helpers.createRuntimeDiagnosticId(1234);
      const second = helpers.createRuntimeDiagnosticId(1234);
      assert.notEqual(first, second);
      assert.match(first, /^runtime-1234-/);
    },
  },
];
