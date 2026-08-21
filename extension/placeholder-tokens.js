// The Placeholder Token contract, once, for both translations.
//
// A Placeholder Token stands in for a link, emphasis, or code span while a translation is in
// flight, so the model may reorder the words around it without rewriting what it stands for.
// The contract is the same on both sides: every token the request sent must come back
// byte-for-byte, exactly once, with nothing else from the token namespace alongside it, and
// with the pairs still nested the way they were sent. Four failures fall out of that — a
// token lost, repeated, invented, or crossed — and this module is where all four are decided.
//
// Side Panel Translation and Inline Translation used to decide them twice, in code that
// differed only in what the entry kinds were called and which field carried the token, so a
// fix to one was invisible to the other. What is shared here is the part that is genuinely the
// same: the enumeration of what was sent, the counting, the namespace-residue test, and the
// walk that checks nesting. What each translation keeps is its own: which entry kinds map onto
// `pair` and `atom`, whether an entry's original parent is enforced, the order the checks run
// in, and how a failure is reported. Those four differ for reasons, and forcing them together
// here would move the divergence rather than remove it.
//
// The failure strings this module returns are bare: `token_missing` and its three siblings.
// Inline Translation reports them as they are and Side Panel Translation prefixes them with
// `markdown.`, and neither spelling changed when the two were brought together — the four
// sentences the reader is shown key on those codes.
(function exposePlaceholderTokens(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.ChromeAiTranslatorPlaceholderTokens = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPlaceholderTokens() {
  'use strict';

  // What an adapter's `classifyEntry` may answer. A `pair` entry wraps translated words and
  // carries `openToken` and `closeToken`; an `atom` entry replaces a span whole and carries
  // `token`. Any other answer means the entry is not a Placeholder Token and is skipped.
  const PAIR = 'pair';
  const ATOM = 'atom';

  const ROOT_ID = 'ROOT';

  const FAILURES = Object.freeze({
    MISSING: 'token_missing',
    DUPLICATE: 'token_duplicate',
    UNKNOWN: 'token_unknown',
    NESTING_INVALID: 'token_nesting_invalid',
    PARENT_CHANGED: 'token_parent_changed',
  });

  // The tokens one request sent, in the order their entries were minted. Each carries the
  // entry it came from, so the walk can ask about the original nesting without a second
  // lookup.
  function enumerateExpectedTokens(entries, classifyEntry) {
    const tokens = [];
    for (const entry of Array.from(entries || [])) {
      if (!entry || typeof entry !== 'object') continue;
      const role = classifyEntry(entry);
      if (role === PAIR) {
        tokens.push({ value: entry.openToken, action: 'open', entry });
        tokens.push({ value: entry.closeToken, action: 'close', entry });
      } else if (role === ATOM) {
        tokens.push({ value: entry.token, action: 'atom', entry });
      }
    }
    return tokens;
  }

  function countOccurrences(value, needle) {
    if (!needle) return 0;
    return String(value).split(needle).length - 1;
  }

  // A token lost or repeated, whichever the answer shows first. Null when every token came
  // back exactly once.
  function findCountFailure(answer, tokens) {
    const value = String(answer);
    for (const token of tokens) {
      const count = countOccurrences(value, token.value);
      if (count === 0) return FAILURES.MISSING;
      if (count > 1) return FAILURES.DUPLICATE;
    }
    return null;
  }

  // Whether anything from this request's own token namespace is left once the tokens it sent
  // are removed. Residue is a token the model invented, and asking it this way catches the
  // unterminated shape — a namespace opened and never closed — that a token-shaped pattern
  // does not. A request with no namespace has no namespace to invent in.
  function hasUnexpectedNamespaceResidue(answer, namespace, tokens) {
    if (!namespace) return false;
    let residue = String(answer);
    for (const token of tokens) {
      residue = residue.split(token.value).join('');
    }
    return residue.includes(`⟦${namespace}:`);
  }

  // Where each token sits in the answer, earliest first. Both callers count before they walk,
  // so every token here occurs exactly once and this order is the answer's own.
  function locateExpectedTokens(answer, tokens) {
    const value = String(answer);
    return tokens
      .map((token) => ({ ...token, index: value.indexOf(token.value) }))
      .sort((left, right) => left.index - right.index);
  }

  // The walk. It reads the answer once and returns the tree the tokens describe: text between
  // tokens, an `atom` node per atom, and a `wrapper` node holding whatever its pair encloses.
  //
  // Balance and nesting are checked for both translations. `trackParents` adds the stricter
  // question Inline Translation has to ask and Side Panel Translation cannot: its entries know
  // which entry they sat inside, so a token that comes back under a different parent has been
  // moved rather than merely reordered, and that is a different failure. Side Panel
  // Translation's entries carry no parent, so it leaves the option off.
  function walkExpectedTokens(answer, tokens, options = {}) {
    const value = String(answer);
    const trackParents = options.trackParents === true;
    const tree = { type: 'root', id: ROOT_ID, children: [] };
    const stack = [tree];
    let cursor = 0;

    for (const token of locateExpectedTokens(value, tokens)) {
      if (token.index > cursor) {
        stack[stack.length - 1].children.push({
          type: 'text',
          value: value.slice(cursor, token.index),
        });
      }
      const parent = stack[stack.length - 1];
      if (token.action === 'close') {
        if (stack.length === 1 || parent.id !== token.entry.id) {
          return { ok: false, reason: FAILURES.NESTING_INVALID };
        }
        stack.pop();
      } else {
        if (trackParents && token.entry.parentId !== parent.id) {
          return { ok: false, reason: FAILURES.PARENT_CHANGED };
        }
        if (token.action === 'open') {
          const wrapper = { type: 'wrapper', id: token.entry.id, children: [] };
          parent.children.push(wrapper);
          stack.push(wrapper);
        } else {
          parent.children.push({ type: 'atom', id: token.entry.id });
        }
      }
      cursor = token.index + token.value.length;
    }

    if (stack.length !== 1) {
      return { ok: false, reason: FAILURES.NESTING_INVALID };
    }
    if (cursor < value.length) {
      tree.children.push({ type: 'text', value: value.slice(cursor) });
    }
    return { ok: true, tree };
  }

  return {
    ATOM,
    FAILURES,
    PAIR,
    ROOT_ID,
    enumerateExpectedTokens,
    findCountFailure,
    hasUnexpectedNamespaceResidue,
    locateExpectedTokens,
    walkExpectedTokens,
  };
});
