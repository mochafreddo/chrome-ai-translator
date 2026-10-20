# Agent environment improvements after the initialization investigation

This design records the four improvements agreed during the 2026-10-20 retrospective interview. The user confirmed the combined implementation scope, public test seams, repository review bases, and verification plan on 2026-10-20. Implementation requires a separate request; this confirmation does not authorize installation, configuration changes, commits, or publication.

## Evidence and boundaries

The [initialization investigation](../qa/content-script-readiness-2026-10-20.md) reproduced a sufficient loader mismatch but did not identify the original Chrome runtime. Restarting Chrome to connect the debugger left the original state unavailable. The implementation review also found that a missing initial page or tab could let a new browser check return without recording a failure; that individual check was corrected.

The common [integration harness](../../tests/integration/harness.mjs) still returns nullable launch observations and leaves assertions to callers. The [syntax command](../../package.json) currently includes every extension script, but its hand-maintained list and selected-name assertions do not enforce coverage of future files. CI already runs syntax, documentation, and unit checks. An offline Modern Web Guidance lookup failed with `ENOTCACHED`; this establishes unavailable cached input for that invocation, not a generally broken tool.

## Agreed changes

### Preserve evidence before changing browser state

The shared browser procedure will collect available, authorized observations before restart, extension Reload, or host-page reload: extension version, relevant worker identity, registered injection file lists, and the necessary error stack. It will distinguish runtime observations from current files on disk and reconstructed hypotheses.

If the debugger cannot connect, the record will state which observations were unavailable before any state-changing recovery. Collection will not require bypassing browser policy or obtaining unrelated profile data. Records will use the existing local task-evidence procedure and exclude credentials and unnecessary page content. No continuous collection feature or extension telemetry is planned.

The canonical procedure belongs in the dotfiles repository's `.agents/docs/browser-tools.md`; this repository's test guide will link to it where incident investigation applies. The existing historical incident record will retain its original evidence and limits.

### Make missing browser prerequisites fail reliably

The shared harness will enforce the prerequisites needed by its browser checks so missing extension, initial page/tab, or failed CDP readiness cannot produce a successful run. All launch callers, including billed-check callers, will be inspected before choosing the smallest shared change. Existing bounded diagnostics and cleanup must survive failures before a context is returned as well as failures after launch.

The public test seam is the harness launch/check interface and the check process's exit status. Unit tests will substitute only external browser/process/network interactions, inject each missing prerequisite, and observe failure and cleanup. A valid launch remains usable. Existing public helpers will be reused before introducing a new seam. Translation behavior and real model requests are outside this change.

### Discover syntax inputs from the extension directory

`npm run check:syntax` will enumerate regular `.js` files immediately inside `extension/`, sort them, and parse them with the current Node executable. Any syntax error produces exit code 1; an empty input set is an error rather than a successful check. No dependency or recursive traversal is required.

The public test seam is the command and its filesystem inputs. A newly discovered valid script must be checked without editing a list, and an invalid script must fail. Fixtures will use a disposable directory or an equivalent existing test seam rather than mutate unrelated extension files. Loader-order and classic-script execution checks remain separate. Existing selected-name assertions will be replaced or adjusted to verify actual coverage, and the repository instructions will stop describing obsolete manual syntax-list maintenance.

### Check tool readiness before dependent work

Shared instructions will direct a read-only check of required executables, cache/network restrictions, and interactive browser permission requirements before dependent work starts. Reports will distinguish unavailable tooling, pending permission, and an observed product failure. A timeout alone will not establish which condition occurred.

The dotfiles repository's `.claude/rules/skill-overrides.md` owns cross-skill execution adjustments; `.agents/runbooks/tooling-gotchas.md` owns the observed cache failure and its narrow recovery procedure. Browser-specific prerequisites stay with the browser procedure. External skill sources will remain unchanged. The preflight will neither install tools nor grant permissions; those actions retain their existing approval requirements. No generic preflight framework is planned.

## Verification and review

| Repository | Review base | Scope | Verification |
| --- | --- | --- | --- |
| chrome-ai-translator | `b16bd56ec59abfbb28853598d7055b09b535f997` | Harness and callers, harness/command regression tests, syntax runner and package entry, relevant repository/test guidance, this design and its index | Unit suite, syntax and documentation checks; missing-prerequisite and invalid-script negative controls; unbilled toolbar and content-readiness browser checks |
| dotfiles | `ab1361683802810c53b3a0bf6c9cc3a8029f3671` | Browser procedure, skill overrides, tooling runbook, only necessary existing navigation links | Source/command ownership and approval-boundary review, local link checks and applicable repository documentation checks; no tests that assert prose wording |

The browser checks use disposable sessions and no API key. Billed checks will not run; their callers receive source review and harness-level tests. Required negative controls will use the existing mutation-probe procedure where source mutations are needed. No repeated full-suite execution is required without changed inputs or unresolved failures.

Before implementation, refresh any delivery target as required and record an adjusted immutable base if concurrent work changed it. The dotfiles checkout already has unrelated agent-definition and dispatch edits; preserve those changes and use isolated implementation work for changes intended for commit. Existing Git delivery and final-input verification rules apply to any later commit or push request. No GitHub issue, deployment, user-profile mutation, or publication is included.

These changes concern engineering procedures and checks rather than translation domain vocabulary. They require neither new glossary entries nor an ADR: the proposed choices are local and reversible, and current architecture decisions remain in force.
