# Inline Page Translation Design

Date: 2026-06-12

## Goal

Add an inline page translation mode to the personal Chrome extension. The
existing side panel translation remains available. The new mode changes visible
article text in the current page from English to Korean while preserving the
page's DOM structure as much as possible.

## User Decisions

- Keep the existing side panel translation workflow.
- Add inline page translation as a separate mode.
- Translate the main article/body content, not the full page chrome.
- Replace text at the text-node level so links, emphasis, and other inline DOM
  structure mostly remain intact.
- Exclude code-like text conservatively.
- Use a small floating button near the page content.
- Make automatic floating-button injection optional. Default is off.
- The floating button opens a small menu first. The user chooses inline
  translation from that menu.
- Support toggling back to the original English text.

## Non-Goals

- Do not replace the side panel translation with inline translation.
- Do not persist translated page text across reloads.
- Do not cache inline translation results.
- Do not translate every visible navigation item, sidebar item, button, or
  footer by default.
- Do not send raw HTML to the model and reinsert model-generated HTML.

## Architecture

The feature is split between the content script and the background service
worker.

### `content.js`

Responsibilities:

- Find the main content root using the existing article-first strategy:
  `article`, `main`, `[role="main"]`, then `body`.
- Render the inline translation floating button and small menu.
- Collect translatable text nodes under the chosen content root.
- Skip unsafe, hidden, empty, or code-like text.
- Keep an in-memory snapshot of original text nodes for restoration.
- Apply validated translations back to the original text nodes.
- Toggle between translated text and original text without another API call.

The content script owns DOM selection and mutation. It should not know OpenAI
API details.

### `background.js`

Responsibilities:

- Reuse existing settings and API key loading.
- Add a structured text-node translation message handler.
- Translate an array of `{ id, text }` records into `{ id, translation }`
  records.
- Split large arrays into stable chunks when needed.
- Validate that model output is parseable JSON and matches requested IDs before
  returning it to the content script.

The background script owns model calls and API error handling. It should not
mutate page DOM.

### Options UI

Add an option for automatic inline floating-button injection:

- Setting name: `inlineAutoShow`
- Default: `false`
- When disabled, the button appears only after the user invokes the extension
  for the current tab.
- When enabled, the extension may inject the button automatically on supported
  normal web pages.
- Enabling automatic injection may require additional Chrome extension
  permissions or declarative content-script registration. The implementation
  should keep the default permission footprint unchanged unless the user enables
  automatic display.

### Toolbar and Command Behavior

The toolbar icon and keyboard command keep their current side panel translation
behavior. They may also ensure the floating button is available on the current
tab, but they must not start inline translation automatically. Inline
translation starts only after the user chooses it from the floating menu.

## Data Flow

1. The user invokes the extension or visits a page with automatic injection
   enabled.
2. The content script displays a small floating button near the page content.
3. The user opens the button menu and chooses inline page translation.
4. The content script selects the article/main content root.
5. The content script walks text nodes in DOM order.
6. Each eligible text node receives an internal ID and original-text snapshot.
7. The content script sends `{ id, text }[]` to the background script.
8. The background script translates the records to Korean with structured JSON
   output.
9. The background script validates all returned IDs and translations.
10. The content script applies translated text to the matching text nodes.
11. The user can choose original text from the same menu to restore the
    snapshot without another API call.

## Text Selection Rules

Skip text inside these elements:

- `script`
- `style`
- `noscript`
- `svg`
- `canvas`
- `iframe`
- `pre`
- `code`
- `kbd`
- `samp`

Also skip:

- Whitespace-only text nodes.
- Text from hidden elements.
- URL-only strings.
- File names or paths.
- CLI flags and command-like fragments.
- Short identifier-like strings where translation is likely harmful.

The implementation may use conservative heuristics. If uncertain, preserve the
original text instead of translating it.

## Model Contract

The inline translation prompt should ask for JSON only. The preferred shape is:

```json
{
  "translations": [
    { "id": "n1", "translation": "..." }
  ]
}
```

Rules:

- Preserve record IDs exactly.
- Translate only the `text` values.
- Do not translate code, identifiers, URLs, filenames, or commands.
- Do not add commentary.
- Return JSON only.

The background script must reject responses that are not valid JSON, do not
contain the expected array, omit IDs, duplicate IDs, or include unexpected IDs.

## Toggle Behavior

The inline mode has three user-visible states:

- `Original`: no inline translation has been applied.
- `Translating`: a translation request is in progress.
- `Translated`: translated text is applied and can be restored.

While translating, duplicate requests are ignored or disabled. Restoring original
text never calls the API.

State is held in the current page context only. Reloading the page clears the
state and restores the original page from the network/browser cache.

## Error Handling

- Missing API key: show a short inline menu error and guide the user to options.
- Unsupported page: fail without modifying page text.
- Extraction finds no useful article text: show a short inline error.
- API request failure: leave original text unchanged.
- Chunk failure: leave original text unchanged.
- Invalid JSON or ID mismatch: leave original text unchanged.
- Node disappearance during translation: skip that node or fail the application
  step without corrupting remaining text.

Apply translations only after the full response set for the current operation is
validated. This avoids partially translated pages after model or network errors.

## Verification

The repository currently has no test runner. Verification should include focused
manual checks and small pure functions where practical.

Manual checks:

- Existing side panel translation still opens and translates.
- Floating button can be shown for the current tab.
- Floating menu exposes inline translation and original-text actions.
- Inline translation changes article text in place.
- Links, emphasis, and inline elements remain structurally intact.
- `pre`, `code`, `kbd`, and `samp` text remains unchanged.
- Code-like short text, URLs, filenames, and command-like fragments remain
  unchanged.
- Original-text toggle restores the page without calling the API.
- Missing API key and API failure leave page text unchanged.
- Automatic button display is off by default and can be enabled from options.

Where logic is extracted into functions, verify:

- tag exclusion
- code-like text detection
- text node eligibility
- chunking
- structured response validation
