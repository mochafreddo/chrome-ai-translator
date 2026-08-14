// Live check: the page's links and inline code survive Side Panel Translation.
//
// The product of this check is an answer, not a green tick. A reader reported
// `markdown.token_missing` -- the refusal Side Panel Translation issues when an answer comes
// back without one of the placeholder tokens it sent -- and nothing in this repo had ever
// reproduced it. `npm test` drives the same path with a fake `fetch`, so a green suite says
// nothing about it: the failure turns on a real model keeping tokens. When this check was
// written, Side Panel Translation's instructions (buildInstructions in background.js) told the
// model to preserve Markdown structure and leave code alone and said nothing at all about the
// tokens. Since #26 they ask for the tokens back, and a chunk that loses one buys a single
// further attempt that names the refusal -- so this check now measures whether the asking
// worked, on a run where a failing chunk bills twice.
//
// This is the second check that spends money. `npm test` is browser-free and
// `npm run test:integration` is browser-bound but unbilled -- see tests/README.md. Run this
// one on its own with `npm run verify:live:sidepanel`, or beside the other with
// `npm run verify:live`. Neither needs the other to have run: each launches its own browser,
// saves its own key through the real options page, and clears it again on the way out.
//
// `.live.` in the filename is the convention: it says the file bills, so nobody wires it into
// test:integration by reflex. package.json is the only wiring -- integration checks are in
// none of the four hand-maintained lists in AGENTS.md.
//
// Three things about the shape of it are deliberate.
//
// The page is a local fixture, dense in links and inline code because those are what mint
// the tokens, and large enough to cut into more than one Translation Chunk because the token
// contract is settled per chunk. What its size buys is written down beside it in
// tests/integration/fixtures/sidepanel-translation.html.
//
// The check asserts invariants, never output. A model's wording changes between runs and
// between models; the number of links does not. So what is asserted is that every href and
// every inline code span comes back exactly as often as it went in -- counted by
// protected-spans.mjs, whose own behaviour is checked browser-free in `npm test`.
//
// It translates the fixture more than once, because the reported failure is not known to be
// deterministic and a single attempt that happened to come back whole would prove nothing.
// ATTEMPTS below is that number, and the reason it is also the bill is written there rather
// than here.
//
// Requires: `agent-browser` on PATH, network access, and an OpenAI key in .env.local. A
// missing or non-OpenAI key fails the run; it does not skip it. A check that quietly passes
// when it did not run is how this repo already lost two months of coverage -- see
// tests/README.md.

import { readFileSync } from 'node:fs';
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
import {
  describeSurvivalFailures,
  findSurvivalFailures,
  findUnmintedSpans,
  readProtectedSpans,
} from './protected-spans.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const EXTENSION_DIR = join(ROOT, 'extension');
const ENV_PATH = join(ROOT, '.env.local');
const FIXTURE = join(HERE, 'fixtures', 'sidepanel-translation.html');
const SESSION = 'chrome-ai-translator-live-sidepanel';
const TARGET_LANGUAGE = 'Korean';
const HANGUL = /[가-힣]/;

// The smallest chunk limit the options page accepts, and the reason the fixture can cross a
// Translation Chunk boundary without being 12,000 characters long -- which is what the
// default limit would have cost, every attempt. It is set through the real options control,
// so what the run translates under is a setting a reader could have chosen.
const CHUNK_MAX_CHARS = 2000;

// How many times the fixture is translated. Three, because the question this check answers is
// whether a nondeterministic failure happens, and one attempt cannot distinguish "does not
// happen" from "did not happen this time". Each attempt bills the whole fixture, so this
// number is the bill: raise it to look harder, and say so where the cost is written down.
const ATTEMPTS = 3;

// A single attempt: extraction, then one request per Translation Chunk. Generous, because the
// thing being waited on is a real model and a slow answer is not a failure.
const ATTEMPT_TIMEOUT_MS = 240000;

const { check, failures, finish } = createChecks('side panel translation live');

const countKind = (spans, kind) => spans.filter((span) => span.kind === kind).length;

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

    const spans = readProtectedSpans(readFileSync(FIXTURE, 'utf8'));
    console.log(
      `  the fixture holds ${countKind(spans, 'link')} links and ` +
        `${countKind(spans, 'code')} inline code spans, and is translated ${ATTEMPTS} times`
    );

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

      // The chunk limit is this check's own business, not the key module's, so it is saved
      // here -- through the same options page, with the key field left empty, which is what
      // makes a save keep the key already stored rather than replace it. That the key really
      // does survive is checked rather than assumed: every attempt below depends on it.
      //
      // It is not put back afterwards, and the key is. The difference is that a chunk limit is
      // not a secret: the profile it stays in belongs to this check's own browser session, and
      // every run of the check sets the limit before it translates anything.
      const optionsUrl = `chrome-extension://${ctx.extension.id}/options.html`;
      await page.navigate(optionsUrl);
      const savedChunkLimit = await page.evaluate(`(async () => {
        document.getElementById('chunkMaxChars').value = ${JSON.stringify(String(CHUNK_MAX_CHARS))};
        document.getElementById('btnSave').click();
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const stored = (await chrome.storage.local.get(['settings'])).settings || {};
        return {
          chunkMaxChars: stored.chunkMaxChars,
          hasKey: typeof stored.apiKey === 'string' && stored.apiKey.length > 0,
          error: document.getElementById('errorBox').hidden
            ? '' : document.getElementById('errorBox').textContent,
        };
      })()`);
      if (!check('the chunk limit the fixture needs is saved, and the key beside it survives',
        savedChunkLimit?.chunkMaxChars === CHUNK_MAX_CHARS && savedChunkLimit?.hasKey === true,
        JSON.stringify({ ...savedChunkLimit, hasKey: Boolean(savedChunkLimit?.hasKey) }))) return;

      await page.navigate(fixture.url);
      const pageText = () => page.evaluate('document.body.innerText.trim()');
      const originalPageText = await pageText();
      if (!check('the fixture starts in its original language',
        typeof originalPageText === 'string' && originalPageText.length > 0
          && !HANGUL.test(originalPageText),
        JSON.stringify(String(originalPageText).slice(0, 80)))) return;

      // Side Panel Translation does not need Inline Translation Authorization, but it does
      // need the content script to extract the article, and the panel to press the control
      // in. The toolbar action is what gives it both.
      const triggered = await ctx.cdp.send('Extensions.triggerAction',
        { id: ctx.extension.id, targetId: ctx.tab.targetId });
      check('toolbar action reaches the extension', !triggered.__timeout && !triggered.__error,
        triggered.__error || (triggered.__timeout ? 'no response' : ''));
      await wait(3000);

      const panelUrl = `chrome-extension://${ctx.extension.id}/sidepanel.html`;
      const panelTarget = await ctx.findTarget((target) => target.url === panelUrl);
      if (!check('side panel is open to drive Side Panel Translation from', Boolean(panelTarget))) return;
      const panel = await ctx.attach(panelTarget.id);

      // In the bilingual view the panel prints the original above the translation, and every
      // span in the document would then be counted twice on the way out. The counting is the
      // check, so the view it counts in is chosen rather than inherited.
      const viewMode = await panel.evaluate(`(() => {
        const el = document.getElementById('viewMode');
        el.value = 'translation';
        el.dispatchEvent(new Event('change'));
        return el.value;
      })()`);
      if (!check('the panel is showing the translation alone', viewMode === 'translation',
        `viewMode=${viewMode}`)) return;

      const panelState = () => panel.evaluate(`({
        status: document.getElementById('status').textContent,
        progress: document.getElementById('progress').textContent,
        error: document.getElementById('errorBox').hidden
          ? '' : document.getElementById('errorBox').textContent,
        original: document.getElementById('original').textContent,
        translated: document.getElementById('translated').textContent,
      })`);
      const click = (id) => panel.evaluate(`document.getElementById(${JSON.stringify(id)}).click(), true`);
      const running = (status) => status === 'Extracting' || status === 'Translating';

      // One attempt, watched rather than merely awaited. Which Translation Chunk was in
      // flight is only knowable while the run is under way -- the worker clears the progress
      // when it fails -- and it is the one thing that says where in the document a refusal
      // happened, so it is sampled as it goes. Sampled, which means a run whose chunks all
      // came and went between two reads reports none; the counts are treated as evidence of
      // what was seen, never as proof of what happened.
      async function translateOnce() {
        await click('btnTranslate');
        // A previous attempt left the panel saying Done, and the panel is a second behind the
        // worker. Waiting for the run to start first is what stops that stale Done being read
        // as this attempt having finished before it began.
        const started = await until(async () => running((await panelState())?.status), 30000, 200);
        let chunkTotal = 0;
        let lastChunk = '';
        let settled = null;
        const done = await until(async () => {
          const now = await panelState();
          const chunk = /Chunk (\d+)\/(\d+)/.exec(String(now?.progress || ''));
          if (chunk) {
            chunkTotal = Math.max(chunkTotal, Number(chunk[2]));
            lastChunk = chunk[0];
          }
          if (now?.status === 'Done' || now?.status === 'Error') {
            settled = now;
            return true;
          }
          return false;
        }, ATTEMPT_TIMEOUT_MS, 250);
        return {
          started,
          done,
          state: settled || (await panelState()),
          chunkTotal,
          lastChunk,
        };
      }

      const ledger = [];
      let chunkTotalSeen = 0;
      let mintingChecked = false;

      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        const attemptLabel = `attempt ${attempt}/${ATTEMPTS}`;
        const run = await translateOnce();
        chunkTotalSeen = Math.max(chunkTotalSeen, run.chunkTotal);
        const status = String(run.state?.status || '');

        if (!check(`${attemptLabel} settles`, run.started && run.done,
          `status="${status}" progress="${run.lastChunk || '(none)'}"`)) {
          // Stop rather than carry on. A run still in flight leaves Start disabled, so the
          // next attempt's click lands on nothing and every remaining attempt would report
          // the same non-event as a finding of its own.
          const abandoned = ATTEMPTS - attempt;
          ledger.push(
            `${attemptLabel}: never settled, last status ${status || '(unknown)'}` +
              (abandoned ? `; ${abandoned} attempt(s) not run` : '')
          );
          break;
        }

        // The extraction happens before the first request and survives a failed translation,
        // so this is answerable on any attempt that got that far -- and it has to be answered
        // before anything about the way back means anything. A fixture that stopped minting
        // tokens would make every other check below vacuously true.
        if (!mintingChecked && String(run.state?.original || '').trim()) {
          mintingChecked = true;
          const notMinted = findUnmintedSpans(spans, run.state.original);
          check('the extracted Markdown holds every link and inline code span the fixture has',
            notMinted.length === 0, describeSurvivalFailures(notMinted));
        }

        if (status !== 'Done') {
          // The reported failure, or another like it. The worker refuses the answer before
          // rehydrating it, so there is no output to name the token from; what the run can
          // say is which refusal and which Translation Chunk was in flight, and it says both.
          check(`${attemptLabel} is accepted with its token contract intact`, false,
            `${run.state?.error || '(no message)'} while ${run.lastChunk || 'no chunk'} was in flight`);
          ledger.push(
            `${attemptLabel}: ${run.state?.error || 'failed with no message'} at ` +
              `${run.lastChunk || 'an unknown chunk'}`
          );
          continue;
        }

        const translated = String(run.state?.translated || '');
        check(`${attemptLabel} comes back in the target language`, HANGUL.test(translated),
          JSON.stringify(translated.slice(0, 80)));

        const lost = findSurvivalFailures({
          spans,
          original: run.state.original,
          translated,
        });
        check(`${attemptLabel} brings every link and inline code span back as often as it went in`,
          lost.length === 0, describeSurvivalFailures(lost));
        ledger.push(
          `${attemptLabel}: accepted over ${run.chunkTotal || 'an unseen number of'} chunks` +
            (lost.length ? `, but ${describeSurvivalFailures(lost)}` : ', every span back')
        );
      }

      // Not an accident of the fixture: the token contract is settled per Translation Chunk,
      // so a run that fitted in one chunk would never cross the boundary this check is here
      // to watch. Read off the panel's own progress rather than computed, because the chunking
      // is the worker's decision and not this check's.
      check('the fixture cuts into more than one Translation Chunk', chunkTotalSeen > 1,
        chunkTotalSeen
          ? `chunks the panel reported: ${chunkTotalSeen}`
          : 'no Chunk n/m ever appeared in the panel, so the count was never seen');

      // The distinguishing property of this translation: the page beside the panel is not
      // touched. Inline Translation is the one that rewrites it.
      check('the page beside the panel is left exactly as it was',
        (await pageText()) === originalPageText);

      console.log('\nwhat the run saw:');
      for (const line of ledger) console.log(`  ${line}`);
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
  console.error(`FAIL side panel translation live - harness threw: ${error?.message || error}`);
} finally {
  await closeAllBrowsers();
}

finish();
