// Integration check: clicking the extension's toolbar action must reach the extension.
//
// Not part of `npm test`. That suite is pure Node with no browser, and folding a
// browser-dependent check into it would make every future `npm test` depend on a
// Chrome binary. Run this one explicitly: `npm run test:integration`.
//
// It guards ADR-0001. `setPanelBehavior({ openPanelOnActionClick: true })` and a
// `chrome.action.onClicked` listener are mutually exclusive: with the former set,
// Chrome consumes the click and the listener never runs, so no content script is
// injected and no Inline Translation Authorization is granted. Restoring that setting
// looks like a simplification, so this check exists to turn it back into a red test.
//
// The Floating Translate Button appearing is the page-side proof that the click arrived,
// and Button Visibility defaults to never, so the check chooses on-invocation from the real
// options page first. Note that the panel opening proves nothing on its own: under the
// broken configuration Chrome opens it without the extension being involved at all.
//
// Requires: `agent-browser` on PATH, and network access (it drives a real page).
//
// Gotchas, all of which look like something other than what they are:
//
//   Symptom: every `Extensions.*` CDP command hangs with no response.
//   Cause:   the domain is gated behind a Chrome launch flag.
//   Fix:     launch with `--args "--enable-unsafe-extension-debugging"`. Without it the
//            domain still appears in `/json/protocol`, so the only signal is the hang.
//
//   Symptom: `--extension <dir>` appears to do nothing.
//   Cause:   it is a global agent-browser flag and is silently ignored after the
//            subcommand.
//   Fix:     put it before `open`. Confirm with `ps aux | grep -o -- "--load-extension=[^ ]*"`.
//
//   Symptom: `triggerAction` rejects with "Action can only be triggered on a tab target".
//   Cause:   `page` and `tab` are different CDP target types, and the ids from
//            `/json/list` are page targets.
//   Fix:     `Target.getTargets` with `{ filter: [{ type: 'tab' }] }`.
//
//   Symptom: the side panel check fails while the panel is plainly open on screen.
//   Cause:   the same two target types again — a side panel is hosted as a `page` target,
//            so a `tab`-filtered listing never contains it.
//   Fix:     list targets unfiltered and match on the sidepanel URL.
//
//   Symptom: `Runtime.evaluate` returns undefined for everything, even `typeof x`.
//   Cause:   it was attached to the `tab` target, which has no page execution context.
//   Fix:     the two target types are needed for different things — evaluate against the
//            `page` target from `/json/list`, trigger the action against the `tab` target.
//            Reading this as "the button is absent" is a false negative that will make the
//            check pass a broken build once the real assertion is fixed.
//
//   Symptom: `Extensions.loadUnpacked`, `Extensions.getStorageItems` and
//            `Target.createTarget` all fail with "No associated browser context".
//   Cause:   the browser-level session has no context id under a driver-launched Chrome.
//            Not fixed by the debugging flag.
//   Fix:     load the extension at launch, reuse a tab the driver opened, and observe
//            the page DOM and the target list rather than extension storage.
//
//   MV3 service workers idle out in roughly 30 seconds, so probes installed in the
//   worker via `Runtime.evaluate` are unreliable. Observe from the page side.
//
// Assertions stay at mounting and target-opening on purpose. Asserting on translation
// output would need an API key and turn a structural check into a billed one.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-integration';
const PAGE_URL = 'https://example.com/';

const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) return console.log(`PASS action click - ${name}`);
  failures.push(name);
  console.error(`FAIL action click - ${name}${detail ? ` (${detail})` : ''}`);
};

const browser = (args, timeout = 120000) =>
  execFileSync('agent-browser', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });

function extensionName() {
  return JSON.parse(readFileSync(join(EXTENSION_DIR, 'manifest.json'), 'utf8')).name;
}

function connect(endpoint) {
  const ws = new WebSocket(endpoint);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter(message.error ? { __error: message.error.message } : message.result);
  });
  const ready = new Promise((resolve) => ws.addEventListener('open', resolve));
  const send = (method, params = {}, sessionId, timeoutMs = 10000) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve({ __timeout: true });
      }, timeoutMs);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ready, send, close: () => ws.close() };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  browser(['--extension', EXTENSION_DIR, '--args', '--enable-unsafe-extension-debugging',
    '--session', SESSION, 'open', PAGE_URL]);

  const cdpUrl = browser(['get', 'cdp-url', '--session', SESSION]).trim().split('\n').pop();
  const httpBase = cdpUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
  const { webSocketDebuggerUrl } = await (await fetch(`${httpBase}/json/version`)).json();
  const cdp = connect(webSocketDebuggerUrl);
  await cdp.ready;

  const listed = await cdp.send('Extensions.getExtensions');
  if (listed.__timeout) {
    check('CDP Extensions domain responds', false,
      'every command hung — is --enable-unsafe-extension-debugging set?');
    return;
  }
  const extension = (listed.extensions || []).find((candidate) => candidate.name === extensionName());
  check('extension is loaded', Boolean(extension), `saw ${JSON.stringify((listed.extensions || []).map((e) => e.name))}`);
  if (!extension) return;

  const tabs = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = (tabs.targetInfos || []).filter((target) => target.url.startsWith(PAGE_URL)).pop();
  const listedTargets = await (await fetch(`${httpBase}/json/list`)).json();
  const pageTarget = listedTargets
    .filter((target) => target.type === 'page' && target.url.startsWith(PAGE_URL))
    .pop();
  check('driver opened a page to act on', Boolean(tab) && Boolean(pageTarget));
  if (!tab || !pageTarget) return;

  const page = await cdp.send('Target.attachToTarget', { targetId: pageTarget.id, flatten: true });
  const evaluate = async (expression) => {
    const evaluated = await cdp.send('Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true }, page.sessionId);
    return evaluated.result?.value;
  };
  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, page.sessionId);
    await wait(2500);
  };
  // A tab target has no page execution context, so guard against silently evaluating
  // into nothing — that would turn every DOM assertion below into a false negative.
  check('page execution context is reachable', (await evaluate('1 + 1')) === 2);
  const buttonPresent = async () =>
    (await evaluate("Boolean(document.getElementById('chrome-ai-translator-inline'))")) === true;
  // Unfiltered, for the target-type reason in the header. Asserted before the click as well
  // as after: the session is reused by name, so a run interrupted with the panel open would
  // otherwise satisfy the after-check without the click having done anything.
  const sidePanelOpen = async () => {
    const targets = await cdp.send('Target.getTargets');
    return (targets.targetInfos || []).some(
      (target) => target.url === `chrome-extension://${extension.id}/sidepanel.html`);
  };
  const triggerAction = async (name) => {
    const triggered = await cdp.send('Extensions.triggerAction', { id: extension.id, targetId: tab.targetId });
    check(`action can be triggered ${name}`, !triggered.__timeout && !triggered.__error,
      triggered.__error || (triggered.__timeout ? 'no response' : ''));
    await wait(3000);
  };

  check('Floating Translate Button is absent before the click', (await buttonPresent()) === false);
  check('side panel is closed before the click', (await sidePanelOpen()) === false,
    'a leftover session would make the check below pass on its own');

  await triggerAction('on a fresh install');

  check('Floating Translate Button stays absent on a fresh install', (await buttonPresent()) === false,
    'Button Visibility defaults to never, so an invocation must mount nothing');

  check('side panel opens after the click', await sidePanelOpen());

  // Choosing on-invocation through the real options page, rather than writing the setting
  // directly, is also the only check that the control saves what the worker reads.
  await cdp.send('Page.enable', {}, page.sessionId);
  await navigate(`chrome-extension://${extension.id}/options.html`);
  const chosen = await evaluate(`(async () => {
    const choice = document.querySelector('input[name="buttonVisibility"][value="onInvocation"]');
    if (!choice) return 'options page has no on-invocation choice';
    choice.checked = true;
    document.getElementById('btnSave').click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const stored = await chrome.storage.local.get(['settings']);
    return document.getElementById('errorBox').textContent ||
      stored.settings?.buttonVisibility || 'nothing saved';
  })()`);
  check('options page saves the on-invocation choice', chosen === 'onInvocation', String(chosen));

  await navigate(PAGE_URL);
  check('page execution context survives the options round trip', (await evaluate('1 + 1')) === 2);
  check('Floating Translate Button is absent on a fresh page load', (await buttonPresent()) === false);

  await triggerAction('with on-invocation chosen');

  check('Floating Translate Button appears after the click', await buttonPresent(),
    'the click never reached the extension — see ADR-0001');

  cdp.close();
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(`FAIL action click - harness threw: ${error?.message || error}`);
} finally {
  try { browser(['close', '--all'], 30000); } catch {}
}

if (failures.length) {
  console.error(`\n${failures.length} failing: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\naction click: all checks passed');
}
