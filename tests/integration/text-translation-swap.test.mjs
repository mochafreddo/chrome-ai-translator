import { createChecks, until, wait } from './harness.mjs';
import { launchTextTranslationBrowser } from './text-translation-helper.mjs';

const { check, failures, finish } = createChecks('Text Translation swap');
let browser;
try {
  browser = await launchTextTranslationBrowser();
  const { page, requests } = browser;
  await page.navigate(browser.url);
  if (check('page is ready', await browser.ready())) {
    browser.setOutput({ translation: '안녕', sourceLanguage: 'English' });
    await page.evaluate(`(() => {
      const source = document.getElementById('sourceText');
      source.value = 'Hello'; source.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('btnTranslate').click();
    })()`);
    check('translation completes', await until(() => page.evaluate("document.getElementById('translatedText').value === '안녕' && !document.getElementById('btnSwap').disabled"), 5000, 100));
    await page.evaluate(`(() => {
      const target = document.getElementById('targetLanguage');
      target.value = 'Japanese'; target.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    check('edited settings mark the result as previous', await page.evaluate("Boolean(document.getElementById('resultRelationship').textContent) && document.getElementById('translatedText').getAttribute('aria-describedby').includes('resultRelationship')"));
    await browser.click('btnSwap');
    check('swap uses the result snapshot and makes no request', await page.evaluate(`
      document.getElementById('sourceText').value === '안녕' &&
      document.getElementById('sourceLanguage').value === 'Korean' &&
      document.getElementById('targetLanguage').value === 'English' &&
      document.getElementById('translatedText').value === '안녕' &&
      Boolean(document.getElementById('resultRelationship').textContent)`) && requests.length === 1);
    await page.evaluate("document.getElementById('sourceText').focus()");
    browser.hold();
    await browser.press('Control+Enter');
    check('keyboard starts the swapped source and clears old result', await until(() => requests.length === 2, 5000, 100) &&
      requests[1].body.input === '안녕' && requests[1].body.instructions.includes('source language is Korean') &&
      requests[1].body.instructions.includes('into English') && await page.evaluate("document.getElementById('translatedText').value === '' && document.getElementById('btnSwap').disabled"));
    await browser.click('btnStop');
    await browser.release();
    await wait(100);
    check('stopped incomplete work cannot be swapped', await page.evaluate("document.getElementById('btnSwap').disabled && document.getElementById('translatedText').value === ''"));

    browser.setOutput({ translation: '결과', sourceLanguage: null });
    await page.evaluate(`(() => {
      document.getElementById('sourceLanguage').value = 'auto';
      document.getElementById('targetLanguage').value = 'Swahili';
      document.getElementById('sourceText').value = 'Unknown';
      document.getElementById('btnTranslate').click();
    })()`);
    check('uncertain result completes', await until(() => page.evaluate("document.getElementById('translatedText').value === '결과' && !document.getElementById('btnSwap').disabled"), 5000, 100));
    await browser.click('btnSwap');
    check('uncertain detection asks for selection without sending', await page.evaluate("!document.getElementById('errorBox').hidden && document.activeElement.id === 'sourceLanguage' && document.getElementById('sourceText').value === 'Unknown'") && requests.length === 3);
    await page.evaluate(`(() => {
      const source = document.getElementById('sourceLanguage');
      source.value = 'English'; source.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await browser.click('btnSwap');
    check('manual choice permits swap without a detection request', await page.evaluate("document.getElementById('sourceText').value === '결과' && document.getElementById('sourceLanguage').value === 'Swahili' && document.getElementById('targetLanguage').value === 'English'") && requests.length === 3);
    await wait(200);
    await page.navigate(browser.url);
    check('swapped language and result relationship survive reload', await browser.ready() && await page.evaluate("document.getElementById('sourceText').value === '결과' && document.getElementById('sourceLanguage').value === 'Swahili' && Boolean(document.getElementById('resultRelationship').textContent)") && requests.length === 3);
    check('fixed provider interception remains fail-closed', browser.errors.length === 0);
  }
} catch (error) {
  failures.push('harness');
  console.error(`FAIL Text Translation swap - harness (${error.message})`);
} finally {
  await browser?.close();
  finish();
}
