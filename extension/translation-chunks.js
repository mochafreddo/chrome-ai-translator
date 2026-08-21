// Cutting a Markdown document model into Translation Chunks, and halving one for recovery.
//
// A Translation Chunk is as much of the article's Markdown as one request may carry, cut at
// block boundaries so no block is split across two. Where a single block is over the limit on
// its own it is cut further, at a sentence boundary if one is available and a whitespace
// boundary if not, and never inside a Placeholder Token or between the two halves of a pair —
// a chunk that carried half a link would fail its own check on the way back. A block that
// cannot be cut anywhere safe ends the translation rather than being sent oversized.
//
// Recovery is the same cutting run again at half the limit, once per chunk (ADR-0005). It is
// here rather than beside the failure it answers because what recovery does is chunk again.
//
// Only the worker calls this. The page builds the document model and stops there.
(function exposeTranslationChunks(globalScope) {
  'use strict';

  // Where the entries a chunk carries are read from, shared with the rehydrating half so the
  // two agree on the shape. In the worker it is already loaded — background.js imports it
  // ahead of this file — and under a CommonJS loader it comes in by require.
  const markdownEntries =
    globalScope?.ChromeAiTranslatorMarkdownEntries ||
    (typeof module !== 'undefined' && module.exports
      ? require('./markdown-entries.js')
      : null);

  const sentenceBoundary = /(?<=[.!?。！？])\s+/u;
  const whitespaceBoundary = /\s+/u;

  function createChunkingError(code, message = code) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function normalizeChunkLimit(maxChars) {
    const limit = Math.floor(Number(maxChars));
    if (!Number.isFinite(limit) || limit < 1) {
      throw new TypeError('maxChars must be a positive finite number');
    }
    return limit;
  }

  function getEntryTokens(entry) {
    return [entry?.token, entry?.openToken, entry?.closeToken].filter(Boolean);
  }

  function getAtomicSpans(template, entries) {
    const spans = [];
    for (const entry of entries) {
      if (entry.kind === 'link') {
        const start = template.indexOf(entry.openToken);
        const close = template.indexOf(entry.closeToken, start + entry.openToken.length);
        if (start >= 0 && close >= 0) {
          spans.push({ start, end: close + entry.closeToken.length });
        }
      } else if (entry.kind === 'code') {
        const start = template.indexOf(entry.token);
        if (start >= 0) spans.push({ start, end: start + entry.token.length });
      }
    }
    return spans.sort((left, right) => left.start - right.start);
  }

  function overlapsAtomicSpan(start, end, atomicSpans) {
    return atomicSpans.some(
      (span) => start < span.end && end > span.start
    );
  }

  function findLastSafeBoundary(
    template,
    start,
    limitEnd,
    boundary,
    atomicSpans
  ) {
    const expression = new RegExp(boundary.source, 'gu');
    expression.lastIndex = start;
    let selected = null;
    for (let match = expression.exec(template); match; match = expression.exec(template)) {
      const boundaryStart = match.index;
      const boundaryEnd = boundaryStart + match[0].length;
      if (boundaryStart > limitEnd) break;
      if (
        boundaryStart > start &&
        boundaryStart <= limitEnd &&
        !overlapsAtomicSpan(boundaryStart, boundaryEnd, atomicSpans)
      ) {
        selected = { cut: boundaryStart, next: boundaryEnd };
      }
    }
    return selected;
  }

  function splitOversizedBlock(block, entries, maxChars) {
    const template = String(block?.template || '');
    if (template.length <= maxChars) return [block];
    const atomicSpans = getAtomicSpans(template, entries);
    const fragments = [];
    let start = 0;

    while (start < template.length) {
      while (/\s/u.test(template[start] || '')) start += 1;
      if (start >= template.length) break;
      if (template.length - start <= maxChars) {
        fragments.push(template.slice(start).trimEnd());
        break;
      }

      const limitEnd = start + maxChars;
      const boundary =
        findLastSafeBoundary(
          template,
          start,
          limitEnd,
          sentenceBoundary,
          atomicSpans
        ) ||
        findLastSafeBoundary(
          template,
          start,
          limitEnd,
          whitespaceBoundary,
          atomicSpans
        );
      if (!boundary) {
        createChunkingError(
          'markdown.segment_too_large',
          'A Markdown segment is too large to split safely.'
        );
      }
      const fragment = template.slice(start, boundary.cut).trimEnd();
      if (!fragment || fragment.length > maxChars) {
        createChunkingError(
          'markdown.segment_too_large',
          'A Markdown segment is too large to split safely.'
        );
      }
      fragments.push(fragment);
      start = boundary.next;
    }

    return fragments.map((templateFragment, index) => {
      const fragmentEntryIds = entries
        .filter((entry) =>
          getEntryTokens(entry).some((token) => templateFragment.includes(token))
        )
        .map((entry) => entry.id);
      const { originalMarkdown: _originalMarkdown, ...blockShape } = block;
      return {
        ...blockShape,
        id: `${block.id || 'block'}-fragment-${index + 1}`,
        template: templateFragment,
        entries: fragmentEntryIds,
      };
    });
  }

  function createChunksFromBlocks(blocks, namespace, entries, maxChars) {
    const limit = normalizeChunkLimit(maxChars);
    const entryById = new Map(entries.map((entry) => [entry.id, entry]));
    const prepared = [];
    for (const block of blocks) {
      const blockEntries = Array.from(block?.entries || [], (id) => entryById.get(id))
        .filter(Boolean);
      prepared.push(...splitOversizedBlock(block, blockEntries, limit));
    }

    const grouped = [];
    let current = [];
    for (const block of prepared) {
      const candidate = [...current, block]
        .map((item) => String(item.template || ''))
        .join('\n\n');
      if (current.length && candidate.length > limit) {
        grouped.push(current);
        current = [block];
      } else {
        current.push(block);
      }
    }
    if (current.length) grouped.push(current);

    return grouped.map((chunkBlocks, index) => {
      const template = chunkBlocks
        .map((block) => String(block.template || ''))
        .join('\n\n');
      if (template.length > limit) {
        createChunkingError(
          'markdown.segment_too_large',
          'A Markdown chunk exceeds its character limit.'
        );
      }
      const referencedIds = new Set(
        chunkBlocks.flatMap((block) => Array.from(block?.entries || []))
      );
      const chunkEntries = entries.filter((entry) => referencedIds.has(entry.id));
      for (const entry of chunkEntries) {
        if (!getEntryTokens(entry).every((token) => template.includes(token))) {
          createChunkingError(
            'markdown.segment_too_large',
            'A protected Markdown span cannot be split safely.'
          );
        }
      }
      return {
        id: `${namespace || 'markdown'}:chunk:${index + 1}`,
        template,
        blocks: chunkBlocks,
        contract: { namespace: String(namespace || ''), entries: chunkEntries },
        maxChars: limit,
      };
    });
  }

  function createTranslationChunks(documentModel, maxChars) {
    return createChunksFromBlocks(
      Array.from(documentModel?.blocks || []),
      documentModel?.namespace,
      Array.from(documentModel?.entries || []),
      maxChars
    );
  }

  function splitChunkForRecovery(chunk) {
    if ((Number(chunk?.recoveryDepth) || 0) >= 1) {
      createChunkingError(
        'response.recovery_exhausted',
        'Translation recovery was already used.'
      );
    }
    const childLimit = Math.max(
      1,
      Math.floor(normalizeChunkLimit(chunk?.maxChars) / 2)
    );
    let children;
    try {
      children = createChunksFromBlocks(
        Array.from(chunk?.blocks || []),
        chunk?.contract?.namespace,
        markdownEntries.getChunkEntries(chunk),
        childLimit
      );
    } catch (error) {
      if (error?.code !== 'markdown.segment_too_large') throw error;
      createChunkingError(
        'response.recovery_unavailable',
        'Translation recovery could not produce smaller chunks.'
      );
    }
    if (children.length < 2) {
      createChunkingError(
        'response.recovery_unavailable',
        'Translation recovery could not produce smaller chunks.'
      );
    }
    return children.map((child) => ({ ...child, recoveryDepth: 1 }));
  }

  const api = {
    createTranslationChunks,
    splitChunkForRecovery,
  };
  globalScope.ChromeAiTranslatorTranslationChunks = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
