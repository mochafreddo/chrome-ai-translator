const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../extension/background.js');
const contentHelpers = require('../extension/content.js');
const fullPageMarkdown = require('../extension/full-page-markdown.js');
const { createReasoningFixture } = require('./inline-block.test');
const { DEFAULT_MODEL } = require('../extension/default-model.js');

// Per-tab state is the worker's alone, and the only account of it a caller gets is the
// STATE_UPDATED broadcast the panel listens to. Collecting those is how a test sees both
// what was recorded and, just as importantly, when nothing was.
function createStateBroadcastChrome(broadcasts) {
  return {
    runtime: {
      async sendMessage(message) {
        broadcasts.push(message);
      },
    },
  };
}

function createCompletedResponse(outputText) {
  return {
    status: 'completed',
    output: [{
      type: 'message',
      content: [{ type: 'output_text', text: outputText }],
    }],
  };
}

function createIncompleteResponse() {
  return {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [],
  };
}

function createProtectedFullPageChunk() {
  const namespace = 'CAT_RECOVERY';
  const link = {
    id: 'L1',
    kind: 'link',
    openToken: `⟦${namespace}:LINK_OPEN:L1⟧`,
    closeToken: `⟦${namespace}:LINK_CLOSE:L1⟧`,
    destination: 'https://private.test/path?token=secret',
  };
  const code = {
    id: 'C1',
    kind: 'code',
    token: `⟦${namespace}:ATOM:C1⟧`,
    display: 'inline',
    value: 'private-command --secret',
    language: '',
  };
  const documentModel = {
    namespace,
    entries: [link, code],
    blocks: [
      {
        id: 'm1',
        kind: 'paragraph',
        template: `Read ${link.openToken}the guide${link.closeToken}.`,
        entries: [link.id],
      },
      {
        id: 'm2',
        kind: 'paragraph',
        template: `Run ${code.token} now.`,
        entries: [code.id],
      },
    ],
  };
  const [chunk] = fullPageMarkdown.createTranslationChunks(documentModel, 200);
  return { chunk, link, code };
}

function createPlainTranslationDocument(markdown) {
  return {
    namespace: 'CAT_TAB',
    entries: [],
    blocks: [{
      id: 'm1',
      kind: 'paragraph',
      template: markdown,
      originalMarkdown: markdown,
      entries: [],
    }],
  };
}

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
    name: 'recovers one incomplete full-page chunk with ordered protected children',
    async fn() {
      const previousFetch = global.fetch;
      const { chunk, link, code } = createProtectedFullPageChunk();
      const requestBodies = [];
      const responses = [
        createIncompleteResponse(),
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.`
        ),
        createCompletedResponse(`지금 ${code.token} 실행.`),
      ];
      global.fetch = async (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        const response = responses.shift();
        return { ok: true, async json() { return response; } };
      };

      try {
        const translated = await helpers.translateFullPageChunk(chunk, {
          apiKey: 'sk-test',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          targetLanguage: 'Korean',
          tone: 'technical',
        });

        assert.equal(requestBodies.length, 3);
        assert.equal(
          translated,
          '읽기 [안내](<https://private.test/path?token=secret>).\n\n지금 ```private-command --secret``` 실행.'
        );
        assert.deepEqual(
          requestBodies.map((body) => body.input),
          [chunk.template, chunk.blocks[0].template, chunk.blocks[1].template]
        );
        for (const body of requestBodies) {
          const request = JSON.stringify(body);
          assert.equal(request.includes(link.destination), false);
          assert.equal(request.includes(code.value), false);
        }
      } finally {
        global.fetch = previousFetch;
      }
    },
  },
  {
    name: 'stops after an incomplete recovery child without publishing success',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const { chunk, link } = createProtectedFullPageChunk();
      const states = [];
      let requestCount = 0;
      const responses = [
        createIncompleteResponse(),
        createCompletedResponse(
          `읽기 ${link.openToken}안내${link.closeToken}.`
        ),
        createIncompleteResponse(),
      ];
      global.chrome = {
        runtime: {
          sendMessage(message) {
            states.push(message);
            return Promise.resolve();
          },
        },
      };
      global.fetch = async () => {
        requestCount += 1;
        const response = responses.shift();
        return { ok: true, async json() { return response; } };
      };

      try {
        await assert.rejects(
          () =>
            helpers.translateFullPageChunk(chunk, {
              apiKey: 'sk-test',
              model: 'gpt-5.4-mini',
              reasoningEffort: 'none',
              targetLanguage: 'Korean',
              tone: 'technical',
            }),
          (error) => error.code === 'response.incomplete.max_output_tokens'
        );
        assert.equal(requestCount, 3);
        assert.equal(
          states.some((message) => message?.state?.status === 'done'),
          false
        );
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
      }
    },
  },
  {
    name: 'keeps extraction contracts out of tab state while translating protected Markdown',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      const { chunk, link, code } = createProtectedFullPageChunk();
      const stateMessages = [];
      const requestBodies = [];
      let messageListener = null;

      global.fetch = async (_url, options) => {
        requestBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          async json() {
            return createCompletedResponse(
              `읽기 ${link.openToken}안내${link.closeToken}.\n\n지금 ${code.token} 실행.`
            );
          },
        };
      };
      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: { addListener(listener) { messageListener = listener; } },
          sendMessage(message) {
            if (message.type === 'STATE_UPDATED') stateMessages.push(message);
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
          local: {
            async get() {
              return {
                settings: {
                  apiKey: 'sk-test',
                  chunkMaxChars: 2000,
                  arbitraryStoredSibling: 'stored-state-secret',
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
                  langHint: 'en',
                  contentMarkdown: 'Read the guide and run the command.',
                  translationDocument: {
                    namespace: chunk.contract.namespace,
                    entries: chunk.contract.entries,
                    blocks: chunk.blocks,
                  },
                  contract: 'unexpected-contract-sentinel',
                  destination: 'https://unexpected.test/private-destination',
                  body: 'unexpected-body-sentinel',
                  apiKey: 'unexpected-key-sentinel',
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
        const responses = [];
        messageListener(
          { type: 'TRANSLATE_TAB', tabId: 20 },
          {},
          (response) => responses.push(response)
        );
        for (let i = 0; i < 20 && responses.length < 1; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.deepEqual(responses, [{ ok: true }]);
        assert.equal(stateMessages.at(-1)?.state?.status, 'done');
        const publicStateKeys = new Set([
          'status',
          'error',
          'extracted',
          'translated',
          'progress',
          'settingsUsed',
          'updatedAt',
        ]);
        const settingsUsedKeys = [
          'model',
          'reasoningEffort',
          'targetLanguage',
          'tone',
          'viewMode',
          'chunkMaxChars',
        ];
        for (const message of stateMessages) {
          const serialized = JSON.stringify(message);
          assert.equal(
            Object.keys(message.state).every((key) => publicStateKeys.has(key)),
            true
          );
          if (message.state.settingsUsed) {
            assert.deepEqual(
              Object.keys(message.state.settingsUsed),
              settingsUsedKeys
            );
          }
          assert.equal(serialized.includes('translationDocument'), false);
          assert.equal(
            serialized.includes('unexpected-contract-sentinel'),
            false
          );
          assert.equal(serialized.includes('private-destination'), false);
          assert.equal(serialized.includes('unexpected-body-sentinel'), false);
          assert.equal(serialized.includes('unexpected-key-sentinel'), false);
          if (message.state.status !== 'done') {
            assert.equal(serialized.includes('token=secret'), false);
            assert.equal(serialized.includes('private-command --secret'), false);
          }
        }
        const stateResponses = [];
        messageListener(
          { type: 'GET_STATE', tabId: 20 },
          {},
          (response) => stateResponses.push(response)
        );
        for (let i = 0; i < 10 && stateResponses.length < 1; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.equal(stateResponses.length, 1);
        assert.equal(
          Object.keys(stateResponses[0].state).every((key) =>
            publicStateKeys.has(key)
          ),
          true
        );
        assert.equal(
          JSON.stringify(stateResponses[0]).includes('stored-state-secret'),
          false
        );
        assert.equal(requestBodies.length, 1);
        assert.equal(
          JSON.stringify(requestBodies).includes('token=secret'),
          false
        );
        assert.equal(
          JSON.stringify(requestBodies).includes('private-command --secret'),
          false
        );
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'does not publish done when a real tab translation recovery child is incomplete',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      const namespace = 'CAT_TAB_RECOVERY';
      const blocks = [1, 2, 3].map((index) => ({
        id: `m${index}`,
        kind: 'paragraph',
        template: `Paragraph ${index} ${'word '.repeat(115)}`.trim(),
        originalMarkdown: `Paragraph ${index} ${'word '.repeat(115)}`.trim(),
        entries: [],
      }));
      const translationDocument = { namespace, entries: [], blocks };
      const responsesFromApi = [
        createIncompleteResponse(),
        createCompletedResponse(blocks[0].template),
        createIncompleteResponse(),
      ];
      const states = [];
      let requestCount = 0;
      let messageListener = null;

      global.fetch = async () => {
        requestCount += 1;
        return {
          ok: true,
          async json() { return responsesFromApi.shift(); },
        };
      };
      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: { addListener(listener) { messageListener = listener; } },
          sendMessage(message) {
            if (message.type === 'STATE_UPDATED') states.push(message.state);
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
          local: {
            async get() {
              return { settings: { apiKey: 'sk-test', chunkMaxChars: 2000 } };
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
                  langHint: 'en',
                  contentMarkdown: 'Original display Markdown.',
                  translationDocument,
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
        const responses = [];
        messageListener(
          { type: 'TRANSLATE_TAB', tabId: 21 },
          {},
          (response) => responses.push(response)
        );
        for (let i = 0; i < 20 && responses.length < 1; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }

        assert.deepEqual(responses, [{
          ok: true,
          skipped: true,
          reason: 'translate_failed',
        }]);
        assert.equal(states.some((state) => state.status === 'done'), false);
        assert.equal(states.at(-1)?.status, 'error');
        assert.equal(states.at(-1)?.translated, null);
        assert.equal(states.at(-1)?.progress, null);
        assert.equal(requestCount, 3);
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'owns malformed and oversized extraction failures without publishing display state',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const modulePath = require.resolve('../extension/background.js');
      const originalModule = require.cache[modulePath];
      const extractionByTab = new Map([
        [30, null],
        [31, undefined],
        [32, 'malformed extraction'],
        [
          33,
          {
            title: 'Missing document',
            url: 'https://example.test/missing',
            langHint: 'en',
            contentMarkdown: 'Visible but invalid.',
          },
        ],
        [
          34,
          {
            title: 'Malformed document',
            url: 'https://example.test/malformed',
            langHint: 'en',
            contentMarkdown: 'Visible but invalid.',
            translationDocument: { blocks: null },
          },
        ],
        [
          35,
          {
            title: 'Oversized',
            url: 'https://example.test/oversized',
            langHint: 'en',
            contentMarkdown: `oversized-display-sentinel${'x'.repeat(60000)}`,
            translationDocument:
              createPlainTranslationDocument('safe template'),
          },
        ],
      ]);
      const statesByTab = new Map();
      let fetchCount = 0;
      let messageListener = null;

      global.fetch = async () => {
        fetchCount += 1;
        throw new Error('model request must not run');
      };
      global.chrome = {
        runtime: {
          onInstalled: { addListener() {} },
          onStartup: { addListener() {} },
          onMessage: { addListener(listener) { messageListener = listener; } },
          sendMessage(message) {
            if (message.type === 'STATE_UPDATED') {
              const states = statesByTab.get(message.tabId) || [];
              states.push(message.state);
              statesByTab.set(message.tabId, states);
            }
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
          local: {
            async get() {
              return { settings: { apiKey: 'sk-test', chunkMaxChars: 2000 } };
            },
            async set() {},
          },
        },
        tabs: {
          async sendMessage(tabId, message) {
            if (message.type === 'EXTRACT_ARTICLE') {
              return { ok: true, data: extractionByTab.get(tabId) };
            }
            return { ok: true };
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/background.js');

        for (const tabId of extractionByTab.keys()) {
          const responses = [];
          messageListener(
            { type: 'TRANSLATE_TAB', tabId },
            {},
            (response) => responses.push(response)
          );
          for (let i = 0; i < 20 && responses.length < 1; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          assert.deepEqual(responses, [{
            ok: true,
            skipped: true,
            reason: 'extract_failed',
          }]);
        }

        assert.equal(fetchCount, 0);
        for (const states of statesByTab.values()) {
          assert.equal(states.at(-1)?.status, 'error');
          assert.equal(states.at(-1)?.progress, null);
          assert.equal(states.at(-1)?.translated, null);
          assert.equal(
            states.some((state) => Boolean(state.extracted)),
            false
          );
          assert.equal(
            JSON.stringify(states).includes('oversized-display-sentinel'),
            false
          );
        }
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'defaults to the current small model with no reasoning effort',
    fn() {
      const settings = helpers.mergeSettingsWithExisting({}, {});

      assert.equal(settings.model, DEFAULT_MODEL);
      assert.equal(settings.reasoningEffort, 'none');
    },
  },
  {
    name: 'exact-allowlists public tab state and settings used fields',
    fn() {
      const state = helpers.sanitizePublicTabState({
        status: 'done',
        error: { message: 'bounded', name: 'Error', secret: 'error-secret' },
        extracted: {
          title: 'Article',
          url: 'https://example.test',
          langHint: 'en',
          contentMarkdown: '# Article',
          contract: 'private-contract',
        },
        translated: '# 번역',
        progress: { current: 1, total: 1, privateCounter: 99 },
        settingsUsed: {
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          targetLanguage: 'Korean',
          tone: 'technical',
          viewMode: 'translation',
          chunkMaxChars: 12000,
          apiKey: 'sk-private',
          arbitraryStoredSibling: 'settings-secret',
        },
        updatedAt: '2026-07-13T00:00:00.000Z',
        arbitraryPatchSibling: 'state-secret',
      });

      assert.deepEqual(Object.keys(state), [
        'status',
        'error',
        'extracted',
        'translated',
        'progress',
        'settingsUsed',
        'updatedAt',
      ]);
      assert.deepEqual(Object.keys(state.settingsUsed), [
        'model',
        'reasoningEffort',
        'targetLanguage',
        'tone',
        'viewMode',
        'chunkMaxChars',
      ]);
      assert.deepEqual(Object.keys(state.error), ['message', 'name']);
      assert.deepEqual(Object.keys(state.extracted), [
        'title',
        'url',
        'langHint',
        'contentMarkdown',
      ]);
      assert.deepEqual(Object.keys(state.progress), ['current', 'total']);
      assert.equal(JSON.stringify(state).includes('secret'), false);
      assert.equal(JSON.stringify(state).includes('private-contract'), false);
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
          buttonVisibility: 'allPages',
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
      assert.equal(next.buttonVisibility, 'allPages');
      assert.equal(next.targetLanguage, 'Japanese');
      assert.equal(next.tone, 'formal');
      assert.equal(next.model, 'gpt-5');
      assert.equal(next.viewMode, 'bilingual');
    },
  },
  {
    name: 'migrates the old inline button checkbox to a Button Visibility choice',
    fn() {
      // Settings saved before the three states still hold the boolean. Merging is where
      // storage is read, so it is where the older shape stops being visible — and the
      // boolean is not written back.
      const migrated = helpers.mergeSettingsWithExisting(
        { inlineAutoShow: true, targetLanguage: 'Korean' },
        {}
      );
      assert.equal(migrated.buttonVisibility, 'allPages');
      assert.equal(Object.hasOwn(migrated, 'inlineAutoShow'), false);

      assert.equal(
        helpers.mergeSettingsWithExisting({ inlineAutoShow: false }, {})
          .buttonVisibility,
        'never'
      );
      assert.equal(helpers.mergeSettingsWithExisting({}, {}).buttonVisibility, 'never');
    },
  },
  {
    name: 'lets a saved Button Visibility choice replace the migrated one',
    fn() {
      const next = helpers.mergeSettingsWithExisting(
        { inlineAutoShow: true },
        { buttonVisibility: 'onInvocation' }
      );
      assert.equal(next.buttonVisibility, 'onInvocation');
    },
  },
  {
    name: 'drops arbitrary stored and patch siblings when merging settings',
    fn() {
      const next = helpers.mergeSettingsWithExisting(
        {
          apiKey: 'sk-existing',
          targetLanguage: 'Korean',
          arbitraryStoredSibling: 'stored-secret',
        },
        {
          tone: 'formal',
          arbitraryPatchSibling: 'patch-secret',
        }
      );

      assert.equal(next.apiKey, 'sk-existing');
      assert.equal(next.tone, 'formal');
      assert.equal(Object.hasOwn(next, 'arbitraryStoredSibling'), false);
      assert.equal(Object.hasOwn(next, 'arbitraryPatchSibling'), false);
    },
  },
  {
    name: 'merges visible batch settings snapshot without accepting api key',
    fn() {
      const settings = helpers.mergeVisibleBatchSettingsSnapshot(
        {
          apiKey: 'sk-current',
          chunkMaxChars: 9000,
          buttonVisibility: 'allPages',
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
          viewMode: 'translation',
        },
        {
          apiKey: 'sk-from-content',
          chunkMaxChars: 24000,
          buttonVisibility: 'never',
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          viewMode: 'bilingual',
        }
      );

      assert.equal(settings.apiKey, 'sk-current');
      assert.equal(settings.chunkMaxChars, 9000);
      assert.equal(settings.buttonVisibility, 'allPages');
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
            return createCompletedResponse('번역 결과');
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
        assert.equal(requestBody.store, false);
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
            return createCompletedResponse('번역 결과');
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
    // The worker used to carry an `assertInlineBlockSessionBudget` that nothing called,
    // and this suite's green check on it was the only thing making it look live. ADR-0003
    // gave the session cap to the content script, where `tests/content-helpers.test.js`
    // already checks it holds. Checking the export alone would only catch the one shape
    // that was there before, so the worker's source is read too: a re-added constant, or
    // an assert kept out of `module.exports`, has to fail here as well.
    name: 'leaves the Semantic Block session cap to the content script',
    fn() {
      assert.equal(helpers.assertInlineBlockSessionBudget, undefined);

      const backgroundJs = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'background.js'),
        'utf8'
      );
      for (const retired of [
        'assertInlineBlockSessionBudget',
        'INLINE_BLOCK_MAX_SESSION_COST',
      ]) {
        assert.equal(
          backgroundJs.includes(retired),
          false,
          `${retired} is back in the service worker`
        );
      }
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
    name: 'rejects repaired non-Korean output without exposing block internals',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const record = createBlockApiRecord();
      const requestBodies = [];
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
        requestBodies.push(JSON.parse(options.body));
        return {
          ok: true,
          async json() {
            return createCompletedResponse(JSON.stringify({
              translations: [{ id: record.id, template: record.template }],
            }));
          },
        };
      };

      try {
        const results = await helpers.translateVisibleBlockBatch([record]);
        const input = JSON.parse(requestBodies[1].input);

        assert.equal(results[0].correlationToken, undefined);
        const result = results[0];
        assert.equal(result.disposition, 'reject');
        assert.equal('template' in result, false);
        assert.equal(result.terminalCode, 'quality.target_language_missing');
        assert.equal(requestBodies.length, 2);
        assert.equal(input.records[0].contract, undefined);
        assert.equal(input.records[0].atoms[0].href, undefined);
        assert.equal(requestBodies[1].text.format.name, 'inline_block_translations');
        assert.equal(
          requestBodies[1].max_output_tokens,
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
    name: 'loads the semantic block codec before the content script',
    fn() {
      assert.deepEqual(helpers.getInlineContentScriptFiles(), [
        'default-model.js',
        'inline-block.js',
        'inline-diagnostics-protocol.js',
        'inline-translation-controls.js',
        'full-page-markdown.js',
        'content.js',
      ]);
    },
  },
  {
    name: 'serializes concurrent all-pages content script registration',
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
          helpers.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' }),
          helpers.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' }),
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
    name: 'updates existing all-pages content script after duplicate registration',
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
        await helpers.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' });

        assert.deepEqual(
          registered.get('inline-translator-auto-show'),
          {
            id: 'inline-translator-auto-show',
            matches: ['http://*/*', 'https://*/*'],
            js: [
              'default-model.js',
              'inline-block.js',
              'inline-diagnostics-protocol.js',
              'inline-translation-controls.js',
              'full-page-markdown.js',
              'content.js',
            ],
            runAt: 'document_idle',
          }
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'updates registered all-pages content script without duplicate registration',
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
        await helpers.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' });

        assert.deepEqual(
          registered.get('inline-translator-auto-show'),
          {
            id: 'inline-translator-auto-show',
            matches: ['http://*/*', 'https://*/*'],
            js: [
              'default-model.js',
              'inline-block.js',
              'inline-diagnostics-protocol.js',
              'inline-translation-controls.js',
              'full-page-markdown.js',
              'content.js',
            ],
            runAt: 'document_idle',
          }
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'does not throw when all-pages duplicate recovery fails',
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
        await helpers.syncButtonVisibilityRegistration({ buttonVisibility: 'allPages' });
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'safely ignores all-pages registration failures from runtime events',
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
          await helpers.syncButtonVisibilityRegistrationSafely({
            buttonVisibility: 'allPages',
          }),
          false
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'registers the content script across pages for the all-pages choice alone',
    async fn() {
      // Registering it is what lets the button appear without the reader invoking the
      // extension. The other two choices must leave no registration behind, or a reader who
      // moved away from all pages would keep getting the button on every page.
      const previousChrome = global.chrome;

      for (const [visibility, expected] of [
        ['allPages', ['inline-translator-auto-show']],
        ['onInvocation', []],
        ['never', []],
      ]) {
        const registered = new Map([
          ['inline-translator-auto-show', { id: 'inline-translator-auto-show' }],
        ]);

        global.chrome = {
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

        try {
          await helpers.syncButtonVisibilityRegistration({
            buttonVisibility: visibility,
          });
          assert.deepEqual(Array.from(registered.keys()), expected, visibility);
        } finally {
          global.chrome = previousChrome;
        }
      }
    },
  },
  {
    name: 'gives back access to all sites for the two choices that do not need it',
    async fn() {
      // An install migrating off the old checkbox reaches never without the reader opening
      // the options page, so the access the checkbox asked for has to be given back here.
      const previousChrome = global.chrome;
      const removed = [];

      global.chrome = {
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

      try {
        await helpers.syncButtonVisibilityRegistration({ inlineAutoShow: false });
        await helpers.syncButtonVisibilityRegistration({
          buttonVisibility: 'onInvocation',
        });
        assert.deepEqual(removed, [
          ['http://*/*', 'https://*/*'],
          ['http://*/*', 'https://*/*'],
        ]);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'keeps access to all sites for the all-pages choice',
    async fn() {
      const previousChrome = global.chrome;
      let removed = false;

      global.chrome = {
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

      try {
        await helpers.syncButtonVisibilityRegistration({
          buttonVisibility: 'allPages',
        });
        assert.equal(removed, false);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'keeps the content script unregistered without access to all sites',
    async fn() {
      // The choice and the permission can disagree: Chrome lets the reader revoke access
      // from its own UI, which no longer reaches the options page.
      const previousChrome = global.chrome;
      const unregistered = [];

      global.chrome = {
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

      try {
        await helpers.syncButtonVisibilityRegistration({
          buttonVisibility: 'allPages',
        });
        assert.deepEqual(unregistered, ['inline-translator-auto-show']);
      } finally {
        global.chrome = previousChrome;
      }
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
            return createCompletedResponse('번역 결과');
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
                  langHint: 'en',
                  contentMarkdown: 'Hello world.',
                  translationDocument:
                    createPlainTranslationDocument('Hello world.'),
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
            return createCompletedResponse('번역 결과');
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
                  langHint: 'en',
                  contentMarkdown: markdown,
                  translationDocument:
                    createPlainTranslationDocument(markdown),
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
          return createCompletedResponse(JSON.stringify({
            translations: [{ id: record.id, template: record.template }],
          }));
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
          diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
          operationId: 123,
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

        const duplicateResponses = [];
        messageListener({
          type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
          diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
          operationId: 123,
          settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
          diagnostics: [{
            code: 'runtime.block_too_large',
            template: record.template,
            contract: record.contract,
            evidence: { recordCost: 13000, limit: 12000 },
          }],
        }, { tab: { id: 7 } }, (response) => duplicateResponses.push(response));
        for (let index = 0; index < 10 && !duplicateResponses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.deepEqual(duplicateResponses, [{ ok: true }]);
        const localRunId = 'local-7-123-11111111-1111-4111-8111-111111111111';
        assert.equal(stored['inlineDiagnostics:v2:index'].filter((id) => id === localRunId).length, 1);
        assert.equal(Object.keys(stored).filter((key) => key === `inlineDiagnostics:v2:run:${localRunId}`).length, 1);

        const conflictResponses = [];
        messageListener({
          type: 'RECORD_INLINE_LOCAL_DIAGNOSTIC',
          diagnosticBatchId: '11111111-1111-4111-8111-111111111111',
          operationId: 123,
          settingsSnapshot: { model: 'gpt-5.4-mini', targetLanguage: 'Korean' },
          diagnostics: [{
            code: 'runtime.session_too_large',
            evidence: { sessionCost: 60000, limit: 60000 },
          }],
        }, { tab: { id: 7 } }, (response) => conflictResponses.push(response));
        for (let index = 0; index < 10 && !conflictResponses.length; index += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        assert.deepEqual(conflictResponses, [{ ok: false }]);
        assert.equal(stored[`inlineDiagnostics:v2:run:${localRunId}`].blocks[0].terminalCode, 'runtime.block_too_large');
      } finally {
        global.chrome = previousChrome;
        global.fetch = previousFetch;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    // The text-node path outlived its only caller for 62 commits because nothing asserted
    // that a retired name stays retired. Every message the text-node path used is listed
    // here, so reviving one half of it fails loudly instead of sitting in the tree.
    name: 'does not answer any retired text-node translation message',
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
            return createCompletedResponse(JSON.stringify({
              translations: [{ id: 'n1', translation: '안녕하세요.' }],
            }));
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

        const retiredMessages = [
          {
            type: 'TRANSLATE_TEXT_NODES',
            records: [{ id: 'n1', text: 'Hello world.' }],
          },
          {
            type: 'TRANSLATE_VISIBLE_TEXT_BATCH',
            records: [{ id: 'v1', text: 'Hello world.' }],
            settingsSnapshot: null,
          },
          {
            type: 'INLINE_TRANSLATION_PROGRESS',
            operationId: 1,
            progress: { stage: 'queued', recordCount: 1, chunkCount: 1 },
          },
        ];

        for (const message of retiredMessages) {
          const responses = [];
          messageListener(message, {}, (response) => responses.push(response));

          for (let i = 0; i < 10 && responses.length < 1; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 0));
          }

          assert.deepEqual(
            responses,
            [{ ok: false, error: { message: 'Unknown message' } }],
            `${message.type} is answered again`
          );
        }

        assert.equal(fetchCount, 0);
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
          return { ok: true, async json() { return createCompletedResponse('{invalid'); } };
        }
        return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [
            { id: first.id, template: firstTranslation },
            { id: second.id, template: second.template },
          ],
        })); } };
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
        return { ok: true, async json() { return createCompletedResponse(JSON.stringify({
          translations: [{ id: record.id, template: call === 1 ? record.template : '한국어 문장입니다.' }],
        })); } };
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
    name: 'names the model and the batch size in the run a failed request leaves behind',
    async fn() {
      const previousChrome = global.chrome;
      const previousFetch = global.fetch;
      const stored = {};
      const first = createTestPlainBlockRecord('failed-first');
      const second = createTestPlainBlockRecord('failed-second');
      first.template = 'Hello world.';
      second.template = 'Goodbye world.';
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
      global.fetch = async () => { throw new Error('network is down'); };

      try {
        await assert.rejects(
          helpers.translateVisibleBlockBatch([first, second]),
          /network is down/
        );
        const failedRun = Object.values(stored).find((value) => value?.outcome === 'failed');
        assert.ok(failedRun, 'the failed request is written to diagnostics');
        assert.equal(failedRun.model, 'gpt-5.4-mini');
        assert.equal(failedRun.summary.requested, 2);
        assert.equal(failedRun.summary.failed, 2);
      } finally {
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
  {
    name: 'plans the side panel as the first step for both triggers',
    fn() {
      for (const trigger of ['action', 'command']) {
        assert.equal(helpers.planInvocation({ trigger }).steps[0], 'openSidePanel');
      }
    },
  },
  {
    name: 'runs the first plan step before awaiting anything',
    async fn() {
      // ADR-0001. The gesture that authorizes sidePanel.open() is spent by the first
      // await on the path from the listener to the call, so the guard has to be that
      // nothing awaits ahead of it — not merely that the plan lists it first. An await
      // added above the loop in runInvocationPlan fails here and nowhere else in this
      // suite. Deliberately not awaiting the returned promise before asserting.
      let openedSynchronously = false;
      const running = helpers.runInvocationPlan(
        helpers.planInvocation({ trigger: 'action' }),
        1,
        {
          openSidePanel: () => {
            openedSynchronously = true;
          },
          injectContentScripts: () => {},
          grantInlineTranslationAuthorization: () => {},
          mountFloatingTranslateButton: () => {},
        }
      );
      assert.equal(openedSynchronously, true);
      await running;
    },
  },
  {
    name: 'opens the side panel before reasserting its options',
    async fn() {
      // Same constraint one level down: setOptions only restates the manifest default,
      // so awaiting it ahead of open() would spend the gesture for nothing.
      const previousChrome = global.chrome;
      const calls = [];
      global.chrome = {
        sidePanel: {
          async open() {
            calls.push('open');
          },
          async setOptions() {
            calls.push('setOptions');
          },
        },
      };
      try {
        await helpers.ensureSidePanel(11);
        assert.deepEqual(calls, ['open', 'setOptions']);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'injects and authorizes inline translation from both the toolbar action and the command',
    fn() {
      for (const trigger of ['action', 'command']) {
        const { steps } = helpers.planInvocation({ trigger });
        assert.ok(steps.includes('injectContentScripts'));
        assert.ok(steps.includes('grantInlineTranslationAuthorization'));
      }
    },
  },
  {
    name: 'never mounts the Floating Translate Button where the reader chose never',
    fn() {
      // The invocation still injects the content scripts and grants Inline Translation
      // Authorization. Mounting the button is a separate step, which is the whole reason
      // never can be honoured without switching the rest of an invocation off with it.
      for (const trigger of ['action', 'command', 'pageLoad']) {
        assert.equal(
          helpers
            .planInvocation({ trigger, settings: { buttonVisibility: 'never' } })
            .steps.includes('mountFloatingTranslateButton'),
          false
        );
      }
    },
  },
  {
    name: 'mounts the Floating Translate Button on invocation where the reader chose on invocation',
    fn() {
      for (const trigger of ['action', 'command']) {
        assert.ok(
          helpers
            .planInvocation({
              trigger,
              settings: { buttonVisibility: 'onInvocation' },
            })
            .steps.includes('mountFloatingTranslateButton')
        );
      }
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { buttonVisibility: 'onInvocation' },
        }).steps,
        []
      );
    },
  },
  {
    name: 'mounts the Floating Translate Button on page load only where it shows on all pages',
    fn() {
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { buttonVisibility: 'allPages' },
        }).steps,
        ['mountFloatingTranslateButton']
      );
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { buttonVisibility: 'never' },
        }).steps,
        []
      );
      assert.deepEqual(helpers.planInvocation({ trigger: 'pageLoad' }).steps, []);
    },
  },
  {
    name: 'plans an invocation from a migrated install as the old checkbox did',
    fn() {
      assert.ok(
        helpers
          .planInvocation({
            trigger: 'pageLoad',
            settings: { buttonVisibility: 'allPages' },
          })
          .steps.includes('mountFloatingTranslateButton')
      );
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'pageLoad',
          settings: { inlineAutoShow: false },
        }).steps,
        []
      );
    },
  },
  {
    name: 'starts Inline Translation for the shortcut but not the toolbar action',
    fn() {
      // ADR-0004. Reaching the side panel spends nothing, and only the reader who reached
      // for the Inline Translation Shortcut asked for a translation — so the shortcut is
      // still the one invocation that starts one, and what it starts is now the feature
      // the steps above it have just finished preparing the page for.
      const settings = { buttonVisibility: 'onInvocation' };
      assert.deepEqual(
        helpers.planInvocation({ trigger: 'action', settings }).steps,
        [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'mountFloatingTranslateButton',
        ]
      );
      assert.deepEqual(
        helpers.planInvocation({ trigger: 'command', settings }).steps,
        [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'mountFloatingTranslateButton',
          'startInlineTranslation',
        ]
      );
    },
  },
  {
    name: 'starts Inline Translation from the shortcut where the reader chose never',
    fn() {
      // Button Visibility says when the Floating Translate Button may appear, not whether
      // Inline Translation may run. The side panel the shortcut opens carries the same
      // controls, so a run under never still has a home to report from.
      assert.deepEqual(
        helpers.planInvocation({
          trigger: 'command',
          settings: { buttonVisibility: 'never' },
        }).steps,
        [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'startInlineTranslation',
        ]
      );
    },
  },
  {
    name: 'plans no step that starts Side Panel Translation',
    fn() {
      // ADR-0004: the step is removed rather than left unused. The side panel's own
      // Translate button sends TRANSLATE_TAB straight to the worker without an invocation
      // plan, so no plan has a caller to serve — and putting one back would be taking the
      // shortcut away from Inline Translation again.
      //
      // The removed step's name is checked, which catches the plain revert, and so is the
      // property that outlives the name: every step of a plan is either one of the two the
      // worker carries out itself or an instruction the content script understands. A step
      // that translates in the worker is neither, so it cannot come back under any name
      // without failing here.
      const workerSteps = ['openSidePanel', 'injectContentScripts'];
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const trigger of ['action', 'command', 'pageLoad', undefined]) {
        for (const buttonVisibility of ['never', 'onInvocation', 'allPages']) {
          const { steps } = helpers.planInvocation({
            trigger,
            settings: { buttonVisibility },
          });
          assert.equal(steps.includes('startSidePanelTranslation'), false);
          for (const step of steps) {
            assert.ok(
              workerSteps.includes(step) || understood.includes(step),
              `${step} is neither the worker's own step nor one the page can carry out`
            );
          }
        }
      }
    },
  },
  {
    name: 'opens the side panel before reading the settings the rest of the plan needs',
    async fn() {
      // ADR-0001: the panel opens only from inside the click's own task, and Button
      // Visibility can only be read asynchronously. Reading it first would forfeit the
      // gesture — silently, since Chrome simply refuses to open the panel.
      const previousChrome = global.chrome;
      const calls = [];
      let releaseSettings = null;

      global.chrome = {
        storage: {
          local: {
            get() {
              calls.push('readSettings');
              return new Promise((resolve) => {
                releaseSettings = () =>
                  resolve({ settings: { buttonVisibility: 'onInvocation' } });
              });
            },
          },
        },
      };

      try {
        const running = helpers.runInvocation('action', 9, {
          openSidePanel: async (tabId) => calls.push(`openSidePanel:${tabId}`),
          injectContentScripts: async () => calls.push('injectContentScripts'),
          grantInlineTranslationAuthorization: async () =>
            calls.push('grantInlineTranslationAuthorization'),
          mountFloatingTranslateButton: async () =>
            calls.push('mountFloatingTranslateButton'),
        });

        assert.deepEqual(calls, ['openSidePanel:9', 'readSettings']);
        releaseSettings();
        await running;
        assert.deepEqual(calls, [
          'openSidePanel:9',
          'readSettings',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
          'mountFloatingTranslateButton',
        ]);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'opens the side panel exactly once per invocation',
    async fn() {
      // The step is started before the plan runs, so the plan must adopt what is already
      // running rather than open a second panel.
      const previousChrome = global.chrome;
      const calls = [];

      global.chrome = {
        storage: {
          local: {
            async get() {
              return { settings: { buttonVisibility: 'never' } };
            },
          },
        },
      };

      try {
        await helpers.runInvocation('action', 2, {
          openSidePanel: async () => calls.push('openSidePanel'),
          injectContentScripts: async () => calls.push('injectContentScripts'),
          grantInlineTranslationAuthorization: async () =>
            calls.push('grantInlineTranslationAuthorization'),
        });

        assert.deepEqual(calls, [
          'openSidePanel',
          'injectContentScripts',
          'grantInlineTranslationAuthorization',
        ]);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'runs plan steps in order and reports which ran',
    async fn() {
      const calls = [];
      const handlers = {
        openSidePanel: async (tabId) => calls.push(`openSidePanel:${tabId}`),
        injectContentScripts: async (tabId) => calls.push(`injectContentScripts:${tabId}`),
        grantInlineTranslationAuthorization: async (tabId) =>
          calls.push(`grantInlineTranslationAuthorization:${tabId}`),
        mountFloatingTranslateButton: async (tabId) =>
          calls.push(`mountFloatingTranslateButton:${tabId}`),
        startInlineTranslation: async (tabId) => calls.push(`startInlineTranslation:${tabId}`),
      };

      const settings = { buttonVisibility: 'onInvocation' };
      await helpers.runInvocationPlan(
        helpers.planInvocation({ trigger: 'command', settings }),
        7,
        handlers
      );
      assert.deepEqual(calls, [
        'openSidePanel:7',
        'injectContentScripts:7',
        'grantInlineTranslationAuthorization:7',
        'mountFloatingTranslateButton:7',
        'startInlineTranslation:7',
      ]);

      calls.length = 0;
      await helpers.runInvocationPlan(
        helpers.planInvocation({ trigger: 'action', settings }),
        7,
        handlers
      );
      assert.deepEqual(calls, [
        'openSidePanel:7',
        'injectContentScripts:7',
        'grantInlineTranslationAuthorization:7',
        'mountFloatingTranslateButton:7',
      ]);
    },
  },
  {
    name: 'only instructs the content script in steps the content script can carry out',
    fn() {
      // The instruction the worker sends is the plan step's own name, so the two sides
      // share one vocabulary and nothing links them. A rename on either side would fail
      // silently: the content script rejects the instruction, the worker never reads the
      // response, and the plan runner swallows what is left.
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const trigger of ['action', 'command', 'pageLoad']) {
        const instructions = helpers.getInlineInstructions(
          helpers.planInvocation({ trigger, settings: { buttonVisibility: 'allPages' } })
        );
        for (const instruction of instructions) {
          assert.ok(
            understood.includes(instruction),
            `content script cannot run ${instruction}`
          );
        }
      }
      assert.deepEqual(
        helpers.getInlineInstructions(
          helpers.planInvocation({
            trigger: 'action',
            settings: { buttonVisibility: 'onInvocation' },
          })
        ),
        ['grantInlineTranslationAuthorization', 'mountFloatingTranslateButton']
      );
      assert.deepEqual(
        helpers.getInlineInstructions(
          helpers.planInvocation({
            trigger: 'command',
            settings: { buttonVisibility: 'never' },
          })
        ),
        ['grantInlineTranslationAuthorization', 'startInlineTranslation']
      );
    },
  },
  {
    name: 'authorizes Inline Translation ahead of every control in the section',
    fn() {
      // A control in the Inline Translation Section is a deliberate reader gesture through
      // extension-owned UI a page cannot forge, so it grants the authorization rather than
      // requiring one. That is also what keeps a panel left open past the expiry working.
      assert.deepEqual(helpers.planInlineTranslationControl('start').steps, [
        'grantInlineTranslationAuthorization',
        'startInlineTranslation',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('stop').steps, [
        'grantInlineTranslationAuthorization',
        'stopInlineTranslation',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('restore').steps, [
        'grantInlineTranslationAuthorization',
        'restoreInlineOriginal',
      ]);
      assert.deepEqual(helpers.planInlineTranslationControl('translateTab').steps, []);
      assert.deepEqual(helpers.planInlineTranslationControl().steps, []);
    },
  },
  {
    name: 'only asks the content script for section controls it can carry out',
    fn() {
      const understood = Object.keys(
        contentHelpers.getDefaultInlineInstructionHandlers({})
      );
      for (const control of ['start', 'stop', 'restore']) {
        for (const step of helpers.planInlineTranslationControl(control).steps) {
          assert.ok(
            understood.includes(step),
            `content script cannot run ${step}`
          );
        }
      }
    },
  },
  {
    name: 'stops a section control at the first step the tab refuses',
    async fn() {
      // Unlike an invocation, whose steps are independent, a control is one gesture: if
      // the authorization did not land, carrying on would run it unauthorized, and the
      // reader has to be told their click did nothing.
      const sent = [];
      await assert.rejects(
        helpers.runInlineTranslationControl(9, 'start', async (tabId, step) => {
          sent.push(`${step}:${tabId}`);
          throw new Error('Could not establish connection.');
        }),
        /Could not establish connection/
      );
      assert.deepEqual(sent, ['grantInlineTranslationAuthorization:9']);

      await assert.rejects(
        helpers.runInlineTranslationControl(9, 'nonsense', async () => {}),
        /nonsense/
      );
    },
  },
  {
    name: 'treats an instruction the page refused as a failure, not a success',
    async fn() {
      // The content script answers whether it carried the instruction out, and it catches
      // its own throw to do so. A sender that read only the transport would report a
      // gesture the page declined as done, and the panel would render success.
      const previousChrome = global.chrome;
      global.chrome = {
        tabs: {
          async sendMessage() {
            return { ok: false, error: { message: 'no page to authorize' } };
          },
        },
      };
      try {
        await assert.rejects(
          helpers.sendInlineInstruction(5, 'grantInlineTranslationAuthorization'),
          /no page to authorize/
        );
      } finally {
        global.chrome = previousChrome;
      }

      const silentChrome = { tabs: { async sendMessage() {} } };
      global.chrome = silentChrome;
      try {
        await assert.rejects(
          helpers.sendInlineInstruction(5, 'startInlineTranslation'),
          /startInlineTranslation/
        );
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'stops a control at the step the page refuses, before it runs unauthorized',
    async fn() {
      const previousChrome = global.chrome;
      const sent = [];
      global.chrome = {
        tabs: {
          async sendMessage(tabId, message) {
            sent.push(message.instruction);
            return message.instruction === 'grantInlineTranslationAuthorization'
              ? { ok: false, error: { message: 'no page to authorize' } }
              : { ok: true };
          },
        },
      };
      try {
        await assert.rejects(
          helpers.runInlineTranslationControl(5, 'start'),
          /no page to authorize/
        );
        assert.deepEqual(sent, ['grantInlineTranslationAuthorization']);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'tells the reader what to do when no content script answers a control',
    fn() {
      // Chrome's own answer names no action the reader can take, and the action they need
      // is the one the missing-access failure already asks for.
      const missingAccess = helpers.classifyContentScriptFailure(
        new Error('Cannot access contents of the page at url "https://example.com/"'),
        'https://example.com/'
      ).message;

      assert.equal(
        helpers.describeInlineTranslationControlFailure(
          new Error(
            'Could not establish connection. Receiving end does not exist.'
          )
        ),
        missingAccess
      );
      assert.match(
        helpers.describeInlineTranslationControlFailure(
          new Error('Unknown inline translation control: nonsense')
        ),
        /nonsense/
      );
      assert.ok(
        helpers.describeInlineTranslationControlFailure(null).length > 0
      );
    },
  },
  {
    name: 'injects and authorizes without mounting when the plan leaves the button out',
    async fn() {
      // The three concerns are separate steps precisely so a plan can carry the first two
      // alone. Nothing in the extension yet produces such a plan for an invocation, but the
      // runner must honour one when Button Visibility starts suppressing the button.
      const calls = [];
      await helpers.runInvocationPlan(
        { steps: ['injectContentScripts', 'grantInlineTranslationAuthorization'] },
        4,
        {
          injectContentScripts: async () => calls.push('injectContentScripts'),
          grantInlineTranslationAuthorization: async () =>
            calls.push('grantInlineTranslationAuthorization'),
          mountFloatingTranslateButton: async () => calls.push('mountFloatingTranslateButton'),
        }
      );
      assert.deepEqual(calls, [
        'injectContentScripts',
        'grantInlineTranslationAuthorization',
      ]);
    },
  },
  {
    name: 'keeps running later steps when injecting the content scripts fails',
    async fn() {
      // Injection legitimately fails on pages extensions cannot touch, and one refused
      // step must not cost an invocation the rest of them — the plan's steps are
      // independent. On such a page every step that speaks to the content script fails
      // with it, the shortcut's own start step included; the start step is reported to
      // the reader as well, which the tests below cover, but no step's failure — nor the
      // report of it — may stop the steps after it.
      const attempted = [];
      await helpers.runInvocationPlan(
        helpers.planInvocation({
          trigger: 'command',
          settings: { buttonVisibility: 'onInvocation' },
        }),
        3,
        {
          openSidePanel: async () => attempted.push('openSidePanel'),
          injectContentScripts: async () => {
            attempted.push('injectContentScripts');
            throw new Error('Cannot access contents of the page');
          },
          grantInlineTranslationAuthorization: async () => {
            attempted.push('grantInlineTranslationAuthorization');
            throw new Error('Could not establish connection');
          },
          mountFloatingTranslateButton: async () => {
            attempted.push('mountFloatingTranslateButton');
            throw new Error('Could not establish connection');
          },
          startInlineTranslation: async () => {
            attempted.push('startInlineTranslation');
            throw new Error('Could not establish connection');
          },
        }
      );
      assert.deepEqual(attempted, [
        'openSidePanel',
        'injectContentScripts',
        'grantInlineTranslationAuthorization',
        'mountFloatingTranslateButton',
        'startInlineTranslation',
      ]);
    },
  },
  {
    name: 'tells the reader when the shortcut could not start a run, and stays silent otherwise',
    async fn() {
      // The start step is the one the reader pressed for: on a tab out of reach its
      // silence is indistinguishable from a translation about to appear. The steps that
      // prepare the page are not what they pressed, so those stay silent.
      const previousChrome = global.chrome;
      const broadcasts = [];
      global.chrome = createStateBroadcastChrome(broadcasts);

      try {
        await helpers.runInvocationPlan(
          helpers.planInvocation({
            trigger: 'command',
            settings: { buttonVisibility: 'onInvocation' },
          }),
          4201,
          {
            openSidePanel: async () => {},
            injectContentScripts: async () => {
              throw new Error('Cannot access contents of the page');
            },
            grantInlineTranslationAuthorization: async () => {
              throw new Error('Could not establish connection');
            },
            mountFloatingTranslateButton: async () => {
              throw new Error('Could not establish connection');
            },
            startInlineTranslation: async () => {
              throw new Error(
                'Could not establish connection. Receiving end does not exist.'
              );
            },
          }
        );

        assert.equal(broadcasts.length, 1);
        const [update] = broadcasts;
        assert.equal(update.type, 'STATE_UPDATED');
        assert.equal(update.tabId, 4201);
        assert.match(
          update.state.inlineTranslationError.message,
          /Click the extension icon on this tab/
        );
        // Side Panel Translation's error area is not where this belongs.
        assert.equal(update.state.error, undefined);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'clears a reported start failure once a later run on the tab starts',
    async fn() {
      const previousChrome = global.chrome;
      const broadcasts = [];
      global.chrome = createStateBroadcastChrome(broadcasts);

      const plan = { steps: ['startInlineTranslation'] };
      const refusing = {
        startInlineTranslation: async () => {
          throw new Error('Could not establish connection.');
        },
      };
      const accepting = { startInlineTranslation: async () => {} };

      try {
        await helpers.runInvocationPlan(plan, 4202, refusing);
        assert.equal(broadcasts.length, 1);

        await helpers.runInvocationPlan(plan, 4202, accepting);
        assert.equal(broadcasts.length, 2);
        assert.equal(broadcasts[1].state.inlineTranslationError, null);

        // Nothing left to clear, so a run that starts on a tab carrying no failure says
        // nothing at all.
        await helpers.runInvocationPlan(plan, 4202, accepting);
        assert.equal(broadcasts.length, 2);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'withdraws a reported start failure once the tab answers an invocation again',
    async fn() {
      // The message asks for a click on the extension icon. That click is an invocation,
      // and its injection step succeeding is the tab answering it — so the message is
      // withdrawn without waiting for a run the reader has not started yet. On a page no
      // click can grant, injection fails too and the message stands.
      const previousChrome = global.chrome;
      const broadcasts = [];
      global.chrome = createStateBroadcastChrome(broadcasts);

      const grantedByClick = {
        openSidePanel: async () => {},
        injectContentScripts: async () => {},
        grantInlineTranslationAuthorization: async () => {},
      };
      const clickOnAPageChromeKeepsToItself = {
        ...grantedByClick,
        injectContentScripts: async () => {
          throw new Error('Cannot access contents of the page');
        },
      };
      const actionInvocation = helpers.planInvocation({
        trigger: 'action',
        settings: { buttonVisibility: 'never' },
      });
      const refusedStart = {
        startInlineTranslation: async () => {
          throw new Error('Could not establish connection.');
        },
      };

      try {
        await helpers.runInvocationPlan(
          { steps: ['startInlineTranslation'] },
          4204,
          refusedStart
        );
        assert.equal(broadcasts.length, 1);

        await helpers.runInvocationPlan(
          actionInvocation,
          4204,
          clickOnAPageChromeKeepsToItself
        );
        assert.equal(broadcasts.length, 1);

        await helpers.runInvocationPlan(actionInvocation, 4204, grantedByClick);
        assert.equal(broadcasts.length, 2);
        assert.equal(broadcasts[1].state.inlineTranslationError, null);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'clears a reported start failure when a control the reader pressed runs',
    async fn() {
      // The field says Inline Translation could not be reached on this tab. A control the
      // tab has just carried out disproves that, whichever of the three it was, and the
      // reader has one more home for these controls than the shortcut.
      const previousChrome = global.chrome;
      const broadcasts = [];
      global.chrome = createStateBroadcastChrome(broadcasts);

      try {
        await helpers.runInvocationPlan({ steps: ['startInlineTranslation'] }, 4203, {
          startInlineTranslation: async () => {
            throw new Error('Could not establish connection.');
          },
        });
        assert.equal(broadcasts.length, 1);

        await helpers.runInlineTranslationControl(4203, 'start', async () => {});
        assert.equal(broadcasts.length, 2);
        assert.equal(broadcasts[1].state.inlineTranslationError, null);
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'keeps the two translations’ failures in separate fields',
    fn() {
      // CONTEXT.md spends half its vocabulary keeping the two translations apart. An error
      // box that merged them would undo that for the one moment the reader most needs to
      // know which feature is talking.
      const state = helpers.sanitizePublicTabState({
        status: 'error',
        error: { message: 'Side Panel Translation failed', name: 'Error', stack: 'x' },
        inlineTranslationError: {
          message: 'Inline Translation could not start',
          stack: 'x',
        },
      });

      assert.equal(state.error.message, 'Side Panel Translation failed');
      assert.equal(state.error.stack, undefined);
      assert.equal(
        state.inlineTranslationError.message,
        'Inline Translation could not start'
      );
      assert.equal(state.inlineTranslationError.stack, undefined);
    },
  },
  {
    name: 'tells a reader without tab access to click the extension icon',
    fn() {
      // Chrome's wording when neither activeTab nor a host permission covers the tab.
      const classified = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access the respective host.'
        ),
        'https://example.com/article'
      );
      assert.equal(classified.reason, 'missing_access');
      assert.match(classified.message, /extension icon/i);
      assert.doesNotMatch(classified.message, /chrome:\/\//i);
    },
  },
  {
    name: 'tells a reader on a page extensions cannot run on that the page is the problem',
    fn() {
      for (const [failure, url] of [
        [new Error('Cannot access a chrome:// URL'), ''],
        [
          new Error('Cannot access contents of url "chrome://settings/".'),
          '',
        ],
        [new Error('The extensions gallery cannot be scripted.'), ''],
        [
          new Error('Cannot access contents of the page.'),
          'https://chromewebstore.google.com/detail/abc',
        ],
        [new Error('Cannot access contents of the page.'), 'about:blank'],
      ]) {
        const classified = helpers.classifyContentScriptFailure(failure, url);
        assert.equal(
          classified.reason,
          'unsupported_page',
          `expected an unsupported page for: ${failure.message} @ ${url || '(unknown)'}`
        );
        assert.match(classified.message, /this page/i);
      }
    },
  },
  {
    name: 'does not read a refused scheme it has never heard of as missing access',
    fn() {
      // Chrome gives one generic sentence for nearly every page it refuses, so the scheme
      // it names is what separates them. Enumerating the refused schemes would mis-sort
      // every one left off the list; only the grantable shape — an ordinary web page — is
      // enumerable, and these are not it. An SSL interstitial is the everyday case.
      for (const refused of [
        'chrome-error://chromewebdata/',
        'data:text/html,hello',
        'blob:https://example.com/9a1f',
        'devtools://devtools/bundled/devtools_app.html',
      ]) {
        const classified = helpers.classifyContentScriptFailure(
          new Error(
            `Cannot access contents of url "${refused}". Extension manifest must request permission to access this host.`
          ),
          ''
        );
        assert.equal(
          classified.reason,
          'unsupported_page',
          `expected an unsupported page for ${refused}`
        );
      }
    },
  },
  {
    name: 'sends a reader blocked on a local file to the switch that unblocks it',
    fn() {
      // Neither of the two reasons fits: file access is grantable, but not by invoking the
      // extension on the page, so both other messages would send the reader nowhere.
      const classified = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of the page. Extension manifest must request permission to access this host.'
        ),
        'file:///Users/reader/article.html'
      );
      assert.equal(classified.reason, 'file_access');
      assert.match(classified.message, /Allow access to file URLs/i);
    },
  },
  {
    name: 'never blames the page when access is the actual problem',
    fn() {
      // The message this replaces blamed chrome:// pages for every failure, which is what
      // sent the diagnosis behind the parent spec down the wrong path for two symptoms.
      const missingAccess = helpers.classifyContentScriptFailure(
        new Error(
          'Cannot access contents of url "https://example.com/". Extension manifest must request permission to access this host.'
        ),
        'https://example.com/'
      );
      const unsupported = helpers.classifyContentScriptFailure(
        new Error('Cannot access a chrome:// URL'),
        'chrome://settings/'
      );
      assert.equal(missingAccess.reason, 'missing_access');
      assert.equal(unsupported.reason, 'unsupported_page');
      assert.notEqual(missingAccess.message, unsupported.message);
    },
  },
  {
    name: 'reports a failure it cannot classify as itself',
    fn() {
      // Guessing between the two known reasons is how the old message misled. An
      // unrecognised failure says what happened instead of picking one.
      const classified = helpers.classifyContentScriptFailure(
        new Error('Frame with ID 0 is showing error page'),
        'https://example.com/'
      );
      assert.equal(classified.reason, 'unknown');
      assert.match(classified.message, /Frame with ID 0 is showing error page/);

      // The address can be a navigation behind the failure, so it is only ever read once
      // Chrome has said it refused the page. On its own it settles nothing.
      const stale = helpers.classifyContentScriptFailure(
        new Error('The tab was closed.'),
        'about:blank'
      );
      assert.equal(stale.reason, 'unknown');

      const empty = helpers.classifyContentScriptFailure(null, '');
      assert.equal(empty.reason, 'unknown');
      assert.ok(empty.message.length > 0);
      assert.doesNotMatch(empty.message, /\[object Object\]/);
    },
  },
];
