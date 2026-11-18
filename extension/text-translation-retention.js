(function initTextTranslationRetention(globalScope) {
  const { retainedState } = globalScope.ChromeAiTranslatorTextTranslationRequest ||
    require('./text-translation-request.js');

  function createTextTranslationRetention({ getStorage, getCurrentDocumentId, documentEnded, onDocumentConfirmed }) {
    const tabs = new Map();

    function ownerFor(tabId) {
      if (!tabs.has(tabId)) tabs.set(tabId, { documentId: null, queue: Promise.resolve() });
      return tabs.get(tabId);
    }

    function enqueue(owner, task) {
      const result = owner.queue.then(task);
      owner.queue = result.catch(() => {});
      return result;
    }

    function assertKnownDocument(tabId, documentId) {
      const owner = tabs.get(tabId);
      if (owner && (owner.closed || (owner.documentId && owner.documentId !== documentId))) {
        throw documentEnded();
      }
    }

    function observeDocument(tabId, documentId) {
      if (documentId) ownerFor(tabId).documentId = documentId;
    }

    function close(tabId) {
      const owner = ownerFor(tabId);
      owner.closed = true;
      return enqueue(owner, async () => {
        const key = `text-translation:${tabId}`;
        try { await getStorage().remove(key); }
        catch { await getStorage().remove(key); }
        if (tabs.get(tabId) === owner) tabs.delete(tabId);
      });
    }

    async function retain(tabId, documentId, write = null) {
      const owner = ownerFor(tabId);
      // Accepted writes keep their place across navigation and check the persisted owner in the queue.
      if (write && owner.documentId && owner.documentId !== documentId) throw documentEnded();
      const key = `text-translation:${tabId}`;
      const state = await enqueue(owner, async () => {
        if (owner.closed) throw documentEnded();
        if (!write) {
          const knownDocumentId = owner.documentId;
          if (await getCurrentDocumentId(tabId) !== documentId || owner.closed ||
              (owner.documentId !== knownDocumentId && owner.documentId !== documentId)) throw documentEnded();
          owner.documentId = documentId;
          onDocumentConfirmed(tabId, documentId);
        }
        const saved = (await getStorage().get(key))[key];
        if (owner.closed) throw documentEnded();
        if (saved && (typeof saved.documentId !== 'string' || !saved.documentId ||
            !Number.isSafeInteger(saved.revision) || saved.revision < 0)) throw documentEnded();
        if (!owner.documentId && saved) owner.documentId = saved.documentId;
        if (!write) {
          if (owner.documentId !== documentId) throw documentEnded();
          const state = saved && saved.state !== null ? retainedState(saved.state) : null;
          if (state?.job?.status === 'running') state.job.status =
            state.job.results.length === state.job.units.length ? 'complete' : 'stopped';
          await getStorage().set({ [key]: { documentId,
            revision: saved?.documentId === documentId ? saved.revision : 0, state } });
          if (owner.documentId !== documentId) throw documentEnded();
          return state;
        }
        if (!saved || saved.documentId !== documentId) throw documentEnded();
        const { revision, nextState } = write;
        if (!Number.isSafeInteger(revision) || revision < 1) throw documentEnded();
        if (revision <= saved.revision) return;
        await getStorage().set({ [key]: { documentId, revision, state: nextState() } });
      });
      if (owner.closed) throw documentEnded();
      return state;
    }

    return {
      observeDocument, close, assertKnownDocument,
      restore: (tabId, documentId) => retain(tabId, documentId),
      save: (tabId, documentId, revision, state) =>
        retain(tabId, documentId, { revision, nextState: () => retainedState(state) }),
      clear: (tabId, documentId, revision) =>
        retain(tabId, documentId, { revision, nextState: () => null }),
    };
  }

  const api = { createTextTranslationRetention };
  globalScope.ChromeAiTranslatorTextTranslationRetention = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
