// Read-only smoke check of the reported AI Hero page: inject the local serializer
// and a deterministic translated template, then prove apply and restore.
//
// Not part of `npm test`. That suite is pure Node with no browser. Not part of
// `test:integration` either: that command guards ADR-0001's action click. Not a
// billed check: the defect is local and pre-request, so this never reads an API
// key and never asks a model. Run it explicitly:
// `npm run test:integration:ai-hero-disclosure`.
//
// The page is on the open web. If its disclosure markup leaves the wrapped
// leading-summary shape this check looks for, the run goes red rather than
// quietly checking a fixture instead.

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
const SESSION = 'chrome-ai-translator-ai-hero-disclosure';
const PAGE_URL = 'https://www.aihero.dev/a-complete-guide-to-agents-md';

const { check, failures, finish } = createChecks('ai hero disclosure');

async function injectCodec(evaluate) {
  for (const file of ['placeholder-tokens.js', 'inline-block.js']) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
}

async function attachReportedPage(ctx) {
  if (ctx.page) return ctx.page;
  const deadline = Date.now() + 15000;
  for (;;) {
    const pages = await ctx.listPages();
    const found = pages.find((target) =>
      target.type === 'page' && String(target.url || '').includes('a-complete-guide-to-agents-md')
    );
    if (found) return ctx.attach(found.id);
    if (Date.now() >= deadline) return null;
    await wait(500);
  }
}

async function main() {
  let ctx = null;
  try {
    ctx = await launchExtensionBrowser({
      session: SESSION,
      url: PAGE_URL,
      extensionDir: EXTENSION_DIR,
    });

    if (!check(
      'extension is loaded',
      Boolean(ctx.extension),
      `saw ${JSON.stringify(ctx.extensionsSeen)}`
    )) return;

    const page = await attachReportedPage(ctx);
    if (!check(
      'driver opened the reported page',
      Boolean(page)
    )) return;

    if (!check(
      'page execution context is reachable',
      (await page.evaluate('1 + 1')) === 2
    )) return;

    const articleReady = await until(
      () => page.evaluate(`document.querySelectorAll('details').length > 0`),
      20000,
      500
    );
    if (!check(
      'the reported page has at least one disclosure',
      articleReady === true
    )) return;

    await injectCodec(page.evaluate);
    if (!check(
      'semantic block codec is available on the page',
      (await page.evaluate(
        'typeof ChromeAiTranslatorInlineBlock?.serializeBlock === "function"'
      )) === true
    )) return;

    const result = await page.evaluate(`(() => {
      const codec = ChromeAiTranslatorInlineBlock;
      const originalFetch = window.fetch;
      let modelRequests = 0;
      window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        if (String(url).includes('api.openai.com')) modelRequests += 1;
        return originalFetch.apply(this, arguments);
      };

      try {
      function firstNonWhitespaceChild(element) {
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE && !String(child.nodeValue || '').trim()) {
            continue;
          }
          return child;
        }
        return null;
      }

      const wrapped = [];
      for (const details of document.querySelectorAll('details')) {
        const walker = document.createTreeWalker(details, NodeFilter.SHOW_ELEMENT);
        let element;
        while ((element = walker.nextNode())) {
          if (!codec.isSemanticBlockElement(element)) continue;
          const first = firstNonWhitespaceChild(element);
          if (
            first &&
            first.nodeType === Node.ELEMENT_NODE &&
            first.tagName === 'SUMMARY' &&
            first.parentElement === element
          ) {
            wrapped.push({ block: element, summary: first, details });
          }
        }
      }

      const target = wrapped[0];
      if (!target) {
        return { wrappedCount: 0, modelRequests };
      }

      const { block, summary, details } = target;
      const originalChildren = Array.from(block.childNodes);
      const originalSummaryChildren = Array.from(summary.childNodes);
      const originalText = block.textContent;
      const serialized = codec.serializeBlock(block);
      const wrapper = serialized.ok
        ? serialized.contract.entries.find((entry) => entry.tagName === 'SUMMARY')
        : null;
      const tokenValues = [];
      for (const entry of serialized.ok ? serialized.contract.entries : []) {
        if (entry.openToken) tokenValues.push(entry.openToken);
        if (entry.closeToken) tokenValues.push(entry.closeToken);
        if (entry.token) tokenValues.push(entry.token);
      }
      tokenValues.sort((a, b) => b.length - a.length);
      let translated = serialized.ok ? serialized.template : '번역';
      if (serialized.ok && tokenValues.length) {
        const pieces = [];
        let cursor = 0;
        while (cursor < serialized.template.length) {
          let nextAt = -1;
          let nextToken = '';
          for (const token of tokenValues) {
            const at = serialized.template.indexOf(token, cursor);
            if (at < 0) continue;
            if (nextAt < 0 || at < nextAt) {
              nextAt = at;
              nextToken = token;
            }
          }
          if (nextAt < 0) {
            pieces.push(serialized.template.slice(cursor));
            break;
          }
          pieces.push(serialized.template.slice(cursor, nextAt), nextToken);
          cursor = nextAt + nextToken.length;
        }
        translated = pieces.map((part) => {
          if (tokenValues.includes(part) || !/[A-Za-z]/.test(part)) return part;
          return '번역';
        }).join('');
      } else if (serialized.ok) {
        translated = '번역';
      }
      const plan = serialized.ok
        ? codec.createPatchPlan(serialized.snapshot, translated)
        : { ok: false };
      const applied = plan.ok
        ? codec.applyPatchPlan(serialized.snapshot, plan)
        : { ok: false };
      const firstChildAfterApply = block.childNodes[0];
      const translatedTitle = summary.textContent;
      const restored = applied.ok
        ? codec.restoreBlock(serialized.snapshot)
        : { ok: false };

      details.open = false;
      details.open = true;
      const openedAfterRestore = details.open === true;
      details.open = false;

      return {
        wrappedCount: wrapped.length,
        serializeOk: serialized.ok === true,
        placement: wrapper && wrapper.placement,
        applyOk: applied.ok === true,
        planError: plan.errorCode || applied.errorCode || '',
        firstChildIsSummary: firstChildAfterApply === summary,
        sameSummary: details.querySelector('summary') === summary,
        translatedTitle,
        restoreOk: restored.ok === true,
        restoredChildren: Array.from(block.childNodes).every(
          (child, index) => child === originalChildren[index]
        ),
        restoredSummaryChildren: Array.from(summary.childNodes).every(
          (child, index) => child === originalSummaryChildren[index]
        ),
        restoredText: block.textContent,
        originalText,
        openedAfterRestore,
        modelRequests,
      };
      } finally {
        window.fetch = originalFetch;
      }
    })()`);

    check(
      'the reported page still has a wrapped leading disclosure summary',
      result?.wrappedCount > 0,
      JSON.stringify({ wrappedCount: result?.wrappedCount })
    );
    check(
      'serializes the wrapped disclosure with an anchored summary',
      result?.serializeOk === true && result?.placement === 'leading-root',
      JSON.stringify({
        serializeOk: result?.serializeOk,
        placement: result?.placement,
      })
    );
    check(
      'applies a deterministic template without replacing the leading summary',
      result?.applyOk === true &&
        result?.firstChildIsSummary === true &&
        result?.sameSummary === true &&
        String(result?.translatedTitle || '').includes('번역'),
      JSON.stringify({
        applyOk: result?.applyOk,
        planError: result?.planError,
        firstChildIsSummary: result?.firstChildIsSummary,
        sameSummary: result?.sameSummary,
        translatedTitle: result?.translatedTitle,
      })
    );
    check(
      'restore reconstructs the original graph and disclosure behaviour',
      result?.restoreOk === true &&
        result?.restoredChildren === true &&
        result?.restoredSummaryChildren === true &&
        result?.restoredText === result?.originalText &&
        result?.openedAfterRestore === true,
      JSON.stringify({
        restoreOk: result?.restoreOk,
        restoredChildren: result?.restoredChildren,
        restoredSummaryChildren: result?.restoredSummaryChildren,
        restoredText: result?.restoredText,
        openedAfterRestore: result?.openedAfterRestore,
      })
    );
    check(
      'no model request was sent',
      result?.modelRequests === 0,
      JSON.stringify({ modelRequests: result?.modelRequests })
    );
  } finally {
    ctx?.close();
  }
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(`FAIL ai hero disclosure - harness threw: ${error?.message || error}`);
} finally {
  await closeAllBrowsers();
}

finish();
