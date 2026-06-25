# chrome-ai-translator (personal)

A **personal-only** Chrome extension that translates article pages with OpenAI
Responses API. It keeps the translated Markdown in a **Side Panel** and can also
translate page text inline with a floating page button.

## Requirements
- Chrome 116 or newer.
- An OpenAI API key. Use a dedicated key/project because the key is stored
  client-side in Chrome extension storage.

## Load the extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `chrome-ai-translator/extension`

## Setup
1. Open extension **Options**
2. Paste your **OpenAI API Key**
3. (Optional) change default target language, tone, model, and chunk size
4. (Optional) enable **Show inline translation button automatically on normal
   web pages**

The automatic inline button option requests access to normal `http://` and
`https://` pages so Chrome can inject the floating button without first clicking
the extension. It is off by default.

The saved key is never shown back in the Options input. Leaving the key field
blank preserves the current key; **Clear key** removes the saved key and the
legacy `openai_api_key` value.

## Use
- Click the extension toolbar icon, or use the Chrome extension shortcut if it
  is assigned:
  - macOS: `Cmd+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`

If the shortcut does not work, check `chrome://extensions/shortcuts`. Chrome can
leave a suggested shortcut unassigned when it conflicts with another shortcut or
has been changed locally.

The Side Panel should open and show the translated Markdown. The same action also
shows a floating **Translate** button on the page.

In the Side Panel:

- **Translate current tab** extracts the current article, translates it, and
  updates progress by chunk.
- Target language, tone, model, and view can be changed for the current run.
- **Save as default** stores the visible settings for future runs.
- **View** can show only the translation or a bilingual original/translation
  output.
- The **Original** tab shows the extracted Markdown source.
- Inline code in paragraphs and list items is marked as Markdown code before
  translation, so the model can keep snippets like API names and commands
  unchanged.

For inline page translation:

1. Open the floating **Translate** button.
2. Choose **Page in Korean** to start viewport-first inline translation.
3. As you scroll, newly visible article text is translated and kept in place.
4. Choose **Stop** to stop translating newly visible text while keeping current
   translations.
5. Choose **Original text** to restore the page text that was replaced.
6. Choose **Page in Korean** again on the same page to reuse matching in-memory
   translations instead of sending the same visible text again.

If automatic inline display is enabled, the floating button can appear without
the toolbar click. Starting inline translation still requires choosing
**Page in Korean** before page text is sent for translation.

## Limits and diagnostics
- Full-page Side Panel translation stops before sending more than 60,000
  extracted characters.
- Full-page translation reserves at least 8,192 output tokens for each request
  and scales that cap up for larger chunks to reduce truncation.
- `Chunk max chars` defaults to `12000` and is clamped between `2000` and
  `60000`.
- Inline translation translates only visible article text while active and
  scans again on scroll, resize, and page mutations. Large pages are scanned in
  bounded windows and viewport changes reset pending scan work so the current
  visible text is prioritized.
- Inline viewport batches are capped at 2,000 input characters and 2,048 output
  tokens. Over-expanded inline responses are rejected before they can be applied
  to the page.
- Inline status separates page-change conflicts from request failures. `Changed`
  means the page modified a text node before the extension could safely apply a
  returned translation; changed text is retried once when the current text is
  still translatable. `Failed` means the request or response validation failed.
- Inline translations restored with **Original text** are cached only in the
  current page instance. The cache is reused only when target language, tone,
  model, and reasoning effort still match, and it is cleared by reloads,
  navigations, or browser restarts.
- Options shows the 20 most recent inline translation runs with status, model,
  node/character/chunk counts, timings, and redacted errors.

## Related docs
- [Inline changed text retry design](docs/design/inline-changed-text-retry-design.md)
- [Inline restore cache design](docs/design/inline-restore-cache-design.md)
- [Local extension QA report](docs/qa/qa-report-local-extension-2026-06-15.md)

## Development
- Run tests: `npm test`
- Check extension script syntax: `npm run check:syntax`

## Notes
- Settings are stored in `chrome.storage.local` under `settings`.
- It won't work on restricted pages like `chrome://`.
- Inline translation skips code-like text, links, filenames, commands, and page
  chrome. It translates visible article text in small batches while active.
- Inline translation uses structured JSON output and records recent run
  diagnostics in Options without storing source text, translations, or API keys.
