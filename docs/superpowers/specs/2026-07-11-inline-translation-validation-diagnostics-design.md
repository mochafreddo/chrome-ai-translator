# Inline Translation Validation and Diagnostics Design

Date: 2026-07-11

## Goal

Make inline translation resilient to quality-detector false positives while
preserving strict DOM safety, and leave enough privacy-preserving diagnostic
data for a human or AI agent to reconstruct every partial translation and
failure.

This design replaces two coupled failure modes:

1. Structurally safe translations are discarded when a translation-quality
   heuristic reports possible untranslated prose.
2. Per-block validation codes are discarded after a run, leaving the UI and
   exported diagnostics unable to explain a failure.

## Ruthless Design Principles

- Do not preserve an incorrect internal contract for compatibility alone.
- Delete states, controls, branches, and logs that do not help the user.
- Never weaken DOM structure and ownership safety.
- Never present partial success as complete success.
- Never hide a terminal failure behind an automatic retry.
- Do not persist source text, translated text, URLs, protected labels, request
  bodies, or API keys.
- Do not add configurable retention, cloud reporting, or model-based judging.
- Allow one repair attempt. Never retry indefinitely.

## Scope

This design applies to viewport-first inline semantic-block translation.

It does not change:

- full-page Side Panel Markdown translation;
- API-key storage;
- page-lifetime translation cache semantics;
- DOM ownership checks;
- page-change retry policy, except to separate its budget and diagnostics from
  model-output repair.

## Chosen Architecture

The current single `ok` result conflates protocol validity, DOM safety, and
translation quality. Replace it with a four-stage pipeline:

```text
model response
  -> protocol validation
  -> structure safety validation
  -> translation quality assessment
  -> disposition policy
```

### Protocol Validation

Protocol validation checks:

- valid structured JSON;
- exact request and response IDs;
- missing, duplicate, and unexpected IDs;
- required output fields;
- record and output budgets.

A protocol failure is a request-level failure. The batch is not partially
interpreted after its envelope becomes untrustworthy.

### Structure Safety Validation

Structure validation checks:

- missing, duplicate, injected, or malformed protected tokens;
- wrapper nesting and parent relationships;
- output parseability;
- patch-plan construction;
- DOM ownership immediately before application.

Its result is `safe` or `unsafe`. An unsafe result is never applied to the DOM.

### Translation Quality Assessment

Quality assessment checks:

- shared English prose remaining in a non-English target;
- output that substantially copies the source prose;
- empty translated prose;
- target-language evidence when the detector can make that determination
  conservatively.

Its result is `complete`, `partial`, or `uncertain`. Quality assessment cannot
authorize or prohibit DOM application. It only informs repair and warning
policy.

Technical names, protected atoms, literal tokens, filenames, commands, and API
names must not count as untranslated prose. Quality evidence must be numeric or
categorical and must not retain the matched words.

### Disposition Policy

The policy maps validation results to one of four dispositions:

```js
{
  id,
  disposition: "apply" | "apply_with_warning" | "retry" | "reject",
  structure: {
    status: "safe" | "unsafe",
    codes: []
  },
  quality: {
    status: "complete" | "partial" | "uncertain",
    codes: [],
    evidence: {}
  }
}
```

The policy table is fixed:

| Attempt | Structure | Quality | Result |
| --- | --- | --- | --- |
| Initial | safe | complete | `apply` |
| Initial | safe | partial or uncertain | one quality repair |
| Initial | unsafe | any | one structure repair |
| Repair | safe | complete | `apply` |
| Repair | safe | partial or uncertain | `apply_with_warning` |
| Repair | unsafe | any | `reject` |

There is one initial request and at most one model-output repair request per
logical block. A repair request includes the previous stable diagnostic code so
the model can correct the specific failure.

Page-change retries remain in the content script because they depend on live
DOM ownership. Their one-retry budget is independent from the model-output
repair budget.

## Component Boundaries

Split only the responsibilities required by this design:

```text
extension/background.js
  extension/translation-validation.js
  extension/translation-policy.js
  extension/translation-diagnostics.js
```

### `translation-validation.js`

- Implements protocol, structure, and quality validation.
- Exposes pure functions.
- Depends on the inline block codec for token-contract parsing.
- Does not access Chrome APIs, storage, fetch, or the DOM.
- Does not return source or translated text in validation results.

### `translation-policy.js`

- Converts validation results and attempt metadata into dispositions.
- Owns the model-output repair budget.
- Selects stable diagnostic and user-message keys.
- Is a pure module without storage, network, or DOM dependencies.

### `translation-diagnostics.js`

- Builds run summaries and per-problem-block timelines.
- Redacts and allowlists persisted fields.
- Creates installation-scoped HMAC fingerprints.
- Enforces retention limits.
- Serializes the exported JSON format.
- Is the only module that reads or writes diagnostic storage.

### `background.js`

- Orchestrates the initial OpenAI request and optional repair request.
- Calls validation and policy modules.
- Returns only terminal per-block dispositions to the content script.
- Finalizes diagnostic records.

The content script no longer constructs model-output repair requests. This
keeps the entire request, validation, repair, and terminal-decision lifecycle in
one service-worker operation.

### `content.js`

- Owns live page scanning, record state, DOM ownership, and DOM application.
- Applies only `apply` and `apply_with_warning` results.
- Keeps original DOM content for `reject` results.
- Owns the separate page-change retry.
- Displays user-message keys without interpreting validator internals.

## Runtime Data Flow

```text
serialize visible semantic blocks
  -> initial OpenAI request
  -> validate protocol, structure, and quality
  -> choose disposition
       -> apply
       -> retry -> repair request -> validate -> terminal disposition
       -> reject
  -> content script verifies live DOM ownership
  -> apply translation or keep original
  -> finalize diagnostics
  -> update user-visible counts and reason summaries
```

An operation-level fetch or protocol failure may fail a whole request. A valid
response containing per-record validation failures remains isolated by block.

## State Model and UI

Internal block states become:

- `queued`
- `translating`
- `repairing`
- `translated`
- `translated_with_warning`
- `changed`
- `failed`

The user sees five counts:

```text
Translated 12 · Partial 1 · Pending 0 · Changed 0 · Failed 1
```

Definitions:

- `Translated`: terminal `apply` results successfully applied to owned DOM.
- `Partial`: terminal `apply_with_warning` results successfully applied.
- `Pending`: queued, translating, or repairing work.
- `Changed`: unresolved page-change ownership conflicts.
- `Failed`: rejected, request-failed, or application-failed blocks that remain
  original.

When partial or failed counts are nonzero, the floating UI shows a concise
human explanation for the most recent reason. Examples:

```text
Partial translation
Some English prose remained after one repair attempt.

Translation failed
A protected token was still missing after repair, so the original was kept.
```

Rules:

- Internal codes are not shown without a human explanation.
- Failed blocks remain visually unchanged in the page.
- Partial translations are applied and counted explicitly.
- The page DOM is not decorated with extension-owned error markers.
- Replace the ambiguous `Scan visible text` recovery action with
  `Retry failed blocks` when retryable terminal failures exist.
- A manual retry starts a new diagnostic attempt and does not bypass safety
  validation.

Each terminal record retains a diagnostic reference in page memory:

```js
{
  state: "failed",
  terminalCode: "structure.token_missing",
  attemptCount: 2,
  diagnosticId: "run-.../block-..."
}
```

## Stable Diagnostic Codes

Codes are namespaced and versioned by the surrounding schema:

```text
protocol.invalid_json
protocol.missing_id
protocol.duplicate_id
protocol.unexpected_id
protocol.output_budget_exceeded
structure.token_missing
structure.token_duplicate
structure.token_unknown
structure.token_nesting_invalid
structure.token_parent_changed
structure.output_parse_failed
structure.patch_failed
quality.source_copy
quality.english_residue
quality.empty_prose
quality.target_language_uncertain
runtime.request_failed
runtime.page_changed
runtime.apply_failed
```

New codes may be added without changing existing meanings. Existing codes must
not be repurposed.

## Persisted RCA Data

Store structured diagnostics in `chrome.storage.local`. Diagnostics use an
allowlist serializer; arbitrary exception objects and model output never enter
storage.

Example schema:

```js
{
  schemaVersion: 2,
  runId: "run-...",
  startedAt: "...",
  finishedAt: "...",
  extensionVersion: "0.3.0",
  model: "gpt-5.4-mini",
  targetLanguageCode: "ko",
  outcome: "partial",
  summary: {
    requested: 3,
    translated: 2,
    translatedWithWarning: 1,
    failed: 0,
    repairs: 1
  },
  blocks: [{
    blockDiagnosticId: "block-...",
    sourceFingerprint: "hmac-sha256:...",
    contractFingerprint: "hmac-sha256:...",
    attemptCount: 2,
    terminalDisposition: "apply_with_warning",
    protocol: {
      status: "valid",
      codes: []
    },
    structure: {
      status: "safe",
      codes: [],
      expectedTokenCount: 5,
      returnedTokenCount: 5
    },
    quality: {
      status: "partial",
      codes: ["quality.english_residue"],
      evidence: {
        sourceChars: 286,
        outputChars: 173,
        sharedEnglishSequenceLength: 3,
        sharedEnglishSequenceCount: 1
      }
    },
    timeline: [{
      stage: "initial_validation",
      disposition: "retry",
      codes: ["quality.english_residue"]
    }, {
      stage: "repair_validation",
      disposition: "apply_with_warning",
      codes: ["quality.english_residue"]
    }]
  }]
}
```

Persist block details only for partial, failed, repaired, or changed blocks.
Normal successful blocks contribute only to the run summary.

### Fingerprints

`sourceFingerprint` and `contractFingerprint` support correlation of repeated
failures without retaining input content. Generate them with HMAC-SHA-256 using
an installation-local random secret created once and stored in extension local
storage.

- The source fingerprint covers the normalized source semantic template.
- The contract fingerprint covers the canonical token contract.
- Never export the HMAC secret.
- Raw SHA-256 is not sufficient because predictable documentation text can be
  guessed offline.

### Privacy Allowlist

Persist and export only:

- timestamps and opaque IDs;
- extension, model, and target-language identifiers;
- dispositions and stable codes;
- counts, lengths, ratios, durations, and attempt numbers;
- installation-scoped HMAC fingerprints;
- bounded stage timelines.

Never persist or export:

- source or translated prose;
- matched residue words or snippets;
- URLs, titles, origins, or tab IDs;
- protected atom labels or literal-token values;
- prompts, request bodies, or response bodies;
- API keys, authorization headers, or raw exceptions.

### Retention

- Keep the most recent 20 runs.
- Keep at most 100 problem-block records per run.
- Keep at most two model-validation timeline entries per block: initial and
  repair.
- Do not expose retention settings.
- Remove all legacy `inlineTranslationLogs` entries on first schema-2 write.
- Do not migrate or dual-read legacy diagnostics.

## Diagnostic Export

Options provides exactly two diagnostic actions:

- `Copy diagnostics`: copy redacted schema-2 JSON for recent runs.
- `Save diagnostics`: download the same JSON as a file.

There is no built-in AI analysis, upload, search dashboard, or automatic bug
report. The exported JSON is sufficient for a human or AI agent to reconstruct:

- the failing stage;
- initial and repair outcomes;
- terminal disposition;
- repeated failure fingerprints;
- correlations with extension version, model, target language, and settings;
- whether the failure was protocol, structure, quality, page ownership, or DOM
  application.

## Error Handling

- Fetch and protocol failures produce stable request-level codes and do not
  expose raw provider errors in persisted diagnostics.
- Per-record structure and quality failures remain isolated when the response
  envelope is valid.
- A model-output repair consumes exactly one repair attempt.
- A page-change retry consumes exactly one independent DOM retry.
- Late results from stale operations are ignored and diagnosed only as bounded
  runtime counters; they do not create new model repair attempts.
- A service-worker shutdown may leave a run without `finishedAt`. On the next
  diagnostic write, mark such a run `interrupted` rather than guessing its
  terminal result.
- Diagnostic write failure must not block translation or DOM restoration.

## Migration

This is a clean contract replacement:

- remove the existing per-block `ok/errorCode` result contract;
- remove content-script model-output repair construction;
- remove the legacy inline log schema and formatter;
- remove legacy diagnostic entries on the first schema-2 write;
- read and write only schema 2 after deployment.

Preserve settings, API keys, and page-memory translation caches. No manifest
permission change is required because storage and downloads initiated through
normal browser download behavior are already within the extension's supported
surface; implementation must verify the exact export mechanism before changing
permissions.

## Testing

### Validation Unit Tests

- Every stable protocol and structure failure code.
- Complete, partial, and uncertain quality results.
- Technical names and protected atoms do not trigger English-residue failures.
- Source copying and real English residue are detected.
- Empty translated prose is rejected by quality assessment.
- The reported Claude Code `AGENTS.md` paragraph is a permanent regression
  fixture.
- Validation results contain no source or translated text.

### Policy Table Tests

- Initial unsafe structure requests one structure repair.
- Unsafe structure after repair rejects the block.
- Initial partial or uncertain quality requests one quality repair.
- Partial or uncertain quality after repair applies with warning.
- Only structurally safe results can be applied.
- No logical block makes more than two model requests.

### Diagnostic Tests

- Stable codes, timelines, summaries, and interrupted-run handling.
- Installation-scoped HMAC fingerprints are stable within one installation and
  differ across installation secrets.
- Allowlist serialization rejects API keys, URLs, prose, outputs, labels,
  request bodies, and raw exceptions.
- Retention is 20 runs and 100 problem blocks per run.
- Export JSON round-trips and declares schema version 2.
- The first schema-2 write removes legacy keys.

### Background and Content Integration Tests

- Background returns only terminal block dispositions.
- Partial translations apply and increment the partial count.
- Rejected translations keep the original DOM.
- Model repair and page-change retry budgets remain independent.
- Completed diagnostics survive service-worker restart.
- Diagnostic storage failures do not change translation results.

### Chrome Regression Verification

Verify the original scenario at:

```text
https://code.claude.com/docs/en/memory#agents-md
```

## Completion Criteria

- The reported block is translated or applied as an explicit partial
  translation; a quality heuristic alone cannot silently discard it.
- Structurally unsafe output is never applied.
- Every partial and failed block has a stable terminal code and bounded attempt
  timeline.
- The floating UI explains partial and failed results in human language.
- Exported JSON alone reconstructs initial validation, repair validation, and
  terminal disposition.
- Exported and persisted diagnostics contain no source text, translated text,
  URL, API key, protected label, prompt, or request/response body.
- Full automated tests and extension syntax checks pass.

## Explicit Non-Goals

- Diagnostic search or analytics dashboard.
- Cloud upload or telemetry.
- Automatic bug reports.
- User-configurable retention.
- Unlimited retries.
- A second model acting as a translation judge.
- Compatibility with legacy inline diagnostic logs.
- Site-specific handling for Claude Code documentation.
