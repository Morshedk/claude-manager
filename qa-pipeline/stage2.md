# Stage 2 — Bug Confirmed

## Test Output (pre-fix run)

```
Running 1 test using 1 worker

  [T1] tmpDir: /tmp/qa-imgpaste-qLL5T0

  [srv] [server] claude-web-app-v2 listening on http://127.0.0.1:3099

  [T1] Server ready on port 3099

  [srv] [ws] client connected: 1c794502-b458-4da0-ae18-89b0aae7b20c

  [T1] bash session created: 73ee2ad5-e613-4c13-85d4-8be2e520cae0

  [T1] Session running

  [srv] [ws] client disconnected: 1c794502-b458-4da0-ae18-89b0aae7b20c (code=1005 reason=)


  [T1] Navigating to app

  [srv] [ws] client connected: 162420b3-9cce-4e5c-bb42-20456b7edc8d

  [T1] Selecting project in sidebar

  [T1] Opening bash session card

  [T1] Session overlay visible

  [T1] Writing PNG image to clipboard via navigator.clipboard.write()

  [T1] Clipboard write result: {"ok":false,"error":"Failed to execute 'write' on 'Clipboard': Failed to read or decode ClipboardItemData for type image/png."}

  [T1] Clipboard API not available in headless — using synthetic ClipboardEvent fallback

  [T1] Synthetic event dispatch: {"ok":false,"error":"DataTransfer.items.add failed: Failed to execute 'add' on 'DataTransferItemList': parameter 1 is not of type 'File'."}

  [T1] Both clipboard approaches failed — falling back to keyboard Ctrl+V only

  [T1] Clicking xterm screen to focus

  [T1] Pressing Ctrl+V

  1) [chromium] › tests/adversarial/image-paste-xterm-T1-ctrl-v.test.js:187:3 › image-paste-xterm-T1 — Ctrl+V with image triggers upload and toast › T1 — Ctrl+V with image in clipboard triggers /api/paste-image and shows toast

    Error: Toast "Image saved — path pasted" must be visible within 3 s of Ctrl+V with an image in the clipboard

    expect(locator).toBeVisible() failed

    Locator: locator('text=Image saved — path pasted')
    Expected: visible
    Timeout: 3000ms
    Error: element(s) not found

    Call log:
      - Toast "Image saved — path pasted" must be visible within 3 s of Ctrl+V with an image in the clipboard with timeout 3000ms
      - waiting for locator('text=Image saved — path pasted')


      394 |         toastLocator,
      395 |         'Toast "Image saved — path pasted" must be visible within 3 s of Ctrl+V with an image in the clipboard',
    > 396 |       ).toBeVisible({ timeout: 3000 });
          |         ^
      397 |
      398 |       console.log('  [T1] Toast "Image saved — path pasted" confirmed');

  1 failed
    [chromium] › tests/adversarial/image-paste-xterm-T1-ctrl-v.test.js:187:3 › image-paste-xterm-T1 — Ctrl+V with image triggers upload and toast › T1 — Ctrl+V with image in clipboard triggers /api/paste-image and shows toast
```

## Conclusion

Bug confirmed. The test reaches the correct path (real Ctrl+V via `page.keyboard.press('Control+v')` on the focused xterm), then times out waiting for the toast. This is exactly the expected failure:
- `attachCustomKeyEventHandler` in TerminalPane.js does not intercept Ctrl+V
- xterm.js internally handles Ctrl+V via `navigator.clipboard.readText()` (text-only)
- The DOM paste event never fires for keyboard-triggered paste
- No fetch to `/api/paste-image` occurs
- Toast assertion times out
