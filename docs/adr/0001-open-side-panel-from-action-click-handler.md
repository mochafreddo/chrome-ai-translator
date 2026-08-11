# Open the side panel from our own action-click handler

Status: accepted

Chrome offers `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` as a convenience: the browser opens the side panel when the toolbar icon is clicked, with no extension code involved. We set it, and we also registered a `chrome.action.onClicked` listener to mount the Floating Translate Button, grant Inline Translation Authorization, and start a Side Panel Translation. These two are mutually exclusive — when the browser handles the click, the click is never delivered to the extension, so `onClicked` does not fire and no `activeTab` grant is issued. Both were present from the initial commit, so the toolbar-icon path never once ran any of that code; the keyboard command was the only working entry point. We therefore set `openPanelOnActionClick` to `false` and call `chrome.sidePanel.open({ tabId })` ourselves from inside `onClicked`.

## Consequences

- Opening the panel is now our responsibility. If `sidePanel.open()` throws, the toolbar icon does nothing at all — previously the panel opened regardless. This is the real cost of the decision.
- `sidePanel.open()` may only be called while the user gesture is still live, so it must be the **first** call in the `onClicked` handler. Awaiting anything before it forfeits the gesture and the call fails. Since Button Visibility landed, the handler reaches it through `runInvocation`, which starts the panel-opening step before its own first `await` and then hands the running step to the plan: the rest of an invocation depends on a setting only storage can answer, and reading it first would spend the gesture. The constraint is unchanged — only the call is one frame further away, and a test asserts the panel call precedes the settings read.
- The toolbar icon reaches the extension at all, which it never previously did. It is deliberately **not** identical to the keyboard command: the icon opens the panel and grants access without starting a Side Panel Translation, while the command — named "Translate current tab" — still starts one. Do not restore symmetry by making the icon translate; that reinstates a per-click API cost that was rejected on purpose.

## Do not revert this

Setting `openPanelOnActionClick` back to `true` looks like a simplification — deleting code in favour of a built-in browser behaviour. It is not. It silently disables the `onClicked` listener again, and the symptoms are indirect: the Floating Translate Button stops appearing, and Side Panel Translation fails with a message blaming `chrome://` pages when the real cause is a missing `activeTab` grant.
