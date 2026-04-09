# Black Box Terminal — Test Validation (Adversarial Review)

**Reviewer role:** TEST VALIDATOR (adversarial — rewarded for finding false PASSes)

**Date:** 2026-04-09

---

## T-1: Terminal renders visible content after session attach

### 1. Outcome valid? GENUINE PASS

The test sends a sentinel string (`echo RENDER_CHECK_T1`), waits for it to appear in `.xterm-rows` DOM text, and asserts xterm-screen has non-zero bounding rect dimensions. Both checks are substantive.

**However, there is a weakening from the design.** The original design (Section 4) specified: assert canvas contains pixels matching the text foreground color `#d0d8e0`. The implementation dropped the pixel-color assertion entirely and replaced it with DOM text content checks (`rows.textContent.includes('RENDER_CHECK_T1')`). The implementation notes (02) explain that `getImageData` on a WebGL canvas returns zeros because the GL context data is not readable via the 2D API. This is a legitimate infrastructure limitation, but it means T-1 tests the xterm *buffer* (DOM layer), not the *rendered canvas*. If the WebGL canvas were broken but the DOM fallback row layer were intact, T-1 would still pass. This is a minor gap — xterm's DOM row layer and canvas are tightly coupled — but the test is weaker than designed.

### 2. Design sound? Yes, with the caveat above.

If the fix were reverted, the container would be 0x0 at mount time, `fit()` would fail, and the terminal canvas would be invisible. The sentinel text would still arrive in the xterm buffer (buffer writes don't depend on canvas size), but `.xterm-rows` children would have zero computed height and `rows.textContent` could still return the text. **Wait** — on a 0x0 terminal, xterm sets cols/rows to 0 (or minimum 1), so the buffer would have 0-1 rows. The `waitForFunction` checking `rows.children.length > 2` would timeout. The marker check would also fail because with 0 cols, the buffer wrapping would corrupt the marker text. So yes, this would catch a regression.

### 3. Execution faithful? Mostly.

The pixel-color assertion was dropped (justified by WebGL canvas read limitation). The DOM-based text check is a reasonable substitute. The sentinel approach matches the design.

---

## T-2: fit() produces non-zero dimensions after mount

### 1. Outcome valid? GENUINE PASS — but with a critical caveat about timing confidence

The monkey-patch captured `containerWidth=639px, containerHeight=704px, proposedCols=79, proposedRows=46` at the first `fit()` call. These are real, non-zero dimensions, proving the double-rAF deferred the call until after layout.

**The critical question from the prompt: does the monkey-patch actually intercept before ResizeObserver corrects?**

Looking at the TerminalPane.js code: the `ResizeObserver` is created at line 184 and `resizeObserver.observe(container)` is at line 191. The double-rAF `fit()` call is at lines 154-165. The ResizeObserver fires asynchronously when the observed element's size changes. Here's the timeline:

1. `xterm.open(container)` — container gets xterm children, may trigger ResizeObserver
2. `resizeObserver.observe(container)` — registered at line 191, synchronously after open
3. Double-rAF fires — calls `fit()` at ~2 frames later

**The ResizeObserver callback fires after a layout cycle.** If the container transitions from 0 to its real size (which happens once the flex layout resolves), the ResizeObserver fires and calls `fitAddon.fit()` — potentially BEFORE the double-rAF fires. The monkey-patch records the first `fit()` call regardless of source (double-rAF or ResizeObserver). If the ResizeObserver fires first, the captured dimensions would show non-zero values (because the ResizeObserver fires precisely when the container gains its real size), and the test would pass — but it would be the ResizeObserver that fixed things, not the double-rAF.

**However**, looking at the run output: `containerWidth=639px` was captured. If the ResizeObserver had fired first, the dimensions would be identical (same container, same moment of measurement). The test cannot distinguish between "double-rAF deferred fit correctly" and "ResizeObserver retroactively corrected before the double-rAF even fired." Both produce the same `firstFitDims`.

**This matters for regression detection.** If the fix were reverted (synchronous `fit()` at line 83, before ResizeObserver registration), the first `fit()` would fire with 0x0 container, the monkey-patch would capture zeros, and the test would FAIL. So despite the ambiguity about which mechanism fires first in the fixed code, the test still correctly distinguishes fixed vs. unfixed.

**Verdict: GENUINE PASS**, but the test does not prove the double-rAF is the specific mechanism responsible — it could be the ResizeObserver belt-and-suspenders doing the work. The test proves the *combined fix* works, not that the double-rAF alone is sufficient.

### 2. Design sound? Yes for regression detection.

Reverted code would produce `containerWidth=0, containerHeight=0` at the first `fit()`, which fails the assertions.

### 3. Execution faithful? Partial deviation.

The design specified reading canvas dimensions at first fit and estimating cols/rows from `xterm-char-measure-element`. The implementation discovered that `xterm-char-measure-element` returns unreliable widths in headless WebGL mode (250px instead of ~8px per character). The implementation fell back to using `firstFit.proposedCols` and DOM row count, which is reasonable but means the "cross-check cols from two independent sources" intent was weakened. The `settled` state checks reuse `firstFit.proposedCols` rather than independently deriving cols — this is circular (checking fit's output against fit's output).

---

## T-3: Terminal survives split/full toggle without going black

### 1. Outcome valid? GENUINE PASS

The test writes a sentinel, toggles split-to-full and full-to-split, and confirms the sentinel text persists in `.xterm-rows.textContent` after both transitions. Screen dimensions are checked after each toggle. The run output confirms width changes (618px to 1260px and back), proving the toggle actually occurred and the terminal re-rendered at the new size.

### 2. Design sound? Yes.

The split/full toggle exercises the ResizeObserver path and terminal re-fitting. If the fix broke resize handling, this test would detect it. Not directly related to the initial-mount bug, but validates the ResizeObserver belt-and-suspenders path.

### 3. Execution faithful? Yes, with minor adaptation.

The implementation correctly detected the initial split state dynamically rather than hardcoding the button label. This was an infrastructure fix, not a change to what the test validates.

---

## T-4: Terminal renders in headless/no-WebGL environment

### 1. Outcome valid? GENUINE PASS — but with a known gap acknowledged in the design

**The critical question from the prompt: does `--disable-gpu` actually exercise the Canvas fallback path, or does Chromium still use GPU in headless mode?**

Looking at the test output: "WebGL context loss handler (Fix B) triggered graceful fallback to Canvas renderer." This is significant — it means WebGL addon *attempted* to initialize, the context was created but immediately lost (or `--disable-gpu` caused context creation failure), and the `onContextLoss` handler fired. The Canvas fallback was exercised.

However, the design notes (Section 5, risk #5) acknowledge: `--disable-gpu` causes WebGL to fail at *creation time*, not after silent context loss. The real-world scenario is WebGL appearing to work initially and then losing context later (GPU driver reset, tab backgrounding). This test does not cover that scenario.

**More importantly:** headless Chromium on a CI server without a physical GPU may already be running without GPU acceleration regardless of the `--disable-gpu` flag. If the test environment has no GPU, then ALL tests are already running the Canvas fallback, and T-4 adds nothing beyond what T-1 already proves. The run output shows `xterm-screen dimensions: 618x690px (same as GPU mode)` — the "(same as GPU mode)" comment suggests the tester noticed the dimensions were identical, which is suspicious. If WebGL were active in other tests, the rendering pipeline would be different even if screen dimensions matched.

### 2. Design sound? Adequate for creation-time failure.

If the fix's WebGL context loss handler were broken, this test would catch it (no Canvas fallback, broken rendering). But it does not test the more insidious scenario of late context loss.

### 3. Execution faithful? Yes.

The implementation matches the design. The `--disable-gpu` arg is passed, console errors are filtered to exclude expected WebGL failures, and the sentinel text check works.

---

## T-5: Terminal content visible on page refresh (reconnect scenario)

### 1. Outcome valid? GENUINE PASS

The test performs a full page reload, re-opens the overlay, and confirms the terminal has non-zero screen dimensions and rendered rows. The run output shows 46 rows after refresh.

**One weakness:** The test does not verify that the pre-refresh sentinel (`REFRESH_MARKER_789`) is visible after refresh. The design (Section 4) says: "Check that terminal has content (cursor visible, or if PTY replays, output visible)." The implementation checks row count and screen dimensions but does not assert the marker persists. This is defensible — whether the PTY replays scrollback depends on server-side behavior — but it means the test only proves the terminal is not a black box, not that PTY replay works correctly.

### 2. Design sound? Yes for the black-box bug.

If the fix were reverted, the terminal would mount with 0x0 dimensions after refresh (same as initial mount), and the `rows.children.length > 2` check would timeout. The test catches the regression.

### 3. Execution faithful? Yes, minor weakening.

No marker persistence check after refresh, but the design explicitly noted this was optional ("cursor visible, or if PTY replays, output visible"). The row count check is sufficient.

---

## T-6: PTY subscribe dimensions match rendered canvas

### 1. Outcome valid? GENUINE PASS — this is the strongest test in the suite

The test intercepts `WebSocket.prototype.send`, captures the `session:subscribe` message, and verifies `cols=79, rows=46`. It then derives cell width (`618/79 = 7.8px`) and asserts it is >= 6px. The 120x30 fallback on a 618px screen would give `618/120 = 5.15px`, which fails the threshold. The row count matches within tolerance.

**The critical question from the prompt: could this pass on the pre-fix codebase if the WS message was delayed enough for layout to resolve naturally?**

On the pre-fix codebase, the `session:subscribe` was sent *synchronously* right after `fitAddon.fit()` (which was also synchronous). `proposeDimensions()` would return null (because fit computed against a 0x0 container), so the fallback `cols: 120, rows: 30` would be sent. The WebSocket interceptor captures the message at `send()` time — there is no delay between `proposeDimensions()` returning null and `send()` being called. The WS send happens synchronously in the same microtask. Layout resolving "naturally" (via ResizeObserver) happens later, in a separate task. **The pre-fix code would send 120x30 before the ResizeObserver could fire.**

**But wait:** the ResizeObserver also calls `session:resize` (line 188 in TerminalPane.js). If the ResizeObserver fires after the subscribe, it sends a resize message that corrects the PTY dimensions. The test only captures the *first* `session:subscribe`, not subsequent `session:resize` messages. So the PTY would start at 120x30, then get corrected to 79x46. The terminal would still render correctly after correction. **T-6 catches the initial wrong dimensions even if the ResizeObserver corrects them later.** This is exactly what the test should do.

### 2. Design sound? Yes, this is the best-designed test.

It directly tests the mechanism that changed (subscribe dimensions) and uses a threshold that distinguishes fixed from unfixed behavior. The 6px threshold is well-calibrated.

### 3. Execution faithful? Yes, with justified adaptation.

The `xterm-char-measure-element` approach was replaced with derived cell width from `screenWidth/cols`, which is actually more robust and directly tests what matters (whether the cols/screen proportion is plausible).

---

## T-7: Rapid session switching does not produce black box (rAF-after-dispose race)

### 1. Outcome valid? INCONCLUSIVE — the test was watered down to the point where it may not exercise the race

**The critical question from the prompt: did watering down the test setup change what the test actually proves?**

The original design specified: "Click session A's card to open the terminal overlay. Wait for `.xterm-screen canvas` to appear. **Immediately** (within 50ms, no explicit wait for content) click session B's card."

The implementation does something different:
1. Click session A's card
2. Wait for overlay and canvas (lines 189-193)
3. **Click the detach button to close the overlay** (lines 206-215)
4. Wait 50ms
5. Click session B's card

This is fundamentally different from the design. The design intended a *direct switch* while session A's terminal is still mounting (double-rAF pending). The implementation first *closes* session A's overlay (triggering cleanup/dispose), waits 50ms, then opens session B. By the time session B opens, session A's cleanup is already complete and its deferred rAF has either fired (into the try/catch) or been abandoned. **The race window the design intended to test — session A's rAF firing while session B is mounting — is not exercised.**

Furthermore, the implementation notes (03-test-run-output.txt, attempt 3) reveal the test was modified because "creating session A and B via separate WS connections caused a server-side race." This is a legitimate infrastructure issue, but the fix (creating both on one WS, using detach-then-click instead of direct switch) eliminated the timing pressure that makes this test meaningful.

**The 50ms delay between overlay close and session B click** is generous — at 60fps, the double-rAF completes in ~33ms, so by the time session B opens, session A's rAF has already resolved. The test proves "session B renders after session A is fully cleaned up" — not "session B renders when session A's rAF is still pending."

### 2. Design sound? The original design was sound. The implementation is not.

The original design would catch a regression where the try/catch around `fit()` in the rAF was removed (causing a crash when fitting a disposed terminal during session B's mount). The weakened implementation would not catch this regression because session A is fully disposed before session B opens.

### 3. Execution faithful? No.

The detach-then-reopen approach fundamentally changes the race timing. The original design specified clicking session B's card directly while session A is mounting. The implementation closes session A first, then opens session B separately. This is not the same test.

---

## Overall Verdict

**BUG PARTIAL: fix works in tested cases but known gaps remain**

### What is verified:
- **T-6 (GENUINE PASS)** is the strongest evidence. The `session:subscribe` message sends real dimensions (cols=79, not fallback 120), proving `proposeDimensions()` returned non-null after the deferred `fit()`. This directly tests the fix mechanism and would fail on the pre-fix codebase.
- **T-2 (GENUINE PASS)** confirms the container has resolved layout dimensions at the time of the first `fit()` call, though it cannot distinguish double-rAF from ResizeObserver as the correcting mechanism.
- **T-1, T-3, T-5 (GENUINE PASS)** provide end-to-end confirmation that the terminal is not a black box in normal usage, split toggle, and page refresh scenarios.
- **T-4 (GENUINE PASS)** confirms the WebGL-to-Canvas fallback works at creation-time failure.

### Known gaps:
1. **T-7 (INCONCLUSIVE):** The rapid-switch race test was watered down. The rAF-after-dispose race is not exercised. If someone removed the `try/catch` around `fitAddon.fit()` inside the rAF, this test would not catch it.
2. **T-1 pixel-color assertion dropped:** Canvas pixel verification was replaced with DOM text checks due to WebGL canvas read limitation. If the WebGL canvas were broken but the DOM row layer worked, T-1 would not detect it.
3. **T-4 does not test late context loss:** Only tests creation-time WebGL failure, not the more dangerous silent-loss-after-success scenario.
4. **T-2 cannot isolate double-rAF from ResizeObserver:** Both mechanisms produce identical observable output. If the double-rAF were removed but the ResizeObserver remained, T-2 might still pass (depending on observer timing).

### Summary:
The fix is verified for the primary bug (subscribe sends real dimensions, terminal has content on mount). T-6 alone would be sufficient evidence. The supporting tests add confidence for secondary scenarios but T-7's weakening is a genuine gap — the rAF-after-dispose race condition remains untested. No false PASSes were found in T-1 through T-6; T-7 is INCONCLUSIVE rather than a false PASS because it tested a different (easier) scenario than designed.
