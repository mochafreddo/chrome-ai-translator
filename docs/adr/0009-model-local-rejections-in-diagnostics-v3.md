# Model local rejections explicitly in diagnostics v3

Status: accepted

Diagnostics schema v3 records a Semantic Block rejected before a model request at the `local_preflight` stage, with an optional `localRejection` containing only an allowlisted reason and offending tag name; source text, DOM paths, attributes, and arbitrary evidence remain excluded.

## Schema and count units

The export and every physical v3 record use `schemaVersion: 3`. Summary fields are `attemptedBlocks`, `translatedBlocks`, `translatedWithWarningBlocks`, `failedBlocks`, `changedBlocks`, `repairAttemptedBlocks`, and `modelRequestAttempts`.

`attemptedBlocks` is the number of Semantic Blocks the run took on. For a settled run that equals the sum of translated, warning, failed, and changed block counts. `repairAttemptedBlocks` counts Semantic Blocks that used the one allowed repair, not model HTTP calls.

`modelRequestAttempts` counts model calls. A completed local-only run records `0`. A completed model-backed run records the exact number of attempted calls, including a call that threw. A legacy schema-2 run, or an interrupted run that cannot prove the count, records `null` rather than zero.

When a v2 record is read, `requested` maps to `attemptedBlocks`, the existing result and repair counts map to the named block fields, and `modelRequestAttempts` is `null`.

## Stage vocabulary

A Semantic Block rejected before a model request is assembled uses `local_preflight`. Initial model validation, the one repair validation, and runtime patch or ownership failures keep `initial_validation`, `repair_validation`, and `runtime_application`.

## Privacy boundary

Only allowlisted diagnostic fields are persisted or exported. Quality evidence stays numeric. Local rejection metadata, when present, is a dedicated object — not quality evidence — and may carry only a stable reason from the allowlist and a tightly validated canonical tag name. Source text, selectors, DOM paths, attributes, class names, custom-element identifiers, fingerprints in issue reports, and arbitrary extra fields stay out.

## Retention, namespaces, and HMAC continuity

Physical writes go only to `inlineDiagnostics:v3:index` and `inlineDiagnostics:v3:run:<id>`. Readers merge that index with `inlineDiagnostics:v2:index`, project both into the v3 export shape, sort newest first by walking the v3 index then the v2 index, drop duplicate run ids in favour of the v3 record, and expose twenty unique runs.

The twenty-run cap is global across both namespaces. A successful write updates retained indexes and records, then removes evicted run keys. Interrupted cleanup may therefore over-retain; it must not erase history that the retained write never committed. Legacy ids stay on the v2 index until that global eviction removes them.

Cross-version idempotency inspects the same run id in both namespaces. A matching HMAC fingerprint is a duplicate that may be represented in v3. A different valid fingerprint is a conflict and is not overwritten.

The installation HMAC secret remains `inlineDiagnostics:v2:hmacSecret`. The schema upgrade does not rotate, copy, or rename it, so fingerprints stay continuous.
