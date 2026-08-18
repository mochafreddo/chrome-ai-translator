# Chrome AI Translator

A personal Chrome extension that translates web pages with the OpenAI Responses API. It offers two distinct translation experiences over the same page, and most of the vocabulary below exists to keep those two apart.

## Language

**Side Panel Translation**:
Translation of a page's article body into Markdown, presented in Chrome's side panel beside the untouched page.
_Avoid_: document translation, full-page translation, panel mode

**Translation Chunk**:
The unit Side Panel Translation works in: as much of the article's Markdown as one request may carry, cut at block boundaries so no block is split across two. Size limits and recovery are expressed in these — recovery from an over-long answer and from one that comes back without the placeholders it was sent, and a chunk gets one recovery in all (ADR-0005). A chunk that fails anyway ends the whole translation, and the chunks already translated are discarded with it: there is no partly-translated result to name (ADR-0006). Only Side Panel Translation has them.
_Avoid_: batch, section, page part

**Inline Translation**:
Translation of a page's article content in place, one Semantic Block at a time, as the reader scrolls. Inline elements such as links, emphasis, and code survive the replacement and may move to match the translated word order.
_Avoid_: in-page translation, overlay translation, live translation, text-node translation

**Semantic Block**:
The unit Inline Translation works in: one paragraph, heading, list item, or table cell, taken whole. Progress counts, size limits, and retries are all expressed in these. Not a Translation Chunk, which belongs to the other translation and holds many of these.
_Avoid_: node, chunk, segment, fragment

**Inline Translation Session**:
The span the Session Budget is counted over: one page visit. It begins when the page loads and ends when the page is reloaded or left. It is not ended by **Original text** and not ended by stopping — both carry the Session Budget forward, so neither is a way to start spending afresh. It bounds one visit to one page, not the reader's spending: a reader who reloads three times has three of these and pays for all three.
_Avoid_: reading session, run, operation, tab session

**Session Budget**:
What one Inline Translation Session may spend, counted as the serialized size of the Semantic Block records sent — the initial request for each block, plus a second charge for a block whose answer needed a repair. It is a runaway guard, not a spending ceiling: its job is to catch an accounting slip or a pathological page before it empties the reader's account, and no spending ceiling exists in this extension. A page that reaches it is refused its next batch and told to reload; nothing is refunded, and the guard says no figure to the reader because the figure counts serialized records rather than anything on the page they can see (ADR-0007).
_Avoid_: character limit, quota, spending limit, budget cap

**Floating Translate Button**:
The control anchored to the page's bottom-right corner that is one of the two homes of Inline Translation's controls, the other being the Inline Translation Section. It is rendered over the host page and belongs to the extension, not to the site. It carries the controls alone: progress and errors are reported in the Inline Translation Section.
_Avoid_: FAB, inline button, page button, widget

**Inline Translation Section**:
The side panel's own home for Inline Translation, carrying the same start, stop, and restore controls as the Floating Translate Button, and the only place Inline Translation reports progress and errors. It is separate from the Side Panel Translation controls beside it, which translate something else, put the result somewhere else, and need different permissions.
_Avoid_: inline panel, panel controls, inline pane

**Inline Translation Shortcut**:
The keyboard shortcut that starts Inline Translation on the page the reader is on. It is a third way in but not a third home for the controls: it only starts, and it opens the side panel so the Inline Translation Section can report what follows. Stopping and restoring stay with the two homes, where what a control will do is visible before it is pressed.
_Avoid_: hotkey, keybinding, translate command, translate current tab

**Button Visibility**:
The reader's standing choice about when the Floating Translate Button may appear: never, only once the extension has been invoked on that page, or on every ordinary web page. The last of these grants the extension access to all sites; the others revoke it.
_Avoid_: auto-show, always-on, auto-inject

**Inline Translation Authorization**:
The time-limited permission to run Inline Translation on a page, granted by a deliberate reader gesture through the extension. Inline Translation refuses to start without it; Side Panel Translation does not require it.
_Avoid_: inline consent, activeTab grant
