// content.js

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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'EXTRACT_ARTICLE') return;

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

  return true;
});
