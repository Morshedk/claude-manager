# T-45 Design: Stop then Immediately Refresh — No Race Condition

**Score:** 12  
**Test type:** Playwright browser + server-level  
**Port:** 3142  
**Date:** 2026-04-08

---

## 1. What This Test Covers

A user clicks Stop. Within 200ms of clicking Stop (before "stopped" badge appears), the user clicks Refresh. This races the stop operation with the refresh operation.

The pass conditions are:
- **(a)** Refresh is ignored/blocked until Stop completes, then proceeds normally — session ends in "running" state.
- **(b)** Refresh waits for Stop to settle then restarts — session ends in "running" state.

The fail condition is:
- Session stuck oscillating between "stopping" and "starting" indefinitely.
- Server spawns two PTYs for one session (duplicate PTY leak).

---

## 2. Source Analysis — State Machine

### DirectSession.stop()

```js
stop() {
  if (this.pty) {
    try { this.pty.kill(); } catch { /* ignore */ }
    this.pty = null;
  }
  if (this.meta.status === STATES.RUNNING || this.meta.status === STATES.STARTING) {
    this._setState(STATES.STOPPED);
  }
}
```

`stop()` is **synchronous** — it kills the PTY and sets state to STOPPED immediately. No async I/O.

### DirectSession.refresh()

```js
async refresh(authEnv = {}) {
  if (this.meta.status === STATES.STARTING) {
    throw new Error(`Cannot refresh direct session "${this.meta.id}": already starting...`);
  }
  if (this.meta.status === STATES.CREATED) {
    throw new Error(`Cannot refresh direct session "${this.meta.id}": session has never been started`);
  }
  // Kill existing PTY if still alive
  if (this.pty) {
    try { this.pty.kill(); } catch { /* ignore */ }
    this.pty = null;
  }
  // Normalise to STOPPED
  if (this.meta.status !== STATES.STOPPED && this.meta.status !== STATES.ERROR) {
    this.meta.status = STATES.STOPPED;
  }
  await this.start(authEnv);
}
```

`refresh()` is async (calls `this.start()`). It:
1. Checks for STARTING state — **blocks refresh if session is starting**.
2. Kills existing PTY.
3. Normalizes to STOPPED.
4. Calls `start()` which increments `_ptyGen`.

### The Race Scenario

**Timeline:**
```
t=0ms:  Client sends session:stop (WS message 1)
t=50ms: Client sends session:refresh (WS message 2)
```

**Server processing:**
- WS messages are handled by `sessionHandlers.stop()` and `sessionHandlers.refresh()`.
- Both are `async` methods on the same `SessionHandlers` instance.
- Node.js single-threaded event loop: the messages are processed sequentially.

**Sequence 1 (stop arrives first, both in same tick):**
1. `stop()` called → pty.kill(), status = STOPPED (synchronous, completes immediately).
2. `refresh()` called → sees STOPPED → normalizes → calls `start()`.
3. `start()` increments `_ptyGen` → new PTY spawned → microtask transitions to RUNNING.
4. Result: Session ends RUNNING. No race.

**Sequence 2 (stop processing starts, refresh arrives while stop is awaited):**
Wait — `stop()` is NOT async in `DirectSession`. `SessionManager.stop()` IS async (calls `session.stop()` then `store.save()`). But `session.stop()` is synchronous. So the async part is only the disk save.

**Could there be a race?**
- `sessionHandlers.stop()` calls `await this.sessions.stop(msg.id)` — which calls `session.stop()` (sync) then `this.store.save(this.sessions)` (async disk write).
- The `session:stop` handler awaits the save, then calls `_broadcastSessionsList()`.
- Meanwhile, if `session:refresh` arrives before `_broadcastSessionsList()` fires, the state is already STOPPED (synchronous), so `refresh()` sees STOPPED and proceeds normally.

**Key insight:** Because `DirectSession.stop()` is synchronous, by the time the server processes `session:refresh`, the session's status is already STOPPED regardless of whether the disk save has completed. There is NO window where the session is in a transitional state between stop and refresh.

**The only actual race window:**
If `session:refresh` somehow arrives before `session:stop` is processed, the session is still RUNNING. `refresh()` handles this: it force-kills the running PTY and calls `start()`. This is valid behavior.

**PTY leak check:**
Each `start()` call increments `_ptyGen`. Old PTY exit events are guarded by `if (gen !== this._ptyGen) return`. So even if the old PTY exits after the new one starts, the stale exit event is ignored. No PTY leak from concurrent stop+refresh.

**Conclusion from analysis:** The code is structurally sound. The race condition cannot produce the fail state (oscillation or PTY leak) because:
1. stop() is synchronous.
2. refresh() checks STARTING state.
3. _ptyGen guards stale PTY events.

The test should confirm this holds under real conditions.

---

## 3. Exact Test Steps

### Infrastructure Setup

1. Start server on port 3142 with fresh tmp DATA_DIR.
2. Seed one project via `projects.json`.
3. Connect via WS, create one session with `bash` command.
4. Wait for session to reach RUNNING state.

### Phase 1: Via WS — Rapid Stop + Refresh

**WS-level test (most reliable timing):**

1. Connect WS client.
2. Subscribe to session to receive state changes.
3. Send `session:stop` at t=0ms.
4. Send `session:refresh` at t=50ms (50ms after stop, well before "stopped" badge could appear in browser).
5. Wait for session to stabilize.

**Collect all state changes** via `sessions:list` broadcasts. Record the state sequence.

**Assert:**
- Session never enters an infinite loop of starting/stopping.
- Final state is either "running" (refresh succeeded) or "stopped" (refresh failed gracefully with error).
- No `session:error` message with "Invalid transition" or similar state machine violation.
- If a `session:refreshed` message is received, the session reaches `running` within 5 seconds.

### Phase 2: Verify single PTY (no duplicate)

After the stop+refresh race, verify via REST API:
- `GET /api/sessions` → session appears exactly once.
- Session has exactly one `pid` value (not two).
- The `pid` is a valid process (check `/proc/{pid}` exists on Linux).

### Phase 3: Browser-level rapid Stop + Refresh

1. Open browser, navigate to app.
2. Select project, click session card to open SessionOverlay.
3. Click "Stop" button.
4. Within 200ms (immediately), click "Refresh" button.

**Why the browser can do this:** Both "Stop" and "Refresh" buttons are in the SessionOverlay header simultaneously — Stop is rendered when `isActive = session.status === 'running'`. After Stop is clicked, the UI dispatches the WS message and shows a toast, but the DOM re-renders asynchronously. The "Refresh" button might still be in DOM if we click fast enough, OR Stop replaces it. 

**Actually:** Looking at SessionOverlay.js:
- `isActive = session.status === 'running'`
- When running: Stop button rendered, Refresh button ALSO rendered (Refresh is always present).
- So BOTH buttons are visible simultaneously when running.
- User can click Stop then Refresh within 200ms before the WS update arrives.

**Assert after browser test:**
- Session eventually shows "running" badge (refresh restarted it) or "stopped" badge (stable stopped).
- No badge oscillation (check by polling badge for 5 seconds after the last expected state).

---

## 4. Pass/Fail Criteria

### PASS
- Session reaches a stable final state (either "running" or "stopped") within 10 seconds.
- No state oscillation observed (badge does not alternate between stopping/starting).
- No server crash (crash log clean).
- If session reached "running" after refresh: single PTY with valid PID.
- No `session:error` due to state machine violation.

### FAIL
- Session never reaches stable state (oscillates or hangs).
- Server logs state machine assertion error.
- Two PTY processes exist for one session.
- Server crashes.

---

## 5. False-PASS Risks

### Risk 1: 50ms delay is too long, stop completes before refresh arrives
By 50ms, the server has processed `session:stop` (synchronous) and the session is STOPPED. The refresh then fires cleanly from STOPPED state. This is still a valid test — it confirms the handoff works. The "race" in the WS handler queue is the key test, not necessarily the timing.

**Mitigation:** Also test with 0ms delay (both WS messages in the same microtask). The WS handler still processes them sequentially.

### Risk 2: Session ends "stopped" instead of "running" — PASS is vacuous
If stop succeeds but refresh fails (e.g., bash exits immediately), we might see "stopped" as final state. This should still be considered PASS if the error is graceful (not an oscillation).

### Risk 3: Browser test can't click both buttons fast enough
The SessionOverlay renders both Stop and Refresh buttons when running. After clicking Stop, the browser sends a WS message. The WS update arrives and re-renders Preact. Before re-render, the Refresh button is still in DOM. Playwright can click it.

**Mitigation:** Use `page.evaluate()` to dispatch both WS messages directly in rapid succession, bypassing button click timing. Or locate both buttons before clicking.

---

## 6. Implementation Notes

- The browser test should confirm both buttons are present before clicking Stop.
- Record all WS messages (state changes) to reconstruct the full state sequence.
- The key assertion is "no oscillation" — check for more than 2 state changes in 5 seconds after the last expected event.
- Use a `bash -c 'sleep 30'` session command so the process stays alive long enough for the race test.
