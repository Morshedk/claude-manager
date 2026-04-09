# Refresh Bug -- Investigation & Test Design (Revised)

## Candidate Root Causes (Ranked by Probability)

### 1. After refresh, `session:subscribed` triggers `xterm.reset()` but no re-fit or dimension sync occurs (PROBABILITY: 50%)

**Evidence:**
- `public/js/components/TerminalPane.js:136-139`: `handleSubscribed` only calls `xterm.reset()`. It does NOT re-fit the terminal, re-subscribe, or re-send dimensions.
- The initial mount uses a double-rAF sequence (lines 154-165) to fit the terminal and subscribe with actual dimensions. After refresh, this sequence does NOT re-run because `useEffect([sessionId])` only fires when `sessionId` changes -- and refresh does not change the session ID.
- The xterm buffer is cleared, PTY output flows, but the terminal may not be properly fitted to the container after the reset. If the container size changed since initial mount (e.g., split-view resize, browser resize), the PTY and xterm are dimensionally mismatched.

### 2. `refreshSession()` sends no cols/rows -- PTY restarts at stale stored dimensions (PROBABILITY: 30%)

**Evidence:**
- `public/js/state/actions.js:90-91`: `send({ type: CLIENT.SESSION_REFRESH, id: sessionId })` -- no cols, no rows
- `lib/ws/handlers/sessionHandlers.js:182-187`: passes `msg.cols` (undefined) and `msg.rows` (undefined) to `SessionManager.refresh()`
- `lib/sessions/SessionManager.js:348-353`: direct session branch calls `session.refresh(authEnv)` -- cols/rows are NEVER forwarded to direct sessions, even if the client sent them
- The PTY restarts with previously stored `_cols`/`_rows` from the last `resize()` call. These may diverge from the actual terminal dimensions.

### 3. Card-based refresh with no active subscription -- output goes nowhere (PROBABILITY: 15%)

**Evidence:**
- When TerminalPane unmounts (overlay closed), it sends `SESSION_UNSUBSCRIBE` (line 201) and the server removes the viewer via `session.removeViewer(clientId)`.
- On card-based refresh, the new PTY's output flows through `_wirePty.onData` but `this.viewers` may be empty. Output emitted before a viewer re-subscribes is lost.
- Direct sessions have no scrollback replay mechanism, so any output emitted while no viewer is subscribed is permanently lost.

### 4. `msg.cols` and `msg.rows` are undefined -- server-side refresh gets undefined cols/rows (PROBABILITY: 5%)

**Evidence:**
- `SessionManager.refresh()` receives `{ cols: undefined, rows: undefined }`. For direct sessions, these are completely ignored (not passed to `DirectSession.refresh()`). For tmux sessions, they ARE forwarded but tmux handles undefined gracefully.
- This is a design gap but not the primary crash vector.

---

## Section 1: Root Cause

The primary root cause is that TerminalPane's `handleSubscribed` callback (triggered after a refresh) only calls `xterm.reset()` and does nothing else. It does not re-fit the terminal to its container, and it does not send updated dimensions to the server. The initial mount path uses a double-rAF to fit the terminal and subscribe with accurate dimensions, but this path only runs once per `sessionId` lifecycle. After a refresh, the server broadcasts `session:subscribed`, the client resets the xterm buffer, and then relies entirely on the PTY's stored dimensions being correct and on xterm's internal state being consistent after reset.

If the terminal container has been resized since the initial subscribe (due to browser resize, split-view drag, or overlay layout changes), the PTY restarts at stale stored dimensions while the xterm viewport is at different dimensions. This causes content to render incorrectly: lines may wrap wrong, the cursor may be mispositioned, or (in the worst case) the terminal appears black because the PTY's output coordinates do not match what xterm expects.

The fix is to add a re-fit and dimension sync step inside `handleSubscribed`, immediately after `xterm.reset()`. This mirrors the logic already present in the `connection:open` reconnect handler (lines 171-180) which correctly resets, re-fits, and re-subscribes with fresh dimensions.

Relevant files and lines:
- `public/js/components/TerminalPane.js:136-139` -- `handleSubscribed` calls only `xterm.reset()`, missing re-fit
- `public/js/components/TerminalPane.js:154-165` -- initial mount double-rAF with fit + subscribe (runs once)
- `public/js/components/TerminalPane.js:171-180` -- reconnect handler that correctly re-fits (the model for the fix)
- `public/js/components/TerminalPane.js:184-190` -- ResizeObserver on the container div
- `public/js/state/actions.js:90-91` -- `refreshSession()` sends no cols/rows
- `lib/sessions/SessionManager.js:348-353` -- direct session branch ignores cols/rows

---

## Section 2: Fix Design

**Design choice: Fix C only (re-fit in `handleSubscribed`).**

The plan review correctly identified that Fixes A, B, and D form a dead code path -- `refreshSession()` gains `cols`/`rows` parameters, but no caller passes them. SessionOverlay has no access to TerminalPane's fitAddon, and adding cross-component plumbing (store signals, refs) adds complexity for no immediate benefit: Fix C alone resolves the user-visible bug by ensuring the client re-fits and re-sends dimensions after every `session:subscribed` event.

This is the conservative choice. Fix C is a single, self-contained change in one function that mirrors existing working code (the reconnect handler). It requires no changes to the WS protocol, no server-side changes, and no cross-component wiring.

### Fix C: Re-fit and re-send dimensions in handleSubscribed

**File:** `public/js/components/TerminalPane.js`
**Function:** `handleSubscribed` (line 136)

```javascript
// Before:
const handleSubscribed = (msg) => {
  if (msg.id !== sessionId) return;
  xterm.reset();
};

// After:
const handleSubscribed = (msg) => {
  if (msg.id !== sessionId) return;
  xterm.reset();
  // Re-fit terminal and sync dimensions with PTY after refresh/reconnect.
  // Without this, the PTY may be at stale dimensions after restart.
  // Mirrors the logic in the connection:open reconnect handler.
  requestAnimationFrame(() => {
    try { fitAddon.fit(); } catch {}
    const dims = fitAddon.proposeDimensions();
    if (dims) {
      send({ type: CLIENT.SESSION_RESIZE, id: sessionId, cols: dims.cols, rows: dims.rows });
    }
  });
};
```

### Why rAF is needed

`xterm.reset()` clears the buffer and resets internal state. The subsequent `fitAddon.fit()` needs the browser to have completed its layout pass so it can measure the container correctly. A single `requestAnimationFrame` defers the fit to after the next paint, which is sufficient (the double-rAF in the initial mount is more cautious because the container may not have been laid out at all yet; here it already has been).

### Edge Cases
- **Card-based refresh (no TerminalPane mounted):** No `handleSubscribed` fires because TerminalPane is not mounted. When the user later opens the overlay, TerminalPane mounts, the double-rAF initial fit runs, and the subscribe sends correct dimensions. No change needed for this path.
- **Multiple viewers:** All viewers receive `session:subscribed` and each TerminalPane re-fits independently. Each sends its own `SESSION_RESIZE`. The last one wins on the server, which is correct (viewers may be at different sizes, but only one can be "primary").
- **WS reconnect during refresh:** The `connection:open` handler already re-fits. If both fire, the second fit is harmless (fitting an already-fitted terminal is a no-op in terms of dimensions).

---

## Section 3: Acceptance Criteria

1. Given a running session with the overlay open, when the user clicks Refresh, then the terminal clears and displays new output from the restarted process within 5 seconds.

2. Given a running session with the overlay open at a non-default width (e.g., after a browser resize), when the user clicks Refresh, then a `session:resize` message is sent from the client after the `session:subscribed` event is received, ensuring the PTY dimensions match the current terminal viewport.

3. Given a running session with the overlay open, when the user clicks Refresh, then keyboard input typed after the process reaches RUNNING state is delivered to the new PTY and produces visible output.

4. Given a session refreshed from the session card (overlay closed), when the user subsequently opens the overlay, then the terminal displays live output from the restarted process.

5. Given a running session with the overlay open at a split-view width significantly different from the default 120x30, when the user clicks Refresh, then the restarted PTY uses the actual viewport dimensions (not the stored defaults).

---

## Section 4: Test Designs (BUG MODE)

### T-1: handleSubscribed sends resize after refresh (Playwright E2E)

**Purpose:** Verify that the fix (re-fit + resize in `handleSubscribed`) actually fires after a refresh. This directly tests the Fix C behavior.

**Flow:**
1. Start server on port 3500 with DATA_DIR in a temp directory
2. Create a project via REST API
3. Open Playwright browser at viewport 1200x800
4. Create a session (command: `bash`) via the new-session UI
5. Click on the session card to open the overlay
6. Wait for terminal to render (bash prompt visible)
7. Set up a WS message interceptor via `page.evaluate` that monkey-patches the WebSocket `send` method to record all outgoing messages with timestamps
8. Click the Refresh button in the overlay header
9. Wait for the terminal to show new content (bash prompt after refresh)
10. Collect the intercepted outgoing WS messages
11. Assert: at least one `session:resize` message was sent AFTER the Refresh button was clicked
12. Assert: the `session:resize` message contains valid `cols` and `rows` values (both > 0)

**Pre-fix result:** FAIL -- `handleSubscribed` only calls `xterm.reset()`. No `session:resize` message is sent after the refresh. The intercepted messages list contains no `session:resize` after the refresh timestamp. Assertion at step 11 fails.

Note: The ResizeObserver (line 184) observes the container div element, not xterm internals. `xterm.reset()` clears the terminal buffer but does not change the container div's dimensions, so ResizeObserver does NOT fire. This was verified by inspecting the source: the observer is attached via `resizeObserver.observe(container)` where `container` is the outer div with `style="height:100%;width:100%;overflow:hidden;"`. A buffer reset does not trigger a DOM layout change on this div.

**Post-fix result:** PASS -- The fixed `handleSubscribed` calls `fitAddon.fit()` and sends `SESSION_RESIZE` inside a `requestAnimationFrame`. The interceptor captures a `session:resize` message after the refresh click. Assertion passes.

**Test type:** Playwright E2E
**Port:** 3500

---

### T-2: Terminal shows content and accepts input after refresh (Playwright E2E)

**Purpose:** Verify the core user-visible bug is fixed: after clicking Refresh, the terminal is not black/unresponsive.

**Flow:**
1. Start server on port 3501
2. Create project via REST API
3. Open Playwright browser at viewport 1200x800
4. Create a session (command: `bash`) via the new-session UI
5. Click on the session card to open the overlay
6. Wait for terminal to show content (bash prompt)
7. Resize the browser window to 900x600 (this changes the terminal container width, triggering ResizeObserver which sends a resize to the server; the PTY is now at the new dimensions)
8. Resize the browser window back to 1200x800 (terminal container is back to original size; ResizeObserver fires again and the PTY dimensions are updated to match)
9. Click the Refresh button in the overlay header
10. Wait for toast "Refreshing session..."
11. Wait up to 8 seconds for the terminal to show new content (non-empty rows)
12. Assert: terminal buffer contains at least one non-whitespace character
13. Type `echo REFRESH_TEST_OK` into the terminal via Playwright keyboard
14. Wait up to 5 seconds for "REFRESH_TEST_OK" to appear in terminal output
15. Assert: terminal shows "REFRESH_TEST_OK"

**Pre-fix result:** PASS -- This test actually passes pre-fix when dimensions happen to match (the resize-back-to-original at step 8 syncs everything). This test exists as a **smoke test** for the core user experience, not as a pre-fix FAIL test. See T-3 for the dimension-mismatch variant that reliably fails pre-fix.

**Post-fix result:** PASS

**Classification:** Smoke test (not bug-mode). Included because it tests the fundamental user story. If this test fails post-fix, the fix is broken regardless of what T-1/T-3/T-5 say.

**Test type:** Playwright E2E
**Port:** 3501

---

### T-3: Dimension mismatch after refresh causes incorrect PTY size (Playwright + WS hybrid)

**Purpose:** Verify that after a container resize followed by refresh, the PTY dimensions are updated to match the current viewport. This is the primary bug-mode test for dimension sync.

**Flow:**
1. Start server on port 3502
2. Create project via REST API
3. Open Playwright browser at viewport 1200x800
4. Create a session (command: `bash`) via the new-session UI
5. Click on the session card to open the overlay
6. Wait for terminal to render (bash prompt visible)
7. Record the initial terminal dimensions by running `stty size` in the terminal and parsing the output (expect roughly "rows cols" matching the 1200x800 viewport)
8. Resize the browser window to 800x500 -- this triggers ResizeObserver, which sends `session:resize` to the PTY. The PTY is now at the smaller dimensions.
9. Wait 500ms for the resize to propagate
10. Resize the browser window to 1400x900 -- ResizeObserver fires again, PTY is now at the larger dimensions
11. Wait 500ms for the resize to propagate
12. Now click the Refresh button -- the PTY is killed and restarted. `DirectSession.refresh()` calls `start()` which spawns the new PTY at the stored `_cols`/`_rows` (which ARE the 1400x900-derived values, since resize updated them). The key question is whether `handleSubscribed` re-fits and sends a `session:resize`.
13. Wait for `session:subscribed` (terminal clears)
14. Wait for new bash prompt to appear
15. Type `stty size` and press Enter
16. Parse the output: expect rows and cols matching the 1400x900 viewport
17. Assert: the `stty size` output matches the expected dimensions for a 1400x900 viewport (within +/- 2 tolerance for each dimension)

**Why this fails pre-fix (revised, explicit mechanism):**

The test as described above has a subtlety: because ResizeObserver at step 10 updates `_cols`/`_rows` on the server to the 1400x900 values, the PTY at step 12 restarts at those dimensions -- which happen to be correct. To force a genuine mismatch, we need a scenario where the container changes size AFTER the last resize message but BEFORE the refresh:

**Revised flow (guaranteed pre-fix FAIL):**
1-6. Same as above
7. Record initial dimensions via `stty size`
8. Use `page.evaluate` to disable the ResizeObserver's `session:resize` sending -- monkey-patch `WebSocket.send` to drop outgoing `session:resize` messages (let the observer fire and fit the local xterm, but prevent the resize from reaching the server)
9. Resize the browser window to 800x500 -- ResizeObserver fires, fitAddon.fit() runs locally (xterm is now 800x500-sized), but the `session:resize` message is dropped. Server-side `_cols`/`_rows` remain at the original 1200x800-derived values.
10. Wait 500ms
11. Re-enable `session:resize` sending (stop dropping resize messages)
12. Click Refresh
13. Wait for new bash prompt
14. Type `stty size` and press Enter
15. Parse the output
16. Assert: `stty size` shows dimensions matching the 800x500 viewport (the current actual container size), NOT the original 1200x800 dimensions

**Pre-fix result:** FAIL -- `handleSubscribed` only calls `xterm.reset()`, no re-fit, no resize. The PTY restarts at the server's stored `_cols`/`_rows` (1200x800-derived), but the xterm viewport is physically 800x500-sized. `stty size` reports the old dimensions. Assertion fails because the output shows ~30 rows / ~120 cols instead of ~20 rows / ~80 cols.

**Post-fix result:** PASS -- The fixed `handleSubscribed` calls `fitAddon.fit()` + sends `SESSION_RESIZE` with the actual 800x500-derived dimensions. The server calls `session.resize()` on the PTY. `stty size` now reports the correct smaller dimensions. Assertion passes.

**Test type:** Playwright + WS interception
**Port:** 3502

---

### T-4: Card-based refresh -- overlay opened after refresh shows live output (Playwright E2E)

**Purpose:** Verify that when a session is refreshed from the card (no overlay open), opening the overlay afterward connects to the new PTY and shows live output.

**Flow:**
1. Start server on port 3503
2. Create project via REST API
3. Open Playwright browser
4. Create a session (command: `bash -c 'while true; do echo HEARTBEAT_$(date +%s); sleep 1; done'`)
5. Click on the session card to open the overlay
6. Wait for "HEARTBEAT_" to appear in the terminal (confirm session is running)
7. Close the overlay (click the X or press Escape) -- TerminalPane unmounts, sends `SESSION_UNSUBSCRIBE`, viewer is removed
8. Disconnect the WebSocket from the client side via `page.evaluate(() => window._ws.close())` -- this ensures the creating client's viewer callback is also removed from the server's viewer map
9. Wait 500ms for the server to process the disconnect
10. Reconnect the WebSocket via page navigation or `page.evaluate` to re-establish the WS connection (but do NOT re-subscribe to the session)
11. Click the Refresh button on the session card (not the overlay)
12. Wait 3 seconds (new PTY emits heartbeats, but no viewers are registered)
13. Click on the session card to open the overlay -- TerminalPane mounts, double-rAF fires, subscribes with dimensions
14. Wait up to 5 seconds for "HEARTBEAT_" to appear in the terminal
15. Assert: terminal shows "HEARTBEAT_" text with a recent timestamp

**Pre-fix result:** FAIL -- After the WS disconnect at step 8, the server has no viewers for this session. The refresh at step 11 restarts the PTY, but heartbeats emitted during steps 11-12 are lost (no viewers). When the overlay opens at step 13, TerminalPane subscribes and gets a fresh `session:subscribed`. But the `handleSubscribed` at step 13 is the INITIAL mount path (double-rAF), not the refresh path, so it works correctly. This means the test actually PASSES because the initial mount path is not broken.

**Revised analysis:** This test validates the card-based refresh workflow but does NOT test Fix C (since the initial mount path already works). It is reclassified as a **smoke test** to ensure the card-based refresh + subsequent overlay-open flow does not regress.

**Post-fix result:** PASS

**Classification:** Smoke test (not bug-mode). The initial mount path already fits and subscribes correctly. This test guards against regressions in the card-refresh + overlay-open flow.

**Test type:** Playwright E2E
**Port:** 3503

---

### T-5: No resize sent without the fix -- direct assertion on handleSubscribed behavior (Playwright + WS interception)

**Purpose:** Directly assert that `handleSubscribed` sends a `session:resize` after refresh. This is the most targeted bug-mode test: it fails pre-fix because no resize is sent, and passes post-fix because Fix C adds the resize.

**Flow:**
1. Start server on port 3504
2. Create project via REST API
3. Open Playwright browser at viewport 1200x800
4. Create a session (command: `bash`) via the new-session UI
5. Click on the session card to open the overlay
6. Wait for terminal to render (bash prompt visible)
7. Resize the browser to 900x600 to establish that the terminal is at non-default dimensions
8. Wait 1 second for resize to propagate
9. Set up WS message interception via `page.evaluate`: monkey-patch `WebSocket.send` to log all outgoing messages into a `window._wsLog` array, each entry including `{ type, timestamp, data }`
10. Clear the log array
11. Click the Refresh button
12. Wait for new content to appear in the terminal (bash prompt after refresh)
13. Wait 1 additional second to allow any deferred callbacks (rAF) to complete
14. Collect the log via `page.evaluate(() => window._wsLog)`
15. Find all `session:resize` messages in the log
16. Find the `session:refresh` message in the log (or use the click timestamp as the boundary)
17. Assert: at least one `session:resize` message exists with a timestamp AFTER the `session:refresh` message
18. Assert: the `session:resize` message has `cols > 0` and `rows > 0`

**ResizeObserver false-PASS analysis (verified fact, not hypothesis):**

The ResizeObserver at `TerminalPane.js:184` is attached to the container div via `resizeObserver.observe(container)`. `xterm.reset()` clears the terminal's internal buffer (scrollback, cursor position, etc.) but does NOT change the container div's CSS dimensions or layout. The container div is styled with `height:100%;width:100%;overflow:hidden;` and its size is determined by its parent flex container, not by xterm content. Therefore, `xterm.reset()` does NOT trigger the ResizeObserver, and no `session:resize` message is sent from the ResizeObserver path during a refresh.

Additionally, `fitAddon.fit()` (if it were called) adjusts xterm's internal rows/cols to match the container but does not change the container's own dimensions, so it also does not trigger ResizeObserver. The only way ResizeObserver fires is if the container div's actual pixel dimensions change (e.g., browser resize, split-view drag).

Conclusion: Without Fix C, no `session:resize` is sent after refresh. The ResizeObserver cannot produce a false PASS.

**Pre-fix result:** FAIL -- `handleSubscribed` only calls `xterm.reset()`. No `fitAddon.fit()`, no `SESSION_RESIZE` send. The WS log contains no `session:resize` after the refresh. Assertion at step 17 fails.

**Post-fix result:** PASS -- The fixed `handleSubscribed` calls `fitAddon.fit()` + sends `SESSION_RESIZE` inside `requestAnimationFrame`. The WS log contains a `session:resize` message after the refresh. Assertion passes.

**Test type:** Playwright + WS interception
**Port:** 3504

---

## Section 5: Risks & False-PASS Risks

### Risk 1: T-1 and T-5 overlap -- both test "resize sent after refresh"

T-1 and T-5 are structurally similar (both assert a `session:resize` is sent after refresh). T-1 is simpler and tests the happy path. T-5 adds explicit timing assertions relative to the refresh message and verifies the ResizeObserver is not the source. If T-1 is sufficient, T-5 can be dropped. If both are kept, they should use different ports and the executor should note the overlap.

**Recommendation:** Keep both. T-1 is the minimal assertion ("resize was sent"). T-5 is the rigorous assertion ("resize was sent after refresh, and it came from handleSubscribed not ResizeObserver"). If time is limited, implement T-1 and T-3 first.

### Risk 2: `bash` starts too fast -- content appears before the assertion checks for "blank"

If bash emits its prompt within milliseconds of refresh, the terminal may never appear blank. T-2 does not rely on observing a blank state; it waits for specific content ("REFRESH_TEST_OK") which requires both rendering and input to work correctly.

### Risk 3: T-3's WS interception (dropping resize messages) may break other test state

Monkey-patching `WebSocket.send` to drop `session:resize` messages could interfere with other WS traffic. Mitigation: the drop filter is narrowly scoped to messages where `type === 'session:resize'`, and it is re-enabled before the refresh click. The resize messages that were dropped are for a deliberate dimension mismatch; once re-enabled, subsequent resizes flow normally.

### Risk 4: Timing sensitivity in T-5

T-5 asserts that a resize message is sent "after" the refresh message. On a fast machine, the rAF callback may fire very quickly. The test uses a 1-second wait after content appears (step 13) to ensure the rAF has completed. If this is insufficient on slow CI, increase to 2 seconds. The assertion is on message ordering, not absolute timing.

### Risk 5: Test uses localhost with minimal latency

In production, WS messages may be delayed, causing `session:subscribed` and `session:output` to arrive in unexpected order. Tests on localhost don't reproduce this. Mitigation: the fix (re-fit in handleSubscribed) is triggered by the `session:subscribed` event itself, so ordering relative to `session:output` does not affect correctness.

### Risk 6: `fitAddon.fit()` throws in edge cases

If `fitAddon.fit()` throws (e.g., xterm disposed, container detached), the fix catches the error with `try/catch {}` and the `proposeDimensions()` call is skipped. This matches the pattern used everywhere else in TerminalPane (lines 157, 185). The test would still fail because no resize is sent, but the fix would not crash the app.

### Priority order for implementation

1. **T-3** (dimension mismatch -- the strongest bug-mode test, most likely to catch regressions)
2. **T-1** (resize sent after refresh -- direct test of Fix C behavior)
3. **T-5** (rigorous variant of T-1 with timing assertions)
4. **T-2** (smoke test for core user experience)
5. **T-4** (smoke test for card-based refresh flow)
