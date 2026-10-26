# Model quality pilot, 2026-10-25–26

This pilot compares six low-cost OpenRouter profiles through the extension's two translation flows. It measures the combined model profile and application path, rather than establishing a general ranking of the models' intrinsic translation ability. The [design record](../design/openrouter-translation-routing.md#approved-billed-comparison) owns the approved scope; the [preparation report](model-quality-preparation-2026-10-25.md) records the earlier unbilled checks.

GPT-6 Luna is the first candidate for a follow-up value comparison against the current DeepSeek profile. Its observed cost was lower and its accepted count was one higher. That is not sufficient evidence to replace the product default or declare a general quality winner. The shared Source Syntax defects described below need correction before another adoption comparison.

## Observed results

All 144 planned comparison IDs were attempted exactly once, alongside twelve compatibility executions. The 451 unique paid requests comprised 367 comparison initial requests, 72 comparison recovery requests and twelve compatibility requests. Reported spending was USD 0.379044292 against the approved USD 5 limit, with zero reservations and no frozen or unknown cost. Initial comparison requests cost USD 0.345244571, recoveries USD 0.030660331 and compatibility USD 0.003139390. Fees and taxes are outside these figures.

The first process ended after 126 comparison attempts when MiniMax's first literary Inline execution reached 240 seconds. A continuation carried the settled expenditure forward and completed four more attempts before MiMo's first literary Side Panel execution reached the same limit. A final continuation attempted the remaining fourteen IDs. No timed-out or completed ID was repeated. Costs reconciled at USD 0.237795159, USD 0.263474323 and USD 0.379044292 respectively. Original process completion flags remain false for the interrupted plans; the final aggregate establishes complete coverage of planned attempts, rather than successful completion of every translation.

An accepted result satisfies the application contract, completion limit and source-based semantic review. The quality denominator excludes the twelve executions affected by the two common invalid constraints, leaving 22 per profile. Costs below include all 24 comparison attempts, compatibility and recoveries, including failures and excluded cases. Cost per accepted result is therefore an observed pilot ratio, not a general translation tariff.

| Profile | Application contract passed / 24 | Accepted / 22 | Initial / recovery requests | Total USD | USD per accepted result |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek | 21 | 15 | 62 / 9 | 0.072714 | 0.004848 |
| GPT-6 Luna | 21 | 16 | 61 / 6 | 0.056185 | 0.003512 |
| Solar Pro 4 | 18 | 9 | 61 / 18 | 0.065548 | 0.007283 |
| MiMo-V2.6-Flash | 16 | 8 | 62 / 14 | 0.043495 | 0.005437 |
| Claude Haiku 5.5 | 21 | 9 | 62 / 10 | 0.085784 | 0.009532 |
| MiniMax-M3.1-Flash | 20 | 5 | 59 / 15 | 0.055319 | 0.011064 |

The application-contract column is not a translation-quality score. For example, Haiku passed that contract in 21 attempts but only nine comparable displayed translations were accepted after meaning review. MiMo had the lowest total bill, but a higher cost per accepted result than Luna or DeepSeek. Individual failures included substantial untranslated or wrong-language prose, changed quantities, reversed negation or relationships, and damaged technical meanings. A retained original paragraph after validation rejection is not attributed to native model generation.

| Profile | Regression / 6 | New application / 6 | News / 4 | Social / 3 | Literary / 3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek | 4 | 6 | 1 | 3 | 1 |
| GPT-6 Luna | 4 | 5 | 2 | 2 | 3 |
| Solar Pro 4 | 3 | 2 | 2 | 2 | 0 |
| MiMo-V2.6-Flash | 4 | 1 | 1 | 1 | 1 |
| Claude Haiku 5.5 | 4 | 3 | 1 | 1 | 0 |
| MiniMax-M3.1-Flash | 2 | 2 | 0 | 1 | 0 |

The denominators are document/flow conditions, not independent documents. On the paired Luna/DeepSeek conditions, both were accepted twelve times and both rejected three times; Luna alone was accepted four times and DeepSeek alone three times. DeepSeek retained all six new application conditions, while Luna retained five. The literary subset favors Luna but comprises only two correlated chapters and three valid flow conditions. Neither observation establishes a domain-wide winner.

Luna's total observed spend was about 22.7% below DeepSeek's in this pass. Listed token rates alone did not predict the actual bill: on comparison requests, Luna reported 109,222 input and 84,596 output tokens with six recoveries, while Haiku reported 189,031 input and 132,253 output tokens with ten recoveries. Tokenization, generated volume, recovery patterns and observed cache usage are not held equal by a shared per-million-token price ceiling. This does not isolate any one cause of the difference.

All 451 actual-provider fields are unknown. Provider identity, endpoint precision and provider-specific throughput therefore cannot be inferred from this experiment. The descriptive UI-signal medians across all 24 attempts were 9.41 seconds for DeepSeek, 9.71 for Luna, 14.17 for Solar, 12.89 for MiMo, 10.57 for Haiku and 17.48 for MiniMax. These mix document sizes and failed outputs, and are not an accepted-translation speed ranking. MiMo and MiniMax each reached the 240-second limit once on the first literary document.

## Conditions

The [profile definitions](../../tests/integration/model-quality.mjs) own model IDs, reasoning settings and component price ceilings. Provider routing remains default under parameter-support, data-collection denial and ZDR filters. Public endpoint and ZDR inventories are refreshed before paid execution. All six profiles passed the small authored compatibility fixture in both flows, at a combined reported inference cost of USD 0.00313939. This proves compatibility for those observed routes and requests, rather than permanent availability or identical behavior across providers.

The comparison uses twelve frozen English documents: three disclosed regressions, three new application excerpts and six WMT documents. Each profile has one planned execution per document and flow. WMT source text and human references remain outside the repository; model requests do not include the references. The new application excerpts are held out from the earlier regression work, but public-source training contamination is unknown. The two literary documents are consecutive chapters from one work.

Early failures and a timeout left some initial chunks or blocks undispatched; those attempts remain application failures rather than completed translations. Among runs with complete source coverage, three Inline conditions had differing initial request/output-cap fingerprints across profiles: the new application article and both literary chapters. Complete-coverage fingerprints matched within the other 21 document/flow groups. Source-block coverage alone does not make request partitioning and context identical, which further limits a pure model-quality interpretation.

All Inline profiles use the same experimental strict schema without array-length bounds. Required fields and exact response shape/IDs remain checked; repaired placeholder structure is judged through final production application. The schema differs from the product's current schema, so these results cannot be treated as a direct validation of changing the product's fixed model. Product files and defaults are unchanged.

## Shared application defects and exclusions

Two Inline document/flow pairs have invalid source-preservation constraints: the second WMT social document protects `U.S`, and the second literary chapter protects `we...we`. The [classifier](../../extension/inline-block.js) treats their dotted endings as file extensions and requires unchanged spelling. Natural Korean translations then fail `source_syntax_changed`. Both cases were reproduced through the public codec with short, project-authored sentences. An independent control confirmed that actual `README.md` protection still accepts the unchanged filename and rejects its replacement.

This contradicts the [Source Syntax definition](../../GLOSSARY.md), which keeps ordinary linguistic abbreviations translatable. The private fixture verifier also confirmed decoded text identity against all six captured WMT sources. These cases are application-rule false positives, rather than evidence that normalization invented notation or that every provider returned untranslated English. The production validator can retain the original paragraph after rejecting a generated translation; raw provider response text was not retained for attribution.

The twelve affected executions remain in actual spending and application-outcome totals. Both pairs are excluded from the model-profile quality comparison, leaving 22 comparable executions per profile. The defects were not fixed during the frozen experiment.

## Review method

Randomized review copies contain the English source and displayed translation without model identity. Separate mappings are used only for analysis. LLM reviewers compare source meaning, omissions, negation, quantities, technical relationships and substantial untranslated prose. A positive verdict requires the full source and output to be read. A decisive failure can stop further error enumeration; its checked scope is recorded. WMT references are aids rather than literal gold answers, and some long-document reviewers used the English source alone.

Contextually recoverable terminology, awkward style and minor compression do not alone reject a page. Borderline cases received a separate materiality review before result mapping. For example, the [Ministry of Education terminology table](https://www.goe.go.kr/resource/old/BBSMSTR_000000030136/BBS_202304060600195200.pdf), printed page 349, maps the ambiguous Korean term `미행성` to both `planetoid` and `planetesimal`; that term alone was therefore not treated as a conclusive concept change. Operational field names and the literal `none` value in a card-writing example were judged consistently as literal contracts. An alternative explanatory reading of that example is a sensitivity limitation.

These are exploratory source-based LLM judgments, not professional human MQM ratings, COMET scores or an official WMT system evaluation. FLORES was not accessed. Review contexts are separate, but that does not establish independent model-family biases or a formal reliability estimate.

Treating the unprotected card example as explanatory prose rather than a literal operational example adds one accepted condition each for DeepSeek, Luna, Haiku and MiniMax. This alternative reading does not change the top pair, but it can change the ordering of lower candidates. Judgments were fixed before aggregate mapping; the calibration and sensitivity records remain with the private evidence.

## Decision

The evidence supports retaining DeepSeek as the current control and prioritizing GPT-6 Luna for a follow-up comparison after correcting Source Syntax classification. Retaining the default reflects insufficient replacement evidence, rather than proven superiority of DeepSeek. The other four profiles do not earn priority over that pair under these observed settings and application paths. This is a shortlist decision, not a production model change.

General intelligence scores, advertised throughput and OpenRouter usage rankings remain candidate-discovery signals. Actual application acceptance, full request/recovery cost and completed-document behavior decide this translation use case. The experiment does not establish a better provider-routing policy for Luna or identify the providers responsible for the observations. Product routing remains unchanged.

## Cost and timing boundaries

The authorized USD 5 envelope includes compatibility, initial requests and production recovery. The [ledger](../../tests/integration/routing-budget.mjs) reserves a conservative full-context input bound and the request's output cap before each POST, rounds reported costs upward to nanodollars and stops on unknown cost. Credit-purchase fees and taxes are excluded. A settled timeout is retained as that attempt's failure; only unattempted canonical IDs continue after request-cost reconciliation, with prior expenditure included in the same total limit. A continuation does not repeat the timed-out attempt.

Timing is the saved UI completion/control-condition duration, recorded before final accounting and protection checks. It includes the controlled Node relay and browser driver, and is not raw provider time to first token or tokens per second. A page has a 240-second completion limit. A translation that appears during subsequent accounting drain still misses that limit. This single pass, serial execution and later continuation order do not establish stable latency percentiles or a causal speed ranking. Fast but incorrect output does not qualify as an accepted translation.

## Verification

The final browser-free unit suite passed 754 checks. The full unbilled preparation passed 144 page executions and 642 intercepted requests. After adding reconciled opening expenditure and canonical plan subsets, focused checks, syntax checks, a reordered two-run mock and two separate browser segments sharing one ledger passed. Seven paid-phase admission, budget and plan mutations were caught on secret-free copies. Independent static review found no remaining spending or replay blocker; the one-off continuation depends on separately reconciled and fixed local receipts rather than a general-purpose resumable CLI.

The two expected-failing Source Syntax reproductions are diagnostic evidence of existing product defects, not passing product regression tests or completed fixes. The earlier invalid reproduction attempt used the fixture helper incorrectly and is not counted. No product deployment, installation, commit or push is part of this work.
