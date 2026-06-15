const assert = require('node:assert/strict');
const helpers = require('../extension/content.js');

exports.name = 'content helpers';
exports.tests = [
  {
    name: 'detects excluded inline code tags',
    fn() {
      assert.equal(helpers.isInlineTranslationExcludedTag('CODE'), true);
      assert.equal(helpers.isInlineTranslationExcludedTag('nav'), true);
      assert.equal(helpers.isInlineTranslationExcludedTag('footer'), true);
      assert.equal(helpers.isInlineTranslationExcludedTag('button'), true);
      assert.equal(helpers.isInlineTranslationExcludedTag('header'), false);
      assert.equal(helpers.isInlineTranslationExcludedTag('aside'), false);
      assert.equal(helpers.isInlineTranslationExcludedTag('p'), false);
    },
  },
  {
    name: 'detects excluded inline page chrome roles',
    fn() {
      const elementWithRole = (role) => ({
        tagName: 'DIV',
        getAttribute(name) {
          return name === 'role' ? role : null;
        },
      });

      assert.equal(
        helpers.isInlineTranslationExcludedElement(
          elementWithRole('navigation')
        ),
        true
      );
      assert.equal(
        helpers.isInlineTranslationExcludedElement(
          elementWithRole('complementary')
        ),
        true
      );
      assert.equal(
        helpers.isInlineTranslationExcludedElement(elementWithRole('main')),
        false
      );
    },
  },
  {
    name: 'formats inline translation progress messages',
    fn() {
      assert.equal(
        helpers.formatInlineProgressMessage({
          stage: 'queued',
          recordCount: 80,
          chunkCount: 5,
        }),
        'Preparing 80 text nodes across 5 chunks...'
      );
      assert.equal(
        helpers.formatInlineProgressMessage({
          stage: 'chunk',
          current: 2,
          total: 5,
          recordCount: 16,
          charCount: 2400,
        }),
        'Chunk 2/5: 16 text nodes, 2400 chars'
      );
      assert.equal(
        helpers.formatInlineProgressMessage({
          stage: 'chunk_done',
          current: 3,
          total: 5,
        }),
        'Completed 3/5 chunks...'
      );
      assert.equal(
        helpers.formatInlineProgressMessage({ stage: 'applying' }),
        'Applying translated text...'
      );
    },
  },
  {
    name: 'detects code-like text conservatively',
    fn() {
      assert.equal(helpers.isCodeLikeInlineText('npm run build'), true);
      assert.equal(helpers.isCodeLikeInlineText('README.md'), true);
      assert.equal(helpers.isCodeLikeInlineText('https://example.com'), true);
      assert.equal(
        helpers.isCodeLikeInlineText(
          'This article explains browser translation.'
        ),
        false
      );
    },
  },
  {
    name: 'accepts readable article text',
    fn() {
      assert.equal(
        helpers.isTranslatableInlineText(
          'OpenAI provides tools for building language applications.'
        ),
        true
      );
      assert.equal(helpers.isTranslatableInlineText('API'), false);
      assert.equal(helpers.isTranslatableInlineText('  '), false);
    },
  },
  {
    name: 'rejects synthetic inline UI events',
    fn() {
      assert.equal(helpers.isTrustedInlineUiEvent({ isTrusted: true }), true);
      assert.equal(helpers.isTrustedInlineUiEvent({ isTrusted: false }), false);
      assert.equal(helpers.isTrustedInlineUiEvent({}), false);
    },
  },
  {
    name: 'resets inline translation state after failures',
    fn() {
      const state = {
        status: 'translating',
        records: [{ id: 'n1', original: 'Hello', translation: null }],
        message: '',
      };

      helpers.resetInlineTranslationAfterFailure(state);

      assert.equal(state.status, 'original');
      assert.deepEqual(state.records, []);
    },
  },
  {
    name: 'reports oversized inline text payloads before messaging',
    fn() {
      assert.match(
        helpers.getInlineTextRecordBudgetError(
          Array.from({ length: 501 }, (_, index) => ({
            id: `n${index + 1}`,
            text: 'Hello world.',
          }))
        ),
        /Too many text nodes/
      );
      assert.match(
        helpers.getInlineTextRecordBudgetError([
          { id: 'n1', text: 'x'.repeat(60001) },
        ]),
        /too much text/
      );
      assert.equal(
        helpers.getInlineTextRecordBudgetError([{ id: 'n1', text: 'Hello.' }]),
        ''
      );
    },
  },
  {
    name: 'requires extension authorization for inline translation',
    fn() {
      const state = { authorizedUntil: 0 };

      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        false
      );

      helpers.authorizeInlineTranslation(state, 1000);

      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        true
      );
      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000 + 5 * 60 * 1000),
        false
      );
    },
  },
  {
    name: 'authorizes inline translation from trusted inline UI events',
    fn() {
      const state = { authorizedUntil: 0 };

      assert.equal(
        helpers.authorizeInlineTranslationFromUiEvent(
          { isTrusted: false },
          state,
          1000
        ),
        false
      );
      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        false
      );

      assert.equal(
        helpers.authorizeInlineTranslationFromUiEvent(
          { isTrusted: true },
          state,
          1000
        ),
        true
      );
      assert.equal(
        helpers.hasInlineTranslationAuthorization(state, 1000),
        true
      );
    },
  },
  {
    name: 'detects masked settings API key for inline preflight',
    fn() {
      assert.equal(helpers.hasInlineSettingsApiKey({ apiKey: '***' }), true);
      assert.equal(helpers.hasInlineSettingsApiKey({ apiKey: '' }), false);
      assert.equal(helpers.hasInlineSettingsApiKey({}), false);
      assert.equal(helpers.hasInlineSettingsApiKey(null), false);
    },
  },
  {
    name: 'loads inline auto-show through masked runtime settings',
    async fn() {
      let message = null;
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            message = value;
            return { ok: true, settings: { inlineAutoShow: true, apiKey: '***' } };
          },
        },
        storage: {
          local: {
            async get() {
              throw new Error('content script must not read raw settings');
            },
          },
        },
      };

      assert.equal(await helpers.getInlineAutoShowEnabled(fakeChrome), true);
      assert.deepEqual(message, { type: 'GET_SETTINGS' });
    },
  },
  {
    name: 'loads inline menu target language through masked runtime settings',
    async fn() {
      const messages = [];
      const state = { status: 'original', menuOpen: true, message: '' };
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            messages.push(value);
            return {
              ok: true,
              settings: {
                targetLanguage: 'Japanese',
                tone: 'technical',
                model: 'gpt-5.4-mini',
                apiKey: '***',
              },
            };
          },
        },
      };

      const snapshot = await helpers.refreshInlineTranslatorSettings(
        fakeChrome,
        state
      );

      assert.deepEqual(messages, [{ type: 'GET_SETTINGS' }]);
      assert.equal(snapshot.targetLanguage, 'Japanese');
      assert.equal(
        helpers.getInlineTranslatorUiModel(state).translateText,
        'Page in Japanese'
      );
    },
  },
  {
    name: 'does not overwrite text nodes changed during translation',
    fn() {
      const stableNode = { isConnected: true, nodeValue: 'Hello world.' };
      const changedNode = { isConnected: true, nodeValue: 'Updated article.' };
      const disconnectedNode = { isConnected: false, nodeValue: 'Detached.' };
      const result = helpers.applyInlineTranslationRecords([
        {
          id: 'n1',
          node: stableNode,
          original: 'Hello world.',
          translation: 'Hello translated.',
        },
        {
          id: 'n2',
          node: changedNode,
          original: 'Read the article.',
          translation: 'Read translated.',
        },
        {
          id: 'n3',
          node: disconnectedNode,
          original: 'Detached.',
          translation: 'Detached translated.',
        },
      ]);

      assert.equal(stableNode.nodeValue, 'Hello translated.');
      assert.equal(changedNode.nodeValue, 'Updated article.');
      assert.equal(disconnectedNode.nodeValue, 'Detached.');
      assert.deepEqual(
        result.applied.map((record) => record.id),
        ['n1']
      );
      assert.equal(result.skipped, 1);
    },
  },
  {
    name: 'requires closed shadow UI isolation',
    fn() {
      assert.equal(helpers.getInlineShadowMode(), 'closed');
      assert.match(helpers.getInlineHostStyleText(), /all: initial !important/);
      assert.match(
        helpers.getInlineHostStyleText(),
        /position: fixed !important/
      );
      assert.match(
        helpers.getInlineHostStyleText(),
        /pointer-events: auto !important/
      );
    },
  },
  {
    name: 'invalidates stale inline translation operations',
    fn() {
      const state = {
        status: 'original',
        records: [],
        operationId: 0,
      };

      const first = helpers.beginInlineTranslationOperation(state, [
        { id: 'n1', node: null, text: 'First text.' },
      ]);
      const second = helpers.beginInlineTranslationOperation(state, [
        { id: 'n1', node: null, text: 'Second text.' },
      ]);

      assert.equal(helpers.isCurrentInlineOperation(state, first.operationId), false);
      assert.equal(helpers.isCurrentInlineOperation(state, second.operationId), true);

      helpers.cancelInlineTranslationOperation(state, second.operationId);

      assert.equal(state.status, 'original');
      assert.deepEqual(state.records, []);
      assert.equal(helpers.isCurrentInlineOperation(state, second.operationId), false);
    },
  },
  {
    name: 'detects text rects inside viewport with prefetch margin',
    fn() {
      const viewport = { width: 1000, height: 800 };

      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 100, bottom: 140, left: 10, right: 700 },
          viewport
        ),
        true
      );
      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 1000, bottom: 1040, left: 10, right: 700 },
          viewport
        ),
        true
      );
      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 1300, bottom: 1340, left: 10, right: 700 },
          viewport
        ),
        false
      );
      assert.equal(
        helpers.isInlineRectInViewport(
          { top: 100, bottom: 140, left: 1100, right: 1200 },
          viewport
        ),
        false
      );
    },
  },
  {
    name: 'collects visible inline text nodes into viewport queue',
    fn() {
      const previous = {
        document: global.document,
        HTMLElement: global.HTMLElement,
        NodeFilter: global.NodeFilter,
        window: global.window,
      };

      class FakeElement {
        constructor(rect) {
          this.rect = rect;
          this.tagName = 'P';
          this.hidden = false;
          this.parentElement = null;
        }

        closest() {
          return null;
        }

        getAttribute() {
          return null;
        }

        getBoundingClientRect() {
          return this.rect;
        }
      }

      const visibleNode = {
        nodeValue: 'Visible article text.',
        parentElement: new FakeElement({
          top: 20,
          bottom: 44,
          left: 10,
          right: 300,
          width: 290,
          height: 24,
        }),
      };
      const belowViewportNode = {
        nodeValue: 'Below article text.',
        parentElement: new FakeElement({
          top: 1000,
          bottom: 1024,
          left: 10,
          right: 300,
          width: 290,
          height: 24,
        }),
      };

      global.HTMLElement = FakeElement;
      global.NodeFilter = {
        SHOW_TEXT: 4,
        FILTER_ACCEPT: 1,
        FILTER_REJECT: 2,
      };
      global.window = {
        innerWidth: 500,
        innerHeight: 300,
        getComputedStyle() {
          return {
            display: 'block',
            visibility: 'visible',
            opacity: '1',
          };
        },
      };
      global.document = {
        documentElement: {
          clientWidth: 0,
          clientHeight: 0,
        },
        createRange() {
          throw new Error('range unavailable');
        },
        createTreeWalker(root, _show, filter) {
          const accepted = root.nodes.filter(
            (node) => filter.acceptNode(node) === global.NodeFilter.FILTER_ACCEPT
          );
          let index = -1;
          return {
            currentNode: null,
            nextNode() {
              index += 1;
              this.currentNode = accepted[index] || null;
              return Boolean(this.currentNode);
            },
          };
        },
      };

      try {
        const store = helpers.createInlineViewportStore(17);
        const queued = helpers.collectVisibleInlineTextNodes(
          { nodes: [visibleNode, belowViewportNode] },
          store
        );

        assert.deepEqual(
          queued.map((record) => record.id),
          ['v1']
        );
        assert.equal(queued[0].original, 'Visible article text.');
        assert.equal(store.queue.length, 1);
      } finally {
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.NodeFilter = previous.NodeFilter;
        global.window = previous.window;
      }
    },
  },
  {
    name: 'queues each visible text node once per active operation',
    fn() {
      const store = helpers.createInlineViewportStore(7);
      const node = { isConnected: true, nodeValue: 'Visible article text.' };

      const first = helpers.queueInlineViewportRecord(
        store,
        node,
        'Visible article text.'
      );
      const second = helpers.queueInlineViewportRecord(
        store,
        node,
        'Visible article text.'
      );

      assert.equal(first.id, 'v1');
      assert.equal(first.state, 'queued');
      assert.equal(first.operationId, 7);
      assert.equal(second, null);
      assert.deepEqual(
        store.queue.map((record) => record.id),
        ['v1']
      );
    },
  },
  {
    name: 'reapplies cached viewport translation to rerendered original text',
    fn() {
      const store = helpers.createInlineViewportStore(7);
      const firstNode = { isConnected: true, nodeValue: 'Hello world.' };

      helpers.queueInlineViewportRecord(store, firstNode, 'Hello world.');
      const batch = helpers.takeInlineViewportBatch(store);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: batch[0].id, translation: '안녕하세요.' }],
        7,
        store
      );

      const rerenderedNode = { isConnected: true, nodeValue: 'Hello world.' };
      const queued = helpers.queueInlineViewportRecord(
        store,
        rerenderedNode,
        'Hello world.'
      );

      assert.equal(queued, null);
      assert.equal(rerenderedNode.nodeValue, '안녕하세요.');
      assert.equal(store.queue.length, 0);
      assert.equal(store.records.length, 2);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 2,
        pending: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'separates page translation cache by inline settings',
    fn() {
      const state = { translationCacheBySettings: new Map() };
      const baseSettings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
        apiKey: 'secret-one',
      };
      const sameTranslationSettings = {
        ...baseSettings,
        apiKey: 'secret-two',
      };
      const noApiKeySettings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      };
      const differentTargetLanguageSettings = {
        ...baseSettings,
        targetLanguage: 'Japanese',
      };
      const differentToneSettings = {
        ...baseSettings,
        tone: 'natural',
      };
      const differentModelSettings = {
        ...baseSettings,
        model: 'gpt-5.4',
      };
      const differentReasoningEffortSettings = {
        ...baseSettings,
        reasoningEffort: 'low',
      };

      const firstCache = helpers.getInlineTranslationCacheBucket(
        state,
        baseSettings
      );
      firstCache.set('Hello world.', {
        original: 'Hello world.',
        translation: '안녕하세요.',
      });

      assert.equal(
        helpers.getInlineTranslationCacheBucket(state, sameTranslationSettings),
        firstCache
      );
      assert.equal(
        helpers.getInlineTranslationCacheBucket(state, noApiKeySettings),
        firstCache
      );
      const japaneseCache = helpers.getInlineTranslationCacheBucket(
        state,
        differentTargetLanguageSettings
      );
      assert.notEqual(japaneseCache, firstCache);
      assert.equal(
        helpers.getInlineTranslationCacheBucket(
          state,
          differentTargetLanguageSettings
        ),
        japaneseCache
      );

      const naturalCache = helpers.getInlineTranslationCacheBucket(
        state,
        differentToneSettings
      );
      assert.notEqual(naturalCache, firstCache);
      assert.equal(
        helpers.getInlineTranslationCacheBucket(state, differentToneSettings),
        naturalCache
      );

      const gpt54Cache = helpers.getInlineTranslationCacheBucket(
        state,
        differentModelSettings
      );
      assert.notEqual(gpt54Cache, firstCache);
      assert.equal(
        helpers.getInlineTranslationCacheBucket(state, differentModelSettings),
        gpt54Cache
      );

      const lowReasoningCache = helpers.getInlineTranslationCacheBucket(
        state,
        differentReasoningEffortSettings
      );
      assert.notEqual(lowReasoningCache, firstCache);
      assert.equal(
        helpers.getInlineTranslationCacheBucket(
          state,
          differentReasoningEffortSettings
        ),
        lowReasoningCache
      );
      assert.equal(
        new Set([
          firstCache,
          japaneseCache,
          naturalCache,
          gpt54Cache,
          lowReasoningCache,
        ]).size,
        5
      );
    },
  },
  {
    name: 'builds inline translation settings snapshot without api key',
    fn() {
      assert.deepEqual(
        helpers.createInlineTranslationSettingsSnapshot({
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
          apiKey: 'sk-secret',
          viewMode: 'bilingual',
          chunkMaxChars: 24000,
        }),
        {
          targetLanguage: 'Japanese',
          tone: 'natural',
          model: 'gpt-5.4',
          reasoningEffort: 'low',
        }
      );
      assert.deepEqual(helpers.createInlineTranslationSettingsSnapshot({}), {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      });
    },
  },
  {
    name: 'reapplies cached translation when same text node reverts to original',
    fn() {
      const store = helpers.createInlineViewportStore(7);
      const node = { isConnected: true, nodeValue: 'Hello world.' };

      helpers.queueInlineViewportRecord(store, node, 'Hello world.');
      const batch = helpers.takeInlineViewportBatch(store);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: batch[0].id, translation: '안녕하세요.' }],
        7,
        store
      );

      node.nodeValue = 'Hello world.';
      const queued = helpers.queueInlineViewportRecord(
        store,
        node,
        'Hello world.'
      );

      assert.equal(queued, null);
      assert.equal(node.nodeValue, '안녕하세요.');
      assert.equal(store.queue.length, 0);
      assert.equal(store.records.length, 1);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 1,
        pending: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'stopping viewport translation invalidates operation without restoring text',
    fn() {
      const store = helpers.createInlineViewportStore(4);
      const node = { isConnected: true, nodeValue: '안녕하세요.' };
      store.queue.push({ id: 'v2', state: 'queued', operationId: 4 });
      store.records.push({
        id: 'v1',
        node,
        original: 'Hello world.',
        translation: '안녕하세요.',
        state: 'translated',
        operationId: 4,
      });
      const state = {
        status: 'active',
        operationId: 4,
        viewport: store,
        records: store.records,
      };

      const nextOperationId = helpers.stopInlineViewportTranslation(state);

      assert.equal(nextOperationId, 5);
      assert.equal(state.operationId, 5);
      assert.equal(state.status, 'stopped');
      assert.equal(store.stopped, true);
      assert.deepEqual(store.queue, []);
      assert.equal(node.nodeValue, '안녕하세요.');
      assert.equal(state.records, store.records);
    },
  },
  {
    name: 'restores stopped-session translations after viewport restart',
    fn() {
      const firstStore = helpers.createInlineViewportStore(4);
      const firstNode = { isConnected: true, nodeValue: '안녕하세요.' };
      firstStore.records.push({
        id: 'v1',
        node: firstNode,
        original: 'Hello world.',
        translation: '안녕하세요.',
        state: 'translated',
        operationId: 4,
      });
      const state = {
        status: 'active',
        operationId: 4,
        viewport: firstStore,
        records: firstStore.records,
        restorableRecords: [],
      };

      helpers.stopInlineViewportTranslation(state);

      const secondStore = helpers.createInlineViewportStore(6);
      const secondNode = { isConnected: true, nodeValue: '두 번째입니다.' };
      secondStore.records.push({
        id: 'v1',
        node: secondNode,
        original: 'Second visible text.',
        translation: '두 번째입니다.',
        state: 'translated',
        operationId: 6,
      });
      state.status = 'active';
      state.operationId = 6;
      state.viewport = secondStore;
      state.records = secondStore.records;

      helpers.restoreInlineViewportRecords(state);

      assert.equal(firstNode.nodeValue, 'Hello world.');
      assert.equal(secondNode.nodeValue, 'Second visible text.');
      assert.deepEqual(state.restorableRecords, []);
      assert.equal(state.status, 'original');
    },
  },
  {
    name: 'does not requeue stopped-session translated nodes after restart',
    fn() {
      const firstStore = helpers.createInlineViewportStore(4);
      const node = {
        isConnected: true,
        nodeValue: '번역된 OpenAI API 문장입니다.',
      };
      firstStore.records.push({
        id: 'v1',
        node,
        original: 'This is an OpenAI API sentence.',
        translation: '번역된 OpenAI API 문장입니다.',
        state: 'translated',
        operationId: 4,
      });
      const state = {
        status: 'active',
        operationId: 4,
        viewport: firstStore,
        records: firstStore.records,
        restorableRecords: [],
      };

      helpers.stopInlineViewportTranslation(state);
      const secondStore = helpers.createInlineViewportStore(6);
      helpers.seedInlineViewportStoreWithRestorableRecords(
        secondStore,
        state.restorableRecords
      );

      const queued = helpers.queueInlineViewportRecord(
        secondStore,
        node,
        node.nodeValue
      );

      assert.equal(queued, null);
      assert.equal(secondStore.queue.length, 0);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(secondStore.records), {
        translated: 1,
        pending: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'does not requeue stopped-session translated nodes after matching settings restart',
    fn() {
      const settings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
        apiKey: 'sk-korean',
      };
      const signature = helpers.getInlineTranslationCacheSignature(settings);
      const state = {
        status: 'active',
        operationId: 4,
        records: [],
        restorableRecords: [],
        translationCacheBySettings: new Map(),
      };
      const firstCache = helpers.activateInlineTranslationCacheBucket(
        state,
        settings
      );
      const firstStore = helpers.createInlineViewportStore(
        4,
        firstCache,
        settings
      );
      const node = {
        isConnected: true,
        nodeValue: 'This is an OpenAI API sentence.',
      };

      assert.equal(firstStore.translationSettingsSignature, signature);

      const firstRecord = helpers.queueInlineViewportRecord(
        firstStore,
        node,
        node.nodeValue
      );
      const batch = helpers.takeInlineViewportBatch(firstStore);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: firstRecord.id, translation: '번역된 OpenAI API 문장입니다.' }],
        4,
        firstStore
      );
      state.viewport = firstStore;
      state.records = firstStore.records;

      assert.equal(firstRecord.translationSettingsSignature, signature);

      helpers.stopInlineViewportTranslation(state);
      const secondCache = helpers.getInlineTranslationCacheBucket(
        state,
        settings
      );
      const secondStore = helpers.createInlineViewportStore(
        6,
        secondCache,
        settings
      );
      helpers.seedInlineViewportStoreWithRestorableRecords(
        secondStore,
        state.restorableRecords
      );

      const queued = helpers.queueInlineViewportRecord(
        secondStore,
        node,
        node.nodeValue
      );

      assert.equal(queued, null);
      assert.equal(secondCache, firstCache);
      assert.equal(secondCache.has('This is an OpenAI API sentence.'), true);
      assert.equal(secondStore.queue.length, 0);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(secondStore.records), {
        translated: 1,
        pending: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'restores stopped-session translated nodes when settings change',
    fn() {
      const original = 'This is an OpenAI API sentence.';
      const koreanTranslation = '번역된 OpenAI API 문장입니다.';
      const koreanSettings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
        apiKey: 'sk-korean',
      };
      const japaneseSettings = {
        ...koreanSettings,
        targetLanguage: 'Japanese',
        apiKey: 'sk-japanese',
      };
      const koreanSignature =
        helpers.getInlineTranslationCacheSignature(koreanSettings);
      const japaneseSignature =
        helpers.getInlineTranslationCacheSignature(japaneseSettings);
      const state = {
        status: 'active',
        operationId: 4,
        records: [],
        restorableRecords: [],
        translationCacheBySettings: new Map(),
      };
      const koreanCache = helpers.getInlineTranslationCacheBucket(
        state,
        koreanSettings
      );
      const japaneseCache = helpers.getInlineTranslationCacheBucket(
        state,
        japaneseSettings
      );
      const firstStore = helpers.createInlineViewportStore(
        4,
        koreanCache,
        koreanSettings
      );
      const node = { isConnected: true, nodeValue: original };

      assert.notEqual(koreanSignature, japaneseSignature);
      assert.notEqual(koreanCache, japaneseCache);
      assert.equal(firstStore.translationSettingsSignature, koreanSignature);

      const firstRecord = helpers.queueInlineViewportRecord(
        firstStore,
        node,
        original
      );
      const batch = helpers.takeInlineViewportBatch(firstStore);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: firstRecord.id, translation: koreanTranslation }],
        4,
        firstStore
      );
      assert.equal(firstRecord.translationSettingsSignature, koreanSignature);
      state.viewport = firstStore;
      state.records = firstStore.records;

      helpers.stopInlineViewportTranslation(state);
      assert.equal(
        state.restorableRecords[0]?.translationSettingsSignature,
        koreanSignature
      );
      const secondStore = helpers.createInlineViewportStore(
        6,
        japaneseCache,
        japaneseSettings
      );
      assert.equal(secondStore.translationSettingsSignature, japaneseSignature);
      helpers.seedInlineViewportStoreWithRestorableRecords(
        secondStore,
        state.restorableRecords
      );

      assert.equal(node.nodeValue, original);
      assert.equal(firstRecord.state, 'original');
      assert.equal(secondStore.records.length, 0);
      assert.deepEqual(
        helpers.getInlineViewportStatusCounts(secondStore.records),
        {
          translated: 0,
          pending: 0,
          failed: 0,
        }
      );
      assert.equal(japaneseCache.has(original), false);

      const queued = helpers.queueInlineViewportRecord(
        secondStore,
        node,
        original
      );

      assert.equal(queued?.state, 'queued');
      assert.equal(queued?.translation, null);
      assert.equal(secondStore.queue.length, 1);
      assert.equal(node.nodeValue, original);
    },
  },
  {
    name: 'rejects stale viewport operation after stop or replacement',
    fn() {
      const store = helpers.createInlineViewportStore(9);
      const state = {
        status: 'active',
        operationId: 9,
        viewport: store,
      };

      assert.equal(
        helpers.isInlineViewportOperationCurrent(state, store, 9),
        true
      );

      store.stopped = true;
      assert.equal(
        helpers.isInlineViewportOperationCurrent(state, store, 9),
        false
      );

      store.stopped = false;
      state.viewport = helpers.createInlineViewportStore(10);
      state.operationId = 10;
      assert.equal(
        helpers.isInlineViewportOperationCurrent(state, store, 9),
        false
      );
    },
  },
  {
    name: 'allows restarting from stopped active viewport state',
    fn() {
      const stoppedStore = helpers.createInlineViewportStore(2);
      stoppedStore.stopped = true;

      assert.equal(
        helpers.canRestartInlineViewportTranslation({
          status: 'stopped',
          viewport: stoppedStore,
        }),
        true
      );
      assert.equal(
        helpers.canRestartInlineViewportTranslation({
          status: 'active',
          viewport: stoppedStore,
        }),
        true
      );
      assert.equal(
        helpers.canRestartInlineViewportTranslation({
          status: 'active',
          viewport: helpers.createInlineViewportStore(2),
        }),
        false
      );
    },
  },
  {
    name: 'moves queued viewport records into character-budget batches',
    fn() {
      const store = helpers.createInlineViewportStore(3);
      const records = [
        helpers.queueInlineViewportRecord(store, { nodeValue: 'a', isConnected: true }, 'alpha beta gamma'),
        helpers.queueInlineViewportRecord(store, { nodeValue: 'b', isConnected: true }, 'delta epsilon zeta'),
        helpers.queueInlineViewportRecord(store, { nodeValue: 'c', isConnected: true }, 'eta theta iota'),
      ];

      const batch = helpers.takeInlineViewportBatch(store, 36);

      assert.deepEqual(
        batch.map((record) => record.id),
        ['v1']
      );
      assert.equal(records[0].state, 'translating');
      assert.equal(store.queue.length, 2);
    },
  },
  {
    name: 'does not send oversized viewport records rejected by background',
    fn() {
      const store = helpers.createInlineViewportStore(3);
      const oversized = helpers.queueInlineViewportRecord(
        store,
        { nodeValue: 'x'.repeat(2001), isConnected: true },
        'x'.repeat(2001)
      );
      const small = helpers.queueInlineViewportRecord(
        store,
        { nodeValue: 'Hello world.', isConnected: true },
        'Hello world.'
      );

      const batch = helpers.takeInlineViewportBatch(store, 2000);

      assert.deepEqual(
        batch.map((record) => record.id),
        [small.id]
      );
      assert.equal(oversized.state, 'failed');
      assert.equal(small.state, 'translating');
      assert.equal(store.queue.length, 0);
      assert.equal(store.inFlight, 1);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        pending: 1,
        failed: 1,
      });
    },
  },
  {
    name: 'applies successful viewport translations and marks stale nodes',
    fn() {
      const stableNode = { isConnected: true, nodeValue: 'Hello world.' };
      const changedNode = { isConnected: true, nodeValue: 'Updated text.' };
      const detachedNode = { isConnected: false, nodeValue: 'Detached text.' };
      const records = [
        {
          id: 'v1',
          node: stableNode,
          original: 'Hello world.',
          translation: null,
          state: 'translating',
          operationId: 11,
        },
        {
          id: 'v2',
          node: changedNode,
          original: 'Original text.',
          translation: null,
          state: 'translating',
          operationId: 11,
        },
        {
          id: 'v3',
          node: detachedNode,
          original: 'Detached text.',
          translation: null,
          state: 'translating',
          operationId: 11,
        },
      ];

      const result = helpers.applyInlineViewportBatchTranslations(
        records,
        [
          { id: 'v1', translation: '안녕하세요.' },
          { id: 'v2', translation: '원문입니다.' },
          { id: 'v3', translation: '분리됨.' },
        ],
        11
      );

      assert.equal(stableNode.nodeValue, '안녕하세요.');
      assert.equal(changedNode.nodeValue, 'Updated text.');
      assert.equal(detachedNode.nodeValue, 'Detached text.');
      assert.deepEqual(result, { applied: 1, stale: 2, ignored: 0 });
      assert.equal(records[0].state, 'translated');
      assert.equal(records[1].state, 'stale');
      assert.equal(records[2].state, 'stale');
    },
  },
  {
    name: 'ignores late viewport translations from stale operations',
    fn() {
      const node = { isConnected: true, nodeValue: 'Hello world.' };
      const records = [
        {
          id: 'v1',
          node,
          original: 'Hello world.',
          translation: null,
          state: 'translating',
          operationId: 4,
        },
      ];

      const result = helpers.applyInlineViewportBatchTranslations(
        records,
        [{ id: 'v1', translation: '안녕하세요.' }],
        5
      );

      assert.deepEqual(result, { applied: 0, stale: 0, ignored: 1 });
      assert.equal(node.nodeValue, 'Hello world.');
      assert.equal(records[0].state, 'translating');
    },
  },
  {
    name: 'marks only current translating viewport records as failed',
    fn() {
      const records = [
        { id: 'v1', state: 'translating', operationId: 12 },
        { id: 'v2', state: 'queued', operationId: 12 },
        { id: 'v3', state: 'translated', operationId: 12 },
        { id: 'v4', state: 'translating', operationId: 11 },
        { id: 'v5', state: 'failed', operationId: 12 },
        { id: 'v6', state: 'stale', operationId: 12 },
      ];

      helpers.markInlineViewportBatchFailed(records, 12);

      assert.deepEqual(
        records.map((record) => record.state),
        ['failed', 'queued', 'translated', 'translating', 'failed', 'stale']
      );
    },
  },
  {
    name: 'counts translated pending and failed viewport records',
    fn() {
      const counts = helpers.getInlineViewportStatusCounts([
        { state: 'translated' },
        { state: 'queued' },
        { state: 'translating' },
        { state: 'failed' },
        { state: 'stale' },
        { state: 'original' },
      ]);

      assert.deepEqual(counts, {
        translated: 1,
        pending: 2,
        failed: 2,
      });
    },
  },
  {
    name: 'formats viewport active status counts',
    fn() {
      const message = helpers.formatInlineViewportStatusMessage({
        translated: 18,
        pending: 4,
        failed: 1,
      });

      assert.equal(
        message,
        'Visible translation on\nTranslated 18 · Pending 4 · Failed 1'
      );
    },
  },
  {
    name: 'builds inline menu model from status and target language',
    fn() {
      assert.deepEqual(
        helpers.getInlineTranslatorUiModel(
          { status: 'original', menuOpen: true, message: '' },
          { targetLanguage: 'Japanese' }
        ),
        {
          toggleText: 'Translate',
          menuOpen: true,
          message: '',
          translateText: 'Page in Japanese',
          stopDisabled: true,
          restoreDisabled: true,
          translateDisabled: false,
          expanded: 'true',
        }
      );

      assert.deepEqual(
        helpers.getInlineTranslatorUiModel(
          { status: 'active', menuOpen: false, message: 'Visible translation on' },
          { targetLanguage: 'Korean' }
        ),
        {
          toggleText: 'Translated',
          menuOpen: false,
          message: 'Visible translation on',
          translateText: 'Scan visible text',
          stopDisabled: false,
          restoreDisabled: false,
          translateDisabled: false,
          expanded: 'false',
        }
      );
    },
  },
  {
    name: 'keeps inline menu target language after restoring original text',
    fn() {
      const previousWindow = global.window;
      global.window = { removeEventListener() {} };

      try {
        const state = globalThis.__chromeAiTranslatorInlineState;
        Object.assign(state, {
          status: 'active',
          records: [],
          restorableRecords: [],
          message: 'Visible translation on',
          operationId: 7,
          translationSettings: {
            targetLanguage: 'Japanese',
            tone: 'technical',
            model: 'gpt-5.4-mini',
            reasoningEffort: 'none',
          },
          translationCache: new Map(),
          viewport: helpers.createInlineViewportStore(7),
        });

        helpers.restoreInlineOriginal();

        assert.equal(state.status, 'original');
        assert.equal(
          helpers.getInlineTranslatorUiModel(state).translateText,
          'Page in Japanese'
        );
      } finally {
        if (previousWindow === undefined) delete global.window;
        else global.window = previousWindow;
      }
    },
  },
  {
    name: 'refreshes inline menu target language when opening menu',
    async fn() {
      const messages = [];
      const state = {
        status: 'original',
        menuOpen: false,
        message: '',
        translationSettings: {
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        },
      };
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            messages.push(value);
            return {
              ok: true,
              settings: {
                targetLanguage: 'Japanese',
                tone: 'technical',
                model: 'gpt-5.4-mini',
                apiKey: '***',
              },
            };
          },
        },
      };

      await helpers.toggleInlineTranslatorMenu(fakeChrome, state);

      assert.equal(state.menuOpen, true);
      assert.deepEqual(messages, [{ type: 'GET_SETTINGS' }]);
      assert.equal(
        helpers.getInlineTranslatorUiModel(state).translateText,
        'Page in Japanese'
      );
    },
  },
  {
    name: 'opens inline menu before target language refresh completes',
    async fn() {
      let resolveSettings;
      const state = {
        status: 'original',
        menuOpen: false,
        message: '',
        translationSettings: {
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        },
      };
      const updates = [];
      const fakeChrome = {
        runtime: {
          async sendMessage() {
            return new Promise((resolve) => {
              resolveSettings = resolve;
            });
          },
        },
      };

      const toggle = helpers.toggleInlineTranslatorMenu(
        fakeChrome,
        state,
        () => updates.push(helpers.getInlineTranslatorUiModel(state))
      );

      assert.equal(state.menuOpen, true);
      assert.equal(updates.length, 1);
      assert.equal(updates[0].menuOpen, true);
      assert.equal(updates[0].translateText, 'Page in Korean');

      resolveSettings({
        ok: true,
        settings: {
          targetLanguage: 'Japanese',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          apiKey: '***',
        },
      });
      await toggle;

      assert.equal(updates.length, 2);
      assert.equal(updates[1].translateText, 'Page in Japanese');
    },
  },
  {
    name: 'formats stopped viewport status without pending work',
    fn() {
      const message = helpers.formatInlineViewportStatusMessage(
        {
          translated: 3,
          pending: 2,
          failed: 1,
        },
        'stopped'
      );

      assert.equal(
        message,
        'Visible translation stopped\nTranslated 3 · Pending 0 · Failed 1'
      );
    },
  },
  {
    name: 'restores translated viewport records and invalidates operation',
    fn() {
      const state = {
        status: 'active',
        operationId: 8,
        viewport: helpers.createInlineViewportStore(8),
      };
      const node = { isConnected: true, nodeValue: '안녕하세요.' };
      const record = {
        id: 'v1',
        node,
        original: 'Hello world.',
        translation: '안녕하세요.',
        state: 'translated',
        operationId: 8,
      };
      state.viewport.records.push(record);

      helpers.restoreInlineViewportRecords(state);

      assert.equal(node.nodeValue, 'Hello world.');
      assert.equal(state.status, 'original');
      assert.equal(state.operationId, 9);
      assert.equal(record.state, 'original');
    },
  },
  {
    name: 'restores cached viewport translations applied to rerendered nodes',
    fn() {
      const store = helpers.createInlineViewportStore(8);
      const firstNode = { isConnected: true, nodeValue: 'Hello world.' };

      helpers.queueInlineViewportRecord(store, firstNode, 'Hello world.');
      const batch = helpers.takeInlineViewportBatch(store);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: batch[0].id, translation: '안녕하세요.' }],
        8,
        store
      );

      const rerenderedNode = { isConnected: true, nodeValue: 'Hello world.' };
      const queued = helpers.queueInlineViewportRecord(
        store,
        rerenderedNode,
        'Hello world.'
      );

      assert.equal(queued, null);
      assert.equal(rerenderedNode.nodeValue, '안녕하세요.');
      assert.equal(store.records.length, 2);

      const state = {
        status: 'active',
        operationId: 8,
        viewport: store,
        records: store.records,
        restorableRecords: [],
      };
      const [firstRecord, rerenderedRecord] = store.records;

      helpers.restoreInlineViewportRecords(state);

      assert.equal(firstNode.nodeValue, 'Hello world.');
      assert.equal(rerenderedNode.nodeValue, 'Hello world.');
      assert.equal(state.status, 'original');
      assert.equal(state.operationId, 9);
      assert.equal(firstRecord.state, 'original');
      assert.equal(rerenderedRecord.state, 'original');
    },
  },
  {
    name: 'reuses cached viewport translations after restoring original text',
    fn() {
      const settings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      };
      const state = {
        status: 'active',
        operationId: 8,
        translationCacheBySettings: new Map(),
        restorableRecords: [],
      };
      const firstCache = helpers.activateInlineTranslationCacheBucket(
        state,
        settings
      );
      const firstStore = helpers.createInlineViewportStore(
        state.operationId,
        firstCache
      );
      const node = { isConnected: true, nodeValue: 'Hello world.' };

      helpers.queueInlineViewportRecord(firstStore, node, 'Hello world.');
      const batch = helpers.takeInlineViewportBatch(firstStore);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: batch[0].id, translation: '안녕하세요.' }],
        8,
        firstStore
      );

      state.viewport = firstStore;
      state.records = firstStore.records;

      helpers.restoreInlineViewportRecords(state);
      assert.equal(node.nodeValue, 'Hello world.');

      const secondCache = helpers.getInlineTranslationCacheBucket(
        state,
        settings
      );
      assert.equal(secondCache, firstCache);
      assert.equal(state.viewport.translationByOriginal, firstCache);
      const queued = helpers.queueInlineViewportRecord(
        state.viewport,
        node,
        'Hello world.'
      );

      assert.equal(queued, null);
      assert.equal(node.nodeValue, '안녕하세요.');
      assert.equal(state.viewport.queue.length, 0);
      assert.deepEqual(
        helpers.getInlineViewportStatusCounts(state.viewport.records),
        {
          translated: 1,
          pending: 0,
          failed: 0,
        }
      );
    },
  },
  {
    name: 'does not restore viewport records changed after translation',
    fn() {
      const state = {
        status: 'active',
        operationId: 8,
        viewport: helpers.createInlineViewportStore(8),
      };
      const node = { isConnected: true, nodeValue: 'Live site update.' };
      const record = {
        id: 'v1',
        node,
        original: 'Hello world.',
        translation: '안녕하세요.',
        state: 'translated',
        operationId: 8,
      };
      state.viewport.records.push(record);

      helpers.restoreInlineViewportRecords(state);

      assert.equal(node.nodeValue, 'Live site update.');
      assert.equal(record.state, 'stale');
      assert.equal(state.status, 'original');
      assert.equal(state.operationId, 9);
    },
  },
];
