// The API key half of the live check: getting a real key in, and getting it back out.
//
// Separate from harness.mjs because the harness is about driving a browser and knows
// nothing about what is being checked. This module knows one thing the harness must not:
// that a real secret is passing through, and that leaving it behind is the failure mode
// that matters most.
//
// Three rules shape it.
//
// The key must belong to the provider the run will send it to, and the name it is stored
// under is the only evidence of that there is. See PROVIDER and PROVIDER_KEY_NAMES below.
//
// The key is read here and handed only to the local CDP session. It is never a command
// argument, never printed, and never returned to a caller: withApiKey takes a callback so
// the value has no way out of this module. When the file has no key it can attribute, the
// error names the keys it did see and never their values.
//
// Clearing is a `finally`, not a last step, and the save is inside the `try` it belongs to.
// Written as a step the clearing runs only when everything before it passed -- which is
// exactly when it matters least -- and a save left outside the `try` can put a real key in
// the profile on a path that never reaches the cleanup at all. It also goes through the
// options page's own Clear key control rather than writing storage behind it, so the
// cleanup is itself a check that the control works. That control asks window.confirm
// first, which is why the harness can answer dialogs.

import { readFileSync } from 'node:fs';
import { until, wait } from './harness.mjs';

// The provider this run sends the key to. The extension posts to api.openai.com and asks for
// no other host in its manifest, so an OpenAI key is the only key that may be handed to it.
const PROVIDER = 'OpenAI';

// The names that say a key is OpenAI's. Selection is by name and by nothing else: `sk-` is
// also the start of Anthropic's `sk-ant-`, so a value is no evidence of whose key it is, and
// a check on the value would only move this bug rather than fix it. Using a key stored under
// a name that is not here is a one-line addition to this list -- and stays a decision about
// which provider a name belongs to. Deliberately absent: API_KEY, which names no provider.
const PROVIDER_KEY_NAMES = ['OPENAI_API_KEY', 'OPENAI_KEY', 'OPENAI_SECRET_KEY'];

// Which entry the run will take its key from -- the name, never the value. This is the half
// of the selection a check can be shown: readApiKey itself stays unexported, because a value
// a caller can ask for is a value with a way out of this module.
export function apiKeyName(envPath) {
  return readApiKey(envPath).name;
}

function readApiKey(envPath) {
  let text;
  try {
    text = readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`no ${envPath} to read an ${PROVIDER} key from`);
  }
  const entries = new Map();
  for (const line of text.split('\n')) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (match) entries.set(match[1], match[2].trim().replace(/^["']|["']$/g, ''));
  }
  for (const name of PROVIDER_KEY_NAMES) {
    const value = entries.get(name);
    if (value) return { key: value, name };
  }
  // Names, never values -- of the names it wants as much as of the names it found, so the fix
  // is a line in the file rather than a hunt through this module.
  throw new Error(
    `no ${PROVIDER} key in ${envPath}. A key is taken by name: one of ` +
      `${PROVIDER_KEY_NAMES.join(', ')}, with a value. ` +
      `Names present: ${[...entries.keys()].join(', ') || '(none)'}`
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
  console.log(`using the ${PROVIDER} key from ${envPath} under ${name} (value not shown)`);
  const optionsUrl = `chrome-extension://${extension.id}/options.html`;

  // The `try` opens before the save, not after it. The save is the step that puts the real key
  // in the browser profile, so a throw anywhere from here on -- including inside the save
  // itself, which may have stored the key before failing -- has to reach the `finally`.
  try {
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

    return await run(saved);
  } finally {
    onCleared?.(await clearApiKey({ page, optionsUrl }));
  }
}

// Drives the real Clear key control, confirmation dialog and all, then confirms the key is
// gone. Returns whether the profile came out clean so the caller can check on it.
//
// Reached even when the save failed, which is the point of it being in a `finally`: a profile
// the key never got into reads as clean here, and one it did get into is cleared whether or
// not anything after the save ran.
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
