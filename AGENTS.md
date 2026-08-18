## Tests

`npm test` is the browser-free unit suite and is what "run the tests" means. `npm run test:integration` additionally drives a real Chrome and needs `agent-browser` plus network access. `npm run verify:live` drives a real Chrome *and* bills a real model, and needs an OpenAI key in `.env.local` — it is the only command that spends money, which is why it is never folded into the other two. See `tests/README.md`.

`npm run check:syntax` parses every extension script outside a browser. There is no linter, formatter, or type checker — those commands are the whole verification story.

The runner prints one `PASS`/`FAIL` line per check and no summary at all, so the exit code is the only verdict. Several check names contain the word "failed", so grepping the output for failure matches passing checks.

## Layout

No bundler and no build step: `extension/` is loaded unpacked as-is and every file there is a classic script. Four runtimes share it. `background.js` is the MV3 service worker and pulls its dependencies in with `importScripts`. `content.js` runs in the page and is injected programmatically by the worker — the manifest declares no `content_scripts` — from the list in `getInlineContentScriptFiles()`. `sidepanel.js` and `options.js` run in extension pages and get their dependencies from `<script>` tags in `sidepanel.html` and `options.html`.

Every module in `extension/` publishes itself twice: onto `globalThis` under a `ChromeAiTranslator*` name for the browser, and as `module.exports` when a CommonJS loader is present. That second half is what lets the unit suite `require()` extension code directly and hand it a fake `chrome`. Keep both when adding a module — converting one to an ES module puts it out of reach of the service worker and the tests at the same time.

## Adding an extension file

Four hand-maintained lists decide whether a new `extension/*.js` file is loaded and checked, and none of them is derived from the directory:

- `check:syntax` in `package.json`.
- `getInlineContentScriptFiles()` in `extension/background.js`, if it runs in the page. Order matters — dependencies come before `content.js`.
- The `<script>` tags in `extension/sidepanel.html` or `options.html`, if it runs in the side panel or the options page.
- The suite list in `tests/run.js`, for its test file. See `tests/README.md`.

`tests/static-assets.test.js` guards parts of this, but it spot-checks `check:syntax` against five named files rather than the whole directory, so an omission there passes.

## Adding a browser-driven check

`tests/integration/harness.mjs` holds the CDP wiring and the gotchas that come with driving this extension from outside a browser — import it rather than rebuilding it from a header comment. A new check under `tests/integration/` is reached only through its own `package.json` script; none of the four lists above covers it. One that needs a real API key reads it through `tests/integration/live-key.mjs`, which never returns the value to a caller, and belongs behind `verify:live` rather than `test:integration`.

## Version

`VERSION`, `version` in `package.json`, and `version` in `extension/manifest.json` all carry it, and nothing keeps them in sync.

## Git

Each unit of work lands as an `issue-<n>-<slug>` branch merged into `main` with a merge commit — nothing is committed to `main` directly. Subjects are `type(scope): imperative`; bodies are prose saying why the change was needed rather than what it touched, and are long by most projects' standards. Wrap the body by hand at about 78 columns: `git log` indents a body four spaces and never reflows it, so a soft-wrapped paragraph breaks mid-word and loses the indent in any terminal. This is the one place the soft-wrap default for prose does not apply. A commit that finishes or advances a ticket carries `Closes #<n>` or `Refs #<n>` — see `docs/agents/issue-tracker.md`.

## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues (`mochafreddo/chrome-ai-translator`), managed via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — one `CONTEXT.md` plus `docs/adr/` at the repo root. See `docs/agents/domain.md`.
