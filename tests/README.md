# Tests

Three tiers, deliberately separate: one needs nothing, one needs a browser, one needs a browser and spends money. Each line is a wall, not a gradient — the reason a check lives in one tier is the reason it must not creep into the one below.

## `npm test` — the suite you run constantly

`node tests/run.js`. Pure Node: no browser, no network, no API key. Almost every check is a unit test against a function the extension exports, with a fake `chrome` object passed in as a parameter. It stays this way on purpose — the moment it needs a browser binary, it stops being the thing you can run without thinking.

The wall is what a check *needs*, not which module it imports, and two checks make that distinction visible: `live-key.test.js` checks the live checks' own key handling against a fake page, so it imports `tests/integration/live-key.mjs` — and `harness.mjs` behind it — from this tier, and `protected-spans.test.js` does the same for `tests/integration/protected-spans.mjs`, which decides whether a page's links and inline code survived a translation. That is allowed only because importing those modules runs nothing: no browser is launched and no process is spawned at import time. Nothing enforces that; if any of them ever does work on import, the check that imports it has to move up a tier rather than quietly bring a browser into `npm test`.

Both of those exist because a billed check that reasons wrongly reports a clean run, which is worse than not running at all. The judgement a billed check makes belongs here, where it is free to check; only the browser and the bill belong up there.

`tests/run.js` holds an explicit list of suites, and **a test file that is not in that list does not run.** A file exporting `name` and `tests` is not picked up by discovery; there is no discovery.

This has bitten once already. `tests/qa-issue-003.regression-1.test.js` was written against `node:test` instead of this harness and was never added to the list, so from the day it landed until it was converted and registered it never ran — a file calling itself a regression test caught nothing for two months. It runs now. When adding a suite, add it to the list and confirm its checks appear in the output.

## `npm run test:integration` — the check that needs a real browser

`node tests/integration/action-click.test.mjs`. Drives a real Chrome with the unpacked extension loaded and triggers the extension's toolbar action, which is not reachable from the unit suite: it is browser UI, not page DOM.

Requires `agent-browser` on `PATH` and network access. Slower and flakier than `npm test`, and not part of it.

It guards ADR-0001. If `setPanelBehavior({ openPanelOnActionClick: true })` ever comes back, Chrome consumes the action click, `chrome.action.onClicked` never fires, and this check goes red — which is the whole point, because the symptoms in a browser are indirect enough to cost an afternoon.

The Floating Translate Button appearing is what it watches for, so it drives the real options page to choose on-invocation Button Visibility first: the default is never, under which a click correctly mounts nothing. That makes it the one check that the options control saves what the background worker reads.

It stops short of asserting on translation output on purpose. Doing that needs an API key, which would turn a structural check into a billed one — that is `npm run verify:live` below.

The CDP gotchas involved are written up in and handled by `tests/integration/harness.mjs`. Read that header before concluding the driver is broken; several of the failures look like something other than what they are.

## `npm run verify:live` — the checks that spend money

Two checks, one per translation, and the extension has two that share nothing but the page:

- `npm run verify:live:inline` — `tests/integration/inline-translation.live.test.mjs`. Inline Translation really translates a page, and Stop and Restore really behave.
- `npm run verify:live:sidepanel` — `tests/integration/sidepanel-translation.live.test.mjs`. Side Panel Translation really brings the page's links and inline code back.

`verify:live` runs both, and **runs the second even when the first fails**, which is why it is not an `&&`. Neither depends on the other having run: each launches its own browser under its own session name, saves its own key through the real options page, and clears it again on the way out. They are still run one after the other rather than at once, because `closeAllBrowsers()` closes every browser the driver has, not only its own.

Requires `agent-browser` on `PATH`, network access, and an OpenAI key in `.env.local` (gitignored). **A missing key fails the run; it does not skip it.** A check that quietly passes when it did not run is the failure mode this repo has already paid for once — see the `qa-issue-003` story above.

### Inline Translation — `verify:live:inline`

It exists because the unit suite drives `translateVisibleBlockBatch` with a fake `fetch`. That is what makes the suite fast and free, and it also means a green suite says nothing about whether a reader pointing the extension at a page gets a translated page. That gap is small and permanent, so the check closing it is small and separate.

Three things about it are deliberate:

- **`.live.` in the filename** says the file bills. `package.json` is the only wiring — integration checks appear in none of the four hand-maintained lists in `AGENTS.md` — so the name is what stops it being folded into `test:integration` by reflex.
- **The page is a local fixture**, served from `127.0.0.1` by the check itself. A page on the open web serves until its owner edits a sentence, and then the check changes both what it costs and what it asserts without anyone having touched it. `tests/integration/fixtures/inline-translation.html` is what decides the size of the bill.
- **It asserts invariants, never output.** A model's wording changes between runs and between models. What is asserted is that Hangul arrived, that Restore puts back exactly what was there, and that the controls move through the states `inline-translation-controls.js` gives them.

**What the run costs, and what the second half of it buys.** The check translates the fixture twice, and the two halves are billed differently. The first run asks a model for the fixture's three visible blocks. The second exists for the Stop checks, and it bills exactly **one more short block** — the fourth, `hidden` in the fixture and revealed by the check between the runs.

That fourth block is the whole reason the second run proves anything. The translation cache survives Restore: it lives on `inlineState.translationCacheBySettings`, keyed by the settings signature, so translating the same page again under the same settings applies every block from the cache and issues no request. A run like that still turns the status active and still offers Stop, so Stop checks that watch only the status stay green even if cancelling an in-flight batch were broken outright — coverage in name only, and billed. Revealing a block the cache has never seen puts one real request in flight, and the checks then wait for the panel to report a pending block before clicking Stop, require the stopped status rather than merely a dimmed Stop, and hold for at least as long as the first run's own round trip to confirm the cancelled batch's answer is never applied.

So the second run costs one block out of four, plus a second request's own overhead on a page whose requests are this small — call it a third to a half more than translating the fixture once. That was checked rather than assumed: with `isInlineViewportOperationCurrent` broken so that a stopped run applies the answer it had in flight, `npm run verify:live:inline` goes red on `a stopped run never applies the batch it had in flight` and green everywhere else.

### Side Panel Translation — `verify:live:sidepanel`

**The product of this check is an answer, not a green tick.** A reader reported `markdown.token_missing` — the refusal Side Panel Translation issues when an answer comes back without one of the placeholder tokens it sent — and nothing here had ever reproduced it. The unit suite drives that path with a fake `fetch`, so it cannot: the failure turns on a real model keeping tokens it was never asked to keep, and `buildInstructions` in `background.js` really does not ask. Whether it happens is a question only a billed run can answer, and this is the run that asks it.

It is separate from the inline check, rather than more assertions inside it, because the two translations share nothing that matters: different controls, different unit of work — Translation Chunks against Semantic Blocks — different permissions, and different failure. Folding them together would also mean one bill you cannot decline half of. As it stands you can run either alone.

**What it costs.** One attempt translates `tests/integration/fixtures/sidepanel-translation.html` end to end: roughly 5,000 characters of Markdown template, close to 2,000 of that the placeholder tokens themselves, split into three Translation Chunks and therefore three requests. The check makes **`ATTEMPTS` of those, three by default — nine requests in all**, because the failure it is looking for is not known to be deterministic and a single whole answer cannot tell "does not happen" from "did not happen this time". That constant is the bill: raise it to look harder, and say so here.

The fixture is what fixes both the input and the bill, as in the inline check, and what makes it worth billing is written beside it: twelve links and twelve inline code spans, each unique and containing no other so that a loss can be counted and named, and enough of them to cross a chunk boundary. The check saves `chunkMaxChars` at **2,000** — the smallest the options page accepts — through the real options control, so it crosses that boundary on a fixture of 5,000 characters rather than one of 12,000, which is what the default limit would have cost every attempt.

**What it asserts is a count, not a translation.** Every href and every inline code span comes back exactly as often as it went in; the wording around them is not on trial. `tests/integration/protected-spans.mjs` does that counting and `npm test` checks it, including that the shipped fixture is still dense enough to be worth billing.

**What it can and cannot name.** When an answer survives, a lost span is named exactly — kind, place in the document, and the counts either side. When the worker refuses the answer instead, there is no output to name a token from, because the refusal happens before rehydration; what the check reports then is which refusal and which Translation Chunk was in flight, read off the panel's own progress while the run is still under way.

That both of those really go red was checked rather than assumed, because a check written to catch something that has never happened is a check nobody has seen fail. With `translateFullPageChunk` stripping one `ATOM` token out of every answer before validating it, the run goes red on `attempt 1/3 is accepted with its token contract intact`, naming the refusal and `Chunk 1/3` as the chunk in flight — the reader's report, artificially. With the `count === 0` refusal in `validateAndRehydrateChunk` additionally neutered, so the damaged answer reaches the panel instead of being refused, it goes red on `code #3 spanGuard01() [lost: in 1, back 0]` and names the other two chunks' losses beside it. Both injections were reverted; neither is in the tree.

Those two runs happened before the panel learned to say what a lost token means, so what they printed was the bare `markdown.token_missing`. The check quotes whatever the panel says rather than a code of its own, so the same injection now prints the sentence `extension/sidepanel-failure.js` gives that code, with the code still in parentheses after it.

The key is read by `tests/integration/live-key.mjs` and handed only to the local CDP session — never a command argument, never printed, never returned to a caller. Clearing it is a `finally`, not a last step — and the save is inside that `try`, because a save outside it can put a real key in the browser profile on a path the cleanup never reaches. The clearing goes through the options page's own Clear key control rather than writing storage behind it. Written as a step it would run only when everything before it passed, which is exactly when it matters least.

**The key is taken by name**: `OPENAI_API_KEY`, `OPENAI_KEY`, or `OPENAI_SECRET_KEY`, whichever comes first with a value. Nothing is accepted on the strength of its value, because `sk-` is also the start of Anthropic's `sk-ant-` and so says nothing about whose key it is — a run that cannot attribute a key to OpenAI stops and names the entries it saw rather than sending someone else's credential to `api.openai.com`. A key stored under any other name needs that name added to `PROVIDER_KEY_NAMES` in `live-key.mjs`, which is where the provider those names belong to is written down. Both halves are checked browser-free by `tests/live-key.test.js` in `npm test`.
