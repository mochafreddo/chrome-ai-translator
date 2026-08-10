# Chrome AI Translator

A personal Chrome extension that translates web pages with the OpenAI Responses API. It offers two distinct translation experiences over the same page, and most of the vocabulary below exists to keep those two apart.

## Language

**Side Panel Translation**:
Translation of a page's article body into Markdown, presented in Chrome's side panel beside the untouched page.
_Avoid_: document translation, full-page translation, panel mode

**Inline Translation**:
Translation of a page's text in place, replacing the visible text on the page itself as the reader scrolls.
_Avoid_: in-page translation, overlay translation, live translation

**Floating Translate Button**:
The control anchored to the page's bottom-right corner that is the entry point to Inline Translation. It is rendered over the host page and belongs to the extension, not to the site.
_Avoid_: FAB, inline button, page button, widget

**Button Visibility**:
The reader's standing choice about when the Floating Translate Button may appear: never, only once the extension has been invoked on that page, or on every ordinary web page. The last of these grants the extension access to all sites; the others revoke it.
_Avoid_: auto-show, always-on, auto-inject

**Inline Translation Authorization**:
The time-limited permission to run Inline Translation on a page, granted by a deliberate reader gesture through the extension. Inline Translation refuses to start without it; Side Panel Translation does not require it.
_Avoid_: inline consent, activeTab grant
