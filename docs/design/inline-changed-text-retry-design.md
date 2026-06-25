# Inline Changed Text Retry Design

Date: 2026-06-25

## Goal

Improve inline translation behavior on dynamic pages such as Gmail where page
text can change after the extension queues a text node but before the translation
response is applied.

The improvement has two parts:

- separate user-facing counts for real translation failures and page text that
  changed during translation;
- retry changed text conservatively when the current text is still safe and
  useful to translate.

The existing side panel Markdown translation remains unchanged.

## Current Problem

Inline viewport translation captures a text node's original value when queueing
work. After the background script returns translations, the content script only
applies a translation when the node is still connected and its current value
still equals the captured original.

That ownership check is correct. It prevents overwriting live page updates with
an older translation.

The problem is the current user-facing model. When the node changes before the
translation can be applied, the record becomes `stale`, and status counting
shows stale records under `Failed`. On Gmail this can produce confusing output
such as:

```text
Visible translation on
Translated 34 · Pending 0 · Failed 34
```

In that state the API may have succeeded, and the extension may have correctly
refused to overwrite changed page text. The label makes this look like a
translation failure rather than a page-change conflict.

## User Decision

The chosen direction is to improve both accuracy and success rate:

- keep the conservative DOM ownership check;
- show changed page text separately from failed translation requests;
- retry changed text once when the current node text is still translatable;
- avoid site-specific Gmail selectors or Gmail-only behavior.

## Non-Goals

- Do not remove the `node.nodeValue === original` safety check.
- Do not overwrite text when the page changed underneath the extension.
- Do not add Gmail-specific selectors, domain checks, or page-specific hacks.
- Do not persist source text, translated text, or retry state outside the
  content script page instance.
- Do not retry indefinitely.
- Do not change the side panel translation workflow.
- Do not send raw HTML to the model or insert model-generated HTML.

## Terminology

The internal `stale` state may continue to exist as a technical state meaning
"the original DOM ownership check failed." User-facing copy should describe this
as `Changed`.

`failed` should mean a translation request or validation failure:

- API request failure;
- missing or malformed response;
- unexpected, duplicate, or missing translation IDs;
- translation output rejected by existing output budget checks;
- oversized records rejected before a batch request.

`changed` should mean the page text changed before the extension could safely
apply the returned translation.

## State Model

Keep the existing record states:

- `original`
- `queued`
- `translating`
- `translated`
- `failed`
- `stale`

Add retry metadata to viewport records:

- `retryOf`: optional original record id that produced this retry record;
- `retryCount`: number of changed-text retries already attempted for this
  logical node path, defaulting to `0`;
- `supersededByRetryId`: optional retry record id that replaces this changed
  record for user-facing status purposes.

The retry budget is one retry per changed record. A retried record starts with
`retryCount: 1`. If it becomes stale again, it remains `stale` and is not
requeued again.

The state model should keep exact node ownership. A retry only reuses the same
text node reference when that node is still connected.

The current `byNode` `WeakMap` can point to only one active record for a text
node. Retrying a changed node therefore needs a dedicated helper rather than the
normal `queueInlineViewportRecord()` path:

```js
queueInlineViewportRetryRecord(store, staleRecord, currentText, translation)
```

This helper should:

1. verify that `staleRecord.node` is still connected;
2. verify that `staleRecord.node.nodeValue === currentText`;
3. reject records whose retry budget is already spent;
4. check the active translation cache for `currentText`;
5. create a new retry record for the same text node;
6. set `staleRecord.supersededByRetryId` to the retry record id;
7. replace `store.byNode.get(node)` with the retry record;
8. append the retry record to `store.records`;
9. apply a cached translation immediately on cache hit, or push the retry record
   into `store.queue` when no cache entry applies.

The stale record remains in `store.records` as history, but it is no longer the
active record for that node. Future scans see the retry record in `byNode` and do
not create duplicate work.

If a page rerender creates a new node with original text that matches an
existing page-lifetime cache entry, the existing cache behavior can still apply
independently through the normal queue path.

## Status Counts

Replace the current `translated/pending/failed` summary with a four-part count:

```text
Visible translation on
Translated 34 · Pending 0 · Changed 34 · Failed 0
```

Counting rules:

- `translated`: records with `state === 'translated'`;
- `pending`: records with `state === 'queued'` or `state === 'translating'`;
- `changed`: records with `state === 'stale'` and no
  `supersededByRetryId`;
- `failed`: records with `state === 'failed'`.

`Changed` is a count of unresolved page-change conflicts, not a lifetime event
counter. If a stale record is superseded by a retry, the original stale record no
longer counts as changed. While the retry is queued or translating, it counts as
pending. If the retry succeeds, the UI shows the translated retry record and no
changed count for that logical text. If the retry becomes stale, that retry
record counts as changed. If the retry request fails, that retry record counts as
failed.

If queued retry work is canceled before it is sent, such as by a viewport reset,
the original stale record becomes unresolved again and counts as `Changed` until
the retry record is requeued. If inline translation is stopped while a retry is
queued or translating, the stale parent also returns to `Changed` so stopped
status does not hide unresolved page-change conflicts behind `Pending 0`.

Stopped mode should still show pending as zero:

```text
Visible translation stopped
Translated 34 · Pending 0 · Changed 2 · Failed 1
```

This is a user-facing display change. Keep the current
`getInlineViewportStatusCounts()` helper name and widen its return object to
`{ translated, pending, changed, failed }` so existing call sites keep their
single status-count entry point.

## Retry Policy

When `applyInlineViewportBatchTranslations()` receives a valid translation for a
record but cannot apply it because the node is disconnected or the node text no
longer equals the captured original:

1. Mark the current record `stale`.
2. Do not apply the returned translation.
3. Consider a retry only if the node is still connected.
4. Read the node's current value.
5. Retry only if the current value passes existing `isTranslatableInlineText()`
   checks.
6. Retry only if the record's retry budget has not been used.
7. Retry only if the current value is different from both the old original and
   the returned translation.
8. Queue a new record through `queueInlineViewportRetryRecord()` for the same
   node with the current text as its original, `retryOf` set to the stale record
   id, and `retryCount` incremented to `1`.

Disconnected nodes are not retried because there is no safe target for applying
future output.

If the current node value equals a cached original text, the retry helper should
apply the cached translation instead of sending a retry request. Because the
normal queue helper only checks the cache when `byNode` has no existing record,
the retry helper must perform this cache lookup directly. A cache hit should
create a translated retry record, set `staleRecord.supersededByRetryId`, replace
the `byNode` entry with the translated retry record, append it to
`store.records`, apply the cached translation only if the node still equals the
cached original, and skip queueing an API request.

If the retry record becomes stale, it remains `stale`. The extension should not
loop on pages that continuously mutate text.

## Data Flow

1. The user starts inline viewport translation.
2. The content script scans visible text and queues records as today.
3. The content script sends small visible batches to the background script.
4. The background script returns validated translations.
5. The content script attempts to apply each translation.
6. If the node is unchanged, the translation is applied and cached as today.
7. If the node changed, the original record becomes `stale`.
8. If retry conditions pass, the content script queues a new record using the
   node's current text.
9. The existing queue drain loop sends the retry record in a later visible batch.
10. If the retry succeeds, the superseded stale record is excluded from
    `Changed` and the retry record counts as `Translated`.
11. If the retry is still queued or translating, it counts as `Pending`.
12. If the retry becomes stale or failed, the retry record counts as `Changed`
    or `Failed`.
13. If queued retry work is canceled by viewport reset, the stale parent returns
    to `Changed` until the retry is requeued.
14. If inline translation is stopped with a queued or translating retry, the
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
Translated 18 · Pending 2 · Changed 3 · Failed 1
```

No raw source text, translated text, API keys, request payloads, or per-node
diagnostics should appear in the floating UI.

The Options diagnostics can continue to show recent run status and redacted
errors. This design does not require adding source text or translated text to
diagnostic storage.

## Error Handling

API and validation failures remain batch-level failures. They should mark only
the affected current translating records as `failed`.

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

The retry design must not log changed node text. Tests can use fixed fake text,
but runtime diagnostics should continue to avoid storing source text,
translations, API keys, or request payloads.

The extension must continue to avoid model-generated HTML. It only replaces text
node values after the same ownership checks used by the existing implementation.

## Testing

Focused unit coverage in `tests/content-helpers.test.js` covers:

- `stale` records are counted as `changed`, not `failed`.
- `failed` records still count as `failed`.
- status message formatting includes `Changed`.
- stopped status formatting forces pending to zero while preserving changed and
  failed counts.
- when a node changes before translation application, the original record is
  marked `stale`, marked with `supersededByRetryId`, and a retry record is
  queued with the current node text.
- superseded stale records do not contribute to `changed` counts.
- while a retry record is queued or translating, it contributes to `pending`.
- when a retry succeeds, the final status has no changed count for the
  superseded stale record.
- when a retry becomes stale, the retry record contributes to `changed`.
- disconnected stale nodes are not retried.
- non-translatable changed text is not retried.
- a retry record that becomes stale is not retried again.
- a retry cache hit creates a translated retry record without queueing an API
  request.
- successful retry application follows the existing translated/cache behavior.

Existing tests for operation invalidation, restore behavior, cache reuse,
oversized record failure, API failure, and syntax checks continue to pass.

Run:

```sh
npm test
npm run check:syntax
```

Manual verification should include:

- Gmail message with built-in Gmail translation controls visible.
- A long normal article page without Gmail-specific behavior.
- A page that mutates visible text while inline translation is active.
- Stop and Original text flows after changed records appear.

Expected Gmail result is not "all text always translates." Expected behavior is
that page-change conflicts appear as `Changed`, safe current text gets one retry,
and the extension never overwrites text that changed after capture.

## Implementation Boundary

This document records the design boundary used for the shipped change. The
implementation stayed scoped to inline viewport content-script behavior, focused
helper tests, and README user-facing status documentation.

Implementation files:

- `extension/content.js`
- `tests/content-helpers.test.js`
- `README.md`

`extension/background.js` did not require behavioral changes.
