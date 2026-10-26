# OpenRouter translation routing pilot, 2026-10-25

This descriptive record reports the authorized fixed-model pilot in the [design](../design/openrouter-translation-routing.md). The inspected repository baseline is `ada35d914b6c73439f4e6b700f19fee1888d6d26`, with the evaluation tools added in the working tree. No product routing default, model, translation prompt or recovery rule was changed. No commit or publication was requested.

## Decision supported by this pilot

The evidence supports retaining the existing default provider routing rather than adopting throughput-first routing globally. Throughput-first routing completed accepted matched samples faster, but had fewer quality-accepted page translations and a higher total model cost. Neither arm met a zero-material-error acceptance bar across every sample; choosing provider speed did not solve model translation accuracy. These observations do not prove routing policy caused the semantic differences.

## Scope and method

The same pinned model, disabled reasoning, Korean target language, technical tone, privacy filters and output/recovery limits were used in both arms. The [corpus manifest](../../tests/integration/fixtures/routing-pilot/corpus.json) identifies normalized public excerpts from Python documentation, GitHub gstack documentation and NASA. Three repetitions of three excerpts under two routing policies and two translation experiences produced 36 page translations. Both arms applied identical price ceilings; the comparison is default versus throughput sorting under those ceilings.

Each run used a fresh document. A fixed tall viewport exposed the short excerpts together. The Side Panel serializer used its supported namespace option to fix random Placeholder Token names, and every paired initial request fingerprint and output limit matched. All 36 planned runs completed, with 66 actual Responses POSTs including 18 repair requests. All 66 responses reported zero reasoning tokens. Provider-reported prompt-cache hits appeared in 47 requests; provider caching was not disabled. Actual provider identity was not available in the retained metadata, so no outcome is attributed to a particular provider.

The browser stored only a synthetic key. A fixed-host Node transport sent validated, budget-reserved requests and fulfilled their responses back into the extension. Display timing ended when polling observed completion, before generation-metadata lookup was awaited. Times include the relay and driver overhead and are not direct provider TTFT, token throughput, screen-paint time or an unmodified-browser performance benchmark.

Routing-blind source-to-translation review covered all 36 outputs. One reviewer assessed the technical and GitHub excerpts, and another assessed the NASA excerpt, using shuffled review copies without policy mappings. The parent associated verdicts with run records only after each verdict was returned. Acceptance required structural success and no material semantic defect in that review. Minor wording differences and legitimate English code/schema examples were allowed. This is source-grounded agent judgment, not a certified translation benchmark or a multi-rater accuracy estimate.

## Observed results

Each row contains nine attempted page translations. Times below include failed attempts; removing only failed throughput runs would bias the comparison. Costs include initial and repair requests, including answers that were not ultimately accepted.

| Experience | Policy | Accepted pages | Pages with failed blocks | All-attempt median completion | Total model cost | Cost per accepted page |
| --- | --- | --- | --- | --- | --- | --- |
| Inline Translation | default | 9/9 | 0/9 | 6.02 s | USD 0.017765 | USD 0.001974 |
| Inline Translation | throughput | 6/9 | 3/9 | 4.99 s | USD 0.019895 | USD 0.003316 |
| Side Panel Translation | default | 7/9 | 0/9 | 4.88 s | USD 0.015834 | USD 0.002262 |
| Side Panel Translation | throughput | 6/9 | 0/9 | 4.48 s | USD 0.018624 | USD 0.003104 |

Default routing accepted 16 of 18 pages, compared with 12 of 18 for throughput-first routing. Their total model costs were USD 0.033599282 and USD 0.038519166 respectively, about 14.6% more for throughput-first routing. Total reported inference cost was USD 0.072118448, below the authorized USD 2 model-spend budget. The ledger ended with zero reserved cost and was not frozen. Credit-purchase fees and taxes are outside this model-spend figure; the pilot did not purchase credits.

Among matched runs where both arms were accepted, six Inline pairs had a median throughput/default completion-time ratio of 0.9002, and five Side Panel pairs had a median ratio of 0.8487. These are medians of per-pair ratios, about 10.0% and 15.1% shorter respectively, not ratios of the table medians. These small subsets do not establish a population effect, a reliable p95, or statistical significance.

Inline outcomes included 22 Partial Translation blocks and six failed blocks. All six failed blocks occurred in the three throughput-first GitHub Inline runs. Partial Translation is recorded separately from page-level review acceptance: source-preserving code and schema examples were allowed in semantic review, while material untranslated explanatory paragraphs were rejected. A Partial Translation count is not itself a count of rejected pages.

## Material semantic defects

| Run | Source-to-output defect |
| --- | --- |
| `technical-sidepanel-default-3` | Negation lost: source says not always the place needing correction; translation says it is always the place. |
| `github-inline-throughput-1` | Retention criteria and an important prohibition remain English. |
| `github-inline-throughput-2` | Four substantive test-evaluation questions and refactoring explanation remain English. |
| `github-inline-throughput-3` | Test proposal conditions and alternatives remain English. |
| `github-sidepanel-throughput-3` | Approved in Step 5 becomes approved in Step 4. |
| `article-sidepanel-throughput-1` | Trans-Neptunian classification mistranslated as crossing Neptune rather than beyond Neptune. |
| `article-sidepanel-throughput-2` | Pluto realm location reversed; trans-Neptunian classification mistranslated as crossing Neptune. |
| `article-sidepanel-default-2` | IAU resolution year changed from 2006 to 2005; trans-Neptunian classification mistranslated. |

The technical rejection reversed an important negation about the place needing correction. Other rejected results changed an approval-step number or year, reversed a location relation, mistranslated an astronomical category, or left substantive English guidance untranslated. These are observed output defects, not evidence that a specific provider or routing setting caused them.

The NASA terminology judgment was checked against the [NASA definition](https://science.nasa.gov/asset/hubble/trans-neptunian-object-illustration/) and the [Korea Astronomy and Space Science Institute terminology](https://www.kasi.re.kr/publication/post/newsMaterial/29164): trans-Neptunian objects are beyond Neptune and are called 해왕성바깥천체. Translating the category as crossing Neptune changes that relation. The original NASA excerpt contains a grammatical typo; grammatical cleanup without meaning loss was not rejected.

## Verification and boundaries

The final browser-free unit suite passed 727 checks. Extension syntax checks, new runner syntax checks, and documentation link/anchor/index checks passed. The budget-aware mock completed all 36 runs with 78 synthetic requests and zero unsettled reservations. Removing the total-reservation gate or unknown-cost freeze in disposable source copies made the unchanged budget tests fail; both negative controls were caught. Independent source review covered request dispatch, credential isolation, settlement and cleanup before paid execution.

The budget control depends on the service honoring the specified price/output/context limits and documented billing dimensions. Full-context input reservation, bounded outputs and a zero request-price cap supplied conservative reservations; unknown costs would have halted the pilot. All costs in this completed run were settled. Existing credential configuration and user-browser profiles were not used as storage targets for the actual key.

The fixed excerpts and three repetitions are insufficient to claim a general translation ranking. The fixed namespace can improve repeat-prompt cache reuse relative to ordinary random-namespace Side Panel requests. Cost, speed and output variability may differ with other text, cold caches, time windows, eligible endpoints or token accounting. The provider identities remain unknown. No competing model, Auto Router, latency-first routing, production default change or additional paid evaluation was tested.

The next useful comparison is translation quality across a small set of candidate models, if separately authorized. External usage rankings and general intelligence benchmarks can help form that set, but neither replaces this extension's structural checks and source-to-translation evaluation. Throughput-first routing remains an optional experiment after a model and eligible provider set meet the quality bar.
