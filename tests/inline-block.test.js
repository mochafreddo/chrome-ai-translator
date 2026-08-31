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

exports.name = 'inline block codec';
exports.tests = [
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
