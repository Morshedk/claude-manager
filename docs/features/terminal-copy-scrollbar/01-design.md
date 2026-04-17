# Terminal Copy & Scrollbar — Design Document

## Section 1: Problem & Context

### The user problem

Users of the Claude Web App v2 cannot copy text from the terminal pane. When they see output they want to save — an error message, a file path, a code snippet, a URL — they have no way to select it and put it on the clipboard. This forces them to retype information by hand or screenshot it, which is a basic usability gap for any terminal-based tool.

Separately, the terminal pane has no visible scrollbar. The viewport is scrollable (xterm.js v5.5.0 renders into a `.xterm-viewport` div with `overflow-y: scroll`), and the app already has scroll tracking logic, but the scrollbar is invisible by default and only shows a faint 4px thumb on hover. Users who are not on trackpads — or who simply do not know the terminal is scrollable — have no visual affordance that more content exists above or below the visible area.

### What currently exists

**xterm.js v5.5.0 selection support (already available, not wired up):**
The vendored xterm.js (`public/vendor/xterm.min.js`, version 5.5.0) includes a full selection API: `xterm.getSelection()` returns the selected text as a string, `xterm.hasSelection()` returns a boolean, `xterm.clearSelection()` deselects, `xterm.selectAll()` selects all buffer content, `xterm.selectLines(start, end)` selects a line range, and `xterm.onSelectionChange` fires a callback when the selection changes. The library also supports `xterm.attachCustomKeyEventHandler(fn)` for intercepting keyboard shortcuts before they reach the default handler.

**Selection highlighting already works visually.** Both `TerminalPane.js` (line 12) and `ProjectTerminalPane.js` (line 12) configure `selectionBackground: 'rgba(0,212,170,0.25)'` in `XTERM_THEME`. The xterm.js constructor also sets `rightClickSelectsWord: true` (TerminalPane.js line 54, ProjectTerminalPane.js line 51). This means users can already click-and-drag to highlight text in the terminal — the teal selection highlight appears — but there is no mechanism to copy that selection to the system clipboard.

**The blocking CSS rule is in the vendor file.** `public/vendor/xterm.min.css` line 7 sets `.xterm { user-select: none; -ms-user-select: none; -webkit-user-select: none }`. This is the xterm.js default — it disables native browser text selection because xterm.js implements its own selection layer (drawn as a colored overlay on the WebGL/canvas renderer). The native browser Ctrl+C/Cmd+C shortcut does not work because (a) the terminal intercepts Ctrl+C as a SIGINT signal sent to the PTY, and (b) there is no code that calls `navigator.clipboard.writeText(xterm.getSelection())`.

**Two terminal pane components exist, both affected:**
- `public/js/components/TerminalPane.js` (lines 1–227) — used for Claude session terminals, mounted inside `SessionOverlay.js` (line 199). This is the primary terminal users interact with.
- `public/js/components/ProjectTerminalPane.js` (lines 1–167) — used for raw shell terminals attached to a project. Mounted in the terminals area of `ProjectDetail.js` (line 155, though the tab/content system is noted as "phase 5C").

Both components follow the same pattern: create a `Terminal` instance, load addons (FitAddon, Unicode11, WebGL, WebLinks), open into a container div, wire scroll tracking, wire `onData` for keyboard input, and subscribe to server events.

**Existing scrollbar CSS (`public/css/styles.css` lines 779–799):**
The terminal scrollbar section is titled "TERMINAL SCROLLBAR (minimalist, visible on hover)" and deliberately hides the scrollbar by default. On Firefox it uses `scrollbar-color: transparent transparent` (line 782), switching to `rgba(255,255,255,0.15) transparent` only when `.xterm:hover` (line 786). On WebKit/Blink it sets the thumb background to `rgba(255,255,255,0.0)` (line 791) — fully transparent — and only shows it at `rgba(255,255,255,0.15)` on `.xterm-viewport:hover` (lines 794–796). The scrollbar width is 4px (line 788). The intent was minimalism, but the result is that users do not know the terminal scrolls.

**Input handler filters in TerminalPane.js (lines 125–132):**
The `onData` callback already filters DA/DA2 escape responses, OSC sequences, and mouse events. It does not filter or intercept Ctrl+C. When the user presses Ctrl+C, xterm.js sends `\x03` (ETX) through `onData`, which the app forwards to the PTY as `CLIENT.SESSION_INPUT`. This is correct behavior for sending SIGINT — but it means there is no branch that checks "is there a selection? if so, copy instead of sending SIGINT."

### What's missing and why

1. **Copy-to-clipboard wiring.** No code anywhere calls `navigator.clipboard.writeText()` with `xterm.getSelection()`. The selection API exists in xterm.js but is not used.

2. **Ctrl+C / Cmd+C interception when text is selected.** When the user has highlighted text in the terminal and presses Ctrl+C, the expected behavior is "copy the selected text to clipboard" (matching every native terminal emulator). Currently, it sends SIGINT to the PTY regardless. A `customKeyEventHandler` is needed to intercept the keystroke, check `hasSelection()`, and divert to clipboard copy when appropriate.

3. **A visible, always-present scrollbar.** The current CSS makes the scrollbar invisible by default. Users need a persistent visual indicator that the terminal has scrollable content, with a thumb that is visible at all times (not just on hover), while remaining unobtrusive enough to not distract from terminal output.

4. **Copy feedback.** When the user copies text, there is no visual confirmation. A brief toast or visual flash would confirm the action succeeded — especially important because Ctrl+C has a dual meaning in terminal contexts and users need to know which interpretation fired.

---

## Section 2: Design Decision

### 2.1 What to build

Two capabilities, applied to both `TerminalPane.js` and `ProjectTerminalPane.js`:

**(A) Copy-to-clipboard via keyboard shortcut.** When the user presses Ctrl+C (or Cmd+C on macOS) and xterm has a selection, copy the selected text to the system clipboard and clear the selection. When there is no selection, let the keystroke pass through to xterm.js as normal (which sends `\x03` to the PTY). This is the standard behavior of iTerm2, Windows Terminal, GNOME Terminal, and every modern terminal emulator.

**(B) Right-click context copy.** Add a `customKeyEventHandler` that also enables right-click copy behavior. xterm.js v5.5.0 already sets `rightClickSelectsWord: true`, which selects a word on right-click. The design adds a context-aware right-click handler: if text is selected, copy it to clipboard (suppressing the browser context menu).

**(C) Always-visible terminal scrollbar.** Replace the current hover-only scrollbar CSS with a permanently visible scrollbar that uses the app's accent color scheme, is slightly wider (6px instead of 4px), and transitions to a brighter color on hover. This applies to all `.xterm-viewport` elements globally.

**(D) Copy toast feedback.** When a copy operation succeeds, show a brief toast notification ("Copied to clipboard") using the existing `showToast()` action from `public/js/state/actions.js`. This reuses the existing toast system (rendered by `ToastContainer` in `App.js` lines 19–50).

### 2.2 Files to modify

**1. `public/js/components/TerminalPane.js`**

- **After line 92 (after `xtermRef.current = { xterm, fitAddon };`):** Add a `customKeyEventHandler` registration on the xterm instance. This handler intercepts `keydown` events for Ctrl+C / Cmd+C. If `xterm.hasSelection()` is true, the handler calls `navigator.clipboard.writeText(xterm.getSelection())`, then calls `xterm.clearSelection()`, fires a toast via the imported `showToast`, and returns `false` (preventing xterm from processing the key). If there is no selection, it returns `true` (letting xterm send `\x03` as usual).

- **After the customKeyEventHandler block:** Add a `contextmenu` event listener on `container`. On right-click, if `xterm.hasSelection()`, call `navigator.clipboard.writeText(xterm.getSelection())`, clear the selection, show the toast, and call `e.preventDefault()` to suppress the browser context menu. If nothing is selected, let the default context menu appear.

- **Import:** Add `import { showToast } from '../state/actions.js';` at the top of the file (line 3 area).

- **Cleanup (return function, around line 212):** Remove the `contextmenu` event listener in the cleanup function.

**2. `public/js/components/ProjectTerminalPane.js`**

- **Same changes as TerminalPane.js** — add `customKeyEventHandler`, add `contextmenu` listener, import `showToast`, clean up on unmount. The insertion points are analogous: after line 81 (after `xtermRef.current = { xterm, fitAddon };`) for the handler, and in the cleanup return around line 154.

**3. `public/css/styles.css`**

- **Lines 779–799 (TERMINAL SCROLLBAR section):** Replace the entire block. The new rules make the scrollbar always visible with a semi-transparent thumb, wider (6px), and brighter on hover. Firefox uses `scrollbar-color` with a visible default color. WebKit uses `::-webkit-scrollbar-thumb` with a non-zero alpha at rest.

### 2.3 Files NOT to modify

- **`public/vendor/xterm.min.css`** — Do not edit the vendor file. The `user-select: none` in the vendor CSS is correct for xterm.js (it uses its own canvas-based selection, not browser native selection). Overriding it would break the rendering.
- **`public/vendor/xterm.min.js`** — Never modify vendored libraries.
- **`public/index.html`** — No new scripts or stylesheets needed. No clipboard addon is required; the Clipboard API (`navigator.clipboard.writeText`) is a standard browser API available in all modern browsers and all secure contexts (HTTPS or localhost).

### 2.4 Data flow

Copy operation flow:
1. User clicks and drags in the terminal canvas to select text. xterm.js internally tracks this selection.
2. User presses Ctrl+C (or Cmd+C).
3. `customKeyEventHandler` fires (synchronous, before xterm processes the key).
4. Handler calls `xterm.hasSelection()` — returns `true`.
5. Handler calls `xterm.getSelection()` — returns the selected text as a plain string.
6. Handler calls `navigator.clipboard.writeText(selectedText)` — returns a Promise (fire-and-forget for the handler; clipboard writes are near-instant).
7. Handler calls `xterm.clearSelection()` to deselect.
8. Handler calls `showToast('Copied to clipboard', 'success')` for user feedback.
9. Handler returns `false`, telling xterm.js to NOT process this keydown (so `\x03` is NOT sent to the PTY).

No-selection flow:
1. User presses Ctrl+C with no selection active.
2. `customKeyEventHandler` fires.
3. `xterm.hasSelection()` returns `false`.
4. Handler returns `true`, telling xterm.js to process the key normally.
5. xterm.js generates `\x03` via `onData`.
6. The existing `onData` handler in TerminalPane.js (line 131) sends it to the server as `CLIENT.SESSION_INPUT`.

Right-click flow:
1. User right-clicks in the terminal.
2. If `xterm.hasSelection()` is true: copy to clipboard, clear selection, show toast, prevent default (no browser context menu).
3. If no selection: allow default browser context menu to appear.

### 2.5 Edge cases and failure modes

**Clipboard API permission denial.** `navigator.clipboard.writeText()` can throw if the document is not focused or if the browser has restricted clipboard access. The handler should catch the rejection and show an error toast ("Copy failed — check clipboard permissions") rather than silently failing.

**Empty selection.** `xterm.getSelection()` can return an empty string if the user clicked without dragging. The handler should check `xterm.getSelection().length > 0` (not just `hasSelection()`) before attempting a copy. If the selection is empty, treat it as "no selection" and let Ctrl+C pass through as SIGINT.

**Ctrl+Shift+C convention.** Some Linux terminal emulators use Ctrl+Shift+C for copy (because Ctrl+C is SIGINT). The handler should also intercept Ctrl+Shift+C as a copy shortcut regardless of whether there is a selection — if there is a selection, copy it; if not, do nothing (do not send SIGINT). This gives Linux users a familiar alternative.

**Cmd+C on macOS.** The `metaKey` property on the KeyboardEvent distinguishes Cmd from Ctrl on macOS. The handler must check both `(e.ctrlKey && e.key === 'c')` and `(e.metaKey && e.key === 'c')`.

**readOnly mode in TerminalPane.** When `readOnly` is true (TerminalPane.js line 37), the input handler is not registered (line 124). However, copy should still work in readOnly mode — the `customKeyEventHandler` is about copying OUT of the terminal, not typing INTO it. The handler must be registered regardless of `readOnly`.

**Multiple terminals mounted simultaneously.** Each terminal pane instance registers its own `customKeyEventHandler` on its own xterm instance. There is no shared state or conflict — xterm.js scopes the handler to the instance, and only the focused terminal receives keyboard events.

**Very large selections.** `xterm.getSelection()` on a terminal with 10,000 lines of scrollback could return a very large string. `navigator.clipboard.writeText()` handles this fine — there is no practical size limit for clipboard text in modern browsers. No special handling needed.

**WebGL renderer and selection.** The WebGL renderer (loaded at TerminalPane.js line 80) supports the selection overlay natively. There is no compatibility issue between WebGL rendering and the selection API.

### 2.6 What NOT to build (scope boundary)

- **No "Select All" keyboard shortcut (Ctrl+A / Cmd+A).** Ctrl+A in a terminal sends SOH (`\x01`) to the PTY, which is "go to beginning of line" in bash/readline. Overriding this would break shell navigation. Users who want to select all can use `xterm.selectAll()` through a future UI button, but that is out of scope.
- **No clipboard paste interception.** Ctrl+V / Cmd+V paste is already handled by xterm.js natively (it reads from the clipboard and writes to the PTY via `onData`). No changes needed.
- **No "Copy" button in the terminal header/toolbar.** The feature request is about keyboard and mouse copy, not a UI button. Adding a button would require UI design for the overlay header and terminal tabs bar, which is a separate concern.
- **No "Copy as HTML" or "Copy with ANSI colors."** The copy operation produces plain text only, matching standard terminal behavior.
- **No custom context menu.** The right-click behavior is: if selection exists, copy and dismiss; if no selection, show the browser's native context menu. Building a custom context menu (with "Copy", "Paste", "Select All" items) is a larger UX project and out of scope.
- **No xterm-addon-clipboard.** The standard `navigator.clipboard` API is sufficient. The xterm clipboard addon is for environments where the Clipboard API is not available (e.g., non-secure contexts). This app runs on localhost or HTTPS, so the standard API is always available.

---

## Section 3: Acceptance Criteria

1. **Given** a terminal with visible output, **when** the user clicks and drags across text in the terminal, **then** the selected text is highlighted with the teal selection color (`rgba(0,212,170,0.25)`).

2. **Given** text is selected in the terminal, **when** the user presses Ctrl+C (or Cmd+C on macOS), **then** the selected text is copied to the system clipboard, the selection is cleared, and a "Copied to clipboard" toast appears.

3. **Given** no text is selected in the terminal, **when** the user presses Ctrl+C, **then** the keystroke is sent to the PTY as SIGINT (`\x03`) — no toast appears, and a running process in the terminal receives the interrupt signal.

4. **Given** text is selected in the terminal, **when** the user presses Ctrl+Shift+C, **then** the selected text is copied to the system clipboard and the selection is cleared (same behavior as Ctrl+C with selection).

5. **Given** text is selected in the terminal, **when** the user right-clicks, **then** the selected text is copied to the system clipboard, the selection is cleared, a toast appears, and the browser context menu does NOT appear.

6. **Given** no text is selected in the terminal, **when** the user right-clicks, **then** the browser's native context menu appears normally.

7. **Given** a terminal with scrollback content (more lines than the visible viewport), **when** the user looks at the terminal without hovering, **then** a scrollbar thumb is visible on the right edge of the terminal viewport, indicating scrollable content exists.

8. **Given** the visible scrollbar, **when** the user hovers over it, **then** the scrollbar thumb becomes brighter (higher contrast) to indicate it is interactive.

9. **Given** the scrollbar is visible, **when** the user clicks and drags the scrollbar thumb, **then** the terminal viewport scrolls correspondingly, matching the drag position.

10. **Given** a ProjectTerminalPane (raw shell terminal, not a session terminal), **when** the user selects text and presses Ctrl+C/Cmd+C, **then** copy behavior is identical to the session terminal — selected text is copied, no SIGINT is sent.

---

## Section 4: User Lifecycle Stories

### Story 1: Copying an error message from a Claude session

A developer opens the Claude Web App and clicks into a running Claude session. The session overlay opens, showing the terminal with Claude's output. Claude has printed a Python traceback — a multi-line error starting with `Traceback (most recent call last):` and ending with `ValueError: invalid literal for int()`. The developer clicks at the start of "Traceback" and drags to the end of the error message. The text highlights in teal. They press Ctrl+C. A small "Copied to clipboard" notification appears briefly at the bottom-right of the screen. The selection disappears. The developer switches to Slack and pastes the full traceback into a message to a colleague.

### Story 2: Ctrl+C dual behavior — copy vs. interrupt

A developer is running a long `npm test` suite in a Claude session terminal. They see it is taking too long and press Ctrl+C. There is no text selected, so the keystroke goes through to the PTY and interrupts the test runner. The terminal shows `^C` and the test suite stops. Later, the developer re-runs the tests and they complete. The output shows a line: `Tests: 47 passed, 3 failed`. The developer double-clicks on "47" (which selects the word), then presses Ctrl+C. This time, because text was selected, the word "47" is copied to the clipboard instead of interrupting the (already finished) process. The toast confirms "Copied to clipboard."

### Story 3: Discovering scrollable content via the scrollbar

A developer opens a session overlay. Claude has been working for several minutes and has produced hundreds of lines of output. The terminal shows the most recent lines. The developer notices a narrow scrollbar track on the right edge of the terminal with a small thumb near the bottom — indicating there is content above. They click the scrollbar track above the thumb, and the terminal jumps upward, showing earlier output. They drag the thumb all the way to the top and read Claude's initial responses. They then scroll back to the bottom by dragging the thumb down or clicking below it.

### Story 4: Right-click copy from a project shell terminal

A developer has a project shell terminal open in the bottom pane of the project detail view. They run `git log --oneline -5` and see a list of commit hashes. They click and drag to select a commit hash like `a3f7b2c`. They right-click. The hash is copied to their clipboard immediately — no context menu appears. They paste it into a `git cherry-pick` command in the same terminal.

### Story 5: Copy fails gracefully when clipboard is unavailable

A developer is using the app over an HTTP connection (not HTTPS, not localhost) on a corporate network where the Clipboard API is restricted. They select text in the terminal and press Ctrl+C. The copy attempt fails silently but gracefully — a toast appears saying "Copy failed — check clipboard permissions." The SIGINT is NOT sent (because there was a selection), so the running process is not interrupted. The developer can still use the browser's Edit > Copy menu or right-click > Copy from the native context menu as a fallback.

---

## Section 5: Risks & False-PASS Risks

### Risk 1: Ctrl+C copies but also sends SIGINT

If the `customKeyEventHandler` calls `navigator.clipboard.writeText()` but forgets to return `false`, xterm.js will still process the key and send `\x03` to the PTY. A test that only checks "clipboard contains the selected text" would pass, but the running process would also receive SIGINT — a destructive side effect. The test must verify that when text is selected and Ctrl+C is pressed, the PTY does NOT receive `\x03`.

### Risk 2: customKeyEventHandler registered but not firing

xterm.js requires `attachCustomKeyEventHandler(fn)` to be called after `xterm.open(container)`. If the handler is attached before `open()`, it may be silently ignored. The implementation must place the registration after the `xterm.open(container)` call (TerminalPane.js line 77, ProjectTerminalPane.js line 73). A test that only checks "the handler function exists" without verifying it actually intercepts a real Ctrl+C event would false-pass.

### Risk 3: Scrollbar CSS overridden by vendor styles

The vendor CSS (`xterm.min.css`) is loaded via `<link>` in `index.html` (line 12), while `styles.css` is loaded on line 11 — BEFORE the vendor CSS. If `styles.css` loads before `xterm.min.css`, the vendor's `.xterm-viewport` `overflow-y: scroll` rule wins with equal specificity. The terminal scrollbar section in `styles.css` already uses `.xterm-viewport` selectors (matching vendor specificity), but load order matters. The implementation must verify that the custom scrollbar CSS actually takes effect. A visual test that only screenshots the terminal without checking the computed scrollbar style could miss a specificity conflict where the scrollbar is technically present but invisible due to transparent colors.

### Risk 4: Scrollbar visible but not functional

CSS scrollbar styling is purely cosmetic — it does not affect scroll behavior. However, if the scrollbar thumb color is set correctly but the track is too narrow or the thumb has `pointer-events: none`, users could see the scrollbar but not interact with it. The acceptance test must verify both visibility AND drag interaction.

### Risk 5: Copy handler swallows ALL Ctrl+C, not just when selected

If the handler has a bug where `hasSelection()` always returns true (perhaps due to a stale reference or a race condition), every Ctrl+C would be intercepted as a copy operation, and users would never be able to send SIGINT. This would make the terminal unusable for interrupting processes. Tests must explicitly verify the "no selection, Ctrl+C sends SIGINT" path.

### Risk 6: Toast import breaks module loading

`TerminalPane.js` currently imports only from `'../ws/connection.js'` and `'../ws/protocol.js'`. Adding an import from `'../state/actions.js'` introduces a new dependency. If `actions.js` has a circular import or fails to load, the entire `TerminalPane.js` module will fail to initialize. The implementer should verify that the import does not create a circular dependency chain (actions.js imports from store.js, store.js imports from signals — none of these import from TerminalPane.js, so this should be safe, but it should be verified).

### Risk 7: Right-click copy interferes with xterm's rightClickSelectsWord

xterm.js's `rightClickSelectsWord: true` option selects a word on right-click. The contextmenu handler fires after the mousedown/mouseup that triggers word selection. If the handler copies the selection and clears it, the user gets one-click word-copy behavior on right-click — which is actually desirable. However, if the handler fires before xterm processes the right-click (due to event ordering), `hasSelection()` might return false at the time the contextmenu handler runs, and the word would be selected but not copied. The implementation must verify the event ordering: `mousedown` (xterm selects word) happens before `contextmenu` (handler copies). In practice, browsers fire `contextmenu` after `mouseup`, so xterm will have already completed word selection.

### Risk 8: ProjectTerminalPane changes forgotten

Because the same changes must be applied to both `TerminalPane.js` and `ProjectTerminalPane.js`, there is a risk that the implementer modifies one but not the other. The acceptance criteria explicitly include a criterion for ProjectTerminalPane (criterion 10) to guard against this. A thorough test plan must exercise both components.
