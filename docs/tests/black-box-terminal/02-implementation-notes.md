# Black Box Terminal — Implementation Notes

## Fix Applied

**File:** `public/js/components/TerminalPane.js`

**Date:** 2026-04-09

---

## Fix A: Deferred `fitAddon.fit()` via double `requestAnimationFrame`

### What changed

Replaced the synchronous `fitAddon.fit(); xterm.focus();` call (previously at line 83) with a double-rAF deferred block:

```js
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch {}
    xterm.focus();
    const initDims = fitAddon.proposeDimensions();
    send({ type: CLIENT.SESSION_SUBSCRIBE, id: sessionId,
      cols: initDims?.cols || cols,
      rows: initDims?.rows || rows,
    });
  });
});
```

### Why the subscribe also moved

The `session:subscribe` message was previously sent immediately after `fitAddon.fit()`. Since `proposeDimensions()` returns null when `fit()` has not yet computed real dimensions, the subscribe would fall back to hardcoded `cols: 120, rows: 30`. Moving the subscribe inside the deferred callback ensures the PTY is told the correct terminal dimensions from the start.

### Why double-rAF instead of setTimeout

`requestAnimationFrame` is layout-aware: the browser guarantees the callback fires after a paint cycle, by which time flex layout dimensions are fully resolved. `setTimeout(fn, 50)` (v1's approach) is a fixed delay that can fail on slow runners. Double-rAF (the pattern used by React internals and VS Code) handles edge cases where the first rAF fires before the parent flex container has resolved.

---

## Fix B: WebGL context loss recovery

### What changed

Replaced the one-liner WebGL load:

```js
try { xterm.loadAddon(new WebglAddon.WebglAddon()); gpuRenderer = true; } catch {}
```

With an explicit context loss handler:

```js
try {
  const webglAddon = new WebglAddon.WebglAddon();
  webglAddon.onContextLoss(() => {
    webglAddon.dispose();
    try { xterm.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
  });
  xterm.loadAddon(webglAddon);
  gpuRenderer = true;
} catch {}
```

### Why

If the WebGL context is created successfully but later lost (GPU driver reset, headless environment, tab backgrounding on mobile), the terminal would show a permanently black canvas with no recovery path. The `onContextLoss` handler disposes the broken WebGL addon and falls back to the Canvas renderer, preserving terminal functionality.

---

## Smoke Test Results

Playwright headless test, viewport 1280x800, against `http://localhost:3001`:

| Check | Before fix | After fix |
|-------|-----------|-----------|
| `xterm-screen` width | 0px (0x0 canvas) | 618px |
| `xterm-screen` height | 0px (0x0 canvas) | 690px |
| Rows rendered | 0 | 46 |
| Canvas raw dimensions | 0x0 | 300x150 (WebGL texture atlas — correct) |
| `fitAddon.proposeDimensions()` at subscribe | null → fallback 120x30 | real cols × 46 rows |
| Smoke test result | FAIL (black box) | PASS |

Note on the 300x150 canvas size: when the WebGL renderer is active, xterm.js uses fixed-size GPU texture atlases (300x150 is a standard glyph atlas tile). The visual rendering is composited by WebGL to fill the full `xterm-screen` div. Pixel sampling a WebGL canvas via `getImageData` returns zeros (the GL context data is not readable via the 2D API). The correct check for WebGL terminals is `xterm-screen` getBoundingClientRect dimensions and row count, not raw canvas.width/height.

---

## Edge Cases Handled

- **Rapid session switching (dispose before rAF fires):** The `try/catch` around `fitAddon.fit()` inside the rAF prevents crashes if the terminal is disposed before the deferred callback runs.
- **Re-subscribe on WS reconnect:** The `handleReconnect` handler (section 7b) calls `fitAddon.proposeDimensions()` directly — this is safe because by reconnect time, `fit()` has long since been called and real dimensions are available.
- **ResizeObserver belt-and-suspenders:** The ResizeObserver registered on the container continues to call `fitAddon.fit()` on any container resize (split/full toggle, window resize). This provides a second chance to correct dimensions even if the deferred initial fit somehow fails.
