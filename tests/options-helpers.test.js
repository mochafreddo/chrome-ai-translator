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
];
