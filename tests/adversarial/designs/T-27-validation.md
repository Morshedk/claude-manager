# T-27 Validation: Browser Resize While Terminal Is Open — PTY Gets New Dimensions

**Date:** 2026-04-08
**Status:** PASS
**Score:** L=4 S=3 D=5 (Total: 12)

## Test Run Summary

| Assertion | Result | Values |
|-----------|--------|--------|
| A1 — Container width decreased | PASS | 1280px → 800px |
| A2 — session:resize WS message sent | PASS | 1 message captured after resize |
| A3 — Resize message cols < initial | PASS | 100 cols < 120 initial cols |
| A4a — tput cols decreased | PASS | 120 → 100 cols |
| A4b — tput matches resize msg (±5) | PASS | delta = 0 (exact match) |
| A5 — No horizontal scrollbar | PASS | `scrollWidth <= clientWidth` |

**Total: 1/1 passed in 26.0s**

## Assertions Verified

1. `page.setViewportSize({ width: 800, height: 600 })` causes `.terminal-container` `clientWidth` to shrink from 1280px to 800px.
2. `ResizeObserver` fires within 2.5s of viewport resize and sends at least one `session:resize` WS message.
3. `session:resize` message `cols` value (100) is less than initial PTY cols (120) — correct direction.
4. `tput cols` inside the PTY reports the new value (100) — `TIOCSWINSZ` was issued via node-pty.
5. `tput cols` result matches `session:resize` message cols within ±5 (delta = 0).
6. No horizontal scrollbar: `xterm-viewport.scrollWidth <= clientWidth + 2`.

## Fixes Made to Test

- `playwright.config.js`: Added T-27 to `testMatch` allowlist.
- **WS subscribe cols override bug**: The second `session:subscribe` (for reading tput after resize) was sent with `cols: 80, rows: 24`. The server's `subscribe()` handler resizes the PTY when `msg.cols && msg.rows` are present. This overwrote the 100-col resize with 80, causing tput to report 80 and the delta assertion to fail with delta=20. Fixed by removing `cols`/`rows` from the verification subscribe message.

## App Behavior Confirmed

The resize path is fully functional end-to-end:

```
page.setViewportSize(800×600)
  → CSS layout reflow
  → .terminal-container shrinks (ResizeObserver target)
  → ResizeObserver callback fires in TerminalPane.js
  → fitAddon.fit() recalculates dimensions
  → fitAddon.proposeDimensions() → { cols: 100, rows: 33 }
  → send({ type: 'session:resize', cols: 100, rows: 33 })
  → sessionHandlers.resize() → sessions.resize() → pty.resize(100, 33)
  → TIOCSWINSZ kernel ioctl
  → tput cols reports 100
```

No regressions detected. PTY dimensions correctly track browser viewport size.
