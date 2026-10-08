const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { getInlineContentScriptFiles } = require('../extension/background');

// A page adapter loads the shipped classic scripts and reaches only DOM controls and
// runtime messages. It shares the operation tests' controlled browser services.
function createContentPage(fixture) {
  const { document } = fixture;
  const runtimeListeners = [];
  let startupRequests = 0;
  const shadows = [];
  const createElement = document.createElement.bind(document);
  document.createElement = tag => {
    const node = createElement(tag);
    node.style = {};
    node.remove = () => node.parentNode?.removeChild(node);
    node.attachShadow = () => {
      const controls = new Map();
      const shadow = {
        set innerHTML(html) {
          for (const match of html.matchAll(/<(button|div)[^>]*data-(role|action)="([^"]+)"[^>]*>/g)) {
            const control = createElement(match[1]);
            const events = new Map();
            control.addEventListener = (type, callback) => events.set(type, callback);
            control.click = (isTrusted = true) => events.get('click')?.({ isTrusted });
            controls.set(`[data-${match[2]}="${match[3]}"]`, control);
          }
        },
        querySelector: selector => controls.get(selector),
      };
      shadows.push(shadow);
      return shadow;
    };
    return node;
  };
  document.getElementById = id => document.body.childNodes.find(node => node.id === id) || null;
  document.querySelector = () => document.body;
  const page = vm.createContext({
    ...fixture.platform,
    crypto: globalThis.crypto,
    chrome: { runtime: {
      onMessage: { addListener: callback => runtimeListeners.push(callback) },
      sendMessage(message) {
        if (message.type === 'GET_INLINE_STARTUP_INSTRUCTIONS') {
          startupRequests += 1;
          return Promise.resolve({ ok: true, instructions: [] });
        }
        return fixture.adapters.sendMessage(message);
      },
    } },
  });
  function inject() {
    for (const file of getInlineContentScriptFiles()) vm.runInContext(
      fs.readFileSync(path.join(__dirname, '..', 'extension', file), 'utf8'), page,
      { filename: file }
    );
  }
  function message(value) {
    let response;
    for (const listener of runtimeListeners) listener(value, {}, reply => { response = reply; });
    return response ? JSON.parse(JSON.stringify(response)) : undefined;
  }
  return {
    inject, message,
    instruct: instruction => message({ type: 'RUN_INLINE_INSTRUCTION', instruction }),
    snapshot: () => message({ type: 'GET_INLINE_TRANSLATION_STATE' }).snapshot,
    button: action => shadows.at(-1).querySelector(`[data-action="${action}"]`),
    toggle: () => shadows.at(-1).querySelector('[data-role="toggle"]'),
    listenerCount: () => runtimeListeners.length,
    startupCount: () => startupRequests,
  };
}
module.exports = { createContentPage };
