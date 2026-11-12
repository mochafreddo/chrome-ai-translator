// The Placeholder Token contract, checked once because it is decided once.
//

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const placeholderTokens = require('../extension/placeholder-tokens.js');

const NS = 'CAT_TEST';

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
    name: 'enumerates Inline wrapper and atom entries into token actions',
    fn() {
      const describe = (tokens) =>
        tokens.map((token) => [token.action, token.entry.id, token.value]);

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
      assert.deepEqual(enumerate([{ kind: 'ignored' }], classifyInlineEntry), []);
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
      const tokens = enumerate(INLINE_ENTRIES, classifyInlineEntry);
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
        id: 'W2',
        kind: 'wrapper',
        openToken: `⟦${NS}:OPEN:W2⟧`,
        closeToken: `⟦${NS}:CLOSE:W2⟧`,
      };
      const crossed = enumerate([...INLINE_ENTRIES, second], classifyInlineEntry);
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
    name: 'Inline template validation uses the shared token walk',
    fn() {
      const calls = [];
      const scope = { ChromeAiTranslatorPlaceholderTokens: {
        ...placeholderTokens,
        enumerateExpectedTokens(entries, classify) {
          const tokens = placeholderTokens.enumerateExpectedTokens(entries, classify);
          calls.push({ entries, tokens });
          return tokens;
        },
        walkExpectedTokens(answer, tokens, options) {
          const walked = placeholderTokens.walkExpectedTokens(answer, tokens, options);
          calls.push({ answer, tokens, options, walked });
          return walked;
        },
      } };
      vm.runInNewContext(readExtensionFile('inline-template.js'), scope);
      const contract = { namespace: NS, entries: INLINE_ENTRIES };
      const [wrapper, atom] = INLINE_ENTRIES;
      const template = `${wrapper.openToken}문서${wrapper.closeToken}${atom.token}`;
      const result = scope.ChromeAiTranslatorInlineTemplate.validateTranslatedTemplate(template, contract);
      assert.equal(result.ok, true);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0].entries, INLINE_ENTRIES);
      assert.equal(calls[1].tokens, calls[0].tokens);
      assert.equal(calls[1].answer, template);
      assert.equal(calls[1].options.trackParents, true);
      assert.equal(result.tree, calls[1].walked.tree);
      assert.deepEqual(result.tree, { type: 'root', id: 'ROOT', children: [
        { type: 'wrapper', id: 'W1', children: [{ type: 'text', value: '문서' }] },
        { type: 'atom', id: 'A1' },
      ] });
      const invalid = scope.ChromeAiTranslatorInlineTemplate.validateTranslatedTemplate(
        `${wrapper.closeToken}문서${wrapper.openToken}${atom.token}`, contract
      );
      assert.equal(invalid.ok, false);
      assert.equal(invalid.errorCode, 'token_nesting_invalid');
    },
  },
];
