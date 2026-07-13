(function exposeFullPageMarkdown(globalScope) {
  'use strict';

  function getTagName(node) {
    return String(node?.tagName || '').toUpperCase();
  }

  function getChildNodes(node) {
    return Array.from(node?.childNodes || []);
  }

  const EXCLUDED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'CANVAS',
    'IFRAME',
    'NAV',
    'FOOTER',
    'FORM',
    'BUTTON',
    'INPUT',
    'TEXTAREA',
    'SELECT',
    'OPTION',
  ]);
  const EXCLUDED_ROLES = new Set([
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'form',
    'search',
    'button',
    'menu',
    'menubar',
    'tablist',
    'toolbar',
  ]);

  function hasAttribute(node, name) {
    return Boolean(node?.hasAttribute?.(name));
  }

  function getAttribute(node, name) {
    return String(node?.getAttribute?.(name) || '');
  }

  function isEffectivelyEditable(node) {
    if (node?.isContentEditable === true) return true;
    for (let current = node; current?.nodeType === 1; current = current.parentElement) {
      if (!hasAttribute(current, 'contenteditable')) continue;
      return getAttribute(current, 'contenteditable').toLowerCase() !== 'false';
    }
    return false;
  }

  function hasHiddenComputedStyle(node) {
    const view = node?.ownerDocument?.defaultView;
    if (typeof view?.getComputedStyle !== 'function') return false;
    try {
      const style = view.getComputedStyle(node);
      const display = String(style?.display || '').toLowerCase();
      const visibility = String(style?.visibility || '').toLowerCase();
      const contentVisibility = String(
        style?.contentVisibility ||
          style?.getPropertyValue?.('content-visibility') ||
          ''
      ).toLowerCase();
      return (
        display === 'none' ||
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        contentVisibility === 'hidden' ||
        Number.parseFloat(style?.opacity) === 0
      );
    } catch {
      return true;
    }
  }

  function isExcludedElement(node) {
    if (!node || node.nodeType !== 1) return false;
    if (EXCLUDED_TAGS.has(getTagName(node))) return true;
    if (node.hidden === true || hasAttribute(node, 'hidden')) return true;
    if (getAttribute(node, 'aria-hidden').toLowerCase() === 'true') return true;
    if (EXCLUDED_ROLES.has(getAttribute(node, 'role').toLowerCase())) return true;
    if (isEffectivelyEditable(node)) return true;
    if (
      hasAttribute(node, 'tabindex') &&
      Number(getAttribute(node, 'tabindex')) >= 0
    ) {
      return true;
    }
    if (hasAttribute(node, 'onclick')) return true;
    return hasHiddenComputedStyle(node);
  }

  function getVisibleText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return String(node.nodeValue || '');
    if (node.nodeType === 1 && isExcludedElement(node)) return '';
    return getChildNodes(node).map(getVisibleText).join('');
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
      return {
        template: value,
        original: options.escapeMarkdownLinkText
          ? escapeMarkdownLinkLabel(value)
          : value,
      };
    }

    if (isExcludedElement(node)) return { template: '', original: '' };
    const tagName = getTagName(node);
    if (options.skipLists && (tagName === 'OL' || tagName === 'UL')) {
      return { template: '', original: '' };
    }
    if (tagName === 'BR') return { template: ' ', original: ' ' };
    if (tagName === 'CODE' || tagName === 'KBD' || tagName === 'SAMP') {
      const entry = addCodeEntry(context, getVisibleText(node), 'inline', '');
      return { template: entry.token, original: renderCode(entry) };
    }
    if (tagName === 'A') {
      const destination = String(node.getAttribute?.('href') || '');
      const label = normalizeInlineText(getVisibleText(node));
      if (isProtectedAtomicLinkLabel(label)) {
        const entry = addCodeEntry(context, label, 'inline', '', destination);
        return {
          template: entry.token,
          original: `[${escapeMarkdownLinkLabel(label)}](${renderDestination(
            entry.destination
          )})`,
        };
      }
      const entry = addLinkEntry(context, destination);
      const labelResult = serializeInlineChildren(node, context, {
        ...options,
        escapeMarkdownLinkText: true,
      });
      return {
        template: `${entry.openToken}${labelResult.template}${entry.closeToken}`,
        original: `[${labelResult.original}](${renderDestination(
          entry.destination
        )})`,
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

  function appendBlock(context, kind, values, extra = {}, options = {}) {
    if (!values.template && !values.original) return null;
    const entryStart = Number(values.entryStart) || 0;
    const block = {
      ...(options.allocateId === false
        ? {}
        : { id: `m${(context.nextBlockId += 1)}` }),
      kind,
      template: values.template,
      originalMarkdown: values.original,
      entries: context.entries.slice(entryStart).map((entry) => entry.id),
      ...extra,
    };
    return block;
  }

  function serializeTextBlock(node, context, kind, prefix, extra, options) {
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
      extra,
      options
    );
  }

  function quoteMarkdown(value) {
    return String(value || '')
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n');
  }

  function isSupportedBlockTag(tagName) {
    return (
      tagName === 'P' ||
      tagName === 'BLOCKQUOTE' ||
      tagName === 'PRE' ||
      tagName === 'OL' ||
      tagName === 'UL' ||
      tagName === 'TABLE' ||
      /^H[1-6]$/.test(tagName)
    );
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
      if (!isSupportedBlockTag(tagName)) {
        const inline = serializeInline(child, context);
        pending.template += inline.template;
        pending.original += inline.original;
        continue;
      }

      flushPending();
      const childBlocks = serializeElementBlocks(child, context, {
        allocateId: false,
      });
      if (childBlocks.length) {
        sections.push({
          template: childBlocks.map((block) => block.template).join('\n'),
          original: childBlocks
            .map((block) => block.originalMarkdown)
            .join('\n'),
        });
      }
    }
    flushPending();
    return {
      template: sections.map((section) => section.template).join('\n\n'),
      original: sections.map((section) => section.original).join('\n\n'),
    };
  }

  function serializeBlockquote(node, context, options) {
    const entryStart = context.entries.length;
    const body = serializeBlockquoteBody(node, context);
    if (!body.template && !body.original) return null;
    return appendBlock(context, 'blockquote', {
      template: quoteMarkdown(body.template),
      original: quoteMarkdown(body.original),
      entryStart,
    }, {}, options);
  }

  function getDirectChildren(node, tagName) {
    return getChildNodes(node).filter((child) => getTagName(child) === tagName);
  }

  function serializeList(list, context, blocks, depth, options) {
    const ordered = getTagName(list) === 'OL';
    const items = getDirectChildren(list, 'LI');
    let ordinal = ordered
      ? Number.parseInt(getAttribute(list, 'start'), 10)
      : 1;
    if (!Number.isInteger(ordinal)) ordinal = 1;
    items.forEach((item) => {
      if (ordered && hasAttribute(item, 'value')) {
        const itemValue = Number.parseInt(getAttribute(item, 'value'), 10);
        if (Number.isInteger(itemValue)) ordinal = itemValue;
      }
      if (isExcludedElement(item)) {
        if (ordered) ordinal += 1;
        return;
      }
      const entryStart = context.entries.length;
      const inline = normalizeInlineResult(
        serializeInlineChildren(item, context, { skipLists: true })
      );
      const marker = ordered ? `${ordinal}. ` : '- ';
      const prefix = `${'    '.repeat(depth)}${marker}`;
      const block = appendBlock(
        context,
        ordered ? 'ordered-item' : 'unordered-item',
        {
          template: `${prefix}${inline.template}`,
          original: `${prefix}${inline.original}`,
          entryStart,
        },
        ordered ? { depth, ordinal } : { depth },
        options
      );
      if (block) blocks.push(block);
      if (ordered) ordinal += 1;
      for (const child of getChildNodes(item)) {
        const childTag = getTagName(child);
        if (childTag === 'OL' || childTag === 'UL') {
          serializeList(child, context, blocks, depth + 1, options);
        }
      }
    });
  }

  function collectTableRows(node, rows, rootTable) {
    for (const child of getChildNodes(node)) {
      if (isExcludedElement(child)) continue;
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

  function serializeTable(table, context, options) {
    const rows = [];
    collectTableRows(table, rows, table);
    if (!rows.length) return null;
    const entryStart = context.entries.length;
    const serializedRows = rows.map((row) =>
      getChildNodes(row)
        .filter(
          (cell) =>
            ['TH', 'TD'].includes(getTagName(cell)) &&
            !isExcludedElement(cell)
        )
        .map((cell) => normalizeInlineResult(serializeInlineChildren(cell, context)))
    ).filter((row) => row.length);
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
    return appendBlock(
      context,
      'table',
      {
        template: templateLines.join('\n'),
        original: originalLines.join('\n'),
        entryStart,
      },
      {},
      options
    );
  }

  function serializeCodeBlock(pre, context, options) {
    const code = getChildNodes(pre).find(
      (child) => getTagName(child) === 'CODE' && !isExcludedElement(child)
    );
    const source = getVisibleText(code || pre).replace(/\n+$/g, '');
    if (!source.trim()) return null;
    const entryStart = context.entries.length;
    const entry = addCodeEntry(
      context,
      source,
      'block',
      code ? detectCodeLanguage(code) : ''
    );
    return appendBlock(
      context,
      'code',
      {
        template: entry.token,
        original: renderCode(entry),
        entryStart,
      },
      {},
      options
    );
  }

  function serializeElementBlocks(element, context, options = {}) {
    if (isExcludedElement(element)) return [];
    const tagName = getTagName(element);
    if (/^H[1-6]$/.test(tagName)) {
      const level = Number(tagName.slice(1));
      const block = serializeTextBlock(
        element,
        context,
        'heading',
        `${'#'.repeat(level)} `,
        { level },
        options
      );
      return block ? [block] : [];
    }
    if (tagName === 'P') {
      const block = serializeTextBlock(
        element,
        context,
        'paragraph',
        '',
        {},
        options
      );
      return block ? [block] : [];
    }
    if (tagName === 'BLOCKQUOTE') {
      const block = serializeBlockquote(element, context, options);
      return block ? [block] : [];
    }
    if (tagName === 'PRE') {
      const block = serializeCodeBlock(element, context, options);
      return block ? [block] : [];
    }
    if (tagName === 'OL' || tagName === 'UL') {
      const blocks = [];
      serializeList(element, context, blocks, 0, options);
      return blocks;
    }
    if (tagName === 'TABLE') {
      const block = serializeTable(element, context, options);
      return block ? [block] : [];
    }
    return serializeChildBlocks(element, context, options);
  }

  function serializeChildBlocks(node, context, options) {
    const blocks = [];
    for (const child of getChildNodes(node)) {
      if (child.nodeType === 1) {
        blocks.push(...serializeElementBlocks(child, context, options));
      }
    }
    return blocks;
  }

  function serializeMarkdownDocument(root, metadata = {}, options = {}) {
    const namespace = createNamespace(root, options);
    const baseUrl = String(
      root?.ownerDocument?.baseURI || root?.baseURI || metadata.url || ''
    );
    const context = createSerializationContext(namespace, baseUrl);
    let blocks = isExcludedElement(root)
      ? []
      : serializeChildBlocks(root, context);
    const title = normalizeInlineText(metadata.title);
    if (title) {
      const equivalentTitle = (block) =>
        block?.kind === 'heading' &&
        block?.level === 1 &&
        normalizeInlineText(
          String(block.originalMarkdown || '').replace(/^#\s+/, '')
        ) === title;
      if (equivalentTitle(blocks[0])) {
        blocks = [
          blocks[0],
          ...blocks.slice(1).filter((block) => !equivalentTitle(block)),
        ];
      } else {
        blocks = blocks.filter((block) => !equivalentTitle(block));
        blocks.unshift({
          id: `m${(context.nextBlockId += 1)}`,
          kind: 'heading',
          level: 1,
          template: `# ${title}`,
          originalMarkdown: `# ${title}`,
          entries: [],
        });
      }
    }
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
    const activeNamespace = String(chunk?.contract?.namespace || '');
    if (
      activeNamespace &&
      withoutExpected.includes(`⟦${activeNamespace}:`)
    ) {
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
          ? `[${escapeMarkdownLinkLabel(entry.value)}](${renderDestination(
              entry.destination
            )})`
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
        getChunkEntries(chunk),
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
    renderOriginalMarkdown,
    serializeMarkdownDocument,
    splitChunkForRecovery,
    validateAndRehydrateChunk,
  };
  globalScope.ChromeAiTranslatorFullPageMarkdown = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
