(function initInlineTemplate(globalScope) {
  'use strict';

  const placeholderTokens = globalScope.ChromeAiTranslatorPlaceholderTokens ||
    (typeof module !== 'undefined' && module.exports ? require('./placeholder-tokens.js') : null);

  function hasSourcePathFileExtension(value) {
    const text = String(value || '');
    return !/^(?:e\.g|i\.e)\.?$/i.test(text) &&
      /\.[\p{L}][\p{L}\p{N}]{0,9}$/u.test(text);
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

  function getSourceSyntaxLiterals(value, contextualLiterals = [], entries = []) {
    const counts = new Map();
    const add = (literal) => {
      const normalized = String(literal || '');
      if (!normalized) return;
      const count = String(value || '').split(normalized).length - 1;
      if (count > 0) counts.set(normalized, count);
    };
    const text = String(value || '');
    let commandText = text;
    for (const entry of entries) {
      if (entry.kind === 'wrapper') {
        commandText = commandText.split(entry.openToken).join('').split(entry.closeToken).join('');
      } else {
        commandText = commandText.split(entry.token).join(entry.tagName === 'BR' ? '\n' : '');
      }
    }
    if (/^\$ [a-z]/.test(commandText) && !/[\r\n\u2028\u2029]/.test(commandText)) add(text);
    for (const match of text.matchAll(/\[[^\]\r\n|]+\|[^\]\r\n]+\]/g)) {
      add(match[0]);
    }
    for (const match of text.matchAll(
      /(^|[\s([{"'`])((?:~\/|\.{1,2}\/|\/)[\p{L}\p{N}._~+@%-]+(?:\/[\p{L}\p{N}._~+@%-]+)*)/gu
    )) {
      add(match[2].replace(/[.,;:!?]+$/u, ''));
    }
    for (const match of text.matchAll(
      /(^|[^\p{L}\p{N}_.~+@%/-])([\p{L}\p{N}_.~+@%-]+(?:\/[\p{L}\p{N}_.~+@%-]+)*)(?=$|[^\p{L}\p{N}_.~+@%/-])/gu
    )) {
      const literal = match[2].replace(/[.,;:!?]+$/u, '');
      if (hasSourcePathFileExtension(literal)) {
        add(literal);
      }
    }
    for (const literal of contextualLiterals || []) add(literal);
    return counts;
  }

  function stripSourceSyntax(value, contextualLiterals = []) {
    let text = String(value || '');
    for (const literal of getSourceSyntaxLiterals(
      text,
      contextualLiterals
    ).keys()) {
      text = text.split(literal).join(' ');
    }
    return text;
  }

  function isSourceSyntaxContinuation(text, index, direction) {
    const character = text[index] || '';
    if (/[A-Za-z0-9_~+@%/-]/.test(character)) return true;
    if (character !== '.') return false;
    const adjacent = text[index + direction] || '';
    return /[\p{L}\p{N}]/u.test(adjacent);
  }

  function countPreservedSourceSyntax(text, expected) {
    let count = 0;
    let from = 0;
    while (from <= text.length - expected.length) {
      const index = text.indexOf(expected, from);
      if (index < 0) break;
      const before = index - 1;
      const after = index + expected.length;
      if (
        !isSourceSyntaxContinuation(text, before, -1) &&
        !isSourceSyntaxContinuation(text, after, 1)
      ) {
        count += 1;
      }
      from = index + expected.length;
    }
    return count;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function classifyContractEntry(entry) {
    if (entry.kind === 'wrapper') return placeholderTokens.PAIR;
    if (entry.kind === 'atom') return placeholderTokens.ATOM;
    return null;
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
    for (const item of contract.sourceSyntax || []) {
      if (
        typeof item?.value !== 'string' ||
        !item.value ||
        !Number.isInteger(item.count) ||
        item.count < 1 ||
        countPreservedSourceSyntax(template, item.value) !== item.count
      ) {
        return validationError('source_syntax_changed');
      }
    }

    const droppedWrappers = contract.entries
      .filter(
        (entry) =>
          entry.droppable === true &&
          !template.includes(entry.openToken) &&
          !template.includes(entry.closeToken)
      )
      .map((entry) => entry.id);
    const expectedTokens = placeholderTokens.enumerateExpectedTokens(
      contract.entries.filter((entry) => !droppedWrappers.includes(entry.id)),
      classifyContractEntry
    );
    const expected = new Set(expectedTokens.map((token) => token.value));
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
      if (expected.has(token)) continue;
      const count = (literalTokenCounts.get(token) || 0) + 1;
      if (count > (literalTokenLimits.get(token) || 0)) {
        return validationError('token_unknown');
      }
      literalTokenCounts.set(token, count);
    }
    const closedNamespaceTokenPattern = new RegExp(
      `⟦${escapeRegExp(contract.namespace)}:[^⟧]+⟧`,
      'g'
    );
    for (const [token] of template.matchAll(closedNamespaceTokenPattern)) {
      if (!expected.has(token)) return validationError('token_unknown');
    }
    const countFailure = placeholderTokens.findCountFailure(
      template,
      expectedTokens
    );
    if (countFailure) return validationError(countFailure);
    if (
      placeholderTokens.hasUnexpectedNamespaceResidue(
        template,
        contract.namespace,
        expectedTokens
      )
    ) {
      return validationError('token_unknown');
    }
    if (
      contract.requiresText === true &&
      !/[\p{L}\p{N}]/u.test(template.replace(closedNamespaceTokenPattern, ''))
    ) {
      return validationError('output_parse_failed');
    }

    const walked = placeholderTokens.walkExpectedTokens(
      template,
      expectedTokens,
      { trackParents: true }
    );
    if (!walked.ok) return validationError(walked.reason);
    if (
      contract.entries.some((entry) => entry.kind === 'wrapper' &&
        entry.tagName === 'DIV' && entry.parentId === 'ROOT') &&
      walked.tree.children.some((child) => child.type === 'text' && child.value.trim())
    ) {
      return validationError('token_parent_changed');
    }

    return { ok: true, tree: walked.tree, template, droppedWrappers };
  }

  function validateSourceTemplate(template, contract) {
    const result = validateTranslatedTemplate(template, contract);
    return result.ok && result.droppedWrappers.length ? validationError('output_parse_failed') : result;
  }

  const api = {
    getSourceSyntaxLiterals,
    getTokenLikeLiterals,
    hasSourcePathFileExtension,
    stripSourceSyntax,
    validateSourceTemplate,
    validateTranslatedTemplate,
  };
  globalScope.ChromeAiTranslatorInlineTemplate = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
