// Runs the shipped viewport against a real Session without draining or charging batches.
// Self-contained so the unbilled browser checks can evaluate the same helper in the page.
function createViewportProbe(session, platform = globalThis,
  createViewport = globalThis.ChromeAiTranslatorInlineViewport.createInlineViewport) {
  const records = [];
  const timers = new Map();
  let nextTimer = 0;
  const viewport = createViewport({
    session: {
      get operationId() { return session.operationId; },
      get status() { return session.status; },
      isCurrent: session.isCurrent,
      resetQueue: session.resetQueue,
      admit(block) {
        const record = session.admit(block);
        if (record) records.push(record);
        return record;
      },
    },
    platform: {
      window: platform.window, document: platform.document,
      HTMLElement: platform.HTMLElement, MutationObserver: platform.MutationObserver,
      setTimeout(callback) { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
  });
  function flush() {
    let remaining = 10000;
    while (timers.size) {
      if (--remaining === 0) throw new Error('Viewport scan did not finish');
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    }
  }
  return {
    records,
    start(root) { viewport.start(root); flush(); },
    rescan() {
      const before = records.length;
      viewport.rescan();
      flush();
      return records.slice(before);
    },
    stop: viewport.stop,
  };
}
module.exports = { createViewportProbe };
