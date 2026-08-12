# Chrome AI Translator

A personal Chrome extension that translates web pages with the OpenAI Responses API. It offers two distinct translation experiences over the same page, and most of the vocabulary below exists to keep those two apart.

## Language

**Side Panel Translation**:
Translation of a page's article body into Markdown, presented in Chrome's side panel beside the untouched page.
_Avoid_: document translation, full-page translation, panel mode

**Inline Translation**:
Translation of a page's article content in place, one Semantic Block at a time, as the reader scrolls. Inline elements such as links, emphasis, and code survive the replacement and may move to match the translated word order.
_Avoid_: in-page translation, overlay translation, live translation, text-node translation

**Semantic Block**:
The unit Inline Translation works in: one paragraph, heading, list item, or table cell, taken whole. Progress counts, size limits, and retries are all expressed in these.
_Avoid_: node, chunk, segment, fragment

**Floating Translate Button**:
The control anchored to the page's bottom-right corner that is one of the two entry points to Inline Translation, the other being the Inline Translation Section. It is rendered over the host page and belongs to the extension, not to the site. It carries the controls alone: progress and errors are reported in the Inline Translation Section.
_Avoid_: FAB, inline button, page button, widget

**Inline Translation Section**:
The side panel's own home for Inline Translation, carrying the same start, stop, and restore controls as the Floating Translate Button, and the only place Inline Translation reports progress and errors. It is separate from the Side Panel Translation controls beside it, which translate something else, put the result somewhere else, and need different permissions.
_Avoid_: inline panel, panel controls, inline pane

**Button Visibility**:
The reader's standing choice about when the Floating Translate Button may appear: never, only once the extension has been invoked on that page, or on every ordinary web page. The last of these grants the extension access to all sites; the others revoke it.
_Avoid_: auto-show, always-on, auto-inject

**Inline Translation Authorization**:
The time-limited permission to run Inline Translation on a page, granted by a deliberate reader gesture through the extension. Inline Translation refuses to start without it; Side Panel Translation does not require it.
_Avoid_: inline consent, activeTab grant
