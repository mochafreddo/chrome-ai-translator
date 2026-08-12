# Translate whole Semantic Blocks, not individual text nodes

Status: accepted

Inline Translation once worked on individual text nodes: each visible node was sent and its text replaced in place. `16f577c` (2026-07-10) replaced that with Semantic Block translation — one paragraph, heading, list item, or table cell serialized whole, with protected tokens standing in for its inline elements — because a sentence split across `<em>`, `<a>`, and `<code>` children cannot be translated fragment by fragment without losing word order. Translating the block whole lets those elements keep their existing DOM objects and move to match the translated word order.

That commit added the block path but did not remove the text-node one, so both lived in the tree for 63 commits. The text-node path is now removed.

## Consequences

- An oversized or malformed block remains untranslated. There is deliberately **no fallback to fragment translation** — falling back would reintroduce exactly the word-order loss the block path exists to prevent.
- Progress counts, size limits, and retries are expressed in Semantic Blocks, not text nodes.
- `TRANSLATE_TEXT_NODES`, `TRANSLATE_VISIBLE_TEXT_BATCH`, and `INLINE_TRANSLATION_PROGRESS` are retired message names, and each one is guarded on the side that used to implement it. The first two were worker endpoints: a negative test in `tests/background-helpers.test.js` sends all three names to the worker and asserts it answers `Unknown message`. `INLINE_TRANSLATION_PROGRESS` ran the other way — the worker sent it and the content script acted on it — so its guard is in `tests/content-helpers.test.js`, which drives the content script's own listener and asserts the message changes nothing. Both halves are covered because reviving either one alone is what went unnoticed before.

## Do not revert this

Restoring a text-node path looks like adding a safety net for blocks that are too large or fail validation. It is not: it is a second record lifecycle over the same page, and the two disagree about what a unit of work is.

The failure mode is silent. When the block path landed, the text-node half kept its message handler and its tests while losing its only caller, and nothing went red — a producerless endpoint and a dead message pair survived 63 commits. The repo did have a removed-endpoint check, but it named one message (`TRANSLATE_TEXT_NODES`) and no check covered `TRANSLATE_VISIBLE_TEXT_BATCH`, which was still answered, or `INLINE_TRANSLATION_PROGRESS`, which had a receiver and no sender. A guard that names one message does not generalise; the retired names have to be enumerated. If a fallback is ever genuinely wanted, add it inside the Semantic Block path, and add the test that fails when its caller disappears.
