const assert = require('node:assert/strict');
const helpers = require('../extension/content.js');

exports.name = 'content helpers';
exports.tests = [
  {
    name: 'detects excluded inline code tags',
    fn() {
      assert.equal(helpers.isInlineTranslationExcludedTag('CODE'), true);
      assert.equal(helpers.isInlineTranslationExcludedTag('p'), false);
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
];
