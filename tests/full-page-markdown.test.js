const assert = require('node:assert/strict');
const markdown = require('../extension/full-page-markdown.js');

function createTestDocument() {
  class TestNode {
    constructor(nodeType, ownerDocument) {
      this.nodeType = nodeType;
      this.ownerDocument = ownerDocument || this;
      this.parentNode = null;
      this.childNodes = [];
    }

    get parentElement() {
      return this.parentNode?.nodeType === 1 ? this.parentNode : null;
    }

    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map((child) => child.textContent).join('');
    }

    appendChild(node) {
      this.childNodes.push(node);
      node.parentNode = this;
      return node;
    }
  }

  class TestText extends TestNode {
    constructor(value, ownerDocument) {
      super(3, ownerDocument);
      this.nodeValue = String(value);
    }
  }

  class TestElement extends TestNode {
    constructor(tagName, ownerDocument) {
      super(1, ownerDocument);
      this.tagName = String(tagName).toUpperCase();
      this.attributes = new Map();
    }

    getAttribute(name) {
      return this.attributes.get(String(name).toLowerCase()) ?? null;
    }

    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase());
    }

    setAttribute(name, value) {
      this.attributes.set(String(name).toLowerCase(), String(value));
    }
  }

  class TestDocument extends TestNode {
    constructor() {
      super(9, null);
      this.ownerDocument = this;
    }

    createElement(tagName) {
      return new TestElement(tagName, this);
    }

    createTextNode(value) {
      return new TestText(value, this);
    }
  }

  const document = new TestDocument();
  const text = (value) => document.createTextNode(value);
  const element = (tagName, attributes = {}, ...children) => {
    const node = document.createElement(tagName);
    for (const [name, value] of Object.entries(attributes)) {
      node.setAttribute(name, value);
    }
    for (const child of children) node.appendChild(child);
    return node;
  };
  return { document, element, text };
}

function createProtectedFixture() {
  const { element, text } = createTestDocument();
  const article = element(
    'article',
    {},
    element('h1', {}, text('Guide')),
    element(
      'p',
      {},
      text('Read '),
      element(
        'a',
        { href: 'https://example.test/a_(b)?token=secret#part' },
        text('the guide')
      ),
      text('.')
    ),
    element(
      'p',
      {},
      text('Run '),
      element('code', {}, text('npm run `build`')),
      text(' now.')
    ),
    element(
      'pre',
      {},
      element('code', { class: 'language-js' }, text('const fence = ```;'))
    ),
    element(
      'ol',
      {},
      element(
        'li',
        {},
        text('First'),
        element('ul', {}, element('li', {}, text('Nested item')))
      )
    )
  );
  return article;
}

function createChunk(documentModel, block) {
  const entryIds = new Set(block.entries);
  return {
    blocks: [block],
    entries: documentModel.entries.filter((entry) => entryIds.has(entry.id)),
  };
}

function createProtectedNaturalLinkTest(tagName) {
  return {
    name: `preserves exact ${tagName} contents inside a natural link`,
    fn() {
      const { element, text } = createTestDocument();
      const protectedValue = `${tagName}[x]\\tail`;
      const destination = `https://safe.test/${tagName}`;
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element(
            'a',
            { href: destination },
            text('Before [raw]\\ '),
            element(tagName, {}, text(protectedValue)),
            text(' after')
          )
        )
      );
      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );
      const block = documentModel.blocks[0];
      const expected = `[Before \\[raw\\]\\\\ \`\`\`${protectedValue}\`\`\` after](<${destination}>)`;

      assert.equal(markdown.renderOriginalMarkdown(documentModel), expected);
      assert.equal(
        markdown.validateAndRehydrateChunk(
          block.template,
          createChunk(documentModel, block)
        ),
        expected
      );
      assert.deepEqual(
        documentModel.entries
          .filter((entry) => entry.kind === 'code')
          .map((entry) => entry.value),
        [protectedValue]
      );
    },
  };
}

exports.name = 'full-page Markdown contract';
exports.tests = [
  {
    name: 'groups protected blocks into source-ordered bounded chunks',
    fn() {
      const documentModel = markdown.serializeMarkdownDocument(
        createProtectedFixture(),
        {},
        { namespace: 'CAT_TEST' }
      );

      const chunks = markdown.createTranslationChunks(documentModel, 120);

      assert.equal(chunks.length > 1, true);
      for (const chunk of chunks) {
        assert.equal(chunk.template.length <= 120, true);
        assert.equal(chunk.contract.namespace, documentModel.namespace);
        for (const entry of chunk.contract.entries) {
          const tokens = [entry.token, entry.openToken, entry.closeToken].filter(
            Boolean
          );
          for (const token of tokens) {
            assert.equal(chunk.template.includes(token), true);
          }
        }
      }
      assert.deepEqual(
        chunks.flatMap((chunk) => chunk.blocks),
        documentModel.blocks
      );
    },
  },
  {
    name: 'splits oversized prose only at sentence or whitespace boundaries',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          text(
            'First sentence has several carefully chosen words and continues well beyond the character limit without ending early. Second sentence finishes the paragraph.'
          )
        )
      );
      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );
      const source = documentModel.blocks[0].template;

      const chunks = markdown.createTranslationChunks(documentModel, 52);

      assert.equal(chunks.length >= 3, true);
      assert.equal(
        chunks.every((chunk) => chunk.template.length <= 52),
        true
      );
      assert.equal(
        chunks.some((chunk, index) => chunk.template === source.slice(index * 52, (index + 1) * 52)),
        false
      );
      assert.equal(
        chunks.map((chunk) => chunk.template).join(' '),
        source
      );
      assert.equal(
        chunks.every((chunk) => !/^\s|\s$/u.test(chunk.template)),
        true
      );
    },
  },
  {
    name: 'keeps a protected link wrapper atomic during forced whitespace splitting',
    fn() {
      const namespace = 'CAT_ATOMIC';
      const entry = {
        id: 'L1',
        kind: 'link',
        openToken: `⟦${namespace}:LINK_OPEN:L1⟧`,
        closeToken: `⟦${namespace}:LINK_CLOSE:L1⟧`,
        destination: 'https://private.test/path?token=secret',
      };
      const protectedLink = `${entry.openToken}one two three four${entry.closeToken}`;
      const documentModel = {
        namespace,
        entries: [entry],
        blocks: [{
          id: 'm1',
          kind: 'paragraph',
          template: `prefix ${protectedLink} suffix words`,
          entries: [entry.id],
        }],
      };

      assert.throws(
        () =>
          markdown.createTranslationChunks(
            documentModel,
            protectedLink.length - 1
          ),
        (error) => error.code === 'markdown.segment_too_large'
      );
    },
  },
  {
    name: 'rejects an indivisible oversized prose segment before chunking',
    fn() {
      const { element, text } = createTestDocument();
      const documentModel = markdown.serializeMarkdownDocument(
        element('main', {}, element('p', {}, text('x'.repeat(121)))),
        {},
        { namespace: 'CAT_TEST' }
      );

      assert.throws(
        () => markdown.createTranslationChunks(documentModel, 60),
        (error) => error.code === 'markdown.segment_too_large'
      );
    },
  },
  {
    name: 'splits a chunk once for recovery at half its original limit',
    fn() {
      const { element, text } = createTestDocument();
      const documentModel = markdown.serializeMarkdownDocument(
        element(
          'main',
          {},
          element('p', {}, text('First short paragraph.')),
          element('p', {}, text('Second short paragraph.')),
          element('p', {}, text('Third short paragraph.'))
        ),
        {},
        { namespace: 'CAT_TEST' }
      );
      const [chunk] = markdown.createTranslationChunks(documentModel, 120);

      const recovery = markdown.splitChunkForRecovery(chunk);

      assert.equal(recovery.length >= 2, true);
      assert.equal(recovery.every((child) => child.maxChars === 60), true);
      assert.equal(
        recovery.every((child) => child.recoveryDepth === 1),
        true
      );
      assert.throws(
        () => markdown.splitChunkForRecovery(recovery[0]),
        (error) => error.code === 'response.recovery_exhausted'
      );
    },
  },
  {
    name: 'reports unavailable recovery when the half limit cannot split safely',
    fn() {
      const { element, text } = createTestDocument();
      const documentModel = markdown.serializeMarkdownDocument(
        element('main', {}, element('p', {}, text('x'.repeat(80)))),
        {},
        { namespace: 'CAT_TEST' }
      );
      const [chunk] = markdown.createTranslationChunks(documentModel, 120);

      assert.throws(
        () => markdown.splitChunkForRecovery(chunk),
        (error) => error.code === 'response.recovery_unavailable'
      );
    },
  },
  {
    name: 'protects destinations and code while preserving document structure',
    fn() {
      const documentModel = markdown.serializeMarkdownDocument(
        createProtectedFixture(),
        {
          title: 'Guide',
          url: 'https://page.test/private',
          langHint: 'en',
        },
        { namespace: 'CAT_TEST' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);
      const modelInput = documentModel.blocks
        .map((block) => block.template)
        .join('\n\n');

      assert.match(original, /\[the guide\]\(<https:\/\/example\.test\//);
      assert.match(original, /npm run `build`/);
      assert.match(original, /    - Nested item/);
      assert.equal(modelInput.includes('token=secret'), false);
      assert.equal(modelInput.includes('npm run'), false);
      assert.equal(modelInput.includes('const fence'), false);
      assert.equal(modelInput.includes('the guide'), true);
      assert.deepEqual(
        documentModel.blocks.map((block) => block.kind),
        [
          'heading',
          'paragraph',
          'paragraph',
          'code',
          'ordered-item',
          'unordered-item',
        ]
      );
    },
  },
  {
    name: 'protects a URL-shaped visible link label as one atom',
    fn() {
      const { element, text } = createTestDocument();
      const article = element(
        'article',
        {},
        element(
          'p',
          {},
          element(
            'a',
            { href: 'https://destination.test/private' },
            text('https://visible.test/private')
          )
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        article,
        {},
        { namespace: 'CAT_TEST' }
      );
      const modelInput = documentModel.blocks[0].template;

      assert.equal(modelInput.includes('visible.test'), false);
      assert.equal(modelInput.includes('destination.test'), false);
      assert.match(
        markdown.renderOriginalMarkdown(documentModel),
        /\[https:\/\/visible\.test\/private\]\(<https:\/\/destination\.test\/private>\)/
      );
    },
  },
  {
    name: 'rehydrates valid protected output and rejects corrupted tokens',
    fn() {
      const documentModel = markdown.serializeMarkdownDocument(
        createProtectedFixture(),
        {},
        { namespace: 'CAT_TEST' }
      );
      const linkBlock = documentModel.blocks[1];
      const codeBlock = documentModel.blocks[2];
      const link = documentModel.entries.find((entry) => entry.kind === 'link');
      const code = documentModel.entries.find(
        (entry) => entry.kind === 'code' && entry.display === 'inline'
      );
      const chunk = {
        blocks: [linkBlock, codeBlock],
        entries: [link, code],
        contract: {
          namespace: documentModel.namespace,
          entries: [link, code],
        },
      };
      const validOutput = `읽기 ${link.openToken}가이드${link.closeToken}.\n\n지금 ${code.token} 실행.`;

      assert.equal(
        markdown
          .validateAndRehydrateChunk(validOutput, chunk)
          .includes('https://example.test/a_(b)?token=secret#part'),
        true
      );

      const invalidCases = [
        [validOutput.replace(code.token, ''), 'markdown.token_missing'],
        [`${validOutput}${code.token}`, 'markdown.token_duplicate'],
        [
          `${validOutput}⟦CAT_TEST:ATOM:C999⟧`,
          'markdown.token_unknown',
        ],
        [
          validOutput.replace(
            `${link.openToken}가이드${link.closeToken}`,
            `${link.closeToken}가이드${link.openToken}`
          ),
          'markdown.token_nesting_invalid',
        ],
      ];
      for (const [badOutput, codeValue] of invalidCases) {
        assert.throws(
          () => markdown.validateAndRehydrateChunk(badOutput, chunk),
          (error) => error.code === codeValue
        );
      }
    },
  },
  {
    name: 'allows foreign token-shaped source literals but rejects active-namespace injection',
    fn() {
      const { element, text } = createTestDocument();
      const foreignLiteral = '⟦FOREIGN_SOURCE:ATOM:C9⟧';
      const documentModel = markdown.serializeMarkdownDocument(
        element('main', {}, element('p', {}, text(`Keep ${foreignLiteral}.`))),
        {},
        { namespace: 'CAT_ACTIVE' }
      );
      const block = documentModel.blocks[0];
      const chunkEntries = createChunk(documentModel, block).entries;
      const chunk = {
        blocks: [block],
        entries: chunkEntries,
        contract: {
          namespace: documentModel.namespace,
          entries: chunkEntries,
        },
      };

      assert.equal(
        markdown.validateAndRehydrateChunk(block.template, chunk),
        `Keep ${foreignLiteral}.`
      );
      for (const injected of [
        `${block.template} ⟦CAT_ACTIVE:ATOM:C999⟧`,
        `${block.template} ⟦CAT_ACTIVE:ATOM:C999`,
      ]) {
        assert.throws(
          () => markdown.validateAndRehydrateChunk(injected, chunk),
          (error) => error.code === 'markdown.token_unknown'
        );
      }
    },
  },
  {
    name: 'excludes hidden navigation form-control and editable subtrees before serialization',
    fn() {
      const { document, element, text } = createTestDocument();
      document.defaultView = {
        getComputedStyle(node) {
          return {
            display: node.getAttribute?.('data-display') || 'block',
            visibility: node.getAttribute?.('data-visibility') || 'visible',
            contentVisibility:
              node.getAttribute?.('data-content-visibility') || 'visible',
            opacity: node.getAttribute?.('data-opacity') || '1',
          };
        },
      };
      const root = element(
        'main',
        {},
        element('p', {}, text('Visible prose.')),
        element('nav', {}, element('p', {}, text('Private navigation prose.'))),
        element('section', { hidden: '' }, element('p', {}, text('Hidden prose.'))),
        element(
          'section',
          { 'aria-hidden': 'true' },
          element('p', {}, text('ARIA hidden prose.'))
        ),
        element('form', {}, element('p', {}, text('Form prose.'))),
        element('button', {}, element('p', {}, text('Control prose.'))),
        element('footer', {}, element('p', {}, text('Footer prose.'))),
        element('svg', {}, element('p', {}, text('SVG prose.'))),
        element(
          'section',
          { tabindex: '0' },
          element('p', {}, text('Interactive prose.'))
        ),
        element(
          'section',
          { contenteditable: 'true' },
          element('p', {}, text('Draft prose.'))
        ),
        element(
          'section',
          { 'data-display': 'none' },
          element('p', {}, text('Computed hidden prose.'))
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_EXCLUSION' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);
      const modelInput = documentModel.blocks.map((block) => block.template).join('\n\n');

      assert.equal(original, 'Visible prose.');
      assert.equal(modelInput, 'Visible prose.');
    },
  },
  {
    name: 'excludes header and aside site chrome before serialization',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element('header', {}, element('p', {}, text('Header chrome.'))),
        element('aside', {}, element('p', {}, text('Sidebar chrome.'))),
        element('p', {}, text('Article body.'))
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_SITE_CHROME' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);
      const modelInput = documentModel.blocks.map((block) => block.template).join('\n\n');

      assert.equal(original, 'Article body.');
      assert.equal(modelInput, 'Article body.');
    },
  },
  {
    name: 'excludes hidden table sections rows and cells from original and model Markdown',
    fn() {
      const { document, element, text } = createTestDocument();
      document.defaultView = {
        getComputedStyle(node) {
          return {
            display: node.getAttribute?.('data-display') || 'table-cell',
            visibility: 'visible',
            contentVisibility: 'visible',
            opacity: '1',
          };
        },
      };
      const root = element(
        'main',
        {},
        element(
          'table',
          {},
          element(
            'thead',
            {},
            element('tr', {}, element('th', {}, text('Visible heading')))
          ),
          element(
            'tbody',
            {},
            element('tr', {}, element('td', {}, text('Visible cell'))),
            element(
              'tr',
              {},
              element('td', { hidden: '' }, text('Hidden cell secret')),
              element('td', {}, text('Visible sibling'))
            ),
            element(
              'tr',
              { 'aria-hidden': 'true' },
              element('td', {}, text('Hidden row secret'))
            )
          ),
          element(
            'tbody',
            { 'data-display': 'none' },
            element('tr', {}, element('td', {}, text('Hidden section secret')))
          )
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TABLE_VISIBILITY' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);
      const modelInput = documentModel.blocks.map((block) => block.template).join('\n\n');

      assert.equal(
        original,
        '| Visible heading |\n| --- |\n| Visible cell |\n| Visible sibling |'
      );
      assert.equal(modelInput, original);
      assert.doesNotMatch(`${original}\n${modelInput}`, /secret/i);
    },
  },
  {
    name: 'derives atomic link labels only from visible descendants',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element(
            'a',
            { href: 'https://destination.test/private' },
            text('https://visible.test/guide'),
            element('span', { 'aria-hidden': 'true' }, text('hidden-link-secret'))
          )
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_ATOMIC_VISIBLE' }
      );
      const modelInput = documentModel.blocks[0].template;
      const original = markdown.renderOriginalMarkdown(documentModel);

      assert.equal(
        original,
        '[https://visible.test/guide](<https://destination.test/private>)'
      );
      assert.match(modelInput, /^⟦CAT_ATOMIC_VISIBLE:ATOM:C1⟧$/);
      assert.equal(documentModel.entries[0].value, 'https://visible.test/guide');
      assert.doesNotMatch(JSON.stringify(documentModel.entries), /hidden-link-secret/);
      assert.doesNotMatch(`${original}\n${modelInput}`, /hidden-link-secret/);
    },
  },
  {
    name: 'derives inline and fenced code values only from visible descendants',
    fn() {
      const { document, element, text } = createTestDocument();
      document.defaultView = {
        getComputedStyle(node) {
          return {
            display: node.getAttribute?.('data-display') || 'inline',
            visibility: 'visible',
            contentVisibility: 'visible',
            opacity: '1',
          };
        },
      };
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          text('Run '),
          element(
            'code',
            {},
            text('visible-command'),
            element('span', { 'data-display': 'none' }, text('inline-secret'))
          ),
          text('.')
        ),
        element(
          'pre',
          {},
          element(
            'code',
            { class: 'language-sh' },
            text('echo visible'),
            element(
              'span',
              { contenteditable: 'true' },
              text('fenced-secret')
            )
          )
        ),
        element(
          'pre',
          {},
          element('code', { hidden: '' }, text('hidden-code-element-secret')),
          text('fallback visible')
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_CODE_VISIBLE' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);
      const modelInput = documentModel.blocks.map((block) => block.template).join('\n\n');

      assert.deepEqual(
        documentModel.entries.map((entry) => entry.value),
        ['visible-command', 'echo visible', 'fallback visible']
      );
      assert.equal(
        original,
        'Run ```visible-command```.\n\n```sh\necho visible\n```\n\n```\nfallback visible\n```'
      );
      assert.doesNotMatch(JSON.stringify(documentModel.entries), /secret/);
      assert.doesNotMatch(`${original}\n${modelInput}`, /secret/);
      assert.doesNotMatch(modelInput, /visible-command|echo visible/);
    },
  },
  {
    name: 'preserves ordered-list start and item values and emits the title once as the first H1',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element('p', {}, text('Introduction.')),
        element('h1', {}, text('Guide')),
        element(
          'ol',
          { start: '3' },
          element('li', {}, text('Third')),
          element('li', { hidden: '' }, text('Hidden fourth')),
          element('li', {}, text('Fifth')),
          element('li', { value: '7' }, text('Seventh')),
          element('li', {}, text('Eighth'))
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        { title: 'Guide' },
        { namespace: 'CAT_LIST_TITLE' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);

      assert.equal(
        original,
        '# Guide\n\nIntroduction.\n\n3. Third\n\n5. Fifth\n\n7. Seventh\n\n8. Eighth'
      );
      assert.equal((original.match(/^# Guide$/gm) || []).length, 1);
      assert.equal(documentModel.blocks[0].kind, 'heading');
      assert.equal(documentModel.blocks[0].level, 1);
    },
  },
  {
    name: 'removes later equivalent H1 blocks when the first H1 already matches the title',
    fn() {
      const { element, text } = createTestDocument();
      const documentModel = markdown.serializeMarkdownDocument(
        element(
          'main',
          {},
          element('h1', {}, text('Guide')),
          element('p', {}, text('Introduction.')),
          element('h1', {}, text('Guide')),
          element('p', {}, text('Details.'))
        ),
        { title: 'Guide' },
        { namespace: 'CAT_TITLE_DEDUP' }
      );
      const original = markdown.renderOriginalMarkdown(documentModel);

      assert.equal(
        original,
        '# Guide\n\nIntroduction.\n\nDetails.'
      );
      assert.equal((original.match(/^# Guide$/gm) || []).length, 1);
      assert.equal(documentModel.blocks[0].originalMarkdown, '# Guide');
    },
  },
  {
    name: 'renders headings blockquotes and rectangular tables',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element('h3', {}, text('Details')),
        element('blockquote', {}, text('Quoted text')),
        element(
          'table',
          {},
          element(
            'tr',
            {},
            element('th', {}, text('Name')),
            element('th', {}, text('Value'))
          ),
          element('tr', {}, element('td', {}, text('One')))
        )
      );

      const result = markdown.renderOriginalMarkdown(
        markdown.serializeMarkdownDocument(root, {}, { namespace: 'CAT_TEST' })
      );

      assert.equal(
        result,
        '### Details\n\n> Quoted text\n\n| Name | Value |\n| --- | --- |\n| One |  |'
      );
    },
  },
  {
    name: 'rehydrates an empty-destination code-like link as a link',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'p',
        {},
        element('a', { href: '' }, text('https://visible.test'))
      );
      const documentModel = markdown.serializeMarkdownDocument(
        element('main', {}, root),
        {},
        { namespace: 'CAT_TEST' }
      );
      const block = documentModel.blocks[0];

      assert.equal(
        markdown.validateAndRehydrateChunk(
          block.template,
          createChunk(documentModel, block)
        ),
        '[https://visible.test](<>)'
      );
    },
  },
  {
    name: 'keeps a natural OpenAI API link label translatable',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element('a', { href: 'https://example.test/api' }, text('OpenAI API'))
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );

      assert.equal(documentModel.blocks[0].template.includes('OpenAI API'), true);
      assert.equal(documentModel.entries[0].kind, 'link');
    },
  },
  {
    name: 'preserves paragraph separation inside a blockquote',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'blockquote',
          {},
          element('p', {}, text('First')),
          element('p', {}, text('Second'))
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );

      assert.equal(documentModel.blocks[0].template, '> First\n>\n> Second');
      assert.equal(
        markdown.renderOriginalMarkdown(documentModel),
        '> First\n>\n> Second'
      );
    },
  },
  {
    name: 'escapes translated wrapper text that could create another link',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element('a', { href: 'https://safe.test' }, text('safe label'))
        )
      );
      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );
      const block = documentModel.blocks[0];
      const link = documentModel.entries[0];
      const output = `${link.openToken}](https://evil.test)[x${link.closeToken}`;

      assert.equal(
        markdown.validateAndRehydrateChunk(
          output,
          createChunk(documentModel, block)
        ),
        '[\\](https://evil.test)\\[x](<https://safe.test>)'
      );
    },
  },
  {
    name: 'resolves relative and fragment destinations against the page URL',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element('a', { href: '../guide' }, text('Relative guide')),
          text(' and '),
          element('a', { href: '#part' }, text('Page section'))
        )
      );
      const documentModel = markdown.serializeMarkdownDocument(
        root,
        { url: 'https://page.test/docs/current/index.html?private=1' },
        { namespace: 'CAT_TEST' }
      );

      assert.deepEqual(
        documentModel.entries.map((entry) => entry.destination),
        [
          'https://page.test/docs/guide',
          'https://page.test/docs/current/index.html?private=1#part',
        ]
      );
      const modelInput = documentModel.blocks[0].template;
      assert.equal(modelInput.includes('../guide'), false);
      assert.equal(modelInput.includes('#part'), false);
      const original = markdown.renderOriginalMarkdown(documentModel);
      assert.equal(original.includes('../guide'), false);
      assert.equal(
        original.includes('https://page.test/docs/guide'),
        true
      );
      assert.equal(
        original.includes(
          'https://page.test/docs/current/index.html?private=1#part'
        ),
        true
      );
    },
  },
  {
    name: 'prefers the effective document base over metadata URL',
    fn() {
      const { document, element, text } = createTestDocument();
      document.baseURI = 'https://assets.test/base/current/';
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element('a', { href: '../guide' }, text('Relative guide'))
        )
      );

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        { url: 'https://page.test/fallback/index.html' },
        { namespace: 'CAT_TEST' }
      );

      assert.equal(
        documentModel.entries[0].destination,
        'https://assets.test/base/guide'
      );
      assert.equal(
        markdown
          .renderOriginalMarkdown(documentModel)
          .includes('https://assets.test/base/guide'),
        true
      );
    },
  },
  {
    name: 'preserves nested lists and tables inside blockquotes',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'blockquote',
          {},
          element('p', {}, text('Intro')),
          element(
            'ol',
            {},
            element(
              'li',
              {},
              text('First'),
              element('ul', {}, element('li', {}, text('Nested')))
            )
          ),
          element(
            'table',
            {},
            element(
              'tr',
              {},
              element('th', {}, text('Name')),
              element('th', {}, text('Value'))
            ),
            element(
              'tr',
              {},
              element('td', {}, text('One')),
              element('td', {}, text('1'))
            )
          )
        )
      );
      const expected = [
        '> Intro',
        '>',
        '> 1. First',
        '>     - Nested',
        '>',
        '> | Name | Value |',
        '> | --- | --- |',
        '> | One | 1 |',
      ].join('\n');

      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );

      assert.equal(documentModel.blocks[0].template, expected);
      assert.equal(markdown.renderOriginalMarkdown(documentModel), expected);
    },
  },
  {
    name: 'escapes malicious visible labels in original and atomic links',
    fn() {
      const { element, text } = createTestDocument();
      const root = element(
        'main',
        {},
        element(
          'p',
          {},
          element(
            'a',
            { href: 'https://safe.test/natural' },
            text('read ](https://evil.test)[ this')
          ),
          text(' and '),
          element(
            'a',
            { href: 'https://safe.test/atomic' },
            text('https://visible.test/](https://evil.test)[x')
          )
        )
      );
      const documentModel = markdown.serializeMarkdownDocument(
        root,
        {},
        { namespace: 'CAT_TEST' }
      );
      const block = documentModel.blocks[0];
      const atomic = documentModel.entries.find((entry) => entry.kind === 'code');
      const original = markdown.renderOriginalMarkdown(documentModel);

      assert.equal(
        original,
        '[read \\](https://evil.test)\\[ this](<https://safe.test/natural>) and [https://visible.test/\\](https://evil.test)\\[x](<https://safe.test/atomic>)'
      );
      assert.equal(
        markdown.validateAndRehydrateChunk(
          block.template,
          createChunk(documentModel, block)
        ),
        '[read \\](https://evil.test)\\[ this](<https://safe.test/natural>) and [https://visible.test/\\](https://evil.test)\\[x](<https://safe.test/atomic>)'
      );
      assert.equal(Boolean(atomic?.destination), true);
    },
  },
  ...['code', 'kbd', 'samp'].map(createProtectedNaturalLinkTest),
];
