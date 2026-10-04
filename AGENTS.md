## Tests

Use `npm test` for "run the tests": it is the browser-free unit suite. `npm run test:integration` runs only the toolbar-action browser check, not all integration checks. Other unbilled browser checks have separate `test:integration:*` scripts in `package.json`. Before choosing or adding a browser check, read `tests/README.md` for its scope and prerequisites.

`npm run verify:live` runs both billed browser checks; `verify:live:inline` and `verify:live:sidepanel` can also run separately and each bills a real model. These commands need `agent-browser`, network access, and an OpenAI key in `.env.local`. Keep all `verify:live*` checks separate from unit and unbilled integration checks.

`npm run check:syntax` parses every extension script outside a browser. There is no linter, formatter, or type checker — those commands are the whole verification story.

The runner prints one `PASS`/`FAIL` line per check and no summary at all, so the exit code is the only verdict. Several check names contain the word "failed", so grepping the output for failure matches passing checks.

## Layout

No bundler and no build step: `extension/` is loaded unpacked as-is and every file there is a classic script. Four runtimes share it. `background.js` is the MV3 service worker and pulls its dependencies in with `importScripts`. `content.js` runs in the page and is injected programmatically by the worker — the manifest declares no `content_scripts` — from the list in `getInlineContentScriptFiles()`. `sidepanel.js` and `options.js` run in extension pages and get their dependencies from `<script>` tags in `sidepanel.html` and `options.html`.

For shared modules in `extension/`, keep both the `ChromeAiTranslator*` browser API on `globalThis` and the guarded `module.exports` export used by the unit suite. Entry scripts need not expose a named browser API: `background.js`, `content.js`, and `options.js` export helpers only for CommonJS tests; `sidepanel.js` also exposes a browser API. Keep scripts compatible with their classic-script loaders and the CommonJS test harness.

## Adding an extension file

Five hand-maintained lists decide whether a new `extension/*.js` file is loaded and checked, and none of them is derived from the directory:

- `check:syntax` in `package.json`.
- The `importScripts` calls at the top of `extension/background.js`, if it runs in the worker. Order matters — a module that resolves a dependency as it loads has to come in after that dependency.
- `getInlineContentScriptFiles()` in `extension/background.js`, if it runs in the page. Order matters — dependencies come before `content.js`.
- The `<script>` tags in `extension/sidepanel.html` or `options.html`, if it runs in the side panel or the options page.
- The suite list in `tests/run.js`, for its test file. See `tests/README.md`.

A module both runtimes reach is in two of those lists at once and has to be ordered correctly in each. `extension/placeholder-tokens.js` and `extension/markdown-entries.js` are both like that: the worker imports each ahead of the modules that read it there, and the page gets it from the injected list ahead of the ones that read it there.

`tests/static-assets.test.js` guards parts of this, but it spot-checks `check:syntax` against a handful of named files rather than the whole directory, so an omission there passes.

## Adding a browser-driven check

`tests/integration/harness.mjs` holds the CDP wiring and the gotchas that come with driving this extension from outside a browser — import it rather than rebuilding it from a header comment. A new check under `tests/integration/` is reached only through its own `package.json` script; none of the five lists above covers it. One that needs a real API key reads it through `tests/integration/live-key.mjs`, which never returns the value to a caller, and belongs behind `verify:live` rather than `test:integration`.

## Version

When changing the version, update `VERSION`, `version` in `package.json`, and `version` in `extension/manifest.json` together, then verify that all three values match.

## Git

Use an `issue-<n>-<slug>` branch for work that resolves a GitHub issue, and merge it into `main` with a merge commit. Commit standalone changes directly to `main`.

Use `type(scope): imperative` subjects. Explain why the change was needed in the body, and wrap it manually at about 78 columns; commit bodies are the exception to the soft-wrap default. Include `Closes #<n>` for a ticket the commit finishes or `Refs #<n>` for one it advances, following `docs/agents/issue-tracker.md`.

## Agent skills

### Issue tracker

Before implementing a ticket or operating on GitHub issues, read `docs/agents/issue-tracker.md`, including its check for work already satisfied by `main`. Manage this repo's GitHub Issues with the `gh` CLI.

### Triage labels

Before assigning triage labels, read `docs/agents/triage-labels.md` for the canonical roles and their label strings.

### Domain docs

Before exploring code or proposing domain or architecture changes, read `docs/agents/domain.md` and follow its guidance for loading `GLOSSARY.md` and relevant ADRs.
