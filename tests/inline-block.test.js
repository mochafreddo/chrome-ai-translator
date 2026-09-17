const assert = require('node:assert/strict');
const codec = require('../extension/inline-block.js');

const LINGUISTIC_SLASH_PROSE = Object.freeze([
  'and/or',
  'his/her',
  'input/output',
  'yes/no',
  'he/she',
  'read/write',
  'he/she/they',
  'and/or/both',
  'input/output/error',
  'mattpocock/skills',
  'version1/version2',
  'input/output-v2/error',
  'alpha/beta2/gamma',
]);

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

    get isConnected() {
      let current = this;
      while (current?.parentNode) current = current.parentNode;
      return current?.nodeType === 9;
    }

    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map((child) => child.textContent).join('');
    }

    set textContent(value) {
      this.replaceChildren(this.ownerDocument.createTextNode(value));
    }

    appendChild(node) {
      if (node.parentNode) node.parentNode.removeChild(node);
      this.childNodes.push(node);
      node.parentNode = this;
      return node;
    }

    insertBefore(node, reference) {
      if (reference == null) return this.appendChild(node);
      if (node.parentNode) node.parentNode.removeChild(node);
      const index = this.childNodes.indexOf(reference);
      if (index < 0) throw new Error('reference is not a child');
      this.childNodes.splice(index, 0, node);
      node.parentNode = this;
      return node;
    }

    removeChild(node) {
      const index = this.childNodes.indexOf(node);
      if (index < 0) throw new Error('node is not a child');
      this.childNodes.splice(index, 1);
      node.parentNode = null;
      return node;
    }

    replaceChildren(...nodes) {
      if (this.throwOnNextReplace) {
        this.throwOnNextReplace = false;
        throw new Error('synthetic replace failure');
      }
      for (const child of [...this.childNodes]) this.removeChild(child);
      for (const node of nodes) this.appendChild(node);
    }
  }

  class TestText extends TestNode {
    constructor(value, ownerDocument) {
      super(3, ownerDocument);
      this.nodeValue = String(value);
    }
  }

  class TestComment extends TestNode {
    constructor(value, ownerDocument) {
      super(8, ownerDocument);
      this.nodeValue = String(value);
    }
  }

  class TestElement extends TestNode {
    constructor(tagName, ownerDocument) {
      super(1, ownerDocument);
      this.tagName = String(tagName).toUpperCase();
      this.attributes = new Map();
      this.hidden = false;
    }

    getAttribute(name) {
      return this.attributes.get(String(name).toLowerCase()) ?? null;
    }

    hasAttribute(name) {
      return this.attributes.has(String(name).toLowerCase());
    }

    getAttributeNames() {
      return Array.from(this.attributes.keys());
    }

    setAttribute(name, value) {
      this.attributes.set(String(name).toLowerCase(), String(value));
    }

    closest() {
      return null;
    }

    getBoundingClientRect() {
      return this.rect || {
        top: 20,
        bottom: 44,
        left: 10,
        right: 300,
        width: 290,
        height: 24,
      };
    }
  }

  class TestDocument extends TestNode {
    constructor() {
      super(9, null);
      this.ownerDocument = this;
      this.defaultView = {
        getComputedStyle(node) {
          return (
            node.computedStyle || {
              display: 'inline',
              visibility: 'visible',
              opacity: '1',
              contentVisibility: 'visible',
            }
          );
        },
      };
      this.body = this.createElement('body');
      this.appendChild(this.body);
    }

    createElement(tagName) {
      return new TestElement(tagName, this);
    }

    createTextNode(value) {
      return new TestText(value, this);
    }

    createComment(value) {
      return new TestComment(value, this);
    }
  }

  const document = new TestDocument();
  const element = (tagName, ...children) => {
    const node = document.createElement(tagName);
    for (const child of children) node.appendChild(child);
    return node;
  };
  const text = (value) => document.createTextNode(value);
  return { document, element, text };
}

function unsupportedBlock(reason, tag) {
  return {
    ok: false,
    errorCode: 'unsupported_block',
    localRejection: tag ? { reason, tag } : { reason },
  };
}

function assertReaderFacingUnsupported(result) {
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unsupported_block');
}

function createReasoningFixture() {
  const { document, element, text } = createTestDocument();
  const strong = element('strong', text('Reasoning models'));
  const link = element('a', text('GPT-5.5'));
  link.setAttribute('href', '/api/docs/models/gpt-5.5');
  const block = element(
    'p',
    strong,
    text(' like '),
    link,
    text(' use internal reasoning tokens.')
  );
  document.body.appendChild(block);
  return { document, block, strong, link, serialized: codec.serializeBlock(block) };
}

function createHeadingControlFixture(trailing = false) {
  const { document, element, text } = createTestDocument();
  const icon = element('svg', element('path'));
  icon.setAttribute('aria-hidden', 'true');
  const link = element('a', text('\u200b'), element('div', icon));
  link.setAttribute('href', '#heading');
  link.setAttribute('aria-label', 'Navigate to header');
  link.computedStyle = { opacity: '0' };
  const control = element('div', link);
  control.rect = { top: 20, bottom: 44, left: 10, right: 10, width: 0, height: 24 };
  const prose = text('Visible heading');
  const block = element('h2', ...(trailing ? [prose, control] : [control, prose]));
  block.setAttribute('id', 'heading');
  document.body.appendChild(block);
  return { document, element, text, block, control, link, icon };
}

exports.name = 'inline block codec';
exports.tests = [
  {
    name: 'refuses apply and restore when data-as changes Semantic Block ownership',
    fn() {
      for (const stage of ['apply', 'restore']) {
        for (const target of ['root', 'descendant']) {
          const { document, element, text } = createTestDocument();
          const wrapper = element('span', text('A paragraph with an inline wrapper.'));
          const block = element('span', wrapper);
          block.setAttribute('data-as', 'p');
          document.body.appendChild(block);
          const serialized = codec.serializeBlock(block);
          assert.equal(serialized.ok, true);
          const entry = serialized.contract.entries[0];
          const plan = codec.createPatchPlan(serialized.snapshot, `${entry.openToken}번역된 문단${entry.closeToken}`);
          assert.equal(plan.ok, true);
          if (stage === 'restore') assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
          if (target === 'root') block.setAttribute('data-as', 'div');
          else wrapper.setAttribute('data-as', 'p');
          const children = [...block.childNodes];
          const content = block.textContent;
          if (stage === 'apply') {
            assert.equal(codec.createPatchPlan(serialized.snapshot, plan.translatedTemplate).errorCode, 'block_changed');
            assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).errorCode, 'block_changed');
          } else {
            assert.equal(codec.restoreBlock(serialized.snapshot).errorCode, 'block_changed');
          }
          assert.deepEqual(block.childNodes, children);
          assert.equal(block.textContent, content);
        }
      }
    },
  },
  {
    name: 'pins trailing heading controls while preserving their original objects',
    fn() {
      const { block, control, link } = createHeadingControlFixture(true);
      const original = [...block.childNodes];
      const serialized = codec.serializeBlock(block);
      assert.equal(serialized.ok, true);
      assert.equal(serialized.template, 'Visible heading');
      assert.deepEqual(serialized.atoms, []);
      assert.deepEqual(serialized.contract.entries, []);
      assert.equal(codec.applyPatchPlan(serialized.snapshot,
        codec.createPatchPlan(serialized.snapshot, '번역된 제목')).ok, true);
      assert.equal(block.childNodes.at(-1), control);
      assert.equal(control.childNodes[0], link);
      assert.equal(codec.restoreBlock(serialized.snapshot).ok, true);
      assert.deepEqual(block.childNodes, original);
    },
  },
  {
    name: 'does not let heading controls bypass hidden prose or interactive exclusions',
    fn() {
      const mutations = [
        ({ control, element, text }) => { const hidden = element('span', text('Secret prose')); hidden.hidden = true; control.appendChild(hidden); },
        ({ link, text }) => link.appendChild(text('Ordinary prose link')),
        ({ control }) => control.setAttribute('contenteditable', 'true'),
        ({ control, element }) => control.appendChild(element('button')),
        ({ control, element }) => { const interactive = element('span'); interactive.setAttribute('role', 'checkbox'); control.appendChild(interactive); },
        ({ link }) => link.setAttribute('href', '#another-heading'),
        ({ link }) => link.setAttribute('href', '#%broken'),
        ({ link }) => link.setAttribute('aria-label', ''),
        ({ control, element }) => control.appendChild(element('my-control')),
        ({ block, element, text }) => { const hidden = element('span', text('Hidden heading prose')); hidden.hidden = true; block.appendChild(hidden); },
        ({ block, control, text }) => block.insertBefore(text('Interior '), control),
        ({ block }) => { block.tagName = 'P'; },
      ];
      for (const mutate of mutations) {
        const fixture = createHeadingControlFixture();
        mutate(fixture);
        assertReaderFacingUnsupported(codec.serializeBlock(fixture.block));
      }
    },
  },
  {
    name: 'rejects changed heading control ownership before apply and restore',
    fn() {
      for (const afterApply of [false, true]) {
        for (const change of ['replace-control', 'replace-icon', 'hidden-prose', 'editable', 'destination']) {
          const fixture = createHeadingControlFixture();
          const { block, control, link, icon, element, text } = fixture;
          const serialized = codec.serializeBlock(block);
          assert.equal(serialized.ok, true);
          const plan = codec.createPatchPlan(serialized.snapshot, '번역된 제목');
          assert.equal(plan.ok, true);
          if (afterApply) assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
          if (change === 'replace-control') {
            const replacement = createHeadingControlFixture().control;
            block.insertBefore(replacement, control);
            block.removeChild(control);
          } else if (change === 'replace-icon') {
            icon.replaceChildren(element('path'));
          } else if (change === 'hidden-prose') {
            const hidden = element('span', text('New hidden prose')); hidden.hidden = true; link.appendChild(hidden);
          } else if (change === 'editable') {
            link.setAttribute('contenteditable', 'true');
          } else {
            link.setAttribute('href', '#different');
          }
          const changedChildren = [...block.childNodes];
          const changedText = block.textContent;
          const result = afterApply ? codec.restoreBlock(serialized.snapshot) : codec.applyPatchPlan(serialized.snapshot, plan);
          assert.deepEqual(result, { ok: false, errorCode: 'block_changed' }, `${change}, applied=${afterApply}`);
          assert.deepEqual(block.childNodes, changedChildren);
          assert.equal(block.textContent, changedText);
        }
      }
    },
  },
  {
    name: 'names every local preflight rejection with a safe tag only',
    fn() {
      const { document, element, text } = createTestDocument();

      const invalidRoot = element('div', text('Not a semantic block.'));
      document.body.appendChild(invalidRoot);
      assert.deepEqual(
        codec.serializeBlock(invalidRoot),
        unsupportedBlock('invalid_root', 'DIV')
      );

      const hidden = element('p', text('Hidden article prose.'));
      hidden.hidden = true;
      document.body.appendChild(hidden);
      assert.deepEqual(
        codec.serializeBlock(hidden),
        unsupportedBlock('hidden_content', 'P')
      );

      const editable = element('p', text('Draft article prose.'));
      editable.setAttribute('contenteditable', 'true');
      document.body.appendChild(editable);
      assert.deepEqual(
        codec.serializeBlock(editable),
        unsupportedBlock('editable_content', 'P')
      );

      const interactive = element(
        'p',
        text('Press '),
        element('button', text('Save')),
        text('.')
      );
      document.body.appendChild(interactive);
      assert.deepEqual(
        codec.serializeBlock(interactive),
        unsupportedBlock('interactive_content', 'BUTTON')
      );

      const custom = document.createElement('my-widget');
      custom.appendChild(text('Custom widget copy.'));
      const withCustom = element('p', text('See '), custom, text('.'));
      document.body.appendChild(withCustom);
      assert.deepEqual(
        codec.serializeBlock(withCustom),
        unsupportedBlock('custom_element')
      );
      assert.equal(
        JSON.stringify(codec.serializeBlock(withCustom)).includes('MY-WIDGET'),
        false
      );

      const nested = element(
        'li',
        text('Outer item text.'),
        element('p', text('Nested paragraph text.'))
      );
      document.body.appendChild(nested);
      assert.deepEqual(
        codec.serializeBlock(nested),
        unsupportedBlock('nested_semantic_block', 'P')
      );

      const descendant = element(
        'p',
        text('Leading '),
        element('div', text('boxed')),
        text(' text.')
      );
      document.body.appendChild(descendant);
      assert.deepEqual(
        codec.serializeBlock(descendant),
        unsupportedBlock('unsupported_descendant', 'DIV')
      );

      let child = text('Deep article text.');
      for (let index = 0; index < 12000; index += 1) {
        child = element('span', child);
      }
      const limited = element('p', child);
      document.body.appendChild(limited);
      assert.deepEqual(
        codec.serializeBlock(limited),
        unsupportedBlock('structure_limit_exceeded', 'P')
      );

      const empty = element('p', text('   '));
      document.body.appendChild(empty);
      assert.deepEqual(
        codec.serializeBlock(empty),
        unsupportedBlock('empty_content', 'P')
      );
    },
  },
  {
    name: 'preserves React separator comments through apply and restore',
    fn() {
      const { document, element, text } = createTestDocument();
      const directComment = document.createComment(' ');
      const codeComment = document.createComment(' ');
      const code = element('code', text('/'), codeComment, text('skill'));
      const block = element(
        'p',
        text('Run '),
        directComment,
        code,
        text('.')
      );
      document.body.appendChild(block);
      const originalChildren = [...block.childNodes];
      const originalCodeChildren = [...code.childNodes];

      const serialized = codec.serializeBlock(block);
      assert.equal(serialized.ok, true);
      const translated = `실행 ${serialized.contract.entries
        .map((entry) => entry.token)
        .filter(Boolean)
        .join('')}.`;
      const plan = codec.createPatchPlan(serialized.snapshot, translated);
      assert.equal(plan.ok, true);
      assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
      assert.equal(directComment.parentNode, block);
      assert.equal(codeComment.parentNode, code);
      assert.equal(codec.restoreBlock(serialized.snapshot).ok, true);
      assert.deepEqual(block.childNodes, originalChildren);
      assert.deepEqual(code.childNodes, originalCodeChildren);
    },
  },
  {
    name: 'preserves text-free image and SVG decorations but rejects hidden prose',
    fn() {
      const { document, element, text } = createTestDocument();
      const image = element('img');
      image.setAttribute('alt', '');
      const heading = element('h1', image, text('Title'));
      const icon = element('svg', element('path'));
      icon.setAttribute('aria-hidden', 'true');
      const paragraph = element('p', icon, text('Privacy'));
      document.body.appendChild(heading);
      document.body.appendChild(paragraph);

      for (const [block, decoration] of [
        [heading, image],
        [paragraph, icon],
      ]) {
        const originalChildren = [...block.childNodes];
        const serialized = codec.serializeBlock(block);
        assert.equal(serialized.ok, true);
        const atom = serialized.contract.entries.find(
          (entry) => entry.kind === 'atom'
        );
        assert.ok(atom);
        const plan = codec.createPatchPlan(
          serialized.snapshot,
          `${atom.token} 번역`
        );
        assert.equal(plan.ok, true);
        assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
        assert.equal(decoration.parentNode, block);
        assert.equal(codec.restoreBlock(serialized.snapshot).ok, true);
        assert.deepEqual(block.childNodes, originalChildren);
      }

      const hidden = element('span', text('Hidden prose'));
      hidden.setAttribute('aria-hidden', 'true');
      const unsafe = element('p', text('Visible prose'), hidden);
      document.body.appendChild(unsafe);
      assert.deepEqual(
        codec.serializeBlock(unsafe),
        unsupportedBlock('hidden_content', 'SPAN')
      );
    },
  },
  {
    name: 'rejects image and SVG nodes that are not inert',
    fn() {
      for (const makeDecoration of [
        ({ element }) => {
          const image = element('img');
          image.setAttribute('alt', 'Architecture diagram');
          return image;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('aria-label', 'Open menu');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('aria-hidden', 'false');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('tabindex', '0');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('tabindex', '-1');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('focusable', 'true');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('focusable', 'false');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('aria-valuetext', 'Half');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('onclick', 'openMenu()');
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.onclick = () => {};
          return icon;
        },
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('role', 'link');
          return icon;
        },
        ...['img', 'presentation', 'none', 'generic'].map((role) =>
          ({ element }) => {
            const icon = element('svg', element('path'));
            icon.setAttribute('role', role);
            return icon;
          }
        ),
        ({ element }) => {
          const icon = element('svg', element('path'));
          icon.setAttribute('onkeydown', 'openMenu()');
          return icon;
        },
        ({ element }) => {
          const editable = element('span');
          editable.setAttribute('contenteditable', 'true');
          return element('svg', editable);
        },
      ]) {
        const { document, element, text } = createTestDocument();
        const block = element(
          'p',
          makeDecoration({ element }),
          text('Visible prose')
        );
        document.body.appendChild(block);
        assertReaderFacingUnsupported(codec.serializeBlock(block));
      }
    },
  },
  {
    name: 'classifies protected technical link labels conservatively',
    fn() {
      assert.equal(codec.isProtectedAtomicLinkLabel('GPT-5.5'), true);
      assert.equal(codec.isProtectedAtomicLinkLabel('Responses API'), true);
      assert.equal(codec.isProtectedAtomicLinkLabel('Codex CLI'), true);
      assert.equal(codec.isProtectedAtomicLinkLabel('ChatGPT'), true);
      assert.equal(codec.isProtectedAtomicLinkLabel('API reference'), false);
      assert.equal(codec.isProtectedAtomicLinkLabel('learn more'), false);
      assert.equal(codec.isProtectedAtomicLinkLabel('Read 2 examples'), false);
      assert.equal(codec.isProtectedAtomicLinkLabel('Version 5 overview'), false);
      assert.equal(codec.isProtectedAtomicLinkLabel('Model o3'), true);
    },
  },
  {
    name: 'preserves Source Syntax while allowing linguistic slash prose to translate',
    fn() {
      const { document, element, text } = createTestDocument();
      const repositoryLink = element('a', text('mattpocock/skills'));
      repositoryLink.setAttribute(
        'href',
        'https://github.com/mattpocock/skills'
      );
      const repository = element('dd', repositoryLink);
      document.body.appendChild(repository);
      const serialized = codec.serializeBlock(repository);
      assert.equal(serialized.ok, true);
      const link = serialized.contract.entries.find(
        (entry) => entry.tagName === 'A'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${link.openToken}저장소 mattpocock/skills${link.closeToken}`,
          serialized.contract
        ).ok,
        true
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${link.openToken}mattpocock/skills는 저장소${link.closeToken}`,
          serialized.contract
        ).ok,
        true
      );
      assert.deepEqual(
        codec.validateTranslatedTemplate(
          `${link.openToken}저장소 other/project${link.closeToken}`,
          serialized.contract
        ),
        { ok: false, errorCode: 'source_syntax_changed' }
      );

      for (const [source, changedValues] of [
        [
          '/usr/local/bin',
          ['usr/local/bin', '/usr/local/bin-old', '/usr/local/bin/extra'],
        ],
        ['./docs/guide.md', ['docs/guide.md']],
        ['문서/안내.md', ['docs/guide.md']],
        ['README.md', ['README.txt', 'README.md-old']],
      ]) {
        const syntax = element('p', text(source));
        document.body.appendChild(syntax);
        const syntaxRecord = codec.serializeBlock(syntax);
        assert.equal(syntaxRecord.ok, true);
        for (const changed of changedValues) {
          assert.deepEqual(
            codec.validateTranslatedTemplate(
              changed,
              syntaxRecord.contract
            ),
            { ok: false, errorCode: 'source_syntax_changed' },
            `${source} -> ${changed}`
          );
        }
      }

      const punctuatedPath = element('p', text('Run /usr/local/bin.'));
      document.body.appendChild(punctuatedPath);
      const punctuatedRecord = codec.serializeBlock(punctuatedPath);
      assert.equal(punctuatedRecord.ok, true);
      assert.deepEqual(punctuatedRecord.contract.sourceSyntax, [
        { value: '/usr/local/bin', count: 1 },
      ]);

      for (const source of LINGUISTIC_SLASH_PROSE) {
        const prose = element('p', text(`Choose ${source}.`));
        document.body.appendChild(prose);
        const proseRecord = codec.serializeBlock(prose);
        assert.equal(proseRecord.ok, true);
        assert.equal(
          codec.validateTranslatedTemplate(
            '하나를 선택하세요.',
            proseRecord.contract
          ).ok,
          true,
          source
        );
      }
    },
  },
  {
    name: 'serializes the reported reasoning sentence as one protected template',
    fn() {
      const { block, strong, link, serialized: result } = createReasoningFixture();

      assert.equal(result.ok, true);
      assert.match(result.template, /OPEN/);
      assert.match(result.template, /Reasoning models/);
      assert.match(result.template, /CLOSE/);
      assert.match(result.template, / like /);
      assert.match(result.template, /ATOM/);
      assert.match(result.template, / use internal reasoning tokens\./);
      assert.equal(result.template.includes('GPT-5.5'), false);
      assert.deepEqual(result.atoms, [
        {
          token: result.contract.entries.find((entry) => entry.kind === 'atom')
            .token,
          kind: 'protected-link',
          label: 'GPT-5.5',
          preserveText: true,
        },
      ]);
      assert.equal(result.snapshot.blockElement, block);
      assert.equal(result.snapshot.entries.get('W1').node, strong);
      assert.equal(result.snapshot.entries.get('A1').node, link);
    },
  },
  {
    name: 'accepts grammatical sibling token reordering',
    fn() {
      const { serialized } = createReasoningFixture();
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const translated = `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;

      const result = codec.validateTranslatedTemplate(
        translated,
        serialized.contract
      );

      assert.equal(result.ok, true);
      assert.equal(result.tree.children[0].id, atom.id);
      assert.equal(result.tree.children[1].type, 'text');
      assert.equal(result.tree.children[2].id, wrapper.id);
    },
  },
  {
    name: 'rejects missing duplicate unknown and unbalanced tokens',
    fn() {
      const { serialized } = createReasoningFixture();
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );

      assert.equal(
        codec.validateTranslatedTemplate(
          serialized.template.replace(atom.token, ''),
          serialized.contract
        ).errorCode,
        'token_missing'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${serialized.template}${atom.token}`,
          serialized.contract
        ).errorCode,
        'token_duplicate'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          serialized.template.replace(
            atom.token,
            `⟦${serialized.contract.namespace}:ATOM:A999⟧`
          ),
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${serialized.template}⟦${serialized.contract.namespace}:BOGUS:X1⟧`,
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          serialized.template
            .replace(wrapper.openToken, '')
            .replace(wrapper.closeToken, `${wrapper.closeToken}${wrapper.openToken}`),
          serialized.contract
        ).errorCode,
        'token_nesting_invalid'
      );
    },
  },
  {
    name: 'rejects unterminated active and injected foreign tokens',
    fn() {
      const { serialized } = createReasoningFixture();

      assert.equal(
        codec.validateTranslatedTemplate(
          `${serialized.template}⟦${serialized.contract.namespace}:ATOM:A999`,
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${serialized.template}⟦FORGED:ATOM:X1⟧`,
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${serialized.template}⟦FORGED:ATOM:X1`,
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
    },
  },
  {
    name: 'allows token-shaped literals that were present in source text',
    fn() {
      const { document, element, text } = createTestDocument();
      const literal = 'Literal ⟦FORGED:ATOM:X1⟧ remains text.';
      const block = element('p', text(literal));
      document.body.appendChild(block);
      const serialized = codec.serializeBlock(block);

      assert.equal(serialized.ok, true);
      assert.equal(
        codec.validateTranslatedTemplate(literal, serialized.contract).ok,
        true
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${literal} ⟦FORGED:ATOM:X1⟧`,
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
    },
  },
  {
    name: 'allows only source-owned unterminated token-shaped literals',
    fn() {
      const { document, element, text } = createTestDocument();
      const literal = 'Literal ⟦FORGED:ATOM:X1 remains text.';
      const block = element('p', text(literal));
      document.body.appendChild(block);
      const serialized = codec.serializeBlock(block);

      assert.equal(serialized.ok, true);
      assert.equal(
        codec.validateTranslatedTemplate(literal, serialized.contract).ok,
        true
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${literal} ⟦FORGED:ATOM:X1 remains text.`,
          serialized.contract
        ).errorCode,
        'token_unknown'
      );
    },
  },
  {
    name: 'rejects moving a nested wrapper outside its original parent',
    fn() {
      const { document, element, text } = createTestDocument();
      const link = element('a', text('documentation guide'));
      const strong = element('strong', text('Read the '), link);
      const block = element('p', strong, text(' before continuing.'));
      document.body.appendChild(block);
      const serialized = codec.serializeBlock(block);
      const outer = serialized.contract.entries.find(
        (entry) => entry.parentId === 'ROOT' && entry.kind === 'wrapper'
      );
      const inner = serialized.contract.entries.find(
        (entry) => entry.parentId === outer.id
      );
      const translated = `${outer.openToken}문서를 읽으세요${outer.closeToken}${inner.openToken}가이드${inner.closeToken}`;

      assert.equal(
        codec.validateTranslatedTemplate(translated, serialized.contract)
          .errorCode,
        'token_parent_changed'
      );
    },
  },
  {
    name: 'rejects translated templates beyond the record output budget',
    fn() {
      const { serialized } = createReasoningFixture();
      const translated = `${serialized.template}${'x'.repeat(
        serialized.contract.maxOutputChars
      )}`;

      assert.equal(
        codec.validateTranslatedTemplate(translated, serialized.contract)
          .errorCode,
        'output_too_long'
      );
    },
  },
  {
    name: 'rejects empty translated content outside protected tokens',
    fn() {
      const { document, element, text } = createTestDocument();
      const plainBlock = element('p', text('Translate this paragraph.'));
      document.body.appendChild(plainBlock);
      const plain = codec.serializeBlock(plainBlock);
      const { serialized } = createReasoningFixture();
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );

      assert.equal(
        codec.validateTranslatedTemplate('', plain.contract).errorCode,
        'output_parse_failed'
      );
      assert.equal(
        codec.validateTranslatedTemplate(
          `${atom.token}${wrapper.openToken}${wrapper.closeToken}`,
          serialized.contract
        ).errorCode,
        'output_parse_failed'
      );
    },
  },
  {
    name: 'reorders existing elements and restores the exact original node graph',
    fn() {
      const { block, strong, link, serialized } = createReasoningFixture();
      const originalBlockChildren = [...block.childNodes];
      const originalStrongChildren = [...strong.childNodes];
      const originalLinkChildren = [...link.childNodes];
      const listenerIdentity = {};
      link.listenerIdentity = listenerIdentity;
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const translated = `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;

      const plan = codec.createPatchPlan(serialized.snapshot, translated);

      assert.equal(plan.ok, true);
      assert.deepEqual(block.childNodes, originalBlockChildren);
      assert.equal(block.textContent, 'Reasoning models like GPT-5.5 use internal reasoning tokens.');

      const applied = codec.applyPatchPlan(serialized.snapshot, plan);

      assert.equal(applied.ok, true);
      assert.equal(block.childNodes[0], link);
      assert.equal(block.childNodes[2], strong);
      assert.equal(link.textContent, 'GPT-5.5');
      assert.equal(strong.textContent, '추론 모델');
      assert.equal(link.getAttribute('href'), '/api/docs/models/gpt-5.5');
      assert.equal(link.listenerIdentity, listenerIdentity);

      const restored = codec.restoreBlock(serialized.snapshot);

      assert.equal(restored.ok, true);
      assert.deepEqual(block.childNodes, originalBlockChildren);
      assert.deepEqual(strong.childNodes, originalStrongChildren);
      assert.deepEqual(link.childNodes, originalLinkChildren);
      assert.equal(block.textContent, 'Reasoning models like GPT-5.5 use internal reasoning tokens.');
    },
  },
  {
    name: 'rolls back the original graph when synchronous application fails',
    fn() {
      const { block, strong, serialized } = createReasoningFixture();
      const originalBlockChildren = [...block.childNodes];
      const originalStrongChildren = [...strong.childNodes];
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const plan = codec.createPatchPlan(
        serialized.snapshot,
        `${atom.token} ${wrapper.openToken}번역${wrapper.closeToken}`
      );
      block.throwOnNextReplace = true;

      const applied = codec.applyPatchPlan(serialized.snapshot, plan);

      assert.deepEqual(applied, { ok: false, errorCode: 'apply_failed' });
      assert.deepEqual(block.childNodes, originalBlockChildren);
      assert.deepEqual(strong.childNodes, originalStrongChildren);
      assert.equal(block.textContent, 'Reasoning models like GPT-5.5 use internal reasoning tokens.');
    },
  },
  {
    name: 'refuses restore after equivalent text is replaced by page-owned nodes',
    fn() {
      const { document, block, serialized } = createReasoningFixture();
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const plan = codec.createPatchPlan(
        serialized.snapshot,
        `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}`
      );
      assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
      const translatedText = block.childNodes[1];
      const pageOwnedCopy = document.createTextNode(translatedText.nodeValue);
      block.childNodes.splice(1, 1, pageOwnedCopy);
      translatedText.parentNode = null;
      pageOwnedCopy.parentNode = block;

      const restored = codec.restoreBlock(serialized.snapshot);

      assert.deepEqual(restored, { ok: false, errorCode: 'block_changed' });
      assert.equal(block.childNodes[1], pageOwnedCopy);
    },
  },
  {
    name: 'rejects equivalent page-owned replacements inside atoms before apply',
    fn() {
      const { document, link, serialized } = createReasoningFixture();
      link.replaceChildren(document.createTextNode('GPT-5.5'));

      assert.deepEqual(
        codec.createPatchPlan(serialized.snapshot, serialized.template),
        { ok: false, errorCode: 'block_changed' }
      );
    },
  },
  {
    name: 'refuses restore after equivalent page-owned replacements inside atoms',
    fn() {
      const { document, link, serialized } = createReasoningFixture();
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const plan = codec.createPatchPlan(
        serialized.snapshot,
        `${atom.token} ${wrapper.openToken}번역${wrapper.closeToken}`
      );
      assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
      const pageOwnedText = document.createTextNode('GPT-5.5');
      link.replaceChildren(pageOwnedText);

      assert.deepEqual(codec.restoreBlock(serialized.snapshot), {
        ok: false,
        errorCode: 'block_changed',
      });
      assert.equal(link.childNodes[0], pageOwnedText);
    },
  },
  {
    name: 'rejects apply and restore after classification state changes',
    fn() {
      const firstFixture = createReasoningFixture();
      const firstRecord = firstFixture.serialized;
      firstFixture.strong.hidden = true;

      assert.deepEqual(
        codec.createPatchPlan(
          firstRecord.snapshot,
          firstRecord.template
        ),
        { ok: false, errorCode: 'block_changed' }
      );

      const secondFixture = createReasoningFixture();
      const wrapper = secondFixture.serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = secondFixture.serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const plan = codec.createPatchPlan(
        secondFixture.serialized.snapshot,
        `${atom.token} ${wrapper.openToken}번역${wrapper.closeToken}`
      );
      assert.equal(
        codec.applyPatchPlan(secondFixture.serialized.snapshot, plan).ok,
        true
      );
      secondFixture.strong.setAttribute('contenteditable', 'true');

      assert.deepEqual(codec.restoreBlock(secondFixture.serialized.snapshot), {
        ok: false,
        errorCode: 'block_changed',
      });
    },
  },
  {
    name: 'rejects a semantic block that is already hidden or editable',
    fn() {
      const hiddenFixture = createReasoningFixture();
      hiddenFixture.block.hidden = true;
      const editableFixture = createReasoningFixture();
      editableFixture.block.setAttribute('contenteditable', 'true');

      assertReaderFacingUnsupported(codec.serializeBlock(hiddenFixture.block));
      assertReaderFacingUnsupported(codec.serializeBlock(editableFixture.block));
    },
  },
  {
    name: 'rejects blocks that inherit an editable ancestor',
    fn() {
      const { document, element, text } = createTestDocument();
      const block = element('p', text('Unpublished draft text.'));
      const editor = element('div', block);
      editor.setAttribute('contenteditable', 'true');
      document.body.appendChild(editor);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'allows an explicit non-editable island inside an editor',
    fn() {
      const { document, element, text } = createTestDocument();
      const block = element('p', text('Published reference text.'));
      const island = element('div', block);
      island.setAttribute('contenteditable', 'false');
      const editor = element('div', island);
      editor.setAttribute('contenteditable', 'true');
      document.body.appendChild(editor);

      assert.equal(codec.serializeBlock(block).ok, true);
    },
  },
  {
    name: 'detects editable ancestor changes before apply and restore',
    fn() {
      const beforeApply = createReasoningFixture();
      beforeApply.document.body.setAttribute('contenteditable', 'true');
      assert.deepEqual(
        codec.createPatchPlan(
          beforeApply.serialized.snapshot,
          beforeApply.serialized.template
        ),
        { ok: false, errorCode: 'block_changed' }
      );

      const beforeRestore = createReasoningFixture();
      const wrapper = beforeRestore.serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const atom = beforeRestore.serialized.contract.entries.find(
        (entry) => entry.kind === 'atom'
      );
      const plan = codec.createPatchPlan(
        beforeRestore.serialized.snapshot,
        `${atom.token} ${wrapper.openToken}번역${wrapper.closeToken}`
      );
      assert.equal(
        codec.applyPatchPlan(beforeRestore.serialized.snapshot, plan).ok,
        true
      );
      beforeRestore.document.body.setAttribute('contenteditable', 'true');

      assert.deepEqual(codec.restoreBlock(beforeRestore.serialized.snapshot), {
        ok: false,
        errorCode: 'block_changed',
      });
    },
  },
  {
    name: 'rejects CSS-hidden descendants instead of serializing hidden text',
    fn() {
      const { document, element, text } = createTestDocument();
      const hidden = element('span', text('hidden diagnostic value'));
      hidden.computedStyle = {
        display: 'none',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
      };
      const block = element(
        'p',
        text('Visible documentation text. '),
        hidden
      );
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'preserves a CSS-hidden responsive alternative label outside the model template',
    fn() {
      for (const hiddenLabel of ['short', 'long']) {
        const { document, element, text } = createTestDocument();
        const shortText = text('/implement');
        const short = element('span', shortText);
        short.setAttribute('class', 'mobile-label min-[901px]:hidden');
        const longText = text('The /implement Skill');
        const long = element('span', longText);
        long.setAttribute(
          'class',
          'desktop-label hidden min-[901px]:inline'
        );
        const hidden = hiddenLabel === 'short' ? short : long;
        const visible = hiddenLabel === 'short' ? long : short;
        hidden.computedStyle = {
          display: 'none',
          visibility: 'visible',
          opacity: '1',
          contentVisibility: 'visible',
        };
        visible.computedStyle = {
          display: 'inline',
          visibility: 'visible',
          opacity: '1',
          contentVisibility: 'visible',
        };
        const labels = element('span', short, long);
        const block = element('p', labels);
        document.body.appendChild(block);
        const originalBlockChildren = [...block.childNodes];
        const originalLabelChildren = [...labels.childNodes];
        const hiddenChildren = [...hidden.childNodes];
        const hiddenClass = hidden.getAttribute('class');

        const serialized = codec.serializeBlock(block);

        assert.equal(serialized.ok, true, hiddenLabel);
        assert.equal(serialized.template.includes(visible.textContent), true);
        assert.equal(
          serialized.template.split(hidden.textContent).length - 1,
          visible.textContent.includes(hidden.textContent) ? 1 : 0
        );
        const hiddenEntry = serialized.contract.entries.find(
          (entry) => entry.kind === 'atom' && entry.tagName === 'SPAN'
        );
        assert.ok(hiddenEntry);
        assert.equal(serialized.atoms.find(
          (atom) => atom.token === hiddenEntry.token
        )?.preserveText, false);

        const plan = codec.createPatchPlan(
          serialized.snapshot,
          serialized.template.replace(
            visible.textContent,
            hiddenLabel === 'short'
              ? '번역된 /implement 스킬'
              : '/implement 번역'
          )
        );
        assert.equal(plan.ok, true);
        assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
        assert.equal(hidden.parentNode, labels);
        assert.equal(hidden.childNodes[0], hiddenChildren[0]);
        assert.equal(hidden.getAttribute('class'), hiddenClass);
        assert.equal(hidden.textContent, hiddenLabel === 'short'
          ? '/implement'
          : 'The /implement Skill');

        assert.equal(codec.restoreBlock(serialized.snapshot).ok, true);
        assert.deepEqual(block.childNodes, originalBlockChildren);
        assert.deepEqual(labels.childNodes, originalLabelChildren);
        assert.deepEqual(hidden.childNodes, hiddenChildren);
        assert.equal(short.childNodes[0], shortText);
        assert.equal(long.childNodes[0], longText);
      }
    },
  },
  {
    name: 'does not treat unsafe hidden prose as a responsive alternative label',
    fn() {
      const unsafeMutations = [
        ({ hidden }) => hidden.setAttribute('aria-label', 'Accessible label'),
        ({ hidden }) => hidden.setAttribute('contenteditable', 'true'),
        ({ hidden, element }) => hidden.appendChild(element('button')),
        ({ hidden, element }) => {
          const action = element('span');
          action.setAttribute('onclick', 'run()');
          hidden.appendChild(action);
        },
      ];
      for (const mutate of unsafeMutations) {
        const { document, element, text } = createTestDocument();
        const visible = element('span', text('The /implement Skill'));
        visible.setAttribute('class', 'hidden min-[901px]:inline');
        const hidden = element('span', text('/implement'));
        hidden.setAttribute('class', 'min-[901px]:hidden');
        hidden.computedStyle = {
          display: 'none',
          visibility: 'visible',
          opacity: '1',
          contentVisibility: 'visible',
        };
        mutate({ hidden, element });
        const block = element('p', element('span', hidden, visible));
        document.body.appendChild(block);

        assertReaderFacingUnsupported(codec.serializeBlock(block));
      }

      const { document, element, text } = createTestDocument();
      const hiddenProse = element('span', text('Unrelated private prose'));
      hiddenProse.computedStyle = {
        display: 'none',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
      };
      const arbitrary = element(
        'p',
        text('Visible documentation text. '),
        hiddenProse
      );
      document.body.appendChild(arbitrary);
      assertReaderFacingUnsupported(codec.serializeBlock(arbitrary));

      const pairedVisible = element('span', text('Visible label'));
      const pairedHidden = element('span', text('Unrelated private prose'));
      pairedHidden.computedStyle = {
        display: 'none',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
      };
      const arbitraryPair = element(
        'p',
        element('span', pairedHidden, pairedVisible)
      );
      document.body.appendChild(arbitraryPair);
      assertReaderFacingUnsupported(codec.serializeBlock(arbitraryPair));
    },
  },
  {
    name: 'rejects hidden descendants inside atomic code elements',
    fn() {
      const { document, element, text } = createTestDocument();
      const hidden = element('span', text('SECRET_ACCOUNT_123'));
      hidden.hidden = true;
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects aria-hidden descendants inside protected links',
    fn() {
      const { document, element, text } = createTestDocument();
      const hidden = element('span', text('SECRET'));
      hidden.setAttribute('aria-hidden', 'true');
      const link = element('a', text('GPT-5.5'), hidden);
      const block = element('p', text('Use '), link, text(' today.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects clipped accessibility-only descendants inside atoms',
    fn() {
      const { document, element, text } = createTestDocument();
      const hidden = element('span', text('SCREEN_READER_SECRET'));
      hidden.computedStyle = {
        display: 'inline',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'absolute',
        overflow: 'hidden',
        clip: 'rect(0px, 0px, 0px, 0px)',
        clipPath: 'none',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 0,
        bottom: 1,
        left: 0,
        right: 1,
        width: 1,
        height: 1,
      };
      const code = element('code', text('public-value'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects zero-area transformed descendants inside atoms',
    fn() {
      const { document, element, text } = createTestDocument();
      const hidden = element('span', text('SECRET_SCALE'));
      hidden.computedStyle = {
        display: 'inline',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(0, 0, 0, 0, 0, 0)',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 20,
        bottom: 20,
        left: 10,
        right: 10,
        width: 0,
        height: 0,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects transformed descendants wholly outside the viewport',
    fn() {
      const { document, element, text } = createTestDocument();
      document.defaultView.innerWidth = 500;
      document.defaultView.innerHeight = 300;
      const hidden = element('span', text('SECRET_TRANSLATE'));
      hidden.computedStyle = {
        display: 'inline',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, -10000, 0)',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 20,
        bottom: 44,
        left: -10000,
        right: -9900,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'serializes a block that is only scrolled out of the viewport',
    fn() {
      const { document, element, text } = createTestDocument();
      document.defaultView.innerWidth = 500;
      document.defaultView.innerHeight = 300;
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const block = element('p', text('Run '), element('code', text('npm i')), text(' now.'));
      // Below the fold: still in the document, just not scrolled to yet.
      block.rect = {
        top: 613,
        bottom: 637,
        left: 10,
        right: 300,
        width: 290,
        height: 24,
      };
      document.body.appendChild(block);

      assert.equal(codec.serializeBlock(block).ok, true);

      // Same block after scrolling past it: negative viewport top, but the
      // page position is unchanged, so the verdict must not change either.
      document.defaultView.scrollY = 2000;
      block.rect = {
        top: -1387,
        bottom: -1363,
        left: 10,
        right: 300,
        width: 290,
        height: 24,
      };

      assert.equal(codec.serializeBlock(block).ok, true);
    },
  },
  {
    name: 'rejects transformed descendants beyond the document right edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 10100,
        scrollHeight: 5000,
        offsetWidth: 1000,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_TRANSLATE_RIGHT'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, 10000, 0)',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 20,
        bottom: 44,
        left: 10000,
        right: 10100,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'serializes normal content inside a horizontally scrollable document',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 3000,
        scrollHeight: 5000,
        offsetWidth: 1280,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const block = element('p', text('Scrollable document content.'));
      block.computedStyle = {
        display: 'block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, 0, 0)',
        fontSize: '16px',
      };
      block.rect = {
        top: 20,
        bottom: 44,
        left: 2000,
        right: 2300,
        width: 300,
        height: 24,
      };
      document.body.appendChild(block);

      assert.equal(codec.serializeBlock(block).ok, true);

      document.defaultView.scrollX = 1720;
      block.rect = {
        top: 20,
        bottom: 44,
        left: 280,
        right: 580,
        width: 300,
        height: 24,
      };

      assert.equal(codec.serializeBlock(block).ok, true);
    },
  },
  {
    name: 'rejects individual CSS translate beyond the document right edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 10100,
        scrollHeight: 5000,
        offsetWidth: 1000,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_INDIVIDUAL_RIGHT'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'none',
        translate: '10000px',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 20,
        bottom: 44,
        left: 10000,
        right: 10100,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects transformed descendants beyond the document bottom edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 1000,
        scrollHeight: 10024,
        offsetWidth: 1000,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_TRANSLATE_BOTTOM'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, 0, 10000)',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 10000,
        bottom: 10024,
        left: 10,
        right: 110,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects percentage translate beyond the document right edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 10100,
        scrollHeight: 5000,
        offsetWidth: 1280,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_PERCENT_RIGHT'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'none',
        translate: '10000%',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 20,
        bottom: 44,
        left: 10000,
        right: 10100,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'serializes normal content inside an RTL horizontal document',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        dir: 'rtl',
        clientWidth: 1280,
        scrollWidth: 3000,
        scrollHeight: 5000,
        offsetWidth: 1280,
        offsetHeight: 5000,
      };
      document.defaultView.innerWidth = 1280;
      document.defaultView.innerHeight = 577;
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const block = element('p', text('RTL scrollable document content.'));
      block.rect = {
        top: 20,
        bottom: 44,
        left: -1720,
        right: -1499,
        width: 221,
        height: 24,
      };
      document.body.appendChild(block);

      assert.equal(codec.serializeBlock(block).ok, true);

      document.defaultView.scrollX = -1720;
      block.rect = {
        top: 20,
        bottom: 44,
        left: 0,
        right: 221,
        width: 221,
        height: 24,
      };

      assert.equal(codec.serializeBlock(block).ok, true);
    },
  },
  {
    name: 'rejects individual CSS translate beyond the document bottom edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 1000,
        scrollHeight: 10024,
        offsetWidth: 1000,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_INDIVIDUAL_BOTTOM'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'none',
        translate: '0px 10000px',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 10000,
        bottom: 10024,
        left: 10,
        right: 110,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects rightward transforms beyond an RTL document edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        dir: 'rtl',
        clientWidth: 1280,
        scrollWidth: 3000,
        scrollHeight: 5000,
        offsetWidth: 1280,
        offsetHeight: 5000,
      };
      document.defaultView.innerWidth = 1280;
      document.defaultView.innerHeight = 577;
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_RTL_TRANSLATE_RIGHT'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, 10000, 0)',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 20,
        bottom: 44,
        left: 11218,
        right: 11318,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects percentage translate beyond the document bottom edge',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 1280,
        scrollHeight: 10100,
        offsetWidth: 1280,
        offsetHeight: 5000,
      };
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const hidden = element('span', text('SECRET_PERCENT_BOTTOM'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'none',
        translate: '0px 10000%',
        fontSize: '16px',
      };
      hidden.rect = {
        top: 10000,
        bottom: 10100,
        left: 10,
        right: 110,
        width: 100,
        height: 100,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'rejects fixed descendants outside the viewport after page scrolling',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 29984,
        scrollHeight: 29984,
        offsetWidth: 29984,
        offsetHeight: 29984,
      };
      document.defaultView.innerWidth = 1280;
      document.defaultView.innerHeight = 577;
      document.defaultView.scrollX = 20000;
      document.defaultView.scrollY = 20000;
      const hidden = element('span', text('SECRET_FIXED_TRANSLATE'));
      hidden.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'fixed',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, -10000, -10000)',
        fontSize: '16px',
      };
      hidden.rect = {
        top: -10000,
        bottom: -9976,
        left: -10000,
        right: -9900,
        width: 100,
        height: 24,
      };
      const code = element('code', text('public-'), hidden);
      const block = element('p', text('Run '), code, text(' now.'));
      document.body.appendChild(block);

      assertReaderFacingUnsupported(codec.serializeBlock(block));
    },
  },
  {
    name: 'serializes fixed content that scrolls with a transformed ancestor',
    fn() {
      const { document, element, text } = createTestDocument();
      document.documentElement = {
        scrollWidth: 1280,
        scrollHeight: 5000,
        offsetWidth: 1280,
        offsetHeight: 5000,
      };
      document.defaultView.innerWidth = 1280;
      document.defaultView.innerHeight = 577;
      document.defaultView.scrollX = 0;
      document.defaultView.scrollY = 0;
      const fixed = element('span', text('Document-positioned fixed content.'));
      fixed.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'fixed',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'none',
        fontSize: '16px',
      };
      fixed.rect = {
        top: 2000,
        bottom: 2024,
        left: 10,
        right: 300,
        width: 290,
        height: 24,
      };
      const transformedAncestor = element('code', fixed);
      transformedAncestor.computedStyle = {
        display: 'inline-block',
        visibility: 'visible',
        opacity: '1',
        contentVisibility: 'visible',
        position: 'static',
        overflow: 'visible',
        clip: 'auto',
        clipPath: 'none',
        transform: 'matrix(1, 0, 0, 1, 0, 0)',
        fontSize: '16px',
      };
      fixed.offsetParent = transformedAncestor;
      const block = element(
        'p',
        text('Read '),
        transformedAncestor,
        text(' later.')
      );
      document.body.appendChild(block);

      assert.equal(codec.serializeBlock(block).ok, true);

      document.defaultView.scrollY = 1800;
      fixed.rect = {
        top: 200,
        bottom: 224,
        left: 10,
        right: 300,
        width: 290,
        height: 24,
      };

      assert.equal(codec.serializeBlock(block).ok, true);
    },
  },
  {
    name: 'fails closed instead of overflowing on deeply nested blocks',
    fn() {
      const { document, element, text } = createTestDocument();
      let child = text('Deep article text.');
      for (let index = 0; index < 12000; index += 1) {
        child = element('span', child);
      }
      const block = element('p', child);
      document.body.appendChild(block);
      let result;

      assert.doesNotThrow(() => {
        result = codec.serializeBlock(block);
      });
      assert.deepEqual(result, unsupportedBlock('structure_limit_exceeded', 'P'));
    },
  },
  {
    name: 'fails ownership safely after a deep page rerender',
    fn() {
      const fixture = createReasoningFixture();
      let child = fixture.document.createTextNode('Reasoning models');
      for (let index = 0; index < 12000; index += 1) {
        const span = fixture.document.createElement('span');
        span.appendChild(child);
        child = span;
      }
      fixture.strong.replaceChildren(child);
      let result;

      assert.doesNotThrow(() => {
        result = codec.createPatchPlan(
          fixture.serialized.snapshot,
          fixture.serialized.template
        );
      });
      assert.deepEqual(result, {
        ok: false,
        errorCode: 'block_changed',
      });
    },
  },
  {
    name: 'serializes a disclosure summary as its own semantic block',
    fn() {
      const { document, element, text } = createTestDocument();
      const title = text('Disclosure title stays with its summary.');
      const summary = element('summary', title);
      const body = element('p', text('Body paragraph remains a separate block.'));
      const disclosure = element('details', summary, body);
      document.body.appendChild(disclosure);

      const serialized = codec.serializeBlock(summary);

      assert.equal(serialized.ok, true);
      assert.equal(
        serialized.template,
        'Disclosure title stays with its summary.'
      );
      assert.equal(codec.isSemanticBlockElement(summary), true);
      assert.equal(codec.isSemanticBlockElement(body), true);
      assert.equal(codec.isSemanticBlockElement(disclosure), false);
    },
  },
  {
    name: 'applies and restores a disclosure summary without replacing its node',
    fn() {
      const { document, element, text } = createTestDocument();
      const title = text('Original disclosure title.');
      const emphasis = element('em', text('kept'));
      const summary = element('summary', title, text(' '), emphasis);
      const body = element('p', text('Body stays outside the summary.'));
      const disclosure = element('details', summary, body);
      document.body.appendChild(disclosure);
      const serialized = codec.serializeBlock(summary);
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      const originalChildren = [...summary.childNodes];
      const originalBody = body;

      const plan = codec.createPatchPlan(
        serialized.snapshot,
        `번역된 제목 ${wrapper.openToken}유지${wrapper.closeToken}`
      );
      assert.equal(plan.ok, true);
      assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
      assert.equal(disclosure.childNodes[0], summary);
      assert.equal(disclosure.childNodes[1], originalBody);
      assert.equal(summary.textContent, '번역된 제목 유지');
      assert.equal(emphasis.parentNode, summary);
      assert.equal(emphasis.textContent, '유지');

      assert.equal(codec.restoreBlock(serialized.snapshot).ok, true);
      assert.equal(disclosure.childNodes[0], summary);
      assert.equal(summary.textContent, 'Original disclosure title. kept');
      assert.deepEqual([...summary.childNodes], originalChildren);
      assert.equal(title.parentNode, summary);
      assert.equal(emphasis.parentNode, summary);
      assert.equal(emphasis.textContent, 'kept');
    },
  },
  {
    name: 'rejects a summary that is not a direct child of a disclosure',
    fn() {
      const { document, element, text } = createTestDocument();
      const orphan = element('summary', text('Orphan summary title.'));
      const nested = element(
        'summary',
        text('Nested summary title.')
      );
      const wrapper = element('div', nested);
      const disclosure = element(
        'details',
        wrapper,
        element('p', text('Body paragraph after a wrapped summary.'))
      );
      const enclosing = element(
        'p',
        text('Leading '),
        element('summary', text('inline summary')),
        text(' text.')
      );
      document.body.appendChild(orphan);
      document.body.appendChild(disclosure);
      document.body.appendChild(enclosing);

      assert.equal(codec.isSemanticBlockElement(orphan), false);
      assert.equal(codec.isSemanticBlockElement(nested), false);
      assertReaderFacingUnsupported(codec.serializeBlock(orphan));
      assertReaderFacingUnsupported(codec.serializeBlock(nested));
      assertReaderFacingUnsupported(codec.serializeBlock(enclosing));
    },
  },
  {
    name: 'serializes a leading wrapped disclosure summary with body prose outside its tokens',
    fn() {
      const { document, element, text } = createTestDocument();
      const title = text('Wrapped disclosure title.');
      const summary = element('summary', title);
      const leadingSpace = text('\n  ');
      const body = text(' Body prose stays outside the summary.');
      const block = element('p', leadingSpace, summary, body);
      const disclosure = element('details', block);
      document.body.appendChild(disclosure);

      const serialized = codec.serializeBlock(block);
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper' && entry.tagName === 'SUMMARY'
      );

      assert.equal(serialized.ok, true);
      assert.equal(codec.isSemanticBlockElement(block), true);
      assert.equal(codec.isSemanticBlockElement(summary), false);
      assert.equal(wrapper.placement, 'leading-root');
      assert.equal(
        serialized.template,
        `\n  ${wrapper.openToken}Wrapped disclosure title.${wrapper.closeToken} Body prose stays outside the summary.`
      );
      assert.equal(
        serialized.template.includes(
          `${wrapper.closeToken} Body prose stays outside the summary.`
        ),
        true
      );
      const cacheIdentity = JSON.parse(serialized.cacheKey);
      assert.equal(
        cacheIdentity.entries.find((entry) => entry.id === wrapper.id)
          .placement,
        'leading-root'
      );
    },
  },
  {
    name: 'keeps a movable wrapper cache identity distinct from an anchored summary',
    fn() {
      const { document, element, text } = createTestDocument();
      const emphasis = element('em', text('Movable title.'));
      const movable = element('p', emphasis, text(' Body prose.'));
      document.body.appendChild(movable);
      const movableKey = JSON.parse(codec.serializeBlock(movable).cacheKey);

      assert.equal(
        movableKey.entries.some((entry) => entry.placement),
        false
      );
    },
  },
  {
    name: 're-pins a moved wrapped summary as the first child without a repair',
    fn() {
      const { document, element, text } = createTestDocument();
      const title = text('Original wrapped title.');
      const emphasis = element('em', text('kept'));
      const summary = element('summary', title, text(' '), emphasis);
      const body = text(' Original wrapped body.');
      const block = element('p', summary, body);
      const disclosure = element('details', block);
      document.body.appendChild(disclosure);
      const serialized = codec.serializeBlock(block);
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper' && entry.tagName === 'SUMMARY'
      );
      const inner = serialized.contract.entries.find(
        (entry) => entry.parentId === wrapper.id
      );
      const originalChildren = [...block.childNodes];
      const originalSummaryChildren = [...summary.childNodes];
      const translated = `번역된 본문 ${wrapper.openToken}번역된 제목 ${inner.openToken}유지${inner.closeToken}${wrapper.closeToken}`;

      const plan = codec.createPatchPlan(serialized.snapshot, translated);
      assert.equal(plan.ok, true);
      assert.equal(plan.rootChildren[0], summary);
      assert.equal(
        plan.rootChildren.includes(summary),
        true
      );
      assert.equal(
        plan.rootChildren.filter((node) => node === summary).length,
        1
      );

      assert.equal(codec.applyPatchPlan(serialized.snapshot, plan).ok, true);
      assert.equal(block.childNodes[0], summary);
      assert.equal(summary.textContent, '번역된 제목 유지');
      assert.equal(emphasis.parentNode, summary);
      assert.equal(emphasis.textContent, '유지');
      assert.equal(block.textContent, '번역된 제목 유지번역된 본문 ');

      assert.equal(codec.restoreBlock(serialized.snapshot).ok, true);
      assert.equal(block.childNodes[0], summary);
      assert.deepEqual([...block.childNodes], originalChildren);
      assert.deepEqual([...summary.childNodes], originalSummaryChildren);
      assert.equal(title.parentNode, summary);
      assert.equal(emphasis.parentNode, summary);
      assert.equal(emphasis.textContent, 'kept');
      assert.equal(
        block.textContent,
        'Original wrapped title. kept Original wrapped body.'
      );
    },
  },
  {
    name: 'rejects a second, non-leading, nested, or out-of-disclosure wrapped summary',
    fn() {
      const { document, element, text } = createTestDocument();
      const second = element(
        'p',
        element('summary', text('First title.')),
        text(' body '),
        element('summary', text('Second title.'))
      );
      const nonLeading = element(
        'p',
        text('Lead-in '),
        element('summary', text('Non-leading title.')),
        text(' body.')
      );
      const nested = element(
        'p',
        element('span', element('summary', text('Nested title.'))),
        text(' Nested body.')
      );
      const outside = element(
        'p',
        element('summary', text('Outside title.')),
        text(' Outside body.')
      );
      document.body.appendChild(element('details', second));
      document.body.appendChild(element('details', nonLeading));
      document.body.appendChild(element('details', nested));
      document.body.appendChild(outside);

      assertReaderFacingUnsupported(codec.serializeBlock(second));
      assertReaderFacingUnsupported(codec.serializeBlock(nonLeading));
      assertReaderFacingUnsupported(codec.serializeBlock(nested));
      assertReaderFacingUnsupported(codec.serializeBlock(outside));
    },
  },
  {
    name: 'fails ownership safely when a wrapped disclosure mutates before apply',
    fn() {
      const { document, element, text } = createTestDocument();
      const summary = element('summary', text('Mutable wrapped title.'));
      const block = element('p', summary, text(' Mutable wrapped body.'));
      document.body.appendChild(element('details', block));
      const serialized = codec.serializeBlock(block);
      const wrapper = serialized.contract.entries.find(
        (entry) => entry.kind === 'wrapper'
      );
      block.appendChild(text(' mutated'));

      assert.deepEqual(
        codec.createPatchPlan(
          serialized.snapshot,
          `${wrapper.openToken}번역된 제목${wrapper.closeToken} 번역된 본문.`
        ),
        { ok: false, errorCode: 'block_changed' }
      );
    },
  },
  {
    name: 'still serializes existing semantic block kinds',
    fn() {
      const { document, element, text } = createTestDocument();
      const samples = [
        ['p', 'Paragraph text stays a paragraph.'],
        ['h1', 'Heading text stays a heading.'],
        ['li', 'List item text stays a list item.'],
        ['blockquote', 'Quotation text stays a quotation.'],
        ['figcaption', 'Caption text stays a caption.'],
        ['dt', 'Term text stays a term.'],
        ['dd', 'Definition text stays a definition.'],
        ['th', 'Table heading cell stays a table cell.'],
        ['td', 'Table cell text stays a table cell.'],
      ];

      for (const [tagName, value] of samples) {
        const block = element(tagName, text(value));
        document.body.appendChild(block);
        const serialized = codec.serializeBlock(block);
        assert.equal(serialized.ok, true, tagName);
        assert.equal(serialized.template, value, tagName);
      }
    },
  },
];

exports.createTestDocument = createTestDocument;
exports.createReasoningFixture = createReasoningFixture;
exports.LINGUISTIC_SLASH_PROSE = LINGUISTIC_SLASH_PROSE;
