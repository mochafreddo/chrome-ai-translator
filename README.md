# Chrome AI Translator

A personal Chrome extension that translates article pages through OpenAI or OpenRouter. Use **Side Panel Translation** to read translated Markdown beside the page. Use **Inline Translation** to translate visible article text in place with either service.

## Requirements

- Chrome 116 or newer.
- An API key for your selected service. Use a dedicated key because the extension stores credentials client-side in Chrome extension storage.

## Load and configure

1. Open `chrome://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's `extension/` directory.
3. Open the extension's **Options**, select **OpenAI** or **OpenRouter**, and enter that service's API key.
4. Choose your default target language, tone, and chunk size. OpenAI keeps a custom model input and reasoning effort selection. OpenRouter uses only `deepseek/deepseek-v4.1-flash-1017`, with reasoning disabled.
5. Choose **When the floating translate button may appear**.

Button Visibility defaults to **Never**. You can also show the button after invoking the extension on a page, or on every ordinary web page. The every-page choice requests access to `http://` and `https://` sites; the other choices revoke that broad access. **Never** hides the floating button while leaving Inline Translation available from the side panel and shortcut.

OpenAI remains the default for existing installations. Each service has its own saved credential. The saved key is not shown again in the Options input. Leave the field blank to keep that service's key, or choose **Clear key** to remove the selected service's credential. Clearing OpenAI also removes its legacy `openai_api_key` value. Switching services keeps the other credential and your OpenAI model and reasoning choices. Selecting or saving settings sends no translation request.

### Update the unpacked extension

After updating this repository, open `chrome://extensions` and click **Reload** on **Chrome AI Translator (Personal)**. Then reload each page where you use the extension. Reload both even when the version number has not changed: an already-running worker or page can still hold code from before the update.

Reloading the page ends its Inline Translation Session, including its cache and Session Budget. Finish any work you want to keep before reloading. The extension does not reload itself automatically.

If the panel says the extension could not initialize, reload the extension and the page in that order, then invoke it again. Clicking the toolbar icon opens the controls without sending a translation request.

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

You can change target language and tone for the current translation, and choose a custom model with OpenAI. Choose **Save as default** to keep the visible settings for later translations. Links and code are preserved in the output. Each translation keeps the service and effective settings it started with, even if you edit Options while it runs.

## Translate on the page

Use the side panel's **Inline translation** section, the floating button, or the shortcut:

1. Choose **Translate visible text** to start. Newly visible article blocks translate as you scroll.
2. Choose **Scan visible text** while active to rescan the current viewport.
3. Choose **Stop** to stop new work and keep existing translations.
4. Choose **Original text** to restore original text and inline-node order where the page still permits safe restoration.
5. Start again on the same page to reuse matching cached translations without another model request for those blocks.

An active Operation keeps its starting service and effective settings, including when you rescan. A later Start after Stop or Original text reads Options again. Changing the service, effective model or reasoning effort, target language, or tone separates cached translations and restores safely owned prior translations before new work. Changing only a key preserves the matching cache.

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

Translation sends page content to your selected service's fixed endpoint. Responses requests use `store: false`. Side Panel Translation sends article Markdown with link destinations and code contents replaced by placeholders; those values stay within the extension for restoration. Inline Translation sends serialized block records containing prose, structural metadata, and permitted visible labels; it does not send DOM attributes, event state, or hidden alternative-label text.

OpenRouter routes only the pinned model, requires support for mandatory request parameters, denies provider data collection, and requires Zero Data Retention (ZDR). Eligible providers of that model may serve requests. If no compliant endpoint is available, translation fails without weakening the policy or switching to another model or OpenAI. ZDR does not erase local extension settings or diagnostics, and does not mean that all request metadata disappears. Resolve key, credit, access, or rate-limit errors with the service named in the error.

Options lets you view recent Inline Translation diagnostics and copy or save diagnostic JSON. Diagnostics contain bounded validation metadata and installation-scoped HMAC fingerprints, rather than source text, translations, protected labels, URLs, request or response bodies, or API keys. See [diagnostics and privacy](docs/architecture.md#diagnostics-and-privacy) for the current schema and retention rules.

## Development and documentation

Run `npm test` for the browser-free unit suite and `npm run check:syntax` for extension script parsing. Browser checks have separate commands and prerequisites in the [test guide](tests/README.md). `npm run test:integration` runs only the toolbar-action check. `npm run verify:live` runs both OpenAI real-model checks and incurs API charges; `npm run verify:live:openrouter:inline` and `npm run verify:live:openrouter:sidepanel` separately bill OpenRouter. Deterministic tests do not establish current model compatibility or availability under the required policy. Live OpenRouter verification, including structured output, Stop, restoration, and provider-reported reasoning usage, remains a separate requirement.

Start with the [documentation index](docs/README.md) for the current architecture, glossary, decisions, agent procedures, and historical design and QA records. Load `extension/` directly; the repository has no build step.
