import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import viewportHarness from '../viewport-harness.js';
import background from '../../extension/background.js';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until } from './harness.mjs';
import { parseBrowserCheckMode } from './browser-check-mode.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = 'chrome-ai-translator-inline-button';
const PAGE_URL = 'https://aiforui.dev/';
const mode = parseBrowserCheckMode(process.argv.slice(2));
const { check, failures, finish } = createChecks('inline button');

async function inject(page) {
  for (const file of background.getInlineContentScriptFiles()) {
    await page.evaluate(readFileSync(join(HERE, '../../extension', file), 'utf8'));
  }
  await page.evaluate(`globalThis.createViewportProbe = ${viewportHarness.createViewportProbe.toString()}`);
}

function exerciseButtons(legacy, reported) {
  const originalMove = Element.prototype.moveBefore;
  const paragraphs = [...document.querySelectorAll('p')].filter((p) => p.querySelector('button[type="button"]'));
  const results = [];
  if (legacy) Element.prototype.moveBefore = undefined;
  try {
    for (const paragraph of paragraphs) {
      paragraph.scrollIntoView({ block: 'center', behavior: 'instant' });
      const buttons = [...paragraph.querySelectorAll('button')];
      const graph = [];
      const capture = (node) => {
        graph.push({ node, children: [...node.childNodes], value: node.nodeValue });
        node.childNodes.forEach(capture);
      };
      capture(paragraph);
      const buttonGraphs = buttons.map((button) => button.innerHTML);
      for (const focusButton of buttons) {
        const session = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
        session.begin({});
        const viewport = createViewportProbe(session);
        try { viewport.start(paragraph); } finally { viewport.stop(); }
        const batch = session.takeBatch();
        if (batch.length !== 1) { results.push({ admitted: false }); continue; }
        const [record] = batch;
        const render = (parentId) => record.contract.entries.filter((entry) => entry.parentId === parentId)
          .reverse().map((entry) => entry.kind === 'atom' ? entry.token :
            `${entry.openToken}번역된 문장 ${render(entry.id)}${entry.closeToken}`).join('');
        const output = `${render('ROOT')} 애니메이션 도구도 받습니다.`;
        focusButton.focus({ preventScroll: true });
        const focusedBefore = document.activeElement === focusButton;
        let blurs = 0;
        let observedClicks = 0;
        const onBlur = () => { blurs += 1; };
        const onClick = () => { observedClicks += 1; };
        focusButton.addEventListener('blur', onBlur);
        focusButton.addEventListener('click', onClick);
        const scrollBefore = window.scrollY;
        session.settle(batch, { ok: true, results: [{ id: record.id, disposition: 'apply', template: output }] });
        const applied = session.progress().counts.translated === 1;
        const focusedAfterApply = document.activeElement === focusButton && blurs === 0;
        const scrollStable = window.scrollY === scrollBefore;
        const buttonSubtrees = buttons.every((button, index) => button.innerHTML === buttonGraphs[index]);
        const positionChanged = graph[0].children.some((child, index) => paragraph.childNodes[index] !== child);
        if (!reported) focusButton.click();
        const pageClickHandled = focusButton.dataset.clicks === '1';
        const clicked = observedClicks === 1;
        const stateBeforeRestore = focusButton.getAttribute('aria-expanded');
        const focusBeforeRestore = document.activeElement;
        const blursBeforeRestore = blurs;
        session.restore();
        const focusedAfterRestore = document.activeElement === focusBeforeRestore && blurs === blursBeforeRestore;
        const exactGraph = graph.every(({ node, children, value }) => node.nodeValue === value &&
          node.childNodes.length === children.length && children.every((child, index) => node.childNodes[index] === child));
        const statePreserved = focusButton.getAttribute('aria-expanded') === stateBeforeRestore;
        if (!reported) focusButton.click();
        const clickAfterRestore = observedClicks === 2 && focusButton.dataset.clicks === '2';
        focusButton.removeEventListener('blur', onBlur);
        focusButton.removeEventListener('click', onClick);
        if (!reported) delete focusButton.dataset.clicks;
        results.push({ admitted: true, focusedBefore, applied, positionChanged, focusedAfterApply,
          scrollStable, buttonSubtrees, focusedAfterRestore, exactGraph, statePreserved,
          ...(!reported ? { clicked, pageClickHandled, clickAfterRestore } : {}) });
      }
    }
  } finally {
    if (legacy) Element.prototype.moveBefore = originalMove;
  }
  return results;
}

function exerciseBlockChildren(legacy) {
  const originalMove = Element.prototype.moveBefore;
  if (legacy) Element.prototype.moveBefore = undefined;
  try {
    const block = document.querySelector('li');
    const frame = block.querySelector('iframe');
    const frameWindow = frame.contentWindow;
    frameWindow.ownState = 'retained';
    const codec = ChromeAiTranslatorInlineBlock;
    const serialized = codec.serializeBlock(block);
    const applied = codec.applyTranslatedTemplate(serialized.snapshot, '이 문장을 읽으세요.');
    const liveAfterApply = frame.contentWindow === frameWindow && frame.contentWindow.ownState === 'retained';
    const restored = codec.restoreBlock(serialized.snapshot);
    return { applied: applied.ok, restored: restored.ok, liveAfterApply,
      liveAfterRestore: frame.contentWindow === frameWindow && frame.contentWindow.ownState === 'retained' };
  } finally {
    if (legacy) Element.prototype.moveBefore = originalMove;
  }
}

let ctx;
let fixture;
let modelRequests = 0;
try {
  if (mode.fixture) fixture = await serveFixture(join(HERE, 'fixtures/inline-button.html'));
  ctx = await launchExtensionBrowser({ session: SESSION, url: fixture?.url || PAGE_URL, extensionDir: join(HERE, '../../extension') });
  console.log(`INFO Chrome ${ctx.browserVersion}`);
  ctx.cdp.on('Network.requestWillBeSent', ({ request }) => {
    if (/^https:\/\/(?:api\.openai\.com|openrouter\.ai)\//.test(request.url)) modelRequests += 1;
  });
  await ctx.cdp.send('Network.enable', {}, ctx.page.sessionId);
  for (const target of await ctx.listTargets()) {
    if (target.type !== 'service_worker' || !target.url.startsWith(`chrome-extension://${ctx.extension.id}/`)) continue;
    const worker = await ctx.attach(target.targetId, 'service_worker');
    await ctx.cdp.send('Network.enable', {}, worker.sessionId);
  }
  if (mode.fixture) {
    await inject(ctx.page);
    check('native state-preserving move is available', await ctx.page.evaluate(`typeof Element.prototype.moveBefore === 'function'`));
    check('Block Child frame is ready', await until(() => ctx.page.evaluate(`document.querySelector('iframe').contentDocument.body.textContent === 'Frame state'`), 10000));
    for (const legacy of [false, true]) {
      const results = await ctx.page.evaluate(`(${exerciseButtons.toString()})(${legacy}, false)`);
      check(`${legacy ? 'legacy insertBefore' : 'native moveBefore'}: reorder, click, focus and exact restore`,
        Array.isArray(results) && results.length === 5 && results.every((result) => Object.values(result).every(Boolean)),
        JSON.stringify(results));
      const blockChildren = await ctx.page.evaluate(`(${exerciseBlockChildren.toString()})(${legacy})`);
      check(`${legacy ? 'legacy' : 'native'}: Block Child browsing context remains live`,
        !!blockChildren && Object.values(blockChildren).every(Boolean), JSON.stringify(blockChildren));
    }
    const keyboardPrepared = await ctx.page.evaluate(`(() => {
      const paragraph = document.querySelector('p');
      const button = paragraph.querySelector('button');
      const session = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
      session.begin({}); session.admit(paragraph);
      const batch = session.takeBatch();
      if (batch.length !== 1) return false;
      button.focus();
      session.settle(batch, { ok: true, results: [{ id: batch[0].id, disposition: 'apply',
        template: batch[0].atoms.map(atom => atom.token).reverse().join('') + ' 도구도 받습니다.' }] });
      globalThis.inlineButtonKeyboardProbe = { session, button };
      return session.progress().counts.translated === 1 && document.activeElement === button;
    })()`);
    check('translated button is ready for native keyboard activation', keyboardPrepared);
    await browser(['--session', SESSION, 'press', 'Enter']);
    const keyboard = await ctx.page.evaluate(`(() => {
      const {session, button} = globalThis.inlineButtonKeyboardProbe;
      const activated = button.dataset.clicks === '1' && button.getAttribute('aria-expanded') === 'true';
      session.restore();
      return { activated, focused: document.activeElement === button,
        restored: session.status === 'original', statePreserved: button.getAttribute('aria-expanded') === 'true' };
    })()`);
    check('translated keyboard activation and state survive restoration', !!keyboard && Object.values(keyboard).every(Boolean), JSON.stringify(keyboard));
  }
  if (mode.reported) {
    if (mode.fixture) await ctx.page.navigate(PAGE_URL);
    const ready = await until(() => ctx.page.evaluate(`!![...document.querySelectorAll('p button')].find(button => button.textContent.trim() === 'Lapse')`), 20000);
    if (check('reported page renders its inline Lapse button', ready)) {
      await inject(ctx.page);
      const results = await ctx.page.evaluate(`(${exerciseButtons.toString()})(false, true)`);
      check('reported page: collection, reordered application, focus and exact restore',
        Array.isArray(results) && results.length > 0 && results.every((result) => Object.values(result).every(Boolean)), JSON.stringify(results));
      const dialogPrepared = await ctx.page.evaluate(`(() => {
        const button = [...document.querySelectorAll('p button')].find(button => button.textContent.trim() === 'Lapse');
        const paragraph = button.closest('p');
        const graph = [];
        const capture = node => { graph.push({node, children:[...node.childNodes], value:node.nodeValue}); node.childNodes.forEach(capture); };
        capture(paragraph);
        const codec = ChromeAiTranslatorInlineBlock;
        const serialized = codec.serializeBlock(paragraph);
        if (!serialized.ok) return false;
        button.focus();
        const applied = codec.applyTranslatedTemplate(serialized.snapshot,
          serialized.atoms.map(atom => atom.token).reverse().join('') + ' 애니메이션 도구도 받습니다.');
        globalThis.inlineButtonDialogProbe = {button, paragraph, graph, snapshot:serialized.snapshot};
        return applied.ok && document.activeElement === button;
      })()`);
      check('reported translated Lapse button is ready for keyboard activation', dialogPrepared);
      await browser(['--session', SESSION, 'press', 'Enter']);
      const dialogIsOpen = () => ctx.page.evaluate(`!!document.querySelector('[role="dialog"]') && globalThis.inlineButtonDialogProbe.button.getAttribute('aria-expanded') === 'true'`);
      check('reported translated Lapse button opens its real dialog', await until(dialogIsOpen, 10000));
      await browser(['--session', SESSION, 'press', 'Escape']);
      const dialogIsClosed = () => ctx.page.evaluate(`!document.querySelector('[role="dialog"]') &&
        globalThis.inlineButtonDialogProbe.button.getAttribute('aria-expanded') === 'false' &&
        getComputedStyle(globalThis.inlineButtonDialogProbe.paragraph).opacity !== '0'`);
      check('reported Lapse dialog closes through its keyboard handler', await until(dialogIsClosed, 10000));
      const dialogRestored = await ctx.page.evaluate(`(() => {
        const {button, graph, snapshot} = globalThis.inlineButtonDialogProbe;
        button.focus();
        const restored = ChromeAiTranslatorInlineBlock.restoreBlock(snapshot);
        return {restored:restored.ok, focused:document.activeElement === button,
          latestState:button.getAttribute('aria-expanded') === 'false',
          exactGraph:graph.every(({node,children,value}) => node.nodeValue === value &&
            node.childNodes.length === children.length && children.every((child,index) => node.childNodes[index] === child))};
      })()`);
      check('reported dialog interaction permits exact restore with current state', !!dialogRestored && Object.values(dialogRestored).every(Boolean), JSON.stringify(dialogRestored));
      await ctx.page.evaluate('globalThis.inlineButtonDialogProbe.button.click()');
      check('reported restored Lapse button still opens its real dialog', await until(dialogIsOpen, 10000));
      await browser(['--session', SESSION, 'press', 'Escape']);
      check('reported restored dialog closes', await until(dialogIsClosed, 10000));
    }
  }
  check('no model requests', modelRequests === 0, String(modelRequests));
} catch (error) {
  failures.push('harness');
  console.error(`FAIL inline button - ${error?.message || error}`);
} finally {
  ctx?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
