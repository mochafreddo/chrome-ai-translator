const assert = require('node:assert/strict');
const { createSettingsLifecycle } = require('../extension/settings-lifecycle.js');
const { DEFAULT_MODEL } = require('../extension/default-model.js');


function createLifecycle({ settings = {}, legacyKey, get, set, remove, chrome = {},
  contentScriptFiles = ['injected-content.js'] } = {}) {
  let persisted = { ...settings };
  const lifecycle = createSettingsLifecycle({
    chrome: {
      ...chrome,
      storage: { local: {
        async get(keys) {
          assert.deepEqual(keys, ['settings', 'openai_api_key']);
          if (get) await get();
          return { settings: { ...persisted }, openai_api_key: legacyKey };
        },
        async set(value) {
          if (set) await set(value.settings);
          persisted = { ...value.settings };
        },
        async remove(key) {
          assert.equal(key, 'openai_api_key');
          if (remove) await remove();
          legacyKey = undefined;
        },
      } },
    },
    contentScriptFiles,
  });
  return { lifecycle, snapshot: () => ({ settings: { ...persisted }, openai_api_key: legacyKey }) };
}

async function completeSettingsWork(work) {
  let timer;
  try {
    return await Promise.race([work, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('settings work did not complete')), 1000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

exports.name = 'settings lifecycle';
exports.tests = [
  {
    name: 'keeps pending saves independent across lifecycle instances',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      const first = createLifecycle({ async set() { started(); await gate; } });
      const second = createLifecycle();
      const pending = first.lifecycle.save({ model: 'first-model' });
      await ready;
      try {
        await completeSettingsWork(second.lifecycle.save({ model: 'second-model' }));
        assert.equal((await second.lifecycle.read()).model, 'second-model');
        assert.equal((await first.lifecycle.read()).model, DEFAULT_MODEL);
      } finally {
        release();
        await pending;
      }
    },
  },
  {
    name: 'reconciliation waits for accepted saves without blocking their registration',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let granted = true;
      let registered = false;
      const { lifecycle } = createLifecycle({
        settings: { buttonVisibility: 'never' },
        async set() { started(); await gate; },
        chrome: {
          permissions: { contains: async () => granted, remove: async () => { granted = false; } },
          scripting: {
            registerContentScripts: async () => { registered = true; },
            unregisterContentScripts: async () => { registered = false; },
          },
        },
      });
      const save = lifecycle.save({ buttonVisibility: 'allPages' });
      await ready;
      const reconcile = lifecycle.reconcile();
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(granted, true);
      release();
      await completeSettingsWork(Promise.all([save, reconcile]));
      assert.equal(granted, true);
      assert.equal(registered, true);
    },
  },
  {
    name: 'reads committed settings while an accepted save is still pending',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      const { lifecycle } = createLifecycle({
        settings: { model: 'committed-model' },
        async set() { started(); await gate; },
      });
      const save = lifecycle.save({ model: 'pending-model' });
      await ready;
      let readSettings;
      const reading = lifecycle.read().then((value) => { readSettings = value; });
      try {
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(readSettings?.model, 'committed-model');
      } finally {
        release();
        await Promise.all([save, reading]);
      }
      assert.equal((await lifecycle.read()).model, 'pending-model');
    },
  },
  {
    name: 'defaults to the current small model with no reasoning effort',
    async fn() {
      const { lifecycle } = createLifecycle();
      const settings = await lifecycle.read();
      assert.equal(settings.model, DEFAULT_MODEL);
      assert.equal(settings.reasoningEffort, 'none');
    },
  },
  {
    name: 'clamps unsafe chunk sizes from saved settings',
    async fn() {
      for (const [chunkMaxChars, expected] of [[-1, 2000], [Infinity, 12000], [900000, 60000]]) {
        const { lifecycle } = createLifecycle({ settings: { chunkMaxChars } });
        assert.equal((await lifecycle.read()).chunkMaxChars, expected);
      }
    },
  },
  {
    name: 'merges partial settings and allowlists persisted values',
    async fn() {
      const { lifecycle, snapshot } = createLifecycle({ settings: {
        apiKey: 'sk-existing', chunkMaxChars: 9000, buttonVisibility: 'allPages',
        targetLanguage: 'Korean', tone: 'technical', model: 'gpt-5-mini',
        viewMode: 'translation', arbitraryStoredSibling: 'stored-secret',
      } });
      await lifecycle.save({ targetLanguage: 'Japanese', tone: 'formal', model: 'gpt-5',
        viewMode: 'bilingual', arbitraryPatchSibling: 'patch-secret' });
      const next = await lifecycle.read();
      assert.equal(next.apiKey, 'sk-existing');
      assert.equal(next.chunkMaxChars, 9000);
      assert.equal(next.buttonVisibility, 'allPages');
      assert.equal(next.targetLanguage, 'Japanese');
      assert.equal(next.tone, 'formal');
      assert.equal(next.model, 'gpt-5');
      assert.equal(next.viewMode, 'bilingual');
      assert.equal(Object.hasOwn(snapshot().settings, 'arbitraryStoredSibling'), false);
      assert.equal(Object.hasOwn(snapshot().settings, 'arbitraryPatchSibling'), false);
    },
  },
  {
    name: 'normalizes legacy Button Visibility and persists only the selected choice',
    async fn() {
      for (const [settings, expected] of [[{ inlineAutoShow: true }, 'allPages'],
        [{ inlineAutoShow: false }, 'never'], [{}, 'never']]) {
        const { lifecycle, snapshot } = createLifecycle({ settings });
        assert.equal((await lifecycle.read()).buttonVisibility, expected);
        await lifecycle.save({});
        assert.equal(snapshot().settings.buttonVisibility, expected);
        assert.equal(Object.hasOwn(snapshot().settings, 'inlineAutoShow'), false);
        await lifecycle.save({ buttonVisibility: 'onInvocation' });
        assert.equal((await lifecycle.read()).buttonVisibility, 'onInvocation');
      }
    },
  },
  ...['get', 'set', 'remove'].map((failure) => ({
    name: `a rejected ${failure} does not retry or prevent later settings changes`,
    async fn() {
      let fail = true;
      let attempts = 0;
      const { lifecycle, snapshot } = createLifecycle({
        settings: { apiKey: 'sk-current-synthetic', model: 'retained-model' },
        legacyKey: 'sk-legacy-synthetic',
        async [failure]() {
          attempts += 1;
          if (fail) { fail = false; throw new Error('synthetic storage rejection'); }
        },
      });
      const rejected = assert.rejects(lifecycle.clearKey(), /synthetic storage rejection/);
      const saved = lifecycle.save({ tone: 'formal' });
      await Promise.all([rejected, saved]);
      assert.equal(attempts, failure === 'remove' ? 1 : 2);
      await lifecycle.clearKey();
      const settings = await lifecycle.read();
      assert.equal(settings.apiKey, '');
      assert.equal(settings.model, 'retained-model');
      assert.equal(settings.tone, 'formal');
      assert.equal(snapshot().settings.apiKey, undefined);
      assert.equal(snapshot().openai_api_key, undefined);
    },
  })),
  {
    name: 'a failed registration leaves a successful save available to reads and later reconciliation',
    async fn() {
      let registrations = 0;
      const { lifecycle } = createLifecycle({ chrome: {
        permissions: { contains: async () => true },
        scripting: { async registerContentScripts() {
          if (++registrations === 1) throw new Error('synthetic registration rejection');
        } },
      } });
      await lifecycle.save({ model: 'saved-model', buttonVisibility: 'allPages' });
      assert.equal((await lifecycle.read()).model, 'saved-model');
      assert.equal(await lifecycle.reconcile(), true);
      assert.equal(registrations, 2);
    },
  },
  {
    name: 'reads normalized legacy settings without writing or reaching another platform',
    async fn() {
      const lifecycle = createSettingsLifecycle({
        chrome: { storage: { local: {
          async get(keys) {
            assert.deepEqual(keys, ['settings', 'openai_api_key']);
            return {
              settings: { inlineAutoShow: true, chunkMaxChars: -1, unknown: 'discard' },
              openai_api_key: 'sk-legacy-synthetic',
            };
          },
        } } },
        contentScriptFiles: ['content.js'],
      });

      const settings = await lifecycle.read();

      assert.equal(settings.service, 'openai');
      assert.equal(settings.apiKey, 'sk-legacy-synthetic');
      assert.equal(settings.openrouterApiKey, '');
      assert.equal(settings.buttonVisibility, 'allPages');
      assert.equal(settings.chunkMaxChars, 2000);
      assert.equal(settings.reasoningEffort, 'none');
      assert.equal(Object.hasOwn(settings, 'inlineAutoShow'), false);
      assert.equal(Object.hasOwn(settings, 'unknown'), false);
    },
  },
  {
    name: 'serializes concurrent all-pages content script registration',
    async fn() {
      const registered = new Map();

      const chrome = {
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
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await Promise.all([
        lifecycle.reconcile(),
        lifecycle.reconcile(),
      ]);

      assert.equal(registered.size, 1);
      assert.deepEqual(
        registered.get('inline-translator-auto-show')?.matches,
        ['http://*/*', 'https://*/*']
      );
    },
  },
  {
    name: 'updates existing all-pages content script after duplicate registration',
    async fn() {
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

      const chrome = {
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
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await lifecycle.reconcile();

      assert.deepEqual(
        registered.get('inline-translator-auto-show'),
        {
          id: 'inline-translator-auto-show',
          matches: ['http://*/*', 'https://*/*'],
          js: ['injected-content.js'],
          runAt: 'document_idle',
        }
      );
    },
  },
  {
    name: 'updates registered all-pages content script without duplicate registration',
    async fn() {
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

      const chrome = {
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
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await lifecycle.reconcile();

      assert.deepEqual(
        registered.get('inline-translator-auto-show'),
        {
          id: 'inline-translator-auto-show',
          matches: ['http://*/*', 'https://*/*'],
          js: ['injected-content.js'],
          runAt: 'document_idle',
        }
      );
    },
  },
  {
    name: 'does not throw when all-pages duplicate recovery fails',
    async fn() {
      const chrome = {
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
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await lifecycle.reconcile();
    },
  },
  {
    name: 'safely ignores all-pages registration failures from runtime events',
    async fn() {
      const chrome = {
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
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      assert.equal(
        await lifecycle.reconcile(),
        false
      );
    },
  },
  {
    name: 'registers the content script across pages for the all-pages choice alone',
    async fn() {
      // Registering it is what lets the button appear without the reader invoking the
      // extension. The other two choices must leave no registration behind, or a reader who
      // moved away from all pages would keep getting the button on every page.
      for (const [visibility, expected] of [
        ['allPages', ['inline-translator-auto-show']],
        ['onInvocation', []],
        ['never', []],
      ]) {
        const registered = new Map([
          ['inline-translator-auto-show', { id: 'inline-translator-auto-show' }],
        ]);

        const chrome = {
          permissions: {
            async contains() {
              return true;
            },
          },
          scripting: {
            async getRegisteredContentScripts({ ids }) {
              return Array.from(registered.values()).filter((script) =>
                ids.includes(script.id)
              );
            },
            async unregisterContentScripts({ ids }) {
              for (const id of ids || []) registered.delete(id);
            },
            async updateContentScripts(scripts) {
              for (const script of scripts || []) registered.set(script.id, script);
            },
            async registerContentScripts(scripts) {
              for (const script of scripts || []) registered.set(script.id, script);
            },
          },
        };
        const { lifecycle } = createLifecycle({ settings: { buttonVisibility: visibility }, chrome });

        await lifecycle.reconcile();
        assert.deepEqual(Array.from(registered.keys()), expected, visibility);
      }
    },
  },
  {
    name: 'gives back access to all sites for the two choices that do not need it',
    async fn() {
      // An install migrating off the old checkbox reaches never without the reader opening
      // the options page, so the access the checkbox asked for has to be given back here.
      const removed = [];

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
          async remove({ origins }) {
            removed.push(origins);
            return true;
          },
        },
        scripting: {
          async unregisterContentScripts() {},
        },
      };
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await lifecycle.save({ buttonVisibility: 'never' });
      await lifecycle.save({ buttonVisibility: 'onInvocation' });
      assert.deepEqual(removed, [
        ['http://*/*', 'https://*/*'],
        ['http://*/*', 'https://*/*'],
      ]);
    },
  },
  {
    name: 'keeps access to all sites for the all-pages choice',
    async fn() {
      let removed = false;

      const chrome = {
        permissions: {
          async contains() {
            return true;
          },
          async remove() {
            removed = true;
            return true;
          },
        },
        scripting: {
          async getRegisteredContentScripts() {
            return [];
          },
          async registerContentScripts() {},
          async unregisterContentScripts() {},
        },
      };
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await lifecycle.reconcile();
      assert.equal(removed, false);
    },
  },
  {
    name: 'keeps the content script unregistered without access to all sites',
    async fn() {
      // The choice and the permission can disagree: Chrome lets the reader revoke access
      // from its own UI, which no longer reaches the options page.
      const unregistered = [];

      const chrome = {
        permissions: {
          async contains() {
            return false;
          },
        },
        scripting: {
          async unregisterContentScripts({ ids }) {
            unregistered.push(...(ids || []));
          },
          async registerContentScripts() {
            throw new Error('registered without access to all sites');
          },
        },
      };
      const { lifecycle } = createLifecycle({ settings: { buttonVisibility: 'allPages' }, chrome });

      await lifecycle.reconcile();
      assert.deepEqual(unregistered, ['inline-translator-auto-show']);
    },
  },
  {
    name: 'a newer all-pages gesture keeps its grant while an older unregister is pending',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let granted = false;
      let registered = false;
      const { lifecycle } = createLifecycle({
        chrome: {
          permissions: { contains: async () => granted, remove: async () => { granted = false; } },
          scripting: {
            registerContentScripts: async () => { registered = true; },
            async unregisterContentScripts() { started(); await gate; registered = false; },
          },
        },
      });
      const first = lifecycle.save({ buttonVisibility: 'never' });
      await completeSettingsWork(ready);
      granted = true;
      const second = lifecycle.save({ buttonVisibility: 'allPages' });
      release();
      await completeSettingsWork(Promise.all([first, second]));
      assert.equal(granted, true);
      assert.equal(registered, true);
    },
  },
  {
    name: 'a later all-pages gesture keeps access when an earlier never save finishes',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      let granted = false;
      let registered = false;
      const { lifecycle } = createLifecycle({
        async set() { if (++writes === 1) { started(); await gate; } },
        chrome: {
          permissions: { contains: async () => granted, remove: async () => { granted = false; } },
          scripting: {
            registerContentScripts: async () => { registered = true; },
            unregisterContentScripts: async () => { registered = false; },
          },
        },
      });
      const first = lifecycle.save({ buttonVisibility: 'never' });
      await ready;
      granted = true; // The later Options gesture grants access before sending its save.
      const second = lifecycle.save({ buttonVisibility: 'allPages' });
      release();
      await Promise.all([first, second]);
      assert.equal((await lifecycle.read()).buttonVisibility, 'allPages');
      assert.equal(granted, true);
      assert.equal(registered, true);
    },
  },
  {
    name: 'key removal responds only after the legacy key removal finishes',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      const { lifecycle } = createLifecycle({
        settings: { apiKey: 'sk-current-synthetic' }, legacyKey: 'sk-legacy-synthetic',
        async remove() { started(); await gate; },
      });
      let answered = false;
      const clear = lifecycle.clearKey().then((result) => { answered = true; return result; });
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(answered, false);
      release();
      await clear;
      assert.equal((await lifecycle.read()).apiKey, '');
    },
  },
  {
    name: 'later overlapping settings request owns the same field and final Button Visibility registration',
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      const registrations = [];
      const { lifecycle } = createLifecycle({
        async set() { if (++writes === 1) { started(); await gate; } },
        chrome: {
          permissions: { contains: async () => true, remove: async () => true },
          scripting: {
            getRegisteredContentScripts: async () => [],
            registerContentScripts: async () => { registrations.push('allPages'); },
            unregisterContentScripts: async () => { registrations.push('never'); },
          },
        },
      });
      const first = lifecycle.save({ model: 'first', buttonVisibility: 'allPages' });
      await ready;
      const second = lifecycle.save({ model: 'last', buttonVisibility: 'never' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await Promise.all([first, second]);
      const result = await lifecycle.read();
      assert.equal(result.model, 'last');
      assert.equal(result.buttonVisibility, 'never');
      assert.equal(registrations.at(-1), 'never');
    },
  },
  {
    name: 'preserves different fields from overlapping settings saves after storage completes',
    async fn() {
      let releaseWrite;
      let writeStarted;
      const started = new Promise((resolve) => { writeStarted = resolve; });
      const blocked = new Promise((resolve) => { releaseWrite = resolve; });
      let writes = 0;
      const { lifecycle } = createLifecycle({
        settings: { model: 'initial-model', apiKey: 'sk-synthetic' },
        async set() {
          writes += 1;
          if (writes === 1) { writeStarted(); await blocked; }
        },
      });
      let firstAnswered = false;
      const first = lifecycle.save({ model: 'new-model' })
        .then((response) => { firstAnswered = true; return response; });
      await started;
      const second = lifecycle.save({ tone: 'formal' });
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(firstAnswered, false);
      releaseWrite();
      await Promise.all([first, second]);
      const response = await lifecycle.read();
      assert.equal(response.model, 'new-model');
      assert.equal(response.tone, 'formal');
      assert.equal(response.apiKey, 'sk-synthetic');
    },
  },
  ...[
    ['save then clear', { tone: 'formal' }, false],
    ['clear then save', { tone: 'formal' }, true],
    ['new key then clear', { apiKey: 'sk-new-synthetic', tone: 'formal' }, false],
    ['clear then new key', { apiKey: 'sk-new-synthetic', tone: 'formal' }, true],
  ].map(([order, settings, clearFirst]) => ({
    name: `overlapping ${order} preserves settings and follows explicit key intent`,
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      const { lifecycle, snapshot } = createLifecycle({
        settings: { apiKey: 'sk-current-synthetic', model: 'retained-model' },
        legacyKey: 'sk-legacy-synthetic',
        async set() { if (++writes === 1) { started(); await gate; } },
      });
      const first = clearFirst ? lifecycle.clearKey() : lifecycle.save(settings);
      await ready;
      const second = clearFirst ? lifecycle.save(settings) : lifecycle.clearKey();
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await Promise.all([first, second]);
      const result = await lifecycle.read();
      assert.equal(result.tone, 'formal');
      assert.equal(result.model, 'retained-model');
      assert.equal(snapshot().openai_api_key, undefined);
      const expectedKey = clearFirst && settings.apiKey ? 'sk-new-synthetic' : '';
      assert.equal(snapshot().settings.apiKey || '', expectedKey);
      assert.equal(result.apiKey, expectedKey);
    },
  })),
  ...[['get', true], ['set', true], ['get', false], ['set', false]].map(([failure, laterGrant]) => ({
    name: `an earlier visibility save still synchronizes after a newer ${laterGrant ? 'all-pages' : 'tone'} ${failure} fails`,
    async fn() {
      let release;
      let started;
      const gate = new Promise((resolve) => { release = resolve; });
      const ready = new Promise((resolve) => { started = resolve; });
      let writes = 0;
      let reads = 0;
      let granted = true;
      let registered = true;
      const { lifecycle } = createLifecycle({
        settings: { buttonVisibility: 'allPages' },
        async get() { if (++reads === 2 && failure === 'get') throw new Error('read failed'); },
        async set() {
          if (++writes === 1) { started(); await gate; }
          else if (writes === 2 && failure === 'set') throw new Error('write failed');
        },
        chrome: {
          permissions: { contains: async () => granted, remove: async () => { granted = false; } },
          scripting: {
            registerContentScripts: async () => { registered = true; },
            unregisterContentScripts: async () => { registered = false; },
          },
        },
      });
      const first = lifecycle.save({ buttonVisibility: 'never' });
      await completeSettingsWork(ready);
      granted = true;
      const second = lifecycle.save(laterGrant ? { buttonVisibility: 'allPages' } : { tone: 'formal' }).catch((error) => error);
      release();
      const results = await completeSettingsWork(Promise.all([first, second]));
      assert.ok(results[1] instanceof Error);
      assert.equal((await lifecycle.read()).buttonVisibility, 'never');
      assert.equal(registered, false);
      // Permission and persistence are not transactional: the later gesture's grant survives
      // its failed save, while registration still matches the successful persisted choice.
      assert.equal(granted, laterGrant);
    },
  })),
];
