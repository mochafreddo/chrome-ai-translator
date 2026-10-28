const assert = require('node:assert/strict');
const helpers = require('../extension/content');
const { createTestDocument } = require('./inline-block.test');
const inlineBlockCodec = require('../extension/inline-block');
const { createOperationFixture, flushMicrotasks } = require('./inline-translation-operation.test');
const { createContentPage } = require('./content-harness');
const sidepanel = require('../extension/sidepanel');
const background = require('../extension/background');
function makeState(overrides = {}) {
  return { operation: createOperationFixture().operation, menuOpen: false, ...overrides };
}
exports.name = 'content helpers';
exports.tests = [
  {
    name: 'extracts a preferred article without reading unrelated candidate text',
    fn() {
      const f = createOperationFixture();
      const article = f.document.createElement('article');
      article.textContent = 'A'.repeat(401);
      Object.defineProperty(article, 'innerText', { get: () => article.textContent });
      const main = f.document.createElement('main');
      main.textContent = 'M'.repeat(600);
      const reads = { main: 0, body: 0 };
      for (const [name, node] of [['main', main], ['body', f.document.body]]) {
        Object.defineProperty(node, 'innerText', { get() {
          reads[name] += 1;
          return node.textContent;
        } });
      }
      f.document.body.replaceChildren(article, main);
      const page = createContentPage(f, { article, main });
      page.inject();

      const response = page.message({ type: 'EXTRACT_ARTICLE' });

      assert.equal(response.ok, true);
      assert.equal(response.data.contentMarkdown, 'A'.repeat(401));
      assert.deepEqual(reads, { main: 0, body: 0 });
    },
  },
  {
    name: 'preserves article length boundaries and candidate ordering through extraction messages',
    fn() {
      const cases = [
        { article: `  ${'A'.repeat(400)}  `, main: 'M'.repeat(600), body: 'B'.repeat(800), expected: 'B'.repeat(800) },
        { article: `  ${'A'.repeat(401)}  `, main: 'M'.repeat(600), body: 'B'.repeat(800), expected: 'A'.repeat(401) },
        { article: `${'A'.repeat(200)} ${'A'.repeat(200)}`, body: 'B'.repeat(800), expected: `${'A'.repeat(200)} ${'A'.repeat(200)}` },
        { main: 'M'.repeat(500), roleMain: 'R'.repeat(600), body: 'B'.repeat(550), expected: 'R'.repeat(600) },
        { main: 'M'.repeat(500), roleMain: 'R'.repeat(600), body: 'B'.repeat(700), expected: 'B'.repeat(700) },
        { article: 'A'.repeat(400), main: 'M'.repeat(400), roleMain: 'R'.repeat(400), body: 'B'.repeat(400), expected: 'A'.repeat(400) },
        { main: 'M'.repeat(500), roleMain: 'R'.repeat(500), body: 'B'.repeat(500), expected: 'M'.repeat(500) },
        { roleMain: 'R'.repeat(500), body: 'B'.repeat(500), expected: 'R'.repeat(500) },
        { body: 'B'.repeat(500), expected: 'B'.repeat(500) },
        { article: 'A'.repeat(400), body: 'B'.repeat(500), sameSelectors: true, expected: 'B'.repeat(500) },
      ];
      for (const [index, value] of cases.entries()) {
        const f = createOperationFixture();
        f.document.body.textContent = value.body;
        f.document.body.innerText = value.body;
        const selectors = {};
        for (const [key, selector, tag] of [
          ['article', 'article', 'article'],
          ['main', 'main', 'main'],
          ['roleMain', '[role="main"]', 'section'],
        ]) {
          if (value[key] == null) continue;
          const node = f.document.createElement(tag);
          node.textContent = value[key];
          node.innerText = value[key];
          selectors[selector] = node;
        }
        if (value.sameSelectors) {
          selectors.main = selectors.article;
          selectors['[role="main"]'] = selectors.article;
        }
        const page = createContentPage(f, selectors);
        page.inject();

        const response = page.message({ type: 'EXTRACT_ARTICLE' });

        assert.equal(response.ok, true, `case ${index}`);
        assert.equal(response.data.contentMarkdown, value.expected, `case ${index}`);
      }
    },
  },
  {
    name: 'falls back to body only below 300 extracted Markdown characters',
    fn() {
      for (const length of [299, 300]) {
        const f = createOperationFixture();
        const article = f.document.createElement('article');
        const navigation = f.document.createElement('nav');
        navigation.textContent = 'N'.repeat(401);
        const articleProse = f.document.createElement('p');
        articleProse.textContent = 'A'.repeat(length);
        article.appendChild(navigation);
        article.appendChild(articleProse);
        article.innerText = article.textContent;
        const bodyProse = f.document.createElement('p');
        bodyProse.textContent = 'B'.repeat(500);
        f.document.body.replaceChildren(article, bodyProse);
        const page = createContentPage(f, { article });
        page.inject();

        const response = page.message({ type: 'EXTRACT_ARTICLE' });

        assert.equal(response.ok, true);
        assert.equal(response.data.contentMarkdown, length === 299
          ? `${'A'.repeat(299)}\n\n${'B'.repeat(500)}`
          : 'A'.repeat(300));
      }
    },
  },
  {
    name: 'Inline Start selects the same preferred article through content instructions',
    async fn() {
      const f = createOperationFixture();
      const article = f.document.createElement('article');
      const prose = f.document.createElement('p');
      prose.textContent = 'Article source sentence. '.repeat(20).trim();
      article.appendChild(prose);
      Object.defineProperty(article, 'innerText', { get: () => article.textContent });
      const outside = f.document.createElement('p');
      outside.textContent = 'Outside article sentence. '.repeat(40);
      f.document.body.replaceChildren(article, outside);
      Object.defineProperty(f.document.body, 'innerText', { get: () => f.document.body.textContent });
      const page = createContentPage(f, { article });
      page.inject();
      page.instruct('grantInlineTranslationAuthorization');
      page.instruct('startInlineTranslation');
      await flushMicrotasks();

      assert.equal(f.pending.length, 1);
      assert.equal(f.pending[0].message.records.length, 1);
      assert.equal(f.pending[0].message.records[0].template, prose.textContent);
      page.instruct('stopInlineTranslation');
    },
  },
  {
    name: 'detects code-like text conservatively',
    fn() {
      // The predicate has one home, in the codec that already owns what a protected atom is.
      // Asserting the identity — not just matching behaviour — is what makes every assertion
      // below cover the codec's link-label call site as well as the content script's scan.
      assert.equal(
        helpers.isCodeLikeInlineText,
        inlineBlockCodec.isCodeLikeInlineText
      );
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
    name: 'brings the Floating Translate Button back with its menu down, not open',
    fn() {
      // The re-mount half of the cycle: mounting renders whatever the state says, so a
      // button closed with its menu open would come back mid-menu if closing left it that
      // way. This is the whole of what closing has to remember.
      const state = makeState({ menuOpen: true });
      helpers.closeFloatingTranslateButton(state);
      const remounted = helpers.getInlineTranslatorUiModel(state);
      assert.equal(remounted.menuOpen, false);
      assert.equal(remounted.expanded, 'false');
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
      const state = makeState({ menuOpen: true });
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
        'Open controls for Japanese'
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
    name: 'refreshes inline menu target language when opening menu',
    async fn() {
      const messages = [];
      const state = makeState({
        translationSettings: {
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        },
      });
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
        'Open controls for Japanese'
      );
    },
  },
  {
    name: 'opens inline menu before target language refresh completes',
    async fn() {
      let resolveSettings;
      const state = makeState({
        translationSettings: {
          targetLanguage: 'Korean',
          tone: 'technical',
          model: 'gpt-5.4-mini',
          reasoningEffort: 'none',
        },
      });
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
      assert.equal(updates[0].translateText, 'Open controls for Korean');

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
      assert.equal(updates[1].translateText, 'Open controls for Japanese');
    },
  },
];

exports.tests.push(
  ...['stop', 'restore'].map(control => ({
    name: `panel to worker to content ${control} acknowledges before Start settings settle`,
    async fn() {
      const f = createOperationFixture();
      const page = createContentPage(f);
      page.inject();
      f.holdSettings();
      const worker = background.createBackgroundWorker({ chrome: { tabs: {
        sendMessage: async (tabId, message) => page.message(message),
      } } });
      let display;
      const controller = sidepanel.createTabStateController({
        queryActiveTab: async () => ({ id: 9 }),
        sendMessage: message => new Promise(resolve => worker.handlers.onMessage(message, {}, resolve)),
        render(value) { display = value; },
      });
      await controller.start(10);
      await controller.runInlineControl('start');
      assert.equal(f.settingsRequests.length, 1);
      await controller.runInlineControl(control);
      const before = display;
      f.settingsRequests[0].resolve({ ok: true, settings: { apiKey: 'synthetic-test-key' } });
      await flushMicrotasks();
      await controller.refresh();
      assert.deepEqual(display, before);
      assert.equal(display.inline.snapshot.status, control === 'stop' ? 'stopped' : 'original');
      assert.equal(f.pending.length, 0);
    },
  })),
  {
    name: 'floating start opens controls while panel instructions start translation',
    async fn() {
      const f = createOperationFixture();
      const page = createContentPage(f);
      page.inject();
      page.instruct('mountFloatingTranslateButton');
      await flushMicrotasks();
      page.button('translate').click(false);
      await flushMicrotasks();
      assert.equal(f.pending.length, 0);
      page.button('translate').click();
      await flushMicrotasks();
      assert.equal(f.pending.length, 0);
      assert.deepEqual(f.messages.filter(message => message.type === 'OPEN_INLINE_TRANSLATION_CONTROLS').map(message => ({ ...message })),
        [{ type: 'OPEN_INLINE_TRANSLATION_CONTROLS' }]);
      page.instruct('startInlineTranslation');
      await flushMicrotasks();
      assert.equal(f.pending.length, 0);
      page.instruct('grantInlineTranslationAuthorization');
      page.instruct('startInlineTranslation');
      await flushMicrotasks();
      assert.equal(f.pending.length, 1);
      assert.deepEqual(Object.keys(page.snapshot()).sort(), ['error', 'progress', 'status']);
      for (const control of ['stop', 'restore']) page.button(control).click(false);
      assert.equal(page.snapshot().status, 'active');
      page.button('close').click();
      page.instruct('mountFloatingTranslateButton');
      await flushMicrotasks();
      assert.equal(page.snapshot().status, 'active');
      assert.equal(page.toggle().getAttribute('aria-expanded'), 'false');
      await f.settle();
      assert.match(f.block.textContent, /추론 모델/);
      page.button('stop').click();
      assert.equal(page.snapshot().status, 'stopped');
      page.instruct('restoreInlineOriginal');
      assert.equal(page.snapshot().status, 'original');
      f.setSettings({ apiKey: 'synthetic-test-key', targetLanguage: 'Japanese' });
      page.instruct('startInlineTranslation');
      await flushMicrotasks();
      assert.equal(f.pending.length, 2);
      assert.equal(f.pending[1].message.settingsSnapshot.targetLanguage, 'Japanese');
      page.button('restore').click();
      assert.equal(page.button('translate').textContent, 'Open controls for Japanese');
      page.instruct('stopInlineTranslation');
    },
  },
  ...['authorized', 'active', 'stopped', 'restored'].map(status => ({
    name: `floating start only opens controls with ${status} operation`,
    async fn() {
      const f = createOperationFixture();
      const page = createContentPage(f);
      page.inject();
      page.instruct('mountFloatingTranslateButton');
      page.instruct('grantInlineTranslationAuthorization');
      if (status !== 'authorized') {
        page.instruct('startInlineTranslation');
        await flushMicrotasks();
        await f.settle();
      }
      if (status === 'stopped') page.instruct('stopInlineTranslation');
      if (status === 'restored') page.instruct('restoreInlineOriginal');
      f.document.body.appendChild(f.paragraph(300));
      const before = f.pending.length;
      const messages = f.messages.length;
      const snapshot = page.snapshot();
      page.button('translate').click(false);
      await flushMicrotasks();
      assert.equal(f.messages.length, messages);
      page.button('translate').click();
      await flushMicrotasks();
      assert.deepEqual(f.messages.slice(messages).map(message => ({ ...message })),
        [{ type: 'OPEN_INLINE_TRANSLATION_CONTROLS' }]);
      assert.equal(f.pending.length, before);
      assert.deepEqual(page.snapshot(), snapshot);
    },
  })),
  {
    name: 'menu refresh changes displayed language without changing active requests',
    async fn() {
      const f = createOperationFixture();
      const page = createContentPage(f);
      page.inject();
      page.instruct('mountFloatingTranslateButton');
      page.instruct('grantInlineTranslationAuthorization');
      page.instruct('startInlineTranslation');
      await flushMicrotasks();
      f.setSettings({ apiKey: 'synthetic-test-key', targetLanguage: 'Japanese' });
      page.toggle().click();
      await flushMicrotasks();
      f.document.body.appendChild(f.paragraph(300));
      page.instruct('startInlineTranslation');
      f.advance();
      await flushMicrotasks();
      assert.equal(f.pending.length, 2);
      assert.equal(f.pending[1].message.settingsSnapshot.targetLanguage, 'Korean');
      page.button('restore').click();
      assert.equal(page.button('translate').textContent, 'Open controls for Japanese');
    },
  },
  {
    name: 'retired messages cannot replace the external translation snapshot',
    fn() {
      const f = createOperationFixture();
      const page = createContentPage(f);
      page.inject();
      const before = page.snapshot();
      assert.equal(page.message({ type: 'INLINE_TRANSLATION_PROGRESS', progress: 'obsolete' }), undefined);
      assert.deepEqual(page.snapshot(), before);
    },
  },
);
