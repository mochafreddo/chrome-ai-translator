import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { browser, launchExtensionBrowser, serveFixture, until } from './harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = `ui-${randomUUID().slice(0, 8)}`;
let ctx;
let fixture;
const nativeScrollChecks = [];

async function resize(width) {
  const result = await ctx.cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height: 900, deviceScaleFactor: 1, mobile: false,
  }, ctx.page.sessionId);
  assert.ok(!result.__error && !result.__timeout, 'Viewport changes succeed');
}

async function press(key, code, windowsVirtualKeyCode, modifiers = 0) {
  for (const type of ['rawKeyDown', 'keyUp']) {
    const result = await ctx.cdp.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode, modifiers }, ctx.page.sessionId);
    assert.ok(!result.__error && !result.__timeout, 'Keyboard input reaches the page');
  }
}

async function main() {
  fixture = await serveFixture(join(HERE, 'fixtures', 'inline-translation.html'));
  ctx = await launchExtensionBrowser({ session: SESSION, url: fixture.url,
    extensionDir: join(HERE, '..', '..', 'extension') });
  const optionsUrl = `chrome-extension://${ctx.extension.id}/options.html`;
  const init = await ctx.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    if (location.pathname !== '/options.html' || !chrome.storage?.local) return;
    const get = chrome.storage.local.get.bind(chrome.storage.local);
    let held = false;
    chrome.storage.local.get = (...args) => {
      if (held) return get(...args);
      held = true;
      return new Promise(resolve => { globalThis.releaseDiagnostics = () => resolve({}); });
    };
  })();` }, ctx.page.sessionId);
  await ctx.page.navigate(optionsUrl);
  assert.ok(await until(() => ctx.page.evaluate(`document.getElementById('targetLanguage').value === 'Korean'`), 10000));
  assert.ok(await until(() => ctx.page.evaluate(`typeof globalThis.releaseDiagnostics === 'function'`), 10000));
  await ctx.page.evaluate(`document.getElementById('btnSaveDiagnostics').focus(); globalThis.releaseDiagnostics();`);
  assert.ok(await until(() => ctx.page.evaluate(`document.getElementById('inlineDiagnostics').textContent === 'No inline diagnostics yet.'`), 10000));
  assert.equal(await ctx.page.evaluate(`document.activeElement.id`), 'btnSaveDiagnostics', 'Loading diagnostics never steals focus');
  await ctx.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: init.identifier }, ctx.page.sessionId);
  for (const text of ['No inline diagnostics yet.', 'One short diagnostic.', 'Diagnostic row.\n'.repeat(100)]) {
    await ctx.page.evaluate(`(() => {
      document.getElementById('inlineDiagnostics').textContent = ${JSON.stringify(text)};
      document.getElementById('btnSaveDiagnostics').focus();
    })()`);
    await press('Tab', 'Tab', 9);
    assert.deepEqual(await ctx.page.evaluate(`(() => {
      const logs = document.getElementById('inlineDiagnostics');
      return { focused: document.activeElement === logs, tabindex: logs.getAttribute('tabindex'),
        outline: getComputedStyle(logs).outlineStyle !== 'none' };
    })()`), { focused: true, tabindex: '0', outline: true });
    if (text.startsWith('Diagnostic row.')) {
      assert.ok(await ctx.page.evaluate(`(() => {
        const logs = document.getElementById('inlineDiagnostics');
        return logs.scrollHeight > logs.clientHeight;
      })()`), 'Long diagnostics overflow their bounded region');
      await press('ArrowDown', 'ArrowDown', 40);
      nativeScrollChecks.push(['ArrowDown', await until(() => ctx.page.evaluate(`document.getElementById('inlineDiagnostics').scrollTop > 0`), 3000, 50)]);
      const top = await ctx.page.evaluate(`document.getElementById('inlineDiagnostics').scrollTop`);
      await press('PageDown', 'PageDown', 34);
      nativeScrollChecks.push(['PageDown', await until(() => ctx.page.evaluate(`document.getElementById('inlineDiagnostics').scrollTop > ${top}`), 3000, 50)]);
    }
    await press('Tab', 'Tab', 9);
    assert.notEqual(await ctx.page.evaluate(`document.activeElement.id`), 'inlineDiagnostics', 'Tab exits diagnostics');
    await ctx.page.evaluate(`document.getElementById('inlineDiagnostics').focus()`);
    await press('Tab', 'Tab', 9, 8);
    assert.equal(await ctx.page.evaluate(`document.activeElement.id`), 'btnSaveDiagnostics', 'Shift+Tab exits diagnostics');
  }
  const documentNode = await ctx.cdp.send('DOM.getDocument', {}, ctx.page.sessionId);
  const logsNode = await ctx.cdp.send('DOM.querySelector', { nodeId: documentNode.root.nodeId, selector: '#inlineDiagnostics' }, ctx.page.sessionId);
  const accessible = await ctx.cdp.send('Accessibility.getPartialAXTree', { nodeId: logsNode.nodeId, fetchRelatives: false }, ctx.page.sessionId);
  assert.ok(accessible.nodes.some(node => node.role?.value === 'region' && node.name?.value === 'Inline diagnostics'), 'Diagnostics have an accessible name');
  console.log('PASS UI polish - diagnostic name keyboard focus and asynchronous focus preservation');
  for (const width of [240, 320, 460, 768, 1280]) {
    await resize(width);
    const layout = await ctx.page.evaluate(`(() => {
      document.getElementById('inlineDiagnostics').textContent = 'diagnostic'.repeat(500);
      const model = document.getElementById('model').getBoundingClientRect();
      const reasoning = document.getElementById('reasoningEffort').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth > innerWidth,
        sameRow: Math.abs(model.top - reasoning.top) < 1,
        hiddenService: document.getElementById('openrouterSettings').getBoundingClientRect().height === 0,
        choices: Array.from(document.querySelectorAll('.choice-label')).every(label =>
          label.getBoundingClientRect().height >= 44 && label.querySelector('input').getBoundingClientRect().width <= 20),
        measure: document.querySelector('.options').getBoundingClientRect().width };
    })()`);
    assert.equal(layout.overflow, false, `Options fit at ${width}px with long diagnostics`);
    assert.equal(layout.sameRow, width > 460, 'Model settings follow the responsive form grid');
    assert.equal(layout.hiddenService, true, 'Inactive service stays hidden');
    assert.equal(layout.choices, true, 'Compact radio indicators retain touch-sized labels');
    assert.ok(layout.measure <= 760, 'Options remain a readable width');
  }
  await ctx.page.evaluate(`(() => {
    const radio = document.querySelector('input[name="service"][value="openrouter"]');
    radio.click();
  })()`);
  assert.equal(await ctx.page.evaluate(`getComputedStyle(document.getElementById('openaiSettings')).display`), 'none');
  assert.notEqual(await ctx.page.evaluate(`getComputedStyle(document.getElementById('openrouterSettings')).display`), 'none');
  console.log('PASS UI polish - responsive Options and service switching');

  await ctx.page.navigate(`chrome-extension://${ctx.extension.id}/sidepanel.html`);
  await ctx.page.evaluate(`(() => {
    globalThis.uiTestState = { status: 'done', workerEpoch: 'ui-fixture', stateSequence: 1, bodyVersion: 1,
      extracted: { contentMarkdown: '<b>Bonjour.</b>', langHint: 'fr' },
      translated: '안녕하세요.', settingsUsed: { targetLanguage: 'Korean' } };
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.uiStateReads = 0;
    globalThis.uiOmittedReads = 0;
    chrome.runtime.sendMessage = message => {
      if (message.type !== 'GET_STATE') return send(message);
      globalThis.uiStateReads += 1;
      const state = { ...globalThis.uiTestState };
      if (message.knownBody?.workerEpoch === state.workerEpoch &&
          message.knownBody.bodyVersion === state.bodyVersion) {
        delete state.extracted; delete state.translated;
        globalThis.uiOmittedReads += 1;
      }
      return Promise.resolve({ ok: true, state });
    };
    document.getElementById('targetLanguage').value = 'Japanese';
  })()`);
  assert.ok(await until(() => ctx.page.evaluate(`document.getElementById('translated').textContent === '안녕하세요.'`), 10000));
  assert.deepEqual(await ctx.page.evaluate(`({
    source: document.getElementById('original').lang,
    translation: document.getElementById('translated').lang,
    safe: document.querySelector('#original b') === null,
  })`), { source: 'fr', translation: 'ko', safe: true });
  await ctx.page.evaluate(`(() => {
    document.getElementById('viewMode').value = 'bilingual';
    document.getElementById('viewMode').dispatchEvent(new Event('change'));
  })()`);
  assert.ok(await until(() => ctx.page.evaluate(`document.getElementById('translated').textContent.startsWith('Original')`), 10000));
  assert.deepEqual(await ctx.page.evaluate(`(() => {
    const output = document.getElementById('translated');
    return { text: output.textContent,
      source: output.querySelector('[lang="fr"]')?.textContent,
      translation: output.querySelector('[lang="ko"]')?.textContent,
      labels: Array.from(output.querySelectorAll('[lang="en"]')).map(node => node.textContent),
      safe: output.querySelector('b') === null };
  })()`), { text: 'Original\n\n<b>Bonjour.</b>\n\nTranslation\n\n안녕하세요.',
    source: '<b>Bonjour.</b>', translation: '안녕하세요.', labels: ['Original\n\n', '\n\nTranslation\n\n'], safe: true });
  console.log('PASS UI polish - content language boundaries and safe bilingual text');
  await ctx.page.evaluate(`(() => {
    const output = document.getElementById('translated');
    globalThis.uiSelectedNode = output.lastChild.firstChild;
    globalThis.uiOriginalNode = document.getElementById('original').firstChild;
    const range = document.createRange();
    range.setStart(globalThis.uiSelectedNode, 0);
    range.setEnd(globalThis.uiSelectedNode, 2);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    globalThis.uiReadTarget = globalThis.uiStateReads + 2;
  })()`);
  assert.ok(await until(() => ctx.page.evaluate(`globalThis.uiStateReads >= globalThis.uiReadTarget`), 10000, 100));
  assert.deepEqual(await ctx.page.evaluate(`({
    original: document.getElementById('original').firstChild === globalThis.uiOriginalNode,
    translated: document.getElementById('translated').lastChild.firstChild === globalThis.uiSelectedNode,
    selected: getSelection().toString(),
    anchor: getSelection().anchorNode === globalThis.uiSelectedNode,
    focus: getSelection().focusNode === globalThis.uiSelectedNode,
  })`), { original: true, translated: true, selected: '안녕', anchor: true, focus: true });
  console.log('PASS UI polish - repeated panel polling preserves text nodes and selection');
  assert.ok(await ctx.page.evaluate('uiOmittedReads > 0'), 'Unchanged polls acknowledge and omit owned bodies');
  await ctx.page.evaluate("document.getElementById('translated').textContent = 'external change'");
  assert.ok(await until(() => ctx.page.evaluate(`document.getElementById('translated').textContent ===
    'Original\\n\\n<b>Bonjour.</b>\\n\\nTranslation\\n\\n안녕하세요.'`), 5000, 100));
  assert.deepEqual(await ctx.page.evaluate(`({ source: document.getElementById('original').lang,
    translated: document.querySelector('#translated [lang="ko"]')?.textContent })`),
    { source: 'fr', translated: '안녕하세요.' });
  console.log('PASS UI polish - omitted bodies retain bilingual rendering and repair externally changed DOM');
  for (const width of [240, 320, 460, 768]) {
    await resize(width);
    assert.equal(await ctx.page.evaluate(`(() => {
      document.getElementById('errorBox').hidden = false;
      document.getElementById('errorBox').textContent = 'error'.repeat(200);
      document.getElementById('translated').textContent = '번역문'.repeat(500);
      return document.documentElement.scrollWidth > innerWidth;
    })()`), false, `Panel fits at ${width}px with long content and error`);
  }
  await ctx.page.evaluate(`document.getElementById('tab-translated').focus()`);
  for (const [key, selected] of [['ArrowRight', 'original'], ['ArrowRight', 'translated'],
    ['ArrowLeft', 'original'], ['Home', 'translated'], ['End', 'original']]) {
    await ctx.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key }, ctx.page.sessionId);
    const state = await ctx.page.evaluate(`(() => {
      const active = document.querySelector('[role="tab"][aria-selected="true"]');
      const panel = document.getElementById(active.getAttribute('aria-controls'));
      return { selected: active.dataset.tab, focused: document.activeElement === active,
        visible: !panel.hidden, stops: document.querySelectorAll('[role="tab"][tabindex="0"]').length };
    })()`);
    assert.deepEqual(state, { selected, focused: true, visible: true, stops: 1 });
  }
  console.log('PASS UI polish - panel overflow and keyboard tabs');

  await ctx.page.navigate(optionsUrl);
  await ctx.page.evaluate(`(() => {
    document.querySelector('input[name="buttonVisibility"][value="onInvocation"]').click();
    document.getElementById('btnSave').click();
  })()`);
  assert.ok(await until(() => ctx.page.evaluate(`document.getElementById('status').textContent === 'Saved.'`), 10000));
  await ctx.page.navigate(fixture.url);
  const invoked = await ctx.cdp.send('Extensions.triggerAction', { id: ctx.extension.id, targetId: ctx.tab.targetId });
  assert.ok(!invoked.__error && !invoked.__timeout, 'Toolbar action succeeds');
  assert.ok(await until(() => ctx.page.evaluate(`Boolean(document.getElementById('chrome-ai-translator-inline'))`), 10000));
  await resize(320);
  const tree = await ctx.cdp.send('DOM.getDocument', { depth: -1, pierce: true }, ctx.page.sessionId);
  const findHost = (node) => node.attributes?.some((value, index, attributes) =>
    value === 'id' && attributes[index + 1] === 'chrome-ai-translator-inline')
    ? node : (node.children || []).map(findHost).find(Boolean);
  const host = findHost(tree.root);
  assert.ok(host?.shadowRoots?.[0], 'Floating controls keep their closed shadow root');
  const resolved = await ctx.cdp.send('DOM.resolveNode', { nodeId: host.shadowRoots[0].nodeId }, ctx.page.sessionId);
  const objectId = resolved.object.objectId;
  const inspect = async (functionDeclaration) => {
    const result = await ctx.cdp.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration, returnByValue: true,
    }, ctx.page.sessionId);
    assert.ok(!result.exceptionDetails && !result.__error && !result.__timeout, 'Shadow inspection succeeds');
    return result.result.value;
  };
  const toggle = await inspect(`function() {
    const box = this.querySelector('[data-role="toggle"]').getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }`);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await ctx.cdp.send('Input.dispatchMouseEvent', { type, ...toggle, button: 'left', clickCount: 1 }, ctx.page.sessionId);
  }
  assert.ok(await until(() => inspect(`function() { return !this.querySelector('[data-role="menu"]').hidden; }`), 10000));
  const floating = await inspect(`function() {
    const menu = this.querySelector('[data-role="menu"]');
    const button = menu.querySelector('button');
    button.textContent = 'Translate a page in a language with a longer name';
    const box = this.host.getBoundingClientRect();
    return { inside: box.left >= 0 && box.right <= innerWidth,
      target: button.getBoundingClientRect().height >= 44,
      font: getComputedStyle(button).fontFamily === getComputedStyle(this.querySelector('[data-role="container"]')).fontFamily,
      flat: getComputedStyle(button).boxShadow === 'none' };
  }`);
  assert.deepEqual(floating, { inside: true, target: true, font: true, flat: true });
  console.log('PASS UI polish - floating controls fit with consistent typography');
  for (const [key, scrolled] of nativeScrollChecks) {
    assert.ok(scrolled, `${key} scrolls long diagnostics through native browser behavior`);
  }
  console.log('PASS UI polish - native diagnostic keyboard scrolling');
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  ctx?.close();
  fixture?.close();
  await browser(['--session', SESSION, 'close']);
}
