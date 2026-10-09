# Tests

Use this guide to choose verification by what it requires. The [package scripts](../package.json) own the commands; the [architecture reference](../docs/architecture.md) describes the behavior they exercise.

## Choose a check

| Command | Scope | Requirements and cost |
| --- | --- | --- |
| `npm test` | Registered browser-free unit suites | Node; no browser, network, or API key |
| `npm run check:syntax` | Parse the extension scripts listed in the command | Node; no browser or model |
| `npm run check:commits -- <base> <head>` | Commit subject/body format | Node and Git; no browser or model |
| `npm run test:integration` | Toolbar-action Chrome check only | `agent-browser` on `PATH` and network; no API key or model |
| `npm run test:integration:<name>` | One dedicated unbilled Chrome check listed below | `agent-browser` and network; no API key or model |
| `npm run verify:live:inline` | Real Inline Translation, Stop, and Restore | Browser prerequisites plus an OpenAI key; billed |
| `npm run verify:live:sidepanel` | Real Side Panel Translation and protected-span preservation | Browser prerequisites plus an OpenAI key; billed |
| `npm run verify:live` | Both billed checks, sequentially | Same prerequisites; attempts the second even if the first fails |

Run the unit suite and syntax checks for ordinary implementation changes. Choose browser checks for the path being changed rather than treating `test:integration` as an aggregate. Keep billed checks separate and run them only within authorized scope.

GitHub Actions runs unit, syntax, and commit-format checks on branch pushes and pull requests, without a browser or API key. See the [workflow](../.github/workflows/checks.yml). Without explicit revisions, the commit checker examines `HEAD^..HEAD`; it checks the subject structure, explanatory body, and 80-column body limit, allowing standalone URLs. Review whether the subject is imperative and the explanation is useful separately.

## Unit suite

`npm test` runs [run.js](run.js). Read its explicit suite list when adding a test: exporting `name` and `tests` does not register a file. Add the suite and confirm its checks appear in output. The runner prints a PASS/FAIL line per check and no summary; use its exit code as the verdict. A passing check name can itself contain “failed”.

For a focused run, use the test file stem without `.test.js`, an exact check name, or both:

```sh
npm test -- --suite sidepanel-translation-execution
npm test -- --test "exact check name"
npm test -- --suite sidepanel-translation-execution --test "exact check name"
```

A name alone selects every matching check across registered suites. Invalid/repeated options, missing values, and selections matching no checks fail. A run without selectors executes all registered checks.

Use deterministic request adapters, fake Chrome interfaces, and local DOM fixtures in this tier. Importing a helper used by browser checks is appropriate only while the import launches no browser or subprocess. The `live-key` and `protected-spans` unit suites verify billed-check decisions without executing the browser checks.

| Suite area | Observable contract |
| --- | --- |
| `inline-translation-session` | Admission, batches, settlement, accounting, cache, stop/restore, progress, and diagnostic outbox |
| `inline-translation-operation` | Start/Stop/Original text wiring, transport, late settlement, feedback, and subsequent admission |
| `inline-viewport` | Discovery, bounded continuation, rescan, and watcher cleanup through start/rescan/stop |
| `inline-local-diagnostic-transport` | Batching, deferred flush, one retry, and final Stop-time sending |
| `inline-diagnostics-controller` | Run lifecycle, local/runtime outcomes, persistence failures, retention, and finalization |
| `inline-model-execution` | Request construction, output validation, repair, dispositions, and diagnostic metadata |
| `sidepanel-translation-execution` | Extraction validation, chunking, one shared recovery, progress, and whole-document publication |
| Content/worker/panel/options checks | Browser-message adapters, controls, state rendering, reinjection, request counts, and classic-script loading |

Probe Session Budget behavior through admission of real paragraphs and subsequent requests rather than reading an internal counter. The Session reconstruction is a synthetic approximation of the page measured in [ADR-0007](../docs/adr/0007-charge-the-session-budget-in-actual-record-cost.md), not live-page validation. The [issue #70 report](../docs/qa/issue-70-session-checks.md) retains its interface checks and mutation evidence.

## Unbilled Chrome checks

Use [integration/harness.mjs](integration/harness.mjs) for CDP/browser wiring. Read its header before diagnosing driver failures or adding a browser check. Page-based collector checks use [viewport-harness.js](viewport-harness.js) without draining batches or requesting a model.

The toolbar check [action-click.test.mjs](integration/action-click.test.mjs) opens a real Chrome with the unpacked extension. It chooses on-invocation Button Visibility through Options and waits for panel/button readiness after the toolbar action. It guards [ADR-0001](../docs/adr/0001-open-side-panel-from-action-click-handler.md), rather than translation quality. Its bounded failure output reports numeric version, target counts, readiness, CDP codes, timeout count, and exception presence; unavailable observations use `null`. Page content, target URLs, exception descriptions, and full logs are excluded.

Other checks run only through their dedicated scripts:

| Script suffix after `test:integration:` | Scope |
| --- | --- |
| `disclosure-summary` | Local standard and renderer-wrapped disclosures: collection, apply, placement, disclosure behavior, exact restore |
| `ai-hero-disclosure` | Reported AI Hero disclosure: deterministic apply and restore |
| `ai-hero-grill-with-docs` | Reported skill page: visible-block preflight and repository-coordinate Source Syntax |
| `github-skill-page` | Rendered GitHub skill article: scrolling collector, local rejection reporting, and zero model requests |
| `ai-hero-responsive-labels` | Desktop/mobile skill navigation: hidden alternatives as text-free Inert Page Nodes, deterministic apply, exact DOM restore, zero model requests |
| `heading-permalink` | Local and reported advisor headings: edge controls, node identity, focus/click behavior, deterministic apply, exact restore |
| `data-as-paragraph` | Local and advisor `span[data-as="p"]` paragraphs: repeated collection, preserved inline elements, exact restoration, and ownership changes |

Reported-page checks navigate public pages read-only and use deterministic output where application is tested. They establish the local DOM paths stated above, not model quality or complete extension startup. Live-page block counts are observations rather than permanent assertions. Generic DIV/SPAN paragraph inference and other `data-as` values remain unsupported; headings with controls embedded within prose remain outside the edge-control contract.

## Billed model checks

Both live checks launch their own Chrome session, save a key through Options, and clear it through the real **Clear key** control in `finally`. Run them sequentially: the harness's `closeAllBrowsers()` can close other driver sessions.

Provide an OpenAI key in the gitignored `.env.local`. [integration/live-key.mjs](integration/live-key.mjs) accepts the named entries `OPENAI_API_KEY`, `OPENAI_KEY`, or `OPENAI_SECRET_KEY`, in that order when nonempty. A missing or unattributable key fails rather than silently skipping. Add a newly approved provider-specific name to that helper instead of guessing from an `sk-` value, which can also identify another provider. The helper hands the key to the local CDP session without returning it to its caller or printing it.

### Inline Translation

[inline-translation.live.test.mjs](integration/inline-translation.live.test.mjs) translates a [local fixture](integration/fixtures/inline-translation.html) and asserts target-language output, exact restoration, and control transitions rather than a model's wording.

The first run translates three visible blocks. The second reveals a fourth short block that is absent from the cache, then waits for a pending request before pressing Stop and checks that its late answer is never applied. Restored cache hits alone would offer Stop without proving cancellation of an in-flight request. Expect the initial three blocks plus one new block and request overhead; output/repair behavior can change the actual bill.

### Side Panel Translation

[sidepanel-translation.live.test.mjs](integration/sidepanel-translation.live.test.mjs) translates a [local protected-span fixture](integration/fixtures/sidepanel-translation.html). It counts every link destination and inline code span back rather than asserting translation wording. If the worker refuses output before rehydration, it reports the refusal and active chunk; if bad output is rendered, it identifies the missing span.

The fixture has twelve links and twelve inline code spans in roughly 5,000 Markdown-template characters, close to 2,000 of them placeholder characters. The check saves a 2,000-character chunk target through Options to produce three Translation Chunks and uses `ATTEMPTS = 3`: nine initial requests on a clean run. Recovery can add requests and cost. Read the fixture and constants in the check before changing that expectation.

[integration/protected-spans.mjs](integration/protected-spans.mjs) owns span counting; its unit suite checks the helper and fixture density. Separate live commands let you authorize one translation flow without paying for both.

## Historical verification evidence

These observations are retained from earlier verification, not rerun by reading or editing this guide:

- The old `qa-issue-003.regression-1` file used `node:test` and was absent from the explicit suite list for two months. It now follows this harness and is registered; confirm both registration and output when adding a suite.
- On 2026-10-06, the `github-skill-page` negative control against codec `65d1a1e` observed 19 visible blocks, one `unsupported_descendant / UL` rejection, zero model requests, and exit 1.
- On 2026-09-10, heading-permalink verification observed 2 fixture and 16 reported-page headings. Codec `3d4848b` rejected all 18 as `hidden_content / DIV`; the fix passed collection, deterministic apply, control behavior, and exact restoration for all 18.
- The billed Inline Stop check was observed failing on `a stopped run never applies the batch it had in flight` when content-side eligibility was broken, while its other checks passed. The extra block was estimated to add a third to a half to that fixture's initial translation cost; this is an estimate for that setup, not a general price.
- The billed Side Panel check was observed failing on `attempt 1/3 is accepted with its token contract intact` at Chunk 1/3 when an `ATOM` token was stripped from every answer. Disabling the missing-token refusal as well made it fail on `code #3 spanGuard01() [lost: in 1, back 0]`, with the other chunk losses named. These controls preceded the current reader-facing error wording and were reverted.
- [ADR-0005](../docs/adr/0005-one-recovery-per-translation-chunk.md) and [ADR-0006](../docs/adr/0006-a-failed-translation-chunk-ends-the-whole-side-panel-translation.md) record the earlier token-failure investigation and its live-verification limitations. [Local UI QA](../docs/qa/qa-report-local-extension-2026-06-15.md) and [Session verification](../docs/qa/issue-70-session-checks.md) retain their own baselines and results.
