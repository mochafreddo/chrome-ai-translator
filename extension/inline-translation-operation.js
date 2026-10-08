// One page visit's controls own preparation and the lifecycle around the Session and
// viewport. Only the Session admits, settles, applies and accounts for Semantic Blocks.
(function exposeInlineTranslationOperation(globalScope) {
  const sessions = globalScope.ChromeAiTranslatorInlineTranslationSession ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-translation-session') : null);
  const viewport = globalScope.ChromeAiTranslatorInlineViewport ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-viewport') : null);
  const diagnostics = globalScope.ChromeAiTranslatorInlineDiagnosticsProtocol ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-diagnostics-protocol') : null);
  const transport = globalScope.ChromeAiTranslatorInlineLocalDiagnosticTransport ||
    (typeof module !== 'undefined' && module.exports ? require('./inline-local-diagnostic-transport') : null);
  const AUTH_MS = 5 * 60 * 1000;

  function formatProgress(counts, status) {
    return [
      status === 'stopped' ? 'Visible translation stopped' : 'Visible translation on',
      `Translated ${Number(counts.translated) || 0} · Partial ${Number(counts.partial) || 0} · Pending ${
        status === 'stopped' ? 0 : Number(counts.pending) || 0
      } · Changed ${Number(counts.changed) || 0} · Failed ${Number(counts.failed) || 0}`,
    ].join('\n');
  }

  function createInlineTranslationOperation({
    sendMessage,
    pickArticleRoot,
    viewportPlatform = globalThis,
    now = Date.now,
    crypto = globalThis.crypto,
    onChange = () => {},
    onSettings = () => {},
  }) {
    const session = sessions.createInlineTranslationSession();
    let authorizedUntil = 0;
    let preparation = null;
    let current = null;
    let progress = '';
    let error = '';

    function isCurrent(store) {
      return current === store && session.isCurrent(store.id);
    }

    function update() {
      const { counts, reason } = session.progress();
      progress = formatProgress(counts, session.status);
      const feedback = [reason, current?.diagnosticsUnavailable ? 'Diagnostics could not be saved.' : '']
        .filter(Boolean).join('\n');
      if (feedback) error = feedback;
      onChange();
    }

    function reportFailure(failure, store) {
      if (!isCurrent(store)) return;
      error = failure?.message || String(failure);
      onChange();
    }

    function unavailable(store) {
      if (!isCurrent(store)) return;
      store.diagnosticsUnavailable = true;
      update();
    }

    function fileOutcomes(store, { runtimeOutcomes, releaseTokens }) {
      if (!runtimeOutcomes.length && !releaseTokens.length) return;
      sendMessage({
        type: diagnostics.messages.recordRuntime,
        operationId: store.id,
        outcomes: runtimeOutcomes,
        releaseTokens,
      }).then(response => {
        if (response?.ok !== true) unavailable(store);
      }, () => unavailable(store));
    }

    async function drain(store) {
      if (!isCurrent(store)) return;
      store.transport.flush();
      while (isCurrent(store)) {
        const batch = session.takeBatch();
        store.transport.flush();
        update();
        if (!batch.length) return;
        // Every submitted batch settles, including transport failure and obsolete work.
        // Eligibility protects display and follow-up work after the Session's accounting.
        Promise.resolve().then(() => sendMessage({
          type: 'TRANSLATE_VISIBLE_BLOCK_BATCH',
          operationId: store.id,
          settingsSnapshot: store.settings,
          records: batch.map(record => ({
            id: record.id, template: record.template, atoms: record.atoms,
            contract: record.contract, repair: record.repair,
          })),
        })).catch(() => null).then(response => {
          const settled = session.settle(batch, response);
          if (settled.diagnosticsUnavailable) store.diagnosticsUnavailable = true;
          fileOutcomes(store, settled);
        }).catch(() => {}) // Filing failures cannot undo already settled Semantic Blocks.
          .finally(() => {
            if (!isCurrent(store)) return;
            update();
            drain(store).catch(failure => reportFailure(failure, store));
          });
      }
    }

    function begin(settings) {
      current?.scanner.stop();
      current?.transport.stop();
      session.begin(settings);
      const store = { id: session.operationId, settings };
      current = store;
      store.transport = transport.createInlineLocalDiagnosticTransport({
        outbox: session.outbox,
        operationId: store.id,
        settingsSnapshot: settings,
        sendMessage, crypto,
        setTimeout: (callback, delay) => viewportPlatform.setTimeout(callback, delay),
        clearTimeout: timer => viewportPlatform.clearTimeout(timer),
        onUnavailable: () => unavailable(store),
      });
      store.scanner = viewport.createInlineViewport({
        session, platform: viewportPlatform,
        onScan() {
          if (!isCurrent(store)) return;
          update();
          drain(store).catch(failure => reportFailure(failure, store));
        },
      });
      return store;
    }

    async function prepare(requested) {
      const response = await sendMessage({ type: 'GET_SETTINGS' });
      if (preparation !== requested) return;
      if (!response?.ok) throw new Error(response?.error?.message || 'Unable to load extension settings.');
      if (!response.settings?.apiKey) {
        error = 'Open Options and paste your OpenAI API key.';
        onChange();
        return;
      }
      const root = pickArticleRoot();
      if (!root) throw new Error('No article content found.');
      const settings = sessions.createSettingsSnapshot(response.settings);
      const store = begin(settings);
      // Display settings have their own lifetime; content receives a separate snapshot.
      onSettings({ ...settings });
      store.scanner.start(root);
    }

    function start() {
      const requested = preparation = {};
      error = '';
      onChange();
      // An existing operation keeps its authorization even when the initial grant expires.
      if (session.status === 'active') {
        current.scanner.rescan();
        update();
        return;
      }
      if (authorizedUntil <= now()) {
        error = 'Use the extension toolbar or shortcut first to authorize inline translation.';
        onChange();
        return;
      }
      prepare(requested).catch(failure => {
        if (preparation !== requested) return;
        error = failure?.message || String(failure);
        onChange();
      });
    }

    function stop() {
      preparation = null;
      session.stop();
      current?.scanner.stop();
      current?.transport.stop();
      update();
    }

    return Object.freeze({
      authorize() { authorizedUntil = now() + AUTH_MS; },
      start, stop,
      restore() {
        preparation = null;
        current?.scanner.stop();
        session.restore();
        // Original text leaves the preceding transport to finish its own outbox/retry.
        // Its feedback ownership ends here; only Stop requests the final flush.
        current = null;
        progress = '';
        error = '';
        onChange();
      },
      getStatus: () => ({ status: session.status, progress, error }),
    });
  }

  const api = { createInlineTranslationOperation };
  globalScope.ChromeAiTranslatorInlineTranslationOperation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
