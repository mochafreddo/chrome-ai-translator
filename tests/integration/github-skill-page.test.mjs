// Read-only local preflight regression against the reported GitHub skill page.
// No API key is read and no model request is sent. Run explicitly with
// `npm run test:integration:github-skill-page`.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import viewportHarness from '../viewport-harness.js';
import background from '../../extension/background.js';
import { browser, createChecks, launchExtensionBrowser, until } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-github-skill-page';
const PAGE_URL = 'https://github.com/mattpocock/skills/blob/main/skills/engineering/ask-matt/SKILL.md';
const { check, failures, finish } = createChecks('github skill page');

async function inject(evaluate) {
  for (const file of background.getInlineContentScriptFiles()) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
  await evaluate(`globalThis.createViewportProbe = ${viewportHarness.createViewportProbe.toString()}`);
}

async function collectArticle() {
  const root = document.querySelector('article.markdown-body');
  if (!root) throw new Error('Rendered Markdown article is missing');
  const session = ChromeAiTranslatorInlineTranslationSession.createInlineTranslationSession();
  session.begin({});
  const records = [];
  const step = Math.max(1, Math.floor(window.innerHeight * 0.75));
  for (let top = 0; top <= document.documentElement.scrollHeight; top += step) {
    window.scrollTo(0, top);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const viewport = createViewportProbe(session);
    try {
      viewport.start(root);
      records.push(...viewport.records);
    } finally { viewport.stop(); }
  }
  window.scrollTo(0, 0);
  return {
    attempted: records.length,
    counts: session.progress().counts,
    localRejections: session.outbox.map(({ code, localRejection }) => ({ code, localRejection })),
  };
}

let context;
let stopWatchingRequests;
try {
  context = await launchExtensionBrowser({ session: SESSION, url: PAGE_URL, extensionDir: EXTENSION_DIR });
  if (!context.extension || !context.page) throw new Error('Extension or reported page did not load');
  const ready = await until(() => context.page.evaluate(
    `Boolean(document.querySelector('article.markdown-body')?.textContent.trim())`
  ), 20000, 250);
  if (check('the reported rendered Markdown article became ready', ready === true)) {
    let modelRequests = 0;
    stopWatchingRequests = context.cdp.on('Network.requestWillBeSent', (params) => {
      if (String(params?.request?.url || '').includes('api.openai.com')) modelRequests += 1;
    });
    const pageNetwork = await context.cdp.send('Network.enable', {}, context.page.sessionId);
    if (pageNetwork.__error || pageNetwork.__timeout) throw new Error('Page network observation failed');
    const workers = (await context.listTargets()).filter((target) =>
      target.type === 'service_worker' &&
      String(target.url || '').startsWith(`chrome-extension://${context.extension.id}/`)
    );
    if (!workers.length) throw new Error('Extension worker network cannot be observed');
    for (const target of workers) {
      const worker = await context.attach(target.targetId);
      const network = await context.cdp.send('Network.enable', {}, worker.sessionId);
      if (network.__error || network.__timeout) throw new Error('Extension worker network observation failed');
    }
    await inject(context.page.evaluate);
    const result = await context.page.evaluate(
      `(${collectArticle.toString()})().catch(error => ({ error: error.message }))`, 60000
    );
    console.log(`INFO github skill page - ${result?.attempted ?? 0} visible Semantic Blocks observed`);
    check('every visible Semantic Block passes local preflight',
      result?.attempted > 0 && result?.counts?.failed === 0,
      JSON.stringify(result));
    check('no model request was sent from the page or extension worker',
      modelRequests === 0, JSON.stringify({ modelRequests }));
  }
} catch (error) {
  failures.push('harness');
  console.error(`FAIL github skill page - harness threw: ${error?.message || error}`);
} finally {
  stopWatchingRequests?.();
  context?.close();
  await browser(['--session', SESSION, 'close']).catch(() => {});
}
finish();
