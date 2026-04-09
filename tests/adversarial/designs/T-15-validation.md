# T-15 Validation: Scroll Up While Streaming — Auto-Scroll Frozen, Input Still Works

**Date:** 2026-04-08
**Result:** PASS
**Tests:** 1/1 passed in 21.5s (no fixes required)

---

## Pass/Fail Verdict

**PASS** — all 7 criteria from the design spec hold.

---

## Criteria Checklist

| # | Criterion | Measured Value | Result |
|---|-----------|---------------|--------|
| C1 | `userScrolledUp=true` immediately after wheel scroll | `true` (first attempt) | PASS |
| C2 | `scrollMax` increases during streaming (output IS arriving) | 12075 → 82275 | PASS |
| C3 | `scrollTop` variance < 50px during 5-second stream period | 0px | PASS |
| C4 | `userScrolledUp=true` throughout ALL 10 stream polls | 10/10 polls | PASS |
| C5 | WS buffer contains `STREAM-LINE-50` or higher | Confirmed | PASS |
| C6 | After scroll-to-bottom, `userScrolledUp=false` | `false` | PASS |
| C7 | PTY echo received while scrolled up | `HELLO_FROM_T15` echoed via WS | PASS |

---

## Adaptive Scrollback Setup

The initial 60-line pre-fill produced `scrollMax=0` (viewport height exceeded content). The test's built-in fallback triggered: 60 additional lines (61–120) were generated, bringing `scrollMax=315`. The design's Risk 3 mitigation worked correctly.

---

## Streaming Observation Window

- Loop: `for i in $(seq 1 150); do echo "STREAM-LINE-$i ..."; sleep 0.05; done`
- Duration: ~7.5 seconds; 5-second poll window captured lines ~50–150
- All 10 polls (500ms apart) confirmed `userScrolledUp=true` and `scrollTop=0`
- `scrollMax` grew by ~70,000px during the window — conclusively proves output was arriving while viewport was frozen

---

## Input While Scrolled Up

Input was delivered via WS (`session:input`) while `userScrolledUp=true`. The PTY echoed `HELLO_FROM_T15` back through `session:output`, captured by the collector. The keyboard fallback was not needed.

This confirms `TerminalPane.js` `xterm.onData()` path (lines 118–124) is not gated on `userScrolledUp`.

---

## Architecture Confirmed

`TerminalPane.js` scroll control (lines 88–113):
```js
scrollDisposable = xterm.onWriteParsed(() => {
  if (!userScrolledUp) vp.scrollTop = vp.scrollHeight;
});
```
When `userScrolledUp === true`, new output expands `scrollHeight` but viewport does NOT follow — exactly the expected behavior. The `_scrollState()` hook at line 104 correctly exposes the internal state for external inspection.

---

## No Fixes Required

Test passed on first execution. The scroll freeze mechanism, `_scrollState` hook, and input delivery are all functioning correctly.

---

## Screenshots

Saved to `qa-screenshots/T-15-scroll-freeze/`:
- `T15-00-pre-stream-scrolled-up.png` — viewport at top before streaming
- `T15-01-scroll-frozen-mid-stream.png` — viewport frozen at top while lines arrive
- `T15-02-after-scroll-to-bottom.png` — viewport at bottom after manual scroll
- `T15-03-input-while-scrolled.png` — state after typing while scrolled up
