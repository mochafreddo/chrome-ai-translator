import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { browser, launchExtensionBrowser, serveFixture, until, wait } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = `inline-consent-${randomUUID().slice(0, 8)}`;
let ctx;
let fixture;
const requests = [];
const failures = [];
const concealedRequests = [];

async function click(page, point) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    const result = await ctx.cdp.send('Input.dispatchMouseEvent', {
      type, ...point, button: 'left', clickCount: 1,
    }, page.sessionId);
    assert.ok(!result.__error && !result.__timeout, 'Real pointer input succeeds');
  }
}

async function main() {
  fixture = await serveFixture(join(HERE, 'fixtures/inline-translation.html'));
  ctx = await launchExtensionBrowser({ session: SESSION, url: fixture.url,
    extensionDir: join(HERE, '../../extension') });
  const target = await ctx.findTarget(target => target.type === 'service_worker' &&
    target.url.startsWith(`chrome-extension://${ctx.extension.id}/`));
  assert.ok(target, 'Worker is available');
  const worker = await ctx.attach(target.id, 'service_worker');
  await worker.evaluate(`(() => {
    const open = chrome.sidePanel.open.bind(chrome.sidePanel);
    globalThis.consentPanelOpens = [];
    chrome.sidePanel.open = options => {
      const result = { tabId: options.tabId, opened: false };
      globalThis.consentPanelOpens.push(result);
      return open(options).then(() => { result.opened = true; });
    };
  })()`);
  ctx.cdp.on('Fetch.requestPaused', (event, sessionId) => {
    if (sessionId !== worker.sessionId) return;
    void (async () => {
      assert.equal(event.request.url, 'https://api.openai.com/v1/responses');
      const preflight = event.request.method === 'OPTIONS';
      let data;
      if (!preflight) {
        const body = JSON.parse(event.request.postData);
        requests.push(body);
        data = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text',
          text: JSON.stringify({ translations: JSON.parse(body.input).records.map(record => ({
            id: record.id, template: `모의 응답입니다. ${record.template}`,
          })) }),
        }] }] };
      }
      const result = await ctx.cdp.send('Fetch.fulfillRequest', {
        requestId: event.requestId, responseCode: preflight ? 204 : 200,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
          { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' },
          { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' }],
        ...(data ? { body: Buffer.from(JSON.stringify(data)).toString('base64') } : {}),
      }, sessionId);
      assert.ok(!result.__error && !result.__timeout, 'Mock response succeeds');
    })().catch(async error => {
      failures.push(error.message);
      await ctx.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sessionId);
    });
  });
  const intercepted = await ctx.cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*', requestStage: 'Request' }],
  }, worker.sessionId);
  assert.ok(!intercepted.__error && !intercepted.__timeout, 'Intercept before storing a synthetic key');
  await ctx.page.navigate(`chrome-extension://${ctx.extension.id}/options.html`);
  await ctx.page.evaluate(`(() => {
    document.getElementById('apiKey').value = 'inline-consent-synthetic-key';
    document.querySelector('input[name="buttonVisibility"][value="onInvocation"]').checked = true;
    document.getElementById('btnSave').click();
  })()`);
  assert.ok(await until(() => ctx.page.evaluate("document.getElementById('status').textContent === 'Saved.'"), 5000, 100));
  await ctx.page.navigate(fixture.url);
  const invoked = await ctx.cdp.send('Extensions.triggerAction', { id: ctx.extension.id, targetId: ctx.tab.targetId });
  assert.ok(!invoked.__error && !invoked.__timeout, 'Toolbar prepares page');
  assert.ok(await until(() => ctx.page.evaluate("Boolean(document.getElementById('chrome-ai-translator-inline'))"), 5000, 100));
  const panelTarget = await ctx.findTarget(target => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`);
  assert.ok(panelTarget, 'Extension-owned panel is available');
  const initial = await ctx.page.evaluate('document.querySelector("main").textContent');
  assert.equal(typeof initial, 'string', 'Fixture exposes its main article text');

  for (const variant of ['host', 'ancestor']) {
    const before = requests.length;
    const opens = await worker.evaluate('globalThis.consentPanelOpens.length');
    const point = await ctx.page.evaluate(`(() => {
      const host = document.getElementById('chrome-ai-translator-inline');
      host.style.cssText = 'position:fixed!important;left:100px!important;top:100px!important;right:auto!important;bottom:auto!important;z-index:2147483647!important;pointer-events:auto!important';
      ${variant === 'host' ? "host.style.setProperty('opacity', '0', 'important');" : "const wrapper = document.createElement('div'); wrapper.style.opacity = '0'; host.before(wrapper); wrapper.append(host);"}
      return { x: 120, y: 120 };
    })()`);
    await click(ctx.page, point);
    await click(ctx.page, { x: 130, y: 174 });
    await wait(700);
    concealedRequests.push({ variant, count: requests.length - before,
      opened: await worker.evaluate(`globalThis.consentPanelOpens.slice(${opens}).some(result => result.opened)`),
      unchanged: await ctx.page.evaluate('document.querySelector("main").textContent') === initial });
    console.log(`OBSERVATION ${variant} concealed clicks requests=${requests.length - before}`);
    await ctx.page.navigate(fixture.url);
    await ctx.cdp.send('Extensions.triggerAction', { id: ctx.extension.id, targetId: ctx.tab.targetId });
    assert.ok(await until(() => ctx.page.evaluate("Boolean(document.getElementById('chrome-ai-translator-inline'))"), 5000, 100));
  }
  const before = requests.length;
  const currentPanel = await ctx.findTarget(target => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`);
  const panel = await ctx.attach(currentPanel.id);
  assert.ok(await until(() => panel.evaluate("!document.getElementById('btnInlineTranslate').disabled"), 10000, 100),
    'Panel can reach the current page');
  await panel.evaluate("document.getElementById('btnInlineTranslate').click()");
  assert.ok(await until(() => requests.length > before, 10000, 100), 'Panel button starts a model request');
  assert.ok(await until(() => ctx.page.evaluate('/[가-힣]/.test(document.querySelector("main").textContent)'), 10000, 100),
    'Legitimate panel start applies mock translation');
  assert.deepEqual(failures, [], 'All requests stayed intercepted');
  console.log('PASS inline consent - panel button preserves translation');
  for (const { variant, count, unchanged, opened } of concealedRequests) {
    assert.equal(count, 0, `${variant} concealed clicks must not start paid translation`);
    assert.equal(unchanged, true, 'Concealed clicks leave article text unchanged');
    assert.equal(opened, true, 'Floating action opens browser-owned controls');
  }
  console.log('PASS inline consent - host and ancestor concealment cannot start translation');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  ctx?.close();
  fixture?.close();
  await browser(['close', '--session', SESSION], 30000);
}
