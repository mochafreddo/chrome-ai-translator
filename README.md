# chrome-ai-translator (personal)

A **personal-only** Chrome extension that translates article pages with OpenAI Responses API. It keeps the translated Markdown in a **Side Panel** and can also translate page text inline, driven from that panel or from a floating page button.

## Requirements
- Chrome 116 or newer.
- An OpenAI API key. Use a dedicated key/project because the key is stored client-side in Chrome extension storage.

## Load the extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `chrome-ai-translator/extension`

## Setup
1. Open extension **Options**
2. Paste your **OpenAI API Key**
3. (Optional) change default target language, tone, model, and chunk size
4. (Optional) choose **When the floating translate button may appear**

The three choices are exclusive: never, once you have opened the extension on the page, or on every web page. **Never** is the default. Only the every-page choice requests access to normal `http://` and `https://` pages, which is what lets Chrome inject the floating button before you open the extension; the other two give that access back.

**Never** removes the button only. The Side Panel has its own **Inline translation** section carrying the same controls, so inline translation stays fully usable with the button switched off.

The saved key is never shown back in the Options input. Leaving the key field blank preserves the current key; **Clear key** removes the saved key and the legacy `openai_api_key` value.

OpenAI Responses requests set `store: false`. Page text is still transmitted to OpenAI and remains subject to the applicable OpenAI data controls.

## Use
- Click the extension toolbar icon, or use the Chrome extension shortcut if it is assigned:
  - macOS: `Cmd+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`

If the shortcut does not work, check `chrome://extensions/shortcuts`. Chrome can leave a suggested shortcut unassigned when it conflicts with another shortcut or has been changed locally. Version 0.3.0.0 renamed the command behind the shortcut, so a combination assigned by hand before that version is no longer honoured and has to be assigned once more.

The Side Panel opens on either action. The shortcut also starts inline translation on the page it was pressed on, whatever the button visibility is set to, and the Side Panel's **Inline translation** section is where that run reports progress and failures. A floating **Translate** button appears on the page where the chosen visibility allows it.

In the Side Panel:

- **Translate current tab** extracts the current article, translates it, and updates progress by chunk.
- Target language, tone, model, and view can be changed for the current run.
- **Save as default** stores the visible settings for future runs.
- **View** can show only the translation or a bilingual original/translation output.
- The **Original** tab shows the extracted Markdown source.
- Inline code in paragraphs and list items is marked as Markdown code before translation, so the model can keep snippets like API names and commands unchanged.

For inline page translation, from the Side Panel's **Inline translation** section:

1. Choose **Translate visible text** to start viewport-first inline translation.
2. As you scroll, newly visible article blocks are translated in place. Inline links, emphasis, and code keep their existing DOM objects and can move to match the translated word order.
3. Choose **Stop** to stop translating newly visible text while keeping current translations.
4. Choose **Original text** to restore the original text and inline-node order.
5. Choose **Scan visible text** on the same page to reuse matching in-memory translations instead of sending the same visible text again.

Progress and errors for inline translation are reported in that section, whether the run was started there or from the page.

The floating **Translate** button, where the chosen visibility allows it, carries the same three controls under **Page in Korean**, **Stop**, and **Original text**. Page text is sent for translation only after one of these controls, or one in the Side Panel, has been chosen.

## Limits and diagnostics
- Full-page Side Panel translation stops before sending more than 60,000 extracted characters.
- Full-page translation reserves at least 8,192 output tokens for each request and scales that cap up for larger chunks to reduce truncation.
- Full-page link destinations and code contents are protected locally and restored after translation; they are not included in model input.
- A full-page chunk that reaches its output-token limit is split and retried once. If recovery does not complete, the extension reports an error and does not publish a partial translation as complete.
- A Translation Chunk that fails anyway ends the whole Side Panel Translation: the panel shows no translated text at all, including the chunks that already came back and were billed, and translating again re-sends every chunk. This is a decision rather than an oversight — see [ADR-0006](docs/adr/0006-a-failed-translation-chunk-ends-the-whole-side-panel-translation.md).
- `Chunk max chars` defaults to `12000` and is clamped between `2000` and `60000`.
- Inline translation translates only visible article text while active and scans again on scroll, resize, and page mutations. Large pages are scanned in bounded windows and viewport changes reset pending scan work so the current visible text is prioritized.
- Inline translation serializes one semantic paragraph, heading, list item, or table cell with protected tokens for inline elements. A block and a batch are each capped at 12,000 serialized characters; the Session Budget for one Inline Translation Session (one page visit) is 150,000 of serialized record cost, which is not a count of the page's own characters. That budget covers the second request a repair sends, survives **Original text** and stop-then-restart, and is cleared only by reloading the page — see [ADR-0007](docs/adr/0007-charge-the-session-budget-in-actual-record-cost.md). Output caps scale from 4,096 to 16,000 tokens. Oversized or malformed blocks remain unchanged instead of falling back to fragment translation.
- Protected visible labels such as model names, commands, and API names are sent as translation context. Link destinations, DOM attributes, hidden text, and event state are not sent.
- Inline status separates complete, partial, page-change, and failed results. `Partial` means structurally safe output was applied after one quality repair still left a conservative quality warning. `Changed` means the page modified a block or replaced its owned DOM nodes before the extension could safely apply a returned translation. Page changes and invalid token output are retried at most once each. `Failed` means the request, protected-token contract, or safe DOM application failed. Counts represent semantic blocks rather than individual text nodes.
- Inline translations restored with **Original text** are cached only in the current page instance. The cache is reused only when target language, tone, model, reasoning effort, semantic template, and protected-token context still match, and it is cleared by reloads, navigations, or browser restarts.
- Options shows the 20 most recent inline translation runs and can copy or save schema-2 diagnostic JSON for RCA with Codex or another agent. Problem records include stable validation codes, attempt counts, bounded evidence, and installation-scoped HMAC fingerprints. Each run retains at most 100 problem blocks. Source text, translations, matched words, protected labels, URLs, request bodies, response bodies, and API keys are never persisted or exported.
- Model-output validation gets at most one repair attempt. Structurally unsafe output is never applied. A structurally safe result that remains incomplete after repair is applied explicitly as `Partial` rather than discarded.

## Related docs
- [Inline changed text retry design](docs/design/inline-changed-text-retry-design.md)
- [Inline restore cache design](docs/design/inline-restore-cache-design.md)
- [Local extension QA report](docs/qa/qa-report-local-extension-2026-06-15.md)

## Development
- Run tests: `npm test`
- Check extension script syntax: `npm run check:syntax`
- Drive a real Chrome: `npm run test:integration`. Needs `agent-browser` on `PATH` and network access. Not part of `npm test`.
- Check that translation really works: `npm run verify:live`. Needs the above plus an OpenAI key in `.env.local`, and bills a real model — it is the only command that costs anything, so it is never run by the other two.

## Notes
- Settings are stored in `chrome.storage.local` under `settings`.
- It won't work on restricted pages like `chrome://`.
- Inline translation excludes page chrome and editable controls. Code-like text, filenames, commands, versions, and protected link labels remain exact through atomic tokens; natural-language link text can be translated in place.
- Inline translation uses structured JSON output and records recent run diagnostics in Options without storing source text, translations, protected labels, URLs, request bodies, or API keys.
