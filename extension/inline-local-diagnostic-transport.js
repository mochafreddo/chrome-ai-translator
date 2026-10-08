// Sends the Session's local-diagnostic outbox, retaining one retry and final Stop flushing.
(function exposeInlineLocalDiagnosticTransport(globalScope) {
  const inlineDiagnosticsProtocol = globalScope.ChromeAiTranslatorInlineDiagnosticsProtocol ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-diagnostics-protocol') : null);
  function createInlineLocalDiagnosticTransport({
    outbox,
    crypto = globalThis.crypto,
    operationId,
    settingsSnapshot,
    sendMessage = (message) => chrome.runtime.sendMessage(message),
    setTimeout: schedule = (task, delay) => setTimeout(task, delay),
    clearTimeout: cancel = (timer) => clearTimeout(timer),
    onUnavailable = () => {},
  }) {
    let inFlight = null;
    let timer = null;
    let stopped = false;

    function takeBatch() {
      return {
        id: inlineDiagnosticsProtocol.createUuidV4(crypto),
        diagnostics: outbox.splice(0, inlineDiagnosticsProtocol.limits.maxRecords),
        attempt: 0,
      };
    }

    function defer(task, delay) {
      if (stopped) return;
      if (timer !== null) cancel(timer);
      timer = schedule(() => {
        timer = null;
        if (!stopped) task();
      }, delay);
    }

    function send(batch) {
      const fail = () => {
        if (!stopped && batch.attempt < 1 && inFlight === batch) {
          batch.attempt += 1;
          defer(() => send(batch), 250);
        } else {
          if (inFlight === batch) inFlight = null;
          if (outbox.length) defer(flush, 250);
          onUnavailable();
        }
      };
      sendMessage({
        type: inlineDiagnosticsProtocol.messages.recordLocal,
        diagnosticBatchId: batch.id,
        operationId,
        settingsSnapshot,
        diagnostics: batch.diagnostics,
      }).then((response) => {
        if (response?.ok !== true) {
          fail();
          return;
        }
        if (inFlight === batch) inFlight = null;
        if (outbox.length) defer(flush, 0);
      }).catch(fail);
    }

    function flush() {
      if (stopped || !outbox.length || inFlight) return;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      inFlight = takeBatch();
      send(inFlight);
    }

    function stop() {
      if (stopped) return;
      stopped = true;
      const retryWaiting = timer !== null && inFlight;
      if (timer !== null) {
        cancel(timer);
        timer = null;
      }
      if (retryWaiting) {
        const batch = inFlight;
        inFlight = null;
        send(batch);
      }
      while (outbox.length) send(takeBatch());
    }

    return { flush, stop };
  }

  const api = { createInlineLocalDiagnosticTransport };
  globalScope.ChromeAiTranslatorInlineLocalDiagnosticTransport = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
