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

- a rerendered text node with the same original text can receive the cached
  translation;
- the same text node can revert to its original value and receive the cached
  translation again.

`restoreInlineViewportRecords()` restored translated DOM nodes to their
original text, cleared restorable records, incremented the operation, and created
a new viewport store. Because the cache belonged to the old viewport store,
clicking **Page in Korean** after **Original text** started with an empty cache.

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

Each bucket is keyed by exact original text, using the existing
`getInlineOriginalTextCacheKey()` behavior. Each entry stores:

- `original`: the original text;
- `translation`: the translated text.

This keeps the responsibilities distinct:

- viewport store records track the current active scan position, queue,
  in-flight work, and DOM ownership;
- restorable records track translated DOM nodes that may need to be restored;
- the page cache tracks known original-to-translation pairs for the current page
  instance.

Viewport scanning is intentionally bounded. Each scan inspects a limited window
of text nodes, skips offscreen element subtrees, and schedules a continuation
when more text nodes remain. Internal continuations resume from the stored scan
position. External viewport changes such as scroll, resize, or page mutation
reset that position and drop unsent queued records so the next scan prioritizes
currently visible text instead of old viewport work.

## Data Flow

On successful inline viewport translation:

1. `applyInlineViewportBatchTranslations()` applies the translated text to the
   DOM only if the record is current and the node still contains the original
   text.
2. The record is marked `translated`.
3. The translation is cached in the current viewport store and in the current
   settings bucket of the page cache.

On **Original text**:

1. Active viewport watchers are detached.
2. Translated nodes are restored to original text using existing ownership
   checks.
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
7. Visible text collection calls `queueInlineViewportRecord()`.
8. If a text node exactly matches a cached original string, the cached
   translation is applied immediately and no batch request is queued for that
   node.
9. If the scan budget is exhausted, the next internal scan continues from the
   stored text-node position. If the viewport changes before that continuation
   runs, queued-but-unsent records are returned to `original` state and the scan
   restarts from the top of the current viewport.

The implementation shares the page cache `Map` with each new viewport store.
That avoids copy drift and keeps the helper API small:
`getInlineTranslationCacheBucket()` only returns a bucket, while
`activateInlineTranslationCacheBucket()` makes that bucket the active cache for
restore/retranslate flows.

## Settings Snapshot

The content script sends a non-secret `settingsSnapshot` with each
`TRANSLATE_VISIBLE_TEXT_BATCH` request. The snapshot contains only:

- `targetLanguage`;
- `tone`;
- `model`;
- `reasoningEffort`.

`extension/background.js` merges that snapshot into the current settings for the
visible inline batch, but preserves the current stored `apiKey` and ignores other
settings such as `chunkMaxChars`, `inlineAutoShow`, and `viewMode`.

This keeps a run consistent with the settings used to choose the cache bucket,
without allowing the content script to provide or override secrets.

Visible inline batches also use a fixed output-token cap in the background
request. After the model returns structured JSON, the background validates every
expected id and rejects translations that expand far beyond their original
record. Rejected, malformed, or missing translations fail the affected batch
instead of being applied or cached.

## Boundaries

The cache must not be written to `chrome.storage`, local files, background
state, diagnostics, or logs. It must remain local to the content script page
instance.

The cache must not apply fuzzy matches. It should only apply when:

- the current run's settings signature matches the cache bucket;
- the node is still connected;
- the current node value equals the cached `original`;
- the cached `translation` is a string.

If any condition fails, the existing queue/stale behavior applies.

## Error Handling

Failed, stale, ignored, queued, and in-flight records are not inserted into the
page cache. Late responses from stale operations remain ignored by the existing
operation checks.

Queued records that have not been sent may be reset when the viewport changes.
Those records remain in `records` for status/restoration bookkeeping, but they
are removed from the active queue and can be queued again if their text is still
visible in a later scan.

If the page changes after restoration and the text no longer equals the cached
original, the cached entry is not applied. That prevents replacing live site
updates with stale translated text.

## Testing

Focused unit coverage in `tests/content-helpers.test.js` covers:

- A translated viewport record is cached in a page-level cache.
- After `restoreInlineViewportRecords()` restores the DOM and creates a fresh
  viewport store, the same original text can be translated from the preserved
  cache without queueing an API request.
- Cache buckets are separated by target language, tone, model, and reasoning
  effort, but not by `apiKey`.
- Stopped-session translated nodes are reused only when settings match.
- Stopped-session translated nodes are restored to original text when settings
  change so they can be queued under the new settings.
- Existing tests for rerendered original text, same-node reversion, stopped
  sessions, and restore ownership continue to pass.
- Viewport scans skip offscreen text, continue through large pages using a
  bounded text-node budget, and reset unsent queued work when the viewport
  changes.

Focused unit coverage in `tests/background-helpers.test.js` verifies that
visible batch settings snapshots can update translation-affecting settings
without accepting an `apiKey` from the content script.
It also verifies the visible-batch output cap, full-page output cap scaling,
structured inline translation id validation, over-expanded inline translation
rejection, and removal of the legacy text-node translation message endpoint.

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
