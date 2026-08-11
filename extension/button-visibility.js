// Button Visibility: the reader's standing choice about when the Floating Translate Button
// may appear. One value with three exclusive states rather than a pair of booleans, so a
// contradiction like "never, but on every page" cannot be stored at all.
//
// The background worker and the options page both read the choice, and both must read it
// the same way, which is why the mapping lives here rather than in either of them.
(function initButtonVisibility(globalScope) {
  const BUTTON_VISIBILITY = Object.freeze({
    NEVER: 'never',
    ON_INVOCATION: 'onInvocation',
    ALL_PAGES: 'allPages',
  });

  const BUTTON_VISIBILITY_CHOICES = Object.freeze([
    BUTTON_VISIBILITY.NEVER,
    BUTTON_VISIBILITY.ON_INVOCATION,
    BUTTON_VISIBILITY.ALL_PAGES,
  ]);

  // The ordinary web pages the all-pages choice needs, and the only origins the extension
  // can ever be granted. The options page asks for them and the worker matches its content
  // script against them, so the two must name the same set.
  const ALL_SITES_ORIGINS = Object.freeze(['http://*/*', 'https://*/*']);

  // Reads the choice out of whichever shape storage holds, so callers never see the older
  // one. Before the three states there was an `inlineAutoShow` boolean: on meant the button
  // appeared on every page, which is the all-pages choice. Off or absent maps to never —
  // and that does change what an existing install does, because the button used to appear
  // on invocation whatever the checkbox said. Making that behaviour choosable instead of
  // implicit is the point of the setting.
  function readButtonVisibility(settings) {
    const chosen = settings?.buttonVisibility;
    if (BUTTON_VISIBILITY_CHOICES.includes(chosen)) return chosen;
    return settings?.inlineAutoShow
      ? BUTTON_VISIBILITY.ALL_PAGES
      : BUTTON_VISIBILITY.NEVER;
  }

  const api = {
    ALL_SITES_ORIGINS,
    BUTTON_VISIBILITY,
    readButtonVisibility,
  };
  globalScope.ChromeAiTranslatorButtonVisibility = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
