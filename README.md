# chrome-ai-translator (personal)

A **personal-only** Chrome extension that translates article pages with OpenAI
Responses API. It keeps the translated Markdown in a **Side Panel** and can also
translate page text inline with a floating page button.

## Load the extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `chrome-ai-translator/extension`

## Setup
1. Open extension **Options**
2. Paste your **OpenAI API Key**
3. (Optional) change model / target language
4. (Optional) enable **Show inline translation button automatically on normal
   web pages**

The automatic inline button option requests access to normal `http://` and
`https://` pages so Chrome can inject the floating button without first clicking
the extension. It is off by default.

## Use
- Click the extension toolbar icon, or press:
  - macOS: `Cmd+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`

The Side Panel should open and show the translated Markdown. The same action also
shows a floating **Translate** button on the page.

For inline page translation:

1. Click the extension toolbar icon or press the shortcut on the target page.
2. Open the floating **Translate** button.
3. Choose **Page in Korean** to start viewport-first inline translation.
4. As you scroll, newly visible article text is translated and kept in place.
5. Choose **Stop** to stop translating newly visible text while keeping current
   translations.
6. Choose **Original text** to restore the page text that was replaced.

If automatic inline display is enabled, the floating button can appear without
the toolbar click. Starting inline translation still requires a recent toolbar
or shortcut action before page text is sent for translation.

## Notes
- This stores your API key in `chrome.storage.local` (client-side). Use a dedicated key/project and rotate if needed.
- It won't work on restricted pages like `chrome://`.
- Inline translation skips code-like text, links, filenames, commands, and page
  chrome. It translates visible article text in small batches while active.
- Inline translation uses structured JSON output and records recent run
  diagnostics in Options without storing source text, translations, or API keys.
