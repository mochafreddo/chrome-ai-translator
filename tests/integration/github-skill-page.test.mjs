// Unbilled preflight regression on a local table fixture and public GitHub skill pages.
// No API key is read and no model request is sent. Run explicitly with
// `npm run test:integration:github-skill-page`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import viewportHarness from '../viewport-harness.js';
import domTree from '../dom-tree.js';
import background from '../../extension/background.js';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-github-skill-page';
const ORIGINAL_PAGE_URL = 'https://github.com/mattpocock/skills/blob/main/skills/engineering/ask-matt/SKILL.md';
const REPORTED_PAGE_URL = 'https://github.com/garrytan/gstack/blob/main/test-audit/SKILL.md';
const { check, failures, finish } = createChecks('github skill page');

async function inject(evaluate) {
  for (const file of background.getInlineContentScriptFiles()) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
  await evaluate(`globalThis.createViewportProbe = ${viewportHarness.createViewportProbe.toString()}`);
  await evaluate(`globalThis.captureDomTree = ${domTree.captureDomTree.toString()}`);
}

async function collectArticle() {
  const root = document.querySelector('article.markdown-body');
  if (!root) throw new Error('Rendered Markdown article is missing');
  const session = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
  session.begin({});
  const viewport = createViewportProbe(session);
  const candidates = [root, ...root.querySelectorAll('*')]
    .filter((element) => ChromeAiTranslatorInlineBlock.isSemanticBlockElement(element));
  try {
    viewport.start(root);
    for (const candidate of candidates) {
      candidate.scrollIntoView({ block: 'center', behavior: 'instant' });
      viewport.rescan();
    }
  } finally { viewport.stop(); }
  const records = viewport.records;
  const metadataCells = [...root.querySelectorAll('td,th')].filter((cell) => {
    const children = [...cell.childNodes];
    const elements = children.filter((node) => node.nodeType === Node.ELEMENT_NODE);
    return elements.length === 1 && elements[0].tagName === 'DIV' &&
      !elements[0].querySelector('table') && /[A-Za-z]/.test(elements[0].textContent) &&
      children.every((node) => node === elements[0] ||
        (node.nodeType === Node.TEXT_NODE && !node.nodeValue.trim()));
  });
  const admittedMetadataCells = records.filter((record) =>
    metadataCells.includes(record.snapshot?.blockElement) && record.state === 'queued');
  const abbreviationChecks = [];
  const abbreviationCandidates = candidates.filter((element) =>
    /\b(?:e\.g\.|i\.e\.)/i.test(element.textContent));
  for (const candidate of abbreviationCandidates) {
    const serialized = ChromeAiTranslatorInlineBlock.serializeBlock(candidate);
    if (!serialized.ok) continue;
    const translated = serialized.template.replace(/\b(e\.g\.|i\.e\.)/gi, 'for example');
    abbreviationChecks.push(ChromeAiTranslatorInlineBlock.validateTranslatedTemplate(
      translated, serialized.contract
    ));
  }
  return {
    attempted: records.length,
    counts: session.progress().counts,
    metadataCellCount: metadataCells.length,
    admittedMetadataCellCount: admittedMetadataCells.length,
    abbreviationChecks,
    localRejections: session.outbox.map(({ code, localRejection }) => ({ code, localRejection })),
  };
}

async function exerciseFixture() {
  const root = document.querySelector('#scrollport');
  if (!root) throw new Error('Scrollable table fixture is missing');
  const cells = [...root.querySelectorAll('td,th')];
  const lowerCell = cells.at(-1);
  const session = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
  session.begin({});
  const viewport = createViewportProbe(session);
  let lowerCellInitiallyAbsent;
  try {
    viewport.start(root);
    lowerCellInitiallyAbsent = !viewport.records.some((record) => record.blockElement === lowerCell);
    for (const cell of cells) {
      cell.scrollIntoView({ block: 'center', behavior: 'instant' });
      viewport.rescan();
    }
  } finally { viewport.stop(); }
  const scrolledToLowerContent = lowerCellInitiallyAbsent && root.scrollTop > 0 &&
    lowerCell.getBoundingClientRect().top < root.getBoundingClientRect().bottom &&
    lowerCell.getBoundingClientRect().bottom > root.getBoundingClientRect().top;
  const allCellsAdmitted = viewport.records.length === cells.length &&
    viewport.records.every(({ state, snapshot }) => state === 'queued' && snapshot?.blockElement);
  const results = [];
  for (const cell of cells) {
    cell.scrollIntoView({ block: 'center', behavior: 'instant' });
    const originalHtml = cell.outerHTML;
    const graph = captureDomTree(cell);
    const elements = [cell, ...cell.querySelectorAll('*')];
    const attributes = elements.map((node) => [...node.attributes].map(({ name, value }) => [name, value]));
    const application = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
    application.begin({});
    const record = application.admit(cell);
    const batch = application.takeBatch();
    const translated = batch.map((item) => ({
      id: item.id,
      disposition: 'apply',
      template: item.template.split(/(⟦[^⟧]+⟧)/g)
        .map((part) => part.startsWith('⟦') || !part.trim() ? part : `번역 ${part}`)
        .join(''),
    }));
    const outcome = application.settle(batch, { ok: true, results: translated });
    const applied = batch.length === 1 && record.state === 'translated' && cell.textContent.includes('번역');
    const preserved = elements.every((node, index) => cell.contains(node) &&
      JSON.stringify([...node.attributes].map(({ name, value }) => [name, value])) ===
        JSON.stringify(attributes[index]));
    const beforeRestoreCounts = application.progress().counts;
    application.restore();
    const exactRestore = application.status === 'original' && cell.outerHTML === originalHtml &&
      graph.matches();
    results.push({ applied, preserved, exactRestore, beforeRestoreCounts, outcome });
  }
  return { scrolledToLowerContent, allCellsAdmitted,
    applied: results.every((result) => result.applied),
    preserved: results.every((result) => result.preserved),
    exactRestore: results.every((result) => result.exactRestore), results,
    rejections: session.outbox.map(({ code, localRejection }) => ({ code, localRejection })),
  };
}

async function checkReportedPage(page, url, label, abbreviation = false) {
  await page.navigate(url);
  const ready = await until(() => page.evaluate(
    `Boolean(document.querySelector('article.markdown-body')?.textContent.trim())`
  ), 20000, 250);
  if (!check(`${label}: rendered Markdown article became ready`, ready === true)) return;
  await inject(page.evaluate);
  const result = await page.evaluate(
    `(${collectArticle.toString()})().catch(error => ({ error: error.message }))`, 60000
  );
  console.log(`INFO ${label} - ${result?.attempted ?? 0} Semantic Blocks observed; ` +
    `${result?.admittedMetadataCellCount ?? 0}/${result?.metadataCellCount ?? 0} sole-DIV table cells admitted`);
  if (label === 'mattpocock page') {
    check(`${label}: every collected Semantic Block passes local preflight`,
      result?.attempted > 0 && result?.counts?.failed === 0, JSON.stringify(result));
  } else {
    check(`${label}: sole-DIV metadata table cells are admitted`,
      result?.metadataCellCount > 0 &&
        result.admittedMetadataCellCount === result.metadataCellCount, JSON.stringify(result));
  }
  if (abbreviation) {
    check(`${label}: ordinary abbreviations pass the public template validator`,
      result?.abbreviationChecks?.length > 0 && result.abbreviationChecks.every(({ ok }) => ok),
      JSON.stringify(result?.abbreviationChecks));
  }
}

let context;
let fixture;
let stopWatchingRequests;
let modelRequests = 0;
try {
  fixture = await serveFixture(join(HERE, 'fixtures', 'github-skill-page.html'));
  context = await launchExtensionBrowser({ session: SESSION, url: fixture.url, extensionDir: EXTENSION_DIR });
  if (!context.extension || !context.page) throw new Error('Extension or fixture page did not load');
  const pageNetwork = await context.cdp.send('Network.enable', {}, context.page.sessionId);
  if (pageNetwork.__error || pageNetwork.__timeout) throw new Error('Page network observation failed');
  const workers = (await context.listTargets()).filter((target) =>
    target.type === 'service_worker' &&
    String(target.url || '').startsWith(`chrome-extension://${context.extension.id}/`)
  );
  if (!workers.length) throw new Error('Extension worker network cannot be observed');
  for (const target of workers) {
    const worker = await context.attach(target.targetId, target.type);
    const network = await context.cdp.send('Network.enable', {}, worker.sessionId);
    if (network.__error || network.__timeout) throw new Error('Extension worker network observation failed');
  }
  stopWatchingRequests = context.cdp.on('Network.requestWillBeSent', (params) => {
    if (/^https:\/\/(?:api\.openai\.com|openrouter\.ai)\//.test(String(params?.request?.url || ''))) {
      modelRequests += 1;
    }
  });

  await inject(context.page.evaluate);
  const fixtureResult = await context.page.evaluate(
    `(${exerciseFixture.toString()})().catch(error => ({ error: error.message }))`, 20000
  );
  check('local fixture scrolls its own viewport and admits every sole-DIV TH/TD',
    fixtureResult?.scrolledToLowerContent && fixtureResult?.allCellsAdmitted, JSON.stringify(fixtureResult));
  check('local fixture applies translations while preserving nodes and attributes',
    fixtureResult?.applied && fixtureResult?.preserved, JSON.stringify(fixtureResult));
  check('local fixture restores the exact DOM and text-node graph',
    fixtureResult?.exactRestore, JSON.stringify(fixtureResult));

  await checkReportedPage(context.page, ORIGINAL_PAGE_URL, 'mattpocock page');
  await checkReportedPage(context.page, REPORTED_PAGE_URL, 'gstack page', true);
  check('no model request was sent from the page or extension worker',
    modelRequests === 0, JSON.stringify({ modelRequests }));
} catch (error) {
  failures.push('harness');
  console.error(`FAIL github skill page - harness threw: ${error?.message || error}`);
} finally {
  stopWatchingRequests?.();
  context?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
