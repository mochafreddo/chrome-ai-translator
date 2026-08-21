// What a Side Panel Translation Placeholder Token entry is, in the two places that spell it.
//
// An entry is the record behind one Placeholder Token: the link, the code span, or the
// code-shaped link the token stands in for, together with the token itself. Two of this
// codec's three parts need to write one back out as Markdown, and they need to write it the
// same way. `extension/markdown-document.js` renders each entry as it takes it out of the
// page, to build the block's untranslated Markdown; `extension/markdown-rehydration.js`
// renders the same entry again once the translation comes back, to put the span where the
// model left the token. A difference between those two renderings would show as a page whose
// untranslated and translated Markdown disagree about a link or a fence, which nothing else
// in the extension would report, so the rendering lives here rather than twice.
//
// Reading the entries off a Translation Chunk is here for the same reason, one seam over:
// `extension/translation-chunks.js` puts them on a chunk and `markdown-rehydration.js` takes
// them off, and neither should have to load the other to agree on where they sit.
//
// This is not the Placeholder Token contract — that is `extension/placeholder-tokens.js`,
// which both translations share and which decides the four failures. This module is only
// Side Panel Translation's Markdown spelling of what a token stands for.
(function exposeMarkdownEntries(globalScope) {
  'use strict';

  function longestBacktickRun(value) {
    return (String(value || '').match(/`+/g) || []).reduce(
      (max, run) => Math.max(max, run.length),
      0
    );
  }

  function renderCode(entry) {
    const fence = '`'.repeat(Math.max(3, longestBacktickRun(entry.value) + 1));
    if (entry.display === 'block') {
      return `${fence}${entry.language || ''}\n${entry.value}\n${fence}`;
    }
    const padding = entry.value.includes('`') ? ' ' : '';
    return `${fence}${padding}${entry.value}${padding}${fence}`;
  }

  function renderDestination(value) {
    return `<${String(value || '').replace(/\\/g, '\\\\').replace(/>/g, '\\>')}>`;
  }

  function escapeMarkdownLinkLabel(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  }

  // Two shapes, because a chunk on its way out carries its entries under `contract` and the
  // callers that build one by hand pass them at the top level.
  function getChunkEntries(chunk) {
    const candidates = chunk?.entries || chunk?.contract?.entries || [];
    return Array.from(candidates).filter(
      (entry) => entry && typeof entry === 'object'
    );
  }

  const api = {
    escapeMarkdownLinkLabel,
    getChunkEntries,
    renderCode,
    renderDestination,
  };
  globalScope.ChromeAiTranslatorMarkdownEntries = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
