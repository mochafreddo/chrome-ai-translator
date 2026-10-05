// Unbilled collection, deterministic apply, and exact restore on a local fixture
// and the reported page. No key is read and no model request is sent.
import { readFileSync } from 'node:fs';
import viewportHarness from '../viewport-harness.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-data-as-paragraph';
const PAGE_URL = 'https://code.claude.com/docs/en/advisor';
const { check, failures, finish } = createChecks('data-as paragraph');

async function exerciseParagraphs() {
  const paragraphs = [...document.querySelectorAll('span[data-as="p"]')];
  const results = [];
  for (const block of paragraphs) {
    block.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(resolve => setTimeout(resolve, 50));
    if (!block.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const originalHtml = block.outerHTML;
    const graph = [];
    const capture = node => {
      graph.push({ node, children: [...node.childNodes], value: node.nodeValue });
      node.childNodes.forEach(capture);
    };
    capture(block);
    const elements = [block, ...block.querySelectorAll('*')];
    const attributes = elements.map(node => JSON.stringify([...node.attributes].map(a => [a.name, a.value])));
    const codeNodes = [...block.querySelectorAll('code')];
    const codeHtml = codeNodes.map(node => node.outerHTML);
    const state = createInlineTranslationState();
    beginInlineTranslationOperation(state, {});
    const viewport = createViewportProbe(state.session);
    try {
      viewport.start(block);
      const collected = viewport.records;
      const duplicate = viewport.rescan();
      const batch = state.session.takeBatch();
      const [record] = batch;
      if (collected.length !== 1 || batch.length !== 1) {
        results.push({ collected: false });
        continue;
      }
      const output = record.template.split(/(⟦[^⟧]+⟧)/g)
        .map(part => part.startsWith('⟦') || !part.trim() ? part : '번역된 문단 ')
        .join('');
      state.session.settle(batch, { ok: true, results: [{ id: record.id, disposition: 'apply', template: output }] });
      const rescanned = viewport.rescan();
      const translated = state.session.progress().counts.translated === 1 && block.textContent.includes('번역된 문단');
      const preserved = elements.every((node, i) => node.isConnected &&
        JSON.stringify([...node.attributes].map(a => [a.name, a.value])) === attributes[i]) &&
        codeNodes.every((node, i) => node.outerHTML === codeHtml[i]);
      const unique = duplicate.length === 0 && rescanned.length === 0 && state.session.takeBatch().length === 0;
      state.session.restore();
      const restored = state.session.status === 'original';
      const exactGraph = graph.every(({ node, children, value }) =>
        node.nodeValue === value && node.childNodes.length === children.length &&
        children.every((child, index) => node.childNodes[index] === child));
      results.push({ collected: true, translated, preserved, unique, restored,
        exactGraph, exactHtml: block.outerHTML === originalHtml });
    } finally { viewport.stop(); }
  }
  return results;
}

async function verifyPage(page, label, expectedCount) {
  for (const file of ['default-model.js', 'placeholder-tokens.js', 'inline-block.js', 'inline-diagnostics-protocol.js', 'inline-translation-session.js', 'inline-viewport.js', 'content.js']) {
    await page.evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
  await page.evaluate(`globalThis.createViewportProbe = ${viewportHarness.createViewportProbe.toString()}`);
  const results = await page.evaluate(`(${exerciseParagraphs.toString()})().catch(error => ({ error: error.message }))`, 20000);
  check(`${label}: visible marked paragraphs are present`, Array.isArray(results) &&
    (expectedCount === undefined ? results.length > 0 : results.length === expectedCount), JSON.stringify(results));
  console.log(`INFO ${label}: ${results?.length ?? 0} visible marked paragraphs observed`);
  if (!Array.isArray(results)) return;
  for (const [index, result] of results.entries()) {
    check(`${label}: paragraph ${index + 1} collects once, applies, and restores`,
      Object.values(result).every(value => value === true), JSON.stringify(result));
  }
}

async function exerciseProtectedAtoms() {
  const results = [];
  for (const tag of ['a', 'code', 'kbd', 'samp']) {
    const outer = document.createElement('p');
    const atom = document.createElement(tag);
    const inner = document.createElement('span');
    inner.setAttribute('data-as', 'p');
    inner.textContent = 'Responses API';
    if (tag === 'a') atom.setAttribute('href', '#usage');
    atom.append(inner);
    outer.append('Read this documentation: ', atom);
    document.body.append(outer);
    const html = outer.outerHTML;
    const children = [...outer.childNodes];
    const originalText = inner.firstChild;
    let viewport;
    try {
      outer.scrollIntoView({ block: 'center', behavior: 'instant' });
      const state = createInlineTranslationState();
      beginInlineTranslationOperation(state, {});
      viewport = createViewportProbe(state.session);
      viewport.start(outer);
      viewport.rescan();
      const expected = tag === 'a' ? ['Responses API'] : [];
      const batch = state.session.takeBatch();
      const unique = batch.length === expected.length &&
        batch.every((record, i) => record.template === expected[i]);
      const rejected = state.session.progress().counts.failed === 1;
      const diagnostics = state.session.outbox.slice();
      let appliedAndRestored = true;
      if (tag === 'a') {
        const [record] = batch;
        if (!record) appliedAndRestored = false;
        else {
          state.session.settle(batch, { ok: true, results: [{ id: record.id, disposition: 'apply', template: '응답 API' }] });
          appliedAndRestored = state.session.progress().counts.translated === 1 && inner.textContent === '응답 API';
          state.session.restore();
        }
      }
      results.push({ tag, rejected, unique, appliedAndRestored,
        diagnostic: diagnostics.length === 1 &&
          diagnostics[0].localRejection?.reason === 'nested_semantic_block' &&
          diagnostics[0].localRejection?.tag === 'SPAN',
        restored: outer.outerHTML === html && outer.childNodes.length === children.length &&
          children.every((node, i) => outer.childNodes[i] === node) && atom.firstChild === inner &&
          inner.childNodes.length === 1 && inner.firstChild === originalText });
    } finally {
      viewport?.stop();
      outer.remove();
    }
  }
  return results;
}

let ctx;
let fixture;
try {
  fixture = await serveFixture(join(HERE, 'fixtures', 'data-as-paragraph.html'));
  ctx = await launchExtensionBrowser({ session: SESSION, url: fixture.url, extensionDir: EXTENSION_DIR });
  if (!ctx.page || !ctx.extension) throw new Error('Fixture page or extension did not load');
  await verifyPage(ctx.page, 'fixture', 2);
  const atoms = await ctx.page.evaluate(`(${exerciseProtectedAtoms.toString()})()`);
  check('fixture: protected atom cases are present', Array.isArray(atoms) && atoms.length === 4, JSON.stringify(atoms));
  for (const { tag, ...result } of atoms || []) {
    check(`fixture: ${tag} prevents overlapping paragraph ownership`,
      Object.values(result).every(value => value === true), JSON.stringify(result));
  }
  await ctx.page.navigate(PAGE_URL);
  const ready = await until(() => ctx.page.evaluate(`document.querySelectorAll('span[data-as="p"]').length > 0`), 20000);
  if (check('reported page renders marked paragraphs', ready)) await verifyPage(ctx.page, 'reported page');
} catch (error) {
  failures.push('harness');
  console.error(`FAIL data-as paragraph - ${error?.message || error}`);
} finally {
  ctx?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
