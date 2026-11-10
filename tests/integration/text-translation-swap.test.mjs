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
      document.getElementById('sourceLanguage').value = ' auto ';
      document.getElementById('targetLanguage').value = 'Swahili';
      document.getElementById('sourceText').value = 'Unknown';
      document.getElementById('btnTranslate').click();
    })()`);
    check('padded automatic detection uses the same request and completes an uncertain result', await until(() => page.evaluate("document.getElementById('translatedText').value === '결과' && !document.getElementById('btnSwap').disabled"), 5000, 100) &&
      requests[2].body.instructions.includes('Detect the source language in this same request.'));
    await browser.click('btnSwap');
    check('uncertain detection asks for selection without sending', await page.evaluate("!document.getElementById('errorBox').hidden && document.activeElement.id === 'sourceLanguage' && document.getElementById('sourceText').value === 'Unknown'") && requests.length === 3);
    for (const language of ['   ', 'x'.repeat(201)]) {
      await page.evaluate(`document.getElementById('sourceLanguage').value = ${JSON.stringify(language)}`);
      await browser.click('btnSwap');
      check(`invalid manual source of length ${language.length} leaves both texts and target unchanged`,
        await page.evaluate("document.getElementById('sourceText').value === 'Unknown' && document.getElementById('translatedText').value === '결과' && document.getElementById('targetLanguage').value === 'Swahili' && !document.getElementById('errorBox').hidden && document.activeElement.id === 'sourceLanguage'") && requests.length === 3);
    }
    await page.evaluate(`(() => {
      const source = document.getElementById('sourceLanguage');
      source.value = ' Swahili '; source.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await browser.click('btnSwap');
    check('an arbitrary manual source choice permits swap without a detection request', await page.evaluate("document.getElementById('sourceText').value === '결과' && document.getElementById('sourceLanguage').value === 'Swahili' && document.getElementById('targetLanguage').value === 'Swahili'") && requests.length === 3);
    await wait(200);
    await page.navigate(browser.url);
    check('swapped language and result relationship survive reload', await browser.ready() && await page.evaluate("document.getElementById('sourceText').value === '결과' && document.getElementById('sourceLanguage').value === 'Swahili' && Boolean(document.getElementById('resultRelationship').textContent)") && requests.length === 3);
    for (const field of ['sourceLanguage', 'targetLanguage', 'model']) {
      const before = requests.length;
      const contents = await page.evaluate(`(() => {
        const input = document.getElementById(${JSON.stringify(field)});
        input.value += 'x'; input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
        return [document.getElementById('sourceText').value, document.getElementById('translatedText').value];
      })()`);
      await browser.press('Enter');
      await wait(300);
      const after = await page.evaluate("[document.getElementById('sourceText').value, document.getElementById('translatedText').value]");
      check(`ordinary Enter in ${field} does not translate`, requests.length === before && JSON.stringify(after) === JSON.stringify(contents));
    }
    for (const key of ['Enter', 'Space']) {
      const before = requests.length;
      await page.evaluate("document.getElementById('btnTranslate').focus()");
      await browser.press(key);
      check(`${key} activates the focused Translate button`, await until(() => requests.length === before + 1, 5000, 100) &&
        await until(() => page.evaluate("!document.getElementById('btnTranslate').disabled"), 5000, 100));
    }
    const beforeNewline = requests.length;
    await page.evaluate("(() => { const source = document.getElementById('sourceText'); source.focus(); source.setSelectionRange(source.value.length, source.value.length); })()");
    await browser.press('Enter');
    check('ordinary Enter in source inserts a newline without translating', requests.length === beforeNewline &&
      await page.evaluate("document.getElementById('sourceText').value === '결과\\n'"));
    check('fixed provider interception remains fail-closed', browser.errors.length === 0);
  }
} catch (error) {
  failures.push('harness');
  console.error(`FAIL Text Translation swap - harness (${error.message})`);
} finally {
  await browser?.close();
  finish();
}
