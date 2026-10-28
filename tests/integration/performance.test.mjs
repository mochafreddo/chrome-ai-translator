import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browser, launchExtensionBrowser, serveFixture } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--extension-dir')) {
  throw new Error('Use --extension-dir <directory> for a comparison revision');
}
const extensionDir = args.length ? resolve(args[1]) : join(HERE, '..', '..', 'extension');
const session = `perf-${randomUUID().slice(0, 8)}`;
let fixture;
let ctx;
try {
  fixture = await serveFixture(join(HERE, 'fixtures', 'inline-translation.html'));
  ctx = await launchExtensionBrowser({ session, url: fixture.url, extensionDir });
  await ctx.cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1280, height: 900, deviceScaleFactor: 1, mobile: false,
  }, ctx.page.sessionId);
  for (const name of ['default-model.js', 'placeholder-tokens.js', 'inline-block.js', 'inline-request.js',
    'inline-diagnostics-protocol.js', 'inline-translation-session.js', 'inline-viewport.js']) {
    await ctx.page.evaluate(readFileSync(join(extensionDir, name), 'utf8'));
  }
  const result = await ctx.page.evaluate(`(() => {
    document.body.innerHTML = '<main style="position:relative;width:1000px;height:600px"></main>';
    const root = document.querySelector('main');
    for (let index = 0; index < 4800; index++) {
      const p = document.createElement('p');
      p.style.cssText = 'position:absolute;top:10px;left:10px';
      p.textContent = 'This is a visible paragraph with ordinary article prose.';
      root.appendChild(p);
    }
    let styles = 0, rectangles = 0, scans = 0;
    const getStyle = window.getComputedStyle.bind(window);
    const elementRect = Element.prototype.getBoundingClientRect;
    const rangeRect = Range.prototype.getBoundingClientRect;
    window.getComputedStyle = (...args) => { styles++; return getStyle(...args); };
    Element.prototype.getBoundingClientRect = function() { rectangles++; return elementRect.call(this); };
    Range.prototype.getBoundingClientRect = function() { rectangles++; return rangeRect.call(this); };
    const timers = new Map();
    let next = 0, admissions = 0;
    const seen = new Set();
    const visit = { operationId: 1, status: 'active', isCurrent: () => true,
      resetQueue() {}, admit(block) { admissions++; seen.add(block); } };
    const viewport = ChromeAiTranslatorInlineViewport.createInlineViewport({
      session: visit, onScan() { scans++; },
      platform: { window, document, HTMLElement, MutationObserver,
        setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); } },
    });
    try {
      viewport.start(root);
      while (timers.size) {
        if (scans > 20) throw new Error('Continuation did not finish');
        const [id, fn] = timers.entries().next().value;
        timers.delete(id); fn();
      }
      return { styles, rectangles, scans, admissions, uniqueBlocks: seen.size };
    } finally {
      viewport.stop();
      window.getComputedStyle = getStyle;
      Element.prototype.getBoundingClientRect = elementRect;
      Range.prototype.getBoundingClientRect = rangeRect;
    }
  })()`);
  console.log(JSON.stringify({ browser: ctx.browserVersion, viewport: [1280, 900],
    fixture: '4800 overlapping visible paragraphs', ...result }));
  assert.equal(result?.uniqueBlocks, 4800);
  assert.equal(result.admissions, 4800);
  assert.equal(result.scans, 4);
  assert.ok(result.styles < 10000, 'Style reads are bounded by one synchronous scan');
  assert.ok(result.rectangles < 15000, 'Rectangle reads avoid repeated ancestor and prefix work');
  console.log('PASS performance - bounded DOM continuation and synchronous layout reads');
  const cached = await ctx.page.evaluate(`(() => {
    document.body.innerHTML = '<main></main>';
    const root = document.querySelector('main');
    const source = 'This is a visible paragraph with ordinary article prose.';
    const create = () => {
      const p = document.createElement('p');
      p.style.cssText = 'position:absolute;top:10px;left:10px';
      p.textContent = source; root.appendChild(p); return p;
    };
    const seed = create();
    const visit = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
    visit.begin({ targetLanguage: 'Korean', tone: 'technical' });
    visit.admit(seed);
    const batch = visit.takeBatch();
    visit.settle(batch, { ok: true, results: batch.map(record => ({
      id: record.id, disposition: 'apply', template: '캐시에 보관한 번역입니다.', attemptCount: 1,
    })) });
    visit.restore();
    root.replaceChildren();
    const paragraphs = Array.from({ length: 1300 }, create);
    const textNodes = paragraphs.map(p => p.firstChild);
    const html = root.innerHTML;
    visit.begin({ targetLanguage: 'Korean', tone: 'technical' });
    const timers = new Map();
    let next = 0, scans = 0;
    const viewport = ChromeAiTranslatorInlineViewport.createInlineViewport({ session: visit,
      onScan() { scans++; }, platform: { window, document, HTMLElement, MutationObserver,
        setTimeout(fn) { const id = ++next; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); } },
    });
    try {
      viewport.start(root);
      while (timers.size) {
        if (scans > 20) throw new Error('Cached continuation did not finish');
        const [id, fn] = timers.entries().next().value;
        timers.delete(id); fn();
      }
      const translated = paragraphs.filter(p => p.textContent === '캐시에 보관한 번역입니다.').length;
      const pending = visit.progress().counts.pending;
      const requests = visit.takeBatch().length;
      viewport.stop();
      visit.restore();
      return { translated, pending, requests, restored: root.innerHTML === html &&
        paragraphs.every((p, i) => p.parentNode === root && p.firstChild === textNodes[i]), scans };
    } finally { viewport.stop(); }
  })()`);
  console.log(JSON.stringify({ cachedContinuation: cached }));
  assert.equal(cached?.translated, 1300);
  assert.equal(cached.pending, 0);
  assert.equal(cached.requests, 0);
  assert.equal(cached.restored, true);
  console.log('PASS performance - real cache mutations invalidate continuation and restore exact nodes');
} finally {
  ctx?.close();
  await browser(['close', '--session', session], 30000).catch(() => {});
  fixture?.close();
}
