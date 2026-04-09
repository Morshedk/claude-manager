# Refresh Bug -- Test Validation Report

**Validator role:** Independent adversarial reviewer
**Date:** 2026-04-09

---

## Test-by-Test Validation

### T-1: handleSubscribed sends resize after refresh

**Outcome: GENUINE PASS**

- The pre-fix run produced FAIL with 0 `session:resize` messages after refresh click. The post-fix run produced PASS with exactly 1 `session:resize` (cols=74, rows=46). This is the expected behavior change from Fix C.
- The WS spy was installed via `page.evaluate` patching `WebSocket.prototype.send` BEFORE the Refresh click, and the log was cleared implicitly (fresh `_wsLog` array). The spy captured `session:refresh` and `session:resize` -- both expected messages.

**Design sound?** Yes, with a caveat. This test would catch a regression if Fix C were reverted: without the rAF+fit+resize in `handleSubscribed`, no `session:resize` appears in the log. However, it does NOT prove the resize came from `handleSubscribed` specifically. If some other code path (e.g., a future ResizeObserver change, or a server-side echo) also sent a `session:resize` after refresh, this test would still pass. T-5 adds the timing ordering check but suffers from the same fundamental limitation -- see T-5 analysis.

**Execution faithful?** Yes. The test code matches the design: installs WS spy, clicks Refresh, waits 3s, checks for `session:resize` with valid cols/rows. The use of `page.evaluate` instead of `addInitScript` is noted in the executor output as an infrastructure fix; this is actually MORE faithful to the design (which specifies `page.evaluate` at step 7) than `addInitScript` would have been.

**Minor observation:** The test waits for `.xterm-screen` selector with a `.catch(() => {})`, meaning if the terminal never renders, the test silently continues. The subsequent 3000ms sleep is the real gate. This is a watered-down precondition -- if xterm never mounts, the test would still run (and likely fail on assertions, so not a false-PASS risk, but it is sloppy).

---

### T-2: Terminal shows content and accepts input after refresh (smoke)

**Outcome: GENUINE PASS (as a smoke test)**

- This test was designed to PASS both pre-fix and post-fix. It did. The pre-fix PASS is expected because the test does not create a dimension mismatch. The post-fix PASS confirms the fix did not break the basic refresh flow.
- This is NOT a bug-mode test. It cannot distinguish between a fixed and unfixed codebase. Its value is purely as a regression guard for the core user experience.

**Design sound?** Yes, for its stated purpose (smoke test). No, for catching a Fix C revert -- it would still pass without Fix C because it resizes back to original dimensions before refreshing.

**Execution faithful?** Partially. The design specifies steps 7-8 (resize to 900x600 then back to 1200x800) to ensure the terminal has been through a resize cycle. The implementation DOES NOT perform these resize steps -- it goes straight from overlay-open to clicking Refresh. This is a deviation from the design. However, since the test was expected to PASS pre-fix regardless (and the resize-back step is what makes it pass pre-fix), this omission does not change the outcome. The test is simpler than designed but the conclusion is the same.

**Critical observation on T-2's assertion strategy:** The test sends `echo REFRESH_TEST_OK` via a SEPARATE WS client (not via the Playwright browser's keyboard). This means it tests whether the PTY accepts input over WS, NOT whether the xterm terminal in the browser is interactive. The design specifies "Type `echo REFRESH_TEST_OK` into the terminal via Playwright keyboard" (step 13) but the implementation uses a raw WS `session:input` message. This is a meaningful downgrade -- it bypasses the xterm input pipeline entirely. If the xterm terminal were frozen/unresponsive (the actual bug symptom), this assertion would still PASS because the WS client talks directly to the server. **This is a partial VACUOUS PASS for assertion A2** -- it tests server-side PTY liveness, not client-side terminal interactivity.

---

### T-3: Dimension mismatch after refresh

**Outcome: GENUINE PASS**

- This is the strongest test in the suite. Pre-fix: the PTY reports rows=46, cols=74 (stale 1200x800 dimensions) after refresh at 800x500 viewport. Post-fix: the PTY reports rows=26, cols=49 (correct 800x500 dimensions). The resize-drop monkey-patch created a genuine dimension mismatch, and Fix C resolved it.
- The pre-fix FAIL is mechanistic and clearly documented: 0 `session:resize` messages sent, `stty size` confirms stale dimensions.
- The post-fix PASS shows 1 `session:resize` with cols=49, rows=26, and `stty size` confirms matching dimensions.

**Design sound?** Yes. This test would definitively catch a regression if Fix C were reverted. The forced mismatch (drop resize messages during viewport shrink) ensures the server has stale dimensions, and only the `handleSubscribed` re-fit path can correct them after refresh.

**Execution faithful?** Yes. The implementation matches the revised design flow (steps 8-16): install resize-drop interceptor, shrink viewport, re-enable sends, click Refresh, check `stty size`. The `stty size` verification via a separate WS client is appropriate here because it tests the server-side PTY dimensions (which is the bug's effect), not the client UI.

**Minor observation:** The assertion A2 has a fallback path (lines 298-311) where if `initialDims` is null, it compares against the resize message cols instead. This weakens the assertion but the test output shows both `initialDims` and `postRefreshDims` were captured successfully, so the primary path executed.

---

### T-5: No resize sent -- rigorous timing assertion

**Outcome: GENUINE PASS**

- Pre-fix: WS log shows `[session:refresh]` only, 0 `session:resize` after. Post-fix: WS log shows `[session:refresh, session:resize]`, resize at cols=55, rows=33 (matching 900x600 viewport).
- The timing assertion (resize appears after refresh in the log sequence) is satisfied.

**Design sound?** Yes, but with redundancy caveat (see below). This test would catch a regression if Fix C were reverted.

**Execution faithful?** Yes. The implementation matches the design: resize viewport to 900x600, install WS spy, click Refresh, check for `session:resize` after `session:refresh` in the log. The fallback logic (lines 217-221) handles the edge case where `session:refresh` might not appear in the log, which is defensive but did not trigger in practice.

**T-1 vs T-5 differentiation analysis:** Both tests assert "a `session:resize` was sent after clicking Refresh." T-5 adds:
1. A viewport resize to 900x600 before refresh (T-1 stays at 1200x800)
2. Explicit ordering check: `session:resize` appears after `session:refresh` in the log sequence
3. Session ID assertion (A3)

In practice, T-1 and T-5 are testing the same code path (Fix C's rAF in `handleSubscribed`). The differentiation is marginal. T-5's claim of being "rigorous" is slightly oversold -- it does NOT prove the resize came from `handleSubscribed` rather than some other source. It only proves a resize appeared in the log after a refresh. T-1 proves the same thing. The viewport resize in T-5 (900x600) does not create a forced mismatch like T-3 does, so it doesn't add dimension-verification value either.

**Verdict on redundancy:** T-5 is a marginally more thorough version of T-1. If either were removed, regression coverage would not decrease meaningfully. T-3 is the test that provides unique, irreplaceable coverage.

---

## Structural Debt Assessment

### Check 1: Dead code

**Result: CLEAN**

The old `handleSubscribed` was:
```javascript
const handleSubscribed = (msg) => {
  if (msg.id !== sessionId) return;
  xterm.reset();
};
```

The new version replaces this entirely -- no old code remains alongside the new. There is no orphaned logic.

### Check 2: Scattered ownership (re-fit logic duplication)

**Result: ISSUE FOUND -- acceptable duplication, but documented**

The re-fit + resize-send logic now exists in THREE places:

1. **`handleSubscribed`** (line 142-148): `requestAnimationFrame(() => { fitAddon.fit(); proposeDimensions(); send(SESSION_RESIZE); })`
2. **`handleReconnect` (connection:open handler)** (line 181-190): `xterm.reset(); proposeDimensions(); send(SESSION_SUBSCRIBE, cols, rows)` -- note this sends `SESSION_SUBSCRIBE` not `SESSION_RESIZE`, and does NOT use rAF
3. **ResizeObserver callback** (line 194-199): `fitAddon.fit(); proposeDimensions(); send(SESSION_RESIZE)`

These three are NOT identical:
- `handleSubscribed` uses rAF, sends `SESSION_RESIZE`
- `handleReconnect` sends `SESSION_SUBSCRIBE` (re-subscribes, different protocol message), no rAF
- ResizeObserver sends `SESSION_RESIZE`, no rAF

The inconsistency between `handleSubscribed` (uses rAF) and ResizeObserver (no rAF) is intentional and correct -- `handleSubscribed` needs rAF because `xterm.reset()` just ran and the layout needs to settle; ResizeObserver fires after the container has already changed size. The different message types between `handleSubscribed` and `handleReconnect` are also correct -- reconnect needs to re-subscribe, refresh only needs to re-send dimensions.

This is three copies of similar-but-not-identical logic. It's not a bug, but a future refactor could extract a `fitAndSyncDimensions()` helper. Low priority.

### Check 3: Effect scope correctness (stale closure risk)

**Result: CLEAN**

The `handleSubscribed` function closes over `fitAddon`, `send`, `sessionId`, and `CLIENT` from the outer `useEffect` scope. These are all created fresh each time the effect runs (when `sessionId` changes):
- `fitAddon` is created at line 61
- `send` is imported at module scope (stable reference)
- `sessionId` is captured from props at effect creation time
- `CLIENT` is a module-level constant (stable)

There is no stale closure risk. The cleanup function (line 204) runs before re-creation on `sessionId` change, removing the old `handleSubscribed` listener. New listener captures new `sessionId`.

### Check 4: Cleanup completeness (rAF use-after-dispose)

**Result: ISSUE FOUND**

The fix adds `requestAnimationFrame(() => { ... fitAddon.fit(); ... send(...) })` inside `handleSubscribed` (line 142). If the component unmounts before the rAF callback fires:

1. The cleanup function runs (line 204-214): it calls `off(SERVER.SESSION_SUBSCRIBED, handleSubscribed)`, `resizeObserver.disconnect()`, `send(SESSION_UNSUBSCRIBE)`, and `xterm.dispose()`.
2. The rAF callback fires on the next animation frame.
3. `fitAddon.fit()` is called on a disposed xterm instance. The `try/catch {}` on line 143 catches the resulting error -- so this does not crash.
4. `fitAddon.proposeDimensions()` may return null or throw (caught by the `if (dims)` guard).
5. `send(SESSION_RESIZE)` sends a resize for a session we just unsubscribed from. This is a spurious message -- the server receives a resize for a session that has no viewer for this client. It's harmless but wasteful.

The rAF ID is NOT stored and `cancelAnimationFrame` is NOT called in the cleanup function. This is a real gap. In practice, it's benign because:
- The `try/catch` prevents crashes
- The spurious resize message is ignored by the server
- The timing window is ~16ms (one animation frame)

However, it should be fixed for correctness: store the rAF ID and cancel it in cleanup. The initial mount path (line 164-175) has the SAME issue -- its double-rAF is also not cancelled on cleanup. So this is pre-existing technical debt, not introduced by Fix C, but Fix C perpetuates it.

**Severity: Low.** Not a user-visible bug, but a code quality issue.

### Check 5: Orphaned references (CLIENT.SESSION_RESIZE import)

**Result: CLEAN**

`CLIENT` is imported at line 4: `import { SERVER, CLIENT } from '../ws/protocol.js';`

`CLIENT.SESSION_RESIZE` is defined in `/home/claude-runner/apps/claude-web-app-v2/public/js/ws/protocol.js` at line 7 as `'session:resize'`. The import is correct and the constant exists.

---

## Overall Verdict

**BUG FIXED WITH GAPS**

### Bug fix status
All bug-mode tests (T-1, T-3, T-5) are GENUINE PASS. The fix correctly adds re-fit + dimension sync to `handleSubscribed`, resolving the black/unresponsive terminal after refresh. T-3 (the strongest test) proves the dimension mismatch is resolved end-to-end.

### Gaps documented

1. **T-2 assertion is partially vacuous.** The "keyboard input works" assertion (A2) sends input via a raw WS client, not via the browser's xterm terminal. This bypasses the client-side input pipeline and would pass even if the terminal were visually frozen. The test proves the PTY is alive, not that the terminal UI is interactive. To fix: send keystrokes via `page.keyboard.type()` and check for output in the xterm buffer via DOM inspection.

2. **T-1 and T-5 are near-duplicates.** Both test the same assertion (resize sent after refresh). T-5 adds marginal value (ordering check, session ID check, non-default viewport). Recommend keeping T-3 + T-5 and dropping T-1, or extracting T-1/T-5 into a single parameterized test.

3. **rAF not cancelled on unmount (structural).** The `requestAnimationFrame` in `handleSubscribed` is not cancelled in the cleanup function. This is a pre-existing pattern (the initial mount rAF has the same issue) but Fix C perpetuates it. Low severity -- the `try/catch` prevents crashes and the spurious message is harmless.

4. **Watered-down terminal-ready precondition.** All tests use `.xterm-screen` selector + fixed sleep instead of verifying actual terminal content. This means if the terminal fails to render, the test runs anyway. In practice, the assertions would catch the failure downstream, but the precondition should be tighter for diagnostic clarity.

### What would NOT be caught by these tests

- Terminal appearing visually blank but with a functioning PTY (the xterm rendering layer is broken but WS communication works). T-2's WS-based echo test would pass in this scenario. T-3's `stty size` would also pass. Only a visual/DOM assertion on the terminal buffer content would catch this.
- Race condition where `session:output` arrives before `session:subscribed` (acknowledged in the design as a localhost-vs-production timing difference). The fix is still correct in this case because `handleSubscribed` fires on the event regardless of prior output.
