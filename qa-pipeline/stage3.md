# Stage 3 — Fix Confirmed

## Root Cause

`public/js/components/TerminalPane.js` and `public/js/components/ProjectTerminalPane.js` — `attachCustomKeyEventHandler` (lines 96–115 / 85–103 respectively). The handler only intercepted Ctrl+C/Cmd+C/Ctrl+Shift+C. Ctrl+V was left unhandled, so xterm.js consumed it internally via `navigator.clipboard.readText()` (text-only). The DOM `paste` event listener (`handlePaste`) was therefore unreachable for keyboard-triggered paste, meaning images in the clipboard were silently ignored.

## Fix

Added Ctrl+V / Cmd+V interception inside `attachCustomKeyEventHandler` in both components:
- When Ctrl+V is pressed, calls `navigator.clipboard.read()` to check for image types
- If an image is found, posts the blob to `/api/paste-image`, then calls `xterm.paste(path)` and `showToast('Image saved — path pasted', 'success')`
- Falls back to `navigator.clipboard.readText()` + `xterm.paste(text)` when no image is present
- Falls back to text paste if `clipboard.read()` is not permitted
- Returns `false` to block xterm's own Ctrl+V handling in all cases

Also removed the now-dead DOM `paste` event listener (`handlePaste` function definition, `container.addEventListener('paste', handlePaste)`, and `container.removeEventListener('paste', handlePaste)`) from both components.

## Evidence

```
Running 1 test using 1 worker

  [T1] tmpDir: /tmp/qa-imgpaste-2WxuxI

  [srv] [server] claude-web-app-v2 listening on http://127.0.0.1:3099

  [T1] Server ready on port 3099

  [srv] [ws] client connected: 061a06f0-1d3e-4d33-a622-f22936596be2

  [T1] bash session created: 26ecf7a2-ad80-473d-93c3-848b58f9aa0b

  [T1] Session running

  [T1] Navigating to app

  [T1] Selecting project in sidebar

  [T1] Opening bash session card

  [T1] Session overlay visible

  [T1] Writing PNG image to clipboard via navigator.clipboard.write()

  [T1] Clipboard write result: {"ok":false,"error":"Failed to execute 'write' on 'Clipboard': Failed to read or decode ClipboardItemData for type image/png."}

  [T1] Clipboard API not available in headless — using synthetic ClipboardEvent fallback

  [T1] Synthetic event dispatch: {"ok":false,"error":"DataTransfer.items.add failed: Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'."}

  [T1] Injecting navigator.clipboard.read() mock so Ctrl+V path can exercise image branch

  [T1] Clicking xterm screen to focus

  [T1] Pressing Ctrl+V

  [T1] /api/paste-image intercepted (call #1)

  [T1] Toast "Image saved — path pasted" confirmed

  [T1] /api/paste-image calls intercepted: 1

  [T1] PASS — toast visible, fetch confirmed

  1 passed (9.4s)
```

## Causal Audit

Does the fix touch the code paths identified in spec.md's Preliminary Investigation?
Yes: The fix adds Ctrl+V interception to `attachCustomKeyEventHandler` in both `TerminalPane.js` and `ProjectTerminalPane.js` — exactly the function identified as failing to intercept Ctrl+V. The fix calls `navigator.clipboard.read()` (not `readText()`) so that image types are visible, matching the identified root cause.
