// What the reader is told when a tab is out of the extension's reach, and the one gesture
// that puts it right.
//
// Page access is granted per tab, and the side panel outlives the tab it was opened on, so
// the reader meets the same missing grant from two directions: the panel dims its Inline
// Translation controls before anything is pressed, and a content-script injection failure
// reports it after. Both need the same click, which is why the wording lives here rather
// than in either of them — two accounts of one problem read as two problems.
(function initPageAccess(globalScope) {
  const MISSING_PAGE_ACCESS_REQUEST =
    'The extension does not have access to this tab. Click the extension icon on this tab';

  const MISSING_PAGE_ACCESS_MESSAGES = Object.freeze({
    // After a gesture the tab did not answer: there is something to try again.
    afterFailedAttempt: `${MISSING_PAGE_ACCESS_REQUEST}, then try again.`,
    // Before any gesture: the controls are dimmed, so there is nothing to try again yet.
    beforeAnyAttempt: `${MISSING_PAGE_ACCESS_REQUEST} to use these controls.`,
  });

  const api = { MISSING_PAGE_ACCESS_MESSAGES };
  globalScope.ChromeAiTranslatorPageAccess = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
