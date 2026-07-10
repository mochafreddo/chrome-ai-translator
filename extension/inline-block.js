(function exposeInlineBlockCodec(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ChromeAiTranslatorInlineBlock = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createCodec() {
  'use strict';

  const CODEC_VERSION = 1;
  const SEMANTIC_BLOCK_TAGS = new Set([
    'P',
    'LI',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'FIGCAPTION',
    'DT',
    'DD',
    'TH',
    'TD',
  ]);
  const WRAPPER_TAGS = new Set([
    'STRONG',
    'B',
    'EM',
    'I',
    'U',
    'MARK',
    'SMALL',
    'SUB',
    'SUP',
    'ABBR',
    'CITE',
    'Q',
    'SPAN',
  ]);
  const ATOM_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'BR', 'WBR']);
  const OPAQUE_DESCENDANT_TAGS = new Set([
    'A',
    ...WRAPPER_TAGS,
    ...ATOM_TAGS,
  ]);
  const INTERACTIVE_TAGS = new Set([
    'BUTTON',
    'INPUT',
    'SELECT',
    'TEXTAREA',
    'OPTION',
    'FORM',
  ]);
  const EXCLUDED_ROLES = new Set([
    'button',
    'menu',
    'menubar',
    'tablist',
    'toolbar',
    'form',
  ]);
  const MAX_STRUCTURE_NODES = 4096;
  const MAX_STRUCTURE_DEPTH = 256;
  const MAX_FINGERPRINT_CHARS = 120000;

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

  function isProtectedAtomicLinkLabel(label) {
    const value = String(label || '').replace(/\s+/g, ' ').trim();
    if (!value) return false;
    if (isCodeLikeInlineText(value)) return true;

    const words = value.split(' ');
    if (
      value.length <= 80 &&
      words.length <= 4 &&
      /(?:[\p{L}]\d|\d[\p{L}]|[\p{L}\p{N}][._+/#-]\d|\d[._+/#-][\p{L}\p{N}])/u.test(
        value
      ) &&
      /^[\p{L}\p{N} ._+/#-]+$/u.test(value)
    ) {
      return true;
    }
    if (
      value.length <= 80 &&
      words.length <= 4 &&
      /^(API|SDK|CLI|IDE)$/.test(words[words.length - 1])
    ) {
      return true;
    }
    return (
      value.length <= 40 &&
      !value.includes(' ') &&
      /^[\p{L}\p{N}._+-]+$/u.test(value) &&
      /\p{Ll}\p{Lu}/u.test(value)
    );
  }

  function getTagName(node) {
    return String(node?.tagName || '').toUpperCase();
  }

  function isSemanticBlockElement(node) {
    return Boolean(
      node?.nodeType === 1 && SEMANTIC_BLOCK_TAGS.has(getTagName(node))
    );
  }

  function getChildNodes(node) {
    return Array.from(node?.childNodes || []);
  }

  function normalizeVisibleLabel(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function getTokenLikeLiterals(value) {
    const text = String(value || '');
    return [
      ...Array.from(text.matchAll(/⟦[^⟦⟧]*:[^⟦⟧]*⟧/g), (match) => match[0]),
      ...Array.from(
        text.matchAll(/⟦[^⟦⟧]*:[^⟦⟧]*(?=⟦|$)/g),
        (match) => match[0]
      ),
    ];
  }

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
    const getComputedStyle = node?.ownerDocument?.defaultView?.getComputedStyle;
    if (typeof getComputedStyle !== 'function') return false;
    try {
      const style = getComputedStyle.call(node.ownerDocument.defaultView, node);
      const display = String(style?.display || '').toLowerCase();
      const visibility = String(style?.visibility || '').toLowerCase();
      const contentVisibility = String(
        style?.contentVisibility ||
          style?.getPropertyValue?.('content-visibility') ||
          ''
      ).toLowerCase();
      const opacity = Number.parseFloat(style?.opacity);
      const overflow = [style?.overflow, style?.overflowX, style?.overflowY]
        .map((value) => String(value || '').toLowerCase())
        .join(' ');
      const clip = String(style?.clip || '').toLowerCase();
      const clipPath = String(
        style?.clipPath || style?.getPropertyValue?.('clip-path') || ''
      ).toLowerCase();
      const fontSize = Number.parseFloat(style?.fontSize);
      const rect = node?.getBoundingClientRect?.();
      const hasText = Boolean(normalizeVisibleLabel(node?.textContent));
      const clipsContent =
        (clip &&
          clip !== 'auto' &&
          !/^rect\(auto(?:,\s*auto){3}\)$/.test(clip)) ||
        (clipPath && clipPath !== 'none');
      const tinyClippedBox = Boolean(
        hasText &&
          rect &&
          /hidden|clip/.test(overflow) &&
          Number(rect.width) <= 1 &&
          Number(rect.height) <= 1
      );
      const view = node?.ownerDocument?.defaultView;
      const zeroArea = Boolean(
        hasText &&
          rect &&
          (Number(rect.width) <= 0 || Number(rect.height) <= 0)
      );
      const whollyOutsideViewport = Boolean(
        hasText &&
          rect &&
          Number(view?.innerWidth) > 0 &&
          Number(view?.innerHeight) > 0 &&
          (Number(rect.right) <= 0 ||
            Number(rect.bottom) <= 0 ||
            Number(rect.left) >= Number(view.innerWidth) ||
            Number(rect.top) >= Number(view.innerHeight))
      );
      return (
        display === 'none' ||
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        contentVisibility === 'hidden' ||
        opacity === 0 ||
        clipsContent ||
        tinyClippedBox ||
        zeroArea ||
        whollyOutsideViewport ||
        (hasText && fontSize === 0)
      );
    } catch {
      return true;
    }
  }

  function isUnsupportedElement(node) {
    const tagName = getTagName(node);
    if (!tagName || tagName.includes('-')) return true;
    if (INTERACTIVE_TAGS.has(tagName)) return true;
    if (node?.hidden || hasAttribute(node, 'hidden')) return true;
    if (getAttribute(node, 'aria-hidden').toLowerCase() === 'true') return true;
    if (hasHiddenComputedStyle(node)) return true;
    if (isEffectivelyEditable(node)) return true;
    if (
      hasAttribute(node, 'tabindex') &&
      Number(getAttribute(node, 'tabindex')) >= 0
    ) {
      return true;
    }
    if (hasAttribute(node, 'onclick')) return true;
    if (EXCLUDED_ROLES.has(getAttribute(node, 'role').toLowerCase())) {
      return true;
    }
    return false;
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function getStructureFingerprint(node) {
    if (!node) return '';
    const parts = [];
    const stack = [{ node, depth: 0, closing: false }];
    let scheduledNodes = 1;
    let outputChars = 0;

    function append(value) {
      const part = String(value);
      outputChars += part.length;
      if (outputChars > MAX_FINGERPRINT_CHARS) return false;
      parts.push(part);
      return true;
    }

    while (stack.length) {
      const item = stack.pop();
      if (item.closing) {
        if (!append(']')) return null;
        continue;
      }
      const current = item.node;
      if (current?.nodeType === 3) {
        if (!append(`T(${String(current.nodeValue || '')})`)) return null;
        continue;
      }
      if (current?.nodeType !== 1) {
        if (!append(`N${current?.nodeType || 0}`)) return null;
        continue;
      }
      if (item.depth > MAX_STRUCTURE_DEPTH) return null;
      if (!append(`${getTagName(current)}[`)) return null;
      const children = getChildNodes(current);
      scheduledNodes += children.length;
      if (scheduledNodes > MAX_STRUCTURE_NODES) return null;
      stack.push({ node: current, depth: item.depth, closing: true });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack.push({
          node: children[index],
          depth: item.depth + 1,
          closing: false,
        });
      }
    }
    return parts.join('');
  }

  function createTokenNamespace(block, fingerprint) {
    const visibleText = String(block?.textContent || '');
    const base = `CAT_${hashText(fingerprint)}`;
    let namespace = base;
    let suffix = 1;
    while (visibleText.includes(`⟦${namespace}:`)) {
      namespace = `${base}_${suffix}`;
      suffix += 1;
    }
    return namespace;
  }

  function createUnsupportedResult(errorCode = 'unsupported_block') {
    return { ok: false, errorCode };
  }

  function serializeBlock(block) {
    if (!block || block.nodeType !== 1) return createUnsupportedResult();
    if (
      !isSemanticBlockElement(block) ||
      isUnsupportedElement(block)
    ) {
      return createUnsupportedResult();
    }

    const sourceFingerprint = getStructureFingerprint(block);
    if (sourceFingerprint == null) return createUnsupportedResult();
    const namespace = createTokenNamespace(block, sourceFingerprint);
    const contractEntries = [];
    const snapshotEntries = new Map();
    const originalContainers = [];
    const originalTextValues = new Map();
    const atoms = [];
    const literalTokenCounts = new Map();
    let wrapperIndex = 0;
    let atomIndex = 0;
    let failed = null;

    function rememberContainer(node) {
      if (!originalContainers.some((item) => item.node === node)) {
        originalContainers.push({ node, children: getChildNodes(node) });
      }
    }

    function rememberLiteralTokens(value) {
      for (const token of getTokenLikeLiterals(value)) {
        literalTokenCounts.set(token, (literalTokenCounts.get(token) || 0) + 1);
      }
    }

    function rememberOpaqueSubtree(root) {
      const stack = [root];
      while (stack.length) {
        const current = stack.pop();
        if (current?.nodeType === 3) {
          originalTextValues.set(current, String(current.nodeValue || ''));
          continue;
        }
        if (
          current?.nodeType !== 1 ||
          isUnsupportedElement(current) ||
          (current !== root &&
            !OPAQUE_DESCENDANT_TAGS.has(getTagName(current)))
        ) {
          return false;
        }
        rememberContainer(current);
        const children = getChildNodes(current);
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack.push(children[index]);
        }
      }
      return true;
    }

    function visit(node, parentId) {
      if (failed) return '';
      if (node?.nodeType === 3) {
        const value = String(node.nodeValue || '');
        originalTextValues.set(node, value);
        rememberLiteralTokens(value);
        return value;
      }
      if (node?.nodeType !== 1 || isUnsupportedElement(node)) {
        failed = 'unsupported_block';
        return '';
      }

      const tagName = getTagName(node);
      if (isSemanticBlockElement(node)) {
        failed = 'unsupported_block';
        return '';
      }

      const protectedLink =
        tagName === 'A' && isProtectedAtomicLinkLabel(node.textContent);
      if (ATOM_TAGS.has(tagName) || protectedLink) {
        if (!rememberOpaqueSubtree(node)) {
          failed = 'unsupported_block';
          return '';
        }
        atomIndex += 1;
        const id = `A${atomIndex}`;
        const token = `⟦${namespace}:ATOM:${id}⟧`;
        const structural = tagName === 'BR' || tagName === 'WBR';
        const atomKind = protectedLink
          ? 'protected-link'
          : structural
            ? 'line-break'
            : tagName.toLowerCase();
        const entry = {
          id,
          kind: 'atom',
          tagName,
          parentId,
          token,
          atomKind,
          preserveText: !structural,
        };
        contractEntries.push(entry);
        snapshotEntries.set(id, { ...entry, node });
        const metadata = {
          token,
          kind: atomKind,
          preserveText: !structural,
        };
        if (!structural) metadata.label = normalizeVisibleLabel(node.textContent);
        atoms.push(metadata);
        return token;
      }

      const pairedWrapper = tagName === 'A' || WRAPPER_TAGS.has(tagName);
      if (!pairedWrapper) {
        failed = 'unsupported_block';
        return '';
      }

      wrapperIndex += 1;
      const id = `W${wrapperIndex}`;
      const openToken = `⟦${namespace}:OPEN:${id}⟧`;
      const closeToken = `⟦${namespace}:CLOSE:${id}⟧`;
      const entry = {
        id,
        kind: 'wrapper',
        tagName,
        parentId,
        openToken,
        closeToken,
      };
      contractEntries.push(entry);
      snapshotEntries.set(id, { ...entry, node });
      rememberContainer(node);
      const inner = getChildNodes(node)
        .map((child) => visit(child, id))
        .join('');
      return `${openToken}${inner}${closeToken}`;
    }

    rememberContainer(block);
    const template = getChildNodes(block)
      .map((child) => visit(child, 'ROOT'))
      .join('');
    if (failed) return createUnsupportedResult(failed);
    if (!template.trim()) return createUnsupportedResult();

    const contract = {
      codecVersion: CODEC_VERSION,
      namespace,
      entries: contractEntries,
      maxOutputChars: Math.min(48000, Math.max(2000, template.length * 4)),
      requiresText: /[\p{L}\p{N}]/u.test(
        contractEntries.reduce((value, entry) => {
          if (entry.kind === 'wrapper') {
            return value
              .replace(entry.openToken, '')
              .replace(entry.closeToken, '');
          }
          return value.replace(entry.token, '');
        }, template)
      ),
      literalTokens: Array.from(literalTokenCounts, ([value, count]) => ({
        value,
        count,
      })),
    };
    const originalSignature = hashText(sourceFingerprint);
    const cacheKey = JSON.stringify({
      codecVersion: CODEC_VERSION,
      template,
      entries: contractEntries.map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        tagName: entry.tagName,
        parentId: entry.parentId,
        atomKind: entry.atomKind || '',
      })),
      atoms: atoms.map((atom) => ({
        kind: atom.kind,
        label: atom.label || '',
        preserveText: atom.preserveText,
      })),
    });
    const snapshot = {
      blockElement: block,
      entries: snapshotEntries,
      originalContainers,
      originalTextValues,
      originalSignature,
      contract,
      template,
      appliedOwnership: null,
      translatedSignature: null,
    };

    return {
      ok: true,
      template,
      atoms,
      contract,
      snapshot,
      originalSignature,
      cacheKey,
    };
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function getExpectedTokens(contract) {
    const tokens = [];
    for (const entry of contract?.entries || []) {
      if (entry?.kind === 'wrapper') {
        tokens.push({ token: entry.openToken, action: 'open', entry });
        tokens.push({ token: entry.closeToken, action: 'close', entry });
      } else if (entry?.kind === 'atom') {
        tokens.push({ token: entry.token, action: 'atom', entry });
      }
    }
    return tokens;
  }

  function validationError(errorCode) {
    return { ok: false, errorCode };
  }

  function validateTranslatedTemplate(template, contract) {
    if (
      typeof template !== 'string' ||
      !contract ||
      typeof contract.namespace !== 'string' ||
      !Array.isArray(contract.entries)
    ) {
      return validationError('output_parse_failed');
    }
    if (
      Number.isFinite(contract.maxOutputChars) &&
      template.length > contract.maxOutputChars
    ) {
      return validationError('output_too_long');
    }

    const expectedTokens = getExpectedTokens(contract);
    const byToken = new Map(expectedTokens.map((item) => [item.token, item]));
    const literalTokenLimits = new Map();
    for (const item of contract.literalTokens || []) {
      if (
        typeof item?.value !== 'string' ||
        !item.value ||
        !Number.isInteger(item.count) ||
        item.count < 1
      ) {
        return validationError('output_parse_failed');
      }
      literalTokenLimits.set(item.value, item.count);
    }
    const literalTokenCounts = new Map();
    for (const token of getTokenLikeLiterals(template)) {
      if (byToken.has(token)) continue;
      const count = (literalTokenCounts.get(token) || 0) + 1;
      if (count > (literalTokenLimits.get(token) || 0)) {
        return validationError('token_unknown');
      }
      literalTokenCounts.set(token, count);
    }
    const tokenExpression = new RegExp(
      `⟦${escapeRegExp(contract.namespace)}:[^⟧]+⟧`,
      'g'
    );
    const matches = Array.from(template.matchAll(tokenExpression));
    const counts = new Map();
    for (const match of matches) {
      const token = match[0];
      if (!byToken.has(token)) return validationError('token_unknown');
      counts.set(token, (counts.get(token) || 0) + 1);
    }
    for (const { token } of expectedTokens) {
      const count = counts.get(token) || 0;
      if (count === 0) return validationError('token_missing');
      if (count > 1) return validationError('token_duplicate');
    }
    let withoutExpectedTokens = template;
    for (const { token } of expectedTokens) {
      withoutExpectedTokens = withoutExpectedTokens.split(token).join('');
    }
    if (withoutExpectedTokens.includes(`⟦${contract.namespace}:`)) {
      return validationError('token_unknown');
    }
    if (
      contract.requiresText === true &&
      !/[\p{L}\p{N}]/u.test(template.replace(tokenExpression, ''))
    ) {
      return validationError('output_parse_failed');
    }

    const tree = { type: 'root', id: 'ROOT', children: [] };
    const stack = [tree];
    let cursor = 0;
    for (const match of matches) {
      if (match.index > cursor) {
        stack[stack.length - 1].children.push({
          type: 'text',
          value: template.slice(cursor, match.index),
        });
      }
      const tokenInfo = byToken.get(match[0]);
      const currentParent = stack[stack.length - 1];
      if (tokenInfo.action === 'open') {
        if (tokenInfo.entry.parentId !== currentParent.id) {
          return validationError('token_parent_changed');
        }
        const wrapper = {
          type: 'wrapper',
          id: tokenInfo.entry.id,
          children: [],
        };
        currentParent.children.push(wrapper);
        stack.push(wrapper);
      } else if (tokenInfo.action === 'close') {
        if (stack.length === 1 || currentParent.id !== tokenInfo.entry.id) {
          return validationError('token_nesting_invalid');
        }
        stack.pop();
      } else {
        if (tokenInfo.entry.parentId !== currentParent.id) {
          return validationError('token_parent_changed');
        }
        currentParent.children.push({
          type: 'atom',
          id: tokenInfo.entry.id,
        });
      }
      cursor = match.index + match[0].length;
    }
    if (stack.length !== 1) return validationError('token_nesting_invalid');
    if (cursor < template.length) {
      tree.children.push({ type: 'text', value: template.slice(cursor) });
    }

    return { ok: true, tree, template };
  }

  function sameNodeList(actual, expected) {
    const current = getChildNodes(actual);
    if (current.length !== expected.length) return false;
    return current.every((node, index) => node === expected[index]);
  }

  function isNodeWithinBlock(node, block) {
    for (let current = node; current; current = current.parentNode) {
      if (current === block) return true;
    }
    return false;
  }

  function matchesOriginalOwnership(snapshot) {
    const block = snapshot?.blockElement;
    if (!block?.isConnected) return false;
    if (!matchesSupportedClassification(snapshot)) return false;
    const fingerprint = getStructureFingerprint(block);
    if (fingerprint == null || hashText(fingerprint) !== snapshot.originalSignature) {
      return false;
    }
    for (const container of snapshot.originalContainers || []) {
      if (!sameNodeList(container.node, container.children)) return false;
    }
    for (const [node, value] of snapshot.originalTextValues || []) {
      if (node.nodeValue !== value || !isNodeWithinBlock(node, block)) {
        return false;
      }
    }
    for (const entry of snapshot.entries?.values?.() || []) {
      if (!isNodeWithinBlock(entry.node, block)) return false;
    }
    return true;
  }

  function matchesSupportedClassification(snapshot) {
    if (isUnsupportedElement(snapshot?.blockElement)) return false;
    for (const container of snapshot?.originalContainers || []) {
      if (isUnsupportedElement(container.node)) return false;
    }
    for (const entry of snapshot?.entries?.values?.() || []) {
      if (isUnsupportedElement(entry.node)) return false;
    }
    return true;
  }

  function createPatchPlan(snapshot, translatedTemplate) {
    if (!matchesOriginalOwnership(snapshot)) {
      return validationError('block_changed');
    }
    const validated = validateTranslatedTemplate(
      translatedTemplate,
      snapshot.contract
    );
    if (!validated.ok) return validated;
    const document = snapshot.blockElement?.ownerDocument;
    if (!document?.createTextNode) return validationError('output_parse_failed');

    const containerPlans = [];
    const createdTextNodes = [];
    let failed = null;

    function buildChildren(treeNode) {
      const children = [];
      for (const child of treeNode.children || []) {
        if (child.type === 'text') {
          const textNode = document.createTextNode(child.value);
          createdTextNodes.push(textNode);
          children.push(textNode);
          continue;
        }
        const registered = snapshot.entries.get(child.id);
        if (!registered?.node) {
          failed = 'output_parse_failed';
          return [];
        }
        if (child.type === 'atom') {
          children.push(registered.node);
          continue;
        }
        if (child.type === 'wrapper') {
          const wrapperChildren = buildChildren(child);
          if (failed) return [];
          containerPlans.push({
            node: registered.node,
            children: wrapperChildren,
          });
          children.push(registered.node);
          continue;
        }
        failed = 'output_parse_failed';
        return [];
      }
      return children;
    }

    const rootChildren = buildChildren(validated.tree);
    if (failed) return validationError(failed);
    return {
      ok: true,
      translatedTemplate,
      tree: validated.tree,
      rootChildren,
      containerPlans,
      createdTextNodes,
    };
  }

  function replaceNodeChildren(node, children) {
    if (typeof node?.replaceChildren === 'function') {
      node.replaceChildren(...children);
      return;
    }
    while (node?.firstChild) node.removeChild(node.firstChild);
    for (const child of children) node.appendChild(child);
  }

  function restoreOriginalGraph(snapshot) {
    for (const [node, value] of snapshot.originalTextValues || []) {
      node.nodeValue = value;
    }
    for (const container of snapshot.originalContainers || []) {
      replaceNodeChildren(container.node, container.children);
    }
    snapshot.appliedOwnership = null;
    snapshot.translatedSignature = null;
  }

  function captureAppliedOwnership(snapshot, plan) {
    return (snapshot.originalContainers || []).map((container) => ({
      node: container.node,
      children: getChildNodes(container.node),
    }));
  }

  function applyPatchPlan(snapshot, plan) {
    if (!plan?.ok) return validationError('output_parse_failed');
    if (!matchesOriginalOwnership(snapshot)) {
      return validationError('block_changed');
    }
    try {
      for (const container of plan.containerPlans) {
        replaceNodeChildren(container.node, container.children);
      }
      replaceNodeChildren(snapshot.blockElement, plan.rootChildren);
      snapshot.appliedOwnership = captureAppliedOwnership(snapshot, plan);
      const translatedFingerprint = getStructureFingerprint(
        snapshot.blockElement
      );
      if (translatedFingerprint == null) throw new Error('block_too_large');
      snapshot.translatedSignature = hashText(translatedFingerprint);
      snapshot.translatedTemplate = plan.translatedTemplate;
      return {
        ok: true,
        translatedSignature: snapshot.translatedSignature,
      };
    } catch {
      try {
        restoreOriginalGraph(snapshot);
      } catch {}
      return validationError('apply_failed');
    }
  }

  function matchesAppliedOwnership(snapshot) {
    const block = snapshot?.blockElement;
    if (!block?.isConnected || !snapshot?.appliedOwnership) return false;
    if (!matchesSupportedClassification(snapshot)) return false;
    const fingerprint = getStructureFingerprint(block);
    if (
      fingerprint == null ||
      hashText(fingerprint) !== snapshot.translatedSignature
    ) {
      return false;
    }
    return snapshot.appliedOwnership.every((container) =>
      sameNodeList(container.node, container.children)
    );
  }

  function restoreBlock(snapshot) {
    if (!matchesAppliedOwnership(snapshot)) {
      return validationError('block_changed');
    }
    try {
      restoreOriginalGraph(snapshot);
      return { ok: true };
    } catch {
      return validationError('apply_failed');
    }
  }

  return {
    CODEC_VERSION,
    applyPatchPlan,
    createPatchPlan,
    matchesAppliedOwnership,
    matchesOriginalOwnership,
    isSemanticBlockElement,
    serializeBlock,
    isProtectedAtomicLinkLabel,
    restoreBlock,
    validateTranslatedTemplate,
  };
});
