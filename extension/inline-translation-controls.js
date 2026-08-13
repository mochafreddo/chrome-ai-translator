// The three Inline Translation controls, and when each of them is on offer.
//
// Inline Translation has two homes — the Floating Translate Button on the page and the
// Inline Translation Section in the side panel — and both must offer the same three
// controls under the same conditions. That is what the rules are doing here rather than in
// either of them: a home that dimmed Stop a moment later than the other would be offering
// the reader a different feature depending on where they reached for it.
//
// Labels stay with each home. They differ, and only these rules have to agree.
(function initInlineTranslationControls(globalScope) {
  const INLINE_TRANSLATION_CONTROLS = Object.freeze({
    START: 'start',
    STOP: 'stop',
    RESTORE: 'restore',
  });

  // The instruction the content script carries out for each control. As with the
  // invocation steps, the name is the content script's own handler name, so the two sides
  // share one vocabulary and nothing has to link them.
  const INLINE_TRANSLATION_CONTROL_STEPS = Object.freeze({
    [INLINE_TRANSLATION_CONTROLS.START]: 'startInlineTranslation',
    [INLINE_TRANSLATION_CONTROLS.STOP]: 'stopInlineTranslation',
    [INLINE_TRANSLATION_CONTROLS.RESTORE]: 'restoreInlineOriginal',
  });

  // Restoring needs something on the page to put back, which outlasts the run that put it
  // there: a stopped run and a finished one both leave translated text behind.
  const INLINE_RESTORABLE_STATUSES = Object.freeze([
    'active',
    'translated',
    'stopped',
  ]);

  // Stopping needs a run to stop. Starting is not a rule here: it is on offer in every
  // status, because Start during a live run rescans what has scrolled into view rather than
  // paying for the page a second time — `isInlineTranslationRunLive` in `content.js` is
  // what enforces that, and dimming Start would take away the rescan along with it.
  function getInlineTranslationControlAvailability(status) {
    const current = status || 'original';
    const isActive = current === 'active';

    return Object.freeze({
      isActive,
      canStop: isActive,
      canRestore: INLINE_RESTORABLE_STATUSES.includes(current),
    });
  }

  function getInlineTranslationControlStep(control) {
    return INLINE_TRANSLATION_CONTROL_STEPS[control] || '';
  }

  const api = {
    INLINE_TRANSLATION_CONTROLS,
    getInlineTranslationControlAvailability,
    getInlineTranslationControlStep,
  };
  globalScope.ChromeAiTranslatorInlineTranslationControls = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
