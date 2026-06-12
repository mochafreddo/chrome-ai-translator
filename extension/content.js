// content.js

var INLINE_TRANSLATOR_ID = 'chrome-ai-translator-inline';
var INLINE_MAX_RECORDS = 500;
var INLINE_MAX_TOTAL_CHARS = 60000;
var INLINE_EXCLUDED_TAGS = new Set([
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
var inlineState = globalThis.__chromeAiTranslatorInlineState || {
  status: 'original',
  records: [],
  menuOpen: false,
  message: '',
};
globalThis.__chromeAiTranslatorInlineState = inlineState;

function isInlineTranslationExcludedTag(tagName) {
  return INLINE_EXCLUDED_TAGS.has(String(tagName || '').toUpperCase());
}

function isCodeLikeInlineText(text) {
  const value = String(text || '').trim();
  if (!value) return true;
  if (/^https?:\/\//i.test(value)) return true;
  if (
    /^[\w./-]+\.(md|js|ts|tsx|jsx|json|ya?ml|css|html|py|rb|go|rs|java|kt|swift|sh)$/i.test(
      value
    )
  ) {
    return true;
  }
  if (/^--?[a-z0-9][a-z0-9-]*(=.*)?$/i.test(value)) return true;
  if (
    /^(npm|pnpm|yarn|node|git|gh|curl|cd|ls|cat|grep|rg|mkdir|rm|cp|mv)\b/.test(
      value
    )
  ) {
    return true;
  }
  if (/^[A-Z0-9_./-]{1,24}$/.test(value)) return true;
  if (/^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*){1,}$/.test(value)) {
    return true;
  }
  return false;
}

function isTranslatableInlineText(text) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 4) return false;
  if (!/[A-Za-z]/.test(value)) return false;
  if (isCodeLikeInlineText(value)) return false;
  return true;
}

function isTrustedInlineUiEvent(event) {
  return event?.isTrusted === true;
}

function resetInlineTranslationAfterFailure(state = inlineState) {
  state.status = 'original';
  state.records = [];
}

function getInlineTextRecordBudgetError(records) {
  if (records.length > INLINE_MAX_RECORDS) {
    return `Too many text nodes for inline translation (${records.length}/${INLINE_MAX_RECORDS})`;
  }

  const totalChars = records.reduce(
    (sum, record) => sum + String(record.text || '').length,
    0
  );
  if (totalChars > INLINE_MAX_TOTAL_CHARS) {
    return `Inline translation has too much text (${totalChars}/${INLINE_MAX_TOTAL_CHARS} characters)`;
  }

  return '';
}

function cleanupRoot(root) {
  const clone = root.cloneNode(true);

  // Remove noisy elements
  const selectors = [
    'script',
    'style',
    'noscript',
    'nav',
    'footer',
    'header',
    'aside',
    'form',
    'button',
    'input',
    'textarea',
    'select',
    'svg',
    'canvas',
  ];
  for (const sel of selectors) {
    clone.querySelectorAll(sel).forEach((n) => n.remove());
  }
  return clone;
}

function detectCodeLang(codeEl) {
  // Typical patterns: class="language-js" or "lang-js" etc.
  const cls =
    (codeEl.getAttribute('class') || '') +
    ' ' +
    (codeEl.parentElement?.getAttribute('class') || '');
  const m =
    cls.match(/language-([a-z0-9_-]+)/i) || cls.match(/lang-([a-z0-9_-]+)/i);
  return m ? m[1] : '';
}

function pickArticleRoot() {
  const candidates = [
    document.querySelector('article'),
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.body,
  ].filter(Boolean);

  // Choose the candidate with the most text, but prefer article/main
  let best = candidates[0];
  let bestLen = (best?.innerText || '').trim().length;
  for (const el of candidates) {
    const len = (el.innerText || '').trim().length;
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }

  // If article exists and isn't tiny, use it even if not maximal.
  const article = document.querySelector('article');
  if (article && (article.innerText || '').trim().length > 400) return article;

  return best;
}

function toMarkdown(root) {
  const title = (document.title || '').trim();
  const url = location.href;
  const langHint = document.documentElement?.lang || '';

  const clean = cleanupRoot(root);

  // Walk in DOM order and capture a subset of block-level elements
  const walker = document.createTreeWalker(clean, NodeFilter.SHOW_ELEMENT);

  const out = [];

  function pushPara(text) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }

  // Title (always include once)
  if (title) out.push(`# ${title}`);
  out.push('');

  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (!(el instanceof HTMLElement)) continue;

    const tag = el.tagName.toLowerCase();

    // Avoid common duplicates. Example: <li><p>Text</p></li>
    // We emit the <li> and skip nested <p>.
    if (tag === 'p' && el.closest('li')) {
      continue;
    }

    // Skip nested list-items (rare, but can cause repeats)
    if (tag === 'li') {
      const parentLi = el.parentElement?.closest?.('li');
      if (parentLi && parentLi !== el) continue;
    }

    // Headings
    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      const text = el.innerText?.trim();
      if (text) out.push(`${'#'.repeat(Math.min(level + 1, 6))} ${text}`);
      out.push('');
      continue;
    }

    // Code blocks
    if (tag === 'pre') {
      const code = el.querySelector('code');
      const codeText = (code ? code.textContent : el.textContent) || '';
      const trimmed = codeText.replace(/\n+$/g, '');
      if (trimmed.trim()) {
        const lang = code ? detectCodeLang(code) : '';
        out.push('```' + lang);
        out.push(trimmed);
        out.push('```');
        out.push('');
      }
      continue;
    }

    // Paragraphs
    if (tag === 'p') {
      const text = el.innerText;
      pushPara(text);
      out.push('');
      continue;
    }

    // List items (simple)
    if (tag === 'li') {
      const text = el.innerText;
      const t = (text || '').replace(/\s+/g, ' ').trim();
      if (t) out.push(`- ${t}`);
      continue;
    }
  }

  // Collapse multiple blank lines
  const md =
    out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';

  return {
    title,
    url,
    langHint,
    contentMarkdown: md,
  };
}

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
  (document.body || document.documentElement).appendChild(host);

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
    #${INLINE_TRANSLATOR_ID} [hidden] {
      display: none !important;
    }
    #${INLINE_TRANSLATOR_ID} [data-role="message"] {
      max-width: 220px;
      color: #b91c1c;
      font-size: 12px;
    }
  `;
  host.appendChild(style);

  host.querySelector('[data-role="toggle"]').addEventListener('click', (event) => {
    if (!isTrustedInlineUiEvent(event)) return;
    inlineState.menuOpen = !inlineState.menuOpen;
    updateInlineTranslatorUi();
  });
  host
    .querySelector('[data-action="translate"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      translateInlinePage().catch((error) =>
        setInlineMessage(error?.message || String(error))
      );
    });
  host
    .querySelector('[data-action="restore"]')
    .addEventListener('click', (event) => {
      if (!isTrustedInlineUiEvent(event)) return;
      restoreInlineOriginal();
    });

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
  const budgetError = getInlineTextRecordBudgetError(records);
  if (budgetError) throw new Error(budgetError);

  inlineState.status = 'translating';
  inlineState.records = records.map((record) => ({
    id: record.id,
    node: record.node,
    original: record.text,
    translation: null,
  }));
  setInlineMessage('');
  updateInlineTranslatorUi();

  try {
    const resp = await chrome.runtime.sendMessage({
      type: 'TRANSLATE_TEXT_NODES',
      records: records.map(({ id, text }) => ({ id, text })),
    });
    if (!resp?.ok) {
      throw new Error(resp?.error?.message || 'Inline translation failed.');
    }
    if (!Array.isArray(resp.translations)) {
      throw new Error('Inline translation response was incomplete.');
    }

    const byId = new Map(
      resp.translations.map((item) => [item.id, item.translation])
    );
    for (const record of inlineState.records) {
      const translation = byId.get(record.id);
      if (typeof translation !== 'string') {
        throw new Error('Inline translation response was incomplete.');
      }
      record.translation = translation;
    }
  } catch (error) {
    resetInlineTranslationAfterFailure();
    updateInlineTranslatorUi();
    throw error;
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

async function initInlineTranslator() {
  try {
    const stored = await chrome.storage.local.get(['settings']);
    if (stored.settings?.inlineAutoShow) {
      ensureInlineTranslatorUi();
    }
  } catch {}
}

function handleExtractArticle(sendResponse) {
  try {
    const root = pickArticleRoot();
    const data = toMarkdown(root);

    // Basic sanity check: if too small, fall back to body
    if ((data.contentMarkdown || '').length < 300 && root !== document.body) {
      const data2 = toMarkdown(document.body);
      sendResponse({ ok: true, data: data2 });
      return;
    }

    sendResponse({ ok: true, data });
  } catch (e) {
    sendResponse({ ok: false, error: { message: e?.message || String(e) } });
  }
}

if (
  typeof chrome !== 'undefined' &&
  chrome.runtime?.onMessage &&
  !globalThis.__chromeAiTranslatorContentInitialized
) {
  globalThis.__chromeAiTranslatorContentInitialized = true;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'EXTRACT_ARTICLE') {
      handleExtractArticle(sendResponse);
      return true;
    }

    if (msg?.type === 'SHOW_INLINE_TRANSLATOR') {
      try {
        ensureInlineTranslatorUi();
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({
          ok: false,
          error: { message: e?.message || String(e) },
        });
      }
      return true;
    }
  });

  initInlineTranslator();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    isInlineTranslationExcludedTag,
    isCodeLikeInlineText,
    isTranslatableInlineText,
    isTrustedInlineUiEvent,
    resetInlineTranslationAfterFailure,
    getInlineTextRecordBudgetError,
  };
}
