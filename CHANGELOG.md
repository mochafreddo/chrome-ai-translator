# Changelog

All notable user-facing changes are documented here.

## [0.2.0.0] - 2026-07-10

### Added

- Inline page translation now translates complete paragraphs, headings, list items, and table cells while preserving links, emphasis, and code in the page.
- Added safe restoration of the original inline DOM order after translated content has been shown.

### Fixed

- Rejects semantic-block responses that leave ordinary English source prose untranslated, while retaining protected technical names and literal tokens.
- Keeps translation retries, cache reuse, diagnostics, and status counts aligned with semantic blocks instead of individual text nodes.
- Rejects incomplete full-page responses and retries an output-token-limited chunk once before reporting an error without publishing a partial translation as complete.
- Protects full-page link destinations and code locally, restoring them after translation without including them in model input.
- Rejects Korean inline translations that still use the wrong language after one repair attempt, leaving the original page content unchanged.
- Shows Side Panel settings-save failures so they can be retried.

### Changed

- Expanded inline translation safety limits and documentation for protected content, block ownership, and page-change handling.
- OpenAI Responses requests now set `store: false`; page text is still transmitted to OpenAI and remains subject to the applicable OpenAI data controls.
