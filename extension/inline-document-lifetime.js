(function exposeInlineDocumentLifetime(globalScope) {
  function createInlineDocumentLifetime({ getDocumentId, documentEnded, clearTabState }) {
    const tabs = new Map();

    function invalidate(tabId, replacement = null) {
      const previous = tabs.get(tabId);
      if (replacement) tabs.set(tabId, replacement);
      else tabs.delete(tabId);
      for (const controller of previous?.requests || []) controller.abort();
      clearTabState(tabId);
    }

    function replaceDocument(tabId, documentId) {
      const replacement = { documentId, requests: new Set() };
      invalidate(tabId, replacement);
      return replacement;
    }

    function trackTab(tabId) {
      let tracked = tabs.get(tabId);
      if (!tracked) {
        tracked = { documentId: null, requests: new Set() };
        tabs.set(tabId, tracked);
      }
      return tracked;
    }

    async function identify(tabId, expectedDocumentId) {
      const tracked = trackTab(tabId);
      const documentId = await getDocumentId(tabId);
      if (tabs.get(tabId) !== tracked ||
          (expectedDocumentId && documentId !== expectedDocumentId)) throw documentEnded();
      if (tracked.documentId && tracked.documentId !== documentId) {
        return replaceDocument(tabId, documentId);
      }
      tracked.documentId = documentId;
      return tracked;
    }

    async function captureDocument(tabId, expectedDocumentId) {
      return (await identify(tabId, expectedDocumentId)).documentId;
    }

    function beginAction(tabId, kind) {
      const tracked = trackTab(tabId);
      const token = {};
      tracked[kind] = token;
      const isCurrent = () => tabs.get(tabId) === tracked && tracked[kind] === token;
      return {
        isCurrent,
        release() {
          if (isCurrent()) delete tracked[kind];
        },
      };
    }

    async function beginRequest(tabId, expectedDocumentId) {
      const tracked = await identify(tabId, expectedDocumentId);
      if (tabs.get(tabId) !== tracked) throw documentEnded();
      const controller = new AbortController();
      tracked.requests.add(controller);

      function assertCurrent() {
        if (tabs.get(tabId) !== tracked) throw documentEnded();
      }

      return {
        signal: controller.signal,
        assertCurrent,
        async beforeRequest() {
          assertCurrent();
          const documentId = await getDocumentId(tabId);
          assertCurrent();
          if (documentId !== tracked.documentId) {
            invalidate(tabId);
            throw documentEnded();
          }
        },
        release() { tracked.requests.delete(controller); },
      };
    }

    function observeNavigation(tabId, documentId) {
      const tracked = tabs.get(tabId);
      if (!tracked || (documentId && tracked.documentId === documentId)) return false;
      replaceDocument(tabId, documentId);
      return true;
    }

    return {
      captureDocument,
      currentDocumentId: tabId => tabs.get(tabId)?.documentId,
      beginInvocation: tabId => beginAction(tabId, 'invocation'),
      beginControl: tabId => beginAction(tabId, 'control'),
      beginRequest,
      observeNavigation,
      markUnavailable: tabId => { replaceDocument(tabId, null); },
      close: tabId => invalidate(tabId),
    };
  }

  const api = { createInlineDocumentLifetime };
  globalScope.ChromeAiTranslatorInlineDocumentLifetime = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
