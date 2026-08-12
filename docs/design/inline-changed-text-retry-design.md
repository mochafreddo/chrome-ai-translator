# Inline Changed Text Retry Design

Date: 2026-06-25

## Goal

Improve inline translation behavior on dynamic pages such as Gmail where page
content can change after the extension queues a Semantic Block but before the
translation response is applied.

The improvement has two parts:

- separate user-facing counts for real translation failures and page content that
  changed during translation;
- retry changed content conservatively when the block can still be serialized and
  is still worth translating.

The existing side panel Markdown translation remains unchanged.

## Current Problem

Inline viewport translation captures a Semantic Block's original child nodes when
queueing work. After the background script returns translations, the content
script only applies a translation when the block still owns exactly the nodes it
was serialized from.

That ownership check is correct. It prevents overwriting live page updates with
an older translation.

The problem is the current user-facing model. When the block changes before the
translation can be applied, the record becomes `stale`, and status counting shows
stale records under `Failed`. On Gmail this can produce confusing output such as:

```text
Visible translation on
Translated 34 · Pending 0 · Failed 34
```

In that state the API may have succeeded, and the extension may have correctly
refused to overwrite changed page content. The label makes this look like a
translation failure rather than a page-change conflict.

## User Decision

The chosen direction is to improve both accuracy and success rate:

- keep the conservative DOM ownership check;
- show changed page content separately from failed translation requests;
- retry a changed block once when it can still be serialized;
- avoid site-specific Gmail selectors or Gmail-only behavior.

## Non-Goals

- Do not remove the block ownership check.
- Do not overwrite content when the page changed underneath the extension.
- Do not add Gmail-specific selectors, domain checks, or page-specific hacks.
- Do not persist source text, translated text, or retry state outside the
  content script page instance.
- Do not retry indefinitely.
- Do not change the side panel translation workflow.
- Do not send raw HTML to the model or insert model-generated HTML.

## Terminology

The internal `stale` state may continue to exist as a technical state meaning
"the block ownership check failed." User-facing copy should describe this as
`Changed`.

`failed` should mean a translation request or validation failure:

- API request failure;
- missing or malformed response;
- unexpected, duplicate, or missing translation IDs;
- a translated template whose protected tokens do not match its contract;
- oversized blocks rejected before a batch request.

`changed` should mean the page content changed before the extension could safely
apply the returned translation.

## State Model

Keep the existing record states:

- `original`
- `queued`
- `translating`
- `translated`
- `translated_with_warning`
- `failed`
- `stale`

Add retry metadata to viewport records:

- `retryOf`: optional original record id that produced this retry record;
- `pageChangeRetryCount`: number of page-change retries already attempted for
  this block, defaulting to `0`;
- `supersededByRetryId`: optional retry record id that replaces this changed
  record for user-facing status purposes.

The retry budget is one retry per changed block. A retried record starts with
`pageChangeRetryCount: 1`. If it becomes stale again, it remains `stale` and is
not requeued again.

The state model should keep exact block ownership. A retry only reuses the same
block element when that element is still connected.

The current `byBlock` `WeakMap` can point to only one active record for a block
element. Retrying a changed block therefore needs a dedicated helper rather than
the normal `queueInlineViewportBlock()` path:

```js
queueInlineViewportBlockRetry(store, parentRecord, retryKind)
```

This helper should:

1. verify that `parentRecord.blockElement` is still connected;
2. verify that `store.byBlock.get(blockElement)` is still the parent record;
3. reject records whose retry budget is already spent;
4. re-serialize the block from its current content, and give up if it can no
   longer be serialized;
5. create a new retry record from that fresh serialization;
6. set `parentRecord.supersededByRetryId` to the retry record id;
7. replace `store.byBlock.get(blockElement)` with the retry record;
8. append the retry record to `store.records`;
9. apply a cached translation immediately on cache hit, or push the retry record
   into `store.queue` when no cache entry applies.

Re-serializing is what replaces a text-level "is this still worth translating"
predicate. A block whose new content cannot be serialized — because it now nests
another semantic block, or holds nothing translatable — is not retried, and that
decision is made by the same code that decides whether to translate the block in
the first place.

The stale record remains in `store.records` as history, but it is no longer the
active record for that block. Future scans see the retry record in `byBlock` and
do not create duplicate work.

If a page rerender replaces a block's children with equivalent page-owned nodes,
the block is requeued through the normal path and the page-lifetime cache can
still apply independently.

## Status Counts

Replace the current `translated/pending/failed` summary with a five-part count:

```text
Visible translation on
Translated 34 · Partial 0 · Pending 0 · Changed 34 · Failed 0
```

Counting rules:

- `translated`: records with `state === 'translated'`;
- `partial`: records with `state === 'translated_with_warning'`;
- `pending`: records with `state === 'queued'` or `state === 'translating'`;
- `changed`: records with `state === 'stale'` and no `supersededByRetryId`;
- `failed`: records with `state === 'failed'` and no `supersededByRetryId`.

`Changed` is a count of unresolved page-change conflicts, not a lifetime event
counter. If a stale record is superseded by a retry, the original stale record no
longer counts as changed. While the retry is queued or translating, it counts as
pending. If the retry succeeds, the UI shows the translated retry record and no
changed count for that block. If the retry becomes stale, that retry record
counts as changed. If the retry request fails, that retry record counts as
failed.

A viewport reset does not cancel a queued Semantic Block retry: the retry is
retained in the queue, so the stale parent stays superseded and the reader is not
shown a conflict the extension is still working on. Stopping inline translation
does discard queued retries, and the stale parent returns to `Changed` so stopped
status does not hide unresolved page-change conflicts behind `Pending 0`. The
same applies to a retry that was in flight when the reader pressed **Stop**.

Stopped mode should still show pending as zero:

```text
Visible translation stopped
Translated 34 · Partial 0 · Pending 0 · Changed 2 · Failed 1
```

This is a user-facing display change. Keep the current
`getInlineViewportStatusCounts()` helper name and widen its return object to
`{ translated, partial, pending, changed, failed }` so existing call sites keep
their single status-count entry point.

## Retry Policy

When `applyInlineViewportBlockResults()` receives a valid translation for a
record but cannot apply it because the block no longer owns the nodes it was
serialized from:

1. Mark the current record `stale` with `errorCode: 'block_changed'`.
2. Do not apply the returned translation.
3. Consider a retry only if the block element is still connected and still maps
   to this record.
4. Re-serialize the block from its current content.
5. Retry only if that serialization succeeds.
6. Retry only if the block's page-change retry budget has not been used.
7. Queue a new record through `queueInlineViewportBlockRetry()` for the same
   block, with `retryOf` set to the stale record id and `pageChangeRetryCount`
   incremented to `1`.

A rejected result is treated the same way when the block has already changed:
a response the extension refuses is not a failure to report if the page moved on
first, so the page-change retry runs instead.

Disconnected blocks are not retried because there is no safe target for applying
future output.

If the re-serialized block's `cacheKey` matches a cached entry that still patches
cleanly, the retry helper applies the cached translation instead of sending a
retry request. That is the same cache check the normal queue path makes, applied
to the retry record before it reaches the queue.

If the retry record becomes stale, it remains `stale`. The extension should not
loop on pages that continuously mutate content.

## Data Flow

1. The user starts inline viewport translation.
2. The content script scans visible content and queues Semantic Blocks as today.
3. The content script sends small block batches to the background script.
4. The background script returns validated translated templates.
5. The content script attempts to apply each translation.
6. If the block is unchanged, the translation is applied and cached as today.
7. If the block changed, the original record becomes `stale`.
8. If retry conditions pass, the content script queues a new record from the
   block's current content.
9. The existing queue drain loop sends the retry record in a later block batch.
10. If the retry succeeds, the superseded stale record is excluded from
    `Changed` and the retry record counts as `Translated`.
11. If the retry is still queued or translating, it counts as `Pending`.
12. If the retry becomes stale or failed, the retry record counts as `Changed`
    or `Failed`.
13. A viewport reset keeps a queued retry in the queue, so the stale parent
    stays superseded.
14. If inline translation is stopped with a queued or in-flight retry, the
    stale parent returns to `Changed` so stopped status still reports the
    unresolved page-change conflict.
15. UI counts show unresolved changed records separately from failed records
    throughout the process.

This keeps retry behavior inside the existing queue and batching model. It does
not introduce a separate request path.

## UI

Keep the floating menu compact. The status line should remain a single summary
line after the status title.

Use this shape:

```text
Visible translation on
Translated 18 · Partial 0 · Pending 2 · Changed 3 · Failed 1
```

No raw source text, translated text, API keys, request payloads, or per-block
diagnostics should appear in the floating UI.

The Options diagnostics can continue to show recent run status and redacted
errors. This design does not require adding source text or translated text to
diagnostic storage.

## Error Handling

API and validation failures remain per-record failures within a batch. They
should mark only the affected current translating records as `failed`.

Changed DOM records should not be counted as `failed`. They should be counted as
`changed` only while they are unresolved. Once a retry record supersedes the
original stale record, the original stale record no longer contributes to
`changed`.

If queueing a retry would exceed existing viewport batch behavior, the retry can
remain queued and follow the same drain limits as any other visible record.

If the user clicks **Stop**, no new retries should be queued after the operation
is invalidated. Already queued retry records are handled by the existing stop
logic.

If the user clicks **Original text**, translated records should restore as
today. Stale and failed records should not alter the DOM during restore.

## Privacy And Safety

The retry design must not persist additional source or translated text outside
the content script page instance.

The retry design must not log changed block content. Tests can use fixed fake
text, but runtime diagnostics should continue to avoid storing source text,
translations, API keys, or request payloads.

The extension must continue to avoid model-generated HTML. The model sees a
template with protected tokens standing in for the block's inline elements, and
the extension moves the block's existing DOM objects to match the translated
token order.

## Testing

Focused unit coverage in `tests/content-helpers.test.js` covers:

- `stale` records are counted as `changed`, not `failed`.
- `failed` records still count as `failed`.
- status message formatting includes `Changed`.
- stopped status formatting forces pending to zero while preserving changed and
  failed counts.
- when a block changes before translation application, the original record is
  marked `stale`, marked with `supersededByRetryId`, and a retry record is
  queued from the block's current content.
- superseded stale records do not contribute to `changed` counts.
- while a retry record is queued or translating, it contributes to `pending`.
- when a retry succeeds, the final status has no changed count for the
  superseded stale record.
- at most one page-change retry is queued for a block.
- a viewport reset keeps a queued block retry queued rather than cancelling it.
- stopping with a queued or in-flight block retry returns the stale parent to
  `changed`.
- a translated block is rehydrated from the page-lifetime cache without queueing
  an API request.
- a response that arrives after a stop or a restart is discarded by the drain
  loop's operation check, and its correlation tokens are released.

Existing tests for operation invalidation, restore behavior, cache reuse,
oversized block failure, API failure, and syntax checks continue to pass.

Run:

```sh
npm test
npm run check:syntax
```

Manual verification should include:

- Gmail message with built-in Gmail translation controls visible.
- A long normal article page without Gmail-specific behavior.
- A page that mutates visible content while inline translation is active.
- Stop and Original text flows after changed records appear.

Expected Gmail result is not "all content always translates." Expected behavior
is that page-change conflicts appear as `Changed`, a block that can still be
serialized gets one retry, and the extension never overwrites content that
changed after capture.

## Implementation Boundary

This document records the design boundary used for the shipped change. The
implementation stayed scoped to inline viewport content-script behavior, focused
helper tests, and README user-facing status documentation.

Implementation files:

- `extension/content.js`
- `tests/content-helpers.test.js`
- `README.md`

`extension/background.js` did not require behavioral changes for the retry
policy itself.
