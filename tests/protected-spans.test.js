// The link-and-code half of the Side Panel Translation live check, checked without a
// browser and without a bill.
//
// protected-spans.mjs answers two questions for that check: which links and inline code a
// fixture is built from, and which of them did not come back as often as they went in. Both
// are properties of plain functions, so they belong in this tier -- and they have to be
// here, because a bug in either one lets the billed check go green while proving nothing,
// which is the exact failure mode that check exists to rule out.
//
// The module is ESM and this suite is CommonJS, so it comes in through a dynamic import, as
// tests/live-key.test.js does. Importing it runs nothing: no browser, no network, no file
// read of its own. That is the condition on this check living in this tier -- see
// tests/README.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const protectedSpans = () => import('./integration/protected-spans.mjs');

const FIXTURE = path.join(
  __dirname,
  'integration',
  'fixtures',
  'sidepanel-translation.html'
);

// A page shaped like the fixture, small enough to read here.
const PAGE = `<!doctype html>
<html lang="en">
  <body>
    <article>
      <h1>A page held still</h1>
      <p>
        The <a href="https://example.com/reference/section-01">chunk boundary rules</a> say
        that <code>spanGuard01()</code> stays put.
      </p>
      <ul>
        <li>
          See <a href="https://example.com/reference/section-02">the recovery notes</a> and
          <code>spanGuard02()</code>.
        </li>
      </ul>
    </article>
  </body>
</html>`;

exports.name = 'protected spans';
exports.tests = [
  {
    name: 'reads the links and inline code a page is built from, in document order',
    async fn() {
      const { readProtectedSpans } = await protectedSpans();

      assert.deepEqual(readProtectedSpans(PAGE), [
        { index: 1, kind: 'link', value: 'https://example.com/reference/section-01' },
        { index: 2, kind: 'code', value: 'spanGuard01()' },
        { index: 3, kind: 'link', value: 'https://example.com/reference/section-02' },
        { index: 4, kind: 'code', value: 'spanGuard02()' },
      ]);
    },
  },
  {
    name: 'refuses a page whose spans a count by substring would confuse',
    async fn() {
      // Every count in this module is a count of occurrences of one span's own text, so two
      // spans where one contains the other would both be counted wrong -- and wrong in the
      // direction that hides a loss. The fixture is written to suit that counting; this is
      // what says so when someone edits it.
      const { readProtectedSpans } = await protectedSpans();

      assert.throws(
        () =>
          readProtectedSpans(
            '<a href="https://example.com/a">one</a><a href="https://example.com/ab">two</a>'
          ),
        /countable/
      );
      assert.throws(
        () => readProtectedSpans('<code>chunk</code><code>chunkMaxChars</code>'),
        /countable/
      );
      // Two spans with the same text are the same trap: a count that falls from two to one
      // cannot say which of them fell.
      assert.throws(
        () => readProtectedSpans('<code>spanGuard01()</code><code>spanGuard01()</code>'),
        /countable/
      );
    },
  },
  {
    name: 'reports nothing when every span comes back as often as it went in',
    async fn() {
      const { findSurvivalFailures, readProtectedSpans } = await protectedSpans();
      const spans = readProtectedSpans(PAGE);
      const original =
        '# A page held still\n\n' +
        'The [chunk boundary rules](<https://example.com/reference/section-01>) say that ```spanGuard01()```.\n\n' +
        '- See [the recovery notes](<https://example.com/reference/section-02>) and ```spanGuard02()```.';

      assert.deepEqual(
        findSurvivalFailures({
          spans,
          original,
          // Different wording, same spans: what is asserted is the count, never the words
          // around it.
          translated: original.replace('A page held still', '가만히 멈춘 페이지'),
        }),
        []
      );
    },
  },
  {
    name: 'names the span that did not come back',
    async fn() {
      const { describeSurvivalFailures, findSurvivalFailures, readProtectedSpans } =
        await protectedSpans();
      const spans = readProtectedSpans(PAGE);
      const original = spans.map((span) => span.value).join(' ');
      const translated = original.replace('spanGuard01()', '');

      const failures = findSurvivalFailures({ spans, original, translated });

      assert.deepEqual(failures, [
        {
          index: 2,
          kind: 'code',
          value: 'spanGuard01()',
          wentIn: 1,
          cameBack: 0,
          reason: 'lost',
        },
      ]);
      assert.match(describeSurvivalFailures(failures), /code #2/);
      assert.match(describeSurvivalFailures(failures), /spanGuard01\(\)/);
      assert.match(describeSurvivalFailures(failures), /in 1, back 0/);
    },
  },
  {
    name: 'tells a span that never went in from one lost on the way back',
    async fn() {
      // A fixture that stopped minting a token would otherwise read as a translation that
      // dropped one, and the two want opposite fixes.
      const { findSurvivalFailures, readProtectedSpans } = await protectedSpans();
      const spans = readProtectedSpans(PAGE);
      const missing = spans[0].value;
      const text = spans
        .map((span) => span.value)
        .filter((value) => value !== missing)
        .join(' ');

      assert.deepEqual(
        findSurvivalFailures({ spans, original: text, translated: text }),
        [
          {
            index: 1,
            kind: 'link',
            value: missing,
            wentIn: 0,
            cameBack: 0,
            reason: 'never-minted',
          },
        ]
      );
    },
  },
  {
    name: 'names a span that came back more often than it went in',
    async fn() {
      const { findSurvivalFailures, readProtectedSpans } = await protectedSpans();
      const spans = readProtectedSpans(PAGE);
      const original = spans.map((span) => span.value).join(' ');

      assert.deepEqual(
        findSurvivalFailures({
          spans,
          original,
          translated: `${original} ${spans[0].value}`,
        }),
        [
          {
            index: 1,
            kind: 'link',
            value: spans[0].value,
            wentIn: 1,
            cameBack: 2,
            reason: 'count-changed',
          },
        ]
      );
    },
  },
  {
    name: 'keeps the shipped fixture dense enough to be worth billing',
    async fn() {
      // The fixture decides both what the billed check costs and what it can catch, and one
      // edited down to two links would still pass every check in the run while proving
      // almost nothing. This is what notices.
      const { readProtectedSpans } = await protectedSpans();
      const spans = readProtectedSpans(fs.readFileSync(FIXTURE, 'utf8'));
      const of = (kind) => spans.filter((span) => span.kind === kind).length;

      assert.ok(of('link') >= 10, `links in the fixture: ${of('link')}`);
      assert.ok(of('code') >= 10, `inline code in the fixture: ${of('code')}`);
    },
  },
];
