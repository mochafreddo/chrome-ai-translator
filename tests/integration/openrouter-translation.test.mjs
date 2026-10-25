import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { browser, createChecks, launchExtensionBrowser, serveFixture, until, wait } from './harness.mjs';
import { readStopBlockContract } from './fixture-stop-contract.mjs';
import { inlinePanelControlsReady } from './inline-panel-readiness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const flowArguments = process.argv.slice(2);
if (flowArguments.length !== 2 || flowArguments[0] !== '--flow' || !['inline', 'sidepanel'].includes(flowArguments[1])) {
  throw new Error('Use --flow inline or --flow sidepanel');
}
const FLOW = flowArguments[1];
const SESSION = `openrouter-${FLOW}-${randomUUID().slice(0, 8)}`;
const { check, failures, finish } = createChecks(`OpenRouter ${FLOW}`);
let ctx;
let fixture;
let stopRequests;
const requests = [];
const interceptionErrors = [];
let hold = false;
const held = [];

async function main() {
  fixture = await serveFixture(join(HERE, 'fixtures', `${FLOW === 'inline' ? 'inline' : 'sidepanel'}-translation.html`));
  ctx = await launchExtensionBrowser({ session: SESSION, url: fixture.url,
    extensionDir: join(HERE, '..', '..', 'extension') });
  const workerTarget = await ctx.findTarget(target => target.type === 'service_worker' &&
    target.url.startsWith(`chrome-extension://${ctx.extension.id}/`));
  if (!check('worker is available for network interception', Boolean(workerTarget))) return;
  const worker = await ctx.attach(workerTarget.id, 'service_worker');
  stopRequests = ctx.cdp.on('Fetch.requestPaused', (event, sessionId) => {
    if (sessionId !== worker.sessionId) return;
    void (async () => {
      const request = event.request;
      if (!/^https:\/\/(?:api\.openai\.com|openrouter\.ai)\//.test(request.url)) {
        interceptionErrors.push('unexpected worker host');
        await ctx.cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }, sessionId);
        return;
      }
      if (request.method === 'OPTIONS') {
        const response = await ctx.cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId, responseCode: 204,
          responseHeaders: [{ name: 'Access-Control-Allow-Origin', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
            { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' }],
        }, sessionId);
        if (response.__error || response.__timeout) interceptionErrors.push('preflight fulfillment failed');
        return;
      }
      const body = JSON.parse(request.postData || '{}');
      requests.push({ url: request.url, method: request.method, body,
        authorization: request.headers.Authorization || request.headers.authorization });
      const outputText = FLOW === 'inline'
        ? JSON.stringify({ translations: JSON.parse(body.input).records.map(record => ({ id: record.id,
          template: record.template.split(/(⟦[^⟧]+⟧)/).map(part =>
            part.startsWith('⟦') ? part : /[A-Za-z]/.test(part) ? '결정적인 번역입니다. ' : part).join(''),
        })) })
        : `결정적 번역\n${body.input}`;
      const fulfill = async () => {
        const response = await ctx.cdp.send('Fetch.fulfillRequest', {
          requestId: event.requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' }],
          body: Buffer.from(JSON.stringify({ status: 'completed', output: [{ type: 'message',
            content: [{ type: 'output_text', text: outputText }] }] })).toString('base64'),
        }, sessionId);
        if (response.__error || response.__timeout) interceptionErrors.push('fulfillment failed');
      };
      if (hold) held.push(fulfill);
      else await fulfill();
    })().catch(() => { interceptionErrors.push('interception failed'); });
  });
  const enabled = await ctx.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, worker.sessionId);
  if (!check('all worker requests are intercepted before network', !enabled.__error && !enabled.__timeout)) return;

  const options = ctx.page;
  const optionsUrl = `chrome-extension://${ctx.extension.id}/options.html`;
  await options.navigate(optionsUrl);
  const save = async (service, key = '') => {
    await options.evaluate(`(() => {
      const choice = document.querySelector('input[name="service"][value="${service}"]');
      choice.checked = true;
      choice.dispatchEvent(new Event('change'));
      document.getElementById('apiKey').value = ${JSON.stringify(key)};
      document.getElementById('model').value = 'custom-openai-browser';
      document.getElementById('reasoningEffort').value = 'high';
      document.getElementById('chunkMaxChars').value = '2000';
      document.querySelector('input[name="buttonVisibility"][value="onInvocation"]').checked = true;
      document.getElementById('btnSave').click();
    })()`);
    return until(() => options.evaluate("document.getElementById('status').textContent === 'Saved.'"), 5000, 100);
  };
  check('OpenAI credential and custom settings save through Options', await save('openai', 'sk-openai-browser-synthetic'));
  check('OpenRouter credential saves through Options', await save('openrouter', 'sk-or-browser-synthetic'));
  await options.navigate(optionsUrl);
  const reloaded = await options.evaluate(`(async () => {
    const settings = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })).settings;
    return { settings, keyInput: document.getElementById('apiKey').value,
      modelHidden: document.getElementById('openaiSettings').hidden,
      pinned: document.getElementById('openrouterModel').textContent,
      permissions: chrome.runtime.getManifest().host_permissions };
  })()`);
  check('service and independent concealed credentials persist', reloaded.settings.service === 'openrouter' &&
    reloaded.settings.apiKey === '***' && reloaded.settings.openrouterApiKey === '***' && reloaded.keyInput === '');
  check('OpenAI choices survive and OpenRouter exposes its pinned model', reloaded.settings.model === 'custom-openai-browser' &&
    reloaded.settings.reasoningEffort === 'high' && reloaded.modelHidden && reloaded.pinned === 'deepseek/deepseek-v4.1-flash-1017');
  check('manifest permits both fixed service hosts', reloaded.permissions.includes('https://api.openai.com/*') &&
    reloaded.permissions.includes('https://openrouter.ai/*'));
  check('blank-key edit saves without a request', await save('openrouter') && requests.length === 0);

  const tabId = await options.evaluate(`chrome.tabs.create({ url: ${JSON.stringify(fixture.url)}, active: true }).then(tab => tab.id)`);
  await until(async () => (await ctx.cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] }))
    .targetInfos?.some(target => target.url === fixture.url), 5000, 100);
  const targets = await ctx.cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tabTarget = targets.targetInfos.find(target => target.url === fixture.url);
  const triggered = await ctx.cdp.send('Extensions.triggerAction', { id: ctx.extension.id, targetId: tabTarget.targetId });
  if (!check('toolbar opens translation entry', !triggered.__error && !triggered.__timeout)) return;
  await until(() => ctx.findTarget(target => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`), 10000, 200);
  const panelTarget = await ctx.findTarget(target => target.url === `chrome-extension://${ctx.extension.id}/sidepanel.html`);
  if (!check('side panel is available', Boolean(panelTarget))) return;
  const panel = await ctx.attach(panelTarget.id);
  if (FLOW === 'inline') {
    let delayedScript;
    const stopDelay = ctx.cdp.on('Fetch.requestPaused', (event, sessionId) => {
      if (sessionId === panel.sessionId) delayedScript = event.requestId;
    });
    try {
      const delayEnabled = await ctx.cdp.send('Fetch.enable', { patterns: [{
        urlPattern: `chrome-extension://${ctx.extension.id}/sidepanel.js`, requestStage: 'Request',
      }] }, panel.sessionId);
      if (!check('side panel script delay is installed', !delayEnabled.__error && !delayEnabled.__timeout)) return;
      await ctx.cdp.send('Page.reload', { ignoreCache: true }, panel.sessionId);
      if (!check('side panel script is delayed before initialization',
        await until(() => Boolean(delayedScript), 5000, 100))) return;
      const initial = await panel.evaluate(`({
        enabled: !document.getElementById('btnInlineTranslate').disabled,
        status: document.getElementById('inlineStatus').textContent,
        loading: document.readyState !== 'complete',
      })`);
      check('initial markup offers Start before its handler is loaded',
        initial?.enabled && initial.status === '' && initial.loading);
      check('Inline readiness rejects the initial enabled markup', !(await inlinePanelControlsReady(panel)),
        'readiness accepted an uninitialized document');
    } finally {
      if (delayedScript) await ctx.cdp.send('Fetch.continueRequest', { requestId: delayedScript }, panel.sessionId);
      await ctx.cdp.send('Fetch.disable', {}, panel.sessionId);
      stopDelay();
    }
    if (!check('Inline controls become ready after the delayed script initializes', await until(
      () => inlinePanelControlsReady(panel), 10000, 100))) return;
  }
  const panelReady = await until(() => panel.evaluate(
    "document.getElementById('model').disabled && document.getElementById('model').value === 'deepseek/deepseek-v4.1-flash-1017'"), 5000, 100);
  check('panel displays the pinned model without an editable model choice', panelReady);
  if (!panelReady) console.log('  panel readiness:', JSON.stringify(await panel.evaluate(`({
    model: document.getElementById('model').value, disabled: document.getElementById('model').disabled,
    status: document.getElementById('status').textContent,
    hasEffectiveModelSettings: typeof ChromeAiTranslatorDefaultModel.getEffectiveModelSettings === 'function'
  })`)));
  if (FLOW === 'sidepanel') {
    await panel.evaluate("document.getElementById('btnTranslate').click()");
    const done = await until(() => panel.evaluate("document.getElementById('status').textContent === 'Done'"), 15000, 100);
    if (!done || requests.length < 2) console.log('  translation readiness:', JSON.stringify({ requests: requests.length,
      requestMetadata: requests.map(request => ({ method: request.method, model: request.body.model,
        inputType: typeof request.body.input, inputChars: typeof request.body.input === 'string' ? request.body.input.length : null,
        reasoning: request.body.reasoning, provider: request.body.provider,
        selectedCredential: request.authorization === 'Bearer sk-or-browser-synthetic' })),
      panel: await panel.evaluate(`({ status: document.getElementById('status').textContent,
        hasError: !document.getElementById('errorBox').hidden,
        errorCode: document.getElementById('errorBox').textContent.match(/(?:response|markdown|openrouter)\\.[a-z_.]+/)?.[0] || '',
        hasOutput: Boolean(document.getElementById('translated').textContent.trim()) })`) }));
    check('Side Panel renders deterministic output across chunks', done && requests.length > 1 &&
      await panel.evaluate("document.getElementById('translated').textContent.includes('결정적 번역')"));
    check('only the chosen credential reaches its fixed endpoint and required policy', requests.length > 1 && requests.every(request =>
      request.url === 'https://openrouter.ai/api/v1/responses' && request.authorization === 'Bearer sk-or-browser-synthetic' &&
      request.body.model === 'deepseek/deepseek-v4.1-flash-1017' && request.body.reasoning?.effort === 'none' &&
      request.body.provider?.require_parameters === true && request.body.provider?.data_collection === 'deny' &&
      request.body.provider?.zdr === true && request.body.store === false));
  } else {
    const pageTarget = await ctx.findTarget(target => target.type === 'page' && target.url === fixture.url);
    const page = await ctx.attach(pageTarget.id);
    const stopContract = await readStopBlockContract(page);
    check('the uncached Stop fixture contract is readable in the fixture realm', Boolean(stopContract?.template) &&
      stopContract.atoms?.length === 0 && stopContract.contract?.entries?.length === 0);
    await page.evaluate(`(() => {
      const p = document.querySelector('main p');
      p.innerHTML = 'Read <a href="https://example.test/">this guide</a> and use <code>sample()</code> safely.';
      const root = document.querySelector('main');
      globalThis.originalNodes = [...root.querySelectorAll('*')];
      globalThis.originalHtml = root.innerHTML;
      return root.textContent;
    })()`);
    const click = id => panel.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
    const state = () => panel.evaluate(`({ status: document.getElementById('inlineStatus').textContent,
      error: document.getElementById('inlineError').hidden ? '' : document.getElementById('inlineError').textContent })`);
    const translated = () => page.evaluate("/[가-힣]/.test(document.querySelector('main').textContent)");
    const restored = () => page.evaluate(`document.querySelector('main').innerHTML === globalThis.originalHtml &&
      globalThis.originalNodes.every((node, index) => document.querySelectorAll('main *')[index] === node)`);
    await click('btnInlineTranslate');
    check('OpenRouter Inline renders structured deterministic output', await until(translated, 10000, 100));
    check('Inline preserves page-owned link and code nodes', await page.evaluate(`
      globalThis.originalNodes.every(node => document.querySelector('main').contains(node)) &&
      document.querySelector('main a').getAttribute('href') === 'https://example.test/' &&
      document.querySelector('main code').textContent === 'sample()'`));
    const firstCount = requests.length;
    check('OpenRouter uses its credential and strict structured policy', firstCount > 0 && requests.every(request =>
      request.url === 'https://openrouter.ai/api/v1/responses' && request.authorization === 'Bearer sk-or-browser-synthetic' &&
      request.body.model === 'deepseek/deepseek-v4.1-flash-1017' && request.body.reasoning?.effort === 'none' &&
      request.body.provider?.require_parameters === true && request.body.provider?.data_collection === 'deny' &&
      request.body.provider?.zdr === true && request.body.text?.format?.strict === true && request.body.store === false));
    await click('btnInlineRestore');
    check('Original text restores exact HTML and node identities', await until(restored, 5000, 100));
    await click('btnInlineTranslate');
    check('same-service cache restores translation without network', await until(translated, 5000, 100) && requests.length === firstCount);
    await click('btnInlineStop');
    await options.navigate(optionsUrl);
    check('service switch saves through Options', await save('openai'));
    hold = true;
    await click('btnInlineTranslate');
    if (!check('service switch bypasses the OpenRouter cache', await until(() => held.length > 0, 5000, 100))) return;
    check('changed settings restore the prior translation before new answers', await restored());
    check('OpenAI request retains its custom configuration and separate key', requests.slice(firstCount).every(request =>
      request.url === 'https://api.openai.com/v1/responses' && request.authorization === 'Bearer sk-openai-browser-synthetic' &&
      request.body.model === 'custom-openai-browser' && request.body.reasoning?.effort === 'high' && !request.body.provider));
    await click('btnInlineStop');
    check('Stop settles while an uncached request is pending', await until(async () => (await state()).status.startsWith('Visible translation stopped'), 5000, 100));
    hold = false;
    for (const fulfill of held.splice(0)) await fulfill();
    await wait(800);
    check('a stopped request never applies its delayed answer', !(await translated()) && await restored());
    await click('btnInlineRestore');
    check('Original text remains exact after Stop', await until(restored, 5000, 100));
    check('stopped Inline reports no error', !(await state()).error);
    await options.navigate(optionsUrl);
    check('switching back selects the earlier service', await save('openrouter'));
    const beforeCache = requests.length;
    await click('btnInlineTranslate');
    check('switching back reuses only the matching service cache', await until(translated, 5000, 100) && requests.length === beforeCache);
    await click('btnInlineRestore');
    check('final restoration keeps every original page node', await until(restored, 5000, 100));
    hold = true;
    await options.navigate(optionsUrl);
    await options.evaluate(`document.getElementById('tone').value = 'natural';
      document.getElementById('btnSave').click()`);
    check('effective tone change saves through Options', await until(() => options.evaluate(
      "document.getElementById('status').textContent === 'Saved.'"), 5000, 100));
    const beforeOpenRouterStop = requests.length;
    await click('btnInlineTranslate');
    if (!check('OpenRouter has an uncached pending request before Stop', await until(() => held.length > 0, 5000, 100))) return;
    check('OpenRouter pending request keeps the selected service', requests.length > beforeOpenRouterStop &&
      requests.slice(beforeOpenRouterStop).every(request => request.url === 'https://openrouter.ai/api/v1/responses' &&
        request.authorization === 'Bearer sk-or-browser-synthetic'));
    await click('btnInlineStop');
    check('OpenRouter Stop settles before the answer', await until(async () =>
      (await state()).status.startsWith('Visible translation stopped'), 5000, 100));
    hold = false;
    for (const fulfill of held.splice(0)) await fulfill();
    await wait(800);
    check('OpenRouter Stop excludes its late answer', !(await translated()) && await restored());
    await click('btnInlineRestore');
    check('OpenRouter Original text restores nodes after Stop', await until(restored, 5000, 100));
  }
  await options.navigate(optionsUrl);
  const stopDialogs = options.answerDialogs(true);
  try {
    await options.evaluate("document.getElementById('btnClear').click()");
    const cleared = await until(() => options.evaluate(`chrome.runtime.sendMessage({type:'GET_SETTINGS'}).then(response =>
      response.settings.openrouterApiKey === '' && response.settings.apiKey === '***')`), 5000, 100);
    check('selected OpenRouter key clears independently through its real UI', cleared);
  } finally { stopDialogs(); }
  check('all observed requests were fulfilled locally', interceptionErrors.length === 0);
  check('translation tab remains addressable', Number.isInteger(tabId));
}

try { await main(); }
catch { failures.push('harness'); console.error(`FAIL OpenRouter ${FLOW} - harness failed`); }
finally {
  stopRequests?.();
  ctx?.close();
  await browser(['close', '--session', SESSION], 30000).catch(() => {});
  fixture?.close();
}
finish();
