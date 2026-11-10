import { createChecks, until, wait } from './harness.mjs';
import { launchTextTranslationBrowser } from './text-translation-helper.mjs';

const { check, failures, finish } = createChecks('Text Translation');
let browser;
const SOURCE = '<b>Hello</b>\n\nSecond paragraph';
const TRANSLATION = '<b>안녕하세요</b>\n\n두 번째 문단';
try {
  browser = await launchTextTranslationBrowser();
  const { page, requests } = browser;
  await page.navigate(browser.url);
  if (check('bookmark URL opens a ready independent page', await browser.ready())) {
    await page.evaluate(`(() => {
      const source = document.getElementById('sourceText');
      source.value = ${JSON.stringify(SOURCE)};
      source.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(100);
    check('page opening and input send no requests', requests.length === 0);
    await page.evaluate("document.getElementById('btnTranslate').click()");
    check('explicit execution displays a plain text result', await until(() => page.evaluate(
      `document.getElementById('translatedText').value === ${JSON.stringify(TRANSLATION)}`), 5000, 100));
    check('source snapshot reaches one model request', requests.length === 1 &&
      requests[0].body.input === '<b>Hello</b>\n\nSecond paragraph' &&
      requests[0].url === 'https://api.openai.com/v1/responses' &&
      requests[0].body.model === 'text-openai-synthetic');
    const permission = await browser.ctx.cdp.send('Browser.grantPermissions', {
      origin: `chrome-extension://${browser.ctx.extension.id}`,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
    check('disposable browser permits the synthetic clipboard round-trip', !permission.__error && !permission.__timeout);
    await browser.click('btnCopy');
    await until(() => page.evaluate("document.getElementById('status').textContent === 'Copied.'"), 3000, 100);
    const copied = await page.evaluate(`navigator.clipboard.readText().catch(error => ({ error: error.name }))`);
    if (copied !== TRANSLATION) console.error('DIAGNOSTIC copy', JSON.stringify(await page.evaluate(`({
      focused: document.hasFocus(), status: document.getElementById('status').textContent,
      error: document.getElementById('errorBox').hidden ? null : document.getElementById('errorBox').textContent,
      clipboard: Boolean(navigator.clipboard),
    })`)), typeof copied);
    check('copy preserves plain text and paragraphs', copied === '<b>안녕하세요</b>\n\n두 번째 문단');
    check('markup stays inert', await page.evaluate("document.querySelectorAll('b, script:not([src])').length === 0"));

    await page.evaluate(`(() => {
      document.getElementById('service').value = 'openrouter';
      document.getElementById('service').dispatchEvent(new Event('change'));
      document.getElementById('sourceLanguage').value = 'English';
      document.getElementById('targetLanguage').value = 'Japanese';
      document.getElementById('tone').value = 'formal';
      document.getElementById('sourceText').dispatchEvent(new Event('paste'));
    })()`);
    const local = await page.evaluate(`chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })`);
    check('page settings stay local and do not send a model request', requests.length === 1 &&
      local.settings.service === 'openai' && local.settings.targetLanguage === 'Korean');
    await page.evaluate("document.getElementById('btnSaveDefaults').click()");
    await until(() => page.evaluate("document.getElementById('status').textContent === 'Defaults saved.'"), 3000, 100);
    const defaults = await page.evaluate(`chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })`);
    check('explicit default save preserves OpenAI preferences and omits page-only language',
      requests.length === 1 && defaults.settings.service === 'openrouter' &&
      defaults.settings.targetLanguage === 'Japanese' && defaults.settings.tone === 'formal' &&
      defaults.settings.model === 'text-openai-synthetic' && defaults.settings.reasoningEffort === 'low' &&
      !Object.hasOwn(defaults.settings, 'sourceLanguage'));

    await page.evaluate(`(() => {
      const input = document.getElementById('sourceText');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    })()`);
    await wait(100);
    check('IME confirmation and ordinary Enter do not execute', requests.length === 1);

    browser.hold();
    await page.evaluate("document.getElementById('sourceText').focus()");
    await browser.press('Control+Enter');
    check('native Ctrl+Enter starts one explicit request', await until(() => requests.length === 2, 5000, 100));
    const locked = await page.evaluate(`({ source: document.getElementById('sourceText').disabled,
      settings: document.getElementById('translationSettings').disabled,
      button: document.getElementById('btnTranslate').disabled })`);
    check('source, settings and duplicate execution lock during a request', locked.source && locked.settings && locked.button);
    await page.evaluate(`(async () => {
      document.getElementById('btnTranslate').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
      await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: {
        service: 'openai', model: 'external-model', targetLanguage: 'French', tone: 'natural' } });
    })()`);
    check('provider snapshot survives external defaults and duplicate gestures', requests.length === 2 &&
      requests[1].url === 'https://openrouter.ai/api/v1/responses' &&
      requests[1].body.model === 'deepseek/deepseek-v4.1-flash-1017' &&
      requests[1].body.reasoning.effort === 'none' &&
      requests[1].body.instructions.includes('Japanese') &&
      requests[1].body.instructions.includes('source language is English') &&
      requests[1].body.instructions.includes('formal') &&
      requests[1].body.provider.data_collection === 'deny' && requests[1].body.provider.zdr === true &&
      requests[1].authorization === 'Bearer sk-text-openrouter-synthetic');
    await page.evaluate("document.getElementById('btnStop').click()");
    check('Stop restores editing', await browser.ready());
    await browser.release();
    await wait(200);
    check('late stopped response cannot replace text or status', await page.evaluate(
      "document.getElementById('translatedText').value === '' && document.getElementById('status').textContent === 'Stopped.' && document.getElementById('errorBox').hidden"));

    browser.hold();
    await page.evaluate("document.getElementById('btnTranslate').click()");
    await until(() => requests.length === 3, 5000, 100);
    await page.evaluate("document.getElementById('btnClear').click()");
    check('Clear all removes input and result during a request', await page.evaluate(
      "document.getElementById('sourceText').value === '' && document.getElementById('translatedText').value === ''"));
    browser.hold(false);
    browser.setOutput({ translation: '新しい結果', sourceLanguage: null });
    await page.evaluate(`(() => {
      document.getElementById('sourceLanguage').value = 'auto';
      document.getElementById('sourceText').value = 'New source';
      document.getElementById('btnTranslate').click();
    })()`);
    check('a new job completes after Clear all', await until(() => page.evaluate(
      "document.getElementById('translatedText').value === '新しい結果'"), 5000, 100));
    await browser.release();
    await wait(200);
    check('old response cannot overwrite the newer job', await page.evaluate(
      "document.getElementById('translatedText').value === '新しい結果' && document.getElementById('errorBox').hidden"));
    check('uncertain detection is not presented as a known language', await page.evaluate(
      "!document.getElementById('languageStatus').textContent.includes('Detected source language:')"));
    check('no retry or separate language detection request occurs', requests.length === 4);

    const beforeInvalid = requests.length;
    await page.evaluate(`(() => {
      document.getElementById('sourceText').value = '😀'.repeat(12001);
      document.getElementById('btnTranslate').click();
    })()`);
    check('over-limit source is refused intact before transport', await page.evaluate(
      "!document.getElementById('errorBox').hidden && Array.from(document.getElementById('sourceText').value).length === 12001 && document.getElementById('translatedText').value === '新しい結果'") && requests.length === beforeInvalid);

    for (const width of [1280, 375]) {
      await browser.ctx.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 900,
        deviceScaleFactor: 1, mobile: false }, page.sessionId);
      const layout = await page.evaluate(`(() => {
        const source = document.getElementById('sourceText').getBoundingClientRect();
        const result = document.getElementById('translatedText').getBoundingClientRect();
        return { source: { x: source.x, y: source.y, width: source.width },
          result: { x: result.x, y: result.y, width: result.width },
          overflow: document.documentElement.scrollWidth > innerWidth };
      })()`);
      check(`${width}px comparison remains readable without horizontal overflow`, !layout.overflow &&
        layout.source.width > 250 && layout.result.width > 250 &&
        (width > 700 ? Math.abs(layout.source.y - layout.result.y) < 2 && layout.result.x > layout.source.x : layout.result.y > layout.source.y));
    }
    check('fixed provider interception remains fail-closed', browser.errors.length === 0);
    await page.evaluate("document.getElementById('sourceText').focus()");
    await browser.ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9 }, page.sessionId);
    await browser.ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab',
      windowsVirtualKeyCode: 9 }, page.sessionId);
    check('keyboard focus reaches the read-only translation', await page.evaluate(
      "document.activeElement.id === 'translatedText'"));

    await page.navigate(`chrome-extension://${browser.ctx.extension.id}/sidepanel.html`);
    await browser.click('openTextTranslation');
    await until(() => browser.ctx.findTarget(value => value.url === browser.url), 5000, 100);
    const target = await browser.ctx.findTarget(value => value.url === browser.url);
    check('side panel entry opens the bookmarkable page in a separate tab', Boolean(target));
    if (target) {
      const opened = await browser.ctx.attach(target.id);
      check('side panel entry reaches the initialized page without requesting a model',
        await browser.ready(opened) && requests.length === beforeInvalid);
    }
  }
} catch (error) {
  failures.push('harness');
  console.error(`FAIL Text Translation - harness (${error.message})`);
} finally {
  await browser?.close();
  finish();
}
