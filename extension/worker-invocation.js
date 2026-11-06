(function exposeWorkerInvocation(globalScope) {
  const { BUTTON_VISIBILITY, readButtonVisibility } =
    globalScope.ChromeAiTranslatorButtonVisibility ||
    (typeof module !== 'undefined' && module.exports ? require('./button-visibility.js') : {});

  function createWorkerInvocation({
    getChrome, getSettings, contentScriptFiles, inlineErrors, describeFailure,
    captureDocument, isCurrent = () => true, documentUnavailable,
  }) {
    function clearError(tabId) {
      if (inlineErrors.get(tabId)) inlineErrors.set(tabId, null);
    }

    async function openSidePanel(tabId) {
      const chrome = getChrome();
      // ADR-0001: Chrome requires open() before the first await spends the gesture.
      try {
        await chrome.sidePanel.open({ tabId });
      } catch {}
      try {
        await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
      } catch {}
    }

    async function ensureContentScript(tabId, documentId, assertCurrent = () => {}) {
      const chrome = getChrome();
      assertCurrent();
      await chrome.scripting.executeScript({
        target: { tabId, documentIds: [documentId] }, files: contentScriptFiles,
      });
      assertCurrent();
      let response;
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: 'GET_INLINE_TRANSLATION_STATE' }, { documentId });
      } catch {}
      assertCurrent();
      const snapshot = response?.snapshot;
      if (response?.ok !== true ||
          !['original', 'active', 'translated', 'stopped'].includes(snapshot?.status) ||
          typeof snapshot.progress !== 'string' || typeof snapshot.error !== 'string') {
        throw Object.assign(new Error(
          'The extension could not initialize on this page. Reload the extension on chrome://extensions, then reload this page and try again.'
        ), { code: 'content_script_not_ready' });
      }
      if (inlineErrors.get(tabId)?.code === 'content_script_not_ready') clearError(tabId);
    }

    async function preparePage(tabId, documentId, assertCurrent) {
      await openSidePanel(tabId);
      await ensureContentScript(tabId, documentId, assertCurrent);
    }

    async function sendInstruction(tabId, instruction, documentId) {
      const response = await getChrome().tabs.sendMessage(tabId, {
        type: 'RUN_INLINE_INSTRUCTION', instruction,
      }, { documentId });
      if (!response?.ok) {
        throw new Error(response?.error?.message || `The page could not carry out ${instruction}`);
      }
    }

    async function invoke(trigger, tabId) {
      const openedSidePanel = openSidePanel(tabId);
      const document = captureDocument(tabId).then(
        documentId => ({ documentId }), error => ({ error })
      );
      const settingsRequest = getSettings().then(settings => ({ settings }), error => ({ error }));
      await openedSidePanel;
      const captured = await document;
      if (!isCurrent()) return;
      if (!captured.documentId) {
        if (captured.error?.code === 'document.unavailable') await documentUnavailable(tabId);
        return;
      }
      const { documentId } = captured;
      const settledSettings = await settingsRequest;
      if (!isCurrent()) return;
      if (settledSettings.error) throw settledSettings.error;
      const settings = settledSettings.settings;
      function assertCurrent() {
        if (!isCurrent()) throw Object.assign(new Error('The original document is no longer open.'), { code: 'document.departed' });
      }
      try {
        await ensureContentScript(tabId, documentId, assertCurrent);
        clearError(tabId);
      } catch (error) {
        if (!isCurrent()) return;
        if (error?.code === 'content_script_not_ready') {
          try { inlineErrors.set(tabId, error); } catch {}
          return;
        }
      }
      if (!isCurrent()) return;
      try { await sendInstruction(tabId, 'grantInlineTranslationAuthorization', documentId); } catch {}
      if (!isCurrent()) return;
      if (readButtonVisibility(settings) !== BUTTON_VISIBILITY.NEVER) {
        try { await sendInstruction(tabId, 'mountFloatingTranslateButton', documentId); } catch {}
      }
      if (!isCurrent()) return;
      if (trigger !== 'command') return;
      let failure = null;
      try { await sendInstruction(tabId, 'startInlineTranslation', documentId); } catch (error) {
        failure = error || new Error('Unknown error');
      }
      try {
        if (failure) inlineErrors.set(tabId, { message: describeFailure(failure) });
        else clearError(tabId);
      } catch {}
    }

    async function startupInstructions() {
      return readButtonVisibility(await getSettings()) === BUTTON_VISIBILITY.ALL_PAGES
        ? ['mountFloatingTranslateButton'] : [];
    }

    return { invoke, preparePage, startupInstructions, sendInstruction, clearError };
  }

  const api = { createWorkerInvocation };
  globalScope.ChromeAiTranslatorWorkerInvocation = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
