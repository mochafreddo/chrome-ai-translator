# Model quality preparation, 2026-10-25

The approved Q13 preparation completed 144 intercepted page executions across twelve documents, two translation flows and six candidate profiles. All runs passed the mock's request, coverage, displayed-prose and protected-content checks. No model credential was read and no billed inference was dispatched. This is preparation evidence, not a translation-quality ranking or proof of live provider compatibility.

The [design record](../design/openrouter-translation-routing.md#final-unpaid-preparation-proposal) defines the scope and review base `ada35d914b6c73439f4e6b700f19fee1888d6d26`. The [test guide](../../tests/README.md#model-quality-corpus-preparation) describes the mock command and its boundaries. Public source excerpts and notices are in the [application manifest](../../tests/integration/fixtures/model-quality/corpus.json); six WMT documents and separate human references remain outside the repository. The runner does not load those references. FLORES remains pending authorized access.

## Observed preparation results

The final quality pass recorded 642 unique intercepted requests: 372 initial requests and 270 Inline repair requests. Every run used a fresh document and candidate initial inputs and output caps matched within each page/flow pair. All 72 Inline executions verified application to their expected nodes and ended with zero pending, changed or failed blocks. Source-to-request coverage, DOM-to-extracted protected content and deterministic displayed prose checks passed for all runs. Source inventories and per-run evidence were retained privately. The growing whole-document viewport makes these checks independent of reader scrolling but does not represent normal reading behavior.

Synthetic responses preserve the English source with a Korean prefix. They intentionally exercise English-residue recovery; 1,416 Partial Translation block outcomes were recorded across all candidates. These outcomes are properties of the fake answer and do not measure the candidates' translation ability. Every `qualityAccepted` and actual-cost value remains `null`. Synthetic accounting settled 642 fixed USD 0.0001 charges, totaling USD 0.0642 with zero reservations; that number is not an OpenRouter bill or a new paid authorization.

The browser census negative controls first established a passing source baseline, then independently removed a duplicated Inline prose occurrence, a duplicated Side Panel prose occurrence, a code entry and a link entry. All four were rejected through the actual source-to-census path and the disposable DOM/functions were restored. Separate checks rejected dropped displayed prose, reused occurrences and code whitespace changes.

## Cost scenarios

The recorded requests contain 4,722,620 serialized request bytes and 3,313,164 output tokens of aggregate requested capacity. The following scenario treats each request byte as one input token, assumes every output cap is fully consumed and applies each profile's recorded price ceiling. It includes the synthetic recovery request pattern; it is not model-specific tokenization, an actual bill, a forecast or an enforced ceiling. Provider-added prompts, changed eligibility/prices and a different real repair pattern can change costs. Cache discounts are not assumed; explicit cache-write charges, optional tools, credit-purchase fees and taxes are excluded.

| Profile | Page runs | Initial / repair requests | Request bytes | Output-token capacity | Scenario USD |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek | 24 | 62 / 45 | 787,995 | 552,194 | 0.8990 |
| GPT-6 Luna | 24 | 62 / 45 | 786,497 | 552,194 | 0.3902 |
| Solar Pro 4 | 24 | 62 / 45 | 786,497 | 552,194 | 0.4493 |
| MiMo-V2.6-Flash | 24 | 62 / 45 | 787,032 | 552,194 | 0.2648 |
| Claude Haiku 5.5 | 24 | 62 / 45 | 787,460 | 552,194 | 0.3903 |
| MiniMax-M3.1-Flash | 24 | 62 / 45 | 787,139 | 552,194 | 0.8988 |

The unrounded total is USD 3.29244422 for one such pass. It replaces the earlier generic 100,000-input/100,000-output illustration as the request-sized planning scenario, while retaining the limitations above. A live spending limit, compatibility probe and repetition count have not been approved for this separate model comparison. The previous routing pilot's USD 2 authorization is not reused.

## Verification and limits

The final browser-free unit suite passed 745 checks with exit zero. Extension syntax, new evaluation-module syntax and documentation checks passed. The existing routing mock also passed all 36 executions with 78 intercepted requests, preserving its DeepSeek-only comparison behavior. Final runtime/tool source fingerprints matched the frozen inputs after these checks.

Six source mutations were caught on disposable, secret-free code snapshots using the standard mutation probe: wrong model acceptance, missing ZDR enforcement, acceptance of extra response fields, missing application evidence, accepting empty chunks and missing observed completion evidence. The empty-chunk mutation was corrected to replace the Boolean operand without introducing a newline-return error; the valid mutant kept the positive case passing and failed at the intended empty-input assertion. The earlier mechanically caught but invalid diagnostic is superseded. A test assertion about metadata prose wording was removed under the repository's no-prose-wording-test rule; the functional reference-exclusion checks remain.

Independent static review identified completion/application and source-inventory false-pass risks. They were corrected before final verification, including duplicate occurrence consumption, DOM-to-extraction protection checks and displayed-prose coverage. The final review found no additional blocking defect; a separate evidence audit confirmed totals and arithmetic. Debug attempts and corrected negative-control evidence remain private and are not counted as final passing runs.

The mock cannot establish actual endpoint availability under the full Responses/schema/privacy intersection, actual reasoning behavior, translation correctness, real latency or real cost. MiMo's disabled-reasoning profile remains tentative. The common Inline schema differs from the product schema, so prior production-schema scores are not a directly comparable baseline. WMT's two literary chapters are correlated samples from one work; normalized HTML does not recreate original websites or social screenshots. No product files, model defaults, credentials, installation, Git publication or paid execution were part of this preparation.
