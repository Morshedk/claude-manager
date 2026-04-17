# Terminal Copy & Scrollbar -- Test Designs

Lifecycle stories from design Section 4, plus adversarial edge cases from the review.

---

### T-1: Ctrl+C with selection copies text, does NOT send SIGINT
**Flow:**
1. Start server on port 3200 with a fresh DATA_DIR. Create a project and a session via REST+WS.
2. Open the browser, navigate to the project, click the session card to open the overlay.
3. Wait for `.xterm` to render. Send input via WS (`session:input`) to print a known string: `echo "COPY_TARGET_abc123"` followed by Enter.
4. Wait 1 second for the output to render.
5. Use `page.evaluate` to programmatically select text in xterm: call `document.querySelector('.xterm').__xtermInstance` -- but since xterm is not exposed that way, instead use the Playwright approach: get the xterm viewport, use `page.evaluate` to access the xterm instance via the component's ref or the Terminal's selection API. Specifically: call `page.evaluate(() => { const term = document.querySelector('.xterm-screen').closest('.xterm')._xterm || window._xtermDebug; ... })`. If direct xterm access is not available, use mouse drag: locate the text "COPY_TARGET_abc123" by finding the xterm-rows element, compute coordinates of the text, then `page.mouse.move(x1, y1)`, `page.mouse.down()`, `page.mouse.move(x2, y2)`, `page.mouse.up()` to create a selection.
6. After selection, dispatch a keyboard event: `page.keyboard.down('Control')`, `page.keyboard.press('c')`, `page.keyboard.up('Control')`.
7. Wait 500ms.
8. Read the clipboard via `page.evaluate(() => navigator.clipboard.readText())`.
9. Also verify that no `^C` appeared in the terminal output after the copy (check that the terminal buffer does not contain the SIGINT marker `^C` after the copy line).

**Pass condition:** Clipboard contains `COPY_TARGET_abc123` (or the selected substring). No `^C` appears in the terminal after the Ctrl+C press. A toast element with text "Copied to clipboard" appeared in the DOM.

**Fail signal:** (a) Clipboard is empty -- the handler did not fire or `navigator.clipboard.writeText` was not called. (b) `^C` appears after the copy -- the handler returned `true` instead of `false`, so SIGINT was sent alongside the copy. This is the Risk 1 false-PASS: clipboard has the text but the process also got killed.

**Test type:** Playwright browser

**Port:** 3200

---

### T-2: Ctrl+C with NO selection sends SIGINT (does not copy)
**Flow:**
1. Start server on port 3201, create project and session.
2. Open browser, navigate to session overlay, wait for xterm.
3. Send input via WS: `sleep 30` + Enter. Wait 1 second for the command to start.
4. Ensure no text is selected: `page.evaluate(() => { /* xterm selection should be empty by default */ })`.
5. Press Ctrl+C via `page.keyboard.down('Control')`, `page.keyboard.press('c')`, `page.keyboard.up('Control')`.
6. Wait 2 seconds.
7. Verify the terminal output contains `^C` (the SIGINT echo from bash).
8. Verify no toast appeared (no element matching `.toast` with "Copied to clipboard" in the DOM).
9. Send `echo "STILL_ALIVE"` + Enter and verify the output appears (proving the shell is responsive again, meaning SIGINT was delivered and the sleep was interrupted).

**Pass condition:** `^C` appears in terminal output. No copy toast appeared. Shell is responsive (prints `STILL_ALIVE`).

**Fail signal:** (a) No `^C` in output and `sleep 30` keeps running -- the handler swallowed Ctrl+C even without a selection. This is Risk 5: all Ctrl+C intercepted. (b) A toast appeared -- handler incorrectly detected a selection when none existed.

**Test type:** Playwright browser

**Port:** 3201

---

### T-3: Scrollbar always visible without hover
**Flow:**
1. Start server on port 3202, create project and session.
2. Open browser, navigate to session overlay, wait for xterm.
3. Send enough output to create scrollback: send `seq 1 500` + Enter via WS. Wait 2 seconds.
4. Without hovering over the terminal (move mouse to top-left corner of the page first: `page.mouse.move(0, 0)`), evaluate the computed style of `.xterm-viewport`:
   - Check `getComputedStyle(vp).scrollbarWidth` equals `'thin'` (Firefox path).
   - For WebKit/Blink: check that no CSS rule sets the thumb to `rgba(255,255,255,0)` or `rgba(255,255,255,0.0)` -- instead check the stylesheet rules for `.xterm-viewport::-webkit-scrollbar-thumb` and verify the `background` value contains `0.2` (not `0.0`).
5. Check the `::-webkit-scrollbar` width rule on `.xterm-viewport` equals `6px` (not `4px`).
6. Hover over the `.xterm-viewport` element.
7. Check that the hover CSS rule sets scrollbar-color to `rgba(255,255,255,0.4)` (Firefox) or the thumb background changes to `0.4` opacity.

**Pass condition:** At rest (no hover), the scrollbar thumb has non-zero opacity (0.2 alpha). Width is 6px. On hover, the thumb brightens to 0.4 alpha. No `transparent transparent` or `0.0` alpha values found in the active scrollbar rules for `.xterm-viewport`.

**Fail signal:** (a) Thumb is transparent at rest -- the old hover-only CSS is still active, possibly due to CSS specificity conflict with `xterm.min.css` (Risk 3). (b) Width is 4px -- the old width was not updated. (c) Hover does not change brightness -- the hover rule is missing or overridden.

**Test type:** Playwright browser

**Port:** 3202

---

### T-4: Right-click copies selection and suppresses context menu
**Flow:**
1. Start server on port 3203, create project and session.
2. Open browser, navigate to session overlay, wait for xterm.
3. Send `echo "RIGHTCLICK_HASH_a3f7b2c"` + Enter. Wait 1 second.
4. Select text in the terminal by mouse-dragging across `a3f7b2c` (compute coordinates from the xterm-rows element position and character width).
5. Right-click within the selected area: `page.mouse.click(x, y, { button: 'right' })`.
6. Wait 500ms.
7. Check clipboard contains `a3f7b2c` (or the selected text).
8. Check that no browser context menu appeared: verify no `contextmenu` default behavior triggered by checking that the selection was cleared (xterm's selection should be empty after the handler runs).
9. Verify a "Copied to clipboard" toast appeared.

**Pass condition:** Clipboard contains the selected text. Selection is cleared. Toast appeared. No context menu was shown (the `contextmenu` event was `preventDefault()`-ed).

**Fail signal:** (a) Context menu appeared AND text was copied -- `preventDefault()` was not called. (b) Context menu appeared and text was NOT copied -- the handler did not fire at all, possibly due to event ordering (Risk 7: the contextmenu fires before xterm's word selection completes, so `hasSelection()` returns false).

**Test type:** Playwright browser

**Port:** 3203

---

### T-5: Ctrl+Shift+C copies when selection exists, does NOT send SIGINT when no selection
**Flow:**
1. Start server on port 3204, create project and session.
2. Open browser, navigate to session overlay, wait for xterm.
3. Send `echo "SHIFT_COPY_TEST"` + Enter. Wait 1 second.
4. **Part A -- with selection:** Select text "SHIFT_COPY_TEST" via mouse drag. Press Ctrl+Shift+C. Verify clipboard contains the selected text. Verify no `^C` in terminal output.
5. **Part B -- without selection:** Clear any selection (click somewhere neutral). Start `sleep 30` + Enter. Press Ctrl+Shift+C (no selection). Wait 2 seconds. Verify `sleep 30` is STILL RUNNING (no `^C`, no shell prompt returned). This confirms that Ctrl+Shift+C without selection does nothing -- it does not send SIGINT. This is the Linux convention where Ctrl+Shift+C is exclusively a copy shortcut.
6. Press Ctrl+C (plain, no Shift) to actually interrupt the sleep. Verify `^C` appears and the shell returns.

**Pass condition:** Part A: clipboard has selected text, no SIGINT sent. Part B: Ctrl+Shift+C without selection does NOT interrupt the running process (sleep continues). Plain Ctrl+C does interrupt it.

**Fail signal:** (a) Ctrl+Shift+C sends SIGINT when no selection exists -- the `isCopyAlt` branch returned `true` instead of `false`. (b) Ctrl+Shift+C with selection does not copy -- the uppercase `'C'` key check failed (the handler checks for lowercase `'c'` instead of uppercase `'C'`).

**Test type:** Playwright browser

**Port:** 3204

---

### T-6: Copy works in readOnly mode (TerminalPane)
**Flow:**
1. Start server on port 3205, create project and session.
2. Open the browser. Instead of clicking the session card normally, manipulate the app state or use a URL/query parameter that opens the terminal in readOnly mode. If the app does not expose readOnly via URL, use `page.evaluate` to unmount and remount the TerminalPane with `readOnly: true` -- or, more practically, verify at the code level: check that `attachCustomKeyEventHandler` is called outside the `if (!readOnly)` guard by reading the source. Then test functionally: open the terminal normally, select text, copy it, and verify the handler works. The key assertion is that the copy handler fires regardless of input mode.
3. Alternatively, a simpler approach: open the terminal, select text, press Ctrl+C, verify clipboard is populated. Then check that the `customKeyEventHandler` registration line number is before the `if (!readOnly)` block in the source code (static analysis assertion).

**Pass condition:** `attachCustomKeyEventHandler` is registered at a line number BEFORE the `if (!readOnly)` guard in TerminalPane.js. Functional copy works in a normal terminal (verifying the handler fires). Combined, these prove the handler would also fire in readOnly mode.

**Fail signal:** The `attachCustomKeyEventHandler` call is inside the `if (!readOnly)` block -- copy would silently not work for readOnly terminals, which is a usability regression for view-only sessions.

**Test type:** Playwright browser + static source analysis

**Port:** 3205

---

### T-7: Adversarial -- rapid Ctrl+C with flickering selection
**Flow:**
1. Start server on port 3206, create project and session.
2. Open browser, navigate to session overlay, wait for xterm.
3. Send `yes "line_output"` + Enter (this produces continuous output, flooding the terminal).
4. Wait 500ms for output to start flowing.
5. In rapid succession (within 200ms total), perform: select text (mouse drag), Ctrl+C, select text, Ctrl+C, select text, Ctrl+C -- three copy attempts with selections interleaved.
6. Wait 1 second.
7. Check that: (a) at least one toast appeared (copy was attempted), (b) the `yes` process was eventually interrupted (because between rapid select-copy cycles, there may be a moment with no selection where Ctrl+C passes through as SIGINT), OR the process is still running (all three Ctrl+C were intercepted as copies because selections were active). Either outcome is acceptable -- the test verifies the system does not crash, throw unhandled errors, or enter a broken state.
8. Verify no JavaScript errors in the browser console related to clipboard or xterm.
9. Verify the terminal is still functional: clear any running process with a plain Ctrl+C (no selection), then `echo "ALIVE"` + Enter, verify output appears.

**Pass condition:** No unhandled exceptions. Terminal remains functional after the rapid-fire interaction. At least one clipboard write succeeded (toast appeared).

**Fail signal:** (a) Unhandled promise rejection from `navigator.clipboard.writeText` -- the error path `.catch()` was missing or broken. (b) Terminal becomes unresponsive -- the handler entered a bad state. (c) Browser console shows errors from xterm.js -- `getSelection()` or `clearSelection()` threw during rapid calls.

**Test type:** Playwright browser

**Port:** 3206

---

### T-8: ProjectTerminalPane has identical copy behavior
**Flow:**
1. Start server on port 3207, create a project.
2. Create a project terminal via WS (send `terminal:create` with the project's working directory).
3. Open the browser, navigate to the project detail view where the ProjectTerminalPane is mounted.
4. Wait for the `.xterm` element in the project terminal area (not the session overlay).
5. Send input to the project terminal: `echo "PROJECT_TERM_COPY"` + Enter.
6. Wait 1 second.
7. Select the text "PROJECT_TERM_COPY" via mouse drag in the project terminal pane.
8. Press Ctrl+C.
9. Verify clipboard contains the selected text.
10. Verify a "Copied to clipboard" toast appeared.
11. Press Ctrl+C with no selection and verify SIGINT is sent (the shell is interrupted or shows `^C`).

**Pass condition:** Copy behavior in ProjectTerminalPane is identical to TerminalPane -- clipboard populated, toast shown, SIGINT blocked when selection exists, SIGINT passed when no selection.

**Fail signal:** (a) No copy handler fires -- ProjectTerminalPane was not updated (Risk 8). (b) Toast does not appear -- `showToast` import was forgotten in ProjectTerminalPane.js. (c) The handler fires but clipboard is empty -- a subtle difference in how ProjectTerminalPane accesses the xterm instance.

**Test type:** Playwright browser

**Port:** 3207
