// The live check's key handling, checked without a browser and without a real key.
//
// live-key.mjs is the one module whose job is that a real secret passing through it goes to
// the right provider and does not stay behind. Both of those are properties of plain
// functions, so they are checkable here rather than only inside a billed run -- which is the
// only place they were checkable before.
//
// Nothing here asks the module for a key value: the only thing it exports about selection is
// the name, and what the module typed into the options page is read back out of the page it
// was handed. A check that could print the key would be the leak it is checking for.
//
// The module is ESM and this suite is CommonJS, so it comes in through a dynamic import.
// Importing it pulls in harness.mjs, which does nothing at import time: no browser is
// launched, nothing is spawned, and `npm test` stays browser-free. That is the condition on
// this check living in this tier -- see tests/README.md.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const path = require('node:path');

const liveKey = () => import('./integration/live-key.mjs');

// Values that are obviously not keys, but are shaped like them. `sk-ant-` is the point of the
// foreign-key checks: it satisfies any test on the value that `sk-` would.
const OPENAI_SHAPED = 'sk-notarealkey000';
const ANTHROPIC_SHAPED = 'sk-ant-notarealkey000';
const OPENROUTER_SHAPED = 'sk-or-notarealkey000';

function withEnvFile(contents, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-ai-translator-live-key-'));
  const envPath = path.join(dir, '.env.local');
  fs.writeFileSync(envPath, contents);
  try {
    return fn(envPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Stands in for the CDP page. Keeps every expression it was asked to evaluate, so what the
// module typed into the options page is checkable from the page's side rather than from the
// module's; and lets the save fail on demand, so the clearing can be checked on the path
// where nothing after the save ran.
function fakePage({ failSave = false, service = 'openai', remaining = {} } = {}) {
  const driven = [];
  const evaluated = [];
  const cleanupResults = [];
  let stored = {};
  return {
    driven,
    cleanupResults,
    // Every key-shaped run of characters the module ever typed into the page.
    typed: () => evaluated.join('\n').match(/sk-[A-Za-z0-9-]+/g) || [],
    stored: () => stored,
    async navigate(url) {
      driven.push(`navigate ${url}`);
    },
    async evaluate(source) {
      evaluated.push(source);
      // Order matters: the save expression reads storage too, so the buttons are matched
      // first. An expression matching none of them is a driving surface this fake does not
      // know about, and silently answering undefined would hide it.
      if (source.includes('.disabled === false')) {
        driven.push('settings ready');
        return true;
      }
      if (source.includes('btnSave')) {
        driven.push('save');
        if (failSave) throw new Error('the options page never answered');
        if (service === 'openrouter') {
          assert.match(source, /input\[name="service"\]\[value="openrouter"\]/);
          assert.match(source, /openrouterApiKey/);
        }
        stored = { [service === 'openrouter' ? 'openrouterApiKey' : 'apiKey']: service === 'openrouter' ? OPENROUTER_SHAPED : OPENAI_SHAPED,
          targetLanguage: 'Korean', model: '', buttonVisibility: 'onInvocation' };
        return { error: '', hasKey: true, targetLanguage: 'Korean', model: '', buttonVisibility: 'onInvocation' };
      }
      if (source.includes('btnClear')) {
        if (service === 'openrouter') assert.match(source, /input\[name="service"\]\[value="openrouter"\]/);
        driven.push('clear');
        stored = remaining.settings || {};
        return true;
      }
      if (source.includes('storage.local.get')) {
        const storage = { settings: stored, ...remaining };
        const get = async keys => Object.fromEntries(keys.filter(key => key in storage).map(key => [key, storage[key]]));
        const result = await vm.runInNewContext(source, { chrome: { storage: { local: { get } } } });
        cleanupResults.push(result);
        return result;
      }
      throw new Error(`the fake page was asked to evaluate something it does not know: ${source}`);
    },
    answerDialogs() {
      driven.push('answering dialogs');
      return () => driven.push('stopped answering dialogs');
    },
  };
}

const withApiKeyArgs = (page, envPath, extra = {}) => ({
  page,
  extension: { id: 'abcdefghijklmnopabcdefghijklmnop' },
  envPath,
  targetLanguage: 'Korean',
  ...extra,
});

exports.name = 'live check key handling';
exports.tests = [
  {
    name: 'OpenRouter live key uses its named source and selected service UI cleanup',
    async fn() {
      const { apiKeyName, withApiKey } = await liveKey();
      await withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\nOPENROUTER_API_KEY=${OPENROUTER_SHAPED}\n`, async envPath => {
        assert.equal(apiKeyName(envPath, 'openrouter'), 'OPENROUTER_API_KEY');
        const remaining = { settings: { apiKey: OPENAI_SHAPED }, openai_api_key: OPENAI_SHAPED };
        const page = fakePage({ service: 'openrouter', remaining });
        const cleared = [];
        await withApiKey(withApiKeyArgs(page, envPath, { service: 'openrouter',
          onCleared: ok => cleared.push(ok) }), async saved => {
          assert.equal(saved.hasKey, true);
          assert.equal(JSON.stringify(saved).includes('notarealkey'), false);
        });
        assert.deepEqual(page.typed(), [OPENROUTER_SHAPED]);
        assert.deepEqual(cleared, [true]);
        assert.deepEqual(page.stored(), remaining.settings);
        assert.deepEqual(page.cleanupResults, [true]);
      });
      withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\n`, envPath => {
        assert.throws(() => apiKeyName(envPath, 'openrouter'), /OPENROUTER_API_KEY/);
      });
    },
  },
  {
    name: 'takes the key from a name that identifies the provider',
    async fn() {
      const { apiKeyName } = await liveKey();
      withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\n`, (envPath) => {
        assert.equal(apiKeyName(envPath), 'OPENAI_API_KEY');
      });
    },
  },
  {
    name: 'accepts the documented alternative names, quoted or exported',
    async fn() {
      const { apiKeyName } = await liveKey();
      withEnvFile(`export OPENAI_KEY="${OPENAI_SHAPED}"\n`, (envPath) => {
        assert.equal(apiKeyName(envPath), 'OPENAI_KEY');
      });
    },
  },
  {
    name: 'passes over an accepted name that has no value',
    async fn() {
      const { apiKeyName } = await liveKey();
      withEnvFile(`OPENAI_API_KEY=\nOPENAI_KEY=${OPENAI_SHAPED}\n`, (envPath) => {
        assert.equal(apiKeyName(envPath), 'OPENAI_KEY');
      });
    },
  },
  {
    name: 'refuses another provider key rather than handing it on',
    async fn() {
      const { apiKeyName } = await liveKey();
      withEnvFile(`ANTHROPIC_API_KEY=${ANTHROPIC_SHAPED}\n`, (envPath) => {
        assert.throws(() => apiKeyName(envPath), (error) => {
          // The names it saw, so the fix is one line rather than a hunt.
          assert.match(error.message, /ANTHROPIC_API_KEY/);
          assert.match(error.message, /OPENAI_API_KEY/);
          // And never the value, whatever else the message says.
          assert.equal(error.message.includes('notarealkey'), false);
          return true;
        });
      });
    },
  },
  {
    name: 'refuses a key whose name says nothing about whose it is',
    async fn() {
      const { apiKeyName } = await liveKey();
      // API_KEY was accepted once. It cannot tell an OpenAI key from any other vendor's, which
      // is the whole bug, so it names no provider and is not accepted.
      withEnvFile(`API_KEY=${ANTHROPIC_SHAPED}\n`, (envPath) => {
        assert.throws(() => apiKeyName(envPath), (error) => {
          assert.match(error.message, /API_KEY/);
          assert.equal(error.message.includes('notarealkey'), false);
          return true;
        });
      });
    },
  },
  {
    name: 'says which file it wanted a key from when there is none',
    async fn() {
      const { apiKeyName } = await liveKey();
      const missing = path.join(os.tmpdir(), 'chrome-ai-translator-no-such-dir', '.env.local');
      assert.throws(() => apiKeyName(missing), new RegExp(path.basename(missing)));
    },
  },
  {
    name: 'types only the provider key into the options page',
    async fn() {
      const { withApiKey } = await liveKey();
      // Both present, and only one of them may reach the page: this is the run that used to
      // send an Anthropic key to api.openai.com.
      await withEnvFile(`ANTHROPIC_API_KEY=${ANTHROPIC_SHAPED}\nOPENAI_API_KEY=${OPENAI_SHAPED}\n`, async (envPath) => {
        const page = fakePage();
        await withApiKey(withApiKeyArgs(page, envPath), async () => {});
        assert.deepEqual(page.typed(), [OPENAI_SHAPED]);
      });
    },
  },
  {
    name: 'clears the key after a run that worked',
    async fn() {
      const { withApiKey } = await liveKey();
      await withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\n`, async (envPath) => {
        const page = fakePage();
        const cleared = [];
        const result = await withApiKey(
          withApiKeyArgs(page, envPath, { onCleared: (ok) => cleared.push(ok) }),
          async (saved) => {
            assert.equal(saved.hasKey, true);
            return 'ran';
          }
        );
        assert.equal(result, 'ran');
        assert.deepEqual(cleared, [true]);
        assert.deepEqual(page.stored(), {});
      });
    },
  },
  {
    name: 'clears the key when the save itself failed',
    async fn() {
      const { withApiKey } = await liveKey();
      await withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\n`, async (envPath) => {
        // The failure the header promises the `finally` protects against: a throw between the
        // key reaching the profile and the run starting. With the save outside the `try` this
        // left a real key behind and reported nothing.
        const page = fakePage({ failSave: true });
        const cleared = [];
        let ran = false;
        await assert.rejects(
          withApiKey(
            withApiKeyArgs(page, envPath, { onCleared: (ok) => cleared.push(ok) }),
            async () => {
              ran = true;
            }
          ),
          /never answered/
        );
        assert.equal(ran, false);
        assert.deepEqual(cleared, [true]);
        assert.ok(page.driven.includes('clear'), `drove: ${page.driven.join(' | ')}`);
      });
    },
  },
  {
    name: 'keeps the key out of everything the caller can see',
    async fn() {
      const { withApiKey } = await liveKey();
      await withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\n`, async (envPath) => {
        const page = fakePage();
        const seen = [];
        const result = await withApiKey(withApiKeyArgs(page, envPath), async (saved) => {
          seen.push(JSON.stringify(saved));
          return saved;
        });
        // What the callback gets says whether a key is there, never which one -- and the key
        // was typed into the page, so a value leaking out here would have to come from the
        // module rather than from this file's own fixture.
        assert.equal(JSON.stringify(result).includes(OPENAI_SHAPED), false);
        assert.equal(seen.join('').includes(OPENAI_SHAPED), false);
        assert.ok(page.driven.includes('clear'));
        assert.deepEqual(page.driven.filter(step => ['settings ready', 'save', 'clear'].includes(step)),
          ['settings ready', 'save', 'settings ready', 'clear']);
      });
    },
  },
];

exports.tests.push({
  name: 'keeps the OpenRouter key inside a fixed-host transport and revokes it after the callback',
  async fn() {
    const { withOpenRouterTransport } = await liveKey();
    const calls = [];
    let retained;
    await withEnvFile(`OPENROUTER_API_KEY=${OPENROUTER_SHAPED}\nOPENAI_API_KEY=${OPENAI_SHAPED}\n`, envPath =>
      withOpenRouterTransport({ envPath, fetchImpl: async (url, init) => {
        calls.push({ url, init }); return { ok: true };
      } }, async transport => {
        retained = transport;
        await transport({ body: { input: 'public sample' } });
        await transport({ generationId: 'gen/sample?x' });
        await assert.rejects(() => transport({}), /Unsupported/);
      }));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/responses');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${OPENROUTER_SHAPED}`);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/generation?id=gen%2Fsample%3Fx');
    assert.equal(calls[1].init.method, 'GET');
    assert.equal(calls[1].init.redirect, 'error');
    await assert.rejects(() => retained({ body: {} }), /closed/);
    assert.equal(calls.length, 2);
  },
});

exports.tests.push({
  name: 'concurrent Inline checks close only the driver session each one opened',
  async fn() {
    const { execFile } = require('node:child_process');
    const run = require('node:util').promisify(execFile);
    const entry = path.join(__dirname, 'integration/inline-translation.live.test.mjs');
    const fixture = `
      const http = require('node:http');
      http.createServer = () => ({
        listen(port, host, ready) { ready(); },
        address() { return { port: 12345 }; },
        close() {},
      });
      require('node:child_process').execFile = (file, args, options, done) => {
        console.log(JSON.stringify(args));
        done(args.includes('open') ? new Error('synthetic launch failure') : null, '');
      };
      require('node:module').syncBuiltinESMExports();
      import(process.argv[1]);
    `;
    async function sessionAfterFailure() {
      try {
        await run(process.execPath, ['--permission', `--allow-fs-read=${__dirname}`,
          `--allow-fs-read=${path.resolve(__dirname, '../extension')}`, '-e', fixture, entry]);
      } catch (error) {
        assert.equal(error.code, 1);
        const calls = error.stdout.split('\n').filter(line => line.startsWith('[')).map(JSON.parse);
        const opened = calls.find(args => args.includes('open'));
        assert.ok(opened);
        const session = opened[opened.indexOf('--session') + 1];
        const closes = calls.filter(args => args.includes('close'));
        assert.ok(closes.length);
        for (const args of closes) assert.deepEqual(args, ['--session', session, 'close']);
        return session;
      }
      assert.fail('synthetic launch should fail');
    }
    const [first, second] = await Promise.all([sessionAfterFailure(), sessionAfterFailure()]);
    assert.notEqual(first, second);
  },
});

exports.tests.push({
  name: 'OpenAI cleanup fails when only its legacy key remains',
  async fn() {
    const { withApiKey } = await liveKey();
    await withEnvFile(`OPENAI_API_KEY=${OPENAI_SHAPED}\n`, async envPath => {
      const page = fakePage({ remaining: { openai_api_key: OPENAI_SHAPED } });
      const cleared = [];
      await assert.rejects(withApiKey(withApiKeyArgs(page, envPath, { onCleared: ok => cleared.push(ok) }),
        async () => {}), /Failed to clear/);
      assert.deepEqual(cleared, [false]);
      assert.ok(page.cleanupResults.length && page.cleanupResults.every(result => result === false));
    });
  },
});
