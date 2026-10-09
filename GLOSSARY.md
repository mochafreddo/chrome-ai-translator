# Chrome AI Translator

Vocabulary for the extension's two translation experiences. Placeholder Token is shared by both; the other terms distinguish their content, controls, and lifetimes. Current behavior and implementation responsibilities are described in the [architecture reference](docs/architecture.md).

## Language

**Side Panel Translation**:
Translation of a page's article body into Markdown, presented in Chrome's side panel beside the unchanged page.
_Avoid_: document translation, full-page translation, panel mode

**Translation Chunk**:
A block-aligned portion of an article's Markdown translated as a unit by Side Panel Translation. A block is never split between Translation Chunks.
_Avoid_: batch, section, page part

**Inline Translation**:
Translation of a page's article content in place, one Semantic Block at a time as the reader scrolls. Page-owned inline elements survive the replacement and may move with the translated word order.
_Avoid_: in-page translation, overlay translation, live translation, text-node translation

**Failed Semantic Block**:
A Semantic Block for which no acceptable Inline Translation could be safely applied, leaving its original content in place. Its failure is independent of sibling Semantic Blocks.
_Avoid_: failed translation, rejected result, request failure

**Partial Translation**:
An applied Inline Translation that still contains a material amount of source-language prose after its allowed repair. Isolated technical names and Source Syntax do not make a translation partial.
_Avoid_: warning, degraded translation, incomplete result

**Semantic Block**:
The own prose of one paragraph, heading, list item, quotation, caption, disclosure summary, term or definition, or table cell, taken whole by Inline Translation and excluding any Block Child.
_Avoid_: node, chunk, segment, fragment

**Block Child**:
A page-owned block-level child at the leading or trailing edge of a Semantic Block's own prose, retained in its position and excluded from that parent's translation. Semantic Blocks within it have independent translations.
_Avoid_: block atom, nested chunk, protected block

**Inert Page Node**:
A page-owned node whose identity is preserved but that exposes no visible or accessible language, role, focus, action, or editing semantics, such as a separator comment or a text-free decoration. A hidden responsive alternative may contain text when its visible counterpart is structurally identifiable; other hidden prose is not inert.
_Avoid_: decorative atom, trusted node, opaque node

**Placeholder Token**:
A stand-in for page-owned structure that translation preserves while reordering the surrounding prose. Both translation experiences use it for structure such as links or code; Inline Translation also uses it for wrappers and Inert Page Nodes.
_Avoid_: bare token (ambiguous with a model token or a request correlation token), marker, tag, sentinel, protected span

**Source Syntax**:
Visible page-owned notation whose spelling and delimiters carry meaning, such as an unambiguous repository coordinate, path, or bracketed choice. Inline Translation preserves it unchanged; it is distinct from a Placeholder Token inserted by the extension.
_Avoid_: code, literal token, protected text, technical term

**Inline Translation Session**:
One page visit over which the Session Budget and reusable Inline Translations persist. It ends when the page is reloaded or left, rather than when translation is stopped or original text is restored.
_Avoid_: reading session, run, operation, tab session

**Inline Translation Operation**:
One active stretch of Inline Translation within a Session, ending when the reader stops it or restores original text. Starting while it is active rescans visible content within the same Operation.
_Avoid_: run (used by diagnostics for a batch request), session (the whole page visit)

**Session Budget**:
A runaway guard on cumulative serialized Semantic Block record cost within one Inline Translation Session, including reported repairs. It is not a monetary spending ceiling, and a new page visit has a new budget.
_Avoid_: character limit, quota, spending limit, budget cap

**Floating Translate Button**:
The extension-owned control at the page's bottom-right corner, providing Inline Translation start, stop, and restore actions. Progress and errors appear in the Inline Translation Section.
_Avoid_: FAB, inline button, page button, widget

**Inline Translation Section**:
The side panel's home for Inline Translation controls, progress, and errors, separate from its Side Panel Translation controls.
_Avoid_: inline panel, panel controls, inline pane

**Inline Translation Shortcut**:
The keyboard shortcut that starts Inline Translation on the current page and opens the side panel to report its progress. Stop and restore actions remain in the two control surfaces.
_Avoid_: hotkey, keybinding, translate command, translate current tab

**Button Visibility**:
The reader's standing choice of when the Floating Translate Button may appear: never, after invoking the extension on a page, or on every ordinary web page.
_Avoid_: auto-show, always-on, auto-inject

**Inline Translation Authorization**:
The time-limited permission to start Inline Translation on a page, granted by a deliberate reader gesture through the extension. Side Panel Translation does not require this separate authorization.
_Avoid_: inline consent, activeTab grant
