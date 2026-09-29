# Issue #70: Session interface verification

This report records verification of [issue #70](https://github.com/mochafreddo/chrome-ai-translator/issues/70), against the work based on `2730fb4`. The checks use real DOM fixtures admitted through the Inline Translation Session. Session records, queues and counters are neither seeded nor inspected. Request payloads, progress, returned outcomes, the diagnostic outbox and page DOM are observable interfaces.

## Results

- `npm test`: exit 0, 456 checks passed.
- `npm run check:syntax`: exit 0. The four adapted browser scripts also passed `node --check`.
- The focused runner: exit 0, 136 checks passed before and after the negative controls.
- 54 single-transition mutations: each exited 1 with at least one failed check. All 40 Session checks were observed failing under a control; the table below also includes the affected content, policy and reinjection checks.
- The ADR-0007 reconstruction admitted and translated all 356 paragraphs, including an answer reporting a repair for every paragraph. Measured reconstruction: 37,376 template characters, 39,512 actual cost, 162,824 reserved cost, 79,024 charged with all repairs. This is a synthetic approximation of the historical page, not a new live-page measurement.

## Procedure

The same small Node runner executed the exported `tests` arrays from `inline-translation-session.test.js`, `content-helpers.test.js`, `qa-issue-003.regression-1.test.js` and `static-assets.test.js`, sequentially and awaiting each `fn`. It printed a PASS or FAIL per check and set exit code 1 if any threw, following `tests/run.js`. Each control ran in a fresh Node process. A preload replaced one exact source span in memory through the CommonJS loader and the classic-script file reader; it did not write the runtime source on disk. Normal execution of that same runner was repeated after the controls. The full unmodified repository runner passed separately as recorded above.

Only assertion failures in named checks count as a detected mutation. A missing replacement anchor, syntax failure or loader failure would not qualify. The transformations below describe the deliberately broken behavior; none remains in the implementation.

## Replaced coverage

- Store construction, queue insertion, state/count assertions and result application are covered by the Session checks below. The old helpers and their delegating exports were deleted.
- The measured-page and short-block budget tests now create real `<p>` elements and settle batches, including repairs. The request limit is tested with both 4,000-character and 2,500-character paragraphs, where the correct batch sizes differ.
- Existing message-level lifecycle cases remain: current and obsolete responses, repeated operation replacement, duplicate repair results, failure accounting, diagnostics ownership and cache reuse. Assertions on internal records were replaced with progress and DOM observations.
- Collector checks retain data-as paragraphs, disclosure summaries, heading permalinks, code-like content, editable ancestors and scan continuation. They observe public request fields and resulting DOM.
- The former direct local-diagnostic enqueue test accepted arbitrary fabricated metadata. Its enqueue export no longer exists. The Session replacement admits actual custom, interactive, hidden, editable and nested page content and checks exact outbox payloads. Existing diagnostics protocol/controller tests still exercise every allowlisted reason and explicit removal of source, selector and custom-element tag fields.

## Negative controls

| ID | Deliberately broken transition | Failing checks |
| --- | --- | ---: |
| M01 | duplicate admission | 8 |
| M02 | reserved session charging | 28 |
| M03 | session limit lowered | 28 |
| M04 | session limit removed | 27 |
| M05 | repair charge dropped | 15 |
| M06 | budget reset on begin | 21 |
| M07 | refund failed request | 16 |
| M08 | cache replay skipped | 4 |
| M09 | cache warning lost | 1 |
| M10 | batch reserve charged as actual | 1 |
| M11 | oversized reservation bypassed | 2 |
| M12 | ordinary queue reset skipped | 1 |
| M13 | retry discarded on rescan | 1 |
| M14 | retry supersession not cleared on stop | 3 |
| M15 | record ids collide across operations | 2 |
| M16 | carried translations lost | 3 |
| M17 | changed settings never restored | 1 |
| M18 | original text skips restore | 8 |
| M19 | settings cache shared | 2 |
| M20 | failed request left pending | 9 |
| M21 | failure reason order reversed | 1 |
| M22 | application failure code lost | 4 |
| M23 | rerender ignored | 1 |
| M24 | unsupported block silently ignored | 10 |
| M25 | local rejection metadata omitted | 4 |
| M26 | page change retry disabled | 8 |
| M27 | page change retries unbounded | 1 |
| M28 | in-flight place never freed | 32 |
| M29 | in-flight cap bypassed | 1 |
| M30 | late responses applied | 10 |
| M31 | late tokens lost | 10 |
| M32 | runtime outcomes dropped | 6 |
| M33 | diagnostics unavailable lost | 1 |
| M34 | operation id never advances | 1 |
| M35 | successful apply skipped | 23 |
| M36 | collector admission skipped | 31 |
| M37 | local diagnostic flush skipped | 2 |
| M38 | local diagnostic stop drain skipped | 3 |
| M39 | diagnostic warning lost | 1 |
| M40 | reinjection replaces session | 1 |
| M41 | worker verdict left pending | 18 |
| M42 | partial result counted as success | 3 |
| M43 | missing result left pending | 1 |
| M44 | stale operation accepted | 1 |
| M45 | stopped run treated as live | 21 |
| M46 | settings tone omitted | 2 |
| M47 | editable ancestors admitted | 1 |
| M48 | worker verdict wrongly filed by page | 2 |
| M49 | missing result wrongly filed by page | 2 |
| M50 | scan position discarded | 2 |
| M51 | offscreen subtrees consume scan budget | 4 |
| M52 | code-like prose admitted | 1 |
| M53 | diagnostics warning before retry exhausted | 1 |
| M54 | local diagnostic retry disabled | 2 |

## Per-check failure evidence

Every listed check passed normally and failed under the named control. One directly related control per check is listed; unrelated preparation failures are not used as that check's evidence. A control often failed other checks as well.

| Suite | Check | Failing control |
| --- | --- | --- |
| inline translation session | exposes only allowlisted rejection metadata from unsupported page content | M25 |
| inline translation session | admits a Semantic Block once across repeated scans | M01 |
| inline translation session | charges actual record cost while reserving space for each request and repair | M02 |
| inline translation session | translates the ADR-0007 page reconstruction whole even when every block is repaired | M05 |
| inline translation session | refuses a full Session Budget and tells the reader to reload without naming a figure | M04 |
| inline translation session | splits requests on reserved cost while retaining every admitted paragraph | M10 |
| inline translation session | retains a queued page-change retry when a viewport rescan resets ordinary queued work | M13 |
| inline translation session | keeps a restarted operation retry distinct from its carried translation when stopped | M15 |
| inline translation session | restores and replays a cached partial translation as partial without a request | M09 |
| inline translation session | isolates an application failure from its valid sibling and files its runtime code | M22 |
| inline translation session | readmits a translated block whose page-owned nodes were replaced | M23 |
| inline translation session | aggregates terminal reasons from real transitions in stable reader-facing order | M21 |
| inline translation session | keeps the Session Budget across stop, Start and Original text | M06 |
| inline translation session | advances the operation id on begin, stop and restore | M34 |
| inline translation session | carries translated blocks into the next operation under unchanged settings | M16 |
| inline translation session | restores carried blocks when the settings change | M17 |
| inline translation session | restores through Original text every block the visit translated | M18 |
| inline translation session | keeps one translation cache per translation settings | M19 |
| inline translation session | applies a cached translation without a request or a charge | M08 |
| inline translation session | refuses a block too large for one request without sending it | M11 |
| inline translation session | refuses a block it cannot serialize without sending it | M24 |
| inline translation session | charges a repair the current operation reports, and only a repair | M05 |
| inline translation session | charges a late repair after Stop and only releases its token | M05 |
| inline translation session | charges a late repair after Original text and only releases its token | M05 |
| inline translation session | charges a late repair after Stop and Start and only releases its token | M05 |
| inline translation session | charges a late repair after Original text and Start and only releases its token | M05 |
| inline translation session | fails a batch whose request came back with nothing, without refunding it | M07 |
| inline translation session | fails a batch whose answer the page could not settle, rather than leaving it pending | M20 |
| inline translation session | holds at most two requests in flight, and settling one frees its place | M29 |
| inline translation session | retries a block the page changed once, and lets the retry answer for the change | M26 |
| inline translation session | files a change its one retry did not survive | M27 |
| inline translation session | stopping a queued retry leaves the change it superseded unresolved | M14 |
| inline translation session | stopping a translating retry leaves the change it superseded unresolved | M14 |
| inline translation session | returns the runtime outcomes to file after an application failure | M32 |
| inline translation session | returns the runtime outcomes to file after a worker verdict | M48 |
| inline translation session | returns the runtime outcomes to file after a partial translation | M42 |
| inline translation session | returns the runtime outcomes to file after a changed block no retry supersedes | M32 |
| inline translation session | returns the runtime outcomes to file after a missing result | M49 |
| inline translation session | says when the worker could not save diagnostics for a batch | M33 |
| inline translation session | builds inline translation settings snapshot without api key | M46 |
| content helpers | settles Session Budget through controls: current one-attempt response | M35 |
| content helpers | settles Session Budget through controls: current repaired response | M05 |
| content helpers | settles Session Budget through controls: current repair charged exactly once | M05 |
| content helpers | settles Session Budget through controls: repair exceeds the submitted budget | M04 |
| content helpers | settles Session Budget through controls: Original text then one-attempt response | M30 |
| content helpers | settles Session Budget through controls: Original text then repaired response | M30 |
| content helpers | settles Session Budget through controls: Stop then repaired response | M30 |
| content helpers | settles Session Budget through controls: Stop and Start then repaired response | M30 |
| content helpers | settles Session Budget through controls: Original text and Start then repaired response | M30 |
| content helpers | settles Session Budget through controls: repeated replacements then repaired response | M30 |
| content helpers | settles only originating records once despite duplicate and unrelated repair results | M05 |
| content helpers | retains initial Session Budget through the request caller after request error | M07 |
| content helpers | retains initial Session Budget through the request caller after unsuccessful batch | M07 |
| content helpers | retains initial Session Budget through the request caller after missing results | M07 |
| content helpers | files runtime outcomes through the request caller after an application failure | M32 |
| content helpers | files runtime outcomes through the request caller after a worker verdict | M48 |
| content helpers | files runtime outcomes through the request caller after a missing result | M49 |
| content helpers | files runtime outcomes through the request caller after a changed block a retry supersedes | M26 |
| content helpers | files runtime outcomes through the request caller after a changed block no retry supersedes | M32 |
| content helpers | reuses repaired cache output at an exhausted budget and gives a fresh content instance its own budget | M08 |
| content helpers | reports a run that will not finish as an error, not as progress | M39 |
| content helpers | schedules another viewport scan when the scan budget is exhausted | M50 |
| content helpers | resumes a Semantic Block scan where the previous one ran out of budget | M50 |
| content helpers | does not let offscreen blocks exhaust the Semantic Block scan budget | M51 |
| content helpers | drains semantic block page-change retries through the runtime loop | M26 |
| content helpers | makes a final RCA persistence attempt when stopping during retry backoff | M38 |
| content helpers | flushes queued RCA diagnostics when stopping before a deferred flush | M38 |
| content helpers | drains queued RCA diagnostics while another request is active | M38 |
| content helpers | rejects stale viewport operation after stop or replacement | M44 |
| content helpers | reads a live run as one Start must rescan rather than start again | M45 |
| content helpers | grants each local diagnostic batch an independent retry | M54 |
| content helpers | does not warn when a local diagnostic retry succeeds | M53 |
| content helpers | collects data-as paragraphs once and preserves inline elements through apply and restore | M35 |
| content helpers | keeps data-as paragraph scope and existing local preflight rejections | M25 |
| content helpers | rejects overlapping data-as paragraphs inside protected links and code atoms | M25 |
| content helpers | collects a heading with a local permalink and restores its exact graph | M35 |
| content helpers | uses short prose around inline code to discover a block | M36 |
| content helpers | skips a code-like block on the scan the reader actually triggers | M52 |
| content helpers | does not collect blocks inside inherited editable regions | M47 |
| content helpers | collects a disclosure summary separately from its body paragraphs | M36 |
| content helpers | collects a wrapped disclosure as one enclosing block | M36 |
| qa ISSUE-003 regression | keeps a repaired wrong-language block original while applying its sibling | M41 |
| static assets | allows content scripts to be injected twice into one page | M40 |

## Browser verification

The four adapted, unbilled browser scripts ran in an isolated Chrome session namespace. For each script, the same runner failed with collector admission removed in memory and passed with normal source. These controls exercise the collection/apply/restore assertions rather than browser startup; extension and page discovery still passed in the negative runs.

| Script | Normal run | Admission-removed run |
| --- | --- | --- |
| `data-as-paragraph.test.mjs` | exit 0; 53 PASS | exit 1; 49 FAIL |
| `heading-permalink.test.mjs` | exit 0; 21 PASS | exit 1; 18 FAIL |
| `ai-hero-responsive-labels.test.mjs` | exit 0; 8 PASS | exit 1; 2 FAIL |
| `ai-hero-grill-with-docs.test.mjs` | exit 0; 6 PASS | exit 1; 2 FAIL |

The data-as paragraph run observed 2 local fixture paragraphs and 43 marked paragraphs on the reported page, and checked the four protected-link/code ownership cases. The heading run observed 2 fixture headings and 16 reported-page headings. The responsive-label run checked both related-skill titles at desktop and mobile widths. The source-syntax run checked collection and repository-coordinate preservation on the reported skill page. These page counts are observations, not permanent expected values.

The responsive-label check also failed at both viewport widths when actual DOM application was skipped while settlement still reported success, then passed normally. Adding that assertion initially exposed an ineffective synthetic answer on mobile: replacing a label's visible text in the serialized template could do nothing when the label was protected Source Syntax. The fixture now adds visible Korean prose around the preserved template, so both viewport checks require a real DOM change without modifying protected text. This changes test input, not runtime translation behavior.

## Review and limits

The Standards review's measurement-versus-reconstruction wording issue was corrected. The Spec review's internal DOM-field accesses and outdated ADR figures were corrected. Its negative-control evidence issue was also corrected: diagnostic retry checks now assert that the next timer was scheduled before invoking it, and direct retry/warning mutations produce AssertionError failures. The per-check table was checked against those failure logs and favors the transition under test over unrelated setup failures.

Paid `verify:live` checks were not run: no model behavior changed and no API key was read. There is no type checker in this repository. Browser checks establish deterministic DOM handling and request-free collection, not live model translation quality.
