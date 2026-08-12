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
//   passes it, and reports whether the domain answered rather than hanging silently.
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
// What does NOT belong here: assertions about the extension's behaviour, anything about
// translation, and anything about API keys. This module knows how to drive a browser and
// nothing about what is being checked -- that is what keeps one check's needs from
// reshaping another's.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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

export const browser = (args, timeout = 120000) =>
  execFileSync('agent-browser', args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });

export const closeAllBrowsers = () => {
  try {
    browser(['close', '--all'], 30000);
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
  const fail = (name, detail = '') => check(name, false, detail);
  const finish = () => {
    if (failures.length) {
      console.error(`\n${failures.length} failing: ${failures.join(', ')}`);
      process.exitCode = 1;
      return;
    }
    console.log(`\n${label}: all checks passed`);
  };
  return { check, fail, failures, finish };
}

function connect(endpoint) {
  const ws = new WebSocket(endpoint);
  let seq = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id === undefined) {
      for (const handler of listeners.get(message.method) || []) handler(message.params, message.sessionId);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    waiter(message.error ? { __error: message.error.message } : message.result);
  });
  const ready = new Promise((resolve) => ws.addEventListener('open', resolve));
  const send = (method, params = {}, sessionId, timeoutMs = 20000) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.delete(id)) resolve({ __timeout: true });
      }, timeoutMs);
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  // Events carry no id, so they are delivered by method name. Returns an unsubscribe.
  const on = (method, handler) => {
    const handlers = listeners.get(method) || [];
    handlers.push(handler);
    listeners.set(method, handlers);
    return () => listeners.set(method, (listeners.get(method) || []).filter((h) => h !== handler));
  };
  return { ready, send, on, close: () => ws.close() };
}

export function extensionManifest(extensionDir) {
  return JSON.parse(readFileSync(`${extensionDir}/manifest.json`, 'utf8'));
}

// Launches a Chrome with the unpacked extension and attaches to the page the driver opened.
//
// Nothing here asserts. It reports what it found -- a missing extension, a hung Extensions
// domain, an absent page -- and leaves the caller to say which of those is a failure and in
// what words, so a check's own output stays its own.
export async function launchExtensionBrowser({ session, url, extensionDir }) {
  browser(['--extension', extensionDir, '--args', '--enable-unsafe-extension-debugging',
    '--session', session, 'open', url]);

  const cdpUrl = browser(['get', 'cdp-url', '--session', session]).trim().split('\n').pop();
  const httpBase = cdpUrl.replace(/^ws:\/\/([^/]+)\/.*$/, 'http://$1');
  const { webSocketDebuggerUrl } = await (await fetch(`${httpBase}/json/version`)).json();
  const cdp = connect(webSocketDebuggerUrl);
  await cdp.ready;

  const listed = await cdp.send('Extensions.getExtensions');
  const extensionsDomainResponded = !listed.__timeout;
  const extensionsSeen = (listed.extensions || []).map((candidate) => candidate.name);
  const wanted = extensionManifest(extensionDir).name;
  const extension = (listed.extensions || []).find((candidate) => candidate.name === wanted) || null;

  const listTargets = async () => (await cdp.send('Target.getTargets')).targetInfos || [];
  const listPages = async () => (await (await fetch(`${httpBase}/json/list`)).json());
  const findTarget = async (predicate) => (await listPages()).find(predicate) || null;

  const tabs = await cdp.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = (tabs.targetInfos || []).filter((target) => target.url.startsWith(url)).pop() || null;
  const pageTarget = (await listPages())
    .filter((target) => target.type === 'page' && target.url.startsWith(url))
    .pop() || null;

  const attach = async (targetId) => {
    const attached = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = attached.sessionId;
    await cdp.send('Page.enable', {}, sessionId);
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

  const page = pageTarget ? await attach(pageTarget.id) : null;

  return {
    cdp,
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
}
