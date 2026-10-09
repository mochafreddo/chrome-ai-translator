const assert = require('node:assert/strict');

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
