# Black Box Terminal — Investigation & Test Design

## Brainstorm: 5 Most Likely Root Causes (Ranked)

### 1. Synchronous `fitAddon.fit()` before browser layout paint (HIGHEST PROBABILITY)

**Evidence:** In `TerminalPane.js` line 83, `fitAddon.fit()` is called synchronously after `xterm.open(container)` (line 73). In Preact's `useEffect`, the container DOM node exists but the browser has not yet completed a layout pass for the flex container hierarchy: `SessionOverlay[position:fixed] > div[flex:1;min-height:0] > div.terminal-container[height:100%]`.

v1 uses `setTimeout(() => fitAddon.fit(), 50)` (file: `public/app.js`, line 908) which gives the browser time to compute dimensions. v2 skips this delay.

When `fit()` reads a container with 0x0 dimensions, it either:
- Sets the canvas to 0x0 (invisible terminal)
- Aborts silently (no fit applied, terminal stuck at initial micro-size)

The xterm canvas renders at the computed size. The background color fills the container, but the canvas (text content) is 0-sized or microscopic, producing a solid black rectangle.

**Probability: 70%**

### 2. Container has 0 height due to `flex: 1; min-height: 0` chain before first paint

**Evidence:** The terminal container tree is:
```
SessionOverlay (position: fixed; top: var(--topbar-h); bottom: 0; flex-direction: column)
  └── div#session-overlay-terminal (flex: 1; min-height: 0; overflow: hidden)
       └── TerminalPane div.terminal-container (height: 100%; width: 100%)
```

Inline styles on `#session-overlay-terminal` use `flex: 1; min-height: 0`. The `flex: 1` item only has a computed height after its parent's flex layout resolves. The parent is a `position: fixed` element with `top: var(--topbar-h); bottom: 0` -- this should give it a definite height. However, if `--topbar-h` is not yet computed (CSS variable resolution) or the `SessionOverlay` component renders before the parent `#app-shell` is laid out, the chain could yield 0.

This is closely related to cause #1 but focuses on the CSS rather than the timing.

**Probability: 60% (overlaps with #1)**

### 3. WebGL renderer fails silently, leaving canvas in broken state

**Evidence:** `TerminalPane.js` lines 76-79:
```js
try { xterm.loadAddon(new WebglAddon.WebglAddon()); gpuRenderer = true; } catch {}
if (!gpuRenderer) {
  try { xterm.loadAddon(new CanvasAddon.CanvasAddon()); } catch {}
}
```

If WebGL initialization appears to succeed (`gpuRenderer = true`) but the WebGL context is actually lost or unusable (e.g., headless browser, GPU driver issue), the WebGL renderer may produce a black canvas. The `catch {}` swallows the error. Unlike v1, v2 does not register a `webglAddon.onContextLoss` handler.

**Probability: 25%**

### 4. Dual Preact instances from CDN import map

**Evidence:** `index.html` loads Preact via CDN import map (`esm.sh`). If the browser resolves `preact` and `preact/hooks` to different Preact instances (version mismatch or separate bundles), `useRef` and `useEffect` may malfunction -- `containerRef.current` could be null when the effect fires, causing `xterm.open(null)` which would silently fail.

The QA report (line 79) flagged this as a potential issue but noted it was unverified at the time.

**Probability: 10%**

### 5. `xterm.reset()` on subscribe clears content with no subsequent output

**Evidence:** `TerminalPane.js` line 132: `xterm.reset()` is called when `session:subscribed` arrives. If the session is in a state where no new PTY output follows (e.g., stopped session, Claude waiting for input with no prompt visible), the terminal shows as empty/black.

This is less of a "black box" and more of an "empty terminal" -- the cursor should still be visible if cursorBlink is enabled. But if the cursor position is 0,0 and the terminal is very small, it might appear as a solid black rectangle.

**Probability: 15%**

---

## Section 1: Problem & Context

### Root Cause (Most Likely)

**Primary:** `fitAddon.fit()` called synchronously in `useEffect` before the browser has computed layout dimensions for the flex container hierarchy.

**File:** `/home/claude-runner/apps/claude-web-app-v2/public/js/components/TerminalPane.js`, line 83

**What happens now:**
1. Preact renders `TerminalPane` inside `SessionOverlay`
2. `useEffect` fires after the virtual DOM is committed to the real DOM
3. `xterm.open(container)` attaches the terminal elements to the container
4. `fitAddon.fit()` is called immediately
5. The browser has not yet performed a layout pass, so `container.getBoundingClientRect()` may return `{width: 0, height: 0}`
6. `fit()` computes 0 cols/rows or aborts, leaving the canvas at its default tiny size or 0x0
7. The xterm background color fills the full container via CSS, but the canvas (where text renders) is invisible
8. The terminal appears as a solid black rectangle

**Contributing factor:** No `.terminal-container` CSS rules exist in `styles.css`. The container relies entirely on inline styles (`height:100%;width:100%`), which depend on the parent having a resolved height -- a fragile chain in a `flex: 1; min-height: 0` layout.

**What should happen:**
The `fit()` call should be deferred until the browser has completed at least one layout pass, ensuring the container has non-zero dimensions. v1 achieves this with `setTimeout(() => fitAddon.fit(), 50)`.

### Secondary Cause

**WebGL context loss without recovery.** If the WebGL renderer loads but the context is silently lost (common in CI/headless environments), no recovery handler re-initializes the renderer. v1 has the same gap but uses `setTimeout` for fit, which may mask the issue.

---

## Section 2: Fix Design

### Fix A: Defer `fitAddon.fit()` with `requestAnimationFrame` + fallback

**File:** `public/js/components/TerminalPane.js`

**Change at line 83:**

Replace:
```js
fitAddon.fit();
xterm.focus();
```

With:
```js
// Defer fit() until browser has computed layout dimensions.
// useEffect fires after DOM commit but before paint; rAF defers to after paint.
// Double-rAF ensures the layout pass has completed even in edge cases.
requestAnimationFrame(() => {
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch {}
    xterm.focus();
  });
});
```

**Why:** `requestAnimationFrame` defers execution to the next frame, after the browser's layout and paint passes have run. The double-rAF pattern (used by React internals and VS Code) ensures the container dimensions are resolved even when the first rAF fires before layout completion.

### Fix B: Add WebGL context loss recovery

**File:** `public/js/components/TerminalPane.js`

**Add after line 76:**
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

### Fix C: Add a ResizeObserver-based initial fit

The ResizeObserver at line 169 already calls `fitAddon.fit()` on resize. However, it is registered AFTER the synchronous `fit()` call. If the initial `fit()` produces 0-dimensions, the ResizeObserver should fire when the container transitions from 0 to its real size -- but only if a real resize event occurs.

To be safe, after the deferred fit in Fix A, also ensure the ResizeObserver is registered BEFORE the first fit attempt. This is already the case structurally (the observer fires on observe), but moving `resizeObserver.observe(container)` earlier (before the deferred fit) would provide a belt-and-suspenders guarantee.

### Edge Cases
- **Split view toggle:** When toggling split/full, the container resizes. The existing ResizeObserver handles this.
- **Tab switch with hidden terminal:** If TerminalPane is mounted while its parent is hidden (display: none), even the deferred fit will compute 0. The ResizeObserver will fire when it becomes visible. This is an acceptable degradation.
- **Rapid session switching:** The cleanup function disposes xterm. The deferred rAF could fire after disposal. The `try/catch` handles this.

---

## Section 3: Acceptance Criteria

1. **Given** a fresh page load with a running session, **when** the user clicks a session card to open the terminal overlay, **then** terminal text content (cursor, prompt, or output) is visible within 1 second -- no solid black rectangle.

2. **Given** a terminal overlay is open, **when** the user toggles between Split and Full modes, **then** the terminal content remains visible and correctly sized in both modes.

3. **Given** a terminal overlay with a running session, **when** the user clicks Refresh, **then** after the refresh completes, the terminal displays new output (not a black box) and the cursor is visible.

4. **Given** a session in stopped state, **when** the user opens the terminal overlay, **then** either the terminal shows the last output (if available) or displays a visible cursor on the background -- not a featureless black rectangle.

5. **Given** the app is loaded in a headless browser (no GPU / WebGL unavailable), **when** a session terminal is opened, **then** the terminal falls back to Canvas or DOM rendering and displays content correctly.

---

## Shared Test Configuration

All tests use the following Playwright browser settings unless otherwise specified:

```js
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
```

**Viewport:** 1280x800 is required for every test. Terminal rendering is dimension-dependent; omitting the viewport risks false passes on small default viewports.

---

## Section 4: Test Designs

### T-1: Terminal renders visible content after session attach

**Flow:**
1. Start v2 server on port 3400 with isolated DATA_DIR
2. Create a project via REST API (`POST /api/projects`)
3. Create a bash session via WebSocket (`session:create` with `command: "bash"`)
4. Wait for session state `running`
5. Navigate Playwright browser to `http://localhost:3400` (viewport: 1280x800)
6. Click the project in the sidebar
7. Click the session card to open the terminal overlay
8. Wait up to 3 seconds for `.xterm-screen canvas` to appear inside `#session-overlay-terminal`
9. Send sentinel text via WebSocket: `session:input` with data `echo RENDER_CHECK_T1\n`
10. Wait up to 3 seconds for `RENDER_CHECK_T1` to appear in terminal buffer text (poll via `page.evaluate` reading `xterm.buffer.active` line contents)
11. Take a screenshot
12. Evaluate the xterm canvas: read pixel data from the canvas element
13. Assert that the canvas contains at least 3 distinct colors: the background color (`#0c1117`), the text foreground color (`#d0d8e0`), and optionally the cursor color. Specifically, assert that pixels matching the foreground color `#d0d8e0` (or near it, within a tolerance of +/-20 per RGB channel) exist in the canvas. This ensures real text was rendered, not just a cursor blink on a black background.
14. Also assert that at least one line in `xterm.buffer.active` (lines 0 through length-1) contains non-whitespace characters (use `getLine(i).translateToString().trim().length > 0`)

**Pass condition:** The canvas contains pixels matching the text foreground color (not just background + cursor), confirming rendered text. At least one buffer line has non-whitespace content.

**Fail signal:** Canvas pixels only contain background color and cursor color (no text foreground), or all buffer lines are empty/whitespace, or the canvas element has 0x0 dimensions.

**Test type:** Playwright browser

**Port:** 3400

---

### T-2: fit() produces non-zero dimensions after mount (not retroactively fixed by ResizeObserver)

**Why this test matters:** The ResizeObserver at line 169-176 of `TerminalPane.js` calls `fitAddon.fit()` on resize. If the initial synchronous `fit()` at line 83 computes 0x0 (because the container has no layout yet), the ResizeObserver fires when the container transitions from 0 to its real size and retroactively fixes the dimensions. This masks the bug. T-2 must capture the dimensions at the moment of the *first* `fit()` call, before any ResizeObserver correction.

**Flow:**
1. Start v2 server on port 3401
2. Create project + bash session via API/WS
3. Navigate Playwright to `http://localhost:3401` (viewport: 1280x800)
4. **Before clicking the session card**, inject a hook to capture first-fit dimensions:
   ```js
   await page.evaluate(() => {
     // Monkey-patch FitAddon.prototype.fit to record the canvas dimensions
     // at the moment of the FIRST fit() call, before ResizeObserver can correct.
     const origFit = FitAddon.FitAddon.prototype.fit;
     window.__firstFitDims = null;
     FitAddon.FitAddon.prototype.fit = function() {
       if (!window.__firstFitDims) {
         const canvas = document.querySelector('#session-overlay-terminal .xterm-screen canvas');
         const container = document.querySelector('#session-overlay-terminal .terminal-container');
         const containerRect = container?.getBoundingClientRect();
         const dims = this.proposeDimensions();
         window.__firstFitDims = {
           canvasWidth: canvas?.width ?? 0,
           canvasHeight: canvas?.height ?? 0,
           containerWidth: containerRect?.width ?? 0,
           containerHeight: containerRect?.height ?? 0,
           proposedCols: dims?.cols ?? 0,
           proposedRows: dims?.rows ?? 0,
         };
       }
       return origFit.call(this);
     };
   });
   ```
5. Click the project in the sidebar, then click the session card to open the overlay
6. Wait for `.xterm-screen canvas` to be visible (layout settled)
7. Read the captured first-fit dimensions:
   ```js
   const firstFit = await page.evaluate(() => window.__firstFitDims);
   ```
8. Assert `firstFit.containerWidth > 100` and `firstFit.containerHeight > 100` (container had resolved layout at first fit)
9. Assert `firstFit.proposedCols > 10` and `firstFit.proposedRows > 5` (fit computed valid terminal dimensions)
10. Now also verify the settled state. Execute in browser context:
    ```js
    const canvas = document.querySelector('#session-overlay-terminal .xterm-screen canvas');
    return { width: canvas.width, height: canvas.height };
    ```
11. Assert `canvas.width > 0` and `canvas.height > 0`
12. Verify terminal cols/rows via the canvas and cell dimensions (not via internal `_xterm` property, which does not exist on the DOM element):
    ```js
    // Read terminal dimensions from the xterm-screen canvas size and character cell metrics.
    // The .xterm-char-measure-element is used by xterm to measure character dimensions.
    const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
    const charMeasure = document.querySelector('#session-overlay-terminal .xterm-char-measure-element');
    const screenRect = screen.getBoundingClientRect();
    const cellWidth = charMeasure ? charMeasure.getBoundingClientRect().width : 0;
    const cellHeight = charMeasure ? parseFloat(getComputedStyle(charMeasure).lineHeight) || charMeasure.getBoundingClientRect().height : 0;
    return {
      screenWidth: screenRect.width,
      screenHeight: screenRect.height,
      cellWidth,
      cellHeight,
      estimatedCols: cellWidth > 0 ? Math.floor(screenRect.width / cellWidth) : 0,
      estimatedRows: cellHeight > 0 ? Math.floor(screenRect.height / cellHeight) : 0,
    };
    ```
13. Assert `estimatedCols > 10` and `estimatedRows > 5`

**Pass condition:** The *first* `fit()` call (before ResizeObserver correction) produces non-zero container dimensions and valid cols/rows. The settled canvas also has non-zero pixel dimensions. Estimated terminal grid from canvas/cell metrics is reasonable.

**Fail signal:** `firstFit` values are 0 or near-zero (proving the initial fit computed before layout). Or settled canvas is 0x0. Or estimated cols/rows are 0.

**Test type:** Playwright browser

**Port:** 3401

---

### T-3: Terminal survives split/full toggle without going black

**Flow:**
1. Start v2 server on port 3402
2. Create project + bash session via API/WS
3. Navigate Playwright (viewport: 1280x800), open session overlay
4. Wait for terminal to render (canvas visible with content)
5. Send `echo SPLIT_TEST_123` via WS input
6. Wait for "SPLIT_TEST_123" to appear in terminal text
7. Click the "Split" button in the overlay header
8. Wait 500ms for layout to settle
9. Take screenshot
10. Read canvas pixel data -- assert non-uniform (content visible)
11. Read terminal text content -- assert "SPLIT_TEST_123" is still present
12. Click the "Full" button
13. Wait 500ms
14. Read canvas pixel data -- assert non-uniform
15. Read terminal text content -- assert "SPLIT_TEST_123" still present

**Pass condition:** Terminal content remains visible and readable after both split and full transitions. Text written before the toggle is preserved.

**Fail signal:** Canvas becomes uniform (black) after toggle, or text content disappears.

**Test type:** Playwright browser

**Port:** 3402

---

### T-4: Terminal renders in headless/no-WebGL environment

**Flow:**
1. Start v2 server on port 3403
2. Create project + bash session
3. Launch Playwright with `--disable-gpu` flag (force WebGL unavailable), viewport: 1280x800
4. Navigate to app, open session overlay
5. Wait for terminal canvas
6. Check browser console logs for `[TerminalPane]` messages
7. Assert no unhandled errors in console
8. Send `echo NOGPU_TEST` via WS
9. Wait for output to appear in terminal
10. Read canvas pixel data -- assert non-uniform content

**Pass condition:** Terminal renders correctly with Canvas or DOM fallback renderer. No console errors. Text is visible.

**Fail signal:** Terminal is a black box, or console contains WebGL-related errors without successful fallback.

**Test type:** Playwright browser (with `--disable-gpu`)

**Port:** 3403

---

### T-5: Terminal content visible on page refresh (reconnect scenario)

**Flow:**
1. Start v2 server on port 3404
2. Create project + bash session via API/WS
3. Navigate Playwright (viewport: 1280x800), open session overlay
4. Send `echo REFRESH_MARKER_789` via WS
5. Wait for marker text in terminal
6. Refresh the page (`page.reload()`)
7. Wait for the page to fully load (wait for the project list / sidebar to render)
8. Click the project in the sidebar to select it
9. Click the session card to re-open the terminal overlay. **Do NOT rely on auto-reopen behavior** -- the app does not restore overlay state on refresh.
10. Wait for `.xterm-screen canvas` to appear inside `#session-overlay-terminal` (up to 5 seconds)
11. Wait up to 5s for canvas to have non-uniform pixel data (poll pixel sampling)
12. Check that terminal has content (cursor visible, or if PTY replays, output visible)

**Pass condition:** After page refresh and re-attach, the terminal renders visible content (not a black box). The canvas has non-zero dimensions and non-uniform pixel data.

**Fail signal:** Terminal is a solid black rectangle after reconnect. Canvas is 0x0 or all-same-color.

**Test type:** Playwright browser

**Port:** 3404

---

### T-6: PTY subscribe dimensions match rendered canvas (no 120x30 fallback on 0x0 canvas)

**Why this test matters:** At line 146-150 of `TerminalPane.js`, `proposeDimensions()` returns the fitted cols/rows. If `fit()` computed against a 0x0 container, `proposeDimensions()` returns null, and the fallback `cols: 120, rows: 30` is sent to the server. The PTY then operates at 120x30, but the canvas is 0x0 -- text is written to the buffer but invisible. This test verifies that the dimensions sent in `session:subscribe` are non-zero AND match the actual rendered terminal size.

**Flow:**
1. Start v2 server on port 3405
2. Create project + bash session via API/WS
3. Navigate Playwright to `http://localhost:3405` (viewport: 1280x800)
4. **Before clicking the session card**, inject a WebSocket message interceptor to capture the `session:subscribe` message:
   ```js
   await page.evaluate(() => {
     window.__subscribeDims = null;
     const origSend = WebSocket.prototype.send;
     WebSocket.prototype.send = function(data) {
       try {
         const msg = JSON.parse(data);
         if (msg.type === 'session:subscribe' && !window.__subscribeDims) {
           window.__subscribeDims = { cols: msg.cols, rows: msg.rows };
         }
       } catch {}
       return origSend.call(this, data);
     };
   });
   ```
5. Click the project in the sidebar, then click the session card to open the overlay
6. Wait for `.xterm-screen canvas` to be visible
7. Read the captured subscribe dimensions:
   ```js
   const subDims = await page.evaluate(() => window.__subscribeDims);
   ```
8. Read the actual rendered terminal dimensions from the canvas:
   ```js
   const rendered = await page.evaluate(() => {
     const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
     const charMeasure = document.querySelector('#session-overlay-terminal .xterm-char-measure-element');
     const screenRect = screen.getBoundingClientRect();
     const cellWidth = charMeasure ? charMeasure.getBoundingClientRect().width : 0;
     const cellHeight = charMeasure ? parseFloat(getComputedStyle(charMeasure).lineHeight) || charMeasure.getBoundingClientRect().height : 0;
     return {
       estimatedCols: cellWidth > 0 ? Math.floor(screenRect.width / cellWidth) : 0,
       estimatedRows: cellHeight > 0 ? Math.floor(screenRect.height / cellHeight) : 0,
     };
   });
   ```
9. Assert `subDims.cols > 0` and `subDims.rows > 0` (no zero dimensions sent to PTY)
10. Assert `subDims.cols !== 120 || subDims.rows !== 30` when rendered dimensions differ from 120x30 -- i.e., the subscribe did NOT use the hardcoded fallback. Specifically: `Math.abs(subDims.cols - rendered.estimatedCols) <= 2` and `Math.abs(subDims.rows - rendered.estimatedRows) <= 2` (allow +/-2 tolerance for rounding)
11. Assert `rendered.estimatedCols > 10` and `rendered.estimatedRows > 5`

**Pass condition:** The `session:subscribe` message sends cols/rows that are non-zero and match (within tolerance) the actual rendered terminal grid size. The PTY and canvas agree on dimensions.

**Fail signal:** Subscribe sends `cols: 120, rows: 30` while the canvas computes a different grid size (indicating `proposeDimensions()` returned null and the fallback was used). Or subscribe sends `cols: 0` or `rows: 0`.

**Test type:** Playwright browser

**Port:** 3405

---

### T-7: Rapid session switching does not produce black box (rAF-after-dispose race)

**Why this test matters:** When session A's terminal is opened, the fix defers `fit()` via `requestAnimationFrame`. If the user immediately switches to session B, session A's cleanup runs (`xterm.dispose()`), but the deferred rAF callback may still fire, attempting to `fit()` a disposed terminal. This could either crash or corrupt session B's terminal. This test verifies that rapid switching does not produce a black box or console errors.

**Flow:**
1. Start v2 server on port 3406
2. Create project via API
3. Create two bash sessions via WebSocket: session A and session B. Wait for both to be `running`.
4. Navigate Playwright to `http://localhost:3406` (viewport: 1280x800)
5. Click the project in the sidebar
6. Start collecting console errors: `page.on('pageerror', ...)` and `page.on('console', msg => { if (msg.type() === 'error') ... })`
7. Click session A's card to open the terminal overlay
8. Wait for `.xterm-screen canvas` to appear (terminal A is mounting)
9. **Immediately** (within 50ms, no explicit wait for content) click session B's card to switch sessions. This triggers session A's cleanup (dispose) while its deferred rAF may still be pending.
10. Wait up to 3 seconds for `.xterm-screen canvas` to appear for session B
11. Send `echo SESSION_B_OK\n` via WS to session B
12. Wait up to 3 seconds for `SESSION_B_OK` to appear in terminal buffer
13. Read canvas pixel data for session B -- assert non-uniform (content visible)
14. Assert no unhandled errors were captured in step 5 (no `TypeError: Cannot read properties of null`, no `Terminal disposed` errors, etc.)

**Pass condition:** Session B renders correctly with visible content after rapid switch from A. No console errors from disposed terminal A's deferred callbacks. Canvas is non-uniform.

**Fail signal:** Session B shows a black box. Or console contains errors related to accessing a disposed terminal. Or canvas is uniform (all one color).

**Test type:** Playwright browser

**Port:** 3406

---

## Section 5: Risks & False-PASS Risks

### 1. Canvas pixel check may pass with just a cursor blink

If the terminal is effectively empty but the cursor is blinking, a single-frame screenshot might capture the cursor's bright pixel, making the canvas appear non-uniform. This could mask a bug where the terminal renders no text content. **Mitigation:** T-1 now writes sentinel text (`echo RENDER_CHECK_T1`) before pixel checking and asserts that pixels matching the text foreground color (`#d0d8e0`) exist, not just any second color. T-1 also asserts at least one buffer line contains non-whitespace content.

### 2. `setTimeout` in the fix could mask rather than fix the timing issue

If the fix uses `setTimeout(fn, 50)` (copying v1's approach), it works for typical machines but could still fail on very slow CI runners where 50ms is not enough. **Mitigation:** Use `requestAnimationFrame` (browser-native layout-aware timing) instead of arbitrary `setTimeout` delays. The double-rAF pattern is more robust.

### 3. Playwright viewport size affects dimensions

If Playwright's default viewport is small (e.g., 800x600), the terminal container may have valid but tiny dimensions. Tests checking "non-zero" would pass, but the terminal might be unusably small without being a "black box." **Mitigation:** All tests now specify viewport `{ width: 1280, height: 800 }` in the shared configuration section and in each test's flow.

### 4. ResizeObserver firing could fix the fit retroactively

The ResizeObserver on the container (line 169-176 in TerminalPane.js) calls `fitAddon.fit()` whenever the container resizes. If the container starts at 0 and then gets its real size on the next frame, the ResizeObserver would fire and fix the fit -- making the bug appear intermittent. **Mitigation:** T-2 now monkey-patches `FitAddon.prototype.fit` to capture canvas and container dimensions at the moment of the *first* `fit()` call, before any ResizeObserver correction. The assertions run against these captured first-call values, not the settled post-ResizeObserver state. This prevents vacuous passes on the pre-fix codebase.

### 5. WebGL fallback test may not detect silent context loss

Test T-4 uses `--disable-gpu` to force WebGL unavailable. But the real bug scenario is WebGL appearing to work (context created successfully) then silently losing the context later. `--disable-gpu` causes WebGL to fail at creation time, triggering the canvas fallback immediately. **Mitigation:** This is acceptable for the initial test. A more advanced test could monkey-patch `WebGLRenderingContext.prototype` to simulate context loss, but that is fragile.

### 6. Test may pass in headed mode but fail in headless

Headed browsers (with a visible window) always complete layout passes before script execution. Headless browsers may batch layout computations differently. Since the bug is timing-dependent, a test in headed mode might always pass. **Mitigation:** Run all tests in headless mode (`headless: true`) which is the default for Playwright.
