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

exports.name = 'full-page Markdown contract';
exports.tests = [
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
    },
  },
];
