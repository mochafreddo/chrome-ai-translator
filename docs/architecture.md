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

The two flows share settings, Responses API transport, and the [Placeholder Token validator](../extension/placeholder-tokens.js). Their admission rules, result lifetimes, and failure behavior remain separate.

### Side Panel Translation

The side panel sends `TRANSLATE_TAB` to the worker. The worker obtains article extraction from the page's content script, snapshots translation settings, manages per-tab execution and state broadcasts, and delegates document execution to [sidepanel-translation-execution.js](../extension/sidepanel-translation-execution.js).

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
4. The worker validates request records and delegates to [inline-model-execution.js](../extension/inline-model-execution.js). Model execution builds structured JSON requests, validates protocol and structure, assesses translation quality, and permits at most one model-output repair per block.
5. Session settles results, charges reported repairs, verifies current ownership, and applies safe translated templates through [inline-block.js](../extension/inline-block.js). Operation relays runtime outcomes and releases correlation tokens through its browser adapter.

A structurally unsafe result is refused. Structurally safe output that still contains material source-language prose after repair is applied as Partial Translation. Failed blocks and unresolved page changes remain separate progress categories.

## Runtime and module ownership

Every extension file is a classic script; there is no bundler or build step. The MV3 worker loads dependencies with `importScripts`, page injection uses the worker's ordered `getInlineContentScriptFiles()` list, and extension pages use HTML script tags. The [manifest](../extension/manifest.json) declares no static `content_scripts`; optional every-page access can install a dynamically registered content script. Shared modules expose a `ChromeAiTranslator*` API on `globalThis` and a guarded CommonJS export for the unit harness.

| Owner | Responsibility |
| --- | --- |
| [background.js](../extension/background.js) | Browser events, message routing, settings, per-tab state, Responses requests, and execution adapters |
| [content.js](../extension/content.js) | Article selection and extraction, floating UI, page instruction handler, persistent page state, and browser adapters |
| [inline-translation-operation.js](../extension/inline-translation-operation.js) | Start/Stop/Original text orchestration, authorization, settings lookup, scanner lifecycle, request transport, and feedback eligibility |
| [inline-translation-session.js](../extension/inline-translation-session.js) | Page-visit budget, cache, progress, per-Operation records, admission, batching, settlement, application, retry, and restore |
| [inline-viewport.js](../extension/inline-viewport.js) | Discovery, bounded scan continuation, viewport reset, and scroll/resize/mutation watchers |
| [inline-block.js](../extension/inline-block.js) | Semantic Block classification, serialization, ownership checks, template validation, application, and restoration |
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

Session cache buckets distinguish target language, tone, model, and reasoning effort. Entries also require compatible codec, serialized template, and protected context; cache application still checks the current DOM. Cached repair metadata is retained as result history, not charged again. Cache hits send no request and spend no Session Budget.

If the page changes a queued block's text or replaces owned nodes, a returned translation cannot overwrite it. One page-change retry can reserialize eligible current content; the earlier record is excluded from unresolved Changed counts while its retry is pending. Viewport resets preserve a queued retry. Stop discards queued or in-flight retry ownership and exposes the unresolved change again. Page-change retry and model-output repair have separate limits; the original [retry design](design/inline-changed-text-retry-design.md) records the rationale, while Session owns today's transitions.

### DOM boundaries

Semantic Blocks own their prose as a whole ([ADR-0002](adr/0002-translate-semantic-blocks-not-text-nodes.md)). Inline Translation does not apply model-generated HTML. The codec builds output from text and existing page-owned nodes, preserving object identity and verifying ownership before application and restoration.

Leading and trailing Block Children stay at their edges and are excluded from a parent's model request and subtree ownership. A nested Semantic Block can translate and restore independently. Interior Block Children and nested blocks below an inline wrapper remain unsupported ([ADR-0011](adr/0011-exclude-block-children-from-own-prose.md)). Inert Page Nodes preserve identity without contributing prose; responsive hidden alternatives do not expose their hidden text to the model. Viewport discovery skips hidden subtrees. Ambiguous hidden, interactive, or editable content encountered within an Inline candidate block is rejected rather than silently stripped.

Both flows require Placeholder Tokens exactly once with valid nesting. Inline answers alone may omit both tokens of an eligible emphasis wrapper enclosing visible text and no other placeholder; other missing tokens, half-pairs, and unsafe nesting remain refusals. The detached original emphasis is retained for restoration ([ADR-0010](adr/0010-apply-an-answer-that-dropped-a-whole-emphasis-pair.md)). The Inline codec also requires Source Syntax to remain byte-for-byte unchanged and distinguishes it from untranslated prose. Side Panel Translation protects links and code through its placeholder entries rather than implementing that broader Source Syntax check.

## Controls and authorization

The toolbar action opens the side panel and prepares page access without translating. The `translate-inline` shortcut opens the panel and starts Inline Translation. The worker initiates panel opening before awaiting stored settings to preserve the gesture-sensitive call order ([ADR-0001](adr/0001-open-side-panel-from-action-click-handler.md), [ADR-0004](adr/0004-give-the-keyboard-shortcut-to-inline-translation.md)).

The Floating Translate Button and Inline Translation Section share start, stop, and restore availability rules. Only the section displays progress and errors. Button Visibility controls where the floating button appears, rather than whether Inline Translation is available. Its every-page setting requests optional site permissions and enables dynamic injection; the other settings revoke that broad access. Automatic button appearance does not itself send a model request.

Inline Translation Authorization is separate from Chrome page access and checked before a new start; its lifetime is owned by Operation. An already-active Operation remains authorized after the initial grant expires, and an active Start only rescans. Side Panel Translation does not require that additional Inline authorization. Neither flow can use page access on restricted browser pages.

## Limits and accounting

These values explain visible limits and billing-related behavior. Linked source files own the current constants; serialized record cost, reserved request cost, page characters, and model tokens are different units.

| Constraint | Current value | Source authority |
| --- | --- | --- |
| Side Panel extracted Markdown | 60,000 characters per document | [Document execution](../extension/sidepanel-translation-execution.js) |
| Configurable Translation Chunk target | 12,000 characters by default; 2,000–60,000 allowed | [Worker settings normalization](../extension/background.js) |
| Side Panel output cap | At least 8,192 tokens, scaled by template length up to 128,000 | [Chunk execution](../extension/sidepanel-translation-execution.js) |
| Inline record and batch admission | 12,000 reserved cost each | [Session](../extension/inline-translation-session.js), [worker request validation](../extension/background.js) |
| Inline record count | 500 per batch, rather than a total for the page or Operation | [Session](../extension/inline-translation-session.js), [worker request validation](../extension/background.js) |
| Inline Session Budget | 150,000 actual record cost per page visit | [Session](../extension/inline-translation-session.js) |
| Inline concurrent batches | 2 | [Session](../extension/inline-translation-session.js) |
| Inline output cap | 4,096–16,000 tokens, scaled from record cost | [Model execution](../extension/inline-model-execution.js) |

Reserved cost bounds a request, including conservative wrapper and repair allowance. Actual cost counts a record's template and serialized atoms/repair metadata, excluding its id and request wrapper. Session charges actual cost on batch admission, then the original record cost again for a matching result reporting a repair. Cache hits are free. Failed requests and stale results do not refund admission charges.

The repair charge is an approximation: Session does not receive the worker's exact repair request. A wholly failed batch cannot report a repair count, and a reported repair can push the budget over its limit after the request has already happened; the next batch is then refused. These are known accounting limits, not a monetary spending promise ([ADR-0007](adr/0007-charge-the-session-budget-in-actual-record-cost.md)).

The Session Budget belongs only to the content-script Session. Worker batch and record caps validate individual requests without reconstructing a page visit. Diagnostic payload limits are independent and must not be merged with translation accounting ([ADR-0003](adr/0003-leave-the-semantic-block-session-cap-to-the-content-script.md)).

## Diagnostics and privacy

Diagnostics describe Inline Translation only. Current physical writes and exports use schema 3; readers project retained schema-2 runs into that shape. Summary block counts are separate from `modelRequestAttempts`: a settled local-only run has zero model calls, while legacy or interrupted runs without a provable count use `null`. A diagnostics run is a batch-level record, not a page Session or an Operation.

Model validation metadata originates in model execution; worker orchestration supplies attempted-call counts. Session supplies local-preflight and runtime-application outcomes. Operation and the local transport send those outcomes, and the controller associates them with diagnostic runs. Persisted local-rejection metadata permits only an allowlisted reason and tightly validated tag name. Transient page-to-worker diagnostic messages can carry a template and contract for fingerprinting; this extension-internal transport is separate from an OpenAI request and from redacted storage/export.

The retention policy exposes twenty unique runs across v2 and v3 namespaces, with at most one hundred problem blocks per run. Stored/exported fields are allowlisted, with numeric quality evidence and installation-scoped HMAC fingerprints. Source text, translations, matched words, protected labels, URLs, selectors, DOM attributes, request/response bodies, and API keys are excluded. Writes can over-retain after interrupted cleanup rather than erase history before the retained write succeeds. Legacy projection, cross-version idempotency, and the unchanged HMAC-secret key are specified in [ADR-0009](adr/0009-model-local-rejections-in-diagnostics-v3.md).

Translation requests still transmit permitted page content to OpenAI, and the worker sets `store: false`. Diagnostic redaction does not change the model-input boundary. Options stores the API key in local extension settings, preserves it on a blank edit, and clears both current and legacy storage through its clear action.

## Verification boundary

Unit tests exercise deterministic adapters and local DOM fixtures; source and unit evidence establish implementation contracts, not current live-model quality. Browser checks exercise their stated Chrome/DOM paths, and billed checks exercise real translation. Commands, prerequisites, suite registration, historical negative controls, and each check's limits are in the [test guide](../tests/README.md). Historical plans and QA reports are evidence for their recorded baseline, not instructions to rerun old helpers against the current tree.
