# T-26 Design: Split View — Terminal Fully Functional After Toggle

**Score:** L=4 S=3 D=3 (Total: 10)  
**Date:** 2026-04-08  
**Test type:** Playwright browser  
**Port:** 3123

---

## Test Objective

Verify that the SessionOverlay split/full toggle:
1. Correctly resizes the terminal container (xterm.fit() fires via ResizeObserver)
2. Terminal input is functional in both split and full modes
3. The PTY receives resize signal with accurate dimensions after each toggle
4. No visual artifacts or overflow in split mode

---

## Architecture Review

### Split/Full Toggle Mechanism (`SessionOverlay.js`)

```js
const isSplit = splitView.value;
const toggleSplit = () => { splitView.value = !splitView.value; };
```

The toggle is a Preact signal write. When `splitView.value` flips:
- `#session-overlay` style changes: `left: 50%` (split) vs `left: 0` (full)
- The overlay's width changes from 100vw to ~50vw
- This change propagates via CSS, triggering a DOM layout reflow

### Terminal Resize Mechanism (`TerminalPane.js`)

```js
const resizeObserver = new ResizeObserver(() => {
  try { fitAddon.fit(); } catch {}
  const dims = fitAddon.proposeDimensions();
  if (dims) {
    send({ type: CLIENT.SESSION_RESIZE, id: sessionId, cols: dims.cols, rows: dims.rows });
  }
});
resizeObserver.observe(container);
```

**Critical path:** `splitView.value` change → Preact re-render → CSS `left: 50%` applied → overlay width shrinks → `#session-overlay-terminal` div shrinks → `.terminal-container` div (ResizeObserver target) shrinks → `ResizeObserver` fires → `fitAddon.fit()` → `SESSION_RESIZE` sent to server.

**Potential failure mode:** If the ResizeObserver fires before the CSS layout settles (e.g., `0×0` transition frame), `fitAddon.proposeDimensions()` might return `null` and the PTY resize is skipped. The terminal would still render at the old column width, causing line-wrap artifacts in split mode.

**Second potential failure mode:** After toggling Full from Split, the overlay returns to full width. ResizeObserver fires again and re-fits. If the terminal was sending text while the resize hadn't settled, there could be a brief window where PTY and xterm disagree on columns.

### Button Selectors

From `SessionOverlay.js` line 116-122:
```html
<button onClick=${toggleSplit} title=${isSplit ? 'Expand to full screen' : 'Switch to split view'}>
  ${isSplit ? 'Full' : 'Split'}
</button>
```

- **In full mode:** button text = `"Split"`, title = `"Switch to split view"`
- **In split mode:** button text = `"Full"`, title = `"Expand to full screen"`

Playwright selectors:
- `button:has-text("Split")` — clicks to enter split mode
- `button:has-text("Full")` — clicks to return to full mode

---

## Test Strategy

### Setup
1. Spawn isolated server on port 3123 with temp DATA_DIR
2. Create a test project pointing at `/tmp`
3. Create a session with command `bash` (not `claude`) — for fast startup and reliable echo
4. Navigate to project, click the session card to open the overlay
5. Wait for terminal to be ready (verify `.terminal-container .xterm-rows` is non-empty)

### Echo Marker Technique (from Key Lessons)
Use bash's `echo` to write a unique marker and verify it appears in the xterm DOM:
- `echo MARKER_T26_SPLIT\r` → wait for `MARKER_T26_SPLIT` text to appear in `.xterm-rows`
- This confirms input→PTY→output→xterm pipeline is live

### Dimension Capture
After each toggle, capture terminal dimensions:
```js
page.evaluate(() => {
  const container = document.querySelector('.terminal-container');
  if (!container) return null;
  const rect = container.getBoundingClientRect();
  const rows = container.querySelectorAll('.xterm-rows > div');
  return {
    containerWidth: rect.width,
    containerHeight: rect.height,
    xtermRows: rows.length,
  };
})
```

Also capture the actual xterm col count via the viewport:
```js
page.evaluate(() => {
  const vp = document.querySelector('.xterm-viewport');
  if (!vp || !vp._scrollState) return null;
  return vp._scrollState();
})
```

### Assertions

**A1 — Split mode width:** `containerWidth` after split should be approximately half the viewport (< 60% of window.innerWidth)

**A2 — Full mode width:** `containerWidth` after full should be approximately full viewport (> 85% of window.innerWidth)

**A3 — Input in split mode:** echo marker appears in terminal DOM after typing in split mode

**A4 — Input in full mode:** echo marker appears in terminal DOM after typing in full mode

**A5 — No dimension crash:** `containerWidth` and `containerHeight` are both > 0 in split mode (not zero-sized)

**A6 — PTY resize sent:** The test intercepts WS messages and verifies `session:resize` is sent after each toggle

---

## Failure Modes to Watch

1. **ResizeObserver race:** If `fitAddon.fit()` is called when container is `0×0` during CSS transition, dims will be null and PTY won't be resized. Terminal renders at old width in narrower container → line wrap artifacts.

2. **Input not reaching PTY:** If `onData` fires with DA response data (the filter in `TerminalPane.js` line 121), it will be dropped. The `\r`-terminated input should be `echo TEXT\r` which won't match the DA filter regex.

3. **xterm not focused after toggle:** `toggleSplit` only changes `splitView.value` — it does NOT call `xterm.focus()`. If the browser shifts focus to the button after click, keyboard input may be silently lost. The test should click into the terminal before typing.

4. **Overlay z-index / click target:** In split mode, the overlay is `z-index: 100`, `left: 50%`. The left half of the screen should still be interactive (sidebar visible). Verify the terminal is clickable and focusable in split mode.

---

## Test Steps Outline

1. `beforeAll`: start server, create project, wait for server ready
2. Launch browser, navigate to app
3. Create session (bash) → wait for overlay to appear
4. **Step A**: In full mode — echo marker A, verify in DOM
5. **Step B**: Click "Split" → wait 1s for layout → verify width < 50% viewport
6. **Step C**: Click terminal container → echo marker B → verify in DOM
7. **Step D**: Verify `containerWidth` is < 60% of window width
8. **Step E**: Click "Full" → wait 1s for layout
9. **Step F**: Click terminal → echo marker C → verify in DOM
10. **Step G**: Verify `containerWidth` > 85% of window width
11. `afterAll`: kill server, cleanup tmp dir

---

## Key Implementation Notes

- Use `waitUntil: 'domcontentloaded'` for page navigation
- ProjectStore seed not needed — create via REST API
- Session command: `bash` or `cat` (not claude) for fast, predictable echo
- Always click terminal container before `page.keyboard.type()` to ensure focus
- Use `page.waitForFunction()` with `.xterm-rows` text content to verify echo appeared
- Timeout per step: 15s (generous for ResizeObserver + PTY roundtrip)
- The toggle button has NO id — use text selector `button:has-text("Split")` and `button:has-text("Full")`

## Execution Summary

**Date:** 2026-04-08
**Result:** PASS — 1/1 test passed (21.1s)
**Port:** 3123

### Fixes applied during validation

1. **playwright.config.js** — Added T-26 to `testMatch` allowlist.
2. **Session overlay flow** — After submitting the New Session modal, the overlay does NOT auto-open; the test must: (a) wait for the session card to appear, (b) wait for `running` state, (c) click the card to open the overlay. Added this step sequence before `waitForSelector('#session-overlay')`.

### Key findings

- Split/Full toggle works correctly: overlay `left` shifts from 0 to ~50% of viewport.
- `ResizeObserver` fires `fitAddon.fit()` and sends `session:resize` after each toggle — captured 2+ messages.
- Terminal input works in both split and full modes (echo markers MARKER_T26_A, B, C appeared in `.xterm-rows` DOM).
- Container dimensions are non-zero in split mode (no zero-size collapse).
- The "Split" button text is correct; "Full" button appears after toggling.
