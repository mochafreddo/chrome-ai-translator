# Inline Restore Cache Design

## Goal

When a user translates visible page text inline, clicks **Original text**, and
then clicks **Page in Korean** again on the same page, previously translated
text should be reapplied from an in-memory cache instead of being sent to the
translation API again.

The cache is intentionally page-scoped. It survives the inline original/translate
toggle flow within the current content script instance, but it does not persist
across page reloads, tab navigations, browser restarts, or extension storage.

## Current Behavior

`extension/content.js` already caches translations inside each viewport store in
`translationByOriginal`. That supports two active-session cases:

- a rerendered text node with the same original text can receive the cached
  translation;
- the same text node can revert to its original value and receive the cached
  translation again.

`restoreInlineViewportRecords()` currently restores translated DOM nodes to their
original text, clears restorable records, increments the operation, and creates a
new viewport store. Because the cache belongs to the old viewport store, clicking
**Page in Korean** after **Original text** starts with an empty cache.

## Chosen Approach

Add a page-lifetime translation cache to `inlineState`, separate from
restorable records and from the current viewport store.

The top-level cache should be bucketed by an inline translation settings
signature. The signature includes the translation-affecting settings that are
available in the content script before an inline run starts:

- `targetLanguage`;
- `tone`;
- `model`;
- `reasoningEffort`.

Each bucket should then be keyed by exact original text, using the existing
`getInlineOriginalTextCacheKey()` behavior. Each entry stores:

- `original`: the original text;
- `translation`: the translated text.

This keeps the responsibilities distinct:

- viewport store records track the current active scan, queue, in-flight work,
  and DOM ownership;
- restorable records track translated DOM nodes that may need to be restored;
- the page cache tracks known original-to-translation pairs for the current page
  instance.

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
3. A new viewport store is created.
4. The new store receives the page cache bucket for the current settings
   signature, either by sharing the same `Map` instance or by copying its
   entries.
5. If the settings signature is different from the previous run, the new bucket
   starts empty and text is translated normally.
6. Visible text collection calls `queueInlineViewportRecord()`.
7. If a text node exactly matches a cached original string, the cached
   translation is applied immediately and no batch request is queued for that
   node.

The preferred implementation is to share the page cache `Map` with each new
viewport store. That avoids copy drift and keeps the existing helper API small.

## Boundaries

The cache must not be written to `chrome.storage`, local files, or background
state. It must remain local to the content script page instance.

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

If the page changes after restoration and the text no longer equals the cached
original, the cached entry is not applied. That prevents replacing live site
updates with stale translated text.

## Testing

Add focused unit coverage in `tests/content-helpers.test.js`:

- A translated viewport record is cached in a page-level cache.
- After `restoreInlineViewportRecords()` restores the DOM and creates a fresh
  viewport store, the same original text can be translated from the preserved
  cache without queueing an API request.
- Existing tests for rerendered original text, same-node reversion, stopped
  sessions, and restore ownership continue to pass.

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
