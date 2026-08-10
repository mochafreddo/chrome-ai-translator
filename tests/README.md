# Tests

Two entry points, deliberately separate.

## `npm test` — the suite you run constantly

`node tests/run.js`. Pure Node: no browser, no network, no API key. Every check is a unit test against a function the extension exports, with a fake `chrome` object passed in as a parameter. It stays this way on purpose — the moment it needs a browser binary, it stops being the thing you can run without thinking.

`tests/run.js` holds an explicit list of suites, and **a test file that is not in that list does not run.** A file exporting `name` and `tests` is not picked up by discovery; there is no discovery.

This has bitten once already. `tests/qa-issue-003.regression-1.test.js` was written against `node:test` instead of this harness and was never added to the list, so from the day it landed until it was converted and registered it never ran — a file calling itself a regression test caught nothing for two months. It runs now. When adding a suite, add it to the list and confirm its checks appear in the output.

## `npm run test:integration` — the check that needs a real browser

`node tests/integration/action-click.test.mjs`. Drives a real Chrome with the unpacked extension loaded and triggers the extension's toolbar action, which is not reachable from the unit suite: it is browser UI, not page DOM.

Requires `agent-browser` on `PATH` and network access. Slower and flakier than `npm test`, and not part of it.

It guards ADR-0001. If `setPanelBehavior({ openPanelOnActionClick: true })` ever comes back, Chrome consumes the action click, `chrome.action.onClicked` never fires, and this check goes red — which is the whole point, because the symptoms in a browser are indirect enough to cost an afternoon.

The CDP gotchas involved are written up in that file's header comment. Read them before concluding the harness is broken; several of the failures look like something other than what they are.
