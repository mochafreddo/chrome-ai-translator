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
];
