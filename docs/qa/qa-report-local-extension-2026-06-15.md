# QA Report: Chrome AI Translator Extension

Date: 2026-06-15
Branch: inline-restore-cache
Mode: diff-aware standard QA
Target: Chrome MV3 extension static UI and helper test suite

## Summary

Health score: 97 -> 100

QA covered the changed extension UI surfaces: options page, sidepanel page,
shared stylesheet, and helper tests for content/options/sidepanel behavior.
Browser `file://` access was blocked by policy, so static UI rendering was
verified through a temporary localhost server serving the `extension/`
directory.

Chrome extension APIs are not available in that local HTTP context, so expected
`chrome.*` context errors were not counted as extension runtime defects.

## Results

- Issues found: 1
- Issues fixed: 1 verified
- Deferred issues: 0
- Reverted fixes: 0

## ISSUE-001: Checkbox Label Detaches From Control On Narrow Options Page

Severity: Medium
Category: UX / Accessibility
Status: verified

On a 375px-wide options page, the inline auto-show checkbox rendered as a
standalone square above the label text. The control remained technically usable,
but the visual association between checkbox and label was weak, especially in a
narrow extension/options panel.

Fix:

- Added `class="checkbox-label"` to the inline auto-show label in
  `extension/options.html`.
- Added checkbox-specific flex layout in `extension/styles.css`.
- Added a static regression assertion in `tests/static-assets.test.js`.

Verification:

- Before: browser-rendered 375px options page showed the checkbox above its
  label text in the Codex browser output.
- After: browser-rendered 375px options page showed the checkbox and label on
  one row.
- After metrics: `display:flex`, `align-items:center`, input `44x44`, no
  horizontal overflow, zero small active targets.

Screenshots were observed in the browser QA output but were not saved as files,
because the browser runtime could not write screenshots into the repository
path. The retained evidence is the recorded render metrics above plus the
automated regression test.

## Automated Verification

- `npm test` passed
- `npm run check:syntax` passed
- `git diff --check` passed

## Follow-up QA: Full-Tab Concurrency And Sidepanel Failure Handling

Date: 2026-06-15 23:18 KST
Status: passed
Health score: 100 -> 100

Scope:

- Duplicate full-tab translation guard in `extension/background.js`
- Sidepanel translation failure rendering in `extension/sidepanel.js`
- Moved inline restore cache design document out of ignored
  `docs/superpowers/`

Automated verification:

- `npm test` passed, including the duplicate full-tab translation regression,
  sidepanel click failure regression, and ignored tracked file guard.
- `npm run check:syntax` passed.
- `git diff --check` passed.
- `git check-ignore --no-index -v docs/design/inline-restore-cache-design.md`
  returned no match.
- `git check-ignore --no-index -v
  docs/superpowers/specs/2026-06-15-inline-restore-cache-design.md` confirmed
  the old location is ignored by `.gitignore:3`.

Browser verification:

- Served `extension/` through a temporary localhost server on
  `127.0.0.1:8765`.
- Options page rendered at 1280px and 375px without horizontal overflow.
- Sidepanel rendered at 375px without horizontal overflow; primary controls
  stayed at touch-sized height.
- Clicking "Translate current tab" outside an extension context showed a local
  failure message and re-enabled the button. The exact error was expected for
  HTTP QA because `chrome.tabs` is unavailable there; the UI recovery path was
  still verified.
- The sidepanel's `chrome.runtime.onMessage` console error was also expected in
  the HTTP context and was not counted as an extension runtime defect.

Issues found in this follow-up: 0
Fixes applied in this follow-up: 0

## Notes

The local HTTP render showed `chrome.storage` / `chrome.runtime` errors because
extension pages were opened outside a real Chrome extension context. That is a
QA environment limitation, not a defect observed in the MV3 extension runtime.

PR summary: QA found 1 issue, fixed 1, health score 97 -> 100.
