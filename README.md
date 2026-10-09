# Chrome AI Translator

A personal Chrome extension that translates article pages with the OpenAI Responses API. Use **Side Panel Translation** to read translated Markdown beside the page, or **Inline Translation** to translate visible article text in place.

## Requirements

- Chrome 116 or newer.
- An OpenAI API key. Use a dedicated key and project because the extension stores the key client-side in Chrome extension storage.

## Load and configure

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Open the extension's **Options** and enter your **OpenAI API Key**.
4. Choose your default target language, tone, model, and chunk size.
5. Choose **When the floating translate button may appear**.

Button Visibility defaults to **Never**. You can also show the button after invoking the extension on a page, or on every ordinary web page. The every-page choice requests access to `http://` and `https://` sites; the other choices revoke that broad access. **Never** hides the floating button while leaving Inline Translation available from the side panel and shortcut.

The saved key is not shown again in the Options input. Leave the field blank to keep it, or choose **Clear key** to remove both the saved key and the legacy `openai_api_key` value.

## Open the controls

Click the toolbar icon to open the side panel without starting a translation. Use the extension shortcut to open the panel and start Inline Translation:

- macOS: `Cmd+Shift+Y`
- Windows/Linux: `Ctrl+Shift+Y`

If the shortcut is unassigned or conflicts with another extension, set it in `chrome://extensions/shortcuts`. Version 0.3.0.0 renamed the command to `translate-inline`; reassign a shortcut you previously set by hand for the old command. The shortcut works even when the floating button is hidden.

The extension cannot translate restricted pages such as `chrome://` pages. If Inline Translation asks for page access, click the extension's toolbar icon on that page and try again.

## Translate in the side panel

1. Choose **Translate current tab** to extract and translate the article.
2. Watch the chunk progress. The translated result appears after every chunk succeeds; a terminal failure leaves no translated result, including earlier chunks that may already have been billed.
3. Choose a translation-only or bilingual **View**, or open the **Original** tab to inspect the extracted Markdown.

You can change target language, tone, and model for the current translation. Choose **Save as default** to keep the visible settings for later translations. Links and code are preserved in the output.

## Translate on the page

Use the side panel's **Inline translation** section, the floating button, or the shortcut:

1. Choose **Translate visible text** to start. Newly visible article blocks translate as you scroll.
2. Choose **Scan visible text** while active to rescan the current viewport.
3. Choose **Stop** to stop new work and keep existing translations.
4. Choose **Original text** to restore original text and inline-node order where the page still permits safe restoration.
5. Start again on the same page to reuse matching cached translations without another model request for those blocks.

The floating menu offers the same start, stop, and restore actions; its start label reflects the target language. Progress and errors appear in the side panel's Inline Translation section regardless of where translation starts.

| Status | Meaning |
| --- | --- |
| Translated | A complete translation was applied. |
| Partial | Safe output was applied, but source-language prose remained after one repair. |
| Pending | A block is queued or being translated. |
| Changed | The page changed before a result could be applied safely. |
| Failed | A block could not be translated or applied safely. Its original content remains. |

Links, emphasis, and code retain their page-owned objects where the translation contract preserves them. Inline Translation skips unsupported or oversized blocks rather than translating fragments. An eligible missing emphasis pair may be omitted from a translated sentence; restoration keeps the original emphasis available.

Stop and **Original text** keep the page visit's cache and Session Budget. Reloading or leaving the page clears them. The budget guards runaway work; it does not cap your spending across page visits. See [limits and accounting](docs/architecture.md#limits-and-accounting) for the implementation constraints.

## Data and diagnostics

Translation sends page content to OpenAI. Responses requests use `store: false`. Side Panel Translation sends article Markdown with link destinations and code contents replaced by placeholders; those values stay within the extension for restoration. Inline Translation sends serialized block records containing prose, structural metadata, and permitted visible labels; it does not send DOM attributes, event state, or hidden alternative-label text.

Options lets you view recent Inline Translation diagnostics and copy or save diagnostic JSON. Diagnostics contain bounded validation metadata and installation-scoped HMAC fingerprints, rather than source text, translations, protected labels, URLs, request or response bodies, or API keys. See [diagnostics and privacy](docs/architecture.md#diagnostics-and-privacy) for the current schema and retention rules.

## Development and documentation

Run `npm test` for the browser-free unit suite and `npm run check:syntax` for extension script parsing. Browser checks have separate commands and prerequisites in the [test guide](tests/README.md). `npm run test:integration` runs only the toolbar-action check. `npm run verify:live` runs both real-model checks and incurs API charges.

Start with the [documentation index](docs/README.md) for the current architecture, glossary, decisions, agent procedures, and historical design and QA records. Load `extension/` directly; the repository has no build step.
