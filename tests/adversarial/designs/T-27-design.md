# T-27: Browser Resize While Terminal Is Open — PTY Gets New Dimensions

**Score:** L=4 S=3 D=5 (Total: 12)
**Test type:** Playwright browser

---

## 1. What We Are Testing

When the user resizes their browser window while a terminal is open, the PTY process running inside the session must receive the updated column/row dimensions. The path is:

```
Browser window resize
  → ResizeObserver fires (container element change)
  → fitAddon.fit() recalculates terminal dimensions
  → fitAddon.proposeDimensions() returns new {cols, rows}
  → send({ type: CLIENT.SESSION_RESIZE, id, cols, rows })
  → WebSocket → sessionHandlers.resize()
  → sessionManager.resize(id, cols, rows)
  → DirectSession.resize(cols, rows)
  → this.pty.resize(cols, rows)
  → PTY kernel ioctl TIOCSWINSZ
  → bash/tput sees new dimensions
```

**Pass condition:** `tput cols` returns the new column count after resize. No horizontal scrollbar. No corruption.

---

## 2. Source Code Analysis

### 2a. TerminalPane.js — ResizeObserver (lines 169–176)

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

- **ResizeObserver fires on container resize** — the container is `<div class="terminal-container" style="height:100%;width:100%;overflow:hidden;" />`.
- **fitAddon.fit()** recalculates the terminal size based on the container's actual pixel dimensions and the terminal's font metrics.
- **proposeDimensions()** returns the would-be `{cols, rows}` after fit.
- **send()** dispatches the `SESSION_RESIZE` message over the existing WebSocket.

**Risk:** `proposeDimensions()` can return `null` if the terminal is not yet open or the container has zero dimensions. The guard `if (dims)` prevents sending garbage, but also means a resize to 0×0 is silently ignored.

**Risk:** The ResizeObserver fires synchronously with the DOM mutation but `fitAddon.fit()` reads `clientWidth`/`clientHeight`. If the browser hasn't done a layout pass yet, the dimensions may be stale. In practice, Playwright's `setViewportSize` triggers a synchronous layout, so this should be fine.

### 2b. sessionHandlers.js — resize() (lines 149–151)

```js
resize(clientId, msg) {
  this.sessions.resize(msg.id, msg.cols, msg.rows);
}
```

- Passes through to `SessionManager.resize()`. No validation — zero cols/rows would be forwarded.
- **Note:** There is no response message sent back. The resize is fire-and-forget.

### 2c. DirectSession.js — resize() (lines 107–113)

```js
resize(cols, rows) {
  this._cols = cols;
  this._rows = rows;
  if (this.pty) {
    try { this.pty.resize(cols, rows); } catch { /* ignore */ }
  }
}
```

- `this._cols` and `this._rows` are updated regardless of PTY state.
- `this.pty.resize()` calls `node-pty`'s resize which issues `TIOCSWINSZ` to the kernel.
- The `try/catch` silently swallows errors — if the PTY is in a bad state, resize fails silently.

---

## 3. Failure Modes

### Failure Mode 1 (High risk): ResizeObserver doesn't fire after viewport change
- **Cause:** `page.setViewportSize()` changes the viewport but the terminal container is inside a CSS overlay. If the overlay's `width`/`height` is hardcoded in pixels (not `%`), the container does not resize and ResizeObserver never fires.
- **Detection:** Intercept outgoing WS messages, assert a `session:resize` message is sent.
- **Mitigation:** Verify terminal overlay fills viewport before testing resize.

### Failure Mode 2 (Medium risk): proposeDimensions() returns same dimensions
- **Cause:** Font size and container size yield the same integer col/row count after resize (e.g., going from 1280 to 1279 pixels doesn't change the column count). 1280→800 is a large enough jump (38% reduction) that this is unlikely.
- **Detection:** Log the before/after dimensions and assert they differ.

### Failure Mode 3 (Medium risk): PTY resize races with session:subscribed reset
- **Cause:** If the terminal is just-subscribed or reconnecting, an xterm.reset() could clear the terminal mid-test.
- **Mitigation:** Wait 2s after subscribe before resizing.

### Failure Mode 4 (Low risk): tput reports ENV-based cols, not PTY dimensions
- **Cause:** `tput cols` reads from the terminal's `COLUMNS` environment variable or the TTY's ioctl. In a PTY, `tput cols` reads from the TTY directly (ioctl `TIOCGWINSZ`), not from environment. This is correct behavior.
- **Mitigation:** Use bash's `tput cols` inside the PTY session, not a local shell.

### Failure Mode 5 (Low risk): node-pty swallows the TIOCSWINSZ silently
- **Cause:** node-pty may throw if `cols` or `rows` is 0 or too large. Our `catch {}` in `DirectSession.resize()` silently ignores this.
- **Detection:** If `tput cols` returns the old value after 2s, this has failed.

---

## 4. Test Infrastructure

### 4a. Server setup
- Isolated `DATA_DIR` (mktemp)
- PORT=3124 (assigned to T-27)
- Pre-seeded `projects.json` with `{ "projects": [...], "scratchpad": [] }` format
- Project path: a real writable directory (e.g., `/tmp/qa-T27-XXX/project`)

### 4b. Session type: bash (not Claude)
- Use `command: 'bash'` so the session starts instantly and `tput cols` works predictably.
- Bash sessions don't need Claude TUI readiness polling.
- `tput cols\r` sends a carriage return (not `\n`) — JOURNAL.md lesson.

### 4c. Viewport sizes
- Initial: 1280×800 (standard desktop)
- After resize: 800×600 (reduces columns significantly)
- At 13px JetBrains Mono, ~7px/char → 1280px ÷ 7px ≈ 182 cols → 800px ÷ 7px ≈ 114 cols.
- The delta is at least 30 columns, making the test robust to measurement variation.

### 4d. WS message interception
- Inject `window.__t27_resizeMsgs = []` before navigation.
- Override `WebSocket.prototype.send` to capture outgoing messages.
- After resize, read `window.__t27_resizeMsgs` and assert at least one `session:resize` was sent with `cols < 150` (below initial ~182).

### 4e. PTY column verification
- Send `tput cols\r` via `session:input` WS message.
- Read the PTY output (session:output stream) and parse the numeric response.
- Assert returned value matches (within ±2) the `cols` from the last `session:resize` message.

---

## 5. Exact Test Steps

1. `fuser -k 3124/tcp` — clear port
2. Create isolated tmpDir, seed `projects.json`
3. Start server: `DATA_DIR=<tmp> PORT=3124 node server-with-crash-log.mjs`
4. Poll `GET /api/projects` until 200 (max 25s)
5. Open Chromium at 1280×800 (`page.setViewportSize({ width: 1280, height: 800 })`)
6. Navigate to `http://127.0.0.1:3124` with `waitUntil: 'domcontentloaded'`
7. Inject WS message spy: override `WebSocket.prototype.send` to capture `session:resize` messages
8. Click project in sidebar → wait for sessions area
9. Open "New Session" modal → fill name `t27-resize` + command `bash` → submit
10. Wait for session card with `t27-resize` to appear
11. Click session card → wait for `#session-overlay` to appear
12. Wait 2s for terminal to stabilize
13. Capture initial terminal dimensions: send `tput cols\r` via WS → read output → parse initial col count
14. **Resize browser to 800×600**: `page.setViewportSize({ width: 800, height: 600 })`
15. Wait 2s for ResizeObserver → fitAddon.fit() → WS send → PTY ioctl to propagate
16. Read captured `session:resize` messages from window spy
17. Assert at least one `session:resize` was sent after the viewport change
18. Assert the `cols` in the resize message is less than the initial cols
19. Verify no horizontal scrollbar: check `.xterm-viewport` `scrollWidth <= clientWidth`
20. Send `tput cols\r` again via WS → read output → parse new col count
21. Assert new col count < initial col count (positive change in the right direction)
22. Assert new col count approximately matches the `cols` from the resize WS message (within ±3)
23. Screenshot: `T-27-after-resize.png`
24. Cleanup: delete session, kill server, rm tmpDir

---

## 6. Pass/Fail Criteria

### PASS (all must hold):
1. At least one `session:resize` WS message was sent after viewport resize
2. The resize message `cols` value is less than the initial terminal cols (positive delta)
3. `tput cols` inside the PTY returns a value < initial cols after resize
4. `tput cols` result approximately matches the resize message `cols` (within ±3)
5. No horizontal scrollbar visible in `.xterm-viewport` (`scrollWidth <= clientWidth + 2`)
6. No terminal corruption (no screenshot anomalies, terminal still accepts input)

### FAIL (any one is sufficient):
1. No `session:resize` message captured after viewport resize (ResizeObserver didn't fire or WS send silently dropped)
2. `tput cols` returns the same value as before resize (PTY not updated)
3. `tput cols` returns a value larger than initial (resize went wrong direction)
4. Horizontal scrollbar visible where none is expected
5. Terminal unresponsive after resize (resize broke the PTY)

---

## 7. Screenshots

| Filename | When |
|----------|------|
| `T-27-initial.png` | After terminal opens, before resize |
| `T-27-after-resize.png` | After viewport resize and 2s settle |
| `T-27-FAIL.png` | Only on failure, for forensic analysis |

---

## 8. Known Risks

- **Risk:** SessionOverlay may have fixed CSS dimensions that don't reflow on viewport change.
  - **Mitigation:** Assert terminal container dimensions changed before checking PTY.
- **Risk:** `tput cols` output may be interleaved with bash prompt, making parsing harder.
  - **Mitigation:** Use a unique prefix: `echo "COLS=$(tput cols)"\r` and parse `COLS=\d+`.
- **Risk:** Timing — ResizeObserver fires asynchronously. 2s wait should be more than sufficient.
  - **Mitigation:** If first tput check fails, retry with 1s delay up to 3 times before failing.

## Execution Summary

**Date:** 2026-04-08
**Result:** PASS — 1/1 test passed (26.0s)
**Port:** 3124

### Fixes applied during validation

1. **playwright.config.js** — Added T-27 to `testMatch` allowlist.
2. **WS subscribe cols override** — The second `session:subscribe` (for the tput-after-resize check) was sending `cols: 80, rows: 24`, which caused the server to RESIZE the PTY to 80 cols before `tput` ran. This made the "tput vs resize message" delta = 20 (fail). Fix: removed `cols`/`rows` from the second subscribe so it does not override PTY dimensions.

### Key findings

- Container width shrinks from 1280px to 800px after `page.setViewportSize({ width: 800, height: 600 })`.
- `ResizeObserver` fires and sends `session:resize` with reduced col count (100 cols after viewport shrink from 1280).
- PTY `tput cols` reads back the new col count (100) — confirming `TIOCSWINSZ` was issued.
- No horizontal scrollbar after resize (`xterm-viewport scrollWidth <= clientWidth`).
- Initial PTY cols: 120 (created with cols:120). After resize: 100. Delta vs resize message: 0 (exact match).
