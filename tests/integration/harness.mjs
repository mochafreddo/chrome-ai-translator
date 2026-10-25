// The CDP wiring every integration check needs, in one place.
//
// Driving this extension from outside a browser means knowing a handful of things that
// each look like a different failure than they are, and they used to live only as prose in
// the header of the one check that had learned them. Prose gets read once and retyped; a
// module gets imported. Each gotcha below is now a line of code rather than a paragraph:
//
//   The Extensions CDP domain is gated behind a launch flag. Without
//   --enable-unsafe-extension-debugging every Extensions.* command hangs, and the domain
//   still appears in /json/protocol, so the hang is the only signal. launch() always
//   passes it, and fails launch when the domain cannot answer.
//
//   --extension is a global agent-browser flag and is ignored after the subcommand, so it
//   goes before `open`.
//
//   `page` and `tab` are different CDP target types and are needed for different things: a
//   tab target has no execution context, so Runtime.evaluate against it returns undefined
//   for everything -- including `1 + 1` -- while Extensions.triggerAction rejects anything
//   that is not a tab. launch() returns both, and evaluating is only wired to the page.
//
//   A side panel is hosted as a `page` target, so a tab-filtered listing never contains it.
//   findTarget() lists unfiltered for that reason.
//
//   Extensions.loadUnpacked, Extensions.getStorageItems and Target.createTarget all fail
//   with "No associated browser context" under a driver-launched Chrome. So the extension
//   is loaded at launch, a tab the driver already opened is reused, and everything is
//   observed from the page and the target list rather than from extension storage.
//
//   MV3 service workers idle out in roughly 30 seconds, so probes installed in the worker
//   are unreliable. Observe from the page side.
//
// Serving a check's own fixture page is here for the same reason: every check that wants a
// page it can hold still needs the same loopback server, and the second copy of it was
// written before this one existed.
//
// What does NOT belong here: assertions about translation behaviour, anything about
// translation, and anything about API keys. This module knows how to drive a browser and
// nothing about what is being checked -- that is what keeps one check's needs from
// reshaping another's.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { promisify } from 'node:util';

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until the predicate holds. Returns false on timeout rather than throwing, so a
// caller can report the state it settled in instead of a stack trace.
export async function until(predicate, timeoutMs, stepMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() >= deadline) return false;
    await wait(stepMs);
  }
}

// Asynchronous on purpose. Driving the browser synchronously blocks this process's event
// loop for the whole call, so anything the browser needs from us while it works -- a check
// serving its own fixture page, most obviously -- cannot answer, and the driver hangs until
// its timeout on a page that would have loaded instantly.
const run = promisify(execFile);

export const browser = async (args, timeout = 120000) =>
  (await run('agent-browser', args, { encoding: 'utf8', timeout })).stdout;

// Serves one file, at every path, on a loopback port the OS picks. http and not file:, because
// the extension's content scripts match http://*/* and https://*/* and a file:// page is
// outside that. The body is read once, so the page a run sees cannot change under it.
export function serveFixture(fixturePath) {
  const body = readFileSync(fixturePath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/`, close: () => server.close() }));
  });
}

export const closeAllBrowsers = async () => {
  try {
    await browser(['close', '--all'], 30000);
  } catch {
    // Closing is best-effort cleanup; a driver that is already gone is not a failure.
  }
};

// One checklist per check file. `label` prefixes every line so a run's output says which
// check produced it, and finish() sets the exit code.
export function createChecks(label) {
  const failures = [];
  const check = (name, ok, detail = '') => {
    if (ok) {
      console.log(`PASS ${label} - ${name}`);
      return true;
    }
    failures.push(name);
    console.error(`FAIL ${label} - ${name}${detail ? ` (${detail})` : ''}`);
    return false;
  };
  const finish = () => {
    if (failures.length) {
      console.error(`\n${failures.length} failing: ${failures.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n${label}: all checks passed`);
  };
  return { check, failures, finish };
}

export function connect(endpoint, platform = globalThis) {
  const ws = new platform.WebSocket(endpoint);
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  const protocolErrorCodes = new Set();
  let timeouts = 0;
  let runtimeExceptionPresent = false;
  let closed = false;
  const settle = (id, result) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    if (result?.__timeout) timeouts += 1;
    pending.delete(id);
    platform.clearTimeout(waiter.timer);
    waiter.resolve(result);
  };
  const terminate = () => {
    closed = true;
    for (const id of pending.keys()) settle(id, { __error: 'CDP connection closed' });
  };
  ws.addEventListener('close', terminate);
  ws.addEventListener('error', terminate);
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      if (message.method === 'Runtime.exceptionThrown') runtimeExceptionPresent = true;
      for (const handler of listeners.get(message.method) || []) handler(message.params, message.sessionId);
      return;
    }
    if (pending.has(message.id) && message.result?.exceptionDetails) {
      runtimeExceptionPresent = true;
    }
    if (pending.has(message.id) && Number.isInteger(message.error?.code)) {
      protocolErrorCodes.add(message.error.code);
    }
    settle(message.id, message.error ? { __error: message.error.message } : message.result);
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('close', () => reject(new Error('CDP connection closed before opening')));
    ws.addEventListener('error', () => reject(new Error('CDP connection failed before opening')));
  });
  const send = (method, params = {}, sessionId, timeoutMs = 20000) =>
    new Promise((resolve) => {
      if (closed) { resolve({ __error: 'CDP connection closed' }); return; }
      const id = ++seq;
      const timer = platform.setTimeout(() => settle(id, { __timeout: true }), timeoutMs);
      pending.set(id, { resolve, timer });
      try {
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      } catch (error) {
        settle(id, { __error: error.message });
      }
    });
  // Events carry no id, so they are delivered by method name. Returns an unsubscribe.
  const on = (method, handler) => {
    const handlers = listeners.get(method) || [];
    handlers.push(handler);
    listeners.set(method, handlers);
    return () => listeners.set(method, (listeners.get(method) || []).filter((h) => h !== handler));
  };
  const getDiagnostics = () => ({
    protocolErrorCodes: [...protocolErrorCodes].sort((a, b) => a - b),
    timeouts,
    runtimeExceptionPresent,
  });
  return { ready, send, on, getDiagnostics, close: () => { terminate(); ws.close(); } };
}

function extensionManifest(extensionDir) {
  return JSON.parse(readFileSync(`${extensionDir}/manifest.json`, 'utf8'));
}

// Launches a Chrome with the unpacked extension and attaches to the page the driver opened.
// Missing launch prerequisites fail here so a caller cannot silently skip its checks.
export async function launchExtensionBrowser({ session, url, extensionDir, headless = true }) {
  let cdp;
  let browserVersion = null;
  let stage = 'browser open';
  try {
    await browser(['--extension', extensionDir, '--headed', String(!headless),
      '--args', '--enable-unsafe-extension-debugging' + (headless ? ',--headless=new' : ''),
      '--session', session, 'open', url]);

    stage = 'CDP discovery';
    const cdpUrl = (await browser(['get', 'cdp-url', '--session', session])).trim().split('\n').pop();
    const httpBase = cdpUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
    const version = await (await fetch(`${httpBase}/json/version`)).json();
    browserVersion = /^(?:Chrome|HeadlessChrome)\/(\d+(?:\.\d+){0,3})$/.exec(version.Browser)?.[1] || null;
    const { webSocketDebuggerUrl } = version;
    stage = 'CDP connection';
    cdp = connect(webSocketDebuggerUrl);
    await cdp.ready;

    stage = 'extension listing';
    const listed = await cdp.send('Extensions.getExtensions');
    const extensionsDomainResponded = !listed.__timeout && !listed.__error;
    if (!extensionsDomainResponded) throw new Error();
    const extensionsSeen = (listed.extensions || []).map((candidate) => candidate.name);
    const wanted = extensionManifest(extensionDir).name;
    const extension = (listed.extensions || []).find((candidate) => candidate.name === wanted) || null;
    stage = 'extension presence';
    if (!extension) throw new Error();

    const listTargets = async () => (await cdp.send('Target.getTargets')).targetInfos || [];
    const listPages = async () => (await (await fetch(`${httpBase}/json/list`)).json());
    const findTarget = async (predicate) => (await listPages()).find(predicate) || null;

    stage = 'initial targets';
    const tabs = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
    const tab = (tabs.targetInfos || []).filter((target) => target.url.startsWith(url)).pop() || null;
    const pageTarget = (await listPages())
      .filter((target) => target.type === 'page' && target.url.startsWith(url))
      .pop() || null;

    if (!tab || !pageTarget) throw new Error();

    const attach = async (targetId, targetType = 'page') => {
      const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const sessionId = attached.sessionId;
      if (!sessionId || attached.__error || attached.__timeout) throw new Error('Page attachment failed');
      if (targetType === 'page') {
        const enabled = await cdp.send('Page.enable', {}, sessionId);
        if (enabled.__error || enabled.__timeout) throw new Error('Page enable failed');
      }
      const evaluate = async (expression, timeoutMs = 20000) => {
        const evaluated = await cdp.send('Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true }, sessionId, timeoutMs);
        return evaluated.result?.value;
      };
      const navigate = async (to, settleMs = 2500) => {
        await cdp.send('Page.navigate', { url: to }, sessionId);
        await wait(settleMs);
      };
      // window.confirm and friends block the page until something answers them, and a
      // CDP-driven page has no one to. Answering makes controls that ask before acting
      // reachable, so a check can drive the real control instead of writing past it.
      const answerDialogs = (accept = true) =>
        cdp.on('Page.javascriptDialogOpening', (_params, from) => {
          if (from === sessionId) cdp.send('Page.handleJavaScriptDialog', { accept }, sessionId);
        });
      return { sessionId, evaluate, navigate, answerDialogs };
    };

    stage = 'initial page attachment';
    const page = await attach(pageTarget.id);

    return {
      cdp,
      browserVersion,
      httpBase,
      extension,
      extensionsDomainResponded,
      extensionsSeen,
      tab,
      pageTarget,
      page,
      attach,
      listTargets,
      listPages,
      findTarget,
      close: () => cdp.close(),
    };
  } catch {
    const diagnostics = { stage, browserVersion, ...(cdp?.getDiagnostics() || {
      protocolErrorCodes: [], timeouts: null, runtimeExceptionPresent: null,
    }) };
    console.error(`DIAGNOSTIC browser launch - ${JSON.stringify(diagnostics)}`);
    try { cdp?.close(); } finally {
      await browser(['close', '--session', session], 30000).catch(() => {});
    }
    throw new Error(`Browser launch failed: ${stage}`);
  }
}
