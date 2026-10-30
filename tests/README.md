# Tests

Use this guide to choose verification by what it requires. The [package scripts](../package.json) own the commands; the [architecture reference](../docs/architecture.md) describes the behavior they exercise.

## Choose a check

| Command | Scope | Requirements and cost |
| --- | --- | --- |
| `npm test` | Registered browser-free unit suites | Node and installed development tools; no browser, network, or API key |
| `npm run lint` | JavaScript error checks using ESLint recommended rules and runtime-specific configuration; no files are changed | Locked development tools installed; no browser, network, or API key |
| `npm run verify:local` | Lint, syntax, documentation and unit checks with private logs and a completion record | Node, Git and installed development tools; no browser, network, or API key |
| `npm run verify:local -- --check-reuse <summary.json>` | Validate an existing successful local verification record against current inputs and log integrity | Same checkout, source files, tool versions and recorded execution conditions; no checks are executed |
| `npm run check:syntax` | Discover and parse regular `.js` files immediately inside `extension/`, sorted by path; fail on syntax errors or empty input | Node; no browser or model |
| `npm run check:docs` | Check Git-tracked Markdown links and heading anchors, and `docs/README.md` coverage of other tracked Markdown under `docs/` | Node and Git; no network |
| `npm run check:docs:history -- --base <full-commit-sha>` | Compare historical tracked Markdown with a fixed baseline | Node and Git; explicit full 40-character SHA-1 commit required |
| `npm run check:commits -- <base> <head>` | Commit subject/body format | Node and Git; no browser or model |
| `npm run test:integration:routing-pilot -- --plan` | Print the frozen corpus and 36-run comparison plan | Node only; no browser, credential, or model request |
| `npm run test:integration:routing-pilot -- --output <new-directory>` | Execute the 36-run routing preparation with intercepted mock responses | `agent-browser`; disposable browser and local HTTP fixtures; synthetic key only, no billed model calls |
| `npm run test:integration` | Toolbar-action Chrome check only | `agent-browser` on `PATH` and network; no API key or model |
| `npm run test:integration:content-readiness` | Content readiness after toolbar injection and reinjection, plus all-pages automatic injection | `agent-browser` on `PATH`; opens a headed disposable Chrome for the optional all-sites permission request; no API key or model |
| `npm run test:integration:<name>` | One dedicated unbilled Chrome check listed below | `agent-browser` and network; no API key or model |
| `npm run test:integration:performance` | Long-DOM continuation and synchronous layout-read counts in a fixed 1280-by-900 Chrome viewport | `agent-browser`; local fixture, no credential or model request |
| `npm run verify:live:inline` | Real Inline Translation, Stop, and Restore | Browser prerequisites plus an OpenAI key; billed |
| `npm run verify:live:sidepanel` | Real Side Panel Translation and protected-span preservation | Browser prerequisites plus an OpenAI key; billed |
| `npm run verify:live:openrouter:inline` | Real OpenRouter Inline Translation, structured output, Stop, restoration, request policy, and provider-reported reasoning usage | Browser prerequisites plus a named OpenRouter key; billed |
| `npm run verify:live:openrouter:sidepanel` | Real OpenRouter Side Panel Translation, request policy, provider-reported reasoning usage, and protected-span preservation | Browser prerequisites plus a named OpenRouter key; billed |
| `npm run verify:live:routing-pilot -- --output <new-directory> --budget-usd 2` | Fixed 36-run OpenRouter routing comparison under identical price ceilings and a shared USD 2 model-spend ledger | Browser prerequisites, network, `OPENROUTER_API_KEY` in `.env.local`; billed; separate authorization required |
| `npm run verify:live` | Both billed checks, sequentially | Same prerequisites; attempts the second even if the first fails |

Install the locked development tools before running checks on a fresh checkout:

```sh
npm ci --ignore-scripts --no-audit --no-fund
```

Use a Node version supported by the installed ESLint package; CI's version is owned by [the workflow](../.github/workflows/checks.yml). Installation needs network access; the checks themselves do not. Loading the unpacked extension still needs no dependency installation or build.

Run lint, the unit suite and syntax checks for ordinary implementation changes. Choose browser checks for the path being changed rather than treating `test:integration` as an aggregate. Keep billed checks separate and run them only within authorized scope.

## JavaScript lint

Run `npm run lint` to check the extension, scripts, tests and ESLint configuration. [The flat config](../eslint.config.mjs) owns file matching, runtime globals and rules. Extension scripts retain classic-script parsing and guarded CommonJS exports. The worker has service-worker globals without page DOM globals; Node scripts and unit tests use CommonJS, while integration modules and the config use ESM. Integration modules may contain serialized browser callbacks, and named injected helpers are allowed only in the files that use them. The diagnostics module also supports Node's Buffer in its CommonJS path.

The recommended rules detect likely errors rather than enforce formatting. Two exceptions preserve existing deliberate patterns: empty catch blocks implement best-effort cleanup and optional probes, and an unused destructured property beside a rest binding removes that property from the result. Other empty blocks and unused variables remain errors. Warnings fail the command. Lint does not fix files, and no Git hook or formatter runs automatically. To change a rule, establish the incorrect diagnostic and document the narrow exception rather than adding a blanket suppression.

The `lint` unit suite runs the real CLI on normal and invalid code for the supported environments, checks the deliberate exceptions and verifies that a failing file check preserves its input. It uses local temporary fixtures and no browser.

## Local verification records

Run `npm run verify:local` for final local verification. It executes lint, syntax, documentation and unit checks, records each exit code or signal, and continues through all checks even if one fails. It creates a new directory under the system temporary directory and prints its `summary.json` path. Use `--output <new-temporary-directory>` to choose a new temporary destination outside the checkout; its parent must already exist. Existing destinations are refused.

The runner applies `umask 077` before starting checks, creates the directory with mode 0700 and exclusive mode-0600 log and summary files, and verifies their ownership and permissions. The record stores command arguments, start/end times, completion status, log hashes, tracked-source and installed-dependency hashes and runtime metadata. It does not store source or dependency contents or environment values. Ignored credentials are not read; tracked secret-bearing paths are refused before checks. Keep the printed record with the work's verification evidence.

Before reusing a record for a later commit or push, run:

```sh
npm run verify:local -- --check-reuse /path/printed/by/verification/summary.json
```

Reuse is permitted only when this command exits 0. It requires every local check to have completed successfully, unchanged inputs during that run, the same physical checkout and tracked file contents/modes, the same installed dependency tree, verification runner, Node/Git versions, OS/platform and recorded locale, timezone and execution environment fingerprint. The run-stability comparison includes file, dependency-tree, parent-directory and Git index change metadata to detect ordinary edit-and-restore races or a temporarily changed check inventory. It also checks the private files and log hashes. A later commit or staging change that leaves these inputs identical does not invalidate the record; a source, checkout, tool or recorded-condition change does. Keep the source, installed dependencies and index fixed while checks run.

Reuse requires installed dependencies and a tracked lockfile whose root dependency declarations match `package.json`. The runner hashes the actual `node_modules` tree, including added or removed entries, file contents, permission modes and symbolic-link targets. Ordinary internal npm bin links are supported. A link must resolve to another collected dependency entry or a tracked checkout file; external, excluded, dangling or unsupported targets are refused. Required locked packages must be present, and declared root and transitive dependencies must resolve to collected inputs through Node's standard resolver. Each resolved installed package must belong to a lockfile package location; an unlisted nested package cannot shadow a locked package for reuse. Missing optional dependencies are allowed, but optional packages discovered in a parent installation prevent reuse. The lockfile describes intended installation and never substitutes for checking installed files. If dependencies become unreadable during checks, the runner retains the check logs and marks the run unsuccessful.

Reuse remains restricted to a plain Node invocation. Nonempty `NODE_OPTIONS`, `NODE_PATH` or Node startup flags prevent reuse rather than collecting externally loaded code. Untracked files and ignored inputs outside `node_modules` and the runner's explicit credential/agent-workspace exclusions also prevent reuse. The exclusions are owned by [the runner](../scripts/verify-local.js). Preserve unrelated work when reuse is refused and run fresh checks instead of staging, deleting or hiding it to obtain reuse. The collector reads only tracked source files and the explicit dependency tree, without following dependency links into excluded files. Resolution checks cover declared package edges under the installed npm tools' loading conventions; they do not sandbox arbitrary undeclared or absolute imports.

Export-restricted type-only and import-only packages are identified through metadata in Node's standard search paths. The same collected-path and lockfile-owner checks apply to those candidates. Built-in modules use the recorded Node version; an installed npm package sharing a built-in name still has its metadata checked.

Browser checks, reported public pages, billed model checks, commit-format checks and history comparisons remain separate. A local record does not qualify them, establish a production deployment, or replace review. Recheck the intended Git target before publication even when local checks are reusable.

## Documentation checks

`npm run check:docs` checks Git-tracked `*.md` and `*.markdown` files for local inline links and heading anchors. It skips fenced and inline code and makes no network requests. By default it reads the working-tree content of tracked files. It also requires `docs/README.md` to cover every other tracked Markdown file under `docs/`, excluding `docs/README.md` itself. New files must be added to Git's index before the checker includes them; linking an untracked file in the documentation index is not enough. Tests registered in the existing unit suite cover checker behavior.

`npm run check:docs:history` is an opt-in comparison against an explicit, fixed commit; it is not an immutable-history CI check. Supply the repository's full lowercase 40-character SHA-1 commit hash with `--base`, for example:

```sh
npm run check:docs:history -- --base 0123456789abcdef0123456789abcdef01234567
```

The example hash is illustrative and must be replaced with the intended baseline commit. The command rejects a missing or symbolic baseline such as `HEAD` or `main`, and rejects invalid commits. It compares each historical tracked Markdown file under `docs/design`, `docs/qa`, and `docs/superpowers` with that baseline: the title and exact original body must match. Content before `## Original record` is excluded from the body comparison; the title remains protected. When that marker is absent in the baseline, the whole baseline file is treated as the original. A file present at only one side fails the check.

The GitHub Actions `checks` job runs commit-format checks and installs locked development tools with lifecycle scripts disabled before lint, syntax, documentation and unit checks on branch pushes and pull requests. Those checks need no browser or API key. A separate `browser-fixtures` job installs pinned agent-browser and its Chrome/system prerequisites, then runs the local fixture commands listed in the [workflow](../.github/workflows/checks.yml). Installation needs outbound network; those checks use local pages and no model credentials. Without explicit revisions, the commit checker examines `HEAD^..HEAD`; it checks the subject structure, explanatory body, and 80-column body limit, allowing standalone URLs. Review whether the subject is imperative and the explanation is useful separately.

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
| `syntax-check` | Directory discovery, invalid newly added scripts, and empty input through the syntax command |
| `integration-harness` | CDP lifecycle plus launch success, missing prerequisites, redacted failure output, and cleanup through external browser adapters |
| `dom-tree` | Independent test-only DOM capture and exact node/text/child-order comparison; the self-contained helper also runs through browser evaluation |
| `evaluation-execution` | Shared comparison execution through deterministic adapters and the real budget: reservation evidence before transport, settlement, frozen-budget admission, interruption, and cleanup |
| `inline-translation-session` | Admission, batches, settlement, accounting, cache, stop/restore, progress, and diagnostic outbox |
| `inline-translation-operation` | Start/Stop/Original text wiring, transport, late settlement, feedback, and subsequent admission |
| `inline-request-flow` | Session admission through worker messages and fake fetch: wire fields, quoted-prose repair, source validation, distinct admission costs, application, restoration, and cache reuse |
| `inline-viewport` | Discovery, bounded continuation, rescan, and watcher cleanup through start/rescan/stop |
| `inline-local-diagnostic-transport` | Batching, deferred flush, one retry, and final Stop-time sending |
| `inline-diagnostics-controller` | Run lifecycle, local/runtime outcomes, persistence failures, retention, and finalization |
| `inline-model-execution` | Request construction, output validation, repair, dispositions, and diagnostic metadata |
| `sidepanel-translation-execution` | Extraction validation, chunking, one shared recovery, progress, and whole-document publication |
| `settings-lifecycle` | Reads during pending saves, partial-save and key-removal ordering, failure recovery, and Button Visibility registration and permission races through the lifecycle interface |
| Content/worker/panel/options checks | Browser-message adapters, controls, state rendering, reinjection, request counts, and classic-script loading |

Probe Session Budget behavior through admission of real paragraphs and subsequent requests rather than reading an internal counter. The Session reconstruction is a synthetic approximation of the page measured in [ADR-0007](../docs/adr/0007-charge-the-session-budget-in-actual-record-cost.md), not live-page validation. The [issue #70 report](../docs/qa/issue-70-session-checks.md) retains its interface checks and mutation evidence.

## Unbilled Chrome checks

Use [integration/harness.mjs](integration/harness.mjs) for CDP/browser wiring. Read its header before diagnosing driver failures or adding a browser check. Page-based collector checks use [viewport-harness.js](viewport-harness.js) without draining batches or requesting a model.

The shared launcher runs Chrome headless by default using the native `--headless=new` flag and enables extension debugging. The content-readiness check explicitly opens a headed disposable browser for its real optional-permission UI. The launch helper requires a responding CDP Extensions domain, the unpacked extension, initial page and tab targets, and a successful page attachment. Missing prerequisites throw before returning a context; the helper closes its CDP connection and attempts to close only its named browser session. Callers retain their check-specific failure reporting and cleanup after a successful launch. `attach(targetId)` enables the Page domain; callers attaching a service worker pass its target type as the second argument so page-only initialization is omitted. Launch diagnostics include only the failure stage, numeric browser version, protocol error codes, timeout count, and exception presence.

Before running a browser check, confirm `agent-browser` is available and identify its network needs and any permission prompt described below. Treat missing tooling and pending approval separately from extension failures. Before restarting or reloading an existing browser incident, follow the evidence-preservation procedure in `~/.agents/docs/browser-tools.md`, installed from the dotfiles repository's `.agents/docs/browser-tools.md`. That shared procedure owns pre-change runtime observations and unavailable-evidence reporting; the [initialization investigation](../docs/qa/content-script-readiness-2026-10-20.md) remains historical evidence.

The toolbar check [action-click.test.mjs](integration/action-click.test.mjs) opens a real Chrome with the unpacked extension. It chooses on-invocation Button Visibility through Options and waits for panel/button readiness after the toolbar action. It guards [ADR-0001](../docs/adr/0001-open-side-panel-from-action-click-handler.md), rather than translation quality. Its bounded failure output reports numeric version, target counts, readiness, CDP codes, timeout count, and exception presence; unavailable observations use `null`. Page content, target URLs, exception descriptions, and full logs are excluded.

The [content-readiness check](integration/content-readiness.test.mjs) uses a local page to verify that the content script answers after the first toolbar injection and a repeated action, then saves the all-pages choice through Options and checks readiness and button mounting on a newly opened page. It observes Chrome DevTools Protocol network events and fails if any request reaches either model service. The check does not use an API key. Approve the all-sites permission prompt in that check's headed disposable browser if Chrome displays it.

Other checks run only through their dedicated scripts:

For `inline-button`, `heading-permalink`, and `github-release-accounts`, pass `-- --fixture-only` for deterministic local regression checks or `-- --reported-only` for the public page alone. With no flag, both phases still run. Unknown, repeated or conflicting flags fail before starting a server or browser. Use fixture-only mode in CI and in mutation probes of local DOM behavior. Run the reported phase separately when validating current site compatibility; its failure remains visible rather than changing a local regression result.

| Script suffix after `test:integration:` | Scope |
| --- | --- |
| `ui` | Options service switching and responsive form layout; diagnostic name, keyboard focus/scrolling and asynchronous load focus; long errors; Side Panel snapshot language boundaries and safe bilingual text through synthetic browser-message responses, keyboard tabs; Floating Translate Button sizing and typography; disposable Chrome, no API key or model calls |
| `inline-consent` | Real pointer clicks on host- or ancestor-concealed floating controls cannot start model requests; the panel button still starts and applies intercepted mock translation; disposable Chrome, synthetic key, no billed calls |
| `disclosure-summary` | Local standard and renderer-wrapped disclosures: collection, apply, placement, disclosure behavior, exact restore |
| `ai-hero-disclosure` | Reported AI Hero disclosure: deterministic apply and restore |
| `ai-hero-grill-with-docs` | Reported skill page: visible-block preflight and repository-coordinate Source Syntax |
| `github-skill-page` | Local table-cell fixture and both reported GitHub skill articles: viewport collection through nested scroll areas, metadata-cell admission, deterministic apply and exact restoration, and zero model requests |
| `github-release-accounts` | Local contributor fixture and reported v1.3.2 release paragraph: account-link atoms, deterministic complete translation, real English-residue detection, link/node preservation and exact restoration; model execution uses an in-process fixed response, with no credential or model HTTP call |
| `inline-inspection` | Run the inspection CLI on a local nested LI/P fixture: preserve rejection reasons, report known source metrics including code-only and oversized blocks, continue after a long block, and exclude source text and URLs from output |
| `ai-hero-responsive-labels` | Desktop/mobile skill navigation: hidden alternatives as text-free Inert Page Nodes, deterministic apply, exact DOM restore, zero model requests |
| `heading-permalink` | Local and reported advisor headings: edge controls, node identity, focus/click behavior, deterministic apply, exact restore |
| `inline-button` | Local multi-button and wrapped-button fixtures: reordered application, node/subtree identity, click handlers, translated-state keyboard activation, focus without blur, state preservation and exact restoration; native moves and `moveBefore`-disabled paths also preserve a Block Child iframe's browsing context. Reported aiforui.dev paragraph: collection, deterministic application, focus, real dialog opening/closing by keyboard, exact restoration after closing, and working restored click behavior; no key or model request |
| `data-as-paragraph` | Local and advisor `span[data-as="p"]` paragraphs: repeated collection, preserved inline elements, exact restoration, and ownership changes |
| `openrouter-inline` | Options service switching, selected credential/configuration, structured Inline output, same-service cache, cross-service cache separation, delayed uncached Stop, exact HTML and page-node restoration; synthetic keys and worker-wide interception, no real model calls |
| `openrouter-sidepanel` | Options service/key persistence and independent clear, fixed-host permissions, pinned-model Side Panel entry and multi-chunk deterministic rendered output, strict request routing/policy, versioned progress and 60 acknowledged polls, tab closure during a delayed request; synthetic keys and worker-wide request interception, no real model calls |

Reported-page checks navigate public pages read-only and use deterministic output where application is tested. They establish the local DOM paths stated above, not model quality or complete extension startup. Live-page block counts are observations rather than permanent assertions. Generic DIV/SPAN paragraph inference and other `data-as` values remain unsupported. The edge-heading contract remains separate from the preserved inline-button contract. Disabling `moveBefore` in a current Chrome tests the legacy insertion branch; it does not establish execution on Chrome 116 itself.

### Inspect candidate blocks

Use the read-only [inspection command](../scripts/inspect-inline-blocks.mjs) to locate a Semantic Block before constructing a translation reproducer:

```sh
npm run --silent inspect:inline-blocks -- --url https://github.com/mattpocock/skills/releases/tag/v1.3.2 --root main
```

The command opens its own disposable Chrome session and scrolls each candidate into view. JSON output lists the index, tag, serialization success or rejection code/reason, and the current model-execution module's numeric `sourceChars` and `sourceProseWordCount` evidence for accepted candidates. A parent LI can be rejected while its own P child is accepted; inspect each result before using its template. The root selector defaults to `main`. Only HTTP(S) URLs without embedded credentials are accepted.

Source, translations, templates, selectors and URLs are excluded from output. The command loads only serialization and model-validation modules and calls their shared quality assessor with fixed probe text to obtain source metrics, including for code-only or oversized blocks. It does not create a translation request or apply a result to the DOM. `syntheticProbe` identifies this local measurement; it does not measure translation quality or recover a past model response. Metrics belong to the current codec and page, so a later protection-rule change can alter them relative to a historical diagnostic. No API key or saved browser profile is used.

### Native keyboard input

Use the existing `browser` driver from [harness.mjs](integration/harness.mjs) for ordinary native key input, keeping the check's named session explicit:

```js
await browser(['--session', SESSION, 'press', 'Enter']);
check('dialog opens', await until(() => ctx.page.evaluate(
  `document.querySelector('button').getAttribute('aria-expanded') === 'true' && !!document.querySelector('[role="dialog"]')`
), 10000));
```

Assert the page handler's observable effect as well as input delivery. Wait for the actual state with `until`; a completed key command can precede rendering. Keep a native key command for keyboard acceptance checks. Reserve direct CDP key sequences for checks that specifically need protocol-level fields and verify their native effect. The [inline-button check](integration/inline-button.test.mjs) demonstrates activation while translated, dialog interaction and restoration; the [UI check](integration/ui-polish.test.mjs) retains its separate protocol-driven scroll scenarios.

The [performance check](integration/performance.test.mjs) constructs 4,800 overlapping visible paragraphs in a disposable Chrome page so every paragraph participates in the same bounded scan. It counts admissions, scan callbacks, computed-style reads and element/range rectangle reads through the Viewport API. The count measurement uses a Session adapter that only records admission. A separate case uses the real Session, seeds one deterministic cache entry, applies it to 1,300 paragraphs through the real MutationObserver path and checks exact node restoration without a new request. Run the same check against another checkout with `npm run test:integration:performance -- --extension-dir /absolute/checkout/extension`. The comparison prints the browser version and uses a fixed viewport. The overlapping layout is synthetic; these operation counts establish neither realistic scrolling latency nor heap or model performance.

## Routing pilot preparation

[routing-pilot.mock.mjs](integration/routing-pilot.mock.mjs) supports only plan output and intercepted mock execution. It does not read `.env.local` and has no live mode. Supply a new, non-synced output directory; it creates mode-0700 directories and mode-0600 files and refuses to overwrite an existing destination. Browser startup still needs the permissions required by the shared harness. Close only the pilot's named session.

The [corpus manifest](integration/fixtures/routing-pilot/corpus.json) records three public source excerpts, capture time, normalization, and SHA-256 fingerprints. Local HTML preserves prose, links, code and emphasis while omitting remote assets, wrappers and original site layout. The GitHub excerpt is normalized prose, not a reproduction of GitHub's table or scrolling surface. Attribution and license texts are in [LICENSES.txt](integration/fixtures/routing-pilot/LICENSES.txt). The fixed 1280-by-12000 viewport exposes these short excerpts together; it is not a realistic reader-scrolling benchmark.

Each page, flow and repetition uses a fresh document to avoid the extension's output cache. Only the disposable worker's fetch adapter adds `provider.sort: "throughput"`; extension files remain unchanged, and settings changes are confined to the disposable browser. The disposable page also fixes the Side Panel serializer's supported namespace option, checking for source collisions, to eliminate otherwise random Placeholder Token differences between paired requests. Requests, including repairs, are intercepted and fulfilled locally. The pilot validates both routing policies and compares all initial request fingerprints and output limits between paired runs. Unknown request costs remain `null`, and failed attempts are included in cost aggregation. `repairAttempts` counts repair requests, not repaired blocks; Inline repair calls can contain several blocks. Full, partial and failed Inline block counts are recorded separately from mock display completion.

Per-run request records, review pairs and mapping files survive an incomplete run. A complete run also produces `summary.json`, randomized `blinded-review.json`, and `review-mapping.json`. Review copies omit routing identifiers; mappings and run metadata must be withheld from the person or agent judging quality. Public source excerpts and mock answers are stored only in the explicitly selected private evidence directory. No actual provider identity is inferred from the routing policy.

The mock prepends Korean text to source templates deliberately, exercising structure preservation and English-residue repair without pretending to translate. `successes` in its summary counts mock display completion, and `qualityAccepted` remains `null`. These values do not establish translation accuracy, live latency, billing, provider choice, or a reliable p95. Elapsed time runs from immediately before the control click until completion is observed by polling, including driver/DOM overhead; it does not directly measure screen painting. Budget and live execution need a separate decision after preparation.

The mock and live entries share [evaluation-execution.mjs](integration/evaluation-execution.mjs) and the browser adapter in [routing-pilot-browser.mjs](integration/routing-pilot-browser.mjs). Routing and model-quality rules supply their own plans, request validation and result qualification; the common execution owns request lifetimes, reservation evidence, settlement, output records and cleanup. Both modes exercise the same reservation ledger before dispatch. Mock responses provide an explicitly synthetic cost for ledger settlement, while reported actual request cost remains `null`. Synthetic ledger totals are labeled and must not be interpreted as billing.

The separately invoked [live entry](integration/routing-pilot.live.mjs) requires the exact USD 2 budget argument and reads the current public model context limits before launch. Both arms use the same caps from [routing-budget.mjs](integration/routing-budget.mjs). The ledger reserves a whole maximum input context plus each output cap, includes concurrent calls, and freezes on unknown cost or a bill above its reservation. Service enforcement of price/output/context limits remains an external assumption; the ledger does not control external provider billing. Missing request-price fields in the public inventory are not evidence of zero request fees: `max_price.request: 0` explicitly constrains them.

Only the Node callback in [live-key.mjs](integration/live-key.mjs) holds the real key. It allows fixed-host Responses POSTs and generation-metadata GETs, rejects redirects, and revokes the bound transport after the callback. The browser stores only a synthetic key, so worker replacement cannot bypass the ledger with a real credential. Responses are fulfilled into the extension before metadata lookup, and accounting is drained before the next run. Unknown in-flight charges retain their reservation and stop further work. Reservations are saved before each possible paid POST, and neither browser cleanup nor transport revocation depends on successful evidence writes.

Live elapsed times include the controlled Node relay and driver overhead in both arms. A full or partial structural result is still subject to routing-blind semantic review. Coverage lost after an actual failed chunk is reported as a comparability limitation without discarding its costs. Any retry after an interrupted paid experiment must first reconcile prior actual and reserved costs against the same total USD 2 authorization; starting a new process does not grant a new budget. No live pilot is added to the existing `verify:live` aggregate.

## Model quality corpus preparation

The [model-quality corpus manifest](integration/fixtures/model-quality/corpus.json) describes three new held-out application excerpts: Python Classes, the Ruff README and NASA Moon Phases. [License and attribution notices](integration/fixtures/model-quality/LICENSES.txt) accompany the normalized HTML. These fixtures preserve selected source prose, links, code and semantic structure while excluding original site chrome and remote media. They do not reproduce the original sites' layouts. They are distinct from the three known regression excerpts in the routing-pilot corpus.

Six WMT25 English-to-Korean source documents, their separate `refA` references and source-only HTML are retained outside the repository for local research evaluation. The [design record](../docs/design/openrouter-translation-routing.md#selected-sources-and-remaining-access-dependency) lists their IDs, source fingerprint, scope and rights limitations. WMT source and reference text is not included in these repository fixtures. Reference translations must remain outside model-facing input and blinded candidate output until the evaluation stage that uses them. The two literary documents are consecutive chapters from one work and are reported separately from the shorter documents.

FLORES+ remains pending access-condition completion; no gated data or replacement mirror is included. The separate [model-quality mock command](integration/model-quality.mock.mjs) loads this corpus plus the existing regressions and the separately supplied private WMT manifest. It does not load the WMT reference file. Use a new owner-only output directory outside the repository:

```sh
npm run test:integration:model-quality -- --wmt-corpus /absolute/private/corpus.private.json --plan
npm run test:integration:model-quality -- --wmt-corpus /absolute/private/corpus.private.json --output /absolute/private/new-output
```

One pass plans 144 pages: twelve source documents, both translation flows and the six confirmed [profiles](integration/model-quality.mjs). A disposable worker adapter changes only the experiment request model, reasoning, price caps and common Inline schema; product files and the original routing-pilot defaults remain unchanged. The Inline common schema omits array length bounds while retaining strict field requirements, and an independent output check rejects extra fields, wrong/missing/duplicate IDs and broken Placeholder Tokens. MiMo's disabled-reasoning profile is explicitly tentative. No credential file is read and the command has no live mode; every accepted model request receives a synthetic response.

The [shared browser runner](integration/routing-pilot-browser.mjs) uses fresh documents, a whole-source viewport and the production discovery/serialization/chunking APIs. It inventories prose from the frozen fixture DOM independently, consumes repeated occurrences separately, records protected/source-syntax exclusions and rejects serializer refusals or unaccounted prose. DOM code and link inventories are checked against Side Panel extraction before the synthetic response can qualify. Real census negative controls remove a duplicated prose occurrence, a code entry and a link entry, requiring rejection before restoring the disposable page and functions. Initial request content hashes and output caps must match across candidate profiles. Inline completion also requires every expected node's own synthetic result to be applied and zero pending/changed/failed outcomes; Side Panel must contain nonempty, ordered source chunks. Both displayed outputs must retain the deterministic mock's ordered source prose. Code/link destinations and protected code text are checked at the appropriate DOM or Markdown boundary. Inline-code source entry text is authoritative when the original Markdown display collapses whitespace.

Private per-run records, source inventories, synthetic accounting, randomized review copies and mapping files are retained. Mock output intentionally copies source prose with a Korean prefix, so Partial Translation outcomes do not establish translation quality. The synthetic USD 2 ledger reuses routing-pilot accounting checks; its small fixed fake charges and context reservation constants are not cost controls or measured billing for these six models. Reported per-profile byte-input/full-output-cap scenarios are planning arithmetic, not tokenization or a hard spend ceiling. The mock does not establish actual provider compatibility, minimum reasoning behavior, translation acceptance or live latency.

### Billed model comparison

The separate [live command](integration/model-quality.live.mjs) requires explicit approval of the USD 5 total envelope. It refreshes public endpoint/ZDR inventories, then runs a small authored compatibility fixture through both flows for every eligible profile. Only profiles passing both flows proceed to twelve documents and two flows once. Compatibility, initial translations and production repairs share one ledger. Every POST reserves the current public maximum context at the accounting price ceiling plus its output cap before transmission; unknown costs freeze spending with the reservation held. Credit-purchase fees and taxes are outside this inference limit. Do not restart an interrupted execution with a fresh ledger before reconciling its charges.

```sh
npm run verify:live:model-quality -- --output /absolute/private/new-output --wmt-corpus /absolute/private/corpus.private.json --budget-usd 5
```

The real OpenRouter key stays inside the fixed-host Node transport; the disposable browser receives a synthetic credential. Per-attempt Inline checks enforce exact JSON shape and IDs, while repaired placeholder structure is judged by the final production application. Failed or nonterminal operations do not authorize unaccounted subsequent requests. Saved success flags cover request, coverage, protection and application contracts; source-based blinded review must establish semantic acceptance separately. Product defaults are unchanged.

## Billed model checks

Both live checks launch their own Chrome session, save a key through Options, and clear it through the real **Clear key** control in `finally`. Run them sequentially: the harness's `closeAllBrowsers()` can close other driver sessions.

Provide an OpenAI key in the gitignored `.env.local`. [integration/live-key.mjs](integration/live-key.mjs) accepts the named entries `OPENAI_API_KEY`, `OPENAI_KEY`, or `OPENAI_SECRET_KEY`, in that order when nonempty. A missing or unattributable key fails rather than silently skipping. Add a newly approved provider-specific name to that helper instead of guessing from an `sk-` value, which can also identify another provider. The helper hands the key to the local CDP session without returning it to its caller or printing it.

For `verify:live:openrouter:inline` and `verify:live:openrouter:sidepanel`, provide `OPENROUTER_API_KEY` in that same file. The helper selects the requested service through Options, saves only its named credential, and selects that service again before clearing it through the real UI in `finally`. OpenAI keys are never substituted for a missing OpenRouter key. Run this command only after separate approval for credential access and billed execution; adding the command grants neither.

### Inline Translation

[inline-translation.live.test.mjs](integration/inline-translation.live.test.mjs) translates a [local fixture](integration/fixtures/inline-translation.html) and asserts target-language output, exact restoration, and control transitions rather than a model's wording.

The first run translates three visible blocks. The second reveals a fourth short block that is absent from the cache, then observes an actual pending model request before pressing Stop. At confirmed Stop, it requires those exact new request IDs to remain unfinished. It then requires their successful HTTP completion and validates the captured answer through the production completion parser and Inline model execution with the original block contract; an unobserved repair cannot qualify. Finally, it checks that the late answer is never applied. Restored cache hits alone would offer Stop without proving cancellation of an in-flight request. Expect the initial three blocks plus one new block and request overhead; output/repair behavior can change the actual bill.

### Side Panel Translation

[sidepanel-translation.live.test.mjs](integration/sidepanel-translation.live.test.mjs) translates a [local protected-span fixture](integration/fixtures/sidepanel-translation.html). It counts every link destination and inline code span back rather than asserting translation wording. If the worker refuses output before rehydration, it reports the refusal and active chunk; if bad output is rendered, it identifies the missing span.

The fixture has twelve links and twelve inline code spans in roughly 5,000 Markdown-template characters, close to 2,000 of them placeholder characters. The check saves a 2,000-character chunk target through Options to produce three Translation Chunks and uses `ATTEMPTS = 3`: nine initial requests on a clean run. Recovery can add requests and cost. Read the fixture and constants in the check before changing that expectation.

[integration/protected-spans.mjs](integration/protected-spans.mjs) owns span counting; its unit suite checks the helper and fixture density. Separate live commands let you authorize one translation flow without paying for both.

The OpenRouter variant uses the same fixture and attempts. It observes only allowlisted request configuration and provider-reported reasoning-token counts for reporting, excluding credentials and translation bodies. A missing reasoning-usage field fails the evidence check rather than proving disablement. Zero reported reasoning tokens is limited provider evidence, not visibility into provider internals. The OpenRouter Inline variant additionally observes strict JSON schema configuration and the existing output bounds. A passing live check establishes compatibility only for its observed route and execution time. Missing authorization, credentials, credits, eligible endpoints, or sufficient response evidence remains a blocker.

## Historical verification evidence

On 2026-10-28, the required UI check reached its panel body, language, view and DOM-repair assertions but failed native ArrowDown scrolling of Options diagnostics on Chrome 149.0.7827.115. The unchanged baseline `6e67502` failed the same assertion. Focus, trusted key delivery, frame timing, macOS native key codes and headed mode did not establish native scrolling; the cause remains unresolved. This observation does not authorize replacing native input with scripted scrolling or weakening the assertion. The performance specification's UI acceptance criterion remains open until the real check passes.

A later #104 verification on the same date ran the unchanged `test:integration:ui` at `207fa9275d9969b901e9352c9e01bd5fc092236a` and exited 0, including native ArrowDown and PageDown scrolling. This supplies a passing observation for the required UI check; it does not identify the cause of the earlier failure or establish that the failure cannot recur. The intercepted `test:integration:openrouter-sidepanel` also exited 0 on Chrome 149.0.7827.115 at 1280×900: four translating notifications carried the 3,900-character source once, and sixty acknowledged polls carried no article bodies. Three independent source mutations were caught by assertion failures in the existing worker/controller suites: retaining unchanged notification bodies, suppressing immediate body recovery, and permitting an older state sequence to replace newer progress. These checks used no real API key or billed model request.

These observations are retained from earlier verification, not rerun by reading or editing this guide:

- On 2026-10-29, heading-permalink's two local fixture headings passed, but all 16 observed public advisor headings failed admission as `hidden_content / DIV` on both `15abb5e83ff1d1567392f5b4aa31b3eb98f0e2f3` and `6d9da2f2a5b2fa94156005d027ae46841250c6b6`. This is an unresolved reported-page failure; separating modes preserves the public failure and the independently passing fixture result.
- The old `qa-issue-003.regression-1` file used `node:test` and was absent from the explicit suite list for two months. It now follows this harness and is registered; confirm both registration and output when adding a suite.
- On 2026-10-06, the `github-skill-page` negative control against codec `65d1a1e` observed 19 visible blocks, one `unsupported_descendant / UL` rejection, zero model requests, and exit 1.
- On 2026-09-10, heading-permalink verification observed 2 fixture and 16 reported-page headings. Codec `3d4848b` rejected all 18 as `hidden_content / DIV`; the fix passed collection, deterministic apply, control behavior, and exact restoration for all 18.
- The billed Inline Stop check was observed failing on `a stopped run never applies the batch it had in flight` when content-side eligibility was broken, while its other checks passed. The extra block was estimated to add a third to a half to that fixture's initial translation cost; this is an estimate for that setup, not a general price.
- The billed Side Panel check was observed failing on `attempt 1/3 is accepted with its token contract intact` at Chunk 1/3 when an `ATOM` token was stripped from every answer. Disabling the missing-token refusal as well made it fail on `code #3 spanGuard01() [lost: in 1, back 0]`, with the other chunk losses named. These controls preceded the current reader-facing error wording and were reverted.
- [ADR-0005](../docs/adr/0005-one-recovery-per-translation-chunk.md) and [ADR-0006](../docs/adr/0006-a-failed-translation-chunk-ends-the-whole-side-panel-translation.md) record the earlier token-failure investigation and its live-verification limitations. [Local UI QA](../docs/qa/qa-report-local-extension-2026-06-15.md) and [Session verification](../docs/qa/issue-70-session-checks.md) retain their own baselines and results.
