import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import background from '../../extension/background.js';
import domTree from '../dom-tree.js';
import viewportHarness from '../viewport-harness.js';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const FIXTURE = join(HERE, 'fixtures', 'mise-recipe.html');
const PAGE_URL = 'https://mise.jdx.dev/';
const SESSION = `mise-recipe-${randomUUID().slice(0, 8)}`;
const { check, failures, finish } = createChecks('mise recipe fixture');

function exercise(captureDomTree, createViewportProbe) {
  const codec = globalThis.ChromeAiTranslatorInlineBlock;
  const block = document.querySelector('li.recipe-row');
  const prose = block.firstElementChild;
  const code = block.lastElementChild;
  const heading = prose.querySelector('h3');
  const paragraph = prose.querySelector('p');
  const session = globalThis.ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
  session.begin({});
  const viewport = createViewportProbe(session);
  try { viewport.start(document.querySelector('main')); } finally { viewport.stop(); }
  const discovered = [block, heading, paragraph].every((element) =>
    viewport.records.some((record) => record.snapshot?.blockElement === element));
  let independent = true;
  for (const childFirst of [false, true]) {
    const graph = captureDomTree(block);
    const entries = [block, heading, paragraph].map((element, index) => {
      const serialized = codec.serializeBlock(element);
      if (!serialized.ok) throw new Error('Supported recipe block was rejected');
      return { ...serialized, translated: serialized.template.replace(
        ['Step 1', 'Install tool', 'Run the installer.'][index],
        ['1단계', '도구 설치', '설치 프로그램을 실행하세요.'][index]) };
    });
    const parent = entries[0];
    if (parent.template.includes('tool') || parent.template.includes('v24')) {
      throw new Error('Code or child prose entered the parent template');
    }
    const ordered = childFirst ? [...entries].reverse() : entries;
    for (const entry of ordered) {
      independent = codec.validateTranslatedTemplate(entry.translated, entry.contract).ok &&
        codec.applyTranslatedTemplate(entry.snapshot, entry.translated).ok && independent;
    }
    independent = prose.textContent === '1단계도구 설치설치 프로그램을 실행하세요.' &&
      block.firstElementChild === prose && block.lastElementChild === code && independent;
    for (const entry of [...ordered].reverse()) independent = codec.restoreBlock(entry.snapshot).ok && independent;
    independent = graph.matches() && independent;
  }
  const serialized = codec.serializeBlock(block);
  const output = code.lastElementChild.firstChild;
  output.nodeValue = 'v25.0.0';
  const applied = codec.applyTranslatedTemplate(serialized.snapshot, serialized.template.replace('Step 1', '1단계'));
  output.nodeValue = 'v26.0.0';
  const restored = codec.restoreBlock(serialized.snapshot);
  const codeUpdates = applied.ok && restored.ok && block.lastElementChild === code &&
    code.lastElementChild.firstChild === output && output.nodeValue === 'v26.0.0' &&
    prose.querySelector('.recipe-num').textContent === 'Step 1';
  const stale = codec.serializeBlock(block);
  const replacement = code.cloneNode(true);
  code.replaceWith(replacement);
  const changedGraph = captureDomTree(block);
  const rejected = codec.applyTranslatedTemplate(stale.snapshot, stale.template.replace('Step 1', '1단계'));
  return { discovered, independent, codeUpdates,
    replacementSafe: !rejected.ok && rejected.errorCode === 'block_changed' && changedGraph.matches() };
}

let context;
let fixture;
let stopRequests;
const interceptionErrors = [];
let fulfilled = 0;
try {
  fixture = await serveFixture(FIXTURE);
  context = await launchExtensionBrowser({ session: SESSION, url: fixture.url, extensionDir: EXTENSION_DIR });
  const inject = async () => {
    for (const file of background.getInlineContentScriptFiles().filter((file) => file !== 'content.js')) {
      await context.page.evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
    }
  };
  await inject();
  check('same markup on loopback remains unsupported', await context.page.evaluate(
    `ChromeAiTranslatorInlineBlock.serializeBlock(document.querySelector('li')).ok === false`));
  stopRequests = context.cdp.on('Fetch.requestPaused', (event, sessionId) => {
    if (sessionId !== context.page.sessionId) return;
    void (async () => {
      const result = await context.cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
        body: readFileSync(FIXTURE).toString('base64'),
      }, sessionId);
      if (result.__error || result.__timeout) throw new Error('Fixture fulfillment failed');
      fulfilled += 1;
    })().catch(() => { interceptionErrors.push('fixture interception failed'); });
  });
  const enabled = await context.cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: PAGE_URL, requestStage: 'Request' }],
  }, context.page.sessionId);
  if (enabled.__error || enabled.__timeout) throw new Error('Fixture interception unavailable');
  await context.page.navigate(PAGE_URL, 0);
  if (!await until(() => context.page.evaluate(
    `location.href === ${JSON.stringify(PAGE_URL)} && document.title === 'Mise recipe boundary fixture'`
  ), 10000, 100)) throw new Error('Fixture did not load at the expected site URL');
  await inject();
  const result = await context.page.evaluate(
    `(() => { try { return (${exercise.toString()})(${domTree.captureDomTree.toString()}, ${viewportHarness.createViewportProbe.toString()}); } catch (error) { return { error: error.message }; } })()`);
  for (const name of ['discovered', 'independent', 'codeUpdates', 'replacementSafe']) {
    check(name, result?.[name] === true, JSON.stringify(result));
  }
  check('site URL was fulfilled entirely from the fixed fixture', fulfilled === 1 && interceptionErrors.length === 0);
} catch (error) {
  failures.push('harness');
  console.error(`FAIL mise recipe fixture - ${error?.message || error}`);
} finally {
  stopRequests?.();
  context?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
