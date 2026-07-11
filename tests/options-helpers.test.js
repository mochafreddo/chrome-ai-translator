const assert = require('node:assert/strict');
const helpers = require('../extension/options.js');

exports.name = 'options helpers';
exports.tests = [
  {
    name: 'clears current and legacy API key storage',
    async fn() {
      const removed = [];
      let savedSettings = null;
      const fakeChrome = {
        storage: {
          local: {
            async get(keys) {
              assert.deepEqual(keys, ['settings']);
              return {
                settings: {
                  apiKey: 'sk-current',
                  model: 'gpt-5.4-mini',
                },
              };
            },
            async set(value) {
              savedSettings = value.settings;
            },
            async remove(key) {
              removed.push(key);
            },
          },
        },
      };

      await helpers.clearStoredApiKey(fakeChrome);

      assert.equal(savedSettings.apiKey, undefined);
      assert.equal(savedSettings.model, 'gpt-5.4-mini');
      assert.deepEqual(removed, ['openai_api_key']);
    },
  },
  {
    name: 'requires confirmation before clearing stored API key',
    fn() {
      assert.equal(helpers.shouldClearStoredApiKey(() => false), false);
      assert.equal(helpers.shouldClearStoredApiKey(() => true), true);
    },
  },
  {
    name: 'labels inline diagnostic chunks as records rather than nodes',
    fn() {
      const formatted = helpers.formatInlineLog({
        startedAt: '2026-07-10T00:00:00.000Z',
        status: 'done',
        durationMs: 10,
        recordCount: 1,
        totalChars: 100,
        chunkCount: 1,
        chunkMaxChars: 12000,
        chunks: [
          {
            index: 1,
            ok: true,
            durationMs: 5,
            recordCount: 1,
            charCount: 100,
          },
        ],
      });

      assert.match(formatted, /1 records, 100 chars/);
      assert.equal(formatted.includes(' nodes'), false);
    },
  },
  {
    name: 'formats schema-2 partial diagnostics with stable codes',
    fn() {
      const formatted = helpers.formatDiagnosticRun({
        startedAt: '2026-07-11T00:00:00.000Z',
        outcome: 'partial',
        model: 'gpt-5.4-mini',
        summary: { translated: 0, translatedWithWarning: 1, failed: 0, repairs: 1 },
        blocks: [{ terminalCode: 'quality.english_residue' }],
      });
      assert.match(formatted, /Partial 1/);
      assert.match(formatted, /quality\.english_residue/);
      assert.equal(helpers.buildDiagnosticExport([]).schemaVersion, 2);
    },
  },
];
