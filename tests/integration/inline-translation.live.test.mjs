// Live check: Inline Translation really translates, and Stop and Restore really behave.
//
// This is the only check that spends money. `npm test` is browser-free and
// `npm run test:integration` is browser-bound but unbilled, and both of those lines are
// deliberate -- see tests/README.md. Run this one on its own: `npm run verify:live`.
//
// It exists because the unit suite drives translateVisibleBlockBatch with a fake `fetch`.
// That makes the suite fast and free, and it also means a green suite says nothing about
// whether a reader pointing the extension at a page gets a translated page. The gap is
// small and permanent, so the check that closes it is small and separate.
//
// `.live.` in the filename is the convention: it says the file bills, so nobody wires it
// into test:integration by reflex. package.json is the only wiring -- integration checks
// are not in any of the four hand-maintained lists in AGENTS.md.
//
// The page is a local fixture, not a page on the web. A real site would serve until its
// owner edited a sentence, and then this check would quietly change both what it costs and
// what it asserts. The fixture fixes the input, and its three blocks are what decide the
// size of the bill.
//
// Assertions are invariants, never output. A model's wording changes between runs and
// between models, so asserting on a translated string would make the check a report on
// today's model. What is asserted is that Hangul arrived, that Restore puts back exactly
// what was there, and that the controls move through the states the rules give them.
//
// Requires: `agent-browser` on PATH, network access, and an OpenAI key in .env.local.
// A missing key fails; it does not skip. A check that quietly passes when it did not run
// is how this repo already lost two months of coverage -- see tests/README.md.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  closeAllBrowsers,
  createChecks,
  launchExtensionBrowser,
  until,
  wait,
} from './harness.mjs';
import { withApiKey } from './live-key.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const ENV_PATH = join(ROOT, '.env.local');
const FIXTURE = join(HERE, 'fixtures', 'inline-translation.html');
const SESSION = 'chrome-ai-translator-live';
const TARGET_LANGUAGE = 'Korean';
const HANGUL = /[가-힣]/;

const { check, failures, finish } = createChecks('inline translation live');

// http, not file: the extension's content scripts match http://*/* and https://*/*, and a
// file:// page is outside that.
function serveFixture() {
  const body = readFileSync(FIXTURE);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

async function main() {
  const fixture = await serveFixture();
  let ctx = null;
  try {
    ctx = await launchExtensionBrowser({
      session: SESSION,
      url: fixture.url,
      extensionDir: EXTENSION_DIR,
    });

    if (!check('extension is loaded', Boolean(ctx.extension), `saw ${JSON.stringify(ctx.extensionsSeen)}`)) return;
    if (!check('driver opened the fixture page', Boolean(ctx.tab) && Boolean(ctx.pageTarget))) return;

    const page = ctx.page;
    if (!check('page execution context is reachable', (await page.evaluate('1 + 1')) === 2)) return;

    await withApiKey({
      page,
      extension: ctx.extension,
      envPath: ENV_PATH,
      targetLanguage: TARGET_LANGUAGE,
      // In a finally, so it reports even when a check above threw. A run that leaves a real
      // key in the browser profile has failed whatever else it proved.
      onCleared: (cleared) => check('the API key is cleared from the browser profile', cleared),
    }, async (saved) => {
      if (!check('options page saves a real API key and the target language',
        saved.hasKey === true && saved.targetLanguage === TARGET_LANGUAGE,
        JSON.stringify({ ...saved, hasKey: Boolean(saved.hasKey) }))) return;
      console.log(`  model in effect: ${saved.model || '(the shared fallback)'}`);

      await page.navigate(fixture.url);
      const originalText = await page.evaluate('document.body.innerText.trim()');
      check('the fixture starts in its original language',
        typeof originalText === 'string' && originalText.length > 0 && !HANGUL.test(originalText),
        JSON.stringify(String(originalText).slice(0, 80)));

      // The toolbar action is what grants Inline Translation Authorization and opens the
      // panel; without it the content script refuses to start a run at all.
      const triggered = await ctx.cdp.send('Extensions.triggerAction',
        { id: ctx.extension.id, targetId: ctx.tab.targetId });
      check('toolbar action reaches the extension', !triggered.__timeout && !triggered.__error,
        triggered.__error || (triggered.__timeout ? 'no response' : ''));
      await wait(3000);

      const panelUrl = `chrome-extension://${ctx.extension.id}/sidepanel.html`;
      const panelTarget = await ctx.findTarget((target) => target.url === panelUrl);
      if (!check('side panel is open to drive the controls from', Boolean(panelTarget))) return;
      const panel = await ctx.attach(panelTarget.id);

      // The side panel is one of Inline Translation's two homes, and the one whose controls
      // are plain DOM: the Floating Translate Button lives behind a closed shadow root.
      // Both are driven by the same rules in inline-translation-controls.js.
      const controls = () => panel.evaluate(`({
        startDisabled: document.getElementById('btnInlineTranslate').disabled,
        stopDisabled: document.getElementById('btnInlineStop').disabled,
        restoreDisabled: document.getElementById('btnInlineRestore').disabled,
        status: document.getElementById('inlineStatus').textContent,
        error: document.getElementById('inlineError').hidden
          ? '' : document.getElementById('inlineError').textContent,
      })`);
      const click = (id) => panel.evaluate(`document.getElementById(${JSON.stringify(id)}).click(), true`);
      const pageText = () => page.evaluate('document.body.innerText.trim()');

      await click('btnInlineTranslate');
      const translated = await until(async () => HANGUL.test(String(await pageText())), 120000, 1500);
      const afterTranslate = await controls();
      check('Inline Translation translates the page with a real API key', translated,
        `status="${afterTranslate?.status}" error="${afterTranslate?.error}"`);

      // Exactly what was there, not merely English again: a restore that dropped a block or
      // kept a boundary space would still read as restored.
      await click('btnInlineRestore');
      check('Original text puts the page back exactly as it was',
        await until(async () => (await pageText()) === originalText, 20000, 1000));

      // Stopping a run that already finished proves nothing, so this stops one in flight.
      await click('btnInlineTranslate');
      const running = await until(async () => (await controls())?.stopDisabled === false, 15000, 250);
      check('Stop is offered while a run is in flight', running);
      await click('btnInlineStop');
      const settled = await until(async () => (await controls())?.stopDisabled === true, 20000, 500);
      const afterStop = await controls();
      check('Stop ends the run', settled, `status="${afterStop?.status}"`);
      check('Stop leaves the page restorable', afterStop?.restoreDisabled === false,
        `restoreDisabled=${afterStop?.restoreDisabled} status="${afterStop?.status}"`);
      // A cancelled run reporting an error is the state 1e2a84a removed.
      check('a stopped run reports no error', !afterStop?.error, String(afterStop?.error || ''));

      await click('btnInlineRestore');
      check('Original text still works after a stop',
        await until(async () => (await pageText()) === originalText, 20000, 1000));
    });

    ctx.close();
  } finally {
    fixture.close();
  }
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(`FAIL inline translation live - harness threw: ${error?.message || error}`);
} finally {
  await closeAllBrowsers();
}

finish();
