// Reading a Translation Chunk's answer back: the Placeholder Token check, then rehydration.
//
// The worker sends a chunk's `template` — Markdown with a Placeholder Token where every link
// and code span was — and gets a translation back. This module decides whether that answer
// kept the bargain, and if it did, puts the spans back where the model left the tokens. It is
// Side Panel Translation's adapter onto `extension/placeholder-tokens.js`: the four failures
// are decided there, and what is decided here is which entry kinds are pairs and which are
// atoms, the order the checks run in, and the `markdown.` spelling the failures come out in.
//
// Only the worker calls this. The page never sees a translation.
(function exposeMarkdownRehydration(globalScope) {
  'use strict';

  // The Placeholder Token contract, which this codec shares with the inline-block one, and the
  // Markdown spelling of an entry, which it shares with the serializing half. Both are already
  // loaded in the worker — background.js imports them ahead of this file — and under a
  // CommonJS loader they come in by require, which is how the unit suite reaches them.
  const placeholderTokens =
    globalScope?.ChromeAiTranslatorPlaceholderTokens ||
    (typeof module !== 'undefined' && module.exports
      ? require('./placeholder-tokens.js')
      : null);
  const markdownEntries =
    globalScope?.ChromeAiTranslatorMarkdownEntries ||
    (typeof module !== 'undefined' && module.exports
      ? require('./markdown-entries.js')
      : null);

  function createValidationError(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }

  // This codec's half of the adapter onto the shared contract: a link entry is a pair, a code
  // entry is an atom, and a block entry carries no Placeholder Token at all.
  function classifyChunkEntry(entry) {
    if (entry.kind === 'link') return placeholderTokens.PAIR;
    if (entry.kind === 'code') return placeholderTokens.ATOM;
    return null;
  }

  // The four failures in this codec's spelling. The shared module answers with the bare code,
  // and the `markdown.` prefix is what the side panel keys the reader's four sentences on and
  // what background.js reads to decide whether a chunk is worth one repair attempt, so the
  // prefix is applied here rather than in the module both codecs share.
  const TOKEN_FAILURE_CODES = Object.freeze({
    token_missing: 'markdown.token_missing',
    token_duplicate: 'markdown.token_duplicate',
    token_unknown: 'markdown.token_unknown',
    token_nesting_invalid: 'markdown.token_nesting_invalid',
  });

  function escapeLinkWrapperContent(value, entry) {
    const openIndex = value.indexOf(entry.openToken);
    const contentStart = openIndex + entry.openToken.length;
    const closeIndex = value.indexOf(entry.closeToken, contentStart);
    const label = markdownEntries.escapeMarkdownLinkLabel(
      value.slice(contentStart, closeIndex)
    );
    return `${value.slice(0, contentStart)}${label}${value.slice(closeIndex)}`;
  }

  function validateAndRehydrateChunk(output, chunk) {
    const value = String(output || '');
    const entries = markdownEntries.getChunkEntries(chunk);
    const expectedTokens = placeholderTokens.enumerateExpectedTokens(
      entries,
      classifyChunkEntry
    );
    // A chunk's namespace is the whole vocabulary the model was given, so anything left in it
    // once the chunk's own tokens are removed is a token the model invented. This codec asks
    // that before it counts, which is not the order the inline codec uses and is left alone:
    // an answer that both loses a token and invents one has two things wrong with it, and
    // which of the two each translation names first is not a difference worth chasing.
    const namespace = String(chunk?.contract?.namespace || '');
    if (
      placeholderTokens.hasUnexpectedNamespaceResidue(
        value,
        namespace,
        expectedTokens
      )
    ) {
      throw createValidationError(TOKEN_FAILURE_CODES.token_unknown);
    }
    const countFailure = placeholderTokens.findCountFailure(
      value,
      expectedTokens
    );
    if (countFailure) {
      throw createValidationError(TOKEN_FAILURE_CODES[countFailure]);
    }

    // The walk without parents enforced: a chunk's entries do not record which entry they sat
    // inside, so balance and nesting is all this codec can ask. The tree it returns is unused
    // here — rehydration works from the entries, not from the answer's shape.
    const walked = placeholderTokens.walkExpectedTokens(value, expectedTokens);
    if (!walked.ok) {
      throw createValidationError(TOKEN_FAILURE_CODES[walked.reason]);
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
          ? `[${markdownEntries.escapeMarkdownLinkLabel(
              entry.value
            )}](${markdownEntries.renderDestination(entry.destination)})`
          : markdownEntries.renderCode(entry);
        result = result.split(entry.token).join(replacement);
      } else if (entry.kind === 'link') {
        result = result.split(entry.openToken).join('[');
        result = result
          .split(entry.closeToken)
          .join(`](${markdownEntries.renderDestination(entry.destination)})`);
      }
    }
    return result;
  }

  const api = {
    validateAndRehydrateChunk,
  };
  globalScope.ChromeAiTranslatorMarkdownRehydration = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
