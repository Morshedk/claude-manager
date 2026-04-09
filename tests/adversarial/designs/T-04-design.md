# T-04: Stop Button Actually Kills the Process

**Source:** Story 7 (Stop a Running Session)
**Score:** L=5 S=5 D=3 (Total: 13)
**Test type:** WS protocol + server-level (REST verification)

---

## 1. Infrastructure Setup

### 1a. Isolated server

Every run starts a fresh, disposable server instance. No state must leak from prior tests.

1. Kill any existing process on port 3101: `fuser -k 3101/tcp 2>/dev/null; sleep 1`.
2. Create a temporary data directory: `DATA_DIR=$(mktemp -d /tmp/qa-T04-XXXXXX)`.
3. Create a project subdirectory inside it: `mkdir -p $DATA_DIR/project`.
4. Seed `$DATA_DIR/projects.json` with:
   ```json
   { "projects": [{ "id": "proj-t04", "name": "T04-Project", "path": "<DATA_DIR>/project", "createdAt": "2026-01-01T00:00:00Z" }], "scratchpad": [] }
   ```
   **Critical lesson (T-02):** `ProjectStore` requires the `{ "projects": [...], "scratchpad": [] }` wrapper, NOT a plain array. A plain array silently yields an empty project list.
5. Start the server:
   ```
   DATA_DIR=$DATA_DIR PORT=3101 CRASH_LOG=$DATA_DIR/crash.log node server-with-crash-log.mjs
   ```
   Spawn via `child_process.spawn` with `{ stdio: 'pipe', detached: false }`. Pipe stdout/stderr to console for debugging.
6. Poll `http://127.0.0.1:3101/` every 400ms up to 25 seconds. The server is ready when a GET returns HTTP 200. If not ready within 25s, fail immediately.

### 1b. Screenshot directory

Create `qa-screenshots/T04-stop-kills/` under the app root. All screenshots go here.

---

## 2. Session Creation Strategy

### Why bash, not claude

Claude's TUI takes 8–10 seconds to start. For this test we only need a long-lived process whose OS-level existence we can verify. `bash` starts instantly, stays alive indefinitely, and produces a process we can probe with `kill -0 <pid>` from Node.js. It is a faithful substitute for Claude for the purposes of "does killing work."

### 2a. Create session via WebSocket

Open a raw WebSocket to `ws://127.0.0.1:3101`. Wait for the `init` message (timeout 8s). Then send:

```json
{
  "type": "session:create",
  "projectId": "proj-t04",
  "name": "t04-bash-stop",
  "command": "bash",
  "mode": "direct",
  "cols": 120,
  "rows": 30
}
```

Wait for `session:created` response (timeout 15s). Capture `session.id` as `testSessionId`.

**Note (JOURNAL):** `session:create` auto-subscribes the creating WS client — do NOT send a separate `session:subscribe`.

### 2b. Confirm session is RUNNING via REST API

Call `GET http://127.0.0.1:3101/api/sessions`. Find the session by `id === testSessionId`. Assert:
- `status === "running"` (or `state === "running"`)
- `pid` is a positive integer > 0

Capture `pid` as `ptyPid`. This is the OS-level process ID we will verify is dead after stop.

### 2c. Confirm PTY process is alive (pre-stop baseline)

From Node.js test runner:
```js
try {
  process.kill(ptyPid, 0); // signal 0: existence check only
  // OK — process alive, as expected
} catch (err) {
  throw new Error(`Baseline FAIL: PTY process ${ptyPid} is already dead before stop was called`);
}
```

If this throws, the session is already dead and the test cannot proceed meaningfully.

---

## 3. Stop Trigger Methods

The T-04 spec says "Click Stop." The test covers TWO stop paths for thoroughness:

### Path A: UI-level stop (Playwright browser)

Open Chromium, navigate to `http://127.0.0.1:3101`. Wait for `.status-dot.connected` or equivalent "Connected" indicator. Navigate to the project → click session card → open session overlay → click the "Stop" button (selector: `#btn-session-stop`).

This is the user-facing path described in Story 7.

### Path B: WS-level stop (direct WebSocket)

Send `{ "type": "session:stop", "id": "<testSessionId>" }` via raw WebSocket. This verifies the server-side kill path independently of the UI.

**For the repeat protocol (Section 7), alternate between Path A and Path B across iterations** to ensure both paths work.

---

## 4. Exact Action Sequence (per iteration)

### 4a. Send stop

**Path A (browser):**
1. Navigate to `http://127.0.0.1:3101`, wait for connected indicator.
2. Select project "T04-Project" in sidebar: `page.locator('.project-item').filter({ hasText: 'T04-Project' }).first().click()`.
3. Wait for session card: `page.waitForSelector('.session-card', { timeout: 8000 })`.
4. Click the session card to open overlay.
5. Wait for `#session-overlay` to be visible (timeout 8s).
6. Wait for `#btn-session-stop` to be present (timeout 5s). If not visible, the session may already be stopped — log and fail.
7. Click `#btn-session-stop`.
8. Record `stopTimestamp = Date.now()`.

**Path B (WS):**
1. `ws.send(JSON.stringify({ type: "session:stop", id: testSessionId }))`.
2. Record `stopTimestamp = Date.now()`.

### 4b. Wait 5 seconds

Per the spec: "Wait 5 seconds." This gives time for:
- `SessionManager.stop()` to call `session.stop()`
- `DirectSession.stop()` to call `this.pty.kill()` and transition to STOPPED
- `sessions:list` broadcast to reach all clients
- UI to re-render the badge

```js
await sleep(5000);
```

### 4c. REST API verification

```
GET http://127.0.0.1:3101/api/sessions
```

Find the session by `id === testSessionId`. Assert:
1. Session still exists in the list (not deleted — stop ≠ delete).
2. `status === "stopped"` (or `state === "stopped"`). NOT "running", "starting", "error", or missing.
3. `pid` field is still present (it should be the last known PID — `DirectSession.stop()` nulls `this.pty` but does not clear `this.meta.pid`).

### 4d. OS-level process liveness check (the critical kill-0 check)

```js
try {
  process.kill(ptyPid, 0);
  // If we reach here: the process is STILL ALIVE — this is the silent failure bug
  throw new Error(`SILENT FAILURE: Process ${ptyPid} still alive after stop. API may say "stopped" but PTY lives.`);
} catch (err) {
  if (err.code === 'ESRCH') {
    // PASS: process does not exist — kill succeeded at OS level
    console.log(`PASS: process.kill(${ptyPid}, 0) → ESRCH (process is dead)`);
  } else if (err.message.includes('SILENT FAILURE')) {
    throw err; // Re-throw our own error
  } else {
    throw new Error(`Unexpected error from process.kill: ${err.message}`);
  }
}
```

**This is the crux of the false-PASS risk.** The API could say "stopped" while the PTY is still alive. The `kill -0` check is the only way to verify OS-level process death.

### 4e. UI badge verification (Path A only)

For browser-based stops, verify the session card badge:

```js
await page.waitForFunction(
  () => {
    const cards = document.querySelectorAll('.session-card');
    return [...cards].some(c =>
      c.textContent.includes('t04-bash-stop') &&
      (c.textContent.includes('stopped') || c.textContent.includes('⏹'))
    );
  },
  { timeout: 8000 }
);
```

Also check inside overlay if still open:
- The `#btn-session-stop` button should have disappeared (it only renders when `isActive === true`).
- The Refresh button should now be visible instead of Stop.

### 4f. Screenshot

Take screenshot after stop: `qa-screenshots/T04-stop-kills/iter-N-post-stop.png`.

---

## 5. False-PASS Risks and Mitigations

### Risk 1 (PRIMARY): UI says "stopped" but PTY still alive

**Scenario:** `session.stop()` is called but `this.pty.kill()` throws silently or the PTY ignores SIGTERM. The state machine transitions to STOPPED (because `_setState(STOPPED)` runs regardless of whether `pty.kill()` succeeds — see `DirectSession.stop()` lines 78–90), but the OS process keeps running. The REST API will faithfully report "stopped" because it reads from `this.meta.status`. This is the "credits are still burning" failure mode from the test spec.

**Mitigation:** `process.kill(ptyPid, 0)` from Node.js test runner (step 4d). This CANNOT be fooled by in-memory state — it asks the OS kernel directly.

**Reading the code:** `DirectSession.stop()` calls `this.pty.kill()` then `this.pty = null` then `_setState(STOPPED)`. The `node-pty` `kill()` method sends SIGKILL (or uses the process group). However, there is a subtle risk: if `this.pty` is null at stop time (e.g., PTY died before stop was called), the code skips the kill but still transitions to STOPPED. This is correct behavior. Our baseline check (step 2c) guards against this scenario.

### Risk 2: State machine says "stopped" but it is a natural exit, not a kill

**Scenario:** `bash` happens to exit on its own (receiving a signal, running a `exit` command) between session creation and the stop command. Our stop "works" vacuously because the process was already dead.

**Mitigation:** The baseline check (step 2c) uses `process.kill(ptyPid, 0)` to confirm the process is alive before we issue the stop. If the process is already dead at baseline, we abort the iteration.

### Risk 3: `ptyPid` recorded before PTY is fully spawned, capturing wrong PID

**Scenario:** We read `pid` from the API immediately after `session:created`, but the PID in the session record has not been updated yet (race between our HTTP fetch and the async PTY spawn completing).

**Mitigation:** Wait for `status === "running"` in the REST API before capturing `pid`. The status transitions STARTING → RUNNING only after the PTY has been spawned and `meta.pid` has been set (see `DirectSession.start()` lines 66–67: `this.meta.pid = ptyProcess.pid` happens before the microtask that transitions to RUNNING). If needed, poll for a non-null PID with a short delay.

### Risk 4: `process.kill(pid, 0)` returns ESRCH because the PID was recycled

**Scenario:** The PTY process dies (from stop), but another process is quickly spawned with the same PID (PID recycling). Our `kill -0` check would incorrectly think the original PTY is still alive.

**In practice:** PID recycling on Linux requires the PID space to wrap around (default max is 32768). Within 5 seconds this is practically impossible. This risk can be ignored for this test.

### Risk 5: WS `session:stop` message is lost before delivery

**Scenario (Path B):** The WebSocket send succeeds client-side but the message is dropped (e.g., server is processing another message and the queue is disrupted). The test would wait 5 seconds and check — finding the session still running. But this would be a FAIL, not a false PASS.

**Mitigation:** Not needed — a dropped stop message causes a genuine FAIL. The test correctly catches this.

### Risk 6: Auto-resume on `subscribe` restarts a stopped session before we check

**Scenario:** When the browser opens the overlay (Path A), `TerminalPane` sends `session:subscribe`. `SessionManager.subscribe()` has auto-resume logic (lines 253–267 of `SessionManager.js`): if a direct session is stopped and its PTY is null, it auto-starts the session. If we check the status AFTER the browser subscribes (e.g., we click Stop and then check via the already-open overlay), the auto-resume might have re-started the session.

**Mitigation:** For the REST check (step 4c), close the session overlay before checking (or check via raw REST without a subscribed browser). Better: check BEFORE re-subscribing. Also: the auto-resume only fires on `session:subscribe`, not passively. If the overlay is still open from before the stop, the already-registered viewer does NOT trigger re-subscribe. New subscribes only happen when TerminalPane mounts. So: do NOT close and re-open the overlay between stop and the REST check.

### Risk 7: Process.kill(pid, 0) throws EPERM, not ESRCH

**Scenario:** The test process doesn't have permission to signal the PTY process. EPERM means "process exists but you can't signal it." This would look like the process is alive when it's actually dead (or vice versa).

**Mitigation:** Both the test process and the server run as the same user (`claude-runner`). The test process spawns the server which spawns the PTY. All three are in the same user context. EPERM should not occur. If it does, the test correctly treats it as an unexpected error and fails explicitly.

---

## 6. Server-Side Verification

Beyond the REST API and `kill -0` check, verify server state through two additional lenses:

### 6a. Session still in list (not deleted)

After stop, `GET /api/sessions` must still include the session. Stop does not delete — it only changes status. Verify count of sessions with `id === testSessionId` is exactly 1.

### 6b. Server process still alive

```js
process.kill(serverProc.pid, 0);
// Must not throw — server must be alive after processing the stop
```

### 6c. Crash log check

After the test, read `$DATA_DIR/crash.log`. Any `UnhandledRejection` or `UncaughtException` entries timestamped during the test window are a FAIL, even if all other checks passed.

---

## 7. Repeat Protocol

### Why repeat 3 times

The stop operation is deterministic (it kills the PTY), but the timing of the state transition broadcast and the auto-resume risk (Section 5, Risk 6) introduce potential flakiness. Three iterations with a fresh session each time eliminates luck as an explanation.

### Iteration setup

For each iteration N (1, 2, 3):
1. Create a new bash session with name `t04-bash-stop-N`.
2. Confirm it is running (baseline kill-0 check).
3. Record `ptyPid`.
4. Trigger stop (alternating: iteration 1 = Path A browser, iteration 2 = Path B WS, iteration 3 = Path A browser).
5. Wait 5 seconds.
6. REST check: status must be "stopped".
7. Kill-0 check: process must be dead (ESRCH).
8. UI check (Path A iterations): badge shows "stopped" / Stop button gone.
9. Delete the session via WS (`session:delete`) before the next iteration.
10. Wait 2s for cleanup.

### Pass threshold

All 3 iterations must pass ALL checks. No "2/3 tolerance" — any single failure reveals the bug.

### Iteration log format

```
Iteration 1 (Path A - UI stop):
  ptyPid=<N>, baseline kill-0: ALIVE
  Stop triggered at <timestamp>
  REST check: status=stopped ✓
  kill-0 check: ESRCH (dead) ✓
  UI badge: "stopped" ✓
  → PASS

Iteration 2 (Path B - WS stop):
  ptyPid=<N>, baseline kill-0: ALIVE
  ...
```

---

## 8. Pass/Fail Criteria

### PASS — all must be true for every iteration:

1. `GET /api/sessions` returns the session with `status === "stopped"` within 5 seconds of stop.
2. `process.kill(ptyPid, 0)` throws with `err.code === 'ESRCH'` after stop (OS-level death confirmed).
3. Session record is still present in the API response (stop ≠ delete).
4. UI badge shows "stopped" (Path A iterations only).
5. `#btn-session-stop` button is no longer visible in overlay after stop (Path A iterations only).
6. Baseline kill-0 confirmed the process was alive before stop (precondition satisfied — not vacuous).
7. Server process still alive throughout all iterations.

### FAIL — any one is sufficient:

1. `GET /api/sessions` shows `status !== "stopped"` after 5 second wait.
2. `process.kill(ptyPid, 0)` does NOT throw (process still alive after stop).
3. Session record is missing from API response (stop triggered accidental deletion).
4. UI badge still shows "running" after 5 seconds (Path A iterations).
5. Server crashes during the test.
6. Crash log contains unhandled errors during test window.
7. Baseline kill-0 check fails (process already dead before stop — test is vacuous, mark INCONCLUSIVE).

---

## 9. Screenshots

Saved to `qa-screenshots/T04-stop-kills/`:

| Filename | When | Purpose |
|----------|------|---------|
| `iter-N-00-session-running.png` | After session created, overlay open | Show running state baseline |
| `iter-N-01-stop-button.png` | Just before clicking Stop | Confirm Stop button visible |
| `iter-N-02-post-stop.png` | After 5-second wait | Show stopped badge |
| `iter-N-03-FAIL.png` | On failure only | Evidence of incorrect state |

---

## 10. Cleanup

In `afterAll` (runs even on failure):

1. Kill all created sessions via WS `session:delete` (for any sessions not already deleted in iteration cleanup).
2. Kill the server process: `serverProc.kill('SIGKILL')`. Wait up to 3s. If alive: `SIGKILL`.
3. Kill PTY processes if still alive (belt-and-suspenders): `process.kill(ptyPid, 'SIGKILL')`, wrapped in try/catch.
4. Close Playwright browser (if opened).
5. Remove temp data directory: `fs.promises.rm(dataDir, { recursive: true, force: true })`.
6. Kill port 3101 as final safety: `fuser -k 3101/tcp 2>/dev/null`.

---

## 11. Key Architectural Observations

Reading `DirectSession.stop()` (lines 78–90):

```js
stop() {
  if (this.pty) {
    try { this.pty.kill(); } catch { /* ignore */ }
    this.pty = null;
  }
  if (
    this.meta.status === STATES.RUNNING ||
    this.meta.status === STATES.STARTING
  ) {
    this._setState(STATES.STOPPED);
  }
}
```

Key observations:
1. `pty.kill()` errors are silently swallowed. If the kill fails, the state still transitions to STOPPED. This is the exact mechanism that could cause the "UI says stopped but process lives" silent failure.
2. `this.pty = null` after kill means there is no way to re-check the PTY after stop. The kill-0 check must use the PID captured before stop, not from the session object.
3. The state transition to STOPPED is conditional on being RUNNING or STARTING. A session in CREATED state cannot be stopped — this is expected and not tested here.

Reading `SessionManager.stop()` (lines 316–321):

```js
async stop(sessionId) {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  await session.stop();
  await this.store.save(this.sessions);
}
```

`session.stop()` in `DirectSession` is synchronous (no async/await), so `await session.stop()` resolves immediately after the kill attempt. The persistence happens synchronously after. This means the REST API will report "stopped" as soon as the HTTP handler returns, which should be within milliseconds.

Reading `SessionHandlers.stop()` (lines 162–170):

```js
async stop(clientId, msg) {
  try {
    await this.sessions.stop(msg.id);
  } catch (err) {
    this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
    return;
  }
  this._broadcastSessionsList();
}
```

After stop, `_broadcastSessionsList()` broadcasts `sessions:list` to all connected clients. The UI should update within the next message delivery cycle. No specific `session:stopped` message is sent — the UI must pick up the state from the next `sessions:list` broadcast.

**Implication for test:** Don't wait for a `session:stopped` WS message. Wait for `sessions:list` with the updated status, OR wait for the REST API to reflect the change (both happen as part of the same synchronous stop flow).

---

## Execution Summary

**Date:** 2026-04-08
**Result:** PASS
**Attempts needed:** 1 (no fixes required)
**Run time:** 59.0 seconds

### Iteration results

| Iteration | Path | PTY PID | Baseline alive | API status | OS kill-0 | UI badge | Stop btn gone |
|-----------|------|---------|----------------|------------|-----------|----------|---------------|
| 1 | Path A (UI) | 2938095 | ALIVE | stopped | ESRCH (dead) | stopped | gone |
| 2 | Path B (WS) | 2940221 | ALIVE | stopped | ESRCH (dead) | n/a | n/a |
| 3 | Path A (UI) | 2942755 | ALIVE | stopped | ESRCH (dead) | stopped | gone |

### Deviations from design

- No `init` message was received in `waitForMsg` on WS connect (design expects an `init` message, test gracefully handles absence with a `.catch(() => {})` — logged as "No init message received (may be OK)"). This did not cause test failure because `session:create` proceeded without it.
- Crash log was absent (no crash.log file created), interpreted as clean server run. The `afterAll` handler checks for ENOENT and treats it as clean — this matched the design's intent.

### All design pass criteria satisfied

All 7 PASS conditions from Section 8 verified across all 3 iterations.
