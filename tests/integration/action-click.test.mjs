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
    const evaluated = await cdp.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId);
    return evaluated.result?.value;
  };
  // A tab target has no page execution context, so guard against silently evaluating
  // into nothing — that would turn every DOM assertion below into a false negative.
  check('page execution context is reachable', (await evaluate('1 + 1')) === 2);
  const buttonPresent = async () =>
    (await evaluate("Boolean(document.getElementById('chrome-ai-translator-inline'))")) === true;

  check('Floating Translate Button is absent before the click', (await buttonPresent()) === false);

  const triggered = await cdp.send('Extensions.triggerAction', { id: extension.id, targetId: tab.targetId });
  check('action can be triggered', !triggered.__timeout && !triggered.__error,
    triggered.__error || (triggered.__timeout ? 'no response' : ''));

  await wait(3000);

  check('Floating Translate Button appears after the click', await buttonPresent(),
    'the click never reached the extension — see ADR-0001');

  const after = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const panel = (after.targetInfos || []).find((target) =>
    target.url === `chrome-extension://${extension.id}/sidepanel.html`);
  check('side panel opens after the click', Boolean(panel));

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
