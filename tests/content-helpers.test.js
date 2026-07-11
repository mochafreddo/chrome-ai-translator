const assert = require('node:assert/strict');
const helpers = require('../extension/content.js');
const {
  createReasoningFixture,
  createTestDocument,
} = require('./inline-block.test');
const inlineBlockCodec = require('../extension/inline-block.js');

function getReasoningTranslatedTemplate(record) {
  const wrapper = record.contract.entries.find(
    (entry) => entry.kind === 'wrapper'
  );
  const atom = record.contract.entries.find((entry) => entry.kind === 'atom');
  return `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
}

exports.name = 'content helpers';

function withFakeViewportDom(fn, options = {}) {
  const previous = {
    chrome: global.chrome,
    clearTimeout: global.clearTimeout,
    document: global.document,
    HTMLElement: global.HTMLElement,
    setTimeout: global.setTimeout,
    window: global.window,
  };
  const defaultRect = {
    top: 20,
    bottom: 44,
    left: 10,
    right: 300,
    width: 290,
    height: 24,
    ...(options.defaultRect || {}),
  };

  class FakeElement {
    constructor(children = [], rect = {}) {
      this.nodeType = 1;
      this.tagName = 'P';
      this.childNodes = children;
      this.hidden = false;
      this.parentElement = null;
      this.rect = { ...defaultRect, ...rect };
      for (const child of children) {
        child.parentElement = this;
      }
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

  function text(value) {
    return {
      nodeType: 3,
      nodeValue: value,
      isConnected: true,
      parentElement: null,
    };
  }

  global.HTMLElement = FakeElement;
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
  };
  if ('chrome' in options) global.chrome = options.chrome;
  if ('clearTimeout' in options) global.clearTimeout = options.clearTimeout;
  if ('setTimeout' in options) global.setTimeout = options.setTimeout;

  const restore = () => {
    global.chrome = previous.chrome;
    global.clearTimeout = previous.clearTimeout;
    global.document = previous.document;
    global.HTMLElement = previous.HTMLElement;
    global.setTimeout = previous.setTimeout;
    global.window = previous.window;
  };

  try {
    const result = fn({ FakeElement, text });
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

async function flushMicrotasks(count = 8) {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve();
  }
}

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
    name: 'preserves inline code markers when serializing paragraph text',
    fn() {
      const paragraph = {
        nodeType: 1,
        tagName: 'P',
        childNodes: [
          { nodeType: 3, nodeValue: 'Use ' },
          {
            nodeType: 1,
            tagName: 'CODE',
            textContent: 'chrome.storage.local',
            childNodes: [{ nodeType: 3, nodeValue: 'chrome.storage.local' }],
          },
          { nodeType: 3, nodeValue: ' for settings.' },
        ],
      };

      assert.equal(
        helpers.getMarkdownTextWithInlineCode(paragraph),
        'Use `chrome.storage.local` for settings.'
      );
    },
  },
  {
    name: 'uses longer inline code delimiters for backtick runs',
    fn() {
      const paragraph = {
        nodeType: 1,
        tagName: 'P',
        childNodes: [
          { nodeType: 3, nodeValue: 'Use ' },
          {
            nodeType: 1,
            tagName: 'CODE',
            textContent: 'a``b',
            childNodes: [{ nodeType: 3, nodeValue: 'a``b' }],
          },
          { nodeType: 3, nodeValue: ' now.' },
        ],
      };

      assert.equal(
        helpers.getMarkdownTextWithInlineCode(paragraph),
        'Use ``` a``b ``` now.'
      );
    },
  },
  {
    name: 'preserves line breaks when serializing paragraph text',
    fn() {
      const paragraph = {
        nodeType: 1,
        tagName: 'P',
        childNodes: [
          { nodeType: 3, nodeValue: 'First line' },
          { nodeType: 1, tagName: 'BR', childNodes: [], textContent: '' },
          { nodeType: 3, nodeValue: 'Second line' },
        ],
      };

      assert.equal(
        helpers.getMarkdownTextWithInlineCode(paragraph),
        'First line Second line'
      );
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
    name: 'preserves text-node boundary spaces when applying translations',
    fn() {
      const dashNode = {
        isConnected: true,
        nodeValue: ' - Activates before writing code.',
      };
      const conjunctionNode = { isConnected: true, nodeValue: ' or ' };

      helpers.applyInlineTranslationRecords([
        {
          id: 'n1',
          node: dashNode,
          original: ' - Activates before writing code.',
          translation: '- 코드 작성 전에 활성화됩니다.',
        },
        {
          id: 'n2',
          node: conjunctionNode,
          original: ' or ',
          translation: '또는',
        },
      ]);

      assert.equal(dashNode.nodeValue, ' - 코드 작성 전에 활성화됩니다.');
      assert.equal(conjunctionNode.nodeValue, ' 또는 ');
    },
  },
  {
    name: 'preserves exact original boundary whitespace',
    fn() {
      const nbspNode = {
        isConnected: true,
        nodeValue: '\u00a0Hello world.  ',
      };

      helpers.applyInlineTranslationRecords([
        {
          id: 'n1',
          node: nbspNode,
          original: '\u00a0Hello world.  ',
          translation: ' 안녕하세요. ',
        },
      ]);

      assert.equal(nbspNode.nodeValue, '\u00a0안녕하세요.  ');
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
    name: 'does not queue offscreen text nodes in manual DOM scans',
    fn() {
      withFakeViewportDom(({ FakeElement, text }) => {
        const visible = new FakeElement([
          text('First visible article sentence.'),
        ]);
        const belowViewport = new FakeElement(
          [text('Second below article sentence.')],
          {
            top: 700,
            bottom: 724,
          }
        );
        const laterVisible = new FakeElement(
          [text('Third visible article sentence.')],
          {
            top: 60,
            bottom: 84,
          }
        );
        const root = new FakeElement([visible, belowViewport, laterVisible]);
        const store = helpers.createInlineViewportStore(19);

        const queued = helpers.collectVisibleInlineTextNodes(root, store, 10);

        assert.deepEqual(
          queued.map((record) => record.original),
          [
            'First visible article sentence.',
            'Third visible article sentence.',
          ]
        );
        assert.deepEqual(
          store.queue.map((record) => record.original),
          [
            'First visible article sentence.',
            'Third visible article sentence.',
          ]
        );
      });
    },
  },
  {
    name: 'does not let offscreen predecessors exhaust the visible scan budget',
    fn() {
      withFakeViewportDom(({ FakeElement, text }) => {
        const offscreen = Array.from({ length: 1200 }, (_item, index) =>
          new FakeElement([text(`Offscreen article sentence ${index + 1}.`)])
        );
        const visible = new FakeElement(
          [text('Visible article sentence now.')],
          {
            top: 20,
            bottom: 44,
          }
        );
        const root = new FakeElement([...offscreen, visible], {
          top: 0,
          bottom: 800,
        });
        const store = helpers.createInlineViewportStore(23);

        const queued = helpers.collectVisibleInlineTextNodes(root, store, 1200);

        assert.deepEqual(
          queued.map((record) => record.original),
          ['Visible article sentence now.']
        );
      }, { defaultRect: { top: 700, bottom: 724 } });
    },
  },
  {
    name: 'resets scan continuation and queued work when the viewport changes',
    fn() {
      const state = global.__chromeAiTranslatorInlineState;
      const previousState = {
        status: state.status,
        records: state.records,
        message: state.message,
        operationId: state.operationId,
        viewport: state.viewport,
      };

      try {
        withFakeViewportDom(({ FakeElement, text }) => {
          const firstViewport = Array.from({ length: 1300 }, (_item, index) =>
            new FakeElement([text(`Initial visible sentence ${index + 1}.`)])
          );
          const secondViewport = [
            new FakeElement(
              [text('Later visible sentence.')],
              { top: 700, bottom: 724 }
            ),
          ];
          const root = new FakeElement([...firstViewport, ...secondViewport], {
            top: 0,
            bottom: 900,
          });
          const store = helpers.createInlineViewportStore(24);

          helpers.collectVisibleInlineTextNodes(root, store, 1200);
          assert.equal(store.scanStartIndex, 1200);

          for (const el of firstViewport) {
            el.rect = {
              top: -1000,
              bottom: -976,
              left: 10,
              right: 300,
              width: 290,
              height: 24,
            };
          }
          for (const el of secondViewport) {
            el.rect = {
              top: 20,
              bottom: 44,
              left: 10,
              right: 300,
              width: 290,
              height: 24,
            };
          }

          state.status = 'active';
          state.operationId = 24;
          state.viewport = store;
          helpers.scheduleInlineViewportScanFromViewportChange();

          assert.equal(store.scanStartIndex, 0);
          const queued = helpers.collectVisibleInlineTextNodes(root, store, 1200);
          assert.deepEqual(
            queued.map((record) => record.original),
            ['Later visible sentence.']
          );
          const batch = helpers.takeInlineViewportBatch(store, 2000);
          assert.deepEqual(
            batch.map((record) => record.original),
            ['Later visible sentence.']
          );
        }, {
          clearTimeout() {},
          setTimeout() {
            return 123;
          },
        });
      } finally {
        state.status = previousState.status;
        state.records = previousState.records;
        state.message = previousState.message;
        state.operationId = previousState.operationId;
        state.viewport = previousState.viewport;
      }
    },
  },
  {
    name: 'includes body and scrollable ancestors in viewport scroll targets',
    fn() {
      withFakeViewportDom(({ FakeElement }) => {
        function makeEventTarget(el) {
          return Object.assign(el, {
            addEventListener() {},
            removeEventListener() {},
          });
        }

        makeEventTarget(global.window);
        makeEventTarget(global.document);

        const root = makeEventTarget(new FakeElement([]));
        const scrollContainer = makeEventTarget(new FakeElement([root]));
        scrollContainer.clientHeight = 300;
        scrollContainer.scrollHeight = 900;
        scrollContainer.overflowY = 'auto';

        const body = makeEventTarget(new FakeElement([scrollContainer]));
        body.tagName = 'BODY';
        body.clientHeight = 577;
        body.scrollHeight = 13648;
        body.overflowY = 'auto';

        const html = makeEventTarget(new FakeElement([body]));
        html.tagName = 'HTML';
        html.clientHeight = 577;
        html.scrollHeight = 577;
        body.parentElement = html;

        global.document.body = body;
        global.document.documentElement = html;
        global.document.scrollingElement = html;
        global.window.getComputedStyle = (el) => ({
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          overflow: el.overflowY || 'visible',
          overflowY: el.overflowY || 'visible',
        });

        const targets = helpers.getInlineViewportScrollTargets(root);

        assert.equal(targets.includes(global.window), true);
        assert.equal(targets.includes(global.document), true);
        assert.equal(targets.includes(html), true);
        assert.equal(targets.includes(body), true);
        assert.equal(targets.includes(scrollContainer), true);
      });
    },
  },
  {
    name: 'advances viewport scans through large pages with a text-node budget',
    fn() {
      withFakeViewportDom(({ FakeElement, text }) => {
        const nodes = [
          text('First visible article sentence.'),
          text('Second visible article sentence.'),
          text('Third visible article sentence.'),
          text('Fourth visible article sentence.'),
        ];
        const root = new FakeElement(nodes);
        const store = helpers.createInlineViewportStore(21);

        const first = helpers.collectVisibleInlineTextNodes(root, store, 2);
        const second = helpers.collectVisibleInlineTextNodes(root, store, 2);

        assert.deepEqual(
          first.map((record) => record.original),
          [
            'First visible article sentence.',
            'Second visible article sentence.',
          ]
        );
        assert.deepEqual(
          second.map((record) => record.original),
          [
            'Third visible article sentence.',
            'Fourth visible article sentence.',
          ]
        );
        assert.deepEqual(
          store.queue.map((record) => record.original),
          [
            'First visible article sentence.',
            'Second visible article sentence.',
            'Third visible article sentence.',
            'Fourth visible article sentence.',
          ]
        );
      });
    },
  },
  {
    name: 'schedules another viewport scan when the scan budget is exhausted',
    fn() {
      const state = global.__chromeAiTranslatorInlineState;
      const previousState = {
        status: state.status,
        records: state.records,
        message: state.message,
        operationId: state.operationId,
        viewport: state.viewport,
      };
      let timerCalls = 0;

      try {
        withFakeViewportDom(({ FakeElement, text }) => {
          const nodes = Array.from({ length: 1201 }, (_item, index) =>
            text(`Visible article sentence ${index + 1}.`)
          );
          const root = new FakeElement(nodes);
          const store = helpers.createInlineViewportStore(31);
          store.root = root;
          state.status = 'active';
          state.operationId = 31;
          state.viewport = store;

          helpers.runInlineViewportScan();

          assert.equal(store.scanStartIndex, 1200);
          assert.equal(timerCalls, 1);
        }, {
          chrome: {
            runtime: {
              sendMessage() {
                return new Promise(() => {});
              },
            },
          },
          clearTimeout() {},
          setTimeout() {
            timerCalls += 1;
            return 123;
          },
        });
      } finally {
        state.status = previousState.status;
        state.records = previousState.records;
        state.message = previousState.message;
        state.operationId = previousState.operationId;
        state.viewport = previousState.viewport;
      }
    },
  },
  {
    name: 'drains semantic block page-change retries through the runtime loop',
    async fn() {
      const state = global.__chromeAiTranslatorInlineState;
      const previous = {
        chrome: global.chrome,
        document: global.document,
        HTMLElement: global.HTMLElement,
        window: global.window,
        status: state.status,
        records: state.records,
        message: state.message,
        operationId: state.operationId,
        viewport: state.viewport,
      };
      const fixture = createReasoningFixture();
      const calls = [];
      fixture.document.documentElement = {
        clientWidth: 0,
        clientHeight: 0,
      };
      fixture.document.createRange = () => {
        throw new Error('range unavailable');
      };
      global.document = fixture.document;
      global.HTMLElement = fixture.block.constructor;
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
      global.chrome = {
        runtime: {
          async sendMessage(message) {
            calls.push(message);
            if (message.type === 'RECORD_INLINE_RUNTIME_DIAGNOSTIC') {
              return { ok: true };
            }
            const activeRecord = state.viewport.records.find(
              (record) => record.id === message.records[0].id
            );
            if (calls.length === 1) {
              activeRecord.snapshot.originalTextValues.keys().next().value.nodeValue =
                'Updated reasoning models';
            }
            return {
              ok: true,
              results: [
                {
                  id: activeRecord.id,
                  ok: true,
                  template: getReasoningTranslatedTemplate(activeRecord),
                },
              ],
            };
          },
        },
      };

      try {
        const store = helpers.createInlineViewportStore(32);
        store.root = fixture.block;
        state.status = 'active';
        state.operationId = 32;
        state.viewport = store;
        state.records = store.records;

        helpers.runInlineViewportScan();
        await flushMicrotasks(16);

        const translationCalls = calls.filter(
          (message) => message.type === 'TRANSLATE_VISIBLE_BLOCK_BATCH'
        );
        assert.equal(translationCalls.length, 2);
        assert.deepEqual(
          translationCalls.map((message) => message.type),
          ['TRANSLATE_VISIBLE_BLOCK_BATCH', 'TRANSLATE_VISIBLE_BLOCK_BATCH']
        );
        assert.match(translationCalls[0].records[0].template, /Reasoning models/);
        assert.match(translationCalls[1].records[0].template, /Updated reasoning models/);
        assert.equal(calls[0].records[0].text, undefined);
        assert.equal(fixture.block.childNodes[0], fixture.link);
        assert.equal(
          fixture.block.textContent,
          'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.'
        );
        assert.equal(store.inFlight, 0);
        assert.equal(store.queue.length, 0);
        assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
          translated: 1,
          partial: 0,
          pending: 0,
          changed: 0,
          failed: 0,
        });
      } finally {
        global.chrome = previous.chrome;
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.window = previous.window;
        state.status = previous.status;
        state.records = previous.records;
        state.message = previous.message;
        state.operationId = previous.operationId;
        state.viewport = previous.viewport;
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
        partial: 0,
        pending: 0,
        changed: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'preserves boundary spaces in viewport translations and cache',
    fn() {
      const store = helpers.createInlineViewportStore(7);
      const conjunctionNode = { isConnected: true, nodeValue: ' or ' };

      helpers.queueInlineViewportRecord(store, conjunctionNode, ' or ');
      const batch = helpers.takeInlineViewportBatch(store);
      helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: batch[0].id, translation: '또는' }],
        7,
        store
      );

      assert.equal(conjunctionNode.nodeValue, ' 또는 ');
      assert.equal(batch[0].translation, ' 또는 ');

      const rerenderedNode = { isConnected: true, nodeValue: ' or ' };
      const queued = helpers.queueInlineViewportRecord(
        store,
        rerenderedNode,
        ' or '
      );

      assert.equal(queued, null);
      assert.equal(rerenderedNode.nodeValue, ' 또는 ');
    },
  },
  {
    name: 'normalizes unpreserved cached viewport translations',
    fn() {
      const store = helpers.createInlineViewportStore(7);
      store.translationByOriginal.set(' - Activates before writing code.', {
        original: ' - Activates before writing code.',
        translation: '- 코드 작성 전에 활성화됩니다.',
      });
      const node = {
        isConnected: true,
        nodeValue: ' - Activates before writing code.',
      };

      const queued = helpers.queueInlineViewportRecord(
        store,
        node,
        ' - Activates before writing code.'
      );

      assert.equal(queued, null);
      assert.equal(node.nodeValue, ' - 코드 작성 전에 활성화됩니다.');
      assert.equal(
        store.translationByOriginal.get(' - Activates before writing code.')
          .translation,
        ' - 코드 작성 전에 활성화됩니다.'
      );
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
        partial: 0,
        pending: 0,
        changed: 0,
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
        partial: 0,
        pending: 0,
        changed: 0,
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
        partial: 0,
        pending: 0,
        changed: 0,
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
          partial: 0,
          pending: 0,
          changed: 0,
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
        partial: 0,
        pending: 1,
        changed: 0,
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
      assert.deepEqual(result, { applied: 1, stale: 2, retried: 0, ignored: 0 });
      assert.equal(records[0].state, 'translated');
      assert.equal(records[1].state, 'stale');
      assert.equal(records[2].state, 'stale');
    },
  },
  {
    name: 'queues one retry when stale node has changed translatable text',
    fn() {
      const store = helpers.createInlineViewportStore(21);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const batch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        21,
        store
      );

      const retry = store.records.find((record) => record.retryOf === original.id);

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 1, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, retry.id);
      assert.equal(retry.original, 'Updated article text.');
      assert.equal(retry.retryCount, 1);
      assert.equal(retry.state, 'queued');
      assert.equal(store.byNode.get(node), retry);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id, retry.id]
      );
      assert.deepEqual(store.queue.map((record) => record.id), [retry.id]);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 1,
        changed: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'does not retry disconnected changed nodes',
    fn() {
      const store = helpers.createInlineViewportStore(22);
      let connected = true;
      const node = {
        get isConnected() {
          return connected;
        },
        nodeValue: 'Original article text.',
      };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const batch = helpers.takeInlineViewportBatch(store);

      connected = false;
      node.nodeValue = 'Updated article text.';
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        22,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, undefined);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id]
      );
      assert.equal(
        store.records.some((record) => record.retryOf === original.id),
        false
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'applies queued retry translations successfully',
    fn() {
      const store = helpers.createInlineViewportStore(26);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const firstBatch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      helpers.applyInlineViewportBatchTranslations(
        firstBatch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        26,
        store
      );

      const retry = store.queue[0];
      const retryBatch = helpers.takeInlineViewportBatch(store);
      const result = helpers.applyInlineViewportBatchTranslations(
        retryBatch,
        [{ id: retry.id, translation: '업데이트된 기사 텍스트.' }],
        26,
        store
      );

      assert.deepEqual(result, { applied: 1, stale: 0, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, retry.id);
      assert.equal(retry.state, 'translated');
      assert.equal(retry.translation, '업데이트된 기사 텍스트.');
      assert.equal(node.nodeValue, '업데이트된 기사 텍스트.');
      assert.equal(store.byNode.get(node), retry);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id, retry.id]
      );
      assert.deepEqual(store.translationByOriginal.get('Updated article text.'), {
        original: 'Updated article text.',
        translation: '업데이트된 기사 텍스트.',
      });
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 1,
        partial: 0,
        pending: 0,
        changed: 0,
        failed: 0,
      });
    },
  },
  {
    name: 'stamps retry records and cache writes with active settings',
    fn() {
      const settings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
        apiKey: 'sk-korean',
      };
      const otherSettings = { ...settings, targetLanguage: 'Japanese' };
      const state = {
        status: 'active',
        operationId: 29,
        translationCacheBySettings: new Map(),
      };
      const cache = helpers.activateInlineTranslationCacheBucket(state, settings);
      const otherCache = helpers.activateInlineTranslationCacheBucket(
        state,
        otherSettings
      );
      const signature = helpers.getInlineTranslationCacheSignature(settings);
      const store = helpers.createInlineViewportStore(29, cache, settings);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const firstBatch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      helpers.applyInlineViewportBatchTranslations(
        firstBatch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        29,
        store
      );

      const retry = store.queue[0];
      const retryBatch = helpers.takeInlineViewportBatch(store);
      helpers.applyInlineViewportBatchTranslations(
        retryBatch,
        [{ id: retry.id, translation: '업데이트된 기사 텍스트.' }],
        29,
        store
      );

      assert.equal(original.translationSettingsSignature, signature);
      assert.equal(retry.translationSettingsSignature, signature);
      assert.deepEqual(cache.get('Updated article text.'), {
        original: 'Updated article text.',
        translation: '업데이트된 기사 텍스트.',
      });
      assert.equal(otherCache.has('Updated article text.'), false);
    },
  },
  {
    name: 'marks retry records failed when retry response is missing',
    fn() {
      const store = helpers.createInlineViewportStore(30);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const firstBatch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      helpers.applyInlineViewportBatchTranslations(
        firstBatch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        30,
        store
      );

      const retry = store.queue[0];
      const retryBatch = helpers.takeInlineViewportBatch(store);
      const result = helpers.applyInlineViewportBatchTranslations(
        retryBatch,
        [],
        30,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 0, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, retry.id);
      assert.equal(retry.state, 'failed');
      assert.equal(node.nodeValue, 'Updated article text.');
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 0,
        failed: 1,
      });
    },
  },
  {
    name: 'resetting queued retries restores changed status until requeued',
    fn() {
      const state = global.__chromeAiTranslatorInlineState;
      const previousState = {
        status: state.status,
        records: state.records,
        message: state.message,
        operationId: state.operationId,
        viewport: state.viewport,
      };

      try {
        withFakeViewportDom(() => {
          const store = helpers.createInlineViewportStore(31);
          const node = { isConnected: true, nodeValue: 'Original article text.' };
          const original = helpers.queueInlineViewportRecord(
            store,
            node,
            'Original article text.'
          );
          const firstBatch = helpers.takeInlineViewportBatch(store);
          state.status = 'active';
          state.operationId = 31;
          state.viewport = store;
          state.records = store.records;

          node.nodeValue = 'Updated article text.';
          helpers.applyInlineViewportBatchTranslations(
            firstBatch,
            [{ id: original.id, translation: '원문 기사 텍스트.' }],
            31,
            store
          );

          const retry = store.queue[0];
          assert.equal(original.supersededByRetryId, retry.id);
          helpers.scheduleInlineViewportScanFromViewportChange();

          assert.equal(retry.state, 'original');
          assert.equal(original.supersededByRetryId, undefined);
          assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
            translated: 0,
            partial: 0,
            pending: 0,
            changed: 1,
            failed: 0,
          });

          const requeued = helpers.queueInlineViewportRecord(
            store,
            node,
            node.nodeValue
          );
          assert.equal(requeued, retry);
          assert.equal(original.supersededByRetryId, retry.id);
          assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
            translated: 0,
            partial: 0,
            pending: 1,
            changed: 0,
            failed: 0,
          });
        }, {
          clearTimeout() {},
          setTimeout() {
            return 123;
          },
        });
      } finally {
        state.status = previousState.status;
        state.records = previousState.records;
        state.message = previousState.message;
        state.operationId = previousState.operationId;
        state.viewport = previousState.viewport;
      }
    },
  },
  {
    name: 'stopping queued retries keeps unresolved changed status visible',
    fn() {
      const store = helpers.createInlineViewportStore(33);
      const state = {
        status: 'active',
        operationId: 33,
        records: [],
        restorableRecords: [],
        viewport: store,
      };
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const firstBatch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      helpers.applyInlineViewportBatchTranslations(
        firstBatch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        33,
        store
      );

      const retry = store.queue[0];
      assert.equal(original.supersededByRetryId, retry.id);
      helpers.stopInlineViewportTranslation(state);

      assert.equal(store.stopped, true);
      assert.equal(store.queue.length, 0);
      assert.equal(original.supersededByRetryId, undefined);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
      assert.equal(
        helpers.formatInlineViewportStatusMessage(
          helpers.getInlineViewportStatusCounts(store.records),
          'stopped'
        ),
        'Visible translation stopped\nTranslated 0 · Partial 0 · Pending 0 · Changed 1 · Failed 0'
      );
    },
  },
  {
    name: 'stopping in-flight retries keeps unresolved changed status visible',
    fn() {
      const store = helpers.createInlineViewportStore(34);
      const state = {
        status: 'active',
        operationId: 34,
        records: [],
        restorableRecords: [],
        viewport: store,
      };
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const firstBatch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      helpers.applyInlineViewportBatchTranslations(
        firstBatch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        34,
        store
      );

      const retry = store.queue[0];
      helpers.takeInlineViewportBatch(store);
      assert.equal(retry.state, 'translating');
      assert.equal(original.supersededByRetryId, retry.id);
      helpers.stopInlineViewportTranslation(state);

      assert.equal(original.supersededByRetryId, undefined);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 1,
        changed: 1,
        failed: 0,
      });
      assert.equal(
        helpers.formatInlineViewportStatusMessage(
          helpers.getInlineViewportStatusCounts(store.records),
          'stopped'
        ),
        'Visible translation stopped\nTranslated 0 · Partial 0 · Pending 0 · Changed 1 · Failed 0'
      );
    },
  },
  {
    name: 'does not retry stale records that no longer own the node',
    fn() {
      const store = helpers.createInlineViewportStore(27);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const batch = helpers.takeInlineViewportBatch(store);
      const replacement = {
        id: 'v-replacement',
        node,
        original: 'Updated article text.',
        translation: null,
        state: 'queued',
        operationId: 27,
      };

      node.nodeValue = 'Updated article text.';
      store.byNode.set(node, replacement);
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        27,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, undefined);
      assert.equal(store.byNode.get(node), replacement);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id]
      );
      assert.equal(
        store.records.some((record) => record.retryOf === original.id),
        false
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'does not retry changed text that equals the rejected translation',
    fn() {
      const store = helpers.createInlineViewportStore(28);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const batch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: 'Updated article text.' }],
        28,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, undefined);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id]
      );
      assert.equal(
        store.records.some((record) => record.retryOf === original.id),
        false
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'does not retry changed text that equals preserved rejected translation',
    fn() {
      const store = helpers.createInlineViewportStore(28);
      const node = { isConnected: true, nodeValue: ' Original article text. ' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        ' Original article text. '
      );
      const batch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = ' 업데이트된 기사 텍스트. ';
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: '업데이트된 기사 텍스트.' }],
        28,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, undefined);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id]
      );
      assert.equal(
        store.records.some((record) => record.retryOf === original.id),
        false
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'normalizes cached changed-text retry translations',
    fn() {
      const store = helpers.createInlineViewportStore(28);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      helpers.takeInlineViewportBatch(store);

      node.nodeValue = ' Updated article text. ';
      store.translationByOriginal.set(' Updated article text. ', {
        original: ' Updated article text. ',
        translation: '업데이트된 기사 텍스트.',
      });

      const retry = helpers.queueInlineViewportRetryRecord(
        store,
        original,
        ' Updated article text. ',
        ''
      );

      assert.equal(retry.state, 'translated');
      assert.equal(retry.translation, ' 업데이트된 기사 텍스트. ');
      assert.equal(node.nodeValue, ' 업데이트된 기사 텍스트. ');
      assert.equal(
        store.translationByOriginal.get(' Updated article text. ').translation,
        ' 업데이트된 기사 텍스트. '
      );
      assert.equal(original.supersededByRetryId, retry.id);
      assert.equal(store.queue.length, 0);
    },
  },
  {
    name: 'does not retry non-translatable changed text',
    fn() {
      const store = helpers.createInlineViewportStore(23);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const batch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'ABC';
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        23,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 0, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, undefined);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id]
      );
      assert.equal(
        store.records.some((record) => record.retryOf === original.id),
        false
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'does not retry a stale retry record again',
    fn() {
      const store = helpers.createInlineViewportStore(24);
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const firstBatch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      helpers.applyInlineViewportBatchTranslations(
        firstBatch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        24,
        store
      );

      const retry = store.queue[0];
      const retryBatch = helpers.takeInlineViewportBatch(store);
      node.nodeValue = 'Updated article text again.';
      const result = helpers.applyInlineViewportBatchTranslations(
        retryBatch,
        [{ id: retry.id, translation: '업데이트된 기사 텍스트.' }],
        24,
        store
      );

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 0, ignored: 0 });
      assert.equal(retry.state, 'stale');
      assert.equal(retry.supersededByRetryId, undefined);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id, retry.id]
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'applies cached translation for changed retry text without queueing',
    fn() {
      const store = helpers.createInlineViewportStore(25);
      store.translationByOriginal.set('Updated article text.', {
        original: 'Updated article text.',
        translation: '업데이트된 기사 텍스트.',
      });
      const node = { isConnected: true, nodeValue: 'Original article text.' };
      const original = helpers.queueInlineViewportRecord(
        store,
        node,
        'Original article text.'
      );
      const batch = helpers.takeInlineViewportBatch(store);

      node.nodeValue = 'Updated article text.';
      const result = helpers.applyInlineViewportBatchTranslations(
        batch,
        [{ id: original.id, translation: '원문 기사 텍스트.' }],
        25,
        store
      );

      const retry = store.records.find((record) => record.retryOf === original.id);

      assert.deepEqual(result, { applied: 0, stale: 1, retried: 1, ignored: 0 });
      assert.equal(original.state, 'stale');
      assert.equal(original.supersededByRetryId, retry.id);
      assert.equal(retry.state, 'translated');
      assert.equal(retry.translation, '업데이트된 기사 텍스트.');
      assert.equal(node.nodeValue, '업데이트된 기사 텍스트.');
      assert.equal(store.byNode.get(node), retry);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(
        store.records.map((record) => record.id),
        [original.id, retry.id]
      );
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 1,
        partial: 0,
        pending: 0,
        changed: 0,
        failed: 0,
      });
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

      assert.deepEqual(result, { applied: 0, stale: 0, retried: 0, ignored: 1 });
      assert.equal(node.nodeValue, 'Hello world.');
      assert.equal(records[0].state, 'translating');
    },
  },
  {
    name: 'releases runtime tokens from stale operation responses',
    fn() {
      const previousChrome = global.chrome;
      const messages = [];
      global.chrome = { runtime: { sendMessage(message) {
        messages.push(message);
        return Promise.resolve({ ok: true });
      } } };
      try {
        assert.equal(helpers.releaseInlineRuntimeTokensFromStaleResponse({
          results: [
            { correlationToken: 'token-1', template: 'ignored translation' },
            { correlationToken: 'token-2' },
          ],
        }, 41), true);
        assert.deepEqual(messages, [{
          type: 'RECORD_INLINE_RUNTIME_DIAGNOSTIC',
          operationId: 41,
          outcomes: [],
          releaseTokens: ['token-1', 'token-2'],
        }]);
      } finally {
        global.chrome = previousChrome;
      }
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
    name: 'counts translated pending changed and failed viewport records',
    fn() {
      const counts = helpers.getInlineViewportStatusCounts([
        { state: 'translated' },
        { state: 'queued' },
        { state: 'translating' },
        { state: 'failed' },
        { state: 'stale' },
        { state: 'stale', supersededByRetryId: 'v7' },
        { state: 'original' },
      ]);

      assert.deepEqual(counts, {
        translated: 1,
        partial: 0,
        pending: 2,
        changed: 1,
        failed: 1,
      });
    },
  },
  {
    name: 'formats viewport active status counts',
    fn() {
      const message = helpers.formatInlineViewportStatusMessage({
        translated: 18,
        partial: 0,
        pending: 4,
        changed: 3,
        failed: 1,
      });

      assert.equal(
        message,
        'Visible translation on\nTranslated 18 · Partial 0 · Pending 4 · Changed 3 · Failed 1'
      );
    },
  },
  {
    name: 'formats human-readable terminal reasons without exposing internal codes',
    fn() {
      assert.match(
        helpers.getInlineTerminalReason([{
          state: 'translated_with_warning',
          terminalCode: 'quality.english_residue',
        }]),
        /Partial translation: Some source-language prose remained/
      );
      assert.match(
        helpers.getInlineTerminalReason([{
          state: 'failed',
          terminalCode: 'structure.token_missing',
        }]),
        /Protected page structure could not be preserved/
      );
      assert.match(
        helpers.getInlineTerminalReason([{
          state: 'failed',
          terminalCode: 'protocol.invalid_json',
        }]),
        /model response was malformed or incomplete/
      );
      assert.match(
        helpers.getInlineTerminalReason([{
          state: 'stale',
          errorCode: 'block_changed',
        }]),
        /Page changed before translation could be applied/
      );
      assert.equal(
        helpers.getInlineTerminalReason([{
          state: 'failed',
          terminalCode: 'structure.token_missing',
          supersededByRetryId: 'retry-1',
        }]),
        ''
      );
    },
  },
  {
    name: 'selects the most recently completed unsuperseded terminal reason',
    fn() {
      const records = [
        {
          state: 'translated_with_warning',
          terminalCode: 'quality.english_residue',
          terminalSequence: 3,
        },
        {
          state: 'failed',
          terminalCode: 'structure.token_missing',
          terminalSequence: 2,
        },
        {
          state: 'failed',
          terminalCode: 'protocol.invalid_json',
          terminalSequence: 4,
          supersededByRetryId: 'retry-1',
        },
      ];

      assert.match(
        helpers.getInlineTerminalReason(records),
        /Partial translation: Some source-language prose remained/
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
          partial: 0,
          pending: 2,
          changed: 4,
          failed: 1,
        },
        'stopped'
      );

      assert.equal(
        message,
        'Visible translation stopped\nTranslated 3 · Partial 0 · Pending 0 · Changed 4 · Failed 1'
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
          partial: 0,
          pending: 0,
          changed: 0,
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
  {
    name: 'selects the nearest supported semantic block',
    fn() {
      const { block, strong } = createReasoningFixture();

      assert.equal(
        helpers.findInlineSemanticBlock(strong.childNodes[0], block),
        block
      );
    },
  },
  {
    name: 'queues one semantic record for all text in the same block',
    fn() {
      const { block } = createReasoningFixture();
      const store = helpers.createInlineViewportStore(12);

      const first = helpers.queueInlineViewportBlock(store, block);
      const duplicate = helpers.queueInlineViewportBlock(store, block);

      assert.equal(first.state, 'queued');
      assert.equal(first.blockElement, block);
      assert.equal(first.template.includes('GPT-5.5'), false);
      assert.equal(first.atoms[0].label, 'GPT-5.5');
      assert.equal(duplicate, null);
      assert.equal(store.records.length, 1);
      assert.equal(store.queue.length, 1);
      assert.equal(store.byBlock.get(block), first);
    },
  },
  {
    name: 'uses short prose around inline code to discover a block',
    fn() {
      const previous = {
        document: global.document,
        HTMLElement: global.HTMLElement,
        window: global.window,
      };
      const { document, element, text } = createTestDocument();
      const code = element('code', text('x'));
      const block = element('p', text('Run '), code, text('.'));
      document.body.appendChild(block);
      document.documentElement = { clientWidth: 0, clientHeight: 0 };
      document.createRange = () => {
        throw new Error('range unavailable');
      };
      global.document = document;
      global.HTMLElement = block.constructor;
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

      try {
        const store = helpers.createInlineViewportStore(12);
        const queued = helpers.collectVisibleInlineBlocks(block, store);

        assert.equal(queued.length, 1);
        assert.equal(store.queue.length, 1);
        assert.equal(store.queue[0].atoms[0].label, 'x');
      } finally {
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.window = previous.window;
      }
    },
  },
  {
    name: 'does not collect blocks inside inherited editable regions',
    fn() {
      const previous = {
        document: global.document,
        HTMLElement: global.HTMLElement,
        window: global.window,
      };
      const { document, element, text } = createTestDocument();
      const block = element('p', text('Unpublished draft text.'));
      const editor = element('div', block);
      editor.setAttribute('contenteditable', 'true');
      document.body.appendChild(editor);
      document.documentElement = { clientWidth: 0, clientHeight: 0 };
      document.createRange = () => {
        throw new Error('range unavailable');
      };
      global.document = document;
      global.HTMLElement = block.constructor;
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

      try {
        const store = helpers.createInlineViewportStore(12);
        const queued = helpers.collectVisibleInlineBlocks(editor, store);

        assert.deepEqual(queued, []);
        assert.equal(store.records.length, 0);
      } finally {
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.window = previous.window;
      }
    },
  },
  {
    name: 'fails closed when a block contains a nested semantic block',
    fn() {
      const { document, element, text } = createTestDocument();
      const nested = element('p', text('Nested paragraph text.'));
      const block = element('li', text('Outer item text.'), nested);
      document.body.appendChild(block);
      const store = helpers.createInlineViewportStore(13);

      const record = helpers.queueInlineViewportBlock(store, block);

      assert.equal(record.state, 'failed');
      assert.equal(record.errorCode, 'unsupported_block');
      assert.equal(record.terminalSequence, 1);
      assert.match(helpers.getInlineTerminalReason([record]), /unsupported structure/);
      const previousChrome = global.chrome;
      const messages = [];
      global.chrome = { runtime: { sendMessage(message) {
        messages.push(message);
        return Promise.resolve({ ok: true });
      } } };
      try {
        helpers.flushInlineLocalDiagnostics(store);
        assert.equal(messages[0].type, 'RECORD_INLINE_LOCAL_DIAGNOSTIC');
        assert.equal(messages[0].diagnostics[0].code, 'runtime.unsupported_block');
        assert.equal(messages[0].diagnostics[0].template, undefined);
      } finally {
        global.chrome = previousChrome;
      }
      assert.equal(store.queue.length, 0);
    },
  },
  {
    name: 'takes semantic block batches within the record-cost limit',
    fn() {
      const firstFixture = createReasoningFixture();
      const secondFixture = createReasoningFixture();
      const store = helpers.createInlineViewportStore(14);
      const first = helpers.queueInlineViewportBlock(
        store,
        firstFixture.block
      );
      const second = helpers.queueInlineViewportBlock(
        store,
        secondFixture.block
      );

      const batch = helpers.takeInlineViewportBlockBatch(store, 12000);

      assert.deepEqual(batch, [first, second]);
      assert.equal(first.state, 'translating');
      assert.equal(second.state, 'translating');
      assert.equal(store.inFlight, 1);
      assert.equal(
        store.sessionRecordCost,
        helpers.getInlineBlockReservedRecordCost(first) +
          helpers.getInlineBlockReservedRecordCost(second)
      );
      for (const record of [first, second]) {
        const modelRecord = (candidate) => ({
          id: candidate.id,
          template: candidate.template,
          atoms: candidate.atoms,
          repair: candidate.repair ?? null,
        });
        const repaired = {
          ...record,
          repair: {
            attempt: 1,
            previousErrorCode: 'quality.target_language_uncertain',
          },
        };
        const actualInitialAndRepairCost =
          JSON.stringify({ records: [modelRecord(record)] }).length +
          JSON.stringify({ records: [modelRecord(repaired)] }).length;
        assert.equal(
          actualInitialAndRepairCost <=
            helpers.getInlineBlockReservedRecordCost(record),
          true
        );
      }
    },
  },
  {
    name: 'caps semantic block batches at record and reserved session limits',
    fn() {
      const store = helpers.createInlineViewportStore(14);
      store.queue = Array.from({ length: 501 }, (_, index) => ({
        id: `b${index + 1}`,
        state: 'queued',
        operationId: 14,
        template: 'text',
        atoms: [],
        repair: null,
      }));
      store.records = [...store.queue];

      const batch = helpers.takeInlineViewportBlockBatch(store, 12000);

      assert.equal(batch.length <= 500, true);
      assert.equal(
        batch.reduce(
          (sum, record) => sum + helpers.getInlineBlockReservedRecordCost(record),
          0
        ) <= 12000,
        true
      );
      assert.equal(store.sessionRecordCost <= 60000, true);
      assert.equal(
        store.records.filter((record) => record.state === 'failed').length,
        0
      );
      assert.equal(store.queue.length, 501 - batch.length);
      assert.equal(store.queue.every((record) => record.state === 'queued'), true);
    },
  },
  {
    name: 'preserves the semantic block session budget across original restore',
    fn() {
      const cache = new Map();
      const firstStore = helpers.createInlineViewportStore(14, cache);
      firstStore.sessionRecordCost = 60000;
      const state = {
        status: 'active',
        operationId: 14,
        viewport: firstStore,
        translationCache: cache,
        records: [],
        restorableRecords: [],
      };

      helpers.restoreInlineViewportRecords(state);

      assert.equal(state.viewport.sessionRecordCost, 60000);
      const { block } = createReasoningFixture();
      const record = helpers.queueInlineViewportBlock(state.viewport, block);
      assert.deepEqual(
        helpers.takeInlineViewportBlockBatch(state.viewport, 12000),
        []
      );
      assert.equal(record.state, 'failed');
      assert.equal(record.errorCode, 'session_too_large');
      assert.equal(record.terminalSequence, 1);
      assert.match(helpers.getInlineTerminalReason([record]), /60,000-character limit/);
    },
  },
  {
    name: 'applies a semantic block result and rehydrates it from cache',
    fn() {
      const { block, link } = createReasoningFixture();
      const cache = new Map();
      const firstStore = helpers.createInlineViewportStore(15, cache);
      const record = helpers.queueInlineViewportBlock(firstStore, block);
      const batch = helpers.takeInlineViewportBlockBatch(firstStore);
      const translatedTemplate = getReasoningTranslatedTemplate(record);

      const applied = helpers.applyInlineViewportBlockResults(
        batch,
        [{ id: record.id, disposition: 'apply', template: translatedTemplate }],
        15,
        firstStore
      );

      assert.deepEqual(applied, {
        applied: 1,
        stale: 0,
        retried: 0,
        failed: 0,
        ignored: 0,
      });
      assert.equal(record.state, 'translated');
      assert.equal(block.childNodes[0], link);
      assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
      assert.equal(cache.get(record.cacheKey).translatedTemplate, translatedTemplate);

      assert.equal(inlineBlockCodec.restoreBlock(record.snapshot).ok, true);
      const secondStore = helpers.createInlineViewportStore(16, cache);
      const queued = helpers.queueInlineViewportBlock(secondStore, block);

      assert.equal(queued, null);
      assert.equal(secondStore.queue.length, 0);
      assert.equal(secondStore.records.length, 1);
      assert.equal(secondStore.records[0].state, 'translated');
      assert.equal(block.childNodes[0], link);
      assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
    },
  },
  {
    name: 'queues at most one page-change retry for a semantic block',
    fn() {
      const { block } = createReasoningFixture();
      const store = helpers.createInlineViewportStore(17);
      const first = helpers.queueInlineViewportBlock(store, block);
      helpers.takeInlineViewportBlockBatch(store);
      const firstText = first.snapshot.originalTextValues.keys().next().value;
      firstText.nodeValue = 'Updated reasoning models';

      const firstResult = helpers.applyInlineViewportBlockResults(
        [first],
        [{ id: first.id, disposition: 'apply', template: getReasoningTranslatedTemplate(first) }],
        17,
        store
      );
      const retry = store.queue[0];

      assert.equal(first.state, 'stale');
      assert.equal(firstResult.retried, 1);
      assert.equal(retry.pageChangeRetryCount, 1);
      assert.equal(first.supersededByRetryId, retry.id);

      helpers.takeInlineViewportBlockBatch(store);
      const retryText = retry.snapshot.originalTextValues.keys().next().value;
      retryText.nodeValue = 'Updated again';
      const secondResult = helpers.applyInlineViewportBlockResults(
        [retry],
        [{ id: retry.id, disposition: 'apply', template: getReasoningTranslatedTemplate(retry) }],
        17,
        store
      );

      assert.equal(secondResult.retried, 0);
      assert.equal(store.queue.length, 0);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
        translated: 0,
        partial: 0,
        pending: 0,
        changed: 1,
        failed: 0,
      });
    },
  },
  {
    name: 'rehydrates cached partial translations without false success',
    fn() {
      const { block } = createReasoningFixture();
      const cache = new Map();
      const firstStore = helpers.createInlineViewportStore(161, cache);
      const record = helpers.queueInlineViewportBlock(firstStore, block);
      helpers.applyInlineViewportBlockResults(
        helpers.takeInlineViewportBlockBatch(firstStore),
        [{
          id: record.id,
          disposition: 'apply_with_warning',
          template: getReasoningTranslatedTemplate(record),
          terminalCode: 'quality.english_residue',
          attemptCount: 2,
        }],
        161,
        firstStore
      );
      assert.equal(inlineBlockCodec.restoreBlock(record.snapshot).ok, true);

      const secondStore = helpers.createInlineViewportStore(162, cache);
      assert.equal(helpers.queueInlineViewportBlock(secondStore, block), null);
      const cachedRecord = secondStore.records[0];
      assert.equal(cachedRecord.state, 'translated_with_warning');
      assert.equal(cachedRecord.terminalCode, 'quality.english_residue');
      assert.equal(cachedRecord.attemptCount, 2);
      assert.match(helpers.getInlineTerminalReason([cachedRecord]), /Partial translation/);
      assert.equal(secondStore.queue.length, 0);
    },
  },
  {
    name: 'isolates an invalid block result from valid siblings',
    fn() {
      const firstFixture = createReasoningFixture();
      const secondFixture = createReasoningFixture();
      secondFixture.strong.childNodes[0].nodeValue = 'Other reasoning models';
      const store = helpers.createInlineViewportStore(19);
      const first = helpers.queueInlineViewportBlock(store, firstFixture.block);
      const second = helpers.queueInlineViewportBlock(store, secondFixture.block);
      const batch = helpers.takeInlineViewportBlockBatch(store);

      const result = helpers.applyInlineViewportBlockResults(
        batch,
        [
          { id: first.id, disposition: 'apply', template: getReasoningTranslatedTemplate(first) },
          {
            id: second.id,
            disposition: 'reject',
            terminalCode: 'structure.token_unknown',
            attemptCount: 2,
          },
        ],
        19,
        store
      );

      assert.equal(result.applied, 1);
      assert.equal(result.retried, 0);
      assert.equal(first.state, 'translated');
      assert.equal(second.state, 'failed');
      assert.equal(store.queue.length, 0);
    },
  },
  {
    name: 'normalizes local DOM apply failures for runtime diagnostics',
    fn() {
      const codec = require('../extension/inline-block.js');
      const previousApply = codec.applyPatchPlan;
      const { block } = createReasoningFixture();
      const store = helpers.createInlineViewportStore(191);
      const record = helpers.queueInlineViewportBlock(store, block);
      const batch = helpers.takeInlineViewportBlockBatch(store);
      codec.applyPatchPlan = () => ({ ok: false, errorCode: 'apply_failed' });
      try {
        helpers.applyInlineViewportBlockResults(
          batch,
          [{
            id: record.id,
            disposition: 'apply',
            template: getReasoningTranslatedTemplate(record),
            correlationToken: 'opaque-token',
          }],
          191,
          store
        );
        assert.equal(record.state, 'failed');
        assert.equal(record.errorCode, 'runtime.apply_failed');
        assert.equal(record.terminalCode, undefined);
        assert.equal(record.correlationToken, 'opaque-token');
      } finally {
        codec.applyPatchPlan = previousApply;
      }
    },
  },
  {
    name: 'restores partial semantic block records through Original text',
    fn() {
      const { block, strong, link } = createReasoningFixture();
      const originalBlockChildren = [...block.childNodes];
      const originalStrongChildren = [...strong.childNodes];
      const cache = new Map();
      const store = helpers.createInlineViewportStore(20, cache);
      const record = helpers.queueInlineViewportBlock(store, block);
      const batch = helpers.takeInlineViewportBlockBatch(store);
      helpers.applyInlineViewportBlockResults(
        batch,
        [{
          id: record.id,
          disposition: 'apply_with_warning',
          template: getReasoningTranslatedTemplate(record),
          terminalCode: 'quality.english_residue',
          attemptCount: 2,
        }],
        20,
        store
      );
      const state = {
        status: 'active',
        operationId: 20,
        viewport: store,
        records: store.records,
        restorableRecords: [record],
        translationCache: cache,
      };

      helpers.restoreInlineViewportRecords(state);

      assert.deepEqual(block.childNodes, originalBlockChildren);
      assert.deepEqual(strong.childNodes, originalStrongChildren);
      assert.equal(block.childNodes[2], link);
      assert.equal(block.textContent, 'Reasoning models like GPT-5.5 use internal reasoning tokens.');
      assert.equal(record.state, 'original');
      assert.equal(state.status, 'original');
      assert.equal(state.operationId, 21);
    },
  },
  {
    name: 'seeds same-settings translated blocks after a stopped restart',
    fn() {
      const { block } = createReasoningFixture();
      const settings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      };
      const cache = new Map();
      const firstStore = helpers.createInlineViewportStore(21, cache, settings);
      const record = helpers.queueInlineViewportBlock(firstStore, block);
      helpers.applyInlineViewportBlockResults(
        helpers.takeInlineViewportBlockBatch(firstStore),
        [{ id: record.id, disposition: 'apply', template: getReasoningTranslatedTemplate(record) }],
        21,
        firstStore
      );
      const state = {
        status: 'active',
        operationId: 21,
        viewport: firstStore,
        records: firstStore.records,
        restorableRecords: [],
      };
      helpers.stopInlineViewportTranslation(state);
      record.terminalSequence = 9;
      const secondStore = helpers.createInlineViewportStore(22, cache, settings);

      helpers.seedInlineViewportStoreWithRestorableRecords(
        secondStore,
        state.restorableRecords
      );

      assert.equal(secondStore.byBlock.get(block), record);
      assert.deepEqual(secondStore.records, [record]);
      assert.equal(record.state, 'translated');
      assert.equal(secondStore.nextTerminalSequence, 9);
      const laterFailure = { state: 'translating', operationId: 22 };
      secondStore.records.push(laterFailure);
      helpers.markInlineViewportBatchFailed([laterFailure], 22, secondStore);
      assert.equal(laterFailure.terminalSequence, 10);
      assert.equal(block.textContent, 'GPT-5.5와 같은 추론 모델은 내부 추론 토큰을 사용합니다.');
    },
  },
  {
    name: 'requeues a block rerendered with equivalent page-owned nodes',
    fn() {
      const { document, block } = createReasoningFixture();
      const store = helpers.createInlineViewportStore(23);
      const first = helpers.queueInlineViewportBlock(store, block);
      helpers.applyInlineViewportBlockResults(
        helpers.takeInlineViewportBlockBatch(store),
        [{ id: first.id, disposition: 'apply', template: getReasoningTranslatedTemplate(first) }],
        23,
        store
      );
      const extensionText = block.childNodes[1];
      const pageOwnedText = document.createTextNode(extensionText.nodeValue);
      block.childNodes.splice(1, 1, pageOwnedText);
      extensionText.parentNode = null;
      pageOwnedText.parentNode = block;

      const rerendered = helpers.queueInlineViewportBlock(store, block);

      assert.equal(first.state, 'stale');
      assert.equal(first.errorCode, 'block_changed');
      assert.equal(rerendered.state, 'queued');
      assert.equal(rerendered.blockElement, block);
      assert.equal(store.byBlock.get(block), rerendered);
      assert.deepEqual(store.queue, [rerendered]);
    },
  },
];
