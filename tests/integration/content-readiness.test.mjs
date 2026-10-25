import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  browser,
  createChecks,
  launchExtensionBrowser,
  serveFixture,
  until,
} from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXTENSION_DIR = join(HERE, '..', '..', 'extension');
const FIXTURE = join(HERE, 'fixtures', 'inline-translation.html');
const SESSION = `content-ready-${randomUUID().slice(0, 8)}`;
const { check, failures, finish } = createChecks('content readiness');
let ctx = null;
let fixtureServer = null;
let modelRequestCount = 0;
let watchedWorkerCount = 0;

async function findPage(url) {
  const found = await until(() => ctx.findTarget((target) =>
    target.type === 'page' && target.url === url), 10000, 250);
  return found ? ctx.findTarget((target) =>
    target.type === 'page' && target.url === url) : null;
}

async function findTab(url) {
  const matches = async () => {
    const response = await ctx.cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    return (response.targetInfos || []).some((target) => target.url === url);
  };
  if (!(await until(matches, 10000, 250))) return null;
  const response = await ctx.cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  return (response.targetInfos || []).find((target) => target.url === url) || null;
}

async function watchModelRequests() {
  const enableNetwork = async (sessionId, isWorker = false) => {
    const response = await ctx.cdp.send('Network.enable', {}, sessionId, 5000);
    if (isWorker && !response.__timeout && !response.__error) watchedWorkerCount += 1;
  };
  ctx.cdp.on('Network.requestWillBeSent', (event) => {
    if (/^https:\/\/(?:api\.openai\.com|openrouter\.ai)\//.test(event.request?.url || '')) modelRequestCount += 1;
  });
  ctx.cdp.on('Target.attachedToTarget', (event) => {
    if (event.targetInfo?.type === 'service_worker' &&
        event.targetInfo.url.startsWith(`chrome-extension://${ctx.extension.id}/`)) {
      void enableNetwork(event.sessionId, true);
    }
  });
  await ctx.cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const targets = await ctx.listTargets();
  for (const target of targets.filter((candidate) =>
    candidate.type === 'service_worker' &&
    candidate.url.startsWith(`chrome-extension://${ctx.extension.id}/`))) {
    const attached = await ctx.cdp.send('Target.attachToTarget', {
      targetId: target.targetId || target.id,
      flatten: true,
    });
    if (attached.sessionId) await enableNetwork(attached.sessionId, true);
  }
  await until(() => watchedWorkerCount > 0, 5000, 100);
}

async function getInlineState(extensionPage, tabId) {
  return extensionPage.evaluate(`(async () => {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_INLINE_TRANSLATION_STATE', tabId: ${tabId}
    });
    return response?.ok && typeof response.snapshot?.status === 'string';
  })()`);
}

async function clickRealControl(page, selector) {
  const point = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    element.scrollIntoView({ block: 'center' });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
  if (!point) return false;
  await ctx.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: point.x, y: point.y,
  }, page.sessionId);
  await ctx.cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1,
  }, page.sessionId);
  await ctx.cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1,
  }, page.sessionId);
  return true;
}

async function main() {
  fixtureServer = await serveFixture(FIXTURE);
  const launchUrl = `${fixtureServer.url}?run=${randomUUID()}`;
  ctx = await launchExtensionBrowser({
    session: SESSION,
    url: launchUrl,
    extensionDir: EXTENSION_DIR,
  });

  check('CDP Extensions domain responds', ctx.extensionsDomainResponded);
  if (!ctx.extensionsDomainResponded) return;
  check('extension is loaded', Boolean(ctx.extension));
  if (!ctx.extension) return;
  check('initial page and tab are available', Boolean(ctx.page) && Boolean(ctx.tab));
  if (!ctx.page || !ctx.tab) return;

  await ctx.cdp.send('Network.enable', {}, ctx.page.sessionId);
  await watchModelRequests();
  check('model request observer is attached to the service worker', watchedWorkerCount > 0);
  if (!watchedWorkerCount) return;

  const optionsUrl = `chrome-extension://${ctx.extension.id}/options.html`;
  await ctx.page.navigate(optionsUrl);
  const optionsTabId = await ctx.page.evaluate('chrome.tabs.getCurrent().then((tab) => tab?.id)');
  check('Options page is available', Number.isInteger(optionsTabId));
  if (!Number.isInteger(optionsTabId)) return;
  const options = ctx.page;

  const firstUrl = `${fixtureServer.url}?run=${randomUUID()}`;
  const firstTabId = await options.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(firstUrl)} })
    .then((tab) => tab.id)`);
  const firstPageTarget = await findPage(firstUrl);
  const firstTabTarget = await findTab(firstUrl);
  check('initial local page opens', Number.isInteger(firstTabId) && Boolean(firstPageTarget) &&
    Boolean(firstTabTarget));
  if (!Number.isInteger(firstTabId) || !firstPageTarget || !firstTabTarget) return;
  const firstPage = await ctx.attach(firstPageTarget.id);
  const initialButton = await firstPage.evaluate(
    "Boolean(document.getElementById('chrome-ai-translator-inline'))");
  check('button is absent before invocation', initialButton === false);

  const triggerAction = async (tabTarget, attempt) => {
    const response = await ctx.cdp.send('Extensions.triggerAction', {
      id: ctx.extension.id,
      targetId: tabTarget.targetId,
    });
    check(`toolbar action triggers ${attempt}`, !response.__timeout && !response.__error);
  };
  await triggerAction(firstTabTarget, 'initial injection');
  const firstReady = await until(() => getInlineState(options, firstTabId), 10000, 250);
  check('content script answers after toolbar injection', firstReady);

  await triggerAction(firstTabTarget, 'reinjection');
  const reinjectedReady = await until(() => getInlineState(options, firstTabId), 10000, 250);
  check('content script remains ready after reinjection', reinjectedReady);

  await options.evaluate(`chrome.tabs.update(${optionsTabId}, { active: true })`);
  const optionsActive = await until(async () => options.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id === ${optionsTabId};
  })()`), 5000, 100);
  check('Options tab is active before the permission request', optionsActive);
  if (!optionsActive) return;
  const radioClicked = await clickRealControl(options,
    'input[name="buttonVisibility"][value="allPages"]');
  const saveClicked = radioClicked && await clickRealControl(options, '#btnSave');
  if (saveClicked) console.log('WAIT content readiness - approve all-sites access in the disposable browser');
  const allPagesSaved = saveClicked &&
    await until(async () => options.evaluate(`(async () => {
      const settings = (await chrome.storage.local.get(['settings'])).settings;
      return settings?.buttonVisibility === 'allPages' &&
        await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] });
    })()`), 60000, 500);
  const savedState = await options.evaluate(`(async () => ({
    choice: document.querySelector('input[name="buttonVisibility"]:checked')?.value,
    stored: (await chrome.storage.local.get(['settings'])).settings?.buttonVisibility,
    access: await chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] }),
    error: document.getElementById('errorBox').textContent
  }))()`);
  check('all-pages choice is saved through Options controls', allPagesSaved, JSON.stringify(savedState));
  if (!allPagesSaved) return;

  const newUrl = `${fixtureServer.url}?run=${randomUUID()}`;
  const newTabId = await options.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(newUrl)} })
    .then((tab) => tab.id)`);
  const newPageTarget = await findPage(newUrl);
  const newTabTarget = await findTab(newUrl);
  check('new local page opens after the all-pages choice', Boolean(newTabId) &&
    Boolean(newPageTarget) && Boolean(newTabTarget));
  if (newTabId && newPageTarget && newTabTarget) {
    const newPage = await ctx.attach(newPageTarget.id);
    const autoReady = await until(() => getInlineState(options, newTabId), 10000, 250);
    check('all-pages injection is ready before toolbar action', autoReady);
    check('button appears on the automatically injected page', await until(
      async () => newPage.evaluate("Boolean(document.getElementById('chrome-ai-translator-inline'))"),
      10000, 250));
  }
}

try {
  await main();
} catch (error) {
  failures.push('harness');
  console.error(`FAIL content readiness - harness failed: ${error.message}`);
} finally {
  check('no model service requests were made', modelRequestCount === 0,
    `${modelRequestCount} request(s)`);
  ctx?.close();
  await browser(['close', '--session', SESSION], 30000).catch(() => {});
  fixtureServer?.close();
}

finish();
