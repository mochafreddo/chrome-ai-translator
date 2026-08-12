// The API key half of the live check: getting a real key in, and getting it back out.
//
// Separate from harness.mjs because the harness is about driving a browser and knows
// nothing about what is being checked. This module knows one thing the harness must not:
// that a real secret is passing through, and that leaving it behind is the failure mode
// that matters most.
//
// Two rules shape it.
//
// The key is read here and handed only to the local CDP session. It is never a command
// argument, never printed, and never returned to a caller: withApiKey takes a callback so
// the value has no way out of this module. When the file has no key, the error names the
// keys it did see and never their values.
//
// Clearing is a `finally`, not a last step. Written as a step it runs only when everything
// before it passed -- which is exactly when it matters least. It also goes through the
// options page's own Clear key control rather than writing storage behind it, so the
// cleanup is itself a check that the control works. That control asks window.confirm
// first, which is why the harness can answer dialogs.

import { readFileSync } from 'node:fs';
import { until, wait } from './harness.mjs';

const PREFERRED_NAMES = ['OPENAI_API_KEY', 'OPENAI_KEY', 'OPENAI_SECRET_KEY', 'API_KEY'];

function readApiKey(envPath) {
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`no ${envPath} to read an OpenAI key from`);
  }
  const entries = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) entries.set(match[1], match[2].trim().replace(/^["']|["']$/g, ''));
  }
  for (const name of PREFERRED_NAMES) {
    const value = entries.get(name);
    if (value?.startsWith('sk-')) return { key: value, name };
  }
  for (const [name, value] of entries) {
    if (value.startsWith('sk-')) return { key: value, name };
  }
  // Names, never values.
  throw new Error(
    `no OpenAI key in ${envPath}; names present: ${[...entries.keys()].join(', ') || '(none)'}`
  );
}

async function storedSettings(page) {
  return page.evaluate('(async () => (await chrome.storage.local.get(["settings"])).settings || {})()');
}

// Saves a real key through the real options page, runs the callback, and clears the key
// again on the way out whatever happened. The callback is given what the options page
// stored -- with the key itself replaced by whether one is there.
//
// Whether the profile came out clean is reported through onCleared rather than returned:
// the clearing happens in a `finally`, which cannot speak to the caller through a return
// value, and it has to stay there.
export async function withApiKey({ page, extension, envPath, targetLanguage, onCleared }, run) {
  const { key, name } = readApiKey(envPath);
  console.log(`using the OpenAI key from ${envPath} under ${name} (value not shown)`);
  const optionsUrl = `chrome-extension://${extension.id}/options.html`;

  await page.navigate(optionsUrl);
  const saved = await page.evaluate(`(async () => {
    document.getElementById('apiKey').value = ${JSON.stringify(key)};
    document.getElementById('targetLanguage').value = ${JSON.stringify(targetLanguage)};
    const choice = document.querySelector('input[name="buttonVisibility"][value="onInvocation"]');
    if (choice) choice.checked = true;
    document.getElementById('btnSave').click();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stored = (await chrome.storage.local.get(['settings'])).settings || {};
    return {
      error: document.getElementById('errorBox').textContent || '',
      hasKey: typeof stored.apiKey === 'string' && stored.apiKey.startsWith('sk-'),
      targetLanguage: stored.targetLanguage || '',
      model: stored.model || '',
      buttonVisibility: stored.buttonVisibility || '',
    };
  })()`);

  try {
    return await run(saved);
  } finally {
    onCleared?.(await clearApiKey({ page, optionsUrl }));
  }
}

// Drives the real Clear key control, confirmation dialog and all, then confirms the key is
// gone. Returns whether the profile came out clean so the caller can check on it.
async function clearApiKey({ page, optionsUrl }) {
  const stopAnswering = page.answerDialogs(true);
  try {
    await page.navigate(optionsUrl);
    await page.evaluate("document.getElementById('btnClear').click(), true");
    await wait(500);
    return await until(async () => !(await storedSettings(page)).apiKey, 10000, 500);
  } catch {
    return false;
  } finally {
    stopAnswering();
  }
}
