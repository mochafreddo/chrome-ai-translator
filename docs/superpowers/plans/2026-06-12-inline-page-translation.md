# Inline Page Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separate inline translation mode that replaces article text nodes in the current page with Korean translations and can restore the original text.

**Architecture:** Keep side panel Markdown translation intact. Put DOM scanning, floating menu, state, and text replacement in `extension/content.js`; put OpenAI JSON batch translation and response validation in `extension/background.js`; expose an `inlineAutoShow` option in `extension/options.*`, optional host permissions in `extension/manifest.json`, and dynamic content-script registration from `extension/background.js`.

**Tech Stack:** Chrome Manifest V3 extension, content scripts, service worker, `chrome.storage.local`, OpenAI Responses API, plain JavaScript, Node syntax checks.

---

## File Structure

- Modify `extension/content.js`
  - Preserve existing article extraction and Markdown conversion.
  - Add inline translation helpers for text-node selection, code-like filtering, floating UI, API messaging, and original-text restoration.
  - Add a test export block gated by CommonJS so Node can verify pure helper functions.
- Modify `extension/background.js`
  - Preserve existing side panel translation.
  - Add settings default `inlineAutoShow`.
  - Add JSON translation prompt, chunking for text records, JSON response parsing, ID validation, and `TRANSLATE_TEXT_NODES` message handling.
  - Add `SHOW_INLINE_TRANSLATOR` message handling from toolbar/command invocation.
  - Add a test export block gated by CommonJS for pure helper functions.
- Modify `extension/options.html`
  - Add a checkbox for automatic inline button display.
- Modify `extension/options.js`
  - Load/save `inlineAutoShow`.
- Modify `extension/manifest.json`
  - Add `optional_host_permissions` for `http://*/*` and `https://*/*`; do not add static broad `content_scripts`.
- Create `tests/content-helpers.test.js`
  - Unit-style Node checks for code-like text detection, excluded tags, and text eligibility.
- Create `tests/background-helpers.test.js`
  - Unit-style Node checks for text-record chunking and response validation.
- Create `tests/run.js`
  - Minimal Node test runner that loads both test files.
- Create or update `package.json`
  - Add `npm test` and `npm run check:syntax`.

---

### Task 1: Add Minimal Test Harness

**Files:**
- Create: `package.json`
- Create: `tests/run.js`
- Create: `tests/content-helpers.test.js`
- Create: `tests/background-helpers.test.js`

- [ ] **Step 1: Add npm scripts**

Create `package.json`:

```json
{
  "private": true,
  "scripts": {
    "test": "node tests/run.js",
    "check:syntax": "node --check extension/content.js && node --check extension/background.js && node --check extension/options.js && node --check extension/sidepanel.js"
  }
}
```

- [ ] **Step 2: Add the test runner**

Create `tests/run.js`:

```js
const suites = [
  require('./content-helpers.test'),
  require('./background-helpers.test'),
];

let failures = 0;

for (const suite of suites) {
  for (const test of suite.tests) {
    try {
      test.fn();
      console.log(`PASS ${suite.name} - ${test.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL ${suite.name} - ${test.name}`);
      console.error(error?.stack || error);
    }
  }
}

if (failures > 0) {
  process.exitCode = 1;
}
```

- [ ] **Step 3: Add failing content helper tests**

Create `tests/content-helpers.test.js`:

```js
const assert = require('node:assert/strict');
const helpers = require('../extension/content.js');

exports.name = 'content helpers';
exports.tests = [
  {
    name: 'detects excluded inline code tags',
    fn() {
      assert.equal(helpers.isInlineTranslationExcludedTag('CODE'), true);
      assert.equal(helpers.isInlineTranslationExcludedTag('p'), false);
    },
  },
  {
    name: 'detects code-like text conservatively',
    fn() {
      assert.equal(helpers.isCodeLikeInlineText('npm run build'), true);
      assert.equal(helpers.isCodeLikeInlineText('README.md'), true);
      assert.equal(helpers.isCodeLikeInlineText('https://example.com'), true);
      assert.equal(
        helpers.isCodeLikeInlineText('This article explains browser translation.'),
        false
      );
    },
  },
  {
    name: 'accepts readable article text',
    fn() {
      assert.equal(
        helpers.isTranslatableInlineText(
          'OpenAI provides tools for building language applications.'
        ),
        true
      );
      assert.equal(helpers.isTranslatableInlineText('API'), false);
      assert.equal(helpers.isTranslatableInlineText('  '), false);
    },
  },
];
```

- [ ] **Step 4: Add failing background helper tests**

Create `tests/background-helpers.test.js`:

```js
const assert = require('node:assert/strict');
const helpers = require('../extension/background.js');

exports.name = 'background helpers';
exports.tests = [
  {
    name: 'splits text records without losing IDs',
    fn() {
      const chunks = helpers.splitTextRecordsIntoChunks(
        [
          { id: 'n1', text: 'alpha beta gamma' },
          { id: 'n2', text: 'delta epsilon zeta' },
          { id: 'n3', text: 'eta theta iota' },
        ],
        30
      );

      assert.deepEqual(
        chunks.flat().map((record) => record.id),
        ['n1', 'n2', 'n3']
      );
      assert.equal(chunks.length > 1, true);
    },
  },
  {
    name: 'validates exact JSON translation IDs',
    fn() {
      const records = [
        { id: 'n1', text: 'Hello world.' },
        { id: 'n2', text: 'Read the article.' },
      ];
      const parsed = helpers.parseAndValidateTextNodeTranslations(
        JSON.stringify({
          translations: [
            { id: 'n1', translation: '안녕하세요.' },
            { id: 'n2', translation: '글을 읽으세요.' },
          ],
        }),
        records
      );

      assert.deepEqual(parsed, [
        { id: 'n1', translation: '안녕하세요.' },
        { id: 'n2', translation: '글을 읽으세요.' },
      ]);
    },
  },
  {
    name: 'rejects unexpected JSON translation IDs',
    fn() {
      assert.throws(
        () =>
          helpers.parseAndValidateTextNodeTranslations(
            JSON.stringify({
              translations: [{ id: 'other', translation: '잘못됨' }],
            }),
            [{ id: 'n1', text: 'Hello.' }]
          ),
        /Unexpected translation id/
      );
    },
  },
];
```

- [ ] **Step 5: Run tests and verify they fail**

Run:

```bash
npm test
```

Expected: fails because `content.js` and `background.js` do not export the helper functions yet.

---

### Task 2: Implement Content Script Inline Translator

**Files:**
- Modify: `extension/content.js`
- Test: `tests/content-helpers.test.js`

- [ ] **Step 1: Add content helper exports and pure filters**

At the top-level of `extension/content.js`, add these helpers without removing existing Markdown extraction:

```js
const INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
const INLINE_EXCLUDED_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'SVG',
  'CANVAS',
  'IFRAME',
  'PRE',
  'CODE',
  'KBD',
  'SAMP',
]);

function isInlineTranslationExcludedTag(tagName) {
  return INLINE_EXCLUDED_TAGS.has(String(tagName || '').toUpperCase());
}

function isCodeLikeInlineText(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/^https?:\/\//i.test(value)) return true;
  if (/^[\w./-]+\.(md|js|ts|tsx|jsx|json|ya?ml|css|html|py|rb|go|rs|java|kt|swift|sh)$/i.test(value)) return true;
  if (/^--?[a-z0-9][a-z0-9-]*(=.*)?$/i.test(value)) return true;
  if (/^(npm|pnpm|yarn|node|git|gh|curl|cd|ls|cat|grep|rg|mkdir|rm|cp|mv)\b/.test(value)) return true;
  if (/^[A-Z0-9_./-]{1,24}$/.test(value)) return true;
  if (/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*){1,}$/.test(value)) return true;
  return false;
}

function isTranslatableInlineText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 4) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (isCodeLikeInlineText(value)) return false;
  return true;
}
```

- [ ] **Step 2: Add DOM eligibility and node collection**

Add:

```js
function isElementHidden(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.opacity === '0' ||
    el.hidden ||
    el.getAttribute('aria-hidden') === 'true'
  );
}

function shouldSkipInlineTextNode(textNode) {
  const parent = textNode.parentElement;
  if (!parent) return true;
  if (parent.closest(`#${INLINE_TRANSLATOR_ID}`)) return true;
  for (let el = parent; el; el = el.parentElement) {
    if (isInlineTranslationExcludedTag(el.tagName)) return true;
    if (isElementHidden(el)) return true;
  }
  return !isTranslatableInlineText(textNode.nodeValue);
}

function collectInlineTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return shouldSkipInlineTextNode(node)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT;
    },
  });
  const records = [];
  let index = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    records.push({
      id: `n${index + 1}`,
      node,
      text: node.nodeValue,
    });
    index += 1;
  }
  return records;
}
```

- [ ] **Step 3: Add floating UI and state**

Add:

```js
const inlineState = {
  status: 'original',
  records: [],
  menuOpen: false,
  message: '',
};

function setInlineMessage(message) {
  inlineState.message = message || '';
  updateInlineTranslatorUi();
}

function ensureInlineTranslatorUi() {
  let host = document.getElementById(INLINE_TRANSLATOR_ID);
  if (host) return host;

  host = document.createElement('div');
  host.id = INLINE_TRANSLATOR_ID;
  host.innerHTML = `
    <button type="button" data-role="toggle">Translate</button>
    <div data-role="menu" hidden>
      <button type="button" data-action="translate">Page in Korean</button>
      <button type="button" data-action="restore">Original text</button>
      <div data-role="message"></div>
    </div>
  `;
  document.documentElement.appendChild(host);

  const style = document.createElement('style');
  style.textContent = `
    #${INLINE_TRANSLATOR_ID} {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483647;
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #111827;
    }
    #${INLINE_TRANSLATOR_ID} button {
      border: 1px solid #d1d5db;
      border-radius: 6px;
      background: #fff;
      color: #111827;
      cursor: pointer;
      padding: 7px 10px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.16);
    }
    #${INLINE_TRANSLATOR_ID} [data-role="menu"] {
      display: grid;
      gap: 6px;
      margin-bottom: 8px;
      padding: 8px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      background: #fff;
      box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
    }
    #${INLINE_TRANSLATOR_ID} [data-role="message"] {
      max-width: 220px;
      color: #b91c1c;
      font-size: 12px;
    }
  `;
  host.appendChild(style);

  host.querySelector('[data-role="toggle"]').addEventListener('click', () => {
    inlineState.menuOpen = !inlineState.menuOpen;
    updateInlineTranslatorUi();
  });
  host.querySelector('[data-action="translate"]').addEventListener('click', () => {
    translateInlinePage().catch((error) => setInlineMessage(error?.message || String(error)));
  });
  host.querySelector('[data-action="restore"]').addEventListener('click', restoreInlineOriginal);

  updateInlineTranslatorUi();
  return host;
}

function updateInlineTranslatorUi() {
  const host = document.getElementById(INLINE_TRANSLATOR_ID);
  if (!host) return;
  const toggle = host.querySelector('[data-role="toggle"]');
  const menu = host.querySelector('[data-role="menu"]');
  const message = host.querySelector('[data-role="message"]');
  toggle.textContent =
    inlineState.status === 'translating'
      ? 'Translating...'
      : inlineState.status === 'translated'
      ? 'Translated'
      : 'Translate';
  menu.hidden = !inlineState.menuOpen;
  message.textContent = inlineState.message;
}
```

- [ ] **Step 4: Add translate and restore actions**

Add:

```js
async function translateInlinePage() {
  if (inlineState.status === 'translating') return;
  if (inlineState.status === 'translated') {
    setInlineMessage('');
    return;
  }

  const root = pickArticleRoot();
  if (!root) throw new Error('No article content found.');

  const records = collectInlineTextNodes(root);
  if (!records.length) throw new Error('No translatable article text found.');

  inlineState.status = 'translating';
  inlineState.records = records.map((record) => ({
    id: record.id,
    node: record.node,
    original: record.text,
    translation: null,
  }));
  setInlineMessage('');
  updateInlineTranslatorUi();

  const resp = await chrome.runtime.sendMessage({
    type: 'TRANSLATE_TEXT_NODES',
    records: records.map(({ id, text }) => ({ id, text })),
  });
  if (!resp?.ok) {
    inlineState.status = 'original';
    throw new Error(resp?.error?.message || 'Inline translation failed.');
  }

  const byId = new Map(resp.translations.map((item) => [item.id, item.translation]));
  for (const record of inlineState.records) {
    const translation = byId.get(record.id);
    if (typeof translation !== 'string') {
      inlineState.status = 'original';
      throw new Error('Inline translation response was incomplete.');
    }
    record.translation = translation;
  }

  for (const record of inlineState.records) {
    if (record.node?.isConnected) {
      record.node.nodeValue = record.translation;
    }
  }
  inlineState.status = 'translated';
  updateInlineTranslatorUi();
}

function restoreInlineOriginal() {
  for (const record of inlineState.records) {
    if (record.node?.isConnected) {
      record.node.nodeValue = record.original;
    }
  }
  inlineState.status = 'original';
  setInlineMessage('');
  updateInlineTranslatorUi();
}
```

- [ ] **Step 5: Add messages and auto-show**

Extend the existing message listener to handle:

```js
if (msg?.type === 'SHOW_INLINE_TRANSLATOR') {
  ensureInlineTranslatorUi();
  sendResponse({ ok: true });
  return true;
}
```

Add an initialization block:

```js
(async function initInlineTranslator() {
  try {
    const stored = await chrome.storage.local.get(['settings']);
    if (stored.settings?.inlineAutoShow) {
      ensureInlineTranslatorUi();
    }
  } catch {}
})();
```

Wrap Chrome-only listener registration and initialization in a guard so Node can
load pure helpers:

```js
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EXTRACT_ARTICLE') {
      // existing extraction branch
    }
    if (msg?.type === 'SHOW_INLINE_TRANSLATOR') {
      ensureInlineTranslatorUi();
      sendResponse({ ok: true });
      return true;
    }
  });

  initInlineTranslator();
}
```

- [ ] **Step 6: Export helpers for tests**

At the bottom of `extension/content.js`:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isInlineTranslationExcludedTag,
    isCodeLikeInlineText,
    isTranslatableInlineText,
  };
}
```

- [ ] **Step 7: Run content tests**

Run:

```bash
npm test
```

Expected: content helper tests pass, background helper tests still fail until Task 3.

---

### Task 3: Implement Background JSON Translation

**Files:**
- Modify: `extension/background.js`
- Test: `tests/background-helpers.test.js`

- [ ] **Step 1: Add settings default**

Add to `DEFAULT_SETTINGS`:

```js
inlineAutoShow: false,
```

- [ ] **Step 2: Add text-record chunking**

Add:

```js
function splitTextRecordsIntoChunks(records, maxChars) {
  const chunks = [];
  let current = [];
  let currentLen = 0;

  for (const record of records || []) {
    const size = String(record.id || '').length + String(record.text || '').length + 20;
    if (current.length && currentLen + size > maxChars) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(record);
    currentLen += size;
  }

  if (current.length) chunks.push(current);
  return chunks;
}
```

- [ ] **Step 3: Add JSON response parsing and validation**

Add:

```js
function parseAndValidateTextNodeTranslations(outputText, records) {
  let parsed;
  try {
    parsed = JSON.parse(outputText);
  } catch {
    throw new Error('Inline translation response was not valid JSON');
  }

  const translations = parsed?.translations;
  if (!Array.isArray(translations)) {
    throw new Error('Inline translation response did not include translations');
  }

  const expected = new Set(records.map((record) => record.id));
  const seen = new Set();
  const normalized = [];

  for (const item of translations) {
    const id = item?.id;
    if (!expected.has(id)) {
      throw new Error(`Unexpected translation id: ${id}`);
    }
    if (seen.has(id)) {
      throw new Error(`Duplicate translation id: ${id}`);
    }
    if (typeof item.translation !== 'string') {
      throw new Error(`Missing translation for id: ${id}`);
    }
    seen.add(id);
    normalized.push({ id, translation: item.translation });
  }

  for (const record of records) {
    if (!seen.has(record.id)) {
      throw new Error(`Missing translation id: ${record.id}`);
    }
  }

  return normalized;
}
```

- [ ] **Step 4: Add inline translation instructions**

Add:

```js
function buildTextNodeInstructions({ targetLanguage, tone }) {
  const toneMap = {
    technical: 'Use a clear, technical tone suitable for docs.',
    natural: 'Use natural, fluent tone.',
    formal: 'Use formal and polite tone.',
  };
  const toneLine = toneMap[tone] || toneMap.technical;

  return [
    `Translate each record's text into ${targetLanguage}.`,
    toneLine,
    'Return JSON only in this exact shape: {"translations":[{"id":"...","translation":"..."}]}.',
    'Preserve every id exactly.',
    'Do not translate code, commands, identifiers, URLs, filenames, product API names, or version strings.',
    'Do not add commentary or Markdown fences.',
  ].join('\n');
}
```

- [ ] **Step 5: Add translation coordinator**

Add:

```js
async function translateTextNodeRecords(records) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error('OpenAI API key is not set. Open Options and paste your key.');
  }

  const instructions = buildTextNodeInstructions(settings);
  const chunks = splitTextRecordsIntoChunks(records, settings.chunkMaxChars);
  const translated = [];

  for (const chunk of chunks) {
    const output = await openaiTranslateChunk({
      apiKey: settings.apiKey,
      model: settings.model,
      instructions,
      input: JSON.stringify({ records: chunk }),
    });
    translated.push(...parseAndValidateTextNodeTranslations(output, chunk));
  }

  return translated;
}
```

- [ ] **Step 6: Wire background messages and toolbar injection**

Add helper:

```js
async function showInlineTranslator(tabId) {
  await ensureContentScript(tabId);
  await chrome.tabs.sendMessage(tabId, { type: 'SHOW_INLINE_TRANSLATOR' });
}
```

After existing `translateTab(tab.id)` calls in toolbar and command handlers, call:

```js
try {
  await showInlineTranslator(tabId);
} catch {}
```

Add to runtime message handler:

```js
if (msg?.type === 'TRANSLATE_TEXT_NODES') {
  const translations = await translateTextNodeRecords(msg.records || []);
  sendResponse({ ok: true, translations });
  return;
}
```

Add automatic content-script registration helpers:

```js
const INLINE_CONTENT_SCRIPT_ID = 'inline-translator-auto-show';
const INLINE_ORIGINS = ['http://*/*', 'https://*/*'];

async function syncInlineAutoShowRegistration(settings = null) {
  const effective = settings || (await getSettings());
  try {
    await chrome.scripting.unregisterContentScripts({
      ids: [INLINE_CONTENT_SCRIPT_ID],
    });
  } catch {}

  if (!effective.inlineAutoShow) return;

  await chrome.scripting.registerContentScripts([
    {
      id: INLINE_CONTENT_SCRIPT_ID,
      matches: INLINE_ORIGINS,
      js: ['content.js'],
      runAt: 'document_idle',
    },
  ]);
}
```

Call `syncInlineAutoShowRegistration(settings)` from `onInstalled`, and call it
after `SAVE_SETTINGS` persists the merged settings.

Wrap Chrome-only listeners in a guard so Node can load pure helpers:

```js
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onInstalled.addListener(async () => {
    const settings = await getSettings();
    await saveSettings(settings);
    await syncInlineAutoShowRegistration(settings);
    try {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    } catch {}
  });

  // existing action, command, and runtime message listeners live inside this guard
}
```

- [ ] **Step 7: Export helpers for tests**

At the bottom of `extension/background.js`:

```js
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    splitTextRecordsIntoChunks,
    parseAndValidateTextNodeTranslations,
  };
}
```

- [ ] **Step 8: Run background tests**

Run:

```bash
npm test
```

Expected: all helper tests pass.

---

### Task 4: Add Options, Optional Permission, and Manifest Wiring

**Files:**
- Modify: `extension/options.html`
- Modify: `extension/options.js`
- Modify: `extension/manifest.json`

- [ ] **Step 1: Add option checkbox to HTML**

In `extension/options.html`, add this label inside the options form after the settings grid:

```html
      <label>
        <input id="inlineAutoShow" type="checkbox" />
        Show inline translation button automatically on normal web pages
      </label>
```

- [ ] **Step 2: Load/save option**

In `extension/options.js`, add:

```js
const elInlineAutoShow = document.getElementById('inlineAutoShow');
```

Set in `load()`:

```js
elInlineAutoShow.checked = Boolean(s.inlineAutoShow);
```

Save in `next`:

```js
inlineAutoShow: elInlineAutoShow.checked,
```

- [ ] **Step 3: Request optional origins only when auto-show is enabled**

In `save()`, before writing settings, request optional host permissions when the
checkbox is enabled:

```js
if (elInlineAutoShow.checked) {
  const granted = await chrome.permissions.request({
    origins: ['http://*/*', 'https://*/*'],
  });
  if (!granted) {
    elInlineAutoShow.checked = false;
    setError('Automatic inline button display needs website access permission.');
    setStatus('');
    return;
  }
}
```

If the checkbox is disabled, remove the optional origins:

```js
if (!elInlineAutoShow.checked) {
  await chrome.permissions.remove({
    origins: ['http://*/*', 'https://*/*'],
  });
}
```

- [ ] **Step 4: Add optional host permissions**

In `extension/manifest.json`, add:

```json
  "optional_host_permissions": ["http://*/*", "https://*/*"],
```

Keep existing `activeTab`, `scripting`, and `sidePanel` permissions unchanged.

- [ ] **Step 5: Run syntax checks**

Run:

```bash
npm run check:syntax
```

Expected: every JavaScript file reports no syntax errors.

---

### Task 5: Manual Verification Pass

**Files:**
- Read: `README.md`
- Run: no dev server needed

- [ ] **Step 1: Run automated checks**

Run:

```bash
npm test
npm run check:syntax
```

Expected: both commands exit 0.

- [ ] **Step 2: Inspect extension files**

Run:

```bash
git diff -- extension/content.js extension/background.js extension/options.html extension/options.js extension/manifest.json
```

Expected:

- Existing `EXTRACT_ARTICLE` flow still exists.
- Existing `TRANSLATE_TAB` flow still exists.
- New `TRANSLATE_TEXT_NODES` flow is separate.
- `inlineAutoShow` defaults false.
- Manifest adds only optional host permissions for automatic inline display and does not add static broad content scripts.

- [ ] **Step 3: Report browser manual checks**

Manual Chrome checks require loading the extension in `chrome://extensions` and using a real API key. If not run in-session, report them as not run:

- Existing side panel translation opens and translates.
- Floating button appears after toolbar/shortcut invocation.
- Floating menu translates article text in place.
- Original action restores text without an API call.
- Code and code-like text remain unchanged.
- Missing API key leaves page text unchanged.
