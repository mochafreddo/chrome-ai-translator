# chrome-ai-translator (personal)

A **personal-only** Chrome extension that extracts an article body, sends it to OpenAI Responses API, and shows the translated Markdown in a **Side Panel**.

## Load the extension
1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select: `chrome-ai-translator/extension`

## Setup
1. Open extension **Options**
2. Paste your **OpenAI API Key**
3. (Optional) change model / target language

## Use
- Click the extension toolbar icon, or press:
  - macOS: `Cmd+Shift+Y`
  - Windows/Linux: `Ctrl+Shift+Y`

The Side Panel should open and show the translation.

## Notes
- This stores your API key in `chrome.storage.local` (client-side). Use a dedicated key/project and rotate if needed.
- It won't work on restricted pages like `chrome://`.
