// What the reader is told when Side Panel Translation stops, and why the code stays.
//
// A Markdown validation failure carries its code as its message, so the panel that prints
// the message prints the code — `markdown.token_missing` and nothing else. The sentence has
// to come from the code instead, which is what this does. The wording lives here rather
// than in the panel because the codes and the words are two lists that have to agree, and
// the test that holds them to each other has to be able to read them without a browser.
//
// The code is kept, in parentheses after the sentence. This is a personal extension: the
// person reading the failure is the person who would report it, and the code is their only
// handle on which of the four went wrong.
(function initSidePanelFailure(globalScope) {
  // For a failure that explains itself neither way below. Nothing about it can be named,
  // so this names only the gesture.
  const UNEXPLAINED_FAILURE_MESSAGE =
    'The translation stopped before it finished. Try again.';

  // One sentence per failure the Markdown validation raises. They are told apart on purpose:
  // a marker the translation invented is a different thing to look at than one it dropped.
  const SIDE_PANEL_FAILURE_MESSAGES = Object.freeze({
    'markdown.token_missing':
      'The translation lost a link or code marker. Try again.',
    'markdown.token_duplicate':
      'The translation repeated a link or code marker. Try again.',
    'markdown.token_unknown':
      'The translation added a link or code marker the page never had. Try again.',
    'markdown.token_nesting_invalid':
      'The translation put the start and end of a link or code marker out of order. Try again.',
  });

  function findSentence(code) {
    return Object.prototype.hasOwnProperty.call(SIDE_PANEL_FAILURE_MESSAGES, code)
      ? SIDE_PANEL_FAILURE_MESSAGES[code]
      : '';
  }

  // Every Side Panel Translation failure comes through here, and most already say something
  // a reader can act on — a missing API key names the Options page. Those keep their own
  // words; only a failure whose message is its own code, or no message at all, is spoken for.
  function describeSidePanelFailure(failure) {
    const code = typeof failure?.code === 'string' ? failure.code.trim() : '';
    const message = String(failure?.message || '').trim();
    const sentence =
      findSentence(code) ||
      (message && message !== code ? message : UNEXPLAINED_FAILURE_MESSAGE);
    return code ? `${sentence} (${code})` : sentence;
  }

  const api = { SIDE_PANEL_FAILURE_MESSAGES, describeSidePanelFailure };
  globalScope.ChromeAiTranslatorSidePanelFailure = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
