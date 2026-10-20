(function exposeWorkerInvocation(globalScope) {
  const { BUTTON_VISIBILITY, readButtonVisibility } =
    globalScope.ChromeAiTranslatorButtonVisibility ||
    (typeof module !== 'undefined' && module.exports ? require('./button-visibility.js') : {});

  function createWorkerInvocation({
    getChrome, getSettings, contentScriptFiles, inlineErrors, describeFailure,
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

    async function ensureContentScript(tabId) {
      const chrome = getChrome();
      await chrome.scripting.executeScript({
        target: { tabId }, files: contentScriptFiles,
      });
      let response;
      try {
        response = await chrome.tabs.sendMessage(tabId, { type: 'GET_INLINE_TRANSLATION_STATE' });
      } catch {}
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

    async function preparePage(tabId) {
      await openSidePanel(tabId);
      await ensureContentScript(tabId);
    }

    async function sendInstruction(tabId, instruction) {
      const response = await getChrome().tabs.sendMessage(tabId, {
        type: 'RUN_INLINE_INSTRUCTION', instruction,
      });
      if (!response?.ok) {
        throw new Error(response?.error?.message || `The page could not carry out ${instruction}`);
      }
    }

    async function invoke(trigger, tabId) {
      const openedSidePanel = openSidePanel(tabId);
      const settings = await getSettings();
      await openedSidePanel;
      try {
        await ensureContentScript(tabId);
        clearError(tabId);
      } catch (error) {
        if (error?.code === 'content_script_not_ready') {
          try { inlineErrors.set(tabId, error); } catch {}
          return;
        }
      }
      try { await sendInstruction(tabId, 'grantInlineTranslationAuthorization'); } catch {}
      if (readButtonVisibility(settings) !== BUTTON_VISIBILITY.NEVER) {
        try { await sendInstruction(tabId, 'mountFloatingTranslateButton'); } catch {}
      }
      if (trigger !== 'command') return;
      let failure = null;
      try { await sendInstruction(tabId, 'startInlineTranslation'); } catch (error) {
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
