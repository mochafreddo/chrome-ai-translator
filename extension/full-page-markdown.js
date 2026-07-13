(function exposeFullPageMarkdown(globalScope) {
  'use strict';

  function getTagName(node) {
    return String(node?.tagName || '').toUpperCase();
  }

  function getChildNodes(node) {
    return Array.from(node?.childNodes || []);
  }

  function normalizeInlineText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function isCodeLikeInlineText(text) {
    const value = normalizeInlineText(text);
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
    return /^[a-zA-Z_$][\w$]*(\.[a-zA-Z_$][\w$]*){1,}$/.test(value);
  }

  function isProtectedAtomicLinkLabel(label) {
    const value = normalizeInlineText(label);
    return Boolean(value && isCodeLikeInlineText(value));
  }

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

  function createNamespace(root, options) {
    if (options?.namespace != null) {
      const supplied = String(options.namespace);
      if (!supplied) throw new TypeError('namespace must not be empty');
      return supplied;
    }
    const randomUUID = globalScope?.crypto?.randomUUID;
    if (typeof randomUUID !== 'function') {
      throw new Error('crypto.randomUUID is unavailable');
    }
    const visibleSource = String(root?.textContent || '');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const namespace = `CAT_${randomUUID.call(globalScope.crypto)}`;
      if (!visibleSource.includes(namespace)) return namespace;
    }
    throw new Error('Unable to create a collision-free Markdown namespace');
  }

  function detectCodeLanguage(codeElement) {
    const classes = `${codeElement?.getAttribute?.('class') || ''} ${
      codeElement?.parentElement?.getAttribute?.('class') || ''
    }`;
    const match =
      classes.match(/language-([a-z0-9_-]+)/i) ||
      classes.match(/lang-([a-z0-9_-]+)/i);
    return match ? match[1] : '';
  }

  function resolveDestination(value, baseUrl) {
    const destination = String(value || '');
    if (!destination || !baseUrl) return destination;
    try {
      return new URL(destination, baseUrl).href;
    } catch {
      return destination;
    }
  }

  function createSerializationContext(namespace, baseUrl) {
    return {
      namespace,
      baseUrl,
      entries: [],
      nextLinkId: 0,
      nextCodeId: 0,
      nextBlockId: 0,
    };
  }

  function addLinkEntry(context, destination) {
    const id = `L${(context.nextLinkId += 1)}`;
    const entry = {
      id,
      kind: 'link',
      openToken: `⟦${context.namespace}:LINK_OPEN:${id}⟧`,
      closeToken: `⟦${context.namespace}:LINK_CLOSE:${id}⟧`,
      destination: resolveDestination(destination, context.baseUrl),
    };
    context.entries.push(entry);
    return entry;
  }

  function addCodeEntry(context, value, display, language, destination) {
    const id = `C${(context.nextCodeId += 1)}`;
    const entry = {
      id,
      kind: 'code',
      token: `⟦${context.namespace}:ATOM:${id}⟧`,
      display,
      value: String(value || ''),
      language: String(language || ''),
    };
    if (destination != null) {
      entry.destination = resolveDestination(destination, context.baseUrl);
    }
    context.entries.push(entry);
    return entry;
  }

  function serializeInline(node, context, options = {}) {
    if (!node) return { template: '', original: '' };
    if (node.nodeType === 3) {
      const value = String(node.nodeValue || '');
      return { template: value, original: value };
    }

    const tagName = getTagName(node);
    if (options.skipLists && (tagName === 'OL' || tagName === 'UL')) {
      return { template: '', original: '' };
    }
    if (tagName === 'BR') return { template: ' ', original: ' ' };
    if (tagName === 'CODE' || tagName === 'KBD' || tagName === 'SAMP') {
      const entry = addCodeEntry(context, node.textContent, 'inline', '');
      return { template: entry.token, original: renderCode(entry) };
    }
    if (tagName === 'A') {
      const destination = String(node.getAttribute?.('href') || '');
      const label = normalizeInlineText(node.textContent);
      if (isProtectedAtomicLinkLabel(label)) {
        const entry = addCodeEntry(context, label, 'inline', '', destination);
        return {
          template: entry.token,
          original: `[${label}](${renderDestination(destination)})`,
        };
      }
      const entry = addLinkEntry(context, destination);
      const labelResult = serializeInlineChildren(node, context, options);
      return {
        template: `${entry.openToken}${labelResult.template}${entry.closeToken}`,
        original: `[${labelResult.original}](${renderDestination(destination)})`,
      };
    }
    return serializeInlineChildren(node, context, options);
  }

  function serializeInlineChildren(node, context, options) {
    const result = { template: '', original: '' };
    for (const child of getChildNodes(node)) {
      const childResult = serializeInline(child, context, options);
      result.template += childResult.template;
      result.original += childResult.original;
    }
    return result;
  }

  function normalizeInlineResult(result) {
    return {
      template: normalizeInlineText(result.template),
      original: normalizeInlineText(result.original),
    };
  }

  function appendBlock(context, kind, values, extra = {}) {
    if (!values.template && !values.original) return null;
    const entryStart = Number(values.entryStart) || 0;
    const block = {
      id: `m${(context.nextBlockId += 1)}`,
      kind,
      template: values.template,
      originalMarkdown: values.original,
      entries: context.entries.slice(entryStart).map((entry) => entry.id),
      ...extra,
    };
    return block;
  }

  function serializeTextBlock(node, context, kind, prefix, extra) {
    const entryStart = context.entries.length;
    const inline = normalizeInlineResult(serializeInlineChildren(node, context));
    if (!inline.template) return null;
    return appendBlock(
      context,
      kind,
      {
        template: `${prefix}${inline.template}`,
        original: `${prefix}${inline.original}`,
        entryStart,
      },
      extra
    );
  }

  function quoteMarkdown(value) {
    return String(value || '')
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }

  function serializeBlockquoteBody(node, context) {
    const sections = [];
    let pending = { template: '', original: '' };

    function flushPending() {
      const normalized = normalizeInlineResult(pending);
      if (normalized.template || normalized.original) sections.push(normalized);
      pending = { template: '', original: '' };
    }

    for (const child of getChildNodes(node)) {
      const tagName = getTagName(child);
      const isBlockChild =
        tagName === 'P' ||
        tagName === 'BLOCKQUOTE' ||
        tagName === 'PRE' ||
        tagName === 'OL' ||
        tagName === 'UL' ||
        tagName === 'TABLE' ||
        /^H[1-6]$/.test(tagName);
      if (!isBlockChild) {
        const inline = serializeInline(child, context);
        pending.template += inline.template;
        pending.original += inline.original;
        continue;
      }

      flushPending();
      if (tagName === 'BLOCKQUOTE') {
        const nested = serializeBlockquoteBody(child, context);
        sections.push({
          template: quoteMarkdown(nested.template),
          original: quoteMarkdown(nested.original),
        });
      } else if (tagName === 'PRE') {
        const code = getChildNodes(child).find(
          (descendant) => getTagName(descendant) === 'CODE'
        );
        const source = String((code || child).textContent || '').replace(
          /\n+$/g,
          ''
        );
        if (source.trim()) {
          const entry = addCodeEntry(
            context,
            source,
            'block',
            code ? detectCodeLanguage(code) : ''
          );
          sections.push({ template: entry.token, original: renderCode(entry) });
        }
      } else {
        const inline = normalizeInlineResult(
          serializeInlineChildren(child, context)
        );
        if (/^H[1-6]$/.test(tagName)) {
          const prefix = `${'#'.repeat(Number(tagName.slice(1)))} `;
          inline.template = `${prefix}${inline.template}`;
          inline.original = `${prefix}${inline.original}`;
        }
        if (inline.template || inline.original) sections.push(inline);
      }
    }
    flushPending();
    return {
      template: sections.map((section) => section.template).join('\n\n'),
      original: sections.map((section) => section.original).join('\n\n'),
    };
  }

  function serializeBlockquote(node, context) {
    const entryStart = context.entries.length;
    const body = serializeBlockquoteBody(node, context);
    if (!body.template && !body.original) return null;
    return appendBlock(context, 'blockquote', {
      template: quoteMarkdown(body.template),
      original: quoteMarkdown(body.original),
      entryStart,
    });
  }

  function getDirectChildren(node, tagName) {
    return getChildNodes(node).filter((child) => getTagName(child) === tagName);
  }

  function serializeList(list, context, blocks, depth) {
    const ordered = getTagName(list) === 'OL';
    const items = getDirectChildren(list, 'LI');
    items.forEach((item, index) => {
      const entryStart = context.entries.length;
      const inline = normalizeInlineResult(
        serializeInlineChildren(item, context, { skipLists: true })
      );
      const marker = ordered ? `${index + 1}. ` : '- ';
      const prefix = `${'    '.repeat(depth)}${marker}`;
      const block = appendBlock(
        context,
        ordered ? 'ordered-item' : 'unordered-item',
        {
          template: `${prefix}${inline.template}`,
          original: `${prefix}${inline.original}`,
          entryStart,
        },
        ordered ? { depth, ordinal: index + 1 } : { depth }
      );
      if (block) blocks.push(block);
      for (const child of getChildNodes(item)) {
        const childTag = getTagName(child);
        if (childTag === 'OL' || childTag === 'UL') {
          serializeList(child, context, blocks, depth + 1);
        }
      }
    });
  }

  function collectTableRows(node, rows, rootTable) {
    for (const child of getChildNodes(node)) {
      const tagName = getTagName(child);
      if (tagName === 'TABLE' && child !== rootTable) continue;
      if (tagName === 'TR') {
        rows.push(child);
      } else {
        collectTableRows(child, rows, rootTable);
      }
    }
  }

  function escapeTableCell(value) {
    return String(value || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
  }

  function serializeTable(table, context) {
    const rows = [];
    collectTableRows(table, rows, table);
    if (!rows.length) return null;
    const entryStart = context.entries.length;
    const serializedRows = rows.map((row) =>
      getChildNodes(row)
        .filter((cell) => ['TH', 'TD'].includes(getTagName(cell)))
        .map((cell) => normalizeInlineResult(serializeInlineChildren(cell, context)))
    );
    const width = serializedRows.reduce(
      (maximum, row) => Math.max(maximum, row.length),
      0
    );
    if (!width) return null;

    function renderRow(row, key) {
      const cells = Array.from({ length: width }, (_, index) =>
        escapeTableCell(row[index]?.[key] || '')
      );
      return `| ${cells.join(' | ')} |`;
    }

    const templateLines = [renderRow(serializedRows[0], 'template')];
    const originalLines = [renderRow(serializedRows[0], 'original')];
    const separator = `| ${Array(width).fill('---').join(' | ')} |`;
    templateLines.push(separator);
    originalLines.push(separator);
    for (const row of serializedRows.slice(1)) {
      templateLines.push(renderRow(row, 'template'));
      originalLines.push(renderRow(row, 'original'));
    }
    return appendBlock(context, 'table', {
      template: templateLines.join('\n'),
      original: originalLines.join('\n'),
      entryStart,
    });
  }

  function serializeCodeBlock(pre, context) {
    const code = getChildNodes(pre).find((child) => getTagName(child) === 'CODE');
    const source = String((code || pre).textContent || '').replace(/\n+$/g, '');
    if (!source.trim()) return null;
    const entryStart = context.entries.length;
    const entry = addCodeEntry(
      context,
      source,
      'block',
      code ? detectCodeLanguage(code) : ''
    );
    return appendBlock(context, 'code', {
      template: entry.token,
      original: renderCode(entry),
      entryStart,
    });
  }

  function walkBlocks(node, context, blocks) {
    for (const child of getChildNodes(node)) {
      if (child.nodeType !== 1) continue;
      const tagName = getTagName(child);
      let block = null;
      if (/^H[1-6]$/.test(tagName)) {
        const level = Number(tagName.slice(1));
        block = serializeTextBlock(
          child,
          context,
          'heading',
          `${'#'.repeat(level)} `,
          { level }
        );
      } else if (tagName === 'P') {
        block = serializeTextBlock(child, context, 'paragraph', '');
      } else if (tagName === 'BLOCKQUOTE') {
        block = serializeBlockquote(child, context);
      } else if (tagName === 'PRE') {
        block = serializeCodeBlock(child, context);
      } else if (tagName === 'OL' || tagName === 'UL') {
        serializeList(child, context, blocks, 0);
        continue;
      } else if (tagName === 'TABLE') {
        block = serializeTable(child, context);
      } else {
        walkBlocks(child, context, blocks);
        continue;
      }
      if (block) blocks.push(block);
    }
  }

  function serializeMarkdownDocument(root, metadata = {}, options = {}) {
    const namespace = createNamespace(root, options);
    const baseUrl = String(
      metadata.url || root?.ownerDocument?.baseURI || root?.baseURI || ''
    );
    const context = createSerializationContext(namespace, baseUrl);
    const blocks = [];
    walkBlocks(root, context, blocks);
    return {
      title: String(metadata.title || ''),
      url: String(metadata.url || ''),
      langHint: String(metadata.langHint || ''),
      namespace,
      blocks,
      entries: context.entries,
    };
  }

  function renderOriginalMarkdown(documentModel) {
    return Array.from(documentModel?.blocks || [], (block) =>
      String(block?.originalMarkdown || '')
    )
      .filter(Boolean)
      .join('\n\n');
  }

  function createValidationError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  function getChunkEntries(chunk) {
    const candidates = chunk?.entries || chunk?.contract?.entries || [];
    return Array.from(candidates).filter(
      (entry) => entry && typeof entry === 'object'
    );
  }

  function getExpectedTokens(entries) {
    const tokens = [];
    for (const entry of entries) {
      if (entry.kind === 'link') {
        tokens.push({ value: entry.openToken, action: 'open', entry });
        tokens.push({ value: entry.closeToken, action: 'close', entry });
      } else if (entry.kind === 'code') {
        tokens.push({ value: entry.token, action: 'atom', entry });
      }
    }
    return tokens;
  }

  function countOccurrences(value, needle) {
    if (!needle) return 0;
    return String(value).split(needle).length - 1;
  }

  function escapeMarkdownLinkLabel(value) {
    return String(value || '')
      .replace(/\\/g, '\\\\')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
  }

  function escapeLinkWrapperContent(value, entry) {
    const openIndex = value.indexOf(entry.openToken);
    const contentStart = openIndex + entry.openToken.length;
    const closeIndex = value.indexOf(entry.closeToken, contentStart);
    return `${value.slice(0, contentStart)}${escapeMarkdownLinkLabel(
      value.slice(contentStart, closeIndex)
    )}${value.slice(closeIndex)}`;
  }

  function validateAndRehydrateChunk(output, chunk) {
    const value = String(output || '');
    const entries = getChunkEntries(chunk);
    const expectedTokens = getExpectedTokens(entries);
    let withoutExpected = value;
    for (const token of expectedTokens) {
      withoutExpected = withoutExpected.split(token.value).join('');
    }
    if (withoutExpected.includes('⟦') || withoutExpected.includes('⟧')) {
      throw createValidationError('markdown.token_unknown');
    }
    for (const token of expectedTokens) {
      const count = countOccurrences(value, token.value);
      if (count === 0) throw createValidationError('markdown.token_missing');
      if (count > 1) throw createValidationError('markdown.token_duplicate');
    }

    const positions = expectedTokens
      .map((token) => ({ ...token, index: value.indexOf(token.value) }))
      .sort((left, right) => left.index - right.index);
    const stack = [];
    for (const token of positions) {
      if (token.action === 'open') {
        stack.push(token.entry.id);
      } else if (token.action === 'close') {
        if (stack.pop() !== token.entry.id) {
          throw createValidationError('markdown.token_nesting_invalid');
        }
      }
    }
    if (stack.length) {
      throw createValidationError('markdown.token_nesting_invalid');
    }

    let result = value;
    for (const entry of entries) {
      if (entry.kind === 'link') {
        result = escapeLinkWrapperContent(result, entry);
      }
    }
    for (const entry of entries) {
      if (entry.kind === 'code') {
        const replacement = Object.prototype.hasOwnProperty.call(
          entry,
          'destination'
        )
          ? `[${entry.value}](${renderDestination(entry.destination)})`
          : renderCode(entry);
        result = result.split(entry.token).join(replacement);
      } else if (entry.kind === 'link') {
        result = result.split(entry.openToken).join('[');
        result = result
          .split(entry.closeToken)
          .join(`](${renderDestination(entry.destination)})`);
      }
    }
    return result;
  }

  function notImplementedUntilChunkingTask() {
    const error = new Error('Markdown chunking is not implemented');
    error.code = 'markdown.chunking_not_implemented';
    throw error;
  }

  const createTranslationChunks = notImplementedUntilChunkingTask;
  const splitChunkForRecovery = notImplementedUntilChunkingTask;
  const api = {
    createTranslationChunks,
    renderOriginalMarkdown,
    serializeMarkdownDocument,
    splitChunkForRecovery,
    validateAndRehydrateChunk,
  };
  globalScope.ChromeAiTranslatorFullPageMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
