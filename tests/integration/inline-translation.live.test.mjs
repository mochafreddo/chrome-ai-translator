// Billed Inline Translation check through real Options and page controls.
// The hidden fixture block makes Stop exercise an uncached request. Run separately
// with verify:live:inline or verify:live:openrouter:inline after billed approval.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  closeAllBrowsers,
  createChecks,
  launchExtensionBrowser,
  serveFixture,
  until,
  wait,
} from './harness.mjs';
import { withApiKey } from './live-key.mjs';
import { observeModelRequests } from './model-request-evidence.mjs';
import { readStopBlockContract } from './fixture-stop-contract.mjs';
import inlineModelExecution from '../../extension/inline-model-execution.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const ENV_PATH = join(ROOT, '.env.local');
const FIXTURE = join(HERE, 'fixtures', 'inline-translation.html');
const serviceArguments = process.argv.slice(2);
if (serviceArguments.length && (serviceArguments.length !== 2 || serviceArguments[0] !== '--service' ||
    !['openai', 'openrouter'].includes(serviceArguments[1]))) {
  throw new Error('Use --service openai or --service openrouter');
}
const SERVICE = serviceArguments[1] || 'openai';
const SESSION = `chrome-ai-translator-live-inline-${SERVICE}`;
const TARGET_LANGUAGE = 'Korean';
const HANGUL = /[가-힣]/;

// The fixture's hidden block: the one the Stop checks put in flight. See the comment beside
// it in tests/integration/fixtures/inline-translation.html.
const STOPPED_RUN_BLOCK_ID = 'stoppedRunBlock';
// The first line the side panel shows once a run has been stopped, from
// formatInlineViewportStatusMessage. A run that ended on its own says "Visible translation
// on" instead, which is how the Stop checks tell a cancelled run from a finished one.
const STOPPED_STATUS = 'Visible translation stopped';
// Blocks queued or awaiting a response, out of the same status line. A run served from the
// translation cache never has one, so this is the part of the panel a cache hit cannot
// produce. A queued block is counted too, but the queue is drained in the same turn the
// scan fills it and the panel is only re-read a second later, so a count this check ever
// sees is a request already out.
const readPending = (snapshot) =>
  Number(/Pending (\d+)/.exec(String(snapshot?.status || ''))?.[1] || 0);

const { check, failures, finish } = createChecks('inline translation live');

async function main() {
  const fixture = await serveFixture(FIXTURE);
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

    const target = await ctx.findTarget(candidate => candidate.type === 'service_worker' &&
      candidate.url.startsWith(`chrome-extension://${ctx.extension.id}/`));
    if (!check('worker network observer is available', Boolean(target))) return;
    const worker = await ctx.attach(target.id, 'service_worker');
    let stopRecord = null;
    const evidence = await observeModelRequests(ctx.cdp, worker.sessionId, {
      reasoningUsage: SERVICE === 'openrouter',
      validateOutput: async (text, input) => {
        const body = JSON.parse(input);
        if (!stopRecord || body.records?.length !== 1 || body.records[0].template !== stopRecord.template ||
            JSON.stringify(body.records[0].atoms) !== JSON.stringify(stopRecord.atoms)) return false;
        let calls = 0;
        const results = await inlineModelExecution.execute(
          [{ ...body.records[0], contract: stopRecord.contract }],
          { targetLanguage: TARGET_LANGUAGE, tone: 'technical' }, async () => {
            if (calls++) throw new Error('An unobserved repair cannot validate this response.');
            return text;
          });
        return results.length === 1 && results[0].disposition === 'apply' && results[0].attemptCount === 1;
      },
    });
    const { requests: requestEvidence, requestIds, completedRequests, reasoningTokens: reasoningEvidence } = evidence;

    await withApiKey({
      page,
      extension: ctx.extension,
      envPath: ENV_PATH,
      targetLanguage: TARGET_LANGUAGE,
      service: SERVICE,
      // In a finally, so it reports even when a check above threw. A run that leaves a real
      // key in the browser profile has failed whatever else it proved.
      onCleared: (cleared) => check('the API key is cleared from the browser profile', cleared),
    }, async (saved) => {
      if (!check('options page saves a real API key and the target language',
        saved.hasKey === true && saved.targetLanguage === TARGET_LANGUAGE,
        JSON.stringify({ ...saved, hasKey: Boolean(saved.hasKey) }))) return;
      console.log(`  selected service: ${SERVICE}`);

      await page.navigate(fixture.url);
      const originalText = await page.evaluate(`(() => {
        globalThis.originalInlineNodes = [...document.querySelectorAll('main *')];
        return document.body.innerText.trim();
      })()`);
      check('the fixture starts in its original language',
        typeof originalText === 'string' && originalText.length > 0 && !HANGUL.test(originalText),
        JSON.stringify(String(originalText).slice(0, 80)));

      // The toolbar action is what grants Inline Translation Authorization and opens the
      // panel; without it the content script refuses to start a run at all.
      const triggered = await ctx.cdp.send('Extensions.triggerAction',
        { id: ctx.extension.id, targetId: ctx.tab.targetId });
      check('toolbar action reaches the extension', !triggered.__timeout && !triggered.__error,
        triggered.__error || (triggered.__timeout ? 'no response' : ''));

      const panelUrl = `chrome-extension://${ctx.extension.id}/sidepanel.html`;
      await until(() => ctx.findTarget(target => target.url === panelUrl), 10000, 100);
      const panelTarget = await ctx.findTarget((target) => target.url === panelUrl);
      if (!check('side panel is open to drive the controls from', Boolean(panelTarget))) return;
      const panel = await ctx.attach(panelTarget.id);
      if (!check('Inline controls finish initialization', await until(() => panel.evaluate(
        "!document.getElementById('btnInlineTranslate').disabled"), 10000, 100))) return;

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
      const translated = await until(async () => await page.evaluate(`
        [...document.querySelectorAll('main h1, main p')].filter(node => !node.hidden)
          .every(node => /[가-힣]/.test(node.textContent))`) && readPending(await controls()) === 0, 120000, 500);
      const afterTranslate = await controls();
      check('Inline Translation translates the page with a real API key', translated,
        `status="${afterTranslate?.status}" error="${afterTranslate?.error}"`);

      // Exactly what was there, not merely English again: a restore that dropped a block or
      // kept a boundary space would still read as restored.
      await click('btnInlineRestore');
      check('Original text puts the page back exactly as it was',
        await until(async () => (await pageText()) === originalText, 20000, 1000));

      // Stopping a run that already finished proves nothing, so this stops one in flight --
      // and getting one in flight takes work. Restore does not empty the translation cache,
      // which is keyed by the settings signature and so is the same bucket on the next run;
      // translating this page again would serve every block from it and issue no request at
      // all. What that leaves is a status flip, and Stop checks that watch only the status
      // pass whether or not cancelling a batch works. So the page is given a block the cache
      // has never seen, and it is the only thing the run below asks a model for.
      const revealed = await page.evaluate(`(() => {
        const block = document.getElementById(${JSON.stringify(STOPPED_RUN_BLOCK_ID)});
        if (!block) return '';
        block.hidden = false;
        return block.innerText.trim();
      })()`);
      if (!check('the fixture holds a block the first run never saw',
        typeof revealed === 'string' && revealed.length > 0 && !HANGUL.test(revealed),
        JSON.stringify(String(revealed).slice(0, 80)))) return;
      const revealedText = () => page.evaluate(
        `document.getElementById(${JSON.stringify(STOPPED_RUN_BLOCK_ID)}).innerText.trim()`);
      const originalWithRevealed = await pageText();

      stopRecord = await readStopBlockContract(page);
      if (!check('the uncached Stop block has a valid translation contract', Boolean(stopRecord))) return;
      const beforeStopRequests = new Set(requestIds);
      await click('btnInlineTranslate');
      // Pending is what says a request is out. Waiting on stopDisabled alone would settle
      // the moment the status turned active, which happens before the page is even scanned.
      const running = await until(async () => {
        const now = await controls();
        return now?.stopDisabled === false && readPending(now) > 0 && [...requestIds].some(id => !beforeStopRequests.has(id) && !completedRequests.has(id));
      }, 60000, 250);
      // The panel is read a second behind the page, so the answer can arrive between the
      // count this saw and the click below. That leaves nothing in flight to stop, which is
      // the one thing these checks may not quietly accept -- so it is reported here, where
      // the detail says a race rather than a broken Stop.
      const atStop = await controls();
      const arrivedFirst = HANGUL.test(String(await revealedText()));
      check('Stop is offered while a run is in flight', running && !arrivedFirst,
        `status="${atStop?.status}"${arrivedFirst ? ' (the answer landed before Stop was clicked)' : ''}`);
      const stopRequestIds = [...requestIds].filter(id => !beforeStopRequests.has(id) && !completedRequests.has(id));
      await click('btnInlineStop');
      // Stopped, not merely finished: a run that ended on its own also dims Stop, and it
      // says so on the line above the counts.
      const settled = await until(async () => {
        const now = await controls();
        return now?.stopDisabled === true && String(now?.status || '').startsWith(STOPPED_STATUS);
      }, 20000, 500);
      const stopCheckpoint = evidence.checkpointPending(stopRequestIds);
      check('the exact request remains incomplete at confirmed Stop', settled && stopCheckpoint.pending);
      const afterStop = await controls();
      check('Stop ends the run', settled, `status="${afterStop?.status}"`);
      check('Stop leaves the page restorable', afterStop?.restoreDisabled === false,
        `restoreDisabled=${afterStop?.restoreDisabled} status="${afterStop?.status}"`);
      // A cancelled run reporting an error is the state 1e2a84a removed.
      check('a stopped run reports no error', !afterStop?.error, String(afterStop?.error || ''));

      const lateAnswerCompleted = stopCheckpoint.pending && await until(() => stopCheckpoint.requestIds.every(id =>
        evidence.responses.has(id)), 120000, 500);
      check('the exact uncached request succeeds after Stop',
        lateAnswerCompleted && evidence.completedSuccessfully(stopCheckpoint));
      await wait(1000);
      check('a stopped run never applies the batch it had in flight',
        !HANGUL.test(String(await revealedText())));

      await click('btnInlineRestore');
      check('Original text still works after a stop',
        await until(async () => (await pageText()) === originalWithRevealed, 20000, 1000));
      check('Original text retains page-node identities', await page.evaluate(`
        globalThis.originalInlineNodes.every((node, index) => document.querySelectorAll('main *')[index] === node)`));
      check('all model requests use the selected service', requestEvidence.length > 0 &&
        requestEvidence.every(evidence => evidence.service === SERVICE));
      console.log(`  observed request models: ${JSON.stringify([...new Set(requestEvidence.map(request => request.model))])}`);
      if (SERVICE === 'openrouter') {
        await evidence.settle();
        check('OpenRouter retains structured output and required model/data policy', requestEvidence.length > 0 &&
          requestEvidence.every(evidence => evidence.model === 'deepseek/deepseek-v4.1-flash-1017' &&
            evidence.reasoning?.effort === 'none' && evidence.provider?.require_parameters === true &&
            evidence.provider?.data_collection === 'deny' && evidence.provider?.zdr === true &&
            evidence.format === 'json_schema' && evidence.strict === true &&
            evidence.maxOutputTokens >= 4096 && evidence.maxOutputTokens <= 16000 && evidence.store === false));
        check('provider usage reports zero reasoning tokens for every response',
          reasoningEvidence.length === requestEvidence.length && reasoningEvidence.length > 0 &&
          reasoningEvidence.every(tokens => tokens === 0),
          `requests=${requestEvidence.length} responses=${reasoningEvidence.length} missing=${reasoningEvidence.filter(tokens => tokens === null).length}`);
        console.log('  Zero reported reasoning tokens is provider evidence; it does not expose provider internals.');
      }
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
  console.error('FAIL inline translation live - harness failed');
} finally {
  await closeAllBrowsers();
}

finish();
