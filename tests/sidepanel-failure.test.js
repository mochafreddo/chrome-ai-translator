const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  SIDE_PANEL_FAILURE_MESSAGES,
  describeSidePanelFailure,
} = require('../extension/sidepanel-failure.js');
const background = require('../extension/background.js');

const EXTENSION_DIR = path.join(__dirname, '..', 'extension');

function readExtensionFile(name) {
  return fs.readFileSync(path.join(EXTENSION_DIR, name), 'utf8');
}

exports.name = 'side panel failure wording';
exports.tests = [
  {
    name: 'tells the reader what a lost Markdown token means, and keeps the code',
    fn() {
      // The code alone is what the reader reads today. It still earns a place — this is a
      // personal extension, so the reader is the one who would report the bug — but it
      // belongs after the sentence, not instead of it.
      assert.equal(
        describeSidePanelFailure({
          message: 'markdown.token_missing',
          code: 'markdown.token_missing',
        }),
        'The translation lost a link or code marker. Try again. (markdown.token_missing)'
      );
    },
  },
  {
    name: 'keeps the four ways a Markdown token comes back wrong apart',
    fn() {
      // Four separate failures, and the reader can act on the difference: a marker the
      // translation invented is a different thing to look at than one it dropped.
      const expected = [
        [
          'markdown.token_duplicate',
          'The translation repeated a link or code marker. Try again. (markdown.token_duplicate)',
        ],
        [
          'markdown.token_unknown',
          'The translation added a link or code marker the page never had. Try again. (markdown.token_unknown)',
        ],
        [
          'markdown.token_nesting_invalid',
          'The translation put the start and end of a link or code marker out of order. Try again. (markdown.token_nesting_invalid)',
        ],
      ];

      for (const [code, sentence] of expected) {
        assert.equal(describeSidePanelFailure({ message: code, code }), sentence);
      }
    },
  },
  {
    name: 'says something for a failure it has no sentence for',
    fn() {
      // Every Side Panel Translation failure comes through here, and most of them already
      // say something for themselves. Those keep their own words and gain the code; only a
      // failure that says nothing a reader can use falls back to the general sentence.
      assert.equal(
        describeSidePanelFailure({
          message: 'A Markdown segment is too large to split safely.',
          code: 'markdown.segment_too_large',
        }),
        'A Markdown segment is too large to split safely. (markdown.segment_too_large)'
      );
      assert.equal(
        describeSidePanelFailure({
          message: 'OpenAI API key is not set. Open Options and paste your key.',
        }),
        'OpenAI API key is not set. Open Options and paste your key.'
      );
      // A code that has outrun the wording, reaching the panel as its own message: the
      // reader gets the general sentence and keeps the code to report.
      assert.equal(
        describeSidePanelFailure({
          message: 'markdown.token_invented_tomorrow',
          code: 'markdown.token_invented_tomorrow',
        }),
        'The translation stopped before it finished. Try again. (markdown.token_invented_tomorrow)'
      );
      assert.equal(
        describeSidePanelFailure({}),
        'The translation stopped before it finished. Try again.'
      );
    },
  },
  {
    name: 'carries the failure code from the worker as far as the panel',
    fn() {
      // The wording above can only be reached if the code survives the trip. The worker
      // prepares the error and then strips the state down to what the panel may see, and
      // either step dropping the code leaves the panel with the code as its whole message.
      const failure = new Error('markdown.token_missing');
      failure.code = 'markdown.token_missing';

      const state = background.sanitizePublicTabState({
        status: 'error',
        error: background.safeError(failure),
      });

      assert.equal(state.error.code, 'markdown.token_missing');
      assert.equal(
        describeSidePanelFailure(state.error),
        'The translation lost a link or code marker. Try again. (markdown.token_missing)'
      );
    },
  },
  {
    name: 'lets no more of a failure than the code through to the panel',
    fn() {
      // The panel is told what the reader may read, not everything the worker knows. A
      // stack trace names the extension's own files and belongs in neither.
      const failure = new Error('markdown.token_missing');
      failure.code = 'markdown.token_missing';
      failure.apiKey = 'sk-should-never-travel';

      const state = background.sanitizePublicTabState({
        status: 'error',
        error: background.safeError(failure),
      });

      assert.deepEqual(Object.keys(state.error).sort(), ['code', 'message', 'name']);
    },
  },
  {
    name: 'has a sentence for each Markdown token failure the worker raises',
    fn() {
      // These four are the failures raised with the code as their whole message, so a fifth
      // added without wording here reaches the reader as a code again. Nothing else would
      // report that. A failure raised any other way falls to the general sentence instead,
      // which is why this guard is drawn around this one way of raising them.
      //
      // The codec now decides these four in the module it shares with the inline codec and
      // spells them in one map on the way out, so both shapes are read: the map's values, and
      // any code still raised as a literal. Either is a code the reader can be shown.
      const source = readExtensionFile('markdown-rehydration.js');
      const raised = new Set([
        ...Array.from(
          source.matchAll(/^\s+token_[a-z_]+: '([^']+)',$/gm),
          (match) => match[1]
        ),
        ...Array.from(
          source.matchAll(/createValidationError\('([^']+)'\)/g),
          (match) => match[1]
        ),
      ]);

      assert.equal(raised.size, 4);
      for (const code of raised) {
        assert.equal(
          typeof SIDE_PANEL_FAILURE_MESSAGES[code],
          'string',
          `${code} reaches the reader without a sentence`
        );
      }
    },
  },
  {
    name: 'is loaded by the panel that reads it, and checked with the rest',
    fn() {
      // The side panel takes its dependencies from its own script tags, so wording only the
      // unit suite can require is wording the reader never sees. Neither list is derived
      // from the directory.
      const html = readExtensionFile('sidepanel.html');
      const packageJson = JSON.parse(
        fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
      );

      assert.notEqual(html.indexOf('src="sidepanel-failure.js"'), -1);
      assert.equal(
        html.indexOf('src="sidepanel-failure.js"') <
          html.indexOf('src="sidepanel.js"'),
        true
      );
      assert.match(
        packageJson.scripts['check:syntax'],
        /node --check extension\/sidepanel-failure\.js/
      );
    },
  },
];
