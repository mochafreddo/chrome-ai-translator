# A failed Translation Chunk ends the whole Side Panel Translation

Status: accepted

Side Panel Translation cuts an article into Translation Chunks and translates them in a sequential loop. The first throw from any chunk escapes the loop, and the handler that catches it records an error with `translated: null`. So a document of five chunks that fails on the fourth discards the three answers that already came back, and those three were billed. The reader is shown a failure and no text, and pressing Translate again pays for all five afresh — nothing is resumed.

Inline Translation made the opposite choice for the same problem: a Semantic Block that fails, fails alone, and the rest of the page is still translated. The question this decision answers (issue #27) is whether Side Panel Translation should follow it.

**It should not. The discard stays.** A failed Translation Chunk ends the whole translation, deliberately.

## Why, with the two blockers' results in hand

The discard was deferred rather than decided while these tickets were written, because two answers were expected to settle it.

**#23 — is the failure real, and how often?** A billed check now drives Side Panel Translation against a local fixture dense in links and inline code, cut into three Translation Chunks at the smallest chunk size the options page accepts, and counts every protected span back. It did not reproduce the reported `markdown.token_missing` in three attempts; all 24 spans returned each time. The check was proven able to fail — with a token stripped from every answer on purpose it goes red and names the chunk — so the green is worth something, though three attempts against one model and one fixture is weak evidence of absence, and the account has had no credits since.

**#26 — does asking properly make it rare enough not to matter?** The instructions now require every placeholder back byte-for-byte, once each, none invented, with `LINK_OPEN` before the `LINK_CLOSE` of the same id; and a refused answer buys exactly one further attempt that is told which of the four codes refused the last one. That is landed and covered by unit checks, but no real model has yet been shown either sentence: the same missing credits stopped `verify:live:sidepanel` at Chunk 1/3.

So the failure that motivated the ticket is unreproduced, now asked against, and repaired once. Building a result state to serve it would be building for a reader who has not been shown to exist.

## What the alternative actually costs

"Keep what succeeded" is one line in the loop's catch and a great deal else. It invents a Side Panel Translation result that is neither `done` nor `error`, and that result has to be named in `CONTEXT.md`, rendered, and explained — and the reader has to be able to tell translated text from text that stayed in its original language, in the bilingual view as well as the plain one. Three further costs are specific to this repo:

- **The name is taken.** `partial` already means something here — Inline Translation's per-block translation quality (`translation-validation.js`, `translation-policy.js`, the diagnostics schema and the options page that renders it). A second, unrelated `partial` on the other translation is exactly the collision `CONTEXT.md`'s vocabulary exists to prevent.
- **Every later feature has to ask whether a translation is whole.** The bilingual view pairs a whole original against the translation; save, copy, and diagnostics would each need the question answered. That is a permanent tax on a personal extension, paid in every future change.
- **It cannot be verified.** With no credits, a new rendering state would land as unmeasured as #26's instruction, and this one is what the reader looks at.

Against that, what keeping the prefix buys is narrow: the reader can read the chunks that came back without paying again. It does not make the re-run cheaper — partial results are not resume — and the money for those chunks is spent either way.

## Consequences

- Any failure the loop does not recover from — a token contract broken twice, an over-long answer whose split child fails, an HTTP or network failure, a billing refusal — ends the translation and discards every answer before it. The billed cost of those answers is lost.
- The cost of a late failure is written beside the loop in `extension/background.js`, so the next reader meets it as a decision rather than rediscovering it as a bug.
- The discard is checked, not merely stated: `tests/background-helpers.test.js` drives three chunks with the third failing and holds that no state the panel could render ever carried the first two answers, with a companion check that the same fixture publishes all three when none fails.
- The side panel no longer promises text "as chunks complete", because it never arrived that way. While a translation runs, the box says the translation appears when the last chunk is back and that a failure before then leaves nothing there.
- Inline Translation keeps its own isolation. The two translations differ here on purpose: a Semantic Block is one paragraph of a page the reader is already reading, and one that fails leaves the rest of the page usable; a Translation Chunk is an arbitrary slice of a document the panel renders as one text.

## What would change this

Evidence that a late failure is common — a reproduced token loss that survives its one repair, or a rate-limit or network failure hit part-way through a long article often enough to notice. `npm run verify:live:sidepanel` is where that evidence would come from, and it needs credits, not code. If it arrives, the thing to design is not only the prefix but how the reader is told which part of the article they are reading, and whether a re-run should resume rather than re-bill.
