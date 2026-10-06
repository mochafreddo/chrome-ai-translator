const assert = require('node:assert/strict');
const { createInlineViewport } = require('../extension/inline-viewport');
const { createInlineTranslationSession } = require('../extension/inline-translation-session');
const { createTestDocument } = require('./inline-block.test');
const { createViewportProbe } = require('./viewport-harness');

function createActiveInlineTranslationState() {
  const session = createInlineTranslationSession();
  session.begin({});
  return { session };
}

function platformFor(root) {
  const document = root.ownerDocument;
  document.documentElement = { clientWidth: 0, clientHeight: 0 };
  document.createRange = () => { throw new Error('range unavailable'); };
  return {
    document, HTMLElement: root.constructor,
    window: {
      innerWidth: 500, innerHeight: 300,
      getComputedStyle: document.defaultView.getComputedStyle,
      addEventListener() {}, removeEventListener() {},
    },
    MutationObserver: class { observe() {} disconnect() {} },
  };
}

function scan(root, { session }) {
  const viewport = createViewportProbe(session, platformFor(root), createInlineViewport);
  try {
    viewport.start(root);
    return viewport.records;
  } finally { viewport.stop(); }
}

function scannerFixture(root, session = createActiveInlineTranslationState().session) {
  const platform = platformFor(root);
  const targets = new Map();
  const timers = new Map();
  const observers = [];
  const admissions = [];
  let nextTimer = 0;
  let scans = 0;
  let resets = 0;
  function target(node) {
    const listeners = new Map();
    targets.set(node, listeners);
    node.addEventListener = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    };
    node.removeEventListener = (type, fn) => listeners.get(type)?.delete(fn);
    return node;
  }
  target(platform.window);
  target(platform.document);
  target(platform.document.body);
  target(platform.document.documentElement);
  platform.document.scrollingElement = platform.document.documentElement;
  platform.setTimeout = (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  };
  platform.clearTimeout = (id) => timers.delete(id);
  platform.MutationObserver = class {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe(node, options) { this.node = node; this.options = options; }
    disconnect() { this.disconnected = true; }
  };
  const viewport = createInlineViewport({
    session: {
      get operationId() { return session.operationId; },
      get status() { return session.status; },
      isCurrent: session.isCurrent,
      resetQueue() { resets += 1; session.resetQueue(); },
      admit(block) { admissions.push(block); return session.admit(block); },
    },
    platform,
    onScan() { scans += 1; },
  });
  return {
    viewport, session, platform, targets, timers, observers, admissions, target,
    get scans() { return scans; },
    get resets() { return resets; },
    event(node, type) { for (const fn of targets.get(node)?.get(type) || []) fn(); },
    advance() {
      assert.equal(timers.size, 1);
      const [id, task] = timers.entries().next().value;
      timers.delete(id);
      assert.equal(task.delay, 250);
      task.callback();
    },
  };
}

exports.name = 'inline viewport';
exports.tests = [
  {
    name: 'collects data-as paragraphs once and preserves inline elements through apply and restore',
    fn() {
      const { document, element, text } = createTestDocument();
      const link = element('a', text('the guide'));
      link.setAttribute('href', '/guide');
      const emphasis = element('em', text('carefully'));
      const code = element('code', text('/advisor'));
      const block = element('span', text('Read '), link, text(' '), emphasis, text(' before using '), code, text('.'));
      block.setAttribute('data-as', 'p');
      const root = element('div', block);
      document.body.appendChild(root);
      const original = [...block.childNodes];
      const originalText = block.textContent;
      const state = createActiveInlineTranslationState();
      const records = scan(root, state);
      assert.equal(records.length, 1);
      const [record] = records;
      assert.deepEqual(scan(root, state), []);
      assert.equal(state.session.progress().counts.pending, 1);
      const [anchor, em, atom] = record.contract.entries;
      const translated = `${atom.token} 사용 전에 ${em.openToken}주의 깊게${em.closeToken} ${anchor.openToken}안내서${anchor.closeToken}를 읽으세요.`;
      state.session.settle(state.session.takeBatch(), { ok: true, results: [{ id: record.id, disposition: 'apply', template: translated }] });
      assert.equal(state.session.progress().counts.translated, 1);
      assert.equal(block.textContent, '/advisor 사용 전에 주의 깊게 안내서를 읽으세요.');
      assert.equal(block.childNodes[0], code);
      assert.equal(link.parentNode, block);
      assert.equal(emphasis.parentNode, block);
      assert.equal(link.getAttribute('href'), '/guide');
      assert.equal(block.getAttribute('data-as'), 'p');
      state.session.restore();
      assert.deepEqual(block.childNodes, original);
      assert.equal(block.textContent, originalText);
    },
  },
  {
    name: 'keeps data-as paragraph scope and existing local preflight rejections',
    fn() {
      const { document, element, text } = createTestDocument();
      const paragraph = (...children) => {
        const node = element('span', ...children);
        node.setAttribute('data-as', 'p');
        return node;
      };
      const ordinary = element('p', text('An ordinary paragraph stays supported.'));
      const unsupported = [element('div', text('Not a paragraph.')), element('span', text('Not a paragraph.'))];
      for (const [tag, value] of [['div', 'p'], ['span', 'div'], ['span', 'P'], ['span', ' p ']]) {
        const node = element(tag, text('Not a supported paragraph marker.'));
        node.setAttribute('data-as', value);
        unsupported.push(node);
      }
      const hidden = element('span', text('Hidden prose must not be sent.'));
      hidden.hidden = true;
      const editor = element('span', text('Editable prose must not be sent.'));
      editor.setAttribute('contenteditable', 'true');
      const rejected = [hidden, element('button', text('Press me')), editor].map(child =>
        paragraph(text('Visible prose before the child. '), child));
      const inner = paragraph(text('Inner paragraph has its own owner.'));
      const outer = paragraph(text('Outer prose cannot absorb an inner paragraph. '), inner);
      const root = element('div', ordinary, ...unsupported, ...rejected, outer);
      document.body.appendChild(root);
      const state = createActiveInlineTranslationState();
      scan(root, state);
      scan(root, state);
      assert.deepEqual(state.session.takeBatch().map(record => record.template), ['An ordinary paragraph stays supported.', 'Inner paragraph has its own owner.']);
      assert.deepEqual(state.session.progress().counts, { translated: 0, partial: 0, pending: 2, changed: 0, failed: 4 });
      assert.deepEqual(state.session.outbox.map(item => item.localRejection), [
        { reason: 'hidden_content', tag: 'SPAN' },
        { reason: 'interactive_content', tag: 'BUTTON' },
        { reason: 'editable_content', tag: 'SPAN' },
        { reason: 'nested_semantic_block', tag: 'SPAN' },
      ]);
    },
  },
  {
    name: 'rejects overlapping data-as paragraphs inside protected links and code atoms',
    fn() {
      for (const tag of ['a', 'code', 'kbd', 'samp']) {
        const { document, element, text } = createTestDocument();
        const inner = element('span', text('Responses API'));
        inner.setAttribute('data-as', 'p');
        const atom = element(tag, inner);
        if (tag === 'a') atom.setAttribute('href', '/docs');
        const outer = element('p', text('Read this documentation: '), atom);
        document.body.appendChild(outer);
        const original = [...outer.childNodes];
        const originalText = outer.textContent;
        const state = createActiveInlineTranslationState();
        scan(outer, state);
        scan(outer, state);
        assert.equal(state.session.progress().counts.failed, 1, tag);
        assert.deepEqual(state.session.outbox.map(item => item.localRejection), [
          { reason: 'nested_semantic_block', tag: 'SPAN' },
        ], tag);
        const batch = state.session.takeBatch();
        assert.deepEqual(batch.map(record => record.template), tag === 'a' ? ['Responses API'] : [], tag);
        if (tag === 'a') {
          const [record] = batch;
          state.session.settle(batch, { ok: true, results: [{ id: record.id, disposition: 'apply', template: '응답 API' }] });
          assert.equal(state.session.progress().counts.translated, 1);
          assert.equal(outer.textContent, 'Read this documentation: 응답 API');
          state.session.restore();
          assert.equal(atom.getAttribute('href'), '/docs');
        }
        assert.deepEqual(outer.childNodes, original);
        assert.equal(atom.childNodes[0], inner);
        assert.equal(outer.textContent, originalText);
      }
    },
  },
  {
    name: 'collects a heading with a local permalink and restores its exact graph',
    fn() {
      const { document, element, text } = createTestDocument();
      const link = element('a', text('\u200b'), element('svg', element('path')));
      link.setAttribute('href', '#heading');
      link.setAttribute('aria-label', 'Link to this heading');
      const control = element('div', link);
      control.rect = { top: 20, bottom: 44, left: 10, right: 10, width: 0, height: 24 };
      const emphasis = element('em', text('advisor'));
      const proseLink = element('a', text('guide'));
      proseLink.setAttribute('href', '/guide');
      const block = element('h2', control, text('Use the '), emphasis, text(' '), proseLink);
      block.setAttribute('id', 'heading');
      const original = [...block.childNodes];
      const originalText = block.textContent;
      document.body.appendChild(block);
      const state = createActiveInlineTranslationState();
      const records = scan(block, state);
      assert.equal(records.length, 1);
      const [record] = records;
      const request = JSON.stringify({ template: record.template, atoms: record.atoms, contract: record.contract });
      for (const local of ['Link to this heading', '#heading', '\u200b', 'DIV', 'SVG']) {
        assert.equal(request.includes(local), false, local);
      }
      const [em, anchor] = record.contract.entries;
      assert.equal(em.tagName, 'EM');
      assert.equal(anchor.tagName, 'A');
      const translated = `${anchor.openToken}안내${anchor.closeToken}: ${em.openToken}조언자${em.closeToken} 사용`;
      state.session.settle(state.session.takeBatch(), { ok: true, results: [{ id: record.id, disposition: 'apply', template: translated }] });
      assert.equal(block.childNodes[0], control);
      assert.equal(control.childNodes[0], link);
      assert.equal(link.getAttribute('href'), '#heading');
      assert.equal(link.getAttribute('aria-label'), 'Link to this heading');
      assert.equal(block.childNodes[1], proseLink);
      state.session.restore();
      assert.deepEqual(block.childNodes, original);
      assert.equal(block.textContent, originalText);
      assert.equal(control.childNodes[0], link);
    },
  },
  {
    name: 'uses short prose around inline code to discover a block',
    fn() {
      const { document, element, text } = createTestDocument();
      const code = element('code', text('x'));
      const block = element('p', text('Run '), code, text('.'));
      document.body.appendChild(block);

      const state = createActiveInlineTranslationState();
      const queued = scan(block, state);

      assert.equal(queued.length, 1);
      assert.equal(state.session.progress().counts.pending, 1);
      assert.equal(state.session.takeBatch()[0].atoms[0].label, 'x');
    },
  },
  {
    name: 'skips a code-like block on the scan the reader actually triggers',
    fn() {
      const { document, element, text } = createTestDocument();
      const command = element('p', text('npm run build'));
      const prose = element('p', text('Then reload the extension.'));
      const root = element('div', command, prose);
      document.body.appendChild(root);

      const state = createActiveInlineTranslationState();
      const queued = scan(root, state);

      assert.equal(queued.length, 1);
      assert.equal(queued[0].template, 'Then reload the extension.');
    },
  },
  {
    name: 'does not collect blocks inside inherited editable regions',
    fn() {
      const { document, element, text } = createTestDocument();
      const block = element('p', text('Unpublished draft text.'));
      const editor = element('div', block);
      editor.setAttribute('contenteditable', 'true');
      document.body.appendChild(editor);

      const state = createActiveInlineTranslationState();
      const queued = scan(editor, state);

      assert.deepEqual(queued, []);
      assert.equal(state.session.progress().counts.pending, 0);
    },
  },
  {
    name: 'collects a disclosure summary separately from its body paragraphs',
    fn() {
      const { document, element, text } = createTestDocument();
      const summary = element(
        'summary',
        text('Disclosure title is its own block.')
      );
      const body = element(
        'p',
        text('Body paragraph remains a separate block.')
      );
      const extra = element('p', text('Second body paragraph stays distinct.'));
      const disclosure = element('details', summary, body, extra);
      const heading = element('h2', text('Ordinary heading stays a heading.'));
      const root = element('div', heading, disclosure);
      document.body.appendChild(root);

      const state = createActiveInlineTranslationState();
      const queued = scan(root, state);

      assert.equal(queued.length, 4);
      assert.deepEqual(
        queued.map((record) => record.template),
        ['Ordinary heading stays a heading.', 'Disclosure title is its own block.', 'Body paragraph remains a separate block.', 'Second body paragraph stays distinct.']
      );
      assert.equal(queued[1].template, 'Disclosure title is its own block.');
      assert.equal(
        queued[2].template,
        'Body paragraph remains a separate block.'
      );
    },
  },
  {
    name: 'collects a wrapped disclosure as one enclosing block',
    fn() {
      const { document, element, text } = createTestDocument();
      const summary = element(
        'summary',
        text('Wrapped disclosure title.')
      );
      const block = element(
        'p',
        summary,
        text(' Body prose stays in the enclosing block.')
      );
      const extra = element('p', text('Sibling paragraph stays distinct.'));
      const disclosure = element('details', block, extra);
      const heading = element('h2', text('Ordinary heading stays a heading.'));
      const root = element('div', heading, disclosure);
      document.body.appendChild(root);

      const state = createActiveInlineTranslationState();
      const queued = scan(root, state);

      assert.equal(queued.length, 3);
      assert.equal(queued[0].template, 'Ordinary heading stays a heading.');
      assert.equal(queued[2].template, 'Sibling paragraph stays distinct.');
      assert.equal(queued[1].template.includes('Wrapped disclosure title.'), true);
      assert.equal(
        queued[1].template.includes('Body prose stays in the enclosing block.'),
        true
      );
    },
  },
  {
    name: 'continues after 1200 text nodes and active rescan retains the cursor and queue',
    fn() {
      const { document, element, text } = createTestDocument();
      const first = element('p', ...Array.from({ length: 1201 }, () => text('Hi ')));
      const tail = element('p', text('The final paragraph.'));
      const root = element('div', first, tail);
      document.body.appendChild(root);
      const f = scannerFixture(root);
      f.viewport.start(root);
      assert.deepEqual(f.admissions, [first]);
      assert.equal(f.timers.size, 1);
      f.viewport.rescan();
      assert.equal(f.resets, 0);
      f.advance();
      assert.deepEqual(f.admissions, [first, first, tail]);
      assert.equal(f.timers.size, 0);
      assert.equal(f.session.progress().counts.pending, 2);
      f.viewport.stop();
    },
  },
  ...['scroll', 'resize', 'mutation'].map((event) => ({
    name: `${event} resets the cursor and pending viewport before the debounced scan`,
    fn() {
      const { document, element, text } = createTestDocument();
      const first = element('p', text('First visible paragraph.'));
      const filler = element('p', ...Array.from({ length: 1200 }, () => text('Hi ')));
      const tail = element('p', text('Final visible paragraph.'));
      const root = element('div', first, filler, tail);
      document.body.appendChild(root);
      const f = scannerFixture(root);
      f.viewport.start(root);
      first.rect = { top: -1000, bottom: -900, left: 0, right: 100, width: 100, height: 100 };
      if (event === 'mutation') f.observers[0].callback();
      else f.event(f.platform.window, event);
      assert.equal(f.resets, 1);
      assert.equal(f.session.progress().counts.pending, 0);
      f.advance();
      assert.equal(f.admissions.includes(tail), false, 'the next scan restarted at the visible head');
      f.advance();
      assert.deepEqual(f.session.takeBatch().map(record => record.template), [
        'Hi '.repeat(1200), 'Final visible paragraph.',
      ]);
      f.viewport.stop();
    },
  })),
  {
    name: 'stops timers and every registered listener and ignores already queued callbacks',
    fn() {
      const { document, element, text } = createTestDocument();
      const root = element('p', text('Visible paragraph.'));
      const parent = element('div', root);
      parent.clientHeight = 100; parent.scrollHeight = 400;
      document.body.appendChild(parent);
      const f = scannerFixture(root);
      f.target(parent);
      const getStyle = f.platform.window.getComputedStyle;
      f.platform.window.getComputedStyle = node => ({ ...getStyle(node), overflowY: node === parent ? 'auto' : 'visible' });
      f.viewport.start(root);
      f.viewport.start(root);
      assert.equal(f.observers.length, 1);
      assert.equal(f.observers[0].node, root);
      assert.deepEqual(f.observers[0].options, { childList: true, subtree: true, characterData: true });
      for (const node of [f.platform.window, document, document.body, document.documentElement, parent]) {
        assert.equal(f.targets.get(node).get('scroll').size, 1);
      }
      f.event(parent, 'scroll');
      const lateTimer = [...f.timers.values()][0].callback;
      const lateObserver = f.observers[0].callback;
      f.viewport.stop();
      f.viewport.stop();
      assert.equal(f.timers.size, 0);
      assert.equal(f.observers[0].disconnected, true);
      for (const listeners of f.targets.values()) {
        for (const handlers of listeners.values()) assert.equal(handlers.size, 0);
      }
      const before = { scans: f.scans, resets: f.resets, admissions: f.admissions.length };
      lateTimer(); lateObserver(); f.viewport.rescan(); f.viewport.start(root);
      assert.deepEqual({ scans: f.scans, resets: f.resets, admissions: f.admissions.length }, before);
      assert.equal(f.timers.size, 0);
    },
  },
  ...['stop', 'restore', 'replace'].map((transition) => ({
    name: `an obsolete scan cannot admit or reset Session work after ${transition}`,
    fn() {
      const { document, element, text } = createTestDocument();
      const root = element('p', text('Visible paragraph.'));
      document.body.appendChild(root);
      const f = scannerFixture(root);
      f.viewport.start(root);
      f.viewport.rescan();
      if (transition === 'replace') f.session.begin({});
      else f.session[transition]();
      const progress = f.session.progress();
      f.advance();
      f.observers[0].callback();
      assert.equal(f.scans, 1);
      assert.equal(f.resets, 0);
      assert.deepEqual(f.session.progress(), progress);
      f.viewport.stop();
    },
  })),
  {
    name: 'offscreen subtrees do not consume the text-node scan budget',
    fn() {
      const { document, element, text } = createTestDocument();
      const offscreen = element('div', ...Array.from({ length: 1201 }, () => element('p', text('Far above.'))));
      offscreen.rect = { top: -1000, bottom: -900, left: 0, right: 100, width: 100, height: 100 };
      const visible = element('p', text('The paragraph the reader sees.'));
      const root = element('div', offscreen, visible);
      document.body.appendChild(root);
      const f = scannerFixture(root);
      f.viewport.start(root);
      assert.deepEqual(f.admissions, [visible]);
      assert.equal(f.timers.size, 0);
      f.viewport.stop();
    },
  },
  {
    name: 'uses the viewport prefetch margin and horizontal limits through discovery',
    fn() {
      const { document, element, text } = createTestDocument();
      const root = element('div');
      for (const [label, top, left] of [['Visible',20,10],['Prefetch',400,10],['Below',500,10],['Right',20,600]]) {
        const block = element('p', text(label + ' paragraph.'));
        block.rect = { top, bottom: top+24, left, right: left+100, width:100, height:24 };
        root.appendChild(block);
      }
      document.body.appendChild(root);
      assert.deepEqual(scan(root, createActiveInlineTranslationState()).map(r => r.template), ['Visible paragraph.', 'Prefetch paragraph.']);
    },
  },
  {
    name: 'does not admit enclosing list items from bare text inside Block Child containers',
    fn() {
      for (const tag of ['ul', 'ol', 'dl', 'table', 'pre', 'details', 'figure']) {
        const { document, element, text } = createTestDocument();
        const block = element('li', element(tag, text('Child content stays outside the parent prose.')));
        document.body.appendChild(block);
        const f = scannerFixture(block);
        try {
          f.viewport.start(block);
          assert.deepEqual(f.admissions, [], tag);
          assert.equal(f.session.progress().counts.failed, 0, tag);
        } finally { f.viewport.stop(); }
      }
    },
  },
  {
    name: 'admits list item prose outside its code Block Child',
    fn() {
      const { document, element, text } = createTestDocument();
      const block = element('li', text('Run the following example.'),
        element('pre', element('code', text('Example code is not parent prose.'))));
      document.body.appendChild(block);
      const f = scannerFixture(block);
      try {
        f.viewport.start(block);
        assert.deepEqual(f.admissions, [block]);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'admits nested list items before reaching their Block Child container',
    fn() {
      for (const tag of ['ul', 'ol']) {
        const { document, element, text } = createTestDocument();
        const inner = element('li', text('Nested item has its own prose.'));
        const outer = element('li', element(tag, inner));
        document.body.appendChild(outer);
        const f = scannerFixture(outer);
        try {
          f.viewport.start(outer);
          assert.deepEqual(f.admissions, [inner], tag);
          assert.deepEqual(f.session.takeBatch().map(record => record.template),
            ['Nested item has its own prose.'], tag);
          assert.equal(f.session.progress().counts.failed, 0, tag);
        } finally { f.viewport.stop(); }
      }
    },
  },
  {
    name: 'excludes page chrome tags and roles while keeping article headings and asides',
    fn() {
      const { document, element, text } = createTestDocument();
      const root = element('div');
      for (const tag of ['code', 'nav', 'footer', 'button', 'header', 'aside']) {
        root.appendChild(element(tag, element('p', text('Paragraph in ' + tag + '.'))));
      }
      for (const role of ['navigation', 'complementary', 'main']) {
        const parent = element('div', element('p', text('Paragraph in ' + role + '.')));
        parent.setAttribute('role', role); root.appendChild(parent);
      }
      document.body.appendChild(root);
      assert.deepEqual(scan(root, createActiveInlineTranslationState()).map(r => r.template), [
        'Paragraph in header.', 'Paragraph in aside.', 'Paragraph in main.',
      ]);
    },
  }
];
