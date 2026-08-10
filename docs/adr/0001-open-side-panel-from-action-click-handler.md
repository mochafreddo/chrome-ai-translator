# Open the side panel from our own action-click handler

Status: accepted

Chrome offers `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` as a convenience: the browser opens the side panel when the toolbar icon is clicked, with no extension code involved. We set it, and we also registered a `chrome.action.onClicked` listener to mount the Floating Translate Button, grant Inline Translation Authorization, and start a Side Panel Translation. These two are mutually exclusive — when the browser handles the click, the click is never delivered to the extension, so `onClicked` does not fire and no `activeTab` grant is issued. Both were present from the initial commit, so the toolbar-icon path never once ran any of that code; the keyboard command was the only working entry point. We therefore set `openPanelOnActionClick` to `false` and call `chrome.sidePanel.open({ tabId })` ourselves from inside `onClicked`.

## Consequences

- Opening the panel is now our responsibility. If `sidePanel.open()` throws, the toolbar icon does nothing at all — previously the panel opened regardless. This is the real cost of the decision.
- `sidePanel.open()` may only be called while the user gesture is still live, so it must be the **first** call in the `onClicked` handler. Awaiting anything before it forfeits the gesture and the call fails.
- The toolbar icon and the keyboard command now do the same thing, which is what a reader would have assumed all along.

## Do not revert this

Setting `openPanelOnActionClick` back to `true` looks like a simplification — deleting code in favour of a built-in browser behaviour. It is not. It silently disables the `onClicked` listener again, and the symptoms are indirect: the Floating Translate Button stops appearing, and Side Panel Translation fails with a message blaming `chrome://` pages when the real cause is a missing `activeTab` grant.
