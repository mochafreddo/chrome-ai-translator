# Tests

Three entry points, deliberately separate: one needs nothing, one needs a browser, one needs a browser and spends money. Each line is a wall, not a gradient — the reason a check lives in one tier is the reason it must not creep into the one below.

## `npm test` — the suite you run constantly

`node tests/run.js`. Pure Node: no browser, no network, no API key. Almost every check is a unit test against a function the extension exports, with a fake `chrome` object passed in as a parameter. It stays this way on purpose — the moment it needs a browser binary, it stops being the thing you can run without thinking.

The wall is what a check *needs*, not which module it imports, and one check makes that distinction visible: `live-key.test.js` checks the live check's own key handling against a fake page, so it imports `tests/integration/live-key.mjs` — and `harness.mjs` behind it — from this tier. That is allowed only because importing those two runs nothing: no browser is launched and no process is spawned at import time. Nothing enforces that; if either module ever does work on import, this check has to move up a tier rather than quietly bring a browser into `npm test`.

`tests/run.js` holds an explicit list of suites, and **a test file that is not in that list does not run.** A file exporting `name` and `tests` is not picked up by discovery; there is no discovery.

This has bitten once already. `tests/qa-issue-003.regression-1.test.js` was written against `node:test` instead of this harness and was never added to the list, so from the day it landed until it was converted and registered it never ran — a file calling itself a regression test caught nothing for two months. It runs now. When adding a suite, add it to the list and confirm its checks appear in the output.

## `npm run test:integration` — the check that needs a real browser

`node tests/integration/action-click.test.mjs`. Drives a real Chrome with the unpacked extension loaded and triggers the extension's toolbar action, which is not reachable from the unit suite: it is browser UI, not page DOM.

Requires `agent-browser` on `PATH` and network access. Slower and flakier than `npm test`, and not part of it.

It guards ADR-0001. If `setPanelBehavior({ openPanelOnActionClick: true })` ever comes back, Chrome consumes the action click, `chrome.action.onClicked` never fires, and this check goes red — which is the whole point, because the symptoms in a browser are indirect enough to cost an afternoon.

The Floating Translate Button appearing is what it watches for, so it drives the real options page to choose on-invocation Button Visibility first: the default is never, under which a click correctly mounts nothing. That makes it the one check that the options control saves what the background worker reads.

It stops short of asserting on translation output on purpose. Doing that needs an API key, which would turn a structural check into a billed one — that is `npm run verify:live` below.

The CDP gotchas involved are written up in and handled by `tests/integration/harness.mjs`. Read that header before concluding the driver is broken; several of the failures look like something other than what they are.

## `npm run verify:live` — the check that spends money

`node tests/integration/inline-translation.live.test.mjs`. The only check that bills. It drives a real Chrome with a real OpenAI key and asserts that Inline Translation really translates a page, and that Stop and Restore really behave.

Requires `agent-browser` on `PATH`, network access, and an OpenAI key in `.env.local` (gitignored). **A missing key fails the run; it does not skip it.** A check that quietly passes when it did not run is the failure mode this repo has already paid for once — see the `qa-issue-003` story above.

It exists because the unit suite drives `translateVisibleBlockBatch` with a fake `fetch`. That is what makes the suite fast and free, and it also means a green suite says nothing about whether a reader pointing the extension at a page gets a translated page. That gap is small and permanent, so the check closing it is small and separate.

Three things about it are deliberate:

- **`.live.` in the filename** says the file bills. `package.json` is the only wiring — integration checks appear in none of the four hand-maintained lists in `AGENTS.md` — so the name is what stops it being folded into `test:integration` by reflex.
- **The page is a local fixture**, served from `127.0.0.1` by the check itself. A page on the open web serves until its owner edits a sentence, and then the check changes both what it costs and what it asserts without anyone having touched it. `tests/integration/fixtures/inline-translation.html` is what decides the size of the bill.
- **It asserts invariants, never output.** A model's wording changes between runs and between models. What is asserted is that Hangul arrived, that Restore puts back exactly what was there, and that the controls move through the states `inline-translation-controls.js` gives them.

The key is read by `tests/integration/live-key.mjs` and handed only to the local CDP session — never a command argument, never printed, never returned to a caller. Clearing it is a `finally`, not a last step — and the save is inside that `try`, because a save outside it can put a real key in the browser profile on a path the cleanup never reaches. The clearing goes through the options page's own Clear key control rather than writing storage behind it. Written as a step it would run only when everything before it passed, which is exactly when it matters least.

**The key is taken by name**: `OPENAI_API_KEY`, `OPENAI_KEY`, or `OPENAI_SECRET_KEY`, whichever comes first with a value. Nothing is accepted on the strength of its value, because `sk-` is also the start of Anthropic's `sk-ant-` and so says nothing about whose key it is — a run that cannot attribute a key to OpenAI stops and names the entries it saw rather than sending someone else's credential to `api.openai.com`. A key stored under any other name needs that name added to `PROVIDER_KEY_NAMES` in `live-key.mjs`, which is where the provider those names belong to is written down. Both halves are checked browser-free by `tests/live-key.test.js` in `npm test`.
