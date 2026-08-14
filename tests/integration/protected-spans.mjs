// The links and inline code a fixture is built from, and which of them did not survive a
// translation.
//
// Separate from the live check that uses it because these are properties of plain strings:
// no browser, no key, no bill. That is what lets `npm test` hold them -- see
// tests/protected-spans.test.js -- and holding them there is not optional. The billed check
// asks these two functions what happened; if they answer wrongly it reports a clean run,
// which is worse than not running at all.
//
// Every count here is a count of occurrences of one span's own text. That is deliberate: it
// says nothing about how the extension renders a link or a code span, so it keeps working
// when the rendering changes, and it is the same measurement on the way in as on the way
// out. The price is that one span's text must never contain another's, which readProtectedSpans
// refuses rather than tolerates.

// A fixture's own markup, read the way the fixture is written -- one <a href="..."> or one
// <code>...</code> per match, both on one line, no nesting. This is not an HTML parser and
// must not be handed a page it did not write: the fixture suits the reader, not the other
// way round.
const LINK_HREF = /<a\s+href="([^"]+)"/g;
const INLINE_CODE = /<code>([^<]+)<\/code>/g;

function collect(html, expression, kind) {
  return Array.from(String(html).matchAll(expression), (match) => ({
    at: match.index,
    kind,
    value: match[1].trim(),
  }));
}

function assertCountable(spans) {
  for (const span of spans) {
    for (const other of spans) {
      if (other === span || !other.value.includes(span.value)) continue;
      throw new Error(
        `these spans are not countable side by side: "${span.value}" occurs inside ` +
          `"${other.value}", so counting either one counts the other too. Give every link ` +
          `and code span in the fixture a value that contains no other.`
      );
    }
  }
}

// The links and inline code the fixture holds, in document order. `index` is a span's place
// in that order and is how a failure says where in the document it is.
export function readProtectedSpans(html) {
  const found = [
    ...collect(html, LINK_HREF, 'link'),
    ...collect(html, INLINE_CODE, 'code'),
  ].sort((left, right) => left.at - right.at);
  assertCountable(found);
  return found.map((span, order) => ({
    index: order + 1,
    kind: span.kind,
    value: span.value,
  }));
}

function countOccurrences(text, needle) {
  return String(text).split(needle).length - 1;
}

// Which spans did not come back as often as they went in. `original` is the Markdown the
// extension extracted from the page and `translated` is what came back from the model
// through it; both are read as plain text, so a model's wording is not on trial here.
//
// A span the extraction never minted is reported apart from one lost in transit: the first
// says the fixture or the extraction changed, the second says the round trip lost it, and
// the two want opposite fixes.
export function findSurvivalFailures({ spans, original, translated }) {
  const failures = [];
  for (const span of spans) {
    const wentIn = countOccurrences(original, span.value);
    const cameBack = countOccurrences(translated, span.value);
    if (wentIn === 0) {
      failures.push({ ...span, wentIn, cameBack, reason: 'never-minted' });
    } else if (cameBack !== wentIn) {
      failures.push({
        ...span,
        wentIn,
        cameBack,
        reason: cameBack === 0 ? 'lost' : 'count-changed',
      });
    }
  }
  return failures;
}

// Which spans the extraction never put in the Markdown at all -- asked before anything about
// the way back, because a fixture that stopped minting tokens makes every question about the
// way back vacuous. Its own function rather than findSurvivalFailures with one text passed
// twice, which is the same computation and reads like a mistake.
export function findUnmintedSpans(spans, markdown) {
  return findSurvivalFailures({ spans, original: markdown, translated: markdown });
}

// One line per failure, naming the span and where in the document it sits, because "a link
// was lost" is not something anyone can act on.
export function describeSurvivalFailures(failures) {
  return failures
    .map(
      (failure) =>
        `${failure.kind} #${failure.index} ${failure.value} ` +
        `[${failure.reason}: in ${failure.wentIn}, back ${failure.cameBack}]`
    )
    .join('; ');
}
