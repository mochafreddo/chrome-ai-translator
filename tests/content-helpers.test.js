const assert = require('node:assert/strict');
const helpers = require('../extension/content.js');
const {
  createReasoningFixture,
  createTestDocument,
} = require('./inline-block.test');
const inlineBlockCodec = require('../extension/inline-block.js');
const { DEFAULT_MODEL } = require('../extension/default-model.js');

function getReasoningTranslatedTemplate(record) {
  const wrapper = record.contract.entries.find(
    (entry) => entry.kind === 'wrapper'
  );
  const atom = record.contract.entries.find((entry) => entry.kind === 'atom');
  return `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
}

// The retry-cancellation checks for Semantic Blocks all start from the same place: a block
// whose translation came back after the page had already changed it, so the block was marked
// stale and the one page-change retry it is allowed was queued behind it.
function queueSemanticBlockPageChangeRetry(
  operationId,
  store = helpers.createInlineViewportStore(operationId),
  fixture = createReasoningFixture()
) {
  const { block } = fixture;
  const original = helpers.queueInlineViewportBlock(store, block);
  helpers.takeInlineViewportBlockBatch(store);
  const originalText = original.snapshot.originalTextValues.keys().next().value;
  originalText.nodeValue = 'Updated reasoning models';

  helpers.applyInlineViewportBlockResults(
    [original],
    [
      {
        id: original.id,
        disposition: 'apply',
        template: getReasoningTranslatedTemplate(original),
      },
    ],
    operationId,
    store
  );

  const retry = store.queue[0];
  assert.equal(original.state, 'stale');
  assert.equal(original.supersededByRetryId, retry.id);
  return { block, store, original, retry };
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
    name: 'builds display Markdown and a protected translation document',
    fn() {
      const { element, text } = createTestDocument();
      const link = element('a', text('private guide'));
      link.setAttribute('href', 'https://private.test/path?token=secret');
      const root = element(
        'main',
        element(
          'p',
          text('Read '),
          link,
          text(' and run '),
          element('code', text('private-command --secret')),
          text('.')
        )
      );

      const extraction = helpers.buildArticleExtraction(root, {
        title: 'Guide',
        url: 'https://page.test/article',
        langHint: 'en',
      });

      assert.equal(extraction.title, 'Guide');
      assert.equal(extraction.langHint, 'en');
      assert.match(
        extraction.contentMarkdown,
        /\[private guide\]\(<https:\/\/private\.test\/path\?token=secret>\)/
      );
      assert.match(extraction.contentMarkdown, /```private-command --secret```/);
      const templates = extraction.translationDocument.blocks
        .map((block) => block.template)
        .join('\n');
      assert.equal(templates.includes('token=secret'), false);
      assert.equal(templates.includes('private-command --secret'), false);
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
    name: 'asks the background worker what to do on startup instead of reading settings',
    async fn() {
      let message = null;
      const fakeChrome = {
        runtime: {
          async sendMessage(value) {
            message = value;
            if (value?.type === 'GET_SETTINGS') {
              throw new Error('the mount decision is not the content script to make');
            }
            return { ok: true, instructions: ['mountFloatingTranslateButton'] };
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

      assert.deepEqual(await helpers.requestInlineStartupInstructions(fakeChrome), [
        'mountFloatingTranslateButton',
      ]);
      assert.deepEqual(message, { type: 'GET_INLINE_STARTUP_INSTRUCTIONS' });
    },
  },
  {
    name: 'treats an unusable startup answer as no instructions',
    async fn() {
      const answers = [
        { ok: false, error: { message: 'Unknown message' } },
        { ok: true },
        undefined,
      ];
      for (const answer of answers) {
        const fakeChrome = {
          runtime: {
            async sendMessage() {
              return answer;
            },
          },
        };
        assert.deepEqual(
          await helpers.requestInlineStartupInstructions(fakeChrome),
          []
        );
      }
      assert.deepEqual(await helpers.requestInlineStartupInstructions({}), []);
    },
  },
  {
    name: 'grants inline translation authorization when instructed to',
    fn() {
      const state = {};
      assert.equal(
        helpers.runInlineInstruction(
          'grantInlineTranslationAuthorization',
          helpers.getDefaultInlineInstructionHandlers(state)
        ),
        true
      );
      assert.equal(helpers.hasInlineTranslationAuthorization(state), true);
    },
  },
  {
    name: 'runs inline instructions in order and ignores ones it does not know',
    fn() {
      const calls = [];
      const handlers = {
        grantInlineTranslationAuthorization: () =>
          calls.push('grantInlineTranslationAuthorization'),
        mountFloatingTranslateButton: () => calls.push('mountFloatingTranslateButton'),
      };

      helpers.runInlineInstructions(
        [
          'grantInlineTranslationAuthorization',
          'startSidePanelTranslation',
          'mountFloatingTranslateButton',
        ],
        handlers
      );
      assert.deepEqual(calls, [
        'grantInlineTranslationAuthorization',
        'mountFloatingTranslateButton',
      ]);
      assert.equal(helpers.runInlineInstruction('openSidePanel', handlers), false);
    },
  },
  {
    name: 'carries out the panel Inline Translation controls as instructions',
    fn() {
      // The side panel drives Inline Translation through the same channel the worker uses,
      // so a control has one implementation whatever pressed it.
      const handlers = helpers.getDefaultInlineInstructionHandlers();

      for (const control of [
        'startInlineTranslation',
        'stopInlineTranslation',
        'restoreInlineOriginal',
      ]) {
        assert.equal(typeof handlers[control], 'function', control);
      }
    },
  },
  {
    name: 'reports Inline Translation progress and errors as separate fields',
    fn() {
      // The panel is the only place either is shown, and it has a line for each: mixing
      // them into one string would leave the panel guessing which it had been handed.
      assert.deepEqual(
        helpers.getInlineTranslationStatusSnapshot({
          status: 'active',
          message: 'Translated 3 blocks.',
          error: '',
        }),
        { status: 'active', progress: 'Translated 3 blocks.', error: '' }
      );

      assert.deepEqual(
        helpers.getInlineTranslationStatusSnapshot({
          status: 'original',
          error: 'Open Options and paste your OpenAI API key.',
        }),
        {
          status: 'original',
          progress: '',
          error: 'Open Options and paste your OpenAI API key.',
        }
      );

      assert.deepEqual(helpers.getInlineTranslationStatusSnapshot({}), {
        status: 'original',
        progress: '',
        error: '',
      });
    },
  },
  {
    name: 'reports a run that will not finish as an error, not as progress',
    fn() {
      // The panel keeps its progress line muted and raises its error line. A translation
      // that failed reaching the reader as muted status was what the split was for.
      const failed = [
        { state: 'failed', errorCode: 'runtime.request_failed' },
      ];

      assert.match(
        helpers.formatInlineViewportErrorText(failed),
        /Translation failed/
      );
      assert.equal(
        helpers.formatInlineViewportErrorText(failed, true),
        `${helpers.getInlineTerminalReason(failed)}\nDiagnostics could not be saved.`
      );
      assert.equal(
        helpers.formatInlineViewportErrorText([{ state: 'translated' }], true),
        'Diagnostics could not be saved.'
      );
      assert.equal(
        helpers.formatInlineViewportErrorText([{ state: 'translated' }]),
        ''
      );
      assert.equal(helpers.formatInlineViewportErrorText([]), '');
    },
  },
  {
    name: 'leaves Inline Translation progress and errors to the side panel',
    fn() {
      // Single-sourced in the panel: the Floating Translate Button carries the controls
      // and nothing else, so there is no two-way synchronisation to maintain.
      const model = helpers.getInlineTranslatorUiModel({
        status: 'active',
        menuOpen: true,
        message: 'Translated 3 blocks.',
        error: 'Translation failed.',
      });

      assert.equal('message' in model, false);
      assert.doesNotMatch(JSON.stringify(model), /Translated 3 blocks|failed/);
    },
  },
  {
    // `INLINE_TRANSLATION_PROGRESS` was the half of the retired message pair that lived
    // here: the service worker sent it and this script wrote it onto the progress line.
    // The worker suite guards the producer; this guards the receiver, because re-adding
    // the receiver alone is the natural way to "restore progress reporting" and it is
    // exactly how the pair survived unnoticed the first time. Progress is now written by
    // `updateInlineViewportMessage`, from Semantic Block counts, and by nothing else.
    name: 'does not act on the retired inline progress message',
    fn() {
      const modulePath = require.resolve('../extension/content.js');
      const originalModule = require.cache[modulePath];
      const previous = {
        chrome: global.chrome,
        initialized: globalThis.__chromeAiTranslatorContentInitialized,
        inlineState: globalThis.__chromeAiTranslatorInlineState,
      };
      let listener = null;

      global.chrome = {
        runtime: {
          onMessage: {
            addListener(fn) {
              listener = fn;
            },
          },
          sendMessage() {
            return Promise.resolve({ ok: false });
          },
        },
      };
      delete globalThis.__chromeAiTranslatorContentInitialized;
      delete globalThis.__chromeAiTranslatorInlineState;

      try {
        delete require.cache[modulePath];
        require('../extension/content.js');
        assert.equal(typeof listener, 'function');

        const state = globalThis.__chromeAiTranslatorInlineState;
        state.status = 'active';
        state.message = 'Visible translation on';
        const responses = [];
        const handled = listener(
          {
            type: 'INLINE_TRANSLATION_PROGRESS',
            operationId: state.operationId,
            progress: { stage: 'queued', recordCount: 3, chunkCount: 1 },
          },
          {},
          (response) => responses.push(response)
        );

        assert.equal(handled, undefined);
        assert.deepEqual(responses, []);
        assert.equal(state.message, 'Visible translation on');
      } finally {
        global.chrome = previous.chrome;
        globalThis.__chromeAiTranslatorContentInitialized = previous.initialized;
        globalThis.__chromeAiTranslatorInlineState = previous.inlineState;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'brings the Floating Translate Button back with its menu down, not open',
    fn() {
      // The re-mount half of the cycle: mounting renders whatever the state says, so a
      // button closed with its menu open would come back mid-menu if closing left it that
      // way. This is the whole of what closing has to remember.
      const state = { status: 'original', menuOpen: true, message: '' };
      helpers.closeFloatingTranslateButton(state);
      const remounted = helpers.getInlineTranslatorUiModel(state);
      assert.equal(remounted.menuOpen, false);
      assert.equal(remounted.expanded, 'false');
    },
  },
  {
    name: 'keeps a running Inline Translation running when the button is closed',
    fn() {
      // Closing takes the UI, not the work: the run stays active on the same operation, so
      // the Semantic Blocks already under way keep being translated against it.
      const scanning = {
        status: 'active',
        menuOpen: true,
        message: 'Visible translation on',
        operationId: 3,
      };
      helpers.closeFloatingTranslateButton(scanning);
      assert.equal(scanning.status, 'active');
      assert.equal(scanning.operationId, 3);
    },
  },
  {
    name: 'records nothing about a closed button that could outlive the page view',
    fn() {
      // A reload brings the button back subject to the reader's visibility choice, so
      // closing must leave nothing behind to restore from. It adds no state at all: the
      // button is closed exactly while its UI is detached.
      const state = { status: 'translating', menuOpen: true, operationId: 4 };
      const before = Object.keys(state).sort();
      helpers.closeFloatingTranslateButton(state);
      assert.deepEqual(Object.keys(state).sort(), before);
    },
  },
  {
    name: 'carries out the remaining inline instructions when one of them fails',
    fn() {
      const calls = [];
      helpers.runInlineInstructions(
        ['grantInlineTranslationAuthorization', 'mountFloatingTranslateButton'],
        {
          grantInlineTranslationAuthorization: () => {
            throw new Error('no page to authorize');
          },
          mountFloatingTranslateButton: () => calls.push('mountFloatingTranslateButton'),
        }
      );
      assert.deepEqual(calls, ['mountFloatingTranslateButton']);
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
    name: 'schedules another viewport scan when the scan budget is exhausted',
    fn() {
      const state = global.__chromeAiTranslatorInlineState;
      const previousState = {
        status: state.status,
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
        state.message = previousState.message;
        state.operationId = previousState.operationId;
        state.viewport = previousState.viewport;
      }
    },
  },
  {
    // The scan position is the reason a long page finishes at all: a scan that runs out of
    // budget must record where it stopped, or every later scan re-inspects the same head of
    // the page and the tail is never reached. `docs/design/inline-restore-cache-design.md`
    // is where the rule is written down.
    name: 'resumes a Semantic Block scan where the previous one ran out of budget',
    fn() {
      const previous = {
        document: global.document,
        HTMLElement: global.HTMLElement,
        window: global.window,
      };
      const { document, element, text } = createTestDocument();
      const root = element('div');
      const sentences = [
        'First article sentence.',
        'Second article sentence.',
        'Third article sentence.',
      ];
      for (const sentence of sentences) {
        root.appendChild(element('p', text(sentence)));
      }
      document.body.appendChild(root);
      document.documentElement = { clientWidth: 0, clientHeight: 0 };
      document.createRange = () => {
        throw new Error('range unavailable');
      };
      global.document = document;
      global.HTMLElement = root.constructor;
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
        const store = helpers.createInlineViewportStore(41);

        const first = helpers.collectVisibleInlineBlocks(root, store, 2);
        assert.deepEqual(
          first.map((record) => record.template),
          [sentences[0], sentences[1]]
        );
        assert.equal(store.scanStartIndex, 2);

        const second = helpers.collectVisibleInlineBlocks(root, store, 2);
        assert.deepEqual(
          second.map((record) => record.template),
          [sentences[2]]
        );
        // Nothing was left unread, so the next scan starts from the top again.
        assert.equal(store.scanStartIndex, 0);
      } finally {
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.window = previous.window;
      }
    },
  },
  {
    // The scan budget is spent on text nodes, but it is only reached by nodes whose
    // ancestors survived the element-level offscreen check. Without that pruning the
    // budget goes on content the reader cannot see, and the blocks in front of them are
    // never queued — the failure looks like Inline Translation doing nothing at all.
    name: 'does not let offscreen blocks exhaust the Semantic Block scan budget',
    fn() {
      const previous = {
        document: global.document,
        HTMLElement: global.HTMLElement,
        window: global.window,
      };
      const { document, element, text } = createTestDocument();
      const offscreen = ['Far above one.', 'Far above two.', 'Far above three.'].map(
        (sentence) => element('p', text(sentence))
      );
      const visible = element('p', text('The paragraph the reader is looking at.'));
      const root = element('div');
      for (const paragraph of [...offscreen, visible]) root.appendChild(paragraph);
      document.body.appendChild(root);
      document.documentElement = { clientWidth: 0, clientHeight: 0 };
      document.createRange = () => {
        throw new Error('range unavailable');
      };
      const offscreenRect = {
        top: -1000,
        bottom: -976,
        left: 10,
        right: 300,
        width: 290,
        height: 24,
      };
      for (const paragraph of offscreen) paragraph.rect = offscreenRect;
      root.rect = { top: 0, bottom: 900, left: 10, right: 300, width: 290, height: 900 };
      global.document = document;
      global.HTMLElement = root.constructor;
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
        const store = helpers.createInlineViewportStore(42);

        // A budget of one: it has to survive three offscreen paragraphs to be spent on the
        // visible one.
        const queued = helpers.collectVisibleInlineBlocks(root, store, 1);

        assert.deepEqual(
          queued.map((record) => record.template),
          ['The paragraph the reader is looking at.']
        );
        assert.equal(store.scanStartIndex, 0);
      } finally {
        global.document = previous.document;
        global.HTMLElement = previous.HTMLElement;
        global.window = previous.window;
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
        state.message = previous.message;
        state.operationId = previous.operationId;
        state.viewport = previous.viewport;
      }
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
        model: DEFAULT_MODEL,
        reasoningEffort: 'none',
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
      };

      const nextOperationId = helpers.stopInlineViewportTranslation(state);

      assert.equal(nextOperationId, 5);
      assert.equal(state.operationId, 5);
      assert.equal(state.status, 'stopped');
      assert.equal(store.stopped, true);
      assert.deepEqual(store.queue, []);
      assert.equal(node.nodeValue, '안녕하세요.');
    },
  },
  {
    name: 'makes a final RCA persistence attempt when stopping during retry backoff',
    fn() {
      const previousChrome = global.chrome;
      const messages = [];
      global.chrome = { runtime: { sendMessage(message) {
        messages.push(message);
        return new Promise(() => {});
      } } };
      const store = helpers.createInlineViewportStore(5);
      store.localDiagnosticsInFlight = {
        id: globalThis.crypto.randomUUID(),
        diagnostics: [{ code: 'runtime.block_too_large', evidence: {} }],
        attempt: 1,
      };
      store.localDiagnostics.push({ code: 'runtime.session_too_large', evidence: {} });
      store.localDiagnosticRetryTimer = setTimeout(() => {}, 10000);
      const state = { status: 'active', operationId: 5, viewport: store };
      try {
        helpers.stopInlineViewportTranslation(state);
        assert.equal(messages.length, 2);
        assert.equal(messages[0].type, 'RECORD_INLINE_LOCAL_DIAGNOSTIC');
        assert.equal(messages[1].diagnostics[0].code, 'runtime.session_too_large');
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'flushes queued RCA diagnostics when stopping before a deferred flush',
    fn() {
      const previousChrome = global.chrome;
      const messages = [];
      global.chrome = { runtime: { sendMessage(message) {
        messages.push(message);
        return new Promise(() => {});
      } } };
      const store = helpers.createInlineViewportStore(6);
      store.localDiagnostics.push({ code: 'runtime.session_too_large', evidence: { limit: 60000 } });
      store.localDiagnosticRetryTimer = setTimeout(() => {}, 10000);
      const state = { status: 'active', operationId: 6, viewport: store };
      try {
        helpers.stopInlineViewportTranslation(state);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].diagnostics[0].code, 'runtime.session_too_large');
      } finally {
        global.chrome = previousChrome;
      }
    },
  },
  {
    name: 'drains queued RCA diagnostics while another request is active',
    fn() {
      const previousChrome = global.chrome;
      const messages = [];
      global.chrome = { runtime: { sendMessage(message) {
        messages.push(message);
        return new Promise(() => {});
      } } };
      const store = helpers.createInlineViewportStore(7);
      store.localDiagnosticsInFlight = {
        id: globalThis.crypto.randomUUID(),
        diagnostics: [{ code: 'runtime.block_too_large', evidence: {} }],
        attempt: 0,
      };
      store.localDiagnostics.push({ code: 'runtime.unsupported_block', evidence: {} });
      const state = { status: 'active', operationId: 7, viewport: store };
      try {
        helpers.stopInlineViewportTranslation(state);
        assert.equal(messages.length, 1);
        assert.equal(messages[0].diagnostics[0].code, 'runtime.unsupported_block');
      } finally {
        global.chrome = previousChrome;
      }
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
    name: 'grants each local diagnostic batch an independent retry',
    async fn() {
      const previousChrome = global.chrome;
      const previousSetTimeout = global.setTimeout;
      const timers = [];
      let calls = 0;
      global.setTimeout = (callback) => { timers.push(callback); return timers.length; };
      global.chrome = { runtime: { sendMessage() {
        calls += 1;
        return calls === 4 ? Promise.resolve({ ok: true }) : Promise.reject(new Error('transient'));
      } } };
      const store = {
        operationId: 77,
        localDiagnostics: [{ code: 'runtime.unsupported_block', evidence: {} }],
        localDiagnosticsInFlight: null,
        translationSettings: null,
      };
      try {
        helpers.flushInlineLocalDiagnostics(store);
        await new Promise((resolve) => setImmediate(resolve));
        store.localDiagnostics.push({ code: 'runtime.block_too_large', evidence: {} });
        timers.shift()();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 2);
        assert.equal(store.localDiagnostics.length, 1);

        timers.shift()();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 3);
        timers.shift()();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 4);
        assert.equal(store.localDiagnostics.length, 0);
        assert.equal(store.localDiagnosticsInFlight, null);
      } finally {
        global.chrome = previousChrome;
        global.setTimeout = previousSetTimeout;
      }
    },
  },
  {
    name: 'does not warn when a local diagnostic retry succeeds',
    async fn() {
      const previousChrome = global.chrome;
      const previousSetTimeout = global.setTimeout;
      const timers = [];
      let calls = 0;
      global.setTimeout = (callback) => { timers.push(callback); return timers.length; };
      global.chrome = { runtime: { sendMessage() {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error('transient')) : Promise.resolve({ ok: true });
      } } };
      const store = {
        operationId: 78,
        localDiagnostics: [{ code: 'runtime.unsupported_block', evidence: {} }],
        localDiagnosticsInFlight: null,
        translationSettings: null,
      };
      try {
        helpers.flushInlineLocalDiagnostics(store);
        await new Promise((resolve) => setImmediate(resolve));
        assert.notEqual(store.diagnosticsUnavailable, true);
        timers.shift()();
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 2);
        assert.notEqual(store.diagnosticsUnavailable, true);
        assert.equal(store.localDiagnosticsInFlight, null);
      } finally {
        global.chrome = previousChrome;
        global.setTimeout = previousSetTimeout;
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
    name: 'resetting queued semantic block retries keeps them queued rather than cancelling them',
    fn() {
      const state = global.__chromeAiTranslatorInlineState;
      const previousState = {
        status: state.status,
        message: state.message,
        operationId: state.operationId,
        viewport: state.viewport,
      };

      try {
        withFakeViewportDom(() => {
          const { block, store, original, retry } =
            queueSemanticBlockPageChangeRetry(35);
          state.status = 'active';
          state.operationId = 35;
          state.viewport = store;

          // Everything this check asserts about the retry is that the reset left it alone,
          // which is also what a reset that never ran would look like. A plain queued block
          // behind it is the control: the same call has to reset that one to `original`, so
          // a green result cannot mean the reset was skipped.
          const control = helpers.queueInlineViewportBlock(
            store,
            createReasoningFixture().block
          );
          assert.equal(control.state, 'queued');
          assert.deepEqual(store.queue, [retry, control]);

          helpers.scheduleInlineViewportScanFromViewportChange();

          assert.equal(control.state, 'original');

          // The retry survives the reset, so the block it superseded stays pending rather
          // than falling back to an unresolved `changed` — either way it does not read as
          // finished.
          assert.equal(retry.state, 'queued');
          assert.deepEqual(store.queue, [retry]);
          assert.equal(original.supersededByRetryId, retry.id);
          assert.deepEqual(helpers.getInlineViewportStatusCounts(store.records), {
            translated: 0,
            partial: 0,
            pending: 1,
            changed: 0,
            failed: 0,
          });

          // The rescan the reset schedules re-reaches the same block, and must not queue a
          // second retry beside the one it left alone.
          assert.equal(helpers.queueInlineViewportBlock(store, block), null);
          assert.deepEqual(store.queue, [retry]);
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
        state.message = previousState.message;
        state.operationId = previousState.operationId;
        state.viewport = previousState.viewport;
      }
    },
  },
  {
    name: 'stopping in-flight semantic block retries keeps unresolved changed status visible',
    fn() {
      const { store, original, retry } = queueSemanticBlockPageChangeRetry(36);
      const state = {
        status: 'active',
        operationId: 36,
        restorableRecords: [],
        viewport: store,
      };
      helpers.takeInlineViewportBlockBatch(store);
      assert.equal(retry.state, 'translating');

      helpers.stopInlineViewportTranslation(state);

      assert.equal(store.stopped, true);
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
      assert.equal(
        helpers.getInlineTerminalReason(store.records),
        'Page changed before translation could be applied.'
      );
    },
  },
  {
    name: 'stopping queued semantic block retries keeps unresolved changed status visible',
    fn() {
      const { store, original, retry } = queueSemanticBlockPageChangeRetry(37);
      const state = {
        status: 'active',
        operationId: 37,
        restorableRecords: [],
        viewport: store,
      };
      assert.equal(retry.state, 'queued');

      helpers.stopInlineViewportTranslation(state);

      // Stopping discards the queue, so this retry will never run. The block it superseded
      // has to stop pointing at it, or nothing counts the block as `changed` and a stopped
      // run with an unresolved block reads as finished.
      assert.equal(store.stopped, true);
      assert.deepEqual(store.queue, []);
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
      assert.equal(
        helpers.getInlineTerminalReason(store.records),
        'Page changed before translation could be applied.'
      );
    },
  },
  {
    // The two checks above build their store with `createInlineViewportStore` and never seed
    // it, so neither can see what a restart does to the record ids. A restarted session
    // carries its translated blocks into a fresh store keeping their original ids, so the
    // first block the new session mints has to be given an id none of them already holds —
    // otherwise `findInlineViewportRecordById` resolves the retry's `retryOf` to the seeded
    // record, the supersession is never cleared, and the unresolved block goes back to
    // reading as finished.
    name: 'stopping a restarted session keeps unresolved changed status visible',
    fn() {
      const settings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      };
      const cache = new Map();
      const { block: firstBlock } = createReasoningFixture();
      const firstStore = helpers.createInlineViewportStore(38, cache, settings);
      const seeded = helpers.queueInlineViewportBlock(firstStore, firstBlock);
      helpers.applyInlineViewportBlockResults(
        helpers.takeInlineViewportBlockBatch(firstStore),
        [{ id: seeded.id, disposition: 'apply', template: getReasoningTranslatedTemplate(seeded) }],
        38,
        firstStore
      );
      assert.equal(seeded.state, 'translated');

      const state = {
        status: 'active',
        operationId: 38,
        viewport: firstStore,
        restorableRecords: [],
      };
      helpers.stopInlineViewportTranslation(state);

      // Page in Korean again: a fresh store for the new operation, seeded with what the
      // stopped run had already translated.
      const secondStore = helpers.createInlineViewportStore(39, cache, settings);
      helpers.seedInlineViewportStoreWithRestorableRecords(
        secondStore,
        state.restorableRecords
      );
      assert.deepEqual(secondStore.records, [seeded]);

      // A second block, whose text differs from the seeded one so the shared cache bucket
      // does not answer for it and it really is queued.
      const secondFixture = createReasoningFixture();
      secondFixture.strong.childNodes[0].nodeValue = 'Other reasoning models';
      const { original, retry } = queueSemanticBlockPageChangeRetry(
        39,
        secondStore,
        secondFixture
      );
      state.status = 'active';
      state.operationId = 39;
      state.viewport = secondStore;

      // Asserted separately from the status below, so a future change that fixes the counts
      // while leaving two records sharing an id does not read as a clean pass.
      const mintedIds = secondStore.records.map((record) => record.id);
      assert.equal(new Set(mintedIds).size, mintedIds.length);
      assert.notEqual(original.id, seeded.id);
      assert.notEqual(retry.id, seeded.id);

      helpers.stopInlineViewportTranslation(state);

      assert.equal(secondStore.stopped, true);
      assert.deepEqual(secondStore.queue, []);
      assert.equal(original.supersededByRetryId, undefined);
      assert.deepEqual(helpers.getInlineViewportStatusCounts(secondStore.records), {
        translated: 1,
        partial: 0,
        pending: 1,
        changed: 1,
        failed: 0,
      });
      assert.equal(
        helpers.formatInlineViewportStatusMessage(
          helpers.getInlineViewportStatusCounts(secondStore.records),
          'stopped'
        ),
        'Visible translation stopped\nTranslated 1 · Partial 0 · Pending 0 · Changed 1 · Failed 0'
      );
      assert.equal(
        helpers.getInlineTerminalReason(secondStore.records),
        'Page changed before translation could be applied.'
      );
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
    // A translation carried over from a stopped run was produced under the settings of that
    // run. Reusing it after the reader changed the target language would show the old answer
    // as if it were the new one, so the block goes back to its original content and is
    // queued again under the settings now in force.
    name: 'restores stopped-session translated blocks when settings change',
    fn() {
      const { block, strong, link } = createReasoningFixture();
      const originalText = block.textContent;
      const cache = new Map();
      const firstStore = helpers.createInlineViewportStore(31, cache, {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      });
      const record = helpers.queueInlineViewportBlock(firstStore, block);
      helpers.applyInlineViewportBlockResults(
        helpers.takeInlineViewportBlockBatch(firstStore),
        [{ id: record.id, disposition: 'apply', template: getReasoningTranslatedTemplate(record) }],
        31,
        firstStore
      );
      const state = {
        status: 'active',
        operationId: 31,
        viewport: firstStore,
        restorableRecords: [],
      };
      helpers.stopInlineViewportTranslation(state);

      // A different settings signature selects a different cache bucket, which is why the
      // carried-over translation cannot simply be reapplied.
      const secondStore = helpers.createInlineViewportStore(32, new Map(), {
        targetLanguage: 'Japanese',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        reasoningEffort: 'none',
      });
      helpers.seedInlineViewportStoreWithRestorableRecords(
        secondStore,
        state.restorableRecords
      );

      assert.equal(record.state, 'original');
      assert.equal(secondStore.byBlock.get(block), undefined);
      assert.deepEqual(secondStore.records, []);
      assert.equal(block.textContent, originalText);
      // The block's own inline elements came back, in their original order.
      assert.equal(block.childNodes[0], strong);
      assert.equal(block.childNodes[2], link);

      // The block is available to translate again under the settings now in force.
      const requeued = helpers.queueInlineViewportBlock(secondStore, block);
      assert.equal(requeued.state, 'queued');
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
