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
  const scrollCaptures = new Map();
  const timers = new Map();
  const observers = [];
  const admissions = [];
  let nextTimer = 0;
  let scans = 0;
  let resets = 0;
  function target(node) {
    const listeners = new Map();
    targets.set(node, listeners);
    const captures = new Set();
    scrollCaptures.set(node, captures);
    node.addEventListener = (type, fn, options) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      if (type === 'scroll' && options?.capture) captures.add(fn);
    };
    node.removeEventListener = (type, fn, options) => {
      if (type === 'scroll' && captures.has(fn) !== Boolean(options?.capture)) return;
      listeners.get(type)?.delete(fn);
      captures.delete(fn);
    };
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
    constructor(callback) { this.callback = callback; this.disconnected = false; this.records = []; observers.push(this); }
    observe(node, options) { this.node = node; this.options = options; }
    disconnect() { this.disconnected = true; }
    takeRecords() { return this.records.splice(0); }
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
    nestedScroll(node) {
      for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
        for (const fn of scrollCaptures.get(ancestor) || []) fn();
      }
      for (const fn of scrollCaptures.get(platform.window)) fn();
    },
    attribute(node, name, value) {
      node.setAttribute(name, value);
      for (const observer of observers) {
        if (observer.disconnected || !observer.options.attributes) continue;
        let ancestor = node;
        while (ancestor && ancestor !== observer.node) ancestor = ancestor.parentNode;
        if (ancestor) observer.callback([{ type: 'attributes', target: node }]);
      }
    },
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
    name: 'invalidates continuation when an attribute reveals earlier prose',
    fn() {
      const { document, element, text } = createTestDocument();
      const revealed = element('p', text('Revealed paragraph.'));
      revealed.computedStyle = { display: 'none' };
      const filler = element('p', ...Array.from({ length: 1200 }, () => text('Hi ')));
      const tail = element('p', text('Final paragraph.'));
      const root = element('div', revealed, filler, tail);
      document.body.appendChild(root);
      const f = scannerFixture(root);
      try {
        f.viewport.start(root);
        assert.equal(f.admissions.includes(revealed), false);
        revealed.computedStyle = {};
        f.attribute(revealed, 'class', 'visible');
        f.advance();
        assert.equal(f.admissions.includes(revealed), true);
        f.advance();
        assert.deepEqual(f.session.takeBatch().map(record => record.template), [
          'Revealed paragraph.', 'Hi '.repeat(1200), 'Final paragraph.',
        ]);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'applies the collected cache batch before restarting invalidated traversal',
    fn() {
      const { document, element, text } = createTestDocument();
      const paragraphs = ['First paragraph.', 'Second paragraph.', 'Third paragraph.']
        .map(value => element('p', text(value)));
      const originals = paragraphs.map(block => [...block.childNodes]);
      const root = element('div', ...paragraphs);
      document.body.appendChild(root);
      const session = createActiveInlineTranslationState().session;
      const records = paragraphs.map(block => session.admit(block));
      session.settle(session.takeBatch(), { ok: true, results: records.map(record => ({
        id: record.id, disposition: 'apply', template: '저장된 문단.',
      })) });
      session.restore();
      session.begin({});
      const f = scannerFixture(root, session);
      for (const block of paragraphs) {
        const replaceChildren = block.replaceChildren.bind(block);
        block.replaceChildren = (...nodes) => {
          replaceChildren(...nodes);
          f.observers[0].records.push({ type: 'childList', target: block });
        };
      }
      try {
        f.viewport.start(root);
        assert.equal(session.progress().counts.translated, 3);
        assert.equal(f.resets, 1);
        f.advance();
        assert.equal(f.timers.size, 0);
        assert.deepEqual(session.takeBatch(), []);
        session.restore();
        paragraphs.forEach((block, index) => assert.deepEqual(block.childNodes, originals[index]));
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'rediscovers newly visible prose after a descendant scroll without bubbling',
    fn() {
      const { document, element, text } = createTestDocument();
      const paragraph = element('p', text('Newly visible nested prose.'));
      const scroller = element('div', paragraph);
      const root = element('div', scroller);
      paragraph.rect = { top: 1000, bottom: 1024, left: 10, right: 300, width: 290, height: 24 };
      document.body.appendChild(root);
      const f = scannerFixture(root);
      try {
        f.viewport.start(root);
        assert.deepEqual(f.admissions, []);
        paragraph.rect = { top: 20, bottom: 44, left: 10, right: 300, width: 290, height: 24 };
        f.nestedScroll(scroller);
        f.advance();
        assert.deepEqual(f.session.takeBatch().map(record => record.template), ['Newly visible nested prose.']);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'stops stale candidate application when an earlier cache hit moves prose outside the root',
    fn() {
      const { document, element, text } = createTestDocument();
      const cached = element('p', text('Cached paragraph.'));
      const moved = element('p', text('Moved paragraph.'));
      const root = element('div', cached, moved);
      document.body.appendChild(root);
      const session = createActiveInlineTranslationState().session;
      const first = session.admit(cached);
      const second = session.admit(moved);
      session.settle(session.takeBatch(), { ok: true, results: [
        { id: first.id, disposition: 'apply', template: '저장된 문단.' },
        { id: second.id, disposition: 'apply', template: '이동한 문단.' },
      ] });
      session.restore();
      session.begin({});
      const f = scannerFixture(root, session);
      const replaceChildren = cached.replaceChildren.bind(cached);
      cached.replaceChildren = (...nodes) => {
        replaceChildren(...nodes);
        document.body.appendChild(moved);
        f.observers[0].records.push({ type: 'childList', target: root });
      };
      try {
        f.viewport.start(root);
        while (f.timers.size) f.advance();
        assert.equal(cached.textContent, '저장된 문단.');
        assert.equal(moved.textContent, 'Moved paragraph.');
        assert.equal(session.progress().counts.translated, 1);
        assert.deepEqual(session.takeBatch(), []);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'ignores a canceled continuation after nested scroll replaces its debounce timer',
    fn() {
      const { document, element, text } = createTestDocument();
      const root = element('p', ...Array.from({ length: 1201 }, () => text('Hi ')));
      const parent = element('div', root);
      parent.clientHeight = 100;
      parent.scrollHeight = 400;
      parent.computedStyle = { overflowY: 'auto' };
      document.body.appendChild(parent);
      const f = scannerFixture(root);
      f.target(parent);
      try {
        f.viewport.start(root);
        const canceled = [...f.timers.values()][0].callback;
        f.event(parent, 'scroll');
        const pending = [...f.timers.entries()];
        canceled();
        assert.equal(f.scans, 1);
        assert.deepEqual([...f.timers.entries()], pending);
        f.advance();
        f.advance();
        assert.equal(f.scans, 3);
        assert.equal(f.session.progress().counts.pending, 1);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'invalidates continuation when cache application replaces pending DOM',
    fn() {
      const { document, element, text } = createTestDocument();
      const cached = element('p', text('Cached paragraph.'));
      const filler = element('p', ...Array.from({ length: 1200 }, () => text('Hi ')));
      const oldTail = element('p', text('Removed paragraph.'));
      const replacement = element('p', text('New paragraph before the continuation.'));
      const root = element('div', cached, filler, oldTail);
      document.body.appendChild(root);
      const original = [...cached.childNodes];
      const session = createActiveInlineTranslationState().session;
      const record = session.admit(cached);
      session.settle(session.takeBatch(), { ok: true,
        results: [{ id: record.id, disposition: 'apply', template: '저장된 문단.' }] });
      session.restore();
      session.begin({});
      const f = scannerFixture(root, session);
      const replaceChildren = cached.replaceChildren.bind(cached);
      let replaced = false;
      cached.replaceChildren = (...nodes) => {
        replaceChildren(...nodes);
        if (replaced) return;
        replaced = true;
        root.removeChild(filler);
        root.removeChild(oldTail);
        root.insertBefore(replacement, cached);
        f.observers[0].records.push({ type: 'childList', target: root });
      };
      try {
        f.viewport.start(root);
        while (f.timers.size) f.advance();
        assert.deepEqual(session.takeBatch().map(item => item.template), [
          'New paragraph before the continuation.',
        ]);
        assert.equal(session.progress().counts.translated, 1);
        assert.equal(f.resets, 1);
        session.restore();
        assert.deepEqual(cached.childNodes, original);
        assert.equal(replacement.textContent, 'New paragraph before the continuation.');
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'collects the synchronous viewport before applying cached translations',
    fn() {
      const { document, element, text } = createTestDocument();
      const cached = element('p', text('Cached paragraph.'));
      const fresh = element('p', text('Fresh paragraph.'));
      const root = element('div', cached, fresh);
      document.body.appendChild(root);
      const original = [...cached.childNodes];
      const session = createActiveInlineTranslationState().session;
      const record = session.admit(cached);
      session.settle(session.takeBatch(), { ok: true,
        results: [{ id: record.id, disposition: 'apply', template: '저장된 문단.' }] });
      session.restore();
      session.begin({});
      const f = scannerFixture(root, session);
      const seenDuringDiscovery = [];
      document.createRange = () => {
        let node;
        return {
          selectNodeContents(value) { node = value; },
          getBoundingClientRect() {
            if (node === fresh.childNodes[0]) seenDuringDiscovery.push(cached.textContent);
            return node.parentElement.getBoundingClientRect();
          },
          detach() {},
        };
      };
      try {
        f.viewport.start(root);
        assert.deepEqual(seenDuringDiscovery, ['Cached paragraph.']);
        assert.equal(cached.textContent, '저장된 문단.');
        assert.deepEqual(session.takeBatch().map(item => item.template), ['Fresh paragraph.']);
        session.restore();
        assert.deepEqual(cached.childNodes, original);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'shares style reads within one scan and refreshes them when the viewport changes',
    fn() {
      const { document, element, text } = createTestDocument();
      const paragraph = element('p', text('Read '), element('em', text('these notes')), text(' carefully.'));
      const root = element('div', paragraph);
      document.body.appendChild(root);
      const f = scannerFixture(root);
      const reads = new Map();
      let rectReads = 0;
      const getRect = paragraph.getBoundingClientRect.bind(paragraph);
      paragraph.getBoundingClientRect = () => { rectReads += 1; return getRect(); };
      const getStyle = f.platform.window.getComputedStyle;
      f.platform.window.getComputedStyle = node => {
        reads.set(node, (reads.get(node) || 0) + 1);
        return getStyle(node);
      };
      try {
        f.viewport.start(root);
        assert.deepEqual(f.admissions, [paragraph]);
        assert.equal(reads.get(paragraph), 1, 'one synchronous scan shares its style reads');
        assert.equal(rectReads, 2, 'one discovery read and one independent Session codec read');
        reads.clear();
        paragraph.computedStyle = { display: 'none' };
        f.event(f.platform.window, 'scroll');
        f.advance();
        assert.equal(reads.get(paragraph), 1);
        assert.deepEqual(f.session.takeBatch(), [], 'a later scan must read current styles');
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'continues a long DOM without re-reading its already visited prefix',
    fn() {
      const { document, element, text } = createTestDocument();
      const paragraphs = Array.from({ length: 4800 }, () => element('p', text('Visible prose.')));
      const root = element('div', ...paragraphs);
      document.body.appendChild(root);
      const children = root.childNodes;
      let expansions = 0;
      Object.defineProperty(root, 'childNodes', { get() { expansions += 1; return children; } });
      const f = scannerFixture(root);
      let styles = 0;
      let rects = 0;
      const getStyle = f.platform.window.getComputedStyle;
      f.platform.window.getComputedStyle = node => { styles += 1; return getStyle(node); };
      for (const node of [document.body, root, ...paragraphs]) {
        const getRect = node.getBoundingClientRect.bind(node);
        node.getBoundingClientRect = () => { rects += 1; return getRect(); };
      }
      try {
        f.viewport.start(root);
        for (let index = 0; f.timers.size && index < 4; index += 1) f.advance();
        assert.equal(f.timers.size, 0, 'the long DOM must finish in four scans');
        console.log('VIEWPORT_WORK ' + JSON.stringify({ fixture: '4800-visible-paragraphs',
          viewport: [500, 300], scans: f.scans, expansions, styles, rects }));
        assert.equal(f.admissions.length, paragraphs.length);
        assert.ok(f.admissions.every((block, index) => block === paragraphs[index]));
        assert.equal(f.scans, 4);
        assert.equal(expansions, 1, 'continuation must retain its pending traversal');
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'skips CSS-hidden headings and ancestors before admission and discovers revealed prose',
    fn() {
      const { document, element, text } = createTestDocument();
      const heading = element('h2', text('Repository navigation'));
      heading.computedStyle = { clip: 'rect(0px, 0px, 0px, 0px)', overflow: 'hidden' };
      heading.rect = { top: 20, bottom: 21, left: 10, right: 11, width: 1, height: 1 };
      const hiddenParent = element('div', element('p', text('Hidden navigation prose.')));
      hiddenParent.computedStyle = { clipPath: 'inset(50%)', overflow: 'hidden' };
      hiddenParent.rect = { ...heading.rect };
      const visible = element('p', text('Visible release notes.'));
      const root = element('div', heading, hiddenParent, visible);
      document.body.appendChild(root);
      const f = scannerFixture(root);
      try {
        f.viewport.start(root);
        assert.deepEqual(f.admissions, [visible]);
        assert.equal(f.session.progress().counts.failed, 0);
        heading.computedStyle = {};
        hiddenParent.computedStyle = {};
        f.viewport.rescan();
        f.advance();
        assert.ok(f.admissions.includes(heading));
        assert.ok(f.admissions.includes(hiddenParent.childNodes[0]));
        assert.equal(f.session.progress().counts.failed, 0);
      } finally { f.viewport.stop(); }
    },
  },
  {
    name: 'collects visible paragraphs under boxless and non-hiding styled ancestors',
    fn() {
      for (const style of [
        { display: 'contents', overflow: 'hidden' },
        { overflow: 'visible' },
        { fontSize: '0px' },
        { clipPath: 'inset(0px)' },
      ]) {
        const { document, element, text } = createTestDocument();
        const paragraph = element('p', text('Visible release notes.'));
        paragraph.computedStyle = { fontSize: '16px' };
        const root = element('div', paragraph);
        root.computedStyle = style;
        if (style.display || style.overflow === 'visible') {
          root.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
        }
        document.body.appendChild(root);
        const f = scannerFixture(root);
        try {
          f.viewport.start(root);
          assert.deepEqual(f.admissions, [paragraph], JSON.stringify(style));
          assert.equal(f.session.progress().counts.failed, 0);
        } finally { f.viewport.stop(); }
      }
    },
  },
  {
    name: 'does not read ancestor textContent while discovering paragraphs',
    fn() {
      const { document, element, text } = createTestDocument();
      const paragraphs = Array.from({ length: 100 }, () => element('p', text('Visible prose.')));
      const root = element('div', ...paragraphs);
      document.body.appendChild(root);
      let reads = 0;
      for (const ancestor of [root, document.body]) {
        Object.defineProperty(ancestor, 'textContent', {
          get() { reads += 1; return paragraphs.map(p => p.textContent).join(''); },
        });
      }
      const f = scannerFixture(root);
      try {
        f.viewport.start(root);
        assert.deepEqual(f.admissions, paragraphs);
        assert.equal(reads, 0);
      } finally { f.viewport.stop(); }
    },
  },
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
      const outer = paragraph(text('Outer prose cannot absorb an interior paragraph. '), inner,
        text(' Outer prose continues after the paragraph.'));
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
      assert.deepEqual(f.observers[0].options, { childList: true, subtree: true, characterData: true, attributes: true });
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
