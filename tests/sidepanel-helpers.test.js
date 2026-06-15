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
];
