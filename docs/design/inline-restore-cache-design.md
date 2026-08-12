# Inline Restore Cache Design

## Goal

When a user translates visible page text inline, clicks **Original text**, and
then clicks **Page in Korean** again on the same page, previously translated
text should be reapplied from an in-memory cache instead of being sent to the
translation API again.

The cache is intentionally page-scoped. It survives the inline original/translate
toggle flow within the current content script instance, but it does not persist
across page reloads, tab navigations, browser restarts, or extension storage.

## Behavior Before This Change

`extension/content.js` cached translations inside each viewport store in
`translationByOriginal`. That supports two active-session cases:

- a Semantic Block rerendered with page-owned nodes it still owns can receive the
  cached translation;
- the same block can be restored to its original content and receive the cached
  translation again.

`restoreInlineViewportRecords()` restored translated blocks to their original
content, cleared restorable records, incremented the operation, and created a new
viewport store. Because the cache belonged to the old viewport store, clicking
**Page in Korean** after **Original text** started with an empty cache.

## Chosen Approach

The implementation adds a page-lifetime translation cache to `inlineState`,
separate from restorable records and from the current viewport store.

The top-level cache is bucketed by an inline translation settings
signature. The signature includes the translation-affecting settings that are
available in the content script before an inline run starts:

- `targetLanguage`;
- `tone`;
- `model`;
- `reasoningEffort`.

Each bucket is keyed by the record's `cacheKey`, which `inline-block.js` derives
from the block's serialized form. Each entry stores:

- `codecVersion`: the codec that produced the entry;
- `translatedTemplate`: the translated template, tokens and all;
- `state`: `translated` or `translated_with_warning`;
- `terminalCode`: the warning's code, when the state carries one;
- `attemptCount`: how many attempts the translation took.

This keeps the responsibilities distinct:

- viewport store records track the current active scan position, queue,
  in-flight work, and block ownership;
- restorable records track translated blocks that may need to be restored;
- the page cache tracks known block-to-translated-template pairs for the current
  page instance.

Viewport scanning is intentionally bounded. Blocks are discovered from the
visible text nodes inside them, so the scan budget and the scan position are both
counted in text nodes even though the unit of work is a block. Each scan inspects
a limited window of text nodes, skips offscreen element subtrees, and schedules a
continuation when more text nodes remain. Internal continuations resume from the
stored scan position. External viewport changes such as scroll, resize, or page
mutation reset that position and return unsent queued records to `original`, so
the next scan prioritizes currently visible content instead of old viewport work.
A queued page-change retry is the one exception: it is retained across the reset,
because dropping it would leave the block it superseded looking finished. See
`docs/design/inline-changed-text-retry-design.md`.

## Data Flow

On successful inline viewport translation:

1. `applyInlineViewportBlockResults()` applies the translated template to the
   DOM only if the record is current and the block still owns the nodes it was
   serialized from.
2. The record is marked `translated`, or `translated_with_warning` when one
   repair attempt left source-language prose behind.
3. The translation is cached in the current viewport store and in the current
   settings bucket of the page cache.

On **Original text**:

1. Active viewport watchers are detached.
2. Translated blocks are restored to their original content using existing
   ownership checks.
3. Current records and restorable records are cleared as they are today.
4. The page cache remains available.
5. A fresh viewport store is created for the next inline run.

On the next **Page in Korean** click on the same page:

1. The content script reads settings as it already does before starting inline
   translation.
2. A settings signature is derived from those settings.
3. `activateInlineTranslationCacheBucket()` selects the current settings bucket
   and stores it as the active `inlineState.translationCache`.
4. A new viewport store is created.
5. The new store receives the shared page cache `Map` for the current settings
   signature.
6. If the settings signature is different from the previous run, the new bucket
   starts empty and text is translated normally.
7. Block collection calls `queueInlineViewportBlock()`.
8. If a block's `cacheKey` matches a cached entry from the same codec version and
   the cached template still patches cleanly onto the block, the cached
   translation is applied immediately and no batch request is queued for that
   block.
9. If the scan budget is exhausted, the next internal scan continues from the
   stored text-node position. If the viewport changes before that continuation
   runs, queued-but-unsent records other than page-change retries are returned to
   `original` state and the scan restarts from the top of the current viewport.

The implementation shares the page cache `Map` with each new viewport store.
That avoids copy drift and keeps the helper API small:
`getInlineTranslationCacheBucket()` only returns a bucket, while
`activateInlineTranslationCacheBucket()` makes that bucket the active cache for
restore/retranslate flows.

## Settings Snapshot

The content script sends a non-secret `settingsSnapshot` with each
`TRANSLATE_VISIBLE_BLOCK_BATCH` request. The snapshot contains only:

- `targetLanguage`;
- `tone`;
- `model`;
- `reasoningEffort`.

`extension/background.js` merges that snapshot into the current settings for the
visible block batch, but preserves the current stored `apiKey` and ignores other
settings such as `chunkMaxChars`, `buttonVisibility`, and `viewMode`.

This keeps a run consistent with the settings used to choose the cache bucket,
without allowing the content script to provide or override secrets.

Visible block batches size their output-token cap from the batch's record cost,
between a floor and a ceiling. After the model returns structured JSON, the
background validates every expected id and every protected token, and rejects a
template whose structure does not match the contract it was given. Rejected,
malformed, or missing translations fail the affected record instead of being
applied or cached; a repairable failure gets one repair attempt first.

## Boundaries

The cache must not be written to `chrome.storage`, local files, background
state, diagnostics, or logs. It must remain local to the content script page
instance.

The cache must not apply fuzzy matches. It should only apply when:

- the current run's settings signature matches the cache bucket;
- the cached entry came from the current codec version;
- the cached `translatedTemplate` is a string;
- the cached template produces a patch plan that applies to the block's
  snapshot.

If any condition fails, the existing queue/stale behavior applies.

## Error Handling

Failed, stale, ignored, queued, and in-flight records are not inserted into the
page cache. Late responses from stale operations remain ignored by the existing
operation checks.

Queued records that have not been sent may be reset when the viewport changes.
Those records remain in `records` for status/restoration bookkeeping, but they
are removed from the active queue and can be queued again if their block is still
visible in a later scan. A queued page-change retry is retained rather than
reset.

If the page changes a block after restoration so that the cached template no
longer patches onto it, the cached entry is not applied. That prevents replacing
live site updates with a stale translation.

## Testing

Focused unit coverage in `tests/content-helpers.test.js` covers:

- A translated Semantic Block is cached in a page-level cache.
- After `restoreInlineViewportRecords()` restores the DOM and creates a fresh
  viewport store, the same block can be translated from the preserved cache
  without queueing an API request.
- Cache buckets are separated by target language, tone, model, and reasoning
  effort, but not by `apiKey`.
- Stopped-session translated blocks are reused only when settings match.
- Stopped-session translated blocks are restored to their original content when
  settings change so they can be queued under the new settings.
- A partial translation is rehydrated from cache as partial, not as success.
- A block rerendered with equivalent page-owned nodes is requeued rather than
  treated as still translated.
- Viewport scans skip offscreen content, resume from the stored scan position
  when the budget runs out, and reset unsent queued work when the viewport
  changes.

Focused unit coverage in `tests/background-helpers.test.js` verifies that
visible batch settings snapshots can update translation-affecting settings
without accepting an `apiKey` from the content script.
It also verifies the block-batch output cap, full-page output cap scaling,
structured block id and protected-token validation, and that none of the retired
text-node message names is answered again.

Run:

```sh
npm test
npm run check:syntax
```

## Non-Goals

- Persisting translations across reloads, navigations, or browser restarts.
- Sharing cache entries across tabs or pages.
- Adding a user-visible cache setting.
- Reusing translations across different target language, tone, model, or
  reasoning effort settings.
