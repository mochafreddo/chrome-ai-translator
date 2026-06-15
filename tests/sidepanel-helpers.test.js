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
];
