import assert from 'node:assert/strict';
import { createChecks, until, wait } from './harness.mjs';
import { launchTextTranslationBrowser } from './text-translation-helper.mjs';

const { check, failures, finish } = createChecks('Text Translation retention');
let browser;
try {
  browser = await launchTextTranslationBrowser();
  const { page, worker, ctx, requests } = browser;
  await worker.evaluate(`globalThis.retentionNavigationEvents = [];
    chrome.webNavigation.onCommitted.addListener(details => {
      if (details.frameId === 0) globalThis.retentionNavigationEvents.push({ tabId: details.tabId, documentId: details.documentId });
    });`);
  await page.navigate(browser.url);
  if (!await browser.ready()) throw new Error('Translation page unavailable: ' +
    JSON.stringify(await page.evaluate(`(async () => {
      const tab = await chrome.tabs.getCurrent();
      let frame;
      try { frame = await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }); }
      catch (error) { frame = { error: error.message }; }
      return { message: document.getElementById('errorBox')?.textContent, frame,
        response: await chrome.runtime.sendMessage({ type: 'GET_TEXT_TRANSLATION_STATE' }),
        contexts: await chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [tab.id] }) };
    })()`)));
  const tabId = await page.evaluate('chrome.tabs.getCurrent().then(tab => tab.id)');
  const documentId = await page.evaluate(`chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [${tabId}] }).then(contexts => contexts[0]?.documentId)`);
  const save = async value => page.evaluate(`(() => {
    document.getElementById('sourceText').value = ${JSON.stringify(value)};
    document.getElementById('sourceText').dispatchEvent(new Event('input', { bubbles: true }));
    return chrome.runtime.sendMessage({ type: 'GET_TEXT_TRANSLATION_STATE' });
  })()`);
  await save('Retained draft');
  await page.evaluate(`document.getElementById('targetLanguage').value = 'Japanese';
    document.getElementById('targetLanguage').dispatchEvent(new Event('change', { bubbles: true }));`);
  await page.navigate(browser.url);
  check('idle draft and page settings survive a real reload without a request', await browser.ready() &&
    await page.evaluate("document.getElementById('sourceText').value === 'Retained draft' && document.getElementById('targetLanguage').value === 'Japanese'") && requests.length === 0);
  check('native extension context identifies a new document after reload',
    await page.evaluate(`chrome.runtime.getContexts({ contextTypes: ['TAB'], tabIds: [${tabId}] }).then(contexts => contexts.length === 1 && contexts[0].frameId === 0 && contexts[0].documentUrl === ${JSON.stringify(browser.url)} && contexts[0].documentId !== ${JSON.stringify(documentId)})`));
  console.log('INFO Text Translation retention - extension onCommitted events: ' +
    await worker.evaluate(`globalThis.retentionNavigationEvents.filter(event => event.tabId === ${tabId}).length`));

  const first = 'A'.repeat(8000) + '\n\n';
  const second = 'B'.repeat(8000);
  await save(first + second);
  browser.setOutput({ translation: '앞부분', sourceLanguage: 'English' });
  browser.hold();
  await page.evaluate("document.getElementById('btnTranslate').click()");
  await until(() => requests.length === 1, 5000, 100);
  browser.setOutput({ translation: '오래된 응답', sourceLanguage: 'English' });
  await browser.release({ keepHolding: true });
  await until(() => requests.length === 2, 5000, 100);
  await page.navigate(browser.url);
  check('reload interrupts running work and restores only the completed prefix', await browser.ready() &&
    await page.evaluate("document.getElementById('translatedText').value === '앞부분\\n\\n' && !document.getElementById('btnResume').disabled && document.getElementById('btnStop').disabled"));
  await browser.release();
  await wait(150);
  check('reload and late delivery issue no automatic or duplicate request', requests.length === 2 &&
    await page.evaluate("document.getElementById('translatedText').value === '앞부분\\n\\n'"));
  browser.setOutput({ translation: '나머지', sourceLanguage: 'English' });
  await page.evaluate("document.getElementById('btnResume').click()");
  check('explicit restored resume requests only unfinished source using the original effective settings',
    await until(() => page.evaluate("document.getElementById('translatedText').value === '앞부분\\n\\n나머지' && !document.getElementById('btnTranslate').disabled"), 5000, 100) &&
    requests.length === 3 && requests[2].body.input === second && requests[0].body.input === first &&
    requests[2].body.model === 'text-openai-synthetic' && requests[2].body.instructions.includes('Japanese'));
  await page.navigate(browser.url);
  check('completed result survives reload', await browser.ready() &&
    await page.evaluate("document.getElementById('translatedText').value === '앞부분\\n\\n나머지' && document.getElementById('btnResume').disabled") && requests.length === 3);
  const retainedPrivacy = await worker.evaluate(`chrome.storage.session.get(null).then(value => {
    const serialized = JSON.stringify(value);
    return { containsReaderData: serialized.includes('A'.repeat(8000)) && serialized.includes('앞부분'),
      containsCredential: serialized.includes('sk-text-openai-synthetic') || serialized.includes('sk-text-openrouter-synthetic') };
  })`);
  check('whole session storage contains the retained source and result', retainedPrivacy.containsReaderData);
  assert.equal(retainedPrivacy.containsCredential, false, 'Retained session storage contains a credential');
  await worker.evaluate("chrome.storage.session.set({ retentionSentinel: 'Unrelated session state survives' })");

  for (const status of ['stopped', 'failed']) {
    const before = requests.length;
    browser.hold();
    browser.setOutput({ translation: '보존한 부분', sourceLanguage: 'English' });
    await page.evaluate("document.getElementById('btnTranslate').click()");
    await until(() => requests.length === before + 1, 5000, 100);
    browser.setOutput({ translation: '미완료', sourceLanguage: 'English' }, 'incomplete');
    await browser.release({ keepHolding: true });
    await until(() => requests.length === before + 2, 5000, 100);
    if (status === 'stopped') await page.evaluate("document.getElementById('btnStop').click()");
    await browser.release();
    await browser.ready();
    await page.navigate(browser.url);
    check(`${status} work reloads with its completed prefix and no new request`, await browser.ready() &&
      await page.evaluate("document.getElementById('translatedText').value === '보존한 부분\\n\\n' && !document.getElementById('btnResume').disabled") && requests.length === before + 2);
  }
  browser.setOutput({ translation: '나머지', sourceLanguage: 'English' });

  await page.evaluate('chrome.tabs.duplicate(' + tabId + ')');
  const duplicateTarget = await ctx.findTarget(target => target.type === 'page' && target.id !== ctx.pageTarget.id && target.url === browser.url);
  if (!duplicateTarget) throw new Error('Duplicated translation tab unavailable');
  const duplicate = await ctx.attach(duplicateTarget.id);
  check('native tab duplication starts a separate empty translation', await browser.ready(duplicate) &&
    await duplicate.evaluate("document.getElementById('sourceText').value === '' && document.getElementById('translatedText').value === ''"));
  await duplicate.evaluate(`document.getElementById('sourceText').value = 'Other tab';
    document.getElementById('sourceText').dispatchEvent(new Event('input', { bubbles: true }));`);
  browser.hold();
  const duplicateRequest = requests.length + 1;
  await duplicate.evaluate("document.getElementById('btnTranslate').click()");
  await until(() => requests.length === duplicateRequest, 5000, 100);
  await page.evaluate("document.getElementById('btnClear').click()");
  await page.navigate(browser.url);
  check('Clear deletes only its tab and reload cannot restore cleared input or result', await browser.ready() &&
    await page.evaluate("document.getElementById('sourceText').value === '' && document.getElementById('translatedText').value === ''"));
  await browser.release();
  check('another tab Clear does not cancel the current tab request',
    await until(() => duplicate.evaluate("document.getElementById('translatedText').value === '나머지'"), 5000, 100) && requests.length === duplicateRequest);
  await save('Surviving first-tab draft');

  const duplicateId = await duplicate.evaluate('chrome.tabs.getCurrent().then(tab => tab.id)');
  await page.evaluate(`chrome.tabs.remove(${duplicateId})`);
  check('tab close removes its retained data instead of keeping a hidden history',
    await until(() => worker.evaluate(`chrome.storage.session.get(null).then(value => {
      const serialized = JSON.stringify(value);
      return !serialized.includes('Other tab') && !serialized.includes('나머지') &&
        serialized.includes('Surviving first-tab draft') && value.retentionSentinel === 'Unrelated session state survives';
    })`), 5000, 100));
  await save('Delete pending translation');
  browser.hold();
  const pendingRequest = requests.length + 1;
  await page.evaluate("document.getElementById('btnTranslate').click()");
  await until(() => requests.length === pendingRequest, 5000, 100);
  await page.evaluate("document.getElementById('btnClear').click()");
  await page.navigate(browser.url);
  await browser.ready();
  await browser.release();
  await page.navigate(browser.url);
  check('Clear during a request prevents late delivery and later reload from reviving the job',
    await browser.ready() && requests.length === pendingRequest &&
    await page.evaluate("document.getElementById('sourceText').value === '' && document.getElementById('translatedText').value === '' && document.getElementById('btnResume').disabled"));
  check('scoped Clear preserves unrelated session storage', await worker.evaluate(`chrome.storage.session.get(null)
    .then(value => value.retentionSentinel === 'Unrelated session state survives')`));
  check('fixed provider interception remains fail-closed', browser.errors.length === 0);
} catch (error) {
  failures.push('harness');
  console.error(`FAIL Text Translation retention - harness (${error.message})`);
} finally {
  await browser?.close();
  finish();
}
