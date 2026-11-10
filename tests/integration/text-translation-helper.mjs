import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browser, closeSessionBrowser, launchExtensionBrowser, until } from './harness.mjs';

export async function launchTextTranslationBrowser() {
  const session = `text-translation-${randomUUID().slice(0, 8)}`;
  const ctx = await launchExtensionBrowser({ session, url: 'about:blank',
    extensionDir: fileURLToPath(new URL('../../extension', import.meta.url)) });
  const requests = [];
  const errors = [];
  const held = [];
  let holding = false;
  let output = { translation: '<b>안녕하세요</b>\n\n두 번째 문단', sourceLanguage: 'English' };
  let completionStatus = 'completed';
  let unsubscribe;
  try {
    const target = await ctx.findTarget(value => value.type === 'service_worker' &&
      value.url.startsWith(`chrome-extension://${ctx.extension.id}/`));
    if (!target) throw new Error('Text Translation worker unavailable');
    const worker = await ctx.attach(target.id, 'service_worker');
    unsubscribe = ctx.cdp.on('Fetch.requestPaused', (event, sessionId) => {
      if (sessionId !== worker.sessionId) return;
      void (async () => {
        if (!['https://api.openai.com/v1/responses', 'https://openrouter.ai/api/v1/responses'].includes(event.request.url)) {
          errors.push('Unexpected worker request blocked');
          await ctx.cdp.send('Fetch.failRequest', { requestId: event.requestId,
            errorReason: 'BlockedByClient' }, sessionId);
          return;
        }
        const headers = [{ name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Allow-Methods', value: 'POST, OPTIONS' },
          { name: 'Access-Control-Allow-Headers', value: 'Content-Type, Authorization' }];
        if (event.request.method === 'OPTIONS') {
          await ctx.cdp.send('Fetch.fulfillRequest', { requestId: event.requestId,
            responseCode: 204, responseHeaders: headers }, sessionId);
          return;
        }
        requests.push({ url: event.request.url, body: JSON.parse(event.request.postData),
          authorization: event.request.headers.Authorization || event.request.headers.authorization });
        const answer = { ...output };
        const status = completionStatus;
        const fulfill = async () => {
          const result = await ctx.cdp.send('Fetch.fulfillRequest', { requestId: event.requestId,
            responseCode: 200, responseHeaders: [...headers, { name: 'Content-Type', value: 'application/json' }],
            body: Buffer.from(JSON.stringify({ status, output: [{ type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] })).toString('base64'),
          }, sessionId);
          return !result.__error && !result.__timeout;
        };
        if (holding) held.push(fulfill);
        else if (!await fulfill()) errors.push('Response interception failed');
      })().catch(() => errors.push('Request interception failed'));
    });
    const enabled = await ctx.cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    }, worker.sessionId);
    if (enabled.__error || enabled.__timeout) throw new Error('Worker interception unavailable');
    await ctx.page.navigate(`chrome-extension://${ctx.extension.id}/options.html`);
    const saved = await ctx.page.evaluate(`chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
      apiKey: 'sk-text-openai-synthetic', openrouterApiKey: 'sk-text-openrouter-synthetic',
      service: 'openai', model: 'text-openai-synthetic', reasoningEffort: 'low',
      targetLanguage: 'Korean', tone: 'technical' } })`);
    if (!saved?.ok) throw new Error('Synthetic settings unavailable');
    return {
      ctx, page: ctx.page, requests, errors,
      url: `chrome-extension://${ctx.extension.id}/text-translation.html`,
      setOutput(value, status = 'completed') { output = value; completionStatus = status; },
      hold(value = true) { holding = value; },
      async press(key) { await browser(['--session', session, 'press', key]); },
      async release({ keepHolding = false } = {}) {
        holding = keepHolding;
        for (const fulfill of held.splice(0)) await fulfill();
      },
      async ready(page = ctx.page) {
        return until(() => page.evaluate("Boolean(document.getElementById('btnTranslate') && !document.getElementById('btnTranslate').disabled)"), 5000, 100);
      },
      async click(id, page = ctx.page) {
        const point = await page.evaluate(`(() => {
          const element = document.getElementById(${JSON.stringify(id)});
          element.scrollIntoView({ block: 'center' });
          const rect = element.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await ctx.cdp.send('Input.dispatchMouseEvent', { type, ...point,
            button: 'left', clickCount: 1 }, page.sessionId);
        }
      },
      async close() {
        unsubscribe?.();
        ctx.cdp.close();
        await closeSessionBrowser(session);
      },
    };
  } catch (error) {
    unsubscribe?.();
    ctx.cdp.close();
    await closeSessionBrowser(session);
    throw error;
  }
}
