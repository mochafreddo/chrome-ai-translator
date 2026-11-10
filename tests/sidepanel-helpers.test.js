const assert = require('node:assert/strict');
const helpers = require('../extension/sidepanel.js');
const background = require('../extension/background.js');
const { createTestDocument } = require('./inline-block.test');

// The one thing the reader has to do to put a tab within reach, in the words both the panel
// and a failed injection are expected to use.
const MISSING_ACCESS_VOCABULARY =
  'The extension does not have access to this tab. Click the extension icon on this tab';

exports.name = 'sidepanel helpers';
exports.tests = [
  {
    name: 'offers Inline Translation from a state the panel has not heard about yet',
    fn() {
      // The panel opens before it has asked the tab anything, and the reader may press a
      // control in that gap. Nothing is under way, so starting is the only thing on offer.
      const model = helpers.getInlineTranslationPanelViewModel();

      assert.equal(model.startText, 'Translate visible text');
      assert.equal(model.startDisabled, false);
      assert.equal(model.stopDisabled, true);
      assert.equal(model.restoreDisabled, true);
      assert.equal(model.statusText, '');
      assert.equal(model.errorText, '');
    },
  },
  {
    name: 'offers stopping and restoring only once Inline Translation has run',
    fn() {
      const active = helpers.getInlineTranslationPanelViewModel({
        snapshot: { status: 'active', progress: 'Translated 3 blocks.' },
      });
      assert.equal(active.startText, 'Scan visible text');
      assert.equal(active.startDisabled, false);
      assert.equal(active.stopDisabled, false);
      assert.equal(active.restoreDisabled, false);
      assert.equal(active.statusText, 'Translated 3 blocks.');

      const stopped = helpers.getInlineTranslationPanelViewModel({
        snapshot: { status: 'stopped' },
      });
      assert.equal(stopped.stopDisabled, true);
      assert.equal(stopped.restoreDisabled, false);

      const original = helpers.getInlineTranslationPanelViewModel({
        snapshot: { status: 'original' },
      });
      assert.equal(original.stopDisabled, true);
      assert.equal(original.restoreDisabled, true);
    },
  },
  {
    name: 'offers no Inline Translation control on a tab it cannot reach',
    fn() {
      // Page access is granted per tab and the panel outlives the tab it opened on. None of
      // the three controls can reach a tab the extension has not been invoked on, so the
      // section dims all three and says what to do instead of taking a click that cannot
      // succeed.
      const model = helpers.getInlineTranslationPanelViewModel({
        hasPageAccess: false,
        // Whatever the panel last heard was about a tab it can still reach; this one has
        // told it nothing, and the guidance is the whole account of why. A shortcut press
        // this tab refused is the same missing grant read from a third direction, and
        // three accounts of one problem read no better than two.
        controlError: 'Inline translation did not answer on this tab.',
        invocationError: 'Click the extension icon on this tab, then try again.',
      });

      assert.equal(model.startDisabled, true);
      assert.equal(model.stopDisabled, true);
      assert.equal(model.restoreDisabled, true);
      assert.match(model.statusText, /Click the extension icon on this tab/);
      assert.equal(model.errorText, '');
    },
  },
  {
    name: 'tells a tab that refused a gesture apart from one nothing has been asked of',
    fn() {
      // The Inline Translation Shortcut is pressed on the page, so on a tab out of reach
      // the section is the whole of what the reader sees of it. Guidance that reads the
      // same either way would leave a refused shortcut indistinguishable from never having
      // pressed one — which is the silence this section exists to end.
      const untouched = helpers.getInlineTranslationPanelViewModel({
        hasPageAccess: false,
      });
      const refusedTheShortcut = helpers.getInlineTranslationPanelViewModel({
        hasPageAccess: false,
        invocationError: 'Click the extension icon on this tab, then try again.',
      });
      const refusedAControl = helpers.getInlineTranslationPanelViewModel({
        hasPageAccess: false,
        controlError: 'Click the extension icon on this tab, then try again.',
      });

      for (const model of [untouched, refusedTheShortcut, refusedAControl]) {
        assert.equal(model.statusText.startsWith(MISSING_ACCESS_VOCABULARY), true);
        // One account of one problem, wherever the reader arrived from.
        assert.equal(model.errorText, '');
      }

      // Nothing has been pressed, so there is nothing to try again.
      assert.match(untouched.statusText, /to use these controls\.$/);
      assert.match(refusedTheShortcut.statusText, /then try again\.$/);
      assert.match(refusedAControl.statusText, /then try again\.$/);
    },
  },
  {
    name: 'asks for access in the words a failed injection already uses',
    fn() {
      // The reader meets one missing grant from two directions — dimmed controls before any
      // gesture, an injection failure after one. Two accounts of it would read as two
      // problems.
      const guidance = helpers.getInlineTranslationPanelViewModel({
        hasPageAccess: false,
      }).statusText;
      const failure = background.classifyContentScriptFailure(
        new Error('Cannot access contents of the page at url "https://example.com/".'),
        'https://example.com/'
      );

      assert.equal(failure.reason, 'missing_access');
      assert.equal(guidance.startsWith(MISSING_ACCESS_VOCABULARY), true);
      assert.equal(failure.message.startsWith(MISSING_ACCESS_VOCABULARY), true);
    },
  },
  {
    name: 'shows the page its own Inline Translation errors, latest gesture first',
    fn() {
      assert.equal(
        helpers.getInlineTranslationPanelViewModel({
          snapshot: {
            status: 'original',
            error: 'Open Options and paste your OpenAI API key.',
          },
        }).errorText,
        'Open Options and paste your OpenAI API key.'
      );

      // A control the tab never received has no page state to report it, so the panel's
      // own account of the click it just made takes precedence.
      assert.equal(
        helpers.getInlineTranslationPanelViewModel({
          snapshot: { status: 'original', error: 'Stale page error.' },
          controlError: 'Click the extension icon on this tab, then try again.',
        }).errorText,
        'Click the extension icon on this tab, then try again.'
      );
    },
  },
  {
    name: 'shows a start the Inline Translation Shortcut could not make',
    fn() {
      // The shortcut is not pressed in the panel, so the worker's per-tab state is the
      // only way its outcome reaches the section — and the section is the only place
      // Inline Translation reports.
      assert.equal(
        helpers.getInlineTranslationPanelViewModel({
          invocationError: 'Click the extension icon on this tab, then try again.',
        }).errorText,
        'Click the extension icon on this tab, then try again.'
      );

      // A click the reader made in the panel is more recent than any shortcut press the
      // panel can still be holding, and the tab's own state is older than both.
      assert.equal(
        helpers.getInlineTranslationPanelViewModel({
          snapshot: { status: 'original', error: 'Stale page error.' },
          controlError: 'The click just made.',
          invocationError: 'The shortcut pressed before it.',
        }).errorText,
        'The click just made.'
      );
      assert.equal(
        helpers.getInlineTranslationPanelViewModel({
          snapshot: { status: 'original', error: 'Stale page error.' },
          invocationError: 'The shortcut pressed before it.',
        }).errorText,
        'The shortcut pressed before it.'
      );
    },
  },
  {
    name: 'drives Inline Translation from the panel without the Floating Translate Button',
    async fn() {
      // The whole section, exercised the way a reader would: the three controls, the
      // progress and errors the tab reports back, and a switch to a tab that has never
      // heard of the extension. Nothing here touches the button.
      const previousChrome = global.chrome;
      const previousDocument = global.document;
      const previousSetInterval = global.setInterval;
      const modulePath = require.resolve('../extension/sidepanel.js');
      const originalModule = require.cache[modulePath];
      const { document: fixtureDocument } = createTestDocument();
      const elements = new Map();
      const controls = [];
      let refreshInterval;
      let activeTabId = 77;
      let tabIsReachable = true;
      let snapshot = { status: 'original', progress: '', error: '' };
      let controlResponse = { ok: true };

      function getElement(id) {
        if (!elements.has(id)) {
          elements.set(id, Object.assign(fixtureDocument.createElement('div'), {
            id,
            value: '',
            textContent: '',
            hidden: false,
            disabled: false,
            dataset: {},
            listeners: {},
            addEventListener(event, listener) {
              this.listeners[event] = listener;
            },
            setAttribute(name, value) {
              this[name] = value;
            },
          }));
        }
        return elements.get(id);
      }

      async function settle() {
        for (let i = 0; i < 32; i += 1) {
          await Promise.resolve();
        }
      }

      global.setInterval = (callback) => {
        refreshInterval = callback;
        return 0;
      };
      global.document = {
        createElement: tag => fixtureDocument.createElement(tag),
        getElementById: getElement,
        querySelectorAll: () => [],
      };
      global.chrome = {
        webNavigation: { getFrame: async ({ tabId }) => ({ documentId: 'doc-' + tabId }), onCommitted: { addListener() {} } },
        storage: { onChanged: { addListener() {} } },
        windows: { getCurrent: async () => ({ id: 10 }) },
        tabs: {
          onActivated: { addListener() {} },
          async query() {
            return [{ id: activeTabId }];
          },
        },
        runtime: {
          onMessage: { addListener() {} },
          openOptionsPage() {},
          async sendMessage(message) {
            if (message.type === 'GET_SETTINGS') {
              return { ok: true, settings: { targetLanguage: 'Korean' } };
            }
            if (message.type === 'GET_STATE') {
              return { ok: true, state: { workerEpoch: 'worker-fixture', stateSequence: 1 } };
            }
            if (message.type === 'GET_INLINE_TRANSLATION_STATE') {
              // Nothing answers in a tab the extension has never been invoked on, which is
              // how the worker reports one.
              if (!tabIsReachable) return { ok: false, snapshot: null };
              return { ok: true, snapshot };
            }
            if (message.type === 'RUN_INLINE_TRANSLATION_CONTROL') {
              controls.push(message);
              return controlResponse;
            }
            return { ok: true };
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/sidepanel.js');
        for (let i = 0; i < 64 && !refreshInterval; i += 1) {
          await Promise.resolve();
        }

        await refreshInterval();
        assert.equal(getElement('btnInlineTranslate').disabled, false);
        assert.equal(getElement('btnInlineTranslate').textContent, 'Translate visible text');
        assert.equal(getElement('btnInlineStop').disabled, true);
        assert.equal(getElement('btnInlineRestore').disabled, true);

        snapshot = { status: 'active', progress: 'Translated 3 blocks.', error: '' };
        getElement('btnInlineTranslate').listeners.click();
        await settle();

        assert.deepEqual(controls, [
          { type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 77, documentId: 'doc-77', control: 'start' },
        ]);
        assert.equal(getElement('inlineStatus').textContent, 'Translated 3 blocks.');
        assert.equal(getElement('btnInlineTranslate').textContent, 'Scan visible text');
        assert.equal(getElement('btnInlineStop').disabled, false);
        assert.equal(getElement('btnInlineRestore').disabled, false);
        assert.equal(getElement('inlineError').hidden, true);

        snapshot = { status: 'stopped', progress: 'Stopped after 3 blocks.', error: '' };
        getElement('btnInlineStop').listeners.click();
        await settle();

        assert.equal(controls[1].control, 'stop');
        assert.equal(getElement('inlineStatus').textContent, 'Stopped after 3 blocks.');
        assert.equal(getElement('btnInlineStop').disabled, true);
        assert.equal(getElement('btnInlineRestore').disabled, false);

        snapshot = { status: 'original', progress: '', error: '' };
        getElement('btnInlineRestore').listeners.click();
        await settle();

        assert.equal(controls[2].control, 'restore');
        assert.equal(getElement('inlineStatus').textContent, '');
        assert.equal(getElement('btnInlineRestore').disabled, true);

        // An error the page reports for itself reaches the panel on the next poll, which
        // is the only place either side shows it.
        snapshot = {
          status: 'original',
          progress: '',
          error: 'Open Options and paste your OpenAI API key.',
        };
        refreshInterval();
        await settle();
        assert.equal(getElement('inlineError').hidden, false);
        assert.equal(
          getElement('inlineError').textContent,
          'Open Options and paste your OpenAI API key.'
        );

        // A control the tab never received leaves no page state behind to report it.
        controlResponse = {
          ok: false,
          error: {
            message:
              'The extension does not have access to this tab. Click the extension icon on this tab, then try again.',
          },
        };
        getElement('btnInlineTranslate').listeners.click();
        await settle();

        assert.equal(controls.length, 4);
        assert.match(getElement('inlineError').textContent, /Click the extension icon/);
        assert.equal(getElement('inlineError').hidden, false);

        // The reader switches to a tab the extension has never been invoked on. The panel
        // stays open across the switch; the access does not come with it.
        activeTabId = 78;
        tabIsReachable = false;
        refreshInterval();
        await settle();

        assert.equal(getElement('btnInlineTranslate').disabled, true);
        assert.equal(getElement('btnInlineStop').disabled, true);
        assert.equal(getElement('btnInlineRestore').disabled, true);
        assert.match(getElement('inlineStatus').textContent, /Click the extension icon on this tab/);
        assert.equal(getElement('inlineError').hidden, true);

        // Which is what clicking the extension icon on that tab puts right.
        tabIsReachable = true;
        snapshot = { status: 'original', progress: '', error: '' };
        refreshInterval();
        await settle();

        assert.equal(getElement('btnInlineTranslate').disabled, false);
        assert.equal(getElement('inlineStatus').textContent, '');
        assert.equal(controls.length, 4);

        // Losing and regaining access on one tab: the reader is told about the tab as it is
        // now, not reminded of what was wrong with it before they fixed it.
        controlResponse = {
          ok: false,
          error: {
            message:
              'The extension does not have access to this tab. Click the extension icon on this tab, then try again.',
          },
        };
        getElement('btnInlineTranslate').listeners.click();
        await settle();
        assert.equal(getElement('inlineError').hidden, false);

        tabIsReachable = false;
        refreshInterval();
        await settle();
        assert.equal(getElement('inlineError').hidden, true);

        tabIsReachable = true;
        refreshInterval();
        await settle();

        assert.equal(getElement('inlineError').hidden, true);
        assert.equal(getElement('inlineError').textContent, '');
        assert.equal(getElement('btnInlineTranslate').disabled, false);
      } finally {
        global.chrome = previousChrome;
        global.document = previousDocument;
        global.setInterval = previousSetInterval;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
];
