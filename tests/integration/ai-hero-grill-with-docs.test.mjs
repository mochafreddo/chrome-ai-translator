// Read-only regression check for the reported AI Hero skill page. It runs the
// shipped collector and validators against the live DOM without an API key or
// model request. Run explicitly:
// `npm run test:integration:ai-hero-grill-with-docs`.

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
const SESSION = 'chrome-ai-translator-ai-hero-grill-with-docs';
const PAGE_URL = 'https://www.aihero.dev/skills-grill-with-docs';
const { check, failures, finish } = createChecks('ai hero grill-with-docs');

async function attachReportedPage(context) {
  if (context.page) return context.page;
  const deadline = Date.now() + 15000;
  for (;;) {
    const pages = await context.listPages();
    const found = pages.find((target) =>
      target.type === 'page' &&
      String(target.url || '').includes('/skills-grill-with-docs')
    );
    if (found) return context.attach(found.id);
    if (Date.now() >= deadline) return null;
    await wait(250);
  }
}

async function injectInlineTranslation(evaluate) {
  for (const file of [
    'inline-diagnostics-protocol.js',
    'placeholder-tokens.js',
    'inline-block.js',
    'translation-validation.js',
    'content.js',
  ]) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
}

async function main() {
  let context = null;
  try {
    context = await launchExtensionBrowser({
      session: SESSION,
      url: PAGE_URL,
      extensionDir: EXTENSION_DIR,
    });
    if (!check('extension is loaded', Boolean(context.extension))) return;

    const page = await attachReportedPage(context);
    if (!check('driver opened the reported page', Boolean(page))) return;
    const articleReady = await until(
      () => page.evaluate(
        `Boolean(document.querySelector('article, main, [role="main"]'))`
      ),
      20000,
      250
    );
    if (!check('the reported article became ready', articleReady === true)) {
      return;
    }

    await injectInlineTranslation(page.evaluate);
    const result = await page.evaluate(`(async () => {
      const originalFetch = window.fetch;
      let modelRequests = 0;
      window.fetch = function patchedFetch(input) {
        const url = typeof input === 'string' ? input : input?.url || '';
        if (String(url).includes('api.openai.com')) modelRequests += 1;
        return originalFetch.apply(this, arguments);
      };
      try {
        const root = pickArticleRoot();
        const store = createInlineViewportStore(1);
        const step = Math.max(1, Math.floor(window.innerHeight * 0.75));
        for (
          let top = 0;
          top <= document.documentElement.scrollHeight;
          top += step
        ) {
          window.scrollTo(0, top);
          await new Promise((resolve) => setTimeout(resolve, 75));
          store.scanStartIndex = 0;
          collectVisibleInlineBlocks(root, store, 5000);
        }
        window.scrollTo(0, 0);

        const repository = store.records.find((record) =>
          record.state === 'queued' &&
          record.template.includes('mattpocock/skills')
        );
        const quality = repository
          ? ChromeAiTranslatorValidation.assessTranslationQuality(
              repository.template,
              repository.template,
              'Korean',
              repository.contract
            )
          : null;
        const changed = repository
          ? ChromeAiTranslatorInlineBlock.validateTranslatedTemplate(
              repository.template.replace(
                'mattpocock/skills',
                'other/project'
              ),
              repository.contract
            )
          : null;
        return {
          attempted: store.records.length,
          failed: store.records.filter(
            (record) => record.state === 'failed'
          ).length,
          repositoryFound: Boolean(repository),
          repositoryQuality: quality?.status || '',
          changedSourceSyntaxCode: changed?.errorCode || '',
          modelRequests,
        };
      } finally {
        window.fetch = originalFetch;
      }
    })()`);

    check(
      'every visible Semantic Block passes local preflight',
      result?.attempted > 0 && result?.failed === 0,
      JSON.stringify({
        attempted: result?.attempted,
        failed: result?.failed,
      })
    );
    check(
      'the repository coordinate is Source Syntax rather than untranslated prose',
      result?.repositoryFound === true &&
        result?.repositoryQuality === 'complete' &&
        result?.changedSourceSyntaxCode === 'source_syntax_changed',
      JSON.stringify({
        repositoryFound: result?.repositoryFound,
        repositoryQuality: result?.repositoryQuality,
        changedSourceSyntaxCode: result?.changedSourceSyntaxCode,
      })
    );
    check(
      'no model request was sent',
      result?.modelRequests === 0,
      JSON.stringify({ modelRequests: result?.modelRequests })
    );
  } finally {
    context?.close();
  }
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(
    `FAIL ai hero grill-with-docs - harness threw: ${
      error?.message || error
    }`
  );
} finally {
  await closeAllBrowsers();
}

finish();
