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
// The CDP gotchas this check ran into are written up in and handled by `harness.mjs`.
// Read that header before concluding the driver is broken.
//
// Assertions stay at mounting and target-opening on purpose. Asserting on translation
// output would need an API key and turn a structural check into a billed one; that is
// `inline-translation.live.test.mjs`, which is a separate command for that reason.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  closeAllBrowsers,
  createChecks,
  launchExtensionBrowser,
  wait,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const SESSION = 'chrome-ai-translator-integration';
const PAGE_URL = 'https://example.com/';

const { check, failures, finish } = createChecks('action click');

async function main() {
  const ctx = await launchExtensionBrowser({
    session: SESSION,
    url: PAGE_URL,
    extensionDir: EXTENSION_DIR,
  });

  if (!ctx.extensionsDomainResponded) {
    check('CDP Extensions domain responds', false,
      'every command hung — is --enable-unsafe-extension-debugging set?');
    return;
  }
  check('extension is loaded', Boolean(ctx.extension), `saw ${JSON.stringify(ctx.extensionsSeen)}`);
  if (!ctx.extension) return;

  check('driver opened a page to act on', Boolean(ctx.tab) && Boolean(ctx.pageTarget));
  if (!ctx.tab || !ctx.pageTarget) return;

  const { evaluate, navigate } = ctx.page;
  // A tab target has no page execution context, so guard against silently evaluating
  // into nothing — that would turn every DOM assertion below into a false negative.
  check('page execution context is reachable', (await evaluate('1 + 1')) === 2);
  const buttonPresent = async () =>
    (await evaluate("Boolean(document.getElementById('chrome-ai-translator-inline'))")) === true;
  // Unfiltered, for the target-type reason in the harness header. Asserted before the click
  // as well as after: the session is reused by name, so a run interrupted with the panel
  // open would otherwise satisfy the after-check without the click having done anything.
  const sidePanelOpen = async () =>
    (await ctx.listTargets()).some(
      (target) => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`);
  const triggerAction = async (name) => {
    const triggered = await ctx.cdp.send('Extensions.triggerAction',
      { id: ctx.extension.id, targetId: ctx.tab.targetId });
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
  await navigate(`chrome-extension://${ctx.extension.id}/options.html`);
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

  ctx.close();
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(`FAIL action click - harness threw: ${error?.message || error}`);
} finally {
  await closeAllBrowsers();
}

finish();
