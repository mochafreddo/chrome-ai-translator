const assert = require('node:assert/strict');
const {
  ALL_SITES_ORIGINS,
  BUTTON_VISIBILITY,
  readButtonVisibility,
} = require('../extension/button-visibility.js');

const BUTTON_VISIBILITY_CHOICES = Object.values(BUTTON_VISIBILITY);

exports.name = 'button visibility';
exports.tests = [
  {
    name: 'offers exactly three exclusive choices',
    fn() {
      assert.deepEqual(BUTTON_VISIBILITY_CHOICES, [
        'never',
        'onInvocation',
        'allPages',
      ]);
    },
  },
  {
    name: 'names the ordinary web pages the all-pages choice needs',
    fn() {
      // The options page asks for these and the worker matches its content script against
      // them; the extension can never be granted anything else.
      assert.deepEqual(ALL_SITES_ORIGINS, ['http://*/*', 'https://*/*']);
    },
  },
  {
    name: 'never shows the button on a fresh install',
    fn() {
      assert.equal(readButtonVisibility(undefined), BUTTON_VISIBILITY.NEVER);
      assert.equal(readButtonVisibility(null), BUTTON_VISIBILITY.NEVER);
      assert.equal(readButtonVisibility({}), BUTTON_VISIBILITY.NEVER);
    },
  },
  {
    name: 'keeps a choice the reader has made',
    fn() {
      for (const choice of BUTTON_VISIBILITY_CHOICES) {
        assert.equal(
          readButtonVisibility({ buttonVisibility: choice }),
          choice
        );
      }
    },
  },
  {
    name: 'maps the old checkbox being on to all pages',
    fn() {
      assert.equal(
        readButtonVisibility({ inlineAutoShow: true }),
        BUTTON_VISIBILITY.ALL_PAGES
      );
    },
  },
  {
    name: 'maps the old checkbox being off or absent to never',
    fn() {
      assert.equal(
        readButtonVisibility({ inlineAutoShow: false }),
        BUTTON_VISIBILITY.NEVER
      );
      assert.equal(
        readButtonVisibility({ targetLanguage: 'Korean' }),
        BUTTON_VISIBILITY.NEVER
      );
    },
  },
  {
    name: 'prefers the three-state choice over the old checkbox',
    fn() {
      // A migrated install keeps the boolean in storage until the next save, and the
      // choice the reader has since made must win over it.
      assert.equal(
        readButtonVisibility({
          buttonVisibility: BUTTON_VISIBILITY.NEVER,
          inlineAutoShow: true,
        }),
        BUTTON_VISIBILITY.NEVER
      );
    },
  },
  {
    name: 'falls back for a stored value outside the three choices',
    fn() {
      assert.equal(
        readButtonVisibility({ buttonVisibility: 'always' }),
        BUTTON_VISIBILITY.NEVER
      );
      assert.equal(
        readButtonVisibility({ buttonVisibility: true, inlineAutoShow: true }),
        BUTTON_VISIBILITY.ALL_PAGES
      );
    },
  },
];
