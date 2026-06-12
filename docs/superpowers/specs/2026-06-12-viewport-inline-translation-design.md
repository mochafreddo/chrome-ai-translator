# Viewport-First Inline Translation Design

Date: 2026-06-12

## Goal

Improve inline page translation UX for long pages by showing useful translated
text quickly. Replace the current `Page in Korean` behavior with an active
viewport-first mode: translate text that is visible now, apply each successful
batch immediately, and continue translating newly visible text as the user
scrolls.

The existing side panel Markdown translation remains unchanged.

## User Decisions

- Optimize for the first translated text appearing quickly.
- Keep successful partial translations when later batches fail.
- Prioritize text currently visible in the viewport.
- Change inline mode from whole-page translation to current-view translation.
- Keep the mode active while the user scrolls.
- Accumulate translated text as the user moves through the page.
- Reuse the existing `Page in Korean` menu action for this new behavior.

## Non-Goals

- Do not make inline mode translate the entire page in the background.
- Do not persist translated page text across reloads.
- Do not cache translations across sessions.
- Do not change the side panel translation workflow.
- Do not send raw HTML to the model or insert model-generated HTML.
- Do not translate skipped code-like, link-like, or UI chrome text that current
  filters already protect.

## Current Context

The current implementation already has conservative text-node extraction,
structured JSON output, response validation, operation IDs, progress messages,
and original-text restoration.

The main UX problem is that inline translation waits for all requested text-node
translations to return before applying anything. On long pages this makes the
page appear idle even when background chunks are being processed.

## UX

When the user chooses `Page in Korean`, the floating inline translator enters an
active mode. It immediately scans the current viewport plus a small margin and
queues only eligible, visible text nodes.

Each successful batch is applied as soon as it returns. The user can start
reading translated text without waiting for the rest of the page. While active
mode is on, scrolling or resizing triggers a short debounced scan. Newly visible,
previously unseen text nodes are queued and translated.

Translated text stays in the page after it scrolls out of view. `Original text`
restores all text that was translated during the active session and turns active
mode off.

The floating UI should show compact cumulative status in this shape:

```text
Visible translation on
Translated 18 · Pending 4 · Failed 1
```

The UI should also expose a `Stop` action that prevents additional scans and
new API requests while leaving already applied translations in place.

## State Model

The content script owns per-page runtime state. It should track each observed
text node with a `WeakMap<TextNode, record>` so repeated scans do not create
duplicate requests.

Each record has one of these states:

- `original`: observed but not currently queued.
- `queued`: visible and waiting to be sent.
- `translating`: included in an in-flight API request.
- `translated`: translation applied successfully.
- `failed`: the batch failed or failed validation; original text remains.
- `stale`: the node disconnected or changed before safe application.

Records store:

- A stable request ID for model round trips.
- The `TextNode` reference.
- The original text captured when queued.
- The translated text after success.
- The current state.
- The operation ID that owns the request.

Before applying a translation, the content script must verify that the node is
still connected and `node.nodeValue === original`. If not, mark the record
`stale` and leave the current page text unchanged.

## Viewport Scanning

The content script should keep the existing article-first root selection and
skip rules. It should add a viewport visibility filter for candidate text nodes.

For each eligible text node:

1. Use its parent element range or bounding client rect to decide whether it is
   visible.
2. Include nodes inside the viewport plus a prefetch margin equal to half the
   current viewport height above and below the viewport.
3. Ignore nodes that already have `queued`, `translating`, or `translated`
   records.
4. Allow failed nodes to remain failed unless the user restarts a new active
   session.

Scanning triggers:

- Initial `Page in Korean` action.
- Debounced `scroll`.
- Debounced `resize`.
- Debounced mutation observer callback for article content changes.

Use a 250 ms debounce for scroll, resize, and mutation-triggered scans.

## Batching And Requests

The current background translation helpers should be reused where practical:

- settings and API key loading
- text-node translation instructions
- JSON schema response format
- response parsing and ID validation
- sanitized inline run logging

Add a batch-oriented message path named `TRANSLATE_VISIBLE_TEXT_BATCH` that
translates one small set of visible records and returns only that batch's
translations.

Batching should be based primarily on character count rather than node count.
Use a default visible batch budget of 2,000 source characters to improve time to
first visible result. Limit active visible-batch requests to 2 at a time to
prevent cost spikes while scrolling.

The content script should keep a pending queue. When a batch starts, records
move from `queued` to `translating`. When the batch succeeds, apply valid
translations immediately. When it fails, mark only that batch's records as
`failed`.

## Data Flow

1. The user opens the floating menu and chooses `Page in Korean`.
2. The content script increments an active operation ID and enters active mode.
3. The content script scans the current viewport and queues eligible text nodes.
4. The content script drains queued records into small visible batches.
5. The background script translates each batch using structured JSON output.
6. The background script validates IDs and returns the batch translations.
7. The content script verifies node freshness and applies successful
   translations immediately.
8. The user scrolls.
9. The content script scans the newly visible area and queues only unseen text.
10. `Original text` restores all translated records and invalidates in-flight
    responses by changing the operation ID.

## Error Handling

- Missing API key: do not enter active mode; show a short options guidance
  message.
- Unsupported page: show a short inline error and leave the page unchanged.
- No useful visible text: keep active mode available and show that no visible
  text was found.
- Batch API failure: mark that batch `failed`; keep already translated batches.
- Invalid JSON or ID mismatch: mark that batch `failed`; keep already
  translated batches.
- Node disconnected or changed: mark that record `stale`; do not overwrite page
  text.
- User restores original text: restore translated records, stop active mode, and
  ignore late responses from older operation IDs.
- Fast scrolling: coalesce scans with debounce and enforce the in-flight batch
  limit.

Partial failure is a normal active-mode state, not a full-page failure.

## UI

Keep the floating button and menu compact. The important user-visible changes
are:

- `Page in Korean` starts viewport-first active mode.
- Button label reflects active/translated status.
- Menu shows cumulative counts for translated, pending, and failed nodes. Stale
  nodes are counted as failed in the user-facing summary.
- `Original text` restores all translated text and exits active mode.
- `Stop` stops future scans and queue draining without reverting already
  translated text.

The UI should not show raw source text, translated text, API keys, or detailed
request payloads.

## Testing

Add focused Node tests for pure helpers and state transitions:

- viewport inclusion with and without prefetch margin
- record state transitions from `original` to `queued` to `translating` to
  `translated`
- duplicate suppression for repeated scans of the same text node
- successful partial application while failed records remain original
- stale detection when node text changes before application
- operation ID invalidation for late responses after restore or stop
- cumulative status counts for UI messages
- character-budget batch creation
- in-flight concurrency limit behavior

Manual verification:

- On a long article, `Page in Korean` translates the current visible area first.
- Scrolling down translates newly visible paragraphs.
- Previously translated paragraphs remain translated.
- `Original text` restores all translated paragraphs.
- API failure keeps successful translations and leaves failed text original.
- Existing side panel translation still works.
- Existing code-like and page-chrome skip rules still protect unsafe text.

## Implementation Boundary

This spec covers the design only. Implementation should be planned separately
before code changes. The implementation should stay concentrated in
`extension/content.js`, `extension/background.js`, and the existing tests unless
the plan identifies a narrower helper extraction that reduces risk.
