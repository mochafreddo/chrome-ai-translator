// Unbilled regression and reported-page check. Collection, serialization, DOM
// apply, focus/click behavior, and exact restoration use deterministic output.
// No key is read and no translation request is made. The live heading count is
// observed, not pinned; markup drift or a missing page fails this check.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-heading-permalink';
const PAGE_URL = 'https://code.claude.com/docs/en/advisor';
const { check, failures, finish } = createChecks('heading permalink');

async function inject(evaluate) {
  for (const file of ['default-model.js', 'placeholder-tokens.js', 'inline-block.js', 'inline-diagnostics-protocol.js', 'content.js']) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
}

// Runs in the page, so references never leave the DOM being checked.
async function exerciseHeadings() {
  const codec = ChromeAiTranslatorInlineBlock;
  const headings = Array.from(document.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'))
    .filter((heading) => Array.from(heading.querySelectorAll('a')).some((link) =>
      link.getAttribute('href') === `#${heading.id}` && !/[\p{L}\p{N}]/u.test(link.textContent)));
  const results = [];
  for (const heading of headings) {
    heading.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (!heading.getBoundingClientRect().width || !heading.getBoundingClientRect().height) continue;
    const originalHtml = heading.outerHTML;
    const graph = [];
    const capture = (node) => {
      graph.push({ node, children: [...node.childNodes], value: node.nodeValue });
      node.childNodes.forEach(capture);
    };
    capture(heading);
    const link = Array.from(heading.querySelectorAll('a')).find((node) => node.getAttribute('href') === `#${heading.id}`);
    let control = link;
    while (control.parentElement !== heading) control = control.parentElement;
    const leading = heading.firstChild === control;
    const controlHtml = control.outerHTML;
    const href = link.getAttribute('href');
    const label = link.getAttribute('aria-label');
    let clicks = 0;
    const onClick = () => { clicks += 1; };
    link.addEventListener('click', onClick);
    const store = createInlineViewportStore(59);
    const records = collectVisibleInlineBlocks(heading, store);
    const record = records.find((item) => item.blockElement === heading);
    if (records.length !== 1 || record?.state !== 'queued') {
      results.push({ collected: false, rejection: store.localDiagnostics.map((item) => item.localRejection) });
      link.removeEventListener('click', onClick);
      continue;
    }
    // The reported headings wrap their prose in a span. Preserve every Placeholder Token
    // literally while substituting deterministic text between placeholder boundaries.
    const output = record.template.split(/(⟦[^⟧]+⟧)/g)
      .map((part) => part.startsWith('⟦') || !part.trim() ? part : '번역된 제목')
      .join('');
    link.focus();
    const focusedBefore = document.activeElement === link;
    const plan = codec.createPatchPlan(record.snapshot, output);
    const applied = codec.applyPatchPlan(record.snapshot, plan);
    const request = JSON.stringify({ template: record.template, atoms: record.atoms, contract: record.contract });
    const localOnly = !request.includes(href) && !request.includes(label) && !request.includes('\u200b');
    const preserved = control.outerHTML === controlHtml && link.isConnected &&
      (leading ? heading.firstChild === control : heading.lastChild === control) &&
      document.activeElement === link;
    link.click();
    const clickedAfterApply = clicks === 1 && location.hash === href;
    // Fragment navigation may move focus to the heading; focus the control
    // again so restoration is tested independently from that native behavior.
    link.focus();
    const focusedBeforeRestore = document.activeElement === link;
    const restored = codec.restoreBlock(record.snapshot);
    const exactGraph = graph.every(({ node, children, value }) =>
      node.nodeValue === value && node.childNodes.length === children.length &&
      children.every((child, index) => node.childNodes[index] === child));
    const focusedAfterRestore = document.activeElement === link;
    link.click();
    results.push({ collected: true, applied: applied.ok, translated: output !== record.template,
      localOnly, preserved, focusedBefore, clickedAfterApply, restored: restored.ok,
      exactGraph, exactHtml: heading.outerHTML === originalHtml, focusedBeforeRestore, focusedAfterRestore,
      clickedAfterRestore: clicks === 2 && location.hash === href });
    link.removeEventListener('click', onClick);
  }
  return results;
}

async function verifyPage(page, label) {
  await inject(page.evaluate);
  const results = await page.evaluate(`(${exerciseHeadings.toString()})().catch(error => ({ error: error.message, stack: error.stack }))`, 20000);
  check(`${label}: observed heading count`, Array.isArray(results) && results.length > 0, JSON.stringify(results));
  console.log(`INFO ${label}: ${results?.length ?? 0} affected visible headings observed`);
  if (!Array.isArray(results)) return;
  for (const [index, result] of results.entries()) {
    check(`${label}: heading ${index + 1} collects, applies, and restores`,
      Object.values(result).every((value) => value === true), JSON.stringify(result));
  }
}

let ctx;
let fixture;
try {
  fixture = await serveFixture(join(HERE, 'fixtures', 'heading-permalink.html'));
  ctx = await launchExtensionBrowser({ session: SESSION, url: fixture.url, extensionDir: EXTENSION_DIR });
  if (!ctx.page || !ctx.extension) throw new Error('Fixture page or extension did not load');
  await verifyPage(ctx.page, 'fixture');
  await ctx.page.navigate(PAGE_URL);
  const ready = await until(() => ctx.page.evaluate(`document.querySelectorAll('h2[id] a[href^="#"]').length > 0`), 20000);
  if (check('reported page renders heading permalinks', ready)) await verifyPage(ctx.page, 'reported page');
} catch (error) {
  failures.push('harness');
  console.error(`FAIL heading permalink - ${error?.message || error}`);
} finally {
  ctx?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
