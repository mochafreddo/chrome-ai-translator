const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const helpers = require('../extension/sidepanel.js');

exports.name = 'sidepanel helpers';
exports.tests = [
  {
    name: 'provides an accessible save-owned feedback boundary',
    fn() {
      const html = fs.readFileSync(
        path.join(__dirname, '..', 'extension', 'sidepanel.html'),
        'utf8'
      );

      assert.match(
        html,
        /id="btnSave"[^>]*aria-describedby="saveStatus saveError"/
      );
      assert.match(
        html,
        /id="saveStatus"[^>]*role="status"[^>]*aria-live="polite"/
      );
      assert.match(html, /id="saveError"[^>]*role="alert"[^>]*hidden/);
    },
  },
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

      const translating = helpers.getInlineTranslationPanelViewModel({
        snapshot: { status: 'translating', progress: 'Chunk 1/3' },
      });
      assert.equal(translating.startText, 'Translating...');
      assert.equal(translating.startDisabled, true);

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
          error: 'Click the extension icon on this tab, then try again.',
        }).errorText,
        'Click the extension icon on this tab, then try again.'
      );
    },
  },
  {
    name: 'saves settings and renders success',
    async fn() {
      const sent = [];
      const rendered = [];
      const settings = {
        targetLanguage: 'Korean',
        tone: 'technical',
        model: 'gpt-5.4-mini',
        viewMode: 'translation',
      };
      const controller = helpers.createSettingsSaveController({
        async sendMessage(message) {
          sent.push(message);
          return { ok: true };
        },
        readSettings: () => settings,
        render: (state) => rendered.push(state),
      });

      assert.equal(await controller.save(), true);
      assert.deepEqual(sent, [{ type: 'SAVE_SETTINGS', settings }]);
      assert.deepEqual(rendered, [
        { saving: true, status: 'Saving...', error: '' },
        { saving: false, status: 'Saved.', error: '' },
      ]);
      assert.equal(controller.isSaving(), false);
    },
  },
  {
    name: 'renders a generic error when saving settings is rejected',
    async fn() {
      const rendered = [];
      const reflectedSecret = 'sk-reflected-rejection-secret';
      const controller = helpers.createSettingsSaveController({
        sendMessage: async () => {
          throw new Error(`Runtime rejected ${reflectedSecret}`);
        },
        readSettings: () => ({ model: 'private-model-name' }),
        render: (state) => rendered.push(state),
      });

      assert.equal(await controller.save(), false);
      assert.deepEqual(rendered[0], {
        saving: true,
        status: 'Saving...',
        error: '',
      });
      assert.deepEqual(rendered[1], {
        saving: false,
        status: '',
        error: 'Failed to save settings.',
      });
      assert.doesNotMatch(
        JSON.stringify(rendered),
        /sk-reflected|private-model/
      );
      assert.equal(controller.isSaving(), false);
    },
  },
  {
    name: 'renders a generic error when saving settings is unsuccessful',
    async fn() {
      const rendered = [];
      const controller = helpers.createSettingsSaveController({
        sendMessage: async () => ({
          ok: false,
          error: {
            message:
              'Settings could not be saved for sk-reflected-response-secret.',
          },
        }),
        readSettings: () => ({ targetLanguage: 'Private target' }),
        render: (state) => rendered.push(state),
      });

      assert.equal(await controller.save(), false);
      assert.deepEqual(rendered[1], {
        saving: false,
        status: '',
        error: 'Failed to save settings.',
      });
      assert.doesNotMatch(
        JSON.stringify(rendered),
        /sk-reflected|Private target/
      );
      assert.equal(controller.isSaving(), false);
    },
  },
  {
    name: 'shares one in-flight save across duplicate clicks',
    async fn() {
      const sent = [];
      const rendered = [];
      let settingsReads = 0;
      let resolveRequest;
      const request = new Promise((resolve) => {
        resolveRequest = resolve;
      });
      const controller = helpers.createSettingsSaveController({
        sendMessage(message) {
          sent.push(message);
          return request;
        },
        readSettings() {
          settingsReads += 1;
          return { targetLanguage: 'Korean' };
        },
        render: (state) => rendered.push(state),
      });

      const first = controller.save();
      const second = controller.save();

      assert.equal(first, second);
      assert.equal(controller.isSaving(), true);
      assert.equal(sent.length, 0);
      assert.deepEqual(rendered[0], {
        saving: true,
        status: 'Saving...',
        error: '',
      });

      await Promise.resolve();
      assert.equal(sent.length, 1);
      assert.equal(settingsReads, 1);
      resolveRequest({ ok: true });
      assert.equal(await first, true);
      assert.equal(controller.isSaving(), false);
    },
  },
  {
    name: 'allows one new settings read and request after a save settles',
    async fn() {
      let settingsReads = 0;
      let requests = 0;
      const controller = helpers.createSettingsSaveController({
        async sendMessage() {
          requests += 1;
          return { ok: requests > 1 };
        },
        readSettings() {
          settingsReads += 1;
          return { targetLanguage: 'Korean' };
        },
        render() {},
      });

      assert.equal(await controller.save(), false);
      assert.equal(await controller.save(), true);
      assert.equal(requests, 2);
      assert.equal(settingsReads, 2);
    },
  },
  {
    name: 'formats bilingual panel with original and translated text',
    fn() {
      const output = helpers.formatTranslatedPanelText(
        {
          extracted: { contentMarkdown: '# Original\n\nHello world.\n' },
          translated: '# Translation\n\n안녕하세요.\n',
        },
        'bilingual'
      );

      assert.equal(
        output,
        'Original\n\n# Original\n\nHello world.\n\nTranslation\n\n# Translation\n\n안녕하세요.'
      );
    },
  },
  {
    name: 'formats translation-only panel with translated text',
    fn() {
      assert.equal(
        helpers.formatTranslatedPanelText(
          {
            extracted: { contentMarkdown: '# Original\n' },
            translated: '# Translation\n',
          },
          'translation'
        ),
        '# Translation'
      );
    },
  },
  {
    name: 'clears original panel text for idle tab state',
    fn() {
      assert.equal(helpers.formatOriginalPanelText({ status: 'idle' }), '');
      assert.equal(
        helpers.formatOriginalPanelText({
          extracted: { contentMarkdown: '# Original\n\nHello world.\n' },
        }),
        '# Original\n\nHello world.\n'
      );
    },
  },
  {
    name: 'describes empty sidepanel state with an actionable message',
    fn() {
      const state = helpers.getSidepanelDisplayState({ status: 'idle' });

      assert.equal(state.statusText, 'Idle');
      assert.equal(state.translateDisabled, false);
      assert.equal(state.translateButtonText, 'Translate current tab');
      assert.match(state.translatedText, /No translation yet/);
      assert.match(state.translatedText, /Translate current tab/);
    },
  },
  {
    name: 'locks translation action and shows progress while busy',
    fn() {
      const state = helpers.getSidepanelDisplayState({
        status: 'translating',
        progress: { current: 2, total: 5 },
      });

      assert.equal(state.statusText, 'Translating');
      assert.equal(state.translateDisabled, true);
      assert.equal(state.translateButtonText, 'Translating...');
      assert.equal(state.progressText, 'Chunk 2/5');
      assert.match(state.translatedText, /Translating current tab/);
    },
  },
  {
    name: 'keeps save feedback and fields independent from translation state',
    async fn() {
      const previousChrome = global.chrome;
      const previousDocument = global.document;
      const previousSetInterval = global.setInterval;
      const modulePath = require.resolve('../extension/sidepanel.js');
      const originalModule = require.cache[modulePath];
      const elements = new Map();
      const savedMessages = [];
      let resolveFirstSave;
      let refreshInterval;
      let runtimeListener;
      const firstSave = new Promise((resolve) => {
        resolveFirstSave = resolve;
      });

      function getElement(id) {
        if (!elements.has(id)) {
          elements.set(id, {
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
          });
        }
        return elements.get(id);
      }

      global.setInterval = (callback) => {
        refreshInterval = callback;
        return 0;
      };
      global.document = {
        getElementById: getElement,
        querySelectorAll(selector) {
          if (selector !== '.tab') return [];
          return [
            {
              dataset: { tab: 'translated' },
              setAttribute() {},
              addEventListener() {},
            },
            {
              dataset: { tab: 'original' },
              setAttribute() {},
              addEventListener() {},
            },
          ];
        },
      };
      global.chrome = {
        tabs: {
          async query() {
            return [{ id: 77 }];
          },
        },
        runtime: {
          onMessage: {
            addListener(listener) {
              runtimeListener = listener;
            },
          },
          openOptionsPage() {},
          async sendMessage(message) {
            if (message.type === 'GET_SETTINGS') {
              return {
                ok: true,
                settings: {
                  targetLanguage: 'Korean',
                  tone: 'technical',
                  model: 'gpt-5.4-mini',
                  viewMode: 'translation',
                },
              };
            }
            if (message.type === 'GET_STATE') {
              return { ok: true, state: { status: 'idle' } };
            }
            if (message.type === 'TRANSLATE_TAB') {
              return {
                ok: false,
                error: { message: 'Cannot run on this page.' },
              };
            }
            if (message.type === 'SAVE_SETTINGS') {
              savedMessages.push(message);
              if (savedMessages.length === 1) return firstSave;
              return { ok: true };
            }
            return { ok: true };
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/sidepanel.js');
        // Wait for the panel to finish starting up rather than for a fixed number of
        // ticks: the last thing it does is register the refresh interval, and letting the
        // fakes be torn down before then leaves a real one-second timer running.
        for (let i = 0; i < 64 && !refreshInterval; i += 1) {
          await Promise.resolve();
        }
        assert.equal(typeof refreshInterval, 'function');

        getElement('targetLanguage').value = 'Private target';
        getElement('tone').value = 'natural';
        getElement('model').value = 'private-model-name';
        getElement('viewMode').value = 'bilingual';

        const saveClick = getElement('btnSave').listeners.click;
        assert.equal(typeof saveClick, 'function');
        saveClick();
        await Promise.resolve();

        assert.equal(savedMessages.length, 1);
        assert.equal(getElement('btnSave').disabled, true);
        assert.equal(getElement('saveStatus').textContent, 'Saving...');
        assert.equal(getElement('status').textContent, 'Idle');

        refreshInterval();
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
        assert.equal(getElement('status').textContent, 'Idle');
        assert.equal(getElement('saveStatus').textContent, 'Saving...');

        runtimeListener({
          type: 'STATE_UPDATED',
          tabId: 77,
          state: { status: 'translating' },
        });
        assert.equal(getElement('status').textContent, 'Translating');
        assert.equal(getElement('saveStatus').textContent, 'Saving...');

        resolveFirstSave({
          ok: false,
          error: {
            message:
              'Reflected sk-sidepanel-secret Private target private-model-name',
          },
        });
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }

        assert.equal(getElement('btnSave').disabled, false);
        assert.equal(getElement('status').textContent, 'Translating');
        assert.equal(getElement('saveStatus').textContent, '');
        assert.equal(
          getElement('saveError').textContent,
          'Failed to save settings.'
        );
        assert.equal(getElement('saveError').hidden, false);
        assert.equal(getElement('targetLanguage').value, 'Private target');
        assert.equal(getElement('tone').value, 'natural');
        assert.equal(getElement('model').value, 'private-model-name');
        assert.equal(getElement('viewMode').value, 'bilingual');
        assert.doesNotMatch(
          `${getElement('saveStatus').textContent} ${
            getElement('saveError').textContent
          }`,
          /sk-sidepanel|Private target|private-model/
        );

        saveClick();
        for (let i = 0; i < 8; i += 1) {
          await Promise.resolve();
        }
        assert.equal(savedMessages.length, 2);
        assert.deepEqual(savedMessages[1], {
          type: 'SAVE_SETTINGS',
          settings: {
            targetLanguage: 'Private target',
            tone: 'natural',
            model: 'private-model-name',
            viewMode: 'bilingual',
          },
        });
        assert.equal(getElement('saveStatus').textContent, 'Saved.');
        assert.equal(getElement('saveError').hidden, true);
        assert.equal(getElement('status').textContent, 'Translating');

        refreshInterval();
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
        assert.equal(getElement('status').textContent, 'Idle');
        assert.equal(getElement('saveStatus').textContent, 'Saved.');

        const click = getElement('btnTranslate').listeners.click;
        assert.equal(typeof click, 'function');

        await Promise.resolve(click());
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }

        assert.equal(getElement('errorBox').hidden, false);
        assert.equal(getElement('errorBox').textContent, 'Cannot run on this page.');
        assert.equal(getElement('btnTranslate').disabled, false);
        assert.equal(getElement('saveStatus').textContent, 'Saved.');
      } finally {
        global.chrome = previousChrome;
        global.document = previousDocument;
        global.setInterval = previousSetInterval;
        delete require.cache[modulePath];
        if (originalModule) require.cache[modulePath] = originalModule;
      }
    },
  },
  {
    name: 'drives Inline Translation from the panel without the Floating Translate Button',
    async fn() {
      // The whole section, exercised the way a reader would: the three controls, and the
      // progress and errors the tab reports back. Nothing here touches the button.
      const previousChrome = global.chrome;
      const previousDocument = global.document;
      const previousSetInterval = global.setInterval;
      const modulePath = require.resolve('../extension/sidepanel.js');
      const originalModule = require.cache[modulePath];
      const elements = new Map();
      const controls = [];
      let refreshInterval;
      let snapshot = { status: 'original', progress: '', error: '' };
      let controlResponse = { ok: true };

      function getElement(id) {
        if (!elements.has(id)) {
          elements.set(id, {
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
          });
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
        getElementById: getElement,
        querySelectorAll: () => [],
      };
      global.chrome = {
        tabs: {
          async query() {
            return [{ id: 77 }];
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
              return { ok: true, state: { status: 'idle' } };
            }
            if (message.type === 'GET_INLINE_TRANSLATION_STATE') {
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

        assert.equal(getElement('btnInlineTranslate').textContent, 'Translate visible text');
        assert.equal(getElement('btnInlineStop').disabled, true);
        assert.equal(getElement('btnInlineRestore').disabled, true);

        snapshot = { status: 'active', progress: 'Translated 3 blocks.', error: '' };
        getElement('btnInlineTranslate').listeners.click();
        await settle();

        assert.deepEqual(controls, [
          { type: 'RUN_INLINE_TRANSLATION_CONTROL', tabId: 77, control: 'start' },
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
