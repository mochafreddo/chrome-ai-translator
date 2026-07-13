const assert = require('node:assert/strict');
const helpers = require('../extension/sidepanel.js');

exports.name = 'sidepanel helpers';
exports.tests = [
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
    name: 'renders a bounded error when saving settings is rejected',
    async fn() {
      const rendered = [];
      const longMessage = 'x'.repeat(350);
      const controller = helpers.createSettingsSaveController({
        sendMessage: async () => {
          throw new Error(longMessage);
        },
        readSettings: () => ({ targetLanguage: 'Korean' }),
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
        error: 'x'.repeat(300),
      });
      assert.equal(controller.isSaving(), false);
    },
  },
  {
    name: 'renders the runtime error when saving settings is unsuccessful',
    async fn() {
      const rendered = [];
      const controller = helpers.createSettingsSaveController({
        sendMessage: async () => ({
          ok: false,
          error: { message: 'Settings could not be saved.' },
        }),
        readSettings: () => ({ targetLanguage: 'Korean' }),
        render: (state) => rendered.push(state),
      });

      assert.equal(await controller.save(), false);
      assert.deepEqual(rendered[1], {
        saving: false,
        status: '',
        error: 'Settings could not be saved.',
      });
      assert.equal(controller.isSaving(), false);
    },
  },
  {
    name: 'shares one in-flight save across duplicate clicks',
    async fn() {
      const sent = [];
      const rendered = [];
      let resolveRequest;
      const request = new Promise((resolve) => {
        resolveRequest = resolve;
      });
      const controller = helpers.createSettingsSaveController({
        sendMessage(message) {
          sent.push(message);
          return request;
        },
        readSettings: () => ({ targetLanguage: 'Korean' }),
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
      resolveRequest({ ok: true });
      assert.equal(await first, true);
      assert.equal(controller.isSaving(), false);
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
    name: 'shows translation request failures from the click handler',
    async fn() {
      const previousChrome = global.chrome;
      const previousDocument = global.document;
      const previousSetInterval = global.setInterval;
      const modulePath = require.resolve('../extension/sidepanel.js');
      const originalModule = require.cache[modulePath];
      const elements = new Map();

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

      global.setInterval = () => 0;
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
          onMessage: { addListener() {} },
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
            return { ok: true };
          },
        },
      };

      try {
        delete require.cache[modulePath];
        require('../extension/sidepanel.js');
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }
        const click = getElement('btnTranslate').listeners.click;
        assert.equal(typeof click, 'function');

        await Promise.resolve(click());
        for (let i = 0; i < 4; i += 1) {
          await Promise.resolve();
        }

        assert.equal(getElement('errorBox').hidden, false);
        assert.equal(getElement('errorBox').textContent, 'Cannot run on this page.');
        assert.equal(getElement('btnTranslate').disabled, false);
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
