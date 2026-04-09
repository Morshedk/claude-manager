# T-26 Validation: Split View — Terminal Fully Functional After Toggle

**Date:** 2026-04-08
**Status:** PASS
**Score:** L=4 S=3 D=3 (Total: 10)

## Test Run Summary

| Step | Result | Notes |
|------|--------|-------|
| A — Full mode echo | PASS | MARKER_T26_A appeared in `.xterm-rows` |
| B — Split toggle resize | PASS | `session:resize` sent; overlay.left ≈ 50%; width < 80% of full |
| C — Split mode echo | PASS | MARKER_T26_B appeared in `.xterm-rows` |
| D — Full toggle resize | PASS | `session:resize` sent; overlay.left ≈ 0 |
| E — Full mode restored echo | PASS | MARKER_T26_C appeared in `.xterm-rows` |

**Total: 1/1 passed in 21.1s**

## Assertions Verified

1. Terminal container is non-zero-sized in full mode before any toggle.
2. Overlay `left` offset is near 0 in full mode.
3. `echo MARKER_T26_A` text appeared in `.xterm-rows` — input pipeline live in full mode.
4. After clicking "Split": `session:resize` WS message sent with cols > 0 and rows > 0.
5. Overlay `left` ≈ 50% of `window.innerWidth` in split mode.
6. Container width in split mode < 80% of container width in full mode.
7. `echo MARKER_T26_B` text appeared in `.xterm-rows` — input pipeline live in split mode.
8. After clicking "Full": `session:resize` WS message sent.
9. Overlay `left` returns to near 0 in full mode.
10. Container width in full mode > 130% of split mode container width.
11. `echo MARKER_T26_C` text appeared in `.xterm-rows` — input pipeline live in restored full mode.

## Fixes Made to Test

- `playwright.config.js`: Added T-26 to `testMatch` allowlist.
- **Session overlay open flow**: Creating a session via modal does not auto-open the overlay. Added: wait for session card → wait for `running` badge → click card → wait for `#session-overlay`. Previously the test waited directly for `#session-overlay` after modal submit, which always timed out.

## App Behavior Confirmed

The `SessionOverlay` + `TerminalPane` split/full toggle correctly:
- Changes overlay CSS `left` between `0` and `50%` on toggle
- Triggers `ResizeObserver` on the `.terminal-container` div
- Calls `fitAddon.fit()` → `fitAddon.proposeDimensions()` → sends `SESSION_RESIZE` to PTY
- PTY is resized in both directions (full→split and split→full)
- Terminal input remains functional (no focus loss, no input drop) in both modes

No regressions detected.
