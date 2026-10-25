const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function launchFixture(scenario) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-launch-'));
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: 'Fixture Extension' }));
    const driver = path.join(dir, 'agent-browser');
    const effects = path.join(dir, 'effects.jsonl');
    fs.writeFileSync(driver, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HARNESS_EFFECTS, JSON.stringify(args) + '\\n');
if (args.includes('get')) console.log('ws://fixture.invalid/devtools/browser/test');
if (process.env.HARNESS_SCENARIO === 'open-error' && args.includes('open')) process.exit(1);
`, { mode: 0o700 });
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import fs from 'node:fs';
      const scenario = process.env.HARNESS_SCENARIO;
      const effects = process.env.HARNESS_EFFECTS;
      const url = 'https://private.invalid/secret-page';
      const page = { id: 'page-1', type: 'page', url };
      globalThis.fetch = async (endpoint) => {
        if (scenario === 'discovery-error') throw new Error(url);
        return { json: async () => endpoint.endsWith('/json/version')
          ? { Browser: 'Chrome/140.0.0.0', webSocketDebuggerUrl: 'ws://fixture.invalid/socket' }
          : scenario === 'missing-page' ? [] : [page] };
      };
      globalThis.WebSocket = class {
        constructor() {
          this.handlers = new Map();
          queueMicrotask(() => this.emit(scenario === 'connection-error' ? 'error' : 'open'));
        }
        addEventListener(name, fn) {
          const handlers = this.handlers.get(name) || [];
          handlers.push(fn); this.handlers.set(name, handlers);
        }
        emit(name, data) { for (const fn of this.handlers.get(name) || []) fn(data); }
        send(message) {
          const { id, method, params, sessionId } = JSON.parse(message);
          let result = {};
          if (method === 'Extensions.getExtensions') result = { extensions:
            scenario === 'missing-extension' ? [] : [{ id: 'extension-1', name: 'Fixture Extension' }] };
          if (method === 'Target.getTargets') result = { targetInfos:
            scenario === 'missing-tab' ? [] : [{ targetId: 'tab-1', type: 'tab', url }] };
          if (method === 'Target.attachToTarget') result = { sessionId:
            params.targetId === 'worker-1' ? 'worker-session' : 'session-1' };
          if (method === 'Runtime.evaluate') result = { result: { value: 2 } };
          const error = (scenario === 'listing-error' && method === 'Extensions.getExtensions') ||
            (scenario === 'attachment-error' && method === 'Target.attachToTarget') ||
            ((scenario === 'page-enable-error' || sessionId === 'worker-session') && method === 'Page.enable');
          queueMicrotask(() => this.emit('message', { data: JSON.stringify({ id,
            ...(error ? { error: { code: -32602, message: url } } : { result }) }) }));
        }
        close() { fs.appendFileSync(effects, JSON.stringify(['socket-close']) + '\\n'); this.emit('close'); }
      };
      const { launchExtensionBrowser, createChecks } = await import(${JSON.stringify(pathToFileURL(path.join(__dirname, 'integration/harness.mjs')).href)});
      const { check, finish } = createChecks('launch fixture');
      try {
        const ctx = await launchExtensionBrowser({ session: 'fixture-session', url,
          extensionDir: ${JSON.stringify(dir)}, ...(scenario === 'headed-permission' ? { headless: false } : {}) });
        check('page remains usable', await ctx.page?.evaluate('1 + 1') === 2);
        if (scenario === 'worker-attachment') {
          const worker = await ctx.attach('worker-1', 'service_worker');
          check('worker execution remains usable', await worker.evaluate('1 + 1') === 2);
        }
        ctx.close();
      } catch (error) {
        check('launch succeeds', false, error.message);
      }
      finish();
    `], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`,
        HARNESS_SCENARIO: scenario, HARNESS_EFFECTS: effects },
    });
    assert.ifError(result.error);
    return { ...result, effects: fs.existsSync(effects)
      ? fs.readFileSync(effects, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [] };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function fixture(open = true) {
  const { connect } = await import('./integration/harness.mjs');
  const timers = new Map();
  let nextTimer = 0;
  let socket;
  class WebSocket {
    constructor() { socket = this; this.handlers = new Map(); }
    addEventListener(name, fn) {
      if (!this.handlers.has(name)) this.handlers.set(name, []);
      this.handlers.get(name).push(fn);
    }
    emit(name, event) { for (const fn of this.handlers.get(name) || []) fn(event); }
    send(value) { this.request = JSON.parse(value); }
    close() { this.emit('close'); }
  }
  const cdp = connect('ws://test.invalid', {
    WebSocket,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  if (open) { socket.emit('open'); await cdp.ready; }
  return { cdp, socket, timers };
}

exports.name = 'integration harness';
exports.tests = [
  {
    name: 'fails missing launch prerequisites and cleans up before returning a context',
    fn() {
      const stages = {
        'missing-tab': 'initial targets', 'missing-page': 'initial targets',
        'missing-extension': 'extension presence', 'connection-error': 'CDP connection',
        'listing-error': 'extension listing', 'attachment-error': 'initial page attachment',
        'page-enable-error': 'initial page attachment', 'discovery-error': 'CDP discovery',
        'open-error': 'browser open',
      };
      for (const [scenario, stage] of Object.entries(stages)) {
        const result = launchFixture(scenario);
        assert.equal(result.status, 1, `${scenario}: ${result.stdout}${result.stderr}`);
        assert.equal(result.effects.some(args => args.includes('socket-close')),
          !['discovery-error', 'open-error'].includes(scenario), scenario);
        assert.ok(result.effects.some(args => args.includes('close') &&
          args.includes('--session') && args.includes('fixture-session') && !args.includes('--all')), scenario);
        assert.equal(result.stderr.includes('private.invalid'), false, scenario);
        const diagnostic = result.stderr.split('\n').find(line => line.startsWith('DIAGNOSTIC browser launch - '));
        assert.ok(diagnostic, scenario);
        assert.equal(JSON.parse(diagnostic.slice('DIAGNOSTIC browser launch - '.length)).stage, stage, scenario);
      }
    },
  },
  {
    name: 'launches Chrome headless with the required extension debugging flag',
    fn() {
      const result = launchFixture('ready');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const args = result.effects.find(argv => argv.includes('open'));
      assert.ok(args);
      assert.ok(args.includes('--headed'));
      assert.ok(args.includes('--args'));
      assert.equal(args[args.indexOf('--headed') + 1], 'false');
      const nativeArgs = args[args.indexOf('--args') + 1].split(',');
      assert.ok(nativeArgs.includes('--headless=new'));
      assert.ok(nativeArgs.includes('--enable-unsafe-extension-debugging'));
    },
  },
  {
    name: 'opens an explicitly headed Chrome for permission UI without dropping extension debugging',
    fn() {
      const result = launchFixture('headed-permission');
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const args = result.effects.find(argv => argv.includes('open'));
      assert.ok(args?.includes('--headed'));
      assert.ok(args.includes('--args'));
      assert.equal(args[args.indexOf('--headed') + 1], 'true');
      const nativeArgs = args[args.indexOf('--args') + 1].split(',');
      assert.ok(nativeArgs.includes('--enable-unsafe-extension-debugging'));
      assert.equal(nativeArgs.includes('--headless=new'), false);
    },
  },
  {
    name: 'returns a usable page and leaves successful-launch cleanup to the caller',
    fn() {
      for (const scenario of ['ready', 'worker-attachment']) {
        const result = launchFixture(scenario);
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /PASS launch fixture - page remains usable/);
        assert.deepEqual(result.effects.filter(args => args.includes('close')), []);
        assert.equal(result.effects.filter(args => args.includes('socket-close')).length, 1);
      }
    },
  },
  {
    name: 'polls for delayed readiness and returns false when the deadline expires',
    async fn() {
      const { until } = await import('./integration/harness.mjs');
      let ready = false;
      const timer = setTimeout(() => { ready = true; }, 5);
      try {
        assert.equal(await until(() => ready, 1000, 1), true);
        assert.equal(await until(() => false, 0, 1), false);
        assert.equal(await until(() => true, 0, 1), true);
      } finally { clearTimeout(timer); }
    },
  },
  {
    name: 'records Runtime exception presence without retaining exception or page content',
    async fn() {
      for (const source of ['response', 'event']) {
        const { cdp, socket } = await fixture();
        try {
          const response = cdp.send('Runtime.evaluate', { expression: 'private expression' });
          const exceptionDetails = { text: 'private exception', exception: { description: 'secret URL' } };
          const result = { result: { value: 'normal page value' },
            ...(source === 'response' ? { exceptionDetails } : {}),
          };
          if (source === 'event') {
            socket.emit('message', { data: JSON.stringify({ method: 'Runtime.exceptionThrown',
              params: { exceptionDetails },
            }) });
          }
          socket.emit('message', { data: JSON.stringify({ id: socket.request.id, result }) });
          assert.deepEqual(await response, result);
          assert.deepEqual(cdp.getDiagnostics(), {
            protocolErrorCodes: [], timeouts: 0, runtimeExceptionPresent: true,
          });
          assert.equal(JSON.stringify(cdp.getDiagnostics()).includes('private'), false);
          assert.equal(JSON.stringify(cdp.getDiagnostics()).includes('secret'), false);
        } finally { cdp.close(); }
      }
    },
  },
  {
    name: 'counts actual timeouts once and ignores a late protocol error',
    async fn() {
      const { cdp, socket, timers } = await fixture();
      try {
        const response = cdp.send('Runtime.evaluate', {}, undefined, 500);
        const id = socket.request.id;
        const [timer] = timers.values();
        timer.fn();
        assert.deepEqual(await response, { __timeout: true });
        socket.emit('message', { data: JSON.stringify({ id,
          error: { code: -32600, message: 'late private failure' },
        }) });
        assert.deepEqual(cdp.getDiagnostics(), {
          protocolErrorCodes: [], timeouts: 1, runtimeExceptionPresent: false,
        });
      } finally { cdp.close(); }
    },
  },
  {
    name: 'reports only numeric protocol failure codes without changing response values',
    async fn() {
      const { cdp, socket } = await fixture();
      try {
        const response = cdp.send('Runtime.evaluate', { expression: 'private page expression' });
        socket.emit('message', { data: JSON.stringify({ id: socket.request.id,
          error: { code: -32602, message: 'private page contents and URL' },
        }) });
        assert.deepEqual(await response, { __error: 'private page contents and URL' });
        assert.deepEqual(cdp.getDiagnostics(), {
          protocolErrorCodes: [-32602], timeouts: 0, runtimeExceptionPresent: false,
        });
        const snapshot = cdp.getDiagnostics();
        snapshot.protocolErrorCodes.push(123);
        assert.deepEqual(cdp.getDiagnostics().protocolErrorCodes, [-32602]);
      } finally { cdp.close(); }
    },
  },
  {
    name: 'ends readiness waiting when the connection fails before opening',
    async fn() {
      for (const event of ['close', 'error']) {
        const { cdp, socket } = await fixture(false);
        const outcome = cdp.ready.then(() => 'open', () => 'closed');
        socket.emit(event);
        await Promise.resolve();
        assert.equal(await Promise.race([outcome, Promise.resolve('pending')]), 'closed');
        cdp.close();
      }
    },
  },
  {
    name: 'clears a completed request timeout for both successful and error responses',
    async fn() {
      for (const error of [false, true]) {
        const { cdp, socket, timers } = await fixture();
        try {
          const result = cdp.send('Runtime.evaluate', {}, undefined, 60000);
          assert.equal(timers.size, 1);
          socket.emit('message', { data: JSON.stringify({ id: socket.request.id,
            ...(error ? { error: { message: 'evaluation failed' } } : { result: { value: 42 } }),
          }) });
          assert.deepEqual(await result, error ? { __error: 'evaluation failed' } : { value: 42 });
          assert.equal(timers.size, 0);
        } finally { cdp.close(); }
      }
    },
  },
  {
    name: 'keeps real timeouts observable and ignores their late responses',
    async fn() {
      const { cdp, socket, timers } = await fixture();
      try {
        const result = cdp.send('Runtime.evaluate', {}, undefined, 60000);
        const id = socket.request.id;
        const [timer] = timers.values();
        assert.equal(timer.delay, 60000);
        timer.fn();
        assert.deepEqual(await result, { __timeout: true });
        assert.equal(timers.size, 0);
        socket.emit('message', { data: JSON.stringify({ id, result: { value: 42 } }) });
        assert.equal(timers.size, 0);
      } finally { cdp.close(); }
    },
  },
  {
    name: 'settles pending requests and clears timers on local or remote connection termination',
    async fn() {
      for (const event of ['local-close', 'close', 'error', 'send-error']) {
        const { cdp, socket, timers } = await fixture();
        if (event === 'send-error') socket.send = () => { throw new Error('send failed'); };
        const requests = [cdp.send('First'), cdp.send('Second')];
        if (event === 'local-close') cdp.close();
        else if (event !== 'send-error') socket.emit(event);
        const results = await Promise.all(requests);
        assert.equal(results.every((result) => Boolean(result.__error)), true, event);
        assert.equal(timers.size, 0, event);
        cdp.close();
        assert.ok((await cdp.send('After close')).__error);
        assert.equal(timers.size, 0);
      }
    },
  },
];

exports.tests.push({
  name: 'model request evidence pairs worker responses and retains only policy and usage metadata',
  async fn() {
    const { observeModelRequests } = await import('./integration/model-request-evidence.mjs');
    const listeners = new Map();
    const calls = [];
    const cdp = {
      on(type, callback) { listeners.set(type, callback); return () => listeners.delete(type); },
      async send(method, args, sessionId) {
        calls.push({ method, args, sessionId });
        return method === 'Network.getResponseBody' ? { base64Encoded: true,
          body: Buffer.from(JSON.stringify({ usage: { output_tokens_details: { reasoning_tokens: 0 } },
            output: 'private translated payload' })).toString('base64') } : {};
      },
    };
    const evidence = await observeModelRequests(cdp, 'worker', { reasoningUsage: true });
    const request = { requestId: 'one', request: { method: 'POST', url: 'https://openrouter.ai/api/v1/responses',
      headers: { Authorization: 'private-key' }, postData: JSON.stringify({ model: 'pinned', reasoning: { effort: 'none', extra: 'private reasoning field' },
        provider: { require_parameters: true, data_collection: 'deny', zdr: true, extra: 'private provider field' }, input: 'private source payload', max_output_tokens: 4096, store: false,
        text: { format: { type: 'json_schema', strict: true, schema: 'private schema' } } }) } };
    listeners.get('Network.requestWillBeSent')(request, 'other-worker');
    listeners.get('Network.loadingFinished')({ requestId: 'unknown' }, 'worker');
    assert.equal(evidence.requests.length, 0);
    listeners.get('Network.requestWillBeSent')(request, 'worker');
    listeners.get('Network.responseReceived')({ requestId: 'one' }, 'worker');
    listeners.get('Network.loadingFinished')({ requestId: 'one' }, 'worker');
    listeners.get('Network.loadingFinished')({ requestId: 'one' }, 'worker');
    await evidence.settle();
    assert.deepEqual(evidence.requests, [{ service: 'openrouter', model: 'pinned', reasoning: { effort: 'none' },
      provider: { require_parameters: true, data_collection: 'deny', zdr: true }, format: 'json_schema', strict: true, maxOutputTokens: 4096, store: false }]);
    assert.deepEqual([...evidence.completedRequests], ['one']);
    assert.deepEqual(evidence.reasoningTokens, [0]);
    assert.deepEqual(calls, [{ method: 'Network.enable', args: {}, sessionId: 'worker' },
      { method: 'Network.getResponseBody', args: { requestId: 'one' }, sessionId: 'worker' }]);
    assert.doesNotMatch(JSON.stringify(evidence), /private-key|private source payload|private translated payload|private schema|private reasoning field|private provider field/);
    evidence.close();
    assert.equal(listeners.size, 0);
  },
});

exports.tests.push({
  name: 'Stop evidence requires the exact pending request to finish successfully after its checkpoint',
  async fn() {
    const { observeModelRequests } = await import('./integration/model-request-evidence.mjs');
    const { execute } = require('../extension/inline-model-execution');
    const { serialized } = require('./inline-block.test').createReasoningFixture();
    const record = { id: 'stop-block', template: serialized.template, atoms: serialized.atoms, contract: serialized.contract };
    const wrapper = record.contract.entries.find(entry => entry.kind === 'wrapper');
    const atom = record.contract.entries.find(entry => entry.kind === 'atom');
    const translated = `${atom.token}와 같은 ${wrapper.openToken}추론 모델${wrapper.closeToken}은 내부 추론 토큰을 사용합니다.`;
    const output = template => JSON.stringify({ status: 'completed', output: [{ type: 'message',
      content: [{ type: 'output_text', text: JSON.stringify({ translations: [{ id: record.id, template }] }) }] }] });
    for (const scenario of ['before-stop', 'unrelated-only', 'http-error', 'http-low', 'response-error', 'invalid-json', 'invalid-protocol', 'invalid-contract', 'pending-success']) {
      const listeners = new Map();
      const cdp = {
        on(type, callback) { listeners.set(type, callback); return () => listeners.delete(type); },
        async send(method) {
          return method === 'Network.getResponseBody' ? { body:
            scenario === 'response-error' ? output(translated).replace('completed', 'failed') :
            scenario === 'invalid-json' ? 'invalid' : scenario === 'invalid-protocol' ? JSON.stringify({ status: 'completed',
              output: [{ type: 'message', content: [{ type: 'output_text', text: 'invalid translation JSON' }] }] }) : output(scenario === 'invalid-contract' ? '토큰이 빠진 번역입니다.' : translated) } : {};
        },
      };
      const evidence = await observeModelRequests(cdp, 'worker', { validateOutput: async (text, input) => {
        const body = JSON.parse(input);
        let calls = 0;
        const results = await execute(body.records.map(item => ({ ...item, contract: record.contract })),
          { targetLanguage: 'Korean', tone: 'technical' }, async () => {
            if (calls++) throw new Error('An unobserved repair cannot validate this response.');
            return text;
          });
        return results.every(result => result.disposition === 'apply' && result.attemptCount === 1);
      } });
      const emit = (name, event) => listeners.get(name)(event, 'worker');
      const request = requestId => ({ requestId, request: { method: 'POST', url: 'https://openrouter.ai/api/v1/responses',
        postData: JSON.stringify({ input: JSON.stringify({ records: [{ id: record.id, template: record.template, atoms: record.atoms }] }) }) } });
      emit('Network.requestWillBeSent', request('exact-request'));
      emit('Network.responseReceived', { requestId: 'exact-request', response: { status: scenario === 'http-error' ? 401 : scenario === 'http-low' ? 199 : 200 } });
      if (scenario === 'before-stop') emit('Network.loadingFinished', { requestId: 'exact-request' });
      const checkpoint = evidence.checkpointPending(['exact-request']);
      assert.equal(checkpoint.pending, scenario !== 'before-stop', scenario);
      assert.equal(evidence.completedSuccessfully(checkpoint), false, scenario);
      emit('Network.requestWillBeSent', request('unrelated-request'));
      emit('Network.responseReceived', { requestId: 'unrelated-request', response: { status: 200 } });
      emit('Network.loadingFinished', { requestId: 'unrelated-request' });
      if (!['before-stop', 'unrelated-only'].includes(scenario)) emit('Network.loadingFinished', { requestId: 'exact-request' });
      await evidence.settle();
      assert.equal(evidence.completedSuccessfully(checkpoint), scenario === 'pending-success', scenario);
      assert.equal(evidence.checkpointPending([]).pending, false);
      assert.equal(evidence.checkpointPending(['unobserved-request']).pending, false);
      assert.doesNotMatch(JSON.stringify([...evidence.responses.values()]), /추론|번역|Reasoning|GPT|template/);
      evidence.close();
    }
  },
});
