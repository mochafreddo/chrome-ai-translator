// The Placeholder Token contract, checked once because it is decided once.
//
// The four failures this module names are checked from each translation's side too — in
// tests/inline-block.test.js and tests/full-page-markdown.test.js, through the codes each of
// them reports. Those are the checks that say the reader still hears the right sentence. These
// are the checks that say why: the contract itself, asked directly, with both translations'
// entry kinds fed through the adapter seam that is the whole reason one module can serve both.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const placeholderTokens = require('../extension/placeholder-tokens.js');

const NS = 'CAT_TEST';

// An entry pair in each translation's own vocabulary, over the same two spans: one that wraps
// translated words, one that replaces a span whole.
const MARKDOWN_ENTRIES = [
  {
    id: 'L1',
    kind: 'link',
    openToken: `⟦${NS}:LINK_OPEN:L1⟧`,
    closeToken: `⟦${NS}:LINK_CLOSE:L1⟧`,
  },
  { id: 'C1', kind: 'code', token: `⟦${NS}:ATOM:C1⟧` },
  { id: 'B1', kind: 'block' },
];
const INLINE_ENTRIES = [
  {
    id: 'W1',
    kind: 'wrapper',
    parentId: 'ROOT',
    openToken: `⟦${NS}:OPEN:W1⟧`,
    closeToken: `⟦${NS}:CLOSE:W1⟧`,
  },
  { id: 'A1', kind: 'atom', parentId: 'ROOT', token: `⟦${NS}:ATOM:A1⟧` },
];

function classifyMarkdownEntry(entry) {
  if (entry.kind === 'link') return placeholderTokens.PAIR;
  if (entry.kind === 'code') return placeholderTokens.ATOM;
  return null;
}

function classifyInlineEntry(entry) {
  if (entry.kind === 'wrapper') return placeholderTokens.PAIR;
  if (entry.kind === 'atom') return placeholderTokens.ATOM;
  return null;
}

function enumerate(entries, classify) {
  return placeholderTokens.enumerateExpectedTokens(entries, classify);
}

function readExtensionFile(name) {
  return fs.readFileSync(
    path.join(__dirname, '..', 'extension', name),
    'utf8'
  );
}

exports.name = 'placeholder tokens';
exports.tests = [
  {
    name: 'enumerates both translations vocabularies into the same three actions',
    fn() {
      // The adapter is the only thing that differs, so this is what says the seam is doing the
      // whole job: two sets of kind names, two field names for the token that stands alone,
      // one shape out.
      const describe = (tokens) =>
        tokens.map((token) => [token.action, token.entry.id, token.value]);

      assert.deepEqual(describe(enumerate(MARKDOWN_ENTRIES, classifyMarkdownEntry)), [
        ['open', 'L1', `⟦${NS}:LINK_OPEN:L1⟧`],
        ['close', 'L1', `⟦${NS}:LINK_CLOSE:L1⟧`],
        ['atom', 'C1', `⟦${NS}:ATOM:C1⟧`],
      ]);
      assert.deepEqual(describe(enumerate(INLINE_ENTRIES, classifyInlineEntry)), [
        ['open', 'W1', `⟦${NS}:OPEN:W1⟧`],
        ['close', 'W1', `⟦${NS}:CLOSE:W1⟧`],
        ['atom', 'A1', `⟦${NS}:ATOM:A1⟧`],
      ]);
    },
  },
  {
    name: 'skips an entry that carries no placeholder token, and any entry at all',
    fn() {
      // A Markdown chunk's entries include block entries, which stand in for nothing and hold
      // no token. An adapter answering null for those is how they stay out of the contract
      // rather than arriving as a token whose value is undefined.
      assert.deepEqual(enumerate(MARKDOWN_ENTRIES, () => null), []);
      assert.deepEqual(enumerate([null, 'text', 7, undefined], classifyInlineEntry), []);
      assert.deepEqual(enumerate(null, classifyInlineEntry), []);
    },
  },
  {
    name: 'names a token lost and a token repeated',
    fn() {
      const tokens = enumerate(INLINE_ENTRIES, classifyInlineEntry);
      const answer = `${tokens[0].value}읽기${tokens[1].value} 그리고 ${tokens[2].value}`;

      assert.equal(placeholderTokens.findCountFailure(answer, tokens), null);
      assert.equal(
        placeholderTokens.findCountFailure(answer.replace(tokens[2].value, ''), tokens),
        'token_missing'
      );
      assert.equal(
        placeholderTokens.findCountFailure(`${answer}${tokens[2].value}`, tokens),
        'token_duplicate'
      );
      // An answer with both wrong is named by whichever token the enumeration reaches first,
      // which is the order the entries were minted in.
      assert.equal(
        placeholderTokens.findCountFailure(
          `${answer.replace(tokens[2].value, '')}${tokens[0].value}`,
          tokens
        ),
        'token_duplicate'
      );
    },
  },
  {
    name: 'sees a token invented in this request namespace, closed or not',
    fn() {
      const tokens = enumerate(INLINE_ENTRIES, classifyInlineEntry);
      const answer = `${tokens[0].value}읽기${tokens[1].value}${tokens[2].value}`;
      const residue = (value, namespace = NS) =>
        placeholderTokens.hasUnexpectedNamespaceResidue(value, namespace, tokens);

      assert.equal(residue(answer), false);
      assert.equal(residue(`${answer}⟦${NS}:ATOM:A999⟧`), true);
      // The unterminated shape, which is the one a token-shaped pattern misses and the reason
      // this question is asked of the residue rather than of the answer.
      assert.equal(residue(`${answer}⟦${NS}:ATOM:A999`), true);
      // Another request's namespace is somebody else's business, and a token-shaped literal
      // the page itself contained is not an invention at all.
      assert.equal(residue(`${answer}⟦FORGED:ATOM:X1⟧`), false);
      // A request with no namespace has no namespace to invent in.
      assert.equal(residue(`${answer}⟦:ATOM:A999⟧`, ''), false);
    },
  },
  {
    name: 'walks an answer into the tree its tokens describe',
    fn() {
      const tokens = enumerate(INLINE_ENTRIES, classifyInlineEntry);
      const [open, , atom] = tokens;
      const close = tokens[1];
      const walked = placeholderTokens.walkExpectedTokens(
        `먼저 ${open.value}읽기${close.value} 그리고 ${atom.value} 끝`,
        tokens
      );

      assert.equal(walked.ok, true);
      assert.deepEqual(walked.tree, {
        type: 'root',
        id: 'ROOT',
        children: [
          { type: 'text', value: '먼저 ' },
          {
            type: 'wrapper',
            id: 'W1',
            children: [{ type: 'text', value: '읽기' }],
          },
          { type: 'text', value: ' 그리고 ' },
          { type: 'atom', id: 'A1' },
          { type: 'text', value: ' 끝' },
        ],
      });
    },
  },
  {
    name: 'refuses a pair crossed, unclosed, or closed before it opened',
    fn() {
      const tokens = enumerate(MARKDOWN_ENTRIES, classifyMarkdownEntry);
      const [open, close, atom] = tokens;
      const refusal = (answer) => {
        const walked = placeholderTokens.walkExpectedTokens(answer, tokens);
        assert.equal(walked.ok, false);
        return walked.reason;
      };

      assert.equal(
        refusal(`${close.value}읽기${open.value}${atom.value}`),
        'token_nesting_invalid'
      );
      // Two pairs interleaved rather than nested: the inner close reaches a parent that is not
      // its own entry.
      const second = {
        id: 'L2',
        kind: 'link',
        openToken: `⟦${NS}:LINK_OPEN:L2⟧`,
        closeToken: `⟦${NS}:LINK_CLOSE:L2⟧`,
      };
      const crossed = enumerate([...MARKDOWN_ENTRIES, second], classifyMarkdownEntry);
      assert.equal(
        placeholderTokens.walkExpectedTokens(
          `${open.value}${second.openToken}${close.value}${second.closeToken}${atom.value}`,
          crossed
        ).reason,
        'token_nesting_invalid'
      );
    },
  },
  {
    name: 'asks about the original parent only when the translation records one',
    fn() {
      // Inline Translation's entries know which entry they sat inside; a Markdown chunk's do
      // not. The same walk answers both, and the option is what keeps the stricter question
      // from being asked of entries that cannot answer it.
      const outer = {
        id: 'W1',
        kind: 'wrapper',
        parentId: 'ROOT',
        openToken: `⟦${NS}:OPEN:W1⟧`,
        closeToken: `⟦${NS}:CLOSE:W1⟧`,
      };
      const inner = {
        id: 'W2',
        kind: 'wrapper',
        parentId: 'W1',
        openToken: `⟦${NS}:OPEN:W2⟧`,
        closeToken: `⟦${NS}:CLOSE:W2⟧`,
      };
      const tokens = enumerate([outer, inner], classifyInlineEntry);
      // Both pairs are balanced and properly nested. What is wrong is that the inner one came
      // back beside its old parent instead of inside it.
      const moved = `${outer.openToken}문서${outer.closeToken}${inner.openToken}가이드${inner.closeToken}`;

      assert.equal(
        placeholderTokens.walkExpectedTokens(moved, tokens, { trackParents: true }).reason,
        'token_parent_changed'
      );
      assert.equal(placeholderTokens.walkExpectedTokens(moved, tokens).ok, true);
    },
  },
  {
    name: 'is the only walk either translation has',
    fn() {
      // The point of the module. Two codecs that each kept their own walk is the state this
      // replaced, and it is a state that reads as fine right up to the moment one of them is
      // fixed alone.
      for (const file of ['inline-block.js', 'full-page-markdown.js']) {
        const source = readExtensionFile(file);
        assert.match(source, /placeholderTokens\.enumerateExpectedTokens\(/, file);
        assert.match(source, /placeholderTokens\.walkExpectedTokens\(/, file);
        // Nothing outside the walk mints a node of the tree it returns. Reading one is fine —
        // the inline codec rebuilds a block's children from it — so this looks for the shape
        // of a node being built, which is what a second walk would have to do.
        assert.equal(
          /type: '(root|wrapper|atom|text)'/.test(source),
          false,
          `${file} builds a token tree of its own`
        );
      }
    },
  },
];
