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
    name: 'detects masked settings API key for inline preflight',
    fn() {
      assert.equal(helpers.hasInlineSettingsApiKey({ apiKey: '***' }), true);
      assert.equal(helpers.hasInlineSettingsApiKey({ apiKey: '' }), false);
      assert.equal(helpers.hasInlineSettingsApiKey({}), false);
      assert.equal(helpers.hasInlineSettingsApiKey(null), false);
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
