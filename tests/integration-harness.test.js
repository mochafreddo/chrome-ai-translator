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
          extensionDir: ${JSON.stringify(dir)} });
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
