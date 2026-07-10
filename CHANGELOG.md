# Changelog

All notable user-facing changes are documented here.

## [0.2.0.0] - 2026-07-10

### Added

- Inline page translation now translates complete paragraphs, headings, list items, and table cells while preserving links, emphasis, and code in the page.
- Added safe restoration of the original inline DOM order after translated content has been shown.

### Fixed

- Rejects semantic-block responses that leave ordinary English source prose untranslated, while retaining protected technical names and literal tokens.
- Keeps translation retries, cache reuse, diagnostics, and status counts aligned with semantic blocks instead of individual text nodes.

### Changed

- Expanded inline translation safety limits and documentation for protected content, block ownership, and page-change handling.
