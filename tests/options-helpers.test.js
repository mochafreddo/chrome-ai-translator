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

async function withOptionsScreen(check, { granted = true, response = { ok: true } } = {}) {
  const modulePath = require.resolve('../extension/options.js');
  const originalModule = require.cache[modulePath];
  const originals = { document: global.document, chrome: global.chrome,
    diagnostics: global.ChromeAiTranslatorDiagnostics, setTimeout: global.setTimeout };
  const elements = new Map();
  const inputs = createChoiceInputs();
  const messages = [];
  const events = [];
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, { value: '', textContent: '', hidden: true,
      listeners: {}, addEventListener(name, listener) { this.listeners[name] = listener; } });
    return elements.get(id);
  };
  global.document = { getElementById: element, querySelectorAll: () => inputs };
  global.setTimeout = () => {};
  global.ChromeAiTranslatorDiagnostics = { loadDiagnostics: async () => ({ runs: [] }) };
  global.chrome = {
    permissions: {
      request() { events.push('permission'); return Promise.resolve(granted); },
      remove() { events.push('permission'); return Promise.resolve(true); },
    },
    storage: { local: { async get() {
      events.push('storage');
      return { settings: { viewMode: 'translation', apiKey: 'sk-stale', model: 'stale-model' } };
    } } },
    runtime: { async sendMessage(message) {
      messages.push(message);
      events.push(message.type);
      if (message.type === 'GET_SETTINGS') return { ok: true, settings: {
        apiKey: '***', model: 'current-model', viewMode: 'bilingual', buttonVisibility: 'onInvocation',
      } };
      return typeof response === 'function' ? response() : response;
    } },
  };
  const flush = async () => { for (let i = 0; i < 32; i += 1) await Promise.resolve(); };
  try {
    delete require.cache[modulePath];
    require('../extension/options.js');
    await flush();
    await check({ element, inputs, messages, events, flush });
  } finally {
    global.document = originals.document;
    global.chrome = originals.chrome;
    global.ChromeAiTranslatorDiagnostics = originals.diagnostics;
    global.setTimeout = originals.setTimeout;
    require.cache[modulePath] = originalModule;
  }
}

exports.name = 'options helpers';
exports.tests = [
  {
    name: 'Options requests all-sites permission before awaiting and restores the public choice after denial',
    async fn() {
      await withOptionsScreen(async ({ element, inputs, messages, events, flush }) => {
        helpers.checkChoice(inputs, 'allPages');
        events.length = 0;
        element('btnSave').listeners.click();
        assert.deepEqual(events, ['permission']);
        await flush();
        assert.equal(messages.some((message) => message.type === 'SAVE_SETTINGS'), false);
        assert.equal(inputs.find((input) => input.checked).value, 'onInvocation');
        assert.equal(element('status').textContent, '');
        assert.match(element('errorBox').textContent, /Nothing was saved/);
      }, { granted: false });
    },
  },
  ...[undefined, { ok: false, error: { message: 'sk-synthetic' } }].map((response) => ({
    name: `Options reports ${response ? 'a rejected' : 'an unanswered'} settings save without success`,
    async fn() {
      await withOptionsScreen(async ({ element, flush }) => {
        element('btnSave').listeners.click();
        await flush();
        assert.equal(element('status').textContent, '');
        assert.equal(element('errorBox').textContent, 'Failed to save settings');
        assert.equal(element('btnSave').disabled, false);
      }, { response: () => response });
    },
  })),
  {
    name: 'Options saves a new key once and reports a lost worker response without exposing the key',
    async fn() {
      let rejectSave;
      const pending = new Promise((_resolve, reject) => { rejectSave = reject; });
      await withOptionsScreen(async ({ element, messages, flush }) => {
        element('apiKey').value = 'sk-new-synthetic';
        const click = element('btnSave').listeners.click;
        click();
        click();
        await flush();
        const saves = messages.filter((message) => message.type === 'SAVE_SETTINGS');
        assert.equal(saves.length, 1);
        assert.equal(saves[0].settings.apiKey, 'sk-new-synthetic');
        assert.equal(element('status').textContent, 'Saving...');
        rejectSave(new Error('Worker disconnected sk-new-synthetic'));
        await flush();
        assert.equal(element('status').textContent, '');
        assert.equal(element('btnSave').disabled, false);
        assert.equal(element('errorBox').textContent, 'Failed to save settings');
        click();
        await flush();
        assert.equal(messages.filter((message) => message.type === 'SAVE_SETTINGS').length, 2);
      }, { response: () => pending });
    },
  },
  {
    name: 'loads public settings and saves only Options fields while a blank key keeps the existing key',
    async fn() {
      await withOptionsScreen(async ({ element, messages, events, flush }) => {
        assert.equal(element('model').value, 'current-model');
        assert.equal(element('apiKey').value, '');
        element('targetLanguage').value = 'Japanese';
        element('tone').value = 'formal';
        element('chunkMaxChars').value = '9000';
        element('btnSave').listeners.click();
        await flush();
        assert.deepEqual(messages, [
          { type: 'GET_SETTINGS' },
          { type: 'SAVE_SETTINGS', settings: {
            targetLanguage: 'Japanese', tone: 'formal', model: 'current-model',
            chunkMaxChars: 9000, buttonVisibility: 'onInvocation',
          } },
        ]);
        assert.equal(events.includes('storage'), false);
        assert.equal(element('status').textContent, 'Saved.');
      });
    },
  },
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
      // A migrated choice must stay visible so the next save preserves the reader's access.
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
        summary: {
          attemptedBlocks: 1,
          translatedBlocks: 0,
          translatedWithWarningBlocks: 1,
          failedBlocks: 0,
          repairAttemptedBlocks: 1,
          modelRequestAttempts: null,
        },
        blocks: [{ terminalCode: 'quality.english_residue' }],
      });
      assert.match(formatted, /Partial 1/);
      assert.match(formatted, /quality\.english_residue/);
    },
  },
  {
    name: 'formats native v3 diagnostics without display failure',
    fn() {
      const native = helpers.formatDiagnosticRun({
        startedAt: '2026-08-28T00:00:00.000Z',
        outcome: 'failed',
        model: 'gpt-5.4-mini',
        summary: {
          attemptedBlocks: 4,
          translatedBlocks: 1,
          translatedWithWarningBlocks: 1,
          changedBlocks: 1,
          failedBlocks: 1,
          repairAttemptedBlocks: 2,
          modelRequestAttempts: 3,
        },
        blocks: [{ terminalCode: 'runtime.request_failed' }],
      });
      assert.match(native, /Translated 1/);
      assert.match(native, /Partial 1/);
      assert.match(native, /Changed 1/);
      assert.match(native, /Failed 1/);
      assert.match(native, /Repairs 2/);
      assert.match(native, /runtime\.request_failed/);
    },
  },
];
