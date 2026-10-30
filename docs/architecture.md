# Architecture

This reference describes the current implementation. Domain terms are defined in the [glossary](../GLOSSARY.md), user actions in the [user guide](../README.md), and verification procedures in the [test guide](../tests/README.md). Accepted decisions and historical evidence are listed in the [documentation index](README.md).

## Translation flows

| Property | Side Panel Translation | Inline Translation |
| --- | --- | --- |
| Input | Extracted article Markdown | Visible article prose in Semantic Blocks |
| Work unit | Translation Chunk cut at block boundaries | Whole Semantic Block serialized with its structure |
| Output | Complete translated Markdown in the side panel | Translated prose applied to page-owned nodes |
| Failure boundary | An unrecovered chunk failure ends the whole translation | A failed block leaves its original content and siblings can continue |
| Reuse | A new translation sends the document again | Matching translations are cached within the page visit |

The two flows share settings, Responses API transport, and the [Placeholder Token validator](../extension/placeholder-tokens.js). Their admission rules, result lifetimes, and failure behavior remain separate. Both translation experiences support OpenAI and OpenRouter through the same selected-service transport.

### Side Panel Translation

The side panel sends `TRANSLATE_TAB` to the worker. The worker obtains article extraction from the page's content script, snapshots translation settings, manages per-tab execution and state broadcasts, and delegates document execution to [sidepanel-translation-execution.js](../extension/sidepanel-translation-execution.js).

The settings snapshot includes the selected service and its credential before extraction. OpenAI retains the stored model and reasoning effort. OpenRouter derives the pinned `deepseek/deepseek-v4.1-flash-1017` model and `none` reasoning effort without overwriting stored OpenAI choices. The worker sends only the selected credential to that service's fixed Responses endpoint. OpenRouter requests include `provider: { require_parameters: true, data_collection: 'deny', zdr: true }`; no fallback model or service is configured. Response completion parsing and chunk recovery are shared. OpenRouter HTTP and transport errors use fixed service-attributed messages rather than reflecting provider bodies or thrown network text.

The document path has four responsibilities:

1. [markdown-document.js](../extension/markdown-document.js) converts article DOM into Markdown blocks and a translation document, using [markdown-entries.js](../extension/markdown-entries.js) for link and code entries.
2. [translation-chunks.js](../extension/translation-chunks.js) groups complete blocks into Translation Chunks. Link destinations and code contents are represented by Placeholder Tokens rather than sent as prose.
3. The execution module sends chunks sequentially, using worker-provided API transport. A token-contract failure can buy one corrective request; output truncation can split a chunk at block boundaries. Both consume the same recovery budget, so split children do not get an additional token repair and a repaired chunk does not then split ([ADR-0005](adr/0005-one-recovery-per-translation-chunk.md)).
4. [markdown-rehydration.js](../extension/markdown-rehydration.js) validates returned placeholders and restores the protected Markdown. Execution returns a result only when every chunk succeeds; an unrecovered failure publishes none of the earlier billed answers ([ADR-0006](adr/0006-a-failed-translation-chunk-ends-the-whole-side-panel-translation.md)).

Chunk progress describes work on the original chunks, rather than publishing translated prefixes. Side Panel results do not replace article content on the page; content-script injection for extraction can still mount extension controls according to Button Visibility. Hidden subtrees are excluded by the Markdown serializer rather than sent as article text.

### Inline Translation

Inline controls reach the page through the worker's instruction messages. [content.js](../extension/content.js) connects the UI, browser-message adapter, page state, and Operation. The ongoing flow is:

1. Operation checks authorization and obtains a settings snapshot. Session begins an Operation or an already-active Start asks for a rescan.
2. Viewport discovers visible Semantic Blocks within the article root. Session admits supported blocks through the codec, applies eligible cache hits, and queues the rest.
3. Session assembles bounded batches and charges initial record cost. Operation sends them to the worker as `TRANSLATE_VISIBLE_BLOCK_BATCH`.
4. The worker validates request records through [inline-request.js](../extension/inline-request.js), resolves the snapshot's service and effective settings with that service's current credential, and delegates to [inline-model-execution.js](../extension/inline-model-execution.js). Model execution owns instructions, response format, protocol and structure validation, translation quality, and the decision to permit at most one model-output repair per block. Request preparation owns wire fields, serialization, actual and reserved cost, and optional repair-context fitting. For English-residue repair, a structurally safe previous answer and up to four matched English phrases can accompany the original source when the complete context fits the serialized reservation and assembled repair-request cap. The previous answer is never substituted for the original or truncated to fit; an over-limit context is omitted, first per record and then in input order if the assembled repair exceeds its cap. Translation instructions distinguish descriptive headings, quoted references, emphasized words and prose next to atoms from protected code and identifiers. Language-specific instructions, quality checks, and diagnostic language codes share the target-language classification in [translation-settings.js](../extension/translation-settings.js). Model instructions and cache identity retain the original target-language setting, including regional names and reader-supplied qualifiers.
5. Session settles results, charges reported repairs, verifies current ownership, and applies safe translated templates through [inline-block.js](../extension/inline-block.js). Operation relays runtime outcomes and releases correlation tokens through its browser adapter.

A structurally unsafe result is refused. Structurally safe output that still contains material source-language prose after repair is applied as Partial Translation. Links whose entire label is an account identifier such as `@dev_1-name` use the protected-link atom path: their labels stay unchanged and are excluded from prose-quality checks, while surrounding prose remains translatable. Display names and descriptive link labels retain their existing classification. Failed blocks and unresolved page changes remain separate progress categories.

## Runtime and module ownership

Every extension file is a classic script; there is no bundler or build step. The MV3 worker loads dependencies with `importScripts`, page injection uses the worker's ordered `getInlineContentScriptFiles()` list, and extension pages use HTML script tags. The [manifest](../extension/manifest.json) declares no static `content_scripts`; optional every-page access can install a dynamically registered content script. Shared modules expose a `ChromeAiTranslator*` API on `globalThis` and a guarded CommonJS export for the unit harness.

| Owner | Responsibility |
| --- | --- |
| [background.js](../extension/background.js) | Browser events, message routing, settings adapters, per-tab state, Responses requests, and execution adapters |
| [settings-lifecycle.js](../extension/settings-lifecycle.js) | Settings reads, ordered saves and key removal, normalization, and Button Visibility registration and access reconciliation |
| [worker-invocation.js](../extension/worker-invocation.js) | Toolbar and shortcut preparation, page-load instructions, panel opening, content readiness, instruction transport, and invocation error handling |
| [content.js](../extension/content.js) | Article selection and extraction, floating UI, page instruction handler, persistent page state, and browser adapters |
| [inline-translation-operation.js](../extension/inline-translation-operation.js) | Start/Stop/Original text orchestration, authorization, settings lookup, scanner lifecycle, request transport, and feedback eligibility |
| [inline-translation-session.js](../extension/inline-translation-session.js) | Page-visit budget, cache, progress, per-Operation records, admission, batching, settlement, application, retry, and restore |
| [inline-viewport.js](../extension/inline-viewport.js) | Discovery, bounded scan continuation, viewport reset, and scroll/resize/mutation watchers |
| [inline-block.js](../extension/inline-block.js) | Semantic Block classification, serialization, ownership checks, template validation, application, and restoration |
| [inline-request.js](../extension/inline-request.js) | Pure source-batch validation, actual/reserved record cost, initial/repair wire preparation, and bounded optional repair context |
| [inline-model-execution.js](../extension/inline-model-execution.js) | Inline request construction, protocol/structure/quality validation, one repair, outcomes, and model-validation metadata |
| [inline-local-diagnostic-transport.js](../extension/inline-local-diagnostic-transport.js) | Local diagnostic outbox batching, deferred flush, one retry, and Stop-time sending |
| [inline-diagnostics-controller.js](../extension/inline-diagnostics-controller.js) | Worker diagnostic run lifecycle, runtime correlation, request counts, local rejections, and persistence coordination |
| [inline-diagnostics-protocol.js](../extension/inline-diagnostics-protocol.js) | Allowlisted diagnostic payloads, bounded evidence, validation codes, and local/runtime message contracts |
| [translation-diagnostics.js](../extension/translation-diagnostics.js) | Diagnostic storage, retention, legacy projection, fingerprints, loading, and export |
| [sidepanel.js](../extension/sidepanel.js) | Side Panel Translation controls/output and the separate Inline Translation Section |
| [options.js](../extension/options.js) | Defaults, API-key updates, site-permission choice, and diagnostic viewing/export |

[translation-settings.js](../extension/translation-settings.js), [default-model.js](../extension/default-model.js), [inline-translation-controls.js](../extension/inline-translation-controls.js), [button-visibility.js](../extension/button-visibility.js), [page-access.js](../extension/page-access.js), [openai-response.js](../extension/openai-response.js), and [sidepanel-failure.js](../extension/sidepanel-failure.js) supply shared settings, control/access rules, response handling, and error presentation. Loader maintenance rules belong in [AGENTS.md](../AGENTS.md).

## Session and Operation lifetimes

The Inline Translation Session lasts for one page visit. It owns the Session Budget, cache buckets, translated records, status, and Operation ids. Persistent page state retains the Session across classic-script reinjection; reloading or leaving the page creates a new visit.

An Operation coordinates one active stretch of translation. Stop invalidates it and detaches scanning while preserving existing translations. Original text invalidates it and restores safely owned translated records. Neither action resets the page visit's budget or cache. Starting while active rescans with that Operation's existing settings snapshot. A later Start from stopped or restored state reads settings again: matching translations can carry forward, while translations under different settings are restored where ownership remains safe before new work begins.

Late responses still settle against their originating Session. Reported repairs are charged before current-Operation eligibility is checked. An obsolete response releases its correlation tokens but cannot apply a result, modify replacement records, retry, or take ownership of current feedback. Session performs accounting and DOM state transitions; Operation performs transport and current-lifecycle coordination.

### Cache and page changes

An ordinary queued record that has never been sent can leave and reenter the viewport queue within the same Operation. If its original ownership and supported classification still match, Session reuses its record and serialized payload. Changed source is serialized again into that eligible record. Sent records and page-change retries keep their separate identities and history.

Viewport retains the remaining traversal stack between bounded scans. Scroll, resize and observed DOM changes discard that position. Each synchronous scan shares its style and element-rectangle reads, collects candidates before admission can apply cached translations, then invalidates its remaining position if those applications changed the DOM. The existing node limit, debounce and viewport margin remain unchanged.

Session cache buckets distinguish service, target language, tone, effective model, and reasoning effort. Existing settings without a service select OpenAI. An active Operation retains its starting service and effective settings in its batch snapshot when Options later changes. OpenRouter derives its pinned model and disabled reasoning before cache identity is computed, so stored OpenAI model and reasoning edits do not split that cache. Keys are excluded from cache identity. Entries also require compatible codec, serialized template, and protected context; cache application still checks the current DOM. Cached repair metadata is retained as result history, not charged again. Cache hits send no request and spend no Session Budget.

If the page changes a queued block's text or replaces owned nodes, a returned translation cannot overwrite it. One page-change retry can reserialize eligible current content; the earlier record is excluded from unresolved Changed counts while its retry is pending. Viewport resets preserve a queued retry. Stop discards queued or in-flight retry ownership and exposes the unresolved change again. Page-change retry and model-output repair have separate limits; the original [retry design](design/inline-changed-text-retry-design.md) records the rationale, while Session owns today's transitions.

### DOM boundaries

An explicit `type="button"` inside a Semantic Block can be a preserved atom when its subtree contains only visible text, comments, and non-interactive formatting wrappers. Its label supplies protected context, while the surrounding prose remains translatable. The existing button and its subtree may move with the translated word order; they are not rebuilt. Supported classification and ownership are rechecked before application, cache reuse and restoration. Changed text, nodes, position or support eligibility prevents an overwrite; current attributes such as `aria-expanded` and `disabled` remain page-owned. Retained buttons and their containing wrappers use state-preserving moves when available; the older-browser path keeps the focused branch connected while inserting other children around it. Submit/reset buttons, implicit button types, editable or hidden content, and nested interactive controls remain unsupported.

Semantic Blocks own their prose as a whole ([ADR-0002](adr/0002-translate-semantic-blocks-not-text-nodes.md)). Inline Translation does not apply model-generated HTML. The codec builds output from text and existing page-owned nodes, preserving object identity and verifying ownership before application and restoration.

Leading and trailing Block Children stay at their edges and are excluded from a parent's model request and subtree ownership. A nested Semantic Block can translate and restore independently. Interior Block Children and nested blocks below an inline wrapper remain unsupported ([ADR-0011](adr/0011-exclude-block-children-from-own-prose.md)). A single direct DIV wrapping a TD or TH's whole prose is preserved within that cell's Semantic Block, with only whitespace allowed outside it; generic DIV paragraph inference remains unsupported. Inert Page Nodes preserve identity without contributing prose; responsive hidden alternatives do not expose their hidden text to the model. Viewport discovery skips hidden subtrees. Ambiguous hidden, interactive, or editable content encountered within an Inline candidate block is rejected rather than silently stripped.

Both flows require Placeholder Tokens exactly once with valid nesting. Inline answers alone may omit both tokens of an eligible emphasis wrapper enclosing visible text and no other placeholder; other missing tokens, half-pairs, and unsafe nesting remain refusals. The detached original emphasis is retained for restoration ([ADR-0010](adr/0010-apply-an-answer-that-dropped-a-whole-emphasis-pair.md)). The Inline codec also requires Source Syntax to remain byte-for-byte unchanged and distinguishes it from untranslated prose. Side Panel Translation protects links and code through its placeholder entries rather than implementing that broader Source Syntax check.

## Controls and authorization

The toolbar action opens the side panel and prepares page access without translating. The `translate-inline` shortcut opens the panel and starts Inline Translation. The worker initiates panel opening before awaiting stored settings to preserve the gesture-sensitive call order ([ADR-0001](adr/0001-open-side-panel-from-action-click-handler.md), [ADR-0004](adr/0004-give-the-keyboard-shortcut-to-inline-translation.md)).

The invocation module expresses those paths directly, without a caller-visible step plan or handler dictionary. It owns preparation and its outcomes while the worker retains tab state through an error adapter. Side Panel Translation shares panel opening and content readiness, then keeps its own extraction and document execution. Section controls retain their separate authorization-first, stop-on-failure procedure and use the same instruction transport. General invocation preparation failures allow later instructions to run; an initialization failure stops them, and a failed shortcut start reports its own outcome. Automatic page load returns only the button instruction permitted by Button Visibility.

The Floating Translate Button opens the Inline Translation Section for Start or rescan confirmation; its page-owned host cannot establish visible user intent through `isTrusted` or closed Shadow DOM. The worker opens controls only for the top-level sender tab and grants no authorization on that path. Stop and restore remain available in both locations. Only the section displays progress and errors. Button Visibility controls where the floating button appears, rather than whether Inline Translation is available. Its every-page setting requests optional site permissions and enables dynamic injection; the other settings revoke that broad access. Automatic button appearance does not itself send a model request.

The worker constructs a settings lifecycle with its Chrome interface and content-script file list. The lifecycle exposes `read()`, `save(partial)`, `clearKey(service)`, and `reconcile()`. Reads observe committed storage without waiting for pending saves. Saves, installation normalization, and key removal share an ordered mutation queue; registration uses a separate queue, and startup reconciliation waits for accepted mutations before joining it. Generations prevent older work from revoking a newer every-page permission grant. Storage errors reach the worker's fixed settings error response; registration failure leaves a successful settings write intact. Options retains the gesture-sensitive permission request, while the worker masks credentials in public settings responses.

Programmatic injection confirms a valid `GET_INLINE_TRANSLATION_STATE` response after loading the ordered scripts. An unanswered or malformed response is an initialization failure, separate from Chrome refusing page access. Toolbar and shortcut invocations report it in the Inline Translation Section and stop the remaining page instructions; Side Panel Translation reports it through its own error area before extraction or model requests. A later successful preparation clears the Inline initialization failure. The panel keeps the initial side-panel opening ahead of asynchronous preparation. Automatic injection uses the registered file list and is verified separately; the programmatic check does not repair an old registration or replace code in an already-running worker.

Inline Translation Authorization is separate from Chrome page access and checked before a new start; its lifetime is owned by Operation. An already-active Operation remains authorized after the initial grant expires, and an active Start only rescans. Side Panel Translation does not require that additional Inline authorization. Neither flow can use page access on restricted browser pages.

## Panel state and tab lifetime

Side Panel state carries a worker epoch, an ordered state sequence and a separate body version. Progress-only notifications omit unchanged `extracted` and `translated` fields. The panel recovers a missing body immediately, merges a useful older body without rolling back newer progress, and confirms an unfamiliar notification epoch through a current worker query. Tab visits and new translation actions invalidate previous body ownership and pending display work.

An ordinary state query can acknowledge `{ workerEpoch, bodyVersion }` only after the panel has received both body fields, including explicit null values. The worker omits the fields only for that matching acknowledgement. The panel still renders accepted polling responses from its retained body, preserving language and view changes and repairing externally changed output DOM. One-second polling and independent Inline state responses remain in place. Worker restart discards in-memory results.

Tab removal drops the worker's retained state and active translation, control and invocation identities. Late continuations cannot publish or recreate that tab's state; delayed shortcut selection also validates the tab before invocation. An already started document execution retains its existing request and settlement policy, and other tabs retain their results and active work. These lifecycle guards do not measure heap reclamation.

## Limits and accounting

These values explain visible limits and billing-related behavior. Linked source files own the current constants; serialized record cost, reserved request cost, page characters, and model tokens are different units.

| Constraint | Current value | Source authority |
| --- | --- | --- |
| Side Panel extracted Markdown | 60,000 characters per document | [Document execution](../extension/sidepanel-translation-execution.js) |
| Configurable Translation Chunk target | 12,000 characters by default; 2,000–60,000 allowed | [Settings normalization](../extension/settings-lifecycle.js) |
| Side Panel output cap | At least 8,192 tokens, scaled by template length up to 128,000 | [Chunk execution](../extension/sidepanel-translation-execution.js) |
| Inline Session record and batch admission | 12,000 reserved cost each | [Session](../extension/inline-translation-session.js), [request preparation](../extension/inline-request.js) |
| Inline worker source record and batch admission | 12,000 actual record cost each | [Request preparation](../extension/inline-request.js) |
| Inline record count | 500 per batch, rather than a total for the page or Operation | [Session](../extension/inline-translation-session.js), [request preparation](../extension/inline-request.js) |
| Inline Session Budget | 150,000 actual record cost per page visit | [Session](../extension/inline-translation-session.js) |
| Inline concurrent batches | 2 | [Session](../extension/inline-translation-session.js) |
| Inline output cap | 4,096–16,000 tokens, scaled from record cost | [Model execution](../extension/inline-model-execution.js) |

Reserved cost bounds a request, including conservative wrapper and repair allowance. Optional repair context receives a source-sized allowance capped at 2,048 serialized characters and the remaining space under the record's existing request cap. This can reduce batch size without excluding an individually admissible record. Actual cost counts a record's template and serialized atoms/repair metadata, excluding its id and request wrapper. Session charges actual cost on batch admission, then the reported actual repair-record cost for a contextual repair; other repairs retain the original-record approximation. Cache hits are free. Failed requests and stale results do not refund admission charges.

Repairs without context still use an approximation rather than the worker's exact repair record. Contextual repairs report only their numeric record cost, excluding the prior answer and matched phrases from results and persisted diagnostics. An invalid reported cost charges the request upper bound rather than reducing the charge. A wholly failed batch cannot report a repair count, and a reported repair can push the budget over its limit after the request has already happened; the next batch is then refused. These are known accounting limits, not a monetary spending promise ([ADR-0007](adr/0007-charge-the-session-budget-in-actual-record-cost.md)).

The Session Budget belongs only to the content-script Session. Worker source admission uses actual record cost, while Session batch admission uses reserved cost; these existing rules remain distinct. The worker does not reconstruct a page visit or independently enforce Session's reservation. Diagnostic payload limits are independent and must not be merged with translation accounting ([ADR-0003](adr/0003-leave-the-semantic-block-session-cap-to-the-content-script.md)).

## Diagnostics and privacy

Batch persistence enumerates storage keys with `getKeys()` when that API exists and reads only both namespace indexes and the current run's v2/v3 records. The key list still discovers orphan and legacy records for cleanup after a successful retained write. A missing API keeps the full `get(null)` path; an API failure uses the existing persistence-failure result without a full-read retry. Options loading and export retain their existing read path.

Diagnostics describe Inline Translation only. Current physical writes and exports use schema 3; readers project retained schema-2 runs into that shape. Summary block counts are separate from `modelRequestAttempts`: a settled local-only run has zero model calls, while legacy or interrupted runs without a provable count use `null`. A diagnostics run is a batch-level record, not a page Session or an Operation.

Model validation metadata originates in model execution; worker orchestration supplies attempted-call counts. Session supplies local-preflight and runtime-application outcomes. Operation and the local transport send those outcomes, and the controller associates them with diagnostic runs. Persisted local-rejection metadata permits only an allowlisted reason and tightly validated tag name. Transient page-to-worker diagnostic messages can carry a template and contract for fingerprinting; this extension-internal transport is separate from an OpenAI request and from redacted storage/export.

The retention policy exposes twenty unique runs across v2 and v3 namespaces, with at most one hundred problem blocks per run. Stored/exported fields are allowlisted, with numeric quality evidence and installation-scoped HMAC fingerprints. Source text, translations, matched words, protected labels, URLs, selectors, DOM attributes, request/response bodies, and API keys are excluded. Writes can over-retain after interrupted cleanup rather than erase history before the retained write succeeds. Legacy projection, cross-version idempotency, and the unchanged HMAC-secret key are specified in [ADR-0009](adr/0009-model-local-rejections-in-diagnostics-v3.md).

Translation requests transmit permitted page content to the selected service, and the worker sets `store: false`. Diagnostic redaction does not change the model-input boundary. Options stores independent OpenAI and OpenRouter keys in local extension settings, preserves the selected key on a blank edit, and clears only the selected service's credential. The OpenAI clear action also removes legacy storage. Public settings expose only key-presence masks, and the UI never populates saved values. OpenRouter's no-data-collection and ZDR routing conditions do not erase these local records or imply absence of all request metadata.

## Verification boundary

Unit tests exercise deterministic adapters and local DOM fixtures; source and unit evidence establish implementation contracts, not current live-model quality. Browser checks exercise their stated Chrome/DOM paths, and billed checks exercise real translation. Commands, prerequisites, suite registration, historical negative controls, and each check's limits are in the [test guide](../tests/README.md). Historical plans and QA reports are evidence for their recorded baseline, not instructions to rerun old helpers against the current tree.

### Comparison execution

The comparison tools run outside the extension. [evaluation-execution.mjs](../tests/integration/evaluation-execution.mjs) owns the shared execution lifetime: request admission, reservation evidence, transport, settlement, output records and cleanup. [Routing](../tests/integration/routing-pilot.mjs) and [model-quality](../tests/integration/model-quality.mjs) modules own their experiment plans, request rules and result qualification. The [browser adapter](../tests/integration/routing-pilot-browser.mjs) observes and drives the disposable extension through the existing harness; deterministic adapters exercise the same execution interface without a browser or billed request.

The evaluation budget remains separate from the product's Session Budget. Actual credentials stay inside the existing fixed-host Node transport callback until execution cleanup completes. The browser receives a synthetic credential. Mock completion and structural qualification remain distinct from provider compatibility, measured billing and semantic quality acceptance.
