const assert = require('node:assert/strict');
const helpers = require('../extension/sidepanel.js');

exports.name = 'sidepanel helpers';
exports.tests = [
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
