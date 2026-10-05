// Read-only regression check for the reported AI Hero responsive skill labels.
// It uses the shipped collector and deterministic output at desktop and mobile
// widths. No key is read and no translation request is made.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeAllBrowsers,
  createChecks,
  launchExtensionBrowser,
  until,
  wait,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const SESSION = 'chrome-ai-translator-ai-hero-responsive-labels';
const PAGE_URL = 'https://www.aihero.dev/skills-to-tickets';
const { check, failures, finish } = createChecks('ai hero responsive labels');

async function injectInlineTranslation(evaluate) {
  for (const file of [
    'default-model.js',
    'inline-diagnostics-protocol.js',
    'placeholder-tokens.js',
    'inline-block.js',
    'inline-translation-session.js',
    'content.js',
  ]) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
}

async function exerciseLabels(page, context, width) {
  await context.cdp.send(
    'Emulation.setDeviceMetricsOverride',
    {
      width,
      height: 800,
      deviceScaleFactor: 1,
      mobile: width < 901,
    },
    page.sessionId
  );
  await wait(250);
  return page.evaluate(`(async () => {
    const cards = [
        ['/skills-to-spec', 'Previous skill'],
        ['/skills-implement', 'Next skill'],
      ]
        .map(([href, label]) => Array.from(
          document.querySelectorAll(\`a[href="\${href}"].min-w-0.flex-1\`)
        ).find((anchor) => anchor.textContent.trim().startsWith(label))
          ?.querySelector('p:last-child'))
        .filter(Boolean);
      const results = [];
      for (const block of cards) {
        block.scrollIntoView({ block: 'center', behavior: 'instant' });
        await new Promise((resolve) => setTimeout(resolve, 75));
        const labels = Array.from(block.querySelectorAll(':scope > span > span'))
          .filter((node) => node.textContent.trim());
        const hidden = labels.find(
          (node) => getComputedStyle(node).display === 'none'
        );
        const visible = labels.find(
          (node) => getComputedStyle(node).display !== 'none'
        );
        const graph = [];
        const capture = (node) => {
          graph.push({
            node,
            children: [...node.childNodes],
            value: node.nodeValue,
          });
          node.childNodes.forEach(capture);
        };
        capture(block);
        const originalHtml = block.outerHTML;
        const hiddenHtml = hidden?.outerHTML || '';
        const originalParent = block.parentNode;
        const originalNextSibling = block.nextSibling;
        const host = document.createElement('div');
        host.style.cssText =
          'position:fixed;left:20px;top:20px;width:400px;z-index:-1';
        document.body.appendChild(host);
        host.appendChild(block);
        const state = createInlineTranslationState();
        beginInlineTranslationOperation(state, {});
        const records = collectVisibleInlineBlocks(block, state);
        const [record] = records;
        const responsiveAtom = record?.atoms.find(
          (atom) => atom.kind === 'responsive-label'
        );
        const hiddenCount = hidden
          ? record?.template.split(hidden.textContent).length - 1
          : -1;
        const visibleContribution = hidden && visible
          ? Number(visible.textContent.includes(hidden.textContent))
          : -1;
        // Mobile labels may be protected Source Syntax. Add visible prose around the
        // preserved template so both viewports exercise a real DOM change.
        const output = record ? record.template + ' 번역' : '';
        if (record) state.session.settle(state.session.takeBatch(), {
          ok: true, results: [{ id: record.id, disposition: 'apply', template: output }],
        });
        const applied = state.session.progress().counts.translated === 1 && block.textContent.includes('번역');
        const preservedAfterApply = Boolean(
          hidden &&
          hidden.isConnected &&
          hidden.outerHTML === hiddenHtml
        );
        const localDiagnostics = state.session.outbox.slice();
        state.session.restore();
        const restored = state.session.status === 'original';
        originalParent.insertBefore(block, originalNextSibling);
        host.remove();
        const exactGraph = graph.every(({ node, children, value }) =>
          node.nodeValue === value &&
          node.childNodes.length === children.length &&
          children.every((child, index) => node.childNodes[index] === child)
        );
        results.push({
          labelsFound: Boolean(hidden && visible),
          collectorOutcomeSafe:
            records.length === 1 &&
            Boolean(record) &&
            localDiagnostics.length === 0,
          noHiddenRejection: !localDiagnostics.some((item) =>
            item.localRejection?.reason === 'hidden_content' &&
            item.localRejection?.tag === 'SPAN'
          ),
          hiddenTextExcluded:
            hiddenCount === visibleContribution &&
            responsiveAtom?.preserveText === false &&
            !Object.hasOwn(responsiveAtom, 'label'),
          applied,
          preservedAfterApply,
          restored,
          exactGraph,
          exactHtml: block.outerHTML === originalHtml,
        });
      }
    return { results };
  })().catch((error) => ({ error: error.message, stack: error.stack }))`);
}

async function main() {
  let context = null;
  let stopWatchingRequests = null;
  try {
    context = await launchExtensionBrowser({
      session: SESSION,
      url: PAGE_URL,
      extensionDir: EXTENSION_DIR,
    });
    if (!check('extension is loaded', Boolean(context.extension))) return;
    if (!check('driver opened the reported page', Boolean(context.page))) return;
    const ready = await until(
      () => context.page.evaluate(
        `Boolean(document.querySelector('a[href="/skills-implement"].min-w-0.flex-1 p:last-child'))`
      ),
      20000,
      250
    );
    if (!check('reported responsive labels rendered', ready === true)) return;
    const modelRequests = [];
    stopWatchingRequests = context.cdp.on(
      'Network.requestWillBeSent',
      (params) => {
        if (String(params?.request?.url || '').includes('api.openai.com')) {
          modelRequests.push(params.request.url);
        }
      }
    );
    await context.cdp.send(
      'Network.enable',
      {},
      context.page.sessionId
    );
    const workerTargets = (await context.listTargets()).filter(
      (target) =>
        target.type === 'service_worker' &&
        String(target.url || '').startsWith(
          `chrome-extension://${context.extension.id}/`
        )
    );
    const workerSessions = [];
    for (const target of workerTargets) {
      const worker = await context.attach(target.targetId);
      workerSessions.push(worker.sessionId);
      await context.cdp.send('Network.enable', {}, worker.sessionId);
    }
    if (!check(
      'extension worker network is observed',
      workerSessions.length > 0
    )) return;
    await injectInlineTranslation(context.page.evaluate);

    for (const [label, width] of [['desktop', 1200], ['mobile', 600]]) {
      const result = await exerciseLabels(context.page, context, width);
      check(
        `${label}: both related-skill titles collect, apply, and restore`,
        result?.results?.length === 2 &&
          result.results.every((item) =>
            Object.values(item).every((value) => value === true)
          ),
        JSON.stringify(result)
      );
      check(
        `${label}: no model request was sent`,
        modelRequests.length === 0,
        JSON.stringify({ modelRequests: modelRequests.length })
      );
    }
  } finally {
    stopWatchingRequests?.();
    context?.close();
  }
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(
    `FAIL ai hero responsive labels - harness threw: ${
      error?.message || error
    }`
  );
} finally {
  await closeAllBrowsers();
}

finish();
