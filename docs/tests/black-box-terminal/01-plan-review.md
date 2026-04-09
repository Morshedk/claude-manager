# Plan Review: Black Box Terminal Test Designs

## Verdict: REVISE

---

## Gaps Requiring Fixes

### 1. T-2 has a false-PASS risk due to ResizeObserver retroactive fix

T-2 aims to verify that `fitAddon.fit()` produces non-zero dimensions after mount. However, the ResizeObserver at line 169-176 of `TerminalPane.js` calls `fitAddon.fit()` whenever the container resizes. If the container transitions from 0 to its real size after the initial synchronous `fit()`, the ResizeObserver fires and corrects the dimensions *before* the test's assertions execute. The test waits for `.terminal-container` to be "visible" (step 5), which implicitly means layout has settled. By the time step 6 executes `getBoundingClientRect()`, the ResizeObserver has already fired and fixed everything.

**The test would pass on the pre-fix codebase.** This is a vacuous pass.

**Fix required:** T-2 must assert dimensions *immediately* after the synchronous `fit()` call, before the ResizeObserver fires. One approach: inject a `window.__xtermFitResult` hook into TerminalPane that records the cols/rows returned by the first synchronous `fit()` call, then assert on that captured value. Alternatively, monkey-patch `ResizeObserver` to be a no-op for the duration of the initial mount check, then restore it. The risk section (item 4) identifies this problem but says "add a test that disables ResizeObserver temporarily" -- that test does not actually exist in the designs.

### 2. T-1 canvas pixel check can pass with just a blinking cursor on an otherwise black terminal

Risk section item 1 acknowledges this: a cursor blink alone produces 2 distinct colors, passing the "at least 2 distinct colors" assertion. The mitigation says "also check `xterm.buffer.active.length > 1`" but the actual T-1 design says `length > 0` (step 12). A terminal with 0 user-visible content still has `length >= 1` (the initial empty line).

**Fix required:** T-1 must either (a) send a known string via WS (like `echo MARKER`) and assert it appears in `xterm.buffer.active` text, or (b) strengthen the buffer assertion to `length > 1` AND check that at least one line contains non-whitespace content. Without this, a terminal that renders only a cursor on a black background passes T-1.

### 3. No test covers the `proposeDimensions()` returning null/zero at subscribe time (line 146)

Line 146-150 of `TerminalPane.js` sends the initial subscribe with `initDims?.cols || cols`. If `proposeDimensions()` returns null (because fit() computed 0x0), the subscribe message uses the hardcoded fallback (120x30). The server then configures the PTY at 120x30, but the terminal canvas is sized at 0x0. This mismatch means the terminal *receives* output at 120 cols but renders at 0 pixels -- the text is written to the buffer but invisible. None of the tests check that the dimensions sent in `session:subscribe` match the actual rendered terminal size.

**Fix required:** Add a test or assertion (can be added to T-2) that captures the WebSocket `session:subscribe` message and verifies the cols/rows sent are non-zero AND match `fitAddon.proposeDimensions()` at the time the terminal is actually visible.

### 4. No test for rapid session switching / component unmount-remount race

The edge cases section mentions "rapid session switching" and notes the cleanup disposes xterm while a deferred rAF could fire after disposal. This is exactly the kind of adversarial scenario that should have a test. There is no adversarial test for: open session A overlay, immediately switch to session B, verify B renders correctly and A's deferred callbacks don't corrupt B's terminal.

**Fix required:** Add T-6: rapid session switch test. Flow: open session A, wait for canvas, immediately click session B, wait for canvas, assert B renders content and no errors in console. This covers the rAF-after-dispose race condition.

### 5. T-5 (refresh/reconnect) flow is ambiguous about overlay state after reload

Step 7 says "wait for `#session-overlay-terminal` or re-click session" -- this is an OR condition that an executor cannot implement deterministically. Does the overlay auto-reopen after refresh? If not, the test needs to explicitly click the session card. If yes, it needs to wait for the overlay. The executor should not have to guess.

**Fix required:** Investigate whether the app restores the overlay state on refresh (via URL hash, localStorage, etc.). If not, the flow must explicitly state: "Click the session card to re-open the overlay" as a required step, not an optional branch.

### 6. Viewport size not specified for any test

Risk section item 3 says "Set explicit viewport size `{ width: 1440, height: 900 }` in all tests." None of the five test designs specify a viewport size. If Playwright uses its default (1280x720 or smaller), the terminal could be small enough that dimension checks like `width > 100` pass trivially even with partially broken layout.

**Fix required:** Add an explicit viewport size (e.g., `{ width: 1440, height: 900 }`) to each test's flow or to a shared setup section that all tests inherit.

### 7. T-2 step 10 relies on internal `_xterm` property that likely does not exist

Step 10 accesses `xtermEl._xterm.cols` via the DOM element. xterm.js does not expose its `Terminal` instance as `_xterm` on the DOM element. The Preact component stores it in a `useRef`, which is not accessible from the DOM. This step will fail with `undefined`, not because of a bug, but because the selector is wrong.

**Fix required:** Either (a) expose the xterm instance on `window` or as a data attribute for test purposes (e.g., `window.__xterm = xterm` in TerminalPane.js), or (b) use an alternative approach such as reading the terminal dimensions from the canvas size and font metrics, or (c) use Playwright to evaluate inside the Preact component tree.

---

## Minor Observations (Non-blocking)

- T-3 waits 500ms after split/full toggle. This is a magic number; using `waitForFunction` on a resize-complete signal would be more robust, but 500ms is acceptable for a first pass.
- T-4 uses `--disable-gpu` which tests the WebGL-creation-failure path, not the silent-context-loss path. The risk section acknowledges this. Acceptable for v1 of the test suite.
- The test designs do not mention cleanup (killing the server process, removing DATA_DIR). This should be handled by a shared teardown but is not a design gap per se.
- All tests create sessions via both REST API and WebSocket, but the exact WS message sequence (connect, authenticate, create project, create session) is not fully spelled out. An executor familiar with the codebase can infer this, but a "shared setup" section would reduce ambiguity.

---

## Cycle 2 Review

### Verdict: APPROVED

All 7 gaps from the Cycle 1 REVISE verdict have been resolved. Details below.

---

### Item-by-Item Resolution

**1. T-2 vacuous pass (ResizeObserver retroactively fixes dims before assertions)**

Resolved. T-2 now monkey-patches `FitAddon.FitAddon.prototype.fit` (step 4) to capture container and proposed dimensions at the moment of the *first* `fit()` call, before any ResizeObserver correction. The hook is injected before clicking the session card, and assertions (steps 8-9) run against the captured `window.__firstFitDims` values. This correctly fails on the pre-fix codebase where the first `fit()` sees a 0x0 container.

**2. T-1 cursor-only false-PASS**

Resolved. T-1 now sends sentinel text `echo RENDER_CHECK_T1` (step 9), waits for it in the terminal buffer (step 10), asserts pixels matching the text foreground color `#d0d8e0` with +/-20 RGB tolerance (step 13), and asserts at least one buffer line contains non-whitespace characters (step 14). A cursor-only terminal cannot pass these checks.

**3. Missing test for proposeDimensions() null at subscribe time**

Resolved. New test T-6 intercepts the `session:subscribe` WebSocket message via monkey-patching `WebSocket.prototype.send` (step 4), captures the `cols`/`rows` sent, and asserts they are non-zero and match the actual rendered terminal grid within +/-2 tolerance (step 10). The specific check that subscribe did NOT use the 120x30 fallback when rendered dims differ is included.

**4. No adversarial test for rapid session switching (rAF-after-dispose race)**

Resolved. New test T-7 creates two sessions, opens session A, immediately switches to session B within 50ms (step 9), verifies session B renders correctly with visible content (steps 11-13), and asserts no console errors from disposed terminal A's deferred callbacks (step 14).

**5. T-5 flow ambiguous about auto-reopen vs manual click**

Resolved. T-5 step 9 now explicitly states: "Click the session card to re-open the terminal overlay. **Do NOT rely on auto-reopen behavior** -- the app does not restore overlay state on refresh." No ambiguity remains for an executor.

**6. No viewport size specified in tests**

Resolved. A "Shared Test Configuration" section specifies `viewport: { width: 1280, height: 800 }` for all tests, with a rationale explaining why viewport is required. Individual test flows also reference the viewport where relevant.

**7. T-2 nonexistent _xterm DOM property**

Resolved. T-2 steps 12-13 now use `.xterm-screen` bounding rect and `.xterm-char-measure-element` to estimate cols/rows from screen dimensions and character cell metrics. No internal xterm properties are accessed.

---

### Fresh Scan: New Issues

No new blocking issues found. Minor non-blocking observations:

- **T-2 monkey-patch assumes `FitAddon` is a global.** Verified: `FitAddon` is loaded via `<script src="/vendor/xterm-addon-fit.min.js">` in `index.html`, so it is available on `window.FitAddon`. The monkey-patch is valid.

- **T-7 "immediately within 50ms" is implementation-dependent.** The test says to click session B's card within 50ms of session A's canvas appearing. In practice, Playwright's click-to-click latency may exceed 50ms. The test should work regardless -- the key is that session A's deferred rAF has not yet fired. Since rAF fires on the next animation frame (~16ms), any click within a few hundred ms is likely to exercise the race. Acceptable.

- **T-6 tolerance of +/-2 cols/rows is generous.** At 1280x800 viewport, a 2-column discrepancy represents roughly 14-18 pixels of disagreement between subscribe and rendered dims. This is fine for rounding differences but would not catch a case where subscribe sends, say, 85 cols while rendered is 80. The tolerance is acceptable for this test's purpose (catching the 120x30 fallback vs real dims).

- **Risks section is thorough.** The updated risks section (items 1-6) correctly documents the remaining false-PASS scenarios and their mitigations. No gaps.
