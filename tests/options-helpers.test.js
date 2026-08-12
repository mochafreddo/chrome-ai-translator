const assert = require('node:assert/strict');
const helpers = require('../extension/options.js');
const { readButtonVisibility } = require('../extension/button-visibility.js');

const ALL_SITES = ['http://*/*', 'https://*/*'];

function createPermissionsChrome({ granted = true } = {}) {
  const calls = [];
  return {
    calls,
    permissions: {
      async request(filter) {
        calls.push(['request', filter.origins]);
        return granted;
      },
      async remove(filter) {
        calls.push(['remove', filter.origins]);
        return true;
      },
    },
  };
}

function createChoiceInputs(checkedValue = null) {
  return ['never', 'onInvocation', 'allPages'].map((value) => ({
    value,
    checked: value === checkedValue,
  }));
}

exports.name = 'options helpers';
exports.tests = [
  {
    name: 'asks for access to all sites only for the all-pages choice',
    async fn() {
      const fakeChrome = createPermissionsChrome();

      assert.equal(
        await helpers.applyButtonVisibilityAccess(fakeChrome, 'allPages'),
        true
      );
      assert.deepEqual(fakeChrome.calls, [['request', ALL_SITES]]);
    },
  },
  {
    name: 'gives access to all sites back for the other two choices',
    async fn() {
      const fakeChrome = createPermissionsChrome();

      for (const visibility of ['never', 'onInvocation']) {
        assert.equal(
          await helpers.applyButtonVisibilityAccess(fakeChrome, visibility),
          true
        );
      }
      assert.deepEqual(fakeChrome.calls, [
        ['remove', ALL_SITES],
        ['remove', ALL_SITES],
      ]);
    },
  },
  {
    name: 'reports a refused request for access to all sites',
    async fn() {
      const fakeChrome = createPermissionsChrome({ granted: false });

      assert.equal(
        await helpers.applyButtonVisibilityAccess(fakeChrome, 'allPages'),
        false
      );
    },
  },
  {
    name: 'reads the chosen Button Visibility from the three controls',
    fn() {
      assert.equal(
        helpers.readCheckedChoice(createChoiceInputs('onInvocation'), 'never'),
        'onInvocation'
      );
      assert.equal(
        helpers.readCheckedChoice(createChoiceInputs(), 'never'),
        'never'
      );
      assert.equal(helpers.readCheckedChoice(undefined, 'never'), 'never');
    },
  },
  {
    name: 'shows a migrated install its all-pages choice',
    fn() {
      // The options page reads storage itself, so it has to see the same migration the
      // worker does — otherwise it would offer never to a reader who had the old checkbox on
      // and quietly revoke their access on the next save.
      const inputs = createChoiceInputs();
      helpers.checkChoice(inputs, readButtonVisibility({ inlineAutoShow: true }));

      assert.deepEqual(
        inputs.filter((input) => input.checked).map((input) => input.value),
        ['allPages']
      );
    },
  },
  {
    name: 'leaves exactly one Button Visibility choice checked',
    fn() {
      const inputs = createChoiceInputs('allPages');
      helpers.checkChoice(inputs, 'never');

      assert.deepEqual(
        inputs.filter((input) => input.checked).map((input) => input.value),
        ['never']
      );
    },
  },
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
    },
  },
];
