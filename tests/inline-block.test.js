const assert = require('node:assert/strict');
const codec = require('../extension/inline-block.js');

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

exports.name = 'inline block codec';
exports.tests = [
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

      assert.deepEqual(codec.serializeBlock(hiddenFixture.block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
      assert.deepEqual(codec.serializeBlock(editableFixture.block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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

      assert.deepEqual(codec.serializeBlock(block), {
        ok: false,
        errorCode: 'unsupported_block',
      });
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
      assert.deepEqual(result, {
        ok: false,
        errorCode: 'unsupported_block',
      });
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
];

exports.createTestDocument = createTestDocument;
exports.createReasoningFixture = createReasoningFixture;
