// Unbilled Chrome check: a valid disclosure summary is collected, applied, and restored
// without replacing the existing summary element or breaking disclosure behaviour.
//
// Not part of `npm test`. That suite is pure Node with no browser. Not part of
// `test:integration` either: that command guards ADR-0001's action click, and folding
// a disclosure DOM check into it would mix two reasons to launch Chrome. Run this one
// explicitly: `npm run test:integration:disclosure-summary`.
//
// Assertions stay at collection ownership, apply, toggle, and restore. A model request
// would not test the decision being changed — the defect is local and pre-request —
// which is why this check never reads an API key.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeAllBrowsers,
  createChecks,
  launchExtensionBrowser,
  serveFixture,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const FIXTURE = join(HERE, 'fixtures', 'disclosure-summary.html');
const SESSION = 'chrome-ai-translator-disclosure-summary';

const { check, failures, finish } = createChecks('disclosure summary');

async function injectCodec(evaluate) {
  for (const file of ['placeholder-tokens.js', 'inline-block.js']) {
    await evaluate(readFileSync(join(EXTENSION_DIR, file), 'utf8'));
  }
}

async function main() {
  const fixture = await serveFixture(FIXTURE);
  let ctx = null;
  try {
    ctx = await launchExtensionBrowser({
      session: SESSION,
      url: fixture.url,
      extensionDir: EXTENSION_DIR,
    });

    if (!check(
      'extension is loaded',
      Boolean(ctx.extension),
      `saw ${JSON.stringify(ctx.extensionsSeen)}`
    )) return;
    if (!check(
      'driver opened the fixture page',
      Boolean(ctx.tab) && Boolean(ctx.pageTarget)
    )) return;

    const page = ctx.page;
    if (!check(
      'page execution context is reachable',
      (await page.evaluate('1 + 1')) === 2
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
      const heading = document.getElementById('heading');
      const details = document.getElementById('disclosure');
      const summary = document.getElementById('title');
      const body = document.getElementById('body');
      const originalTitle = summary.textContent;
      const originalBody = body.textContent;
      const originalSummaryChildren = Array.from(summary.childNodes);

      const owners = [];
      const seen = new Set();
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT
      );
      let node;
      while ((node = walker.nextNode())) {
        const value = String(node.nodeValue || '').replace(/\\s+/g, ' ').trim();
        if (!/[A-Za-z]/.test(value)) continue;
        let element = node.parentElement;
        while (element) {
          if (codec.isSemanticBlockElement(element)) {
            if (!seen.has(element)) {
              seen.add(element);
              owners.push(element.id || element.tagName);
            }
            break;
          }
          element = element.parentElement;
        }
      }

      const serialized = codec.serializeBlock(summary);
      const plan = serialized.ok
        ? codec.createPatchPlan(serialized.snapshot, '번역된 공개 제목')
        : { ok: false };
      const applied = plan.ok
        ? codec.applyPatchPlan(serialized.snapshot, plan)
        : { ok: false };
      const translatedTitle = summary.textContent;

      details.open = false;
      summary.click();
      const openedAfterApply = details.open === true;
      summary.click();
      const closedAfterApply = details.open === false;

      const restored = applied.ok
        ? codec.restoreBlock(serialized.snapshot)
        : { ok: false };
      details.open = false;
      summary.click();
      const openedAfterRestore = details.open === true;

      return {
        owners,
        serializeOk: serialized.ok === true,
        template: serialized.template,
        applyOk: applied.ok === true,
        translatedTitle,
        sameSummary: details.querySelector('summary') === summary,
        sameBody: details.querySelector('p') === body,
        bodyUnchanged: body.textContent === originalBody,
        openedAfterApply,
        closedAfterApply,
        restoreOk: restored.ok === true,
        restoredTitle: summary.textContent,
        restoredChildren: Array.from(summary.childNodes).every(
          (child, index) => child === originalSummaryChildren[index]
        ),
        originalTitle,
        openedAfterRestore,
      };
    })()`);

    check(
      'collects the heading, summary, and body without an overlapping disclosure owner',
      Array.isArray(result?.owners) &&
        result.owners.join(',') === 'heading,title,body',
      JSON.stringify(result?.owners)
    );
    check(
      'serializes the disclosure summary',
      result?.serializeOk === true &&
        result?.template === 'Disclosure title is its own block.',
      JSON.stringify({ ok: result?.serializeOk, template: result?.template })
    );
    check(
      'applies the translated title on the existing summary element',
      result?.applyOk === true &&
        result?.sameSummary === true &&
        result?.sameBody === true &&
        result?.bodyUnchanged === true &&
        result?.translatedTitle === '번역된 공개 제목',
      JSON.stringify({
        applyOk: result?.applyOk,
        sameSummary: result?.sameSummary,
        sameBody: result?.sameBody,
        bodyUnchanged: result?.bodyUnchanged,
        translatedTitle: result?.translatedTitle,
      })
    );
    check(
      'disclosure still opens and closes after apply',
      result?.openedAfterApply === true && result?.closedAfterApply === true,
      JSON.stringify({
        openedAfterApply: result?.openedAfterApply,
        closedAfterApply: result?.closedAfterApply,
      })
    );
    check(
      'restore reconstructs the original title, children, and disclosure behaviour',
      result?.restoreOk === true &&
        result?.restoredTitle === result?.originalTitle &&
        result?.restoredChildren === true &&
        result?.openedAfterRestore === true,
      JSON.stringify({
        restoreOk: result?.restoreOk,
        restoredTitle: result?.restoredTitle,
        restoredChildren: result?.restoredChildren,
        openedAfterRestore: result?.openedAfterRestore,
      })
    );
  } finally {
    ctx?.close();
    fixture.close();
  }
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(`FAIL disclosure summary - harness threw: ${error?.message || error}`);
} finally {
  await closeAllBrowsers();
}

finish();
