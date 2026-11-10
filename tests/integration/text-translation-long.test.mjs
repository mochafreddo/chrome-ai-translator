import { createChecks, until, wait } from './harness.mjs';
import { launchTextTranslationBrowser } from './text-translation-helper.mjs';

const { check, failures, finish } = createChecks('Long Text Translation');
let browser;
const first = 'A'.repeat(8000);
const second = '😀'.repeat(8000);
const source = `${first}\n\n${second}`;
try {
  browser = await launchTextTranslationBrowser();
  const { page, requests } = browser;
  await page.navigate(browser.url);
  if (check('independent translation page is ready', await browser.ready())) {
    browser.setOutput({ translation: '완료', sourceLanguage: 'English' });
    await page.evaluate(`(() => {
      document.getElementById('sourceText').value = ${JSON.stringify(source)};
      document.getElementById('btnTranslate').click();
    })()`);
    check('long text runs sequentially at paragraph boundaries without losing Unicode or separators',
      await until(() => requests.length === 2, 5000, 100) &&
      requests[0].body.input === `${first}\n\n` && requests[1].body.input === second);

    await browser.ready();
    browser.hold();
    browser.setOutput({ translation: '첫 번째', sourceLanguage: 'English' });
    await page.evaluate("document.getElementById('btnTranslate').click()");
    await until(() => requests.length === 3, 5000, 100);
    await wait(100);
    check('only one unit is in flight before its completed response', requests.length === 3);
    browser.setOutput({ translation: '버린 응답', sourceLanguage: 'English' });
    await browser.release({ keepHolding: true });
    check('completed prefix is visible while the second unit remains pending',
      await until(() => page.evaluate("document.getElementById('translatedText').value === '첫 번째\\n\\n'"), 5000, 100));
    await until(() => requests.length === 4, 5000, 100);
    await page.evaluate("document.getElementById('btnStop').click()");
    check('Stop retains the completed prefix and offers explicit resume', await page.evaluate(
      "document.getElementById('translatedText').value === '첫 번째\\n\\n' && !document.getElementById('btnResume')?.disabled && !document.getElementById('btnTranslate').disabled"));
    await browser.release();
    await wait(150);
    check('stopped late response cannot move progress or change the completed prefix', requests.length === 4 &&
      await page.evaluate("document.getElementById('translatedText').value === '첫 번째\\n\\n' && !document.getElementById('btnResume')?.disabled"));
    browser.setOutput({ translation: '나머지', sourceLanguage: 'English' });
    await page.evaluate("document.getElementById('btnResume')?.click()");
    check('explicit resume requests only the unfinished unit and keeps source order',
      await until(() => page.evaluate("document.getElementById('translatedText').value === '첫 번째\\n\\n나머지'"), 5000, 100) &&
      requests.length === 5 && requests[4].body.input === second &&
      requests.filter(request => request.body.input === `${first}\n\n`).length === 2);

    browser.hold();
    browser.setOutput({ translation: '보존한 앞부분', sourceLanguage: 'English' });
    await page.evaluate("document.getElementById('btnTranslate').click()");
    await until(() => requests.length === 6, 5000, 100);
    browser.setOutput({ translation: '잘린 뒷부분', sourceLanguage: 'English' }, 'incomplete');
    await browser.release({ keepHolding: true });
    await until(() => requests.length === 7, 5000, 100);
    await browser.release();
    check('truncated response leaves only completed parts and does not retry automatically',
      await until(() => page.evaluate("!document.getElementById('errorBox').hidden && !document.getElementById('btnResume').disabled"), 5000, 100) &&
      await page.evaluate("document.getElementById('translatedText').value === '보존한 앞부분\\n\\n'") && requests.length === 7);
    browser.setOutput({ translation: '다시 받은 뒷부분', sourceLanguage: 'English' });
    await page.evaluate("document.getElementById('btnResume').click()");
    check('explicit resume after truncation sends only the failed source unit',
      await until(() => page.evaluate("document.getElementById('translatedText').value === '보존한 앞부분\\n\\n다시 받은 뒷부분'"), 5000, 100) &&
      requests.length === 8 && requests[7].body.input === second);

    browser.hold();
    await page.evaluate("document.getElementById('btnTranslate').click()");
    await until(() => requests.length === 9, 5000, 100);
    await page.evaluate(`(() => {
      document.getElementById('btnStop').click();
      document.getElementById('tone').value = 'formal';
      document.getElementById('tone').dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('btnResume').click();
    })()`);
    check('changed effective settings disable resume without another provider request', requests.length === 9 &&
      await page.evaluate("document.getElementById('btnResume').disabled"));
    await browser.release();
    check('fixed provider interception remains fail-closed', browser.errors.length === 0);
  }
} catch (error) {
  failures.push('harness');
  console.error(`FAIL Long Text Translation - harness (${error.message})`);
} finally {
  await browser?.close();
  finish();
}
