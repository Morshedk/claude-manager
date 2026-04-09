# T-49 Design: Auth Failure Mid-Session — Graceful Degradation

**Score:** 12  
**Test type:** Playwright browser + server-level (WS + REST)  
**Port:** 3146  
**Date:** 2026-04-08

---

## 1. What the Test Covers

A session starts with a command that simulates auth failure: it outputs an error message
and then exits with a non-zero exit code. The test verifies that the session lifecycle
state machine handles this gracefully — no unhandled exceptions, clean state transition
to "stopped" or "error", and the UI reflects the terminal condition.

The simulated command is:
```
bash -c "echo 'Error: Invalid API key'; sleep 1; exit 1"
```

This:
1. Outputs a visible error line
2. Waits 1 second (enough time to confirm the session was RUNNING)
3. Exits with code 1 (non-zero → should transition to ERROR state)

### Why this matters

The silent failure mode is that a process exits but the session card continues showing
"running" indefinitely — because an unhandled EventEmitter error on the dead PTY stream
crashed the server's error handler, or the PTY exit event was never wired, or the state
machine swallowed the transition. This leaves users believing Claude is still running when
it is not.

---

## 2. Source Analysis

### DirectSession._wirePty() — exit handling

```js
ptyProcess.onExit(({ exitCode }) => {
  if (gen !== this._ptyGen) return;  // stale guard

  this.pty = null;
  this.meta.exitCode = exitCode;
  this.meta.exitedAt = new Date().toISOString();

  if (
    this.meta.status === STATES.RUNNING ||
    this.meta.status === STATES.STARTING
  ) {
    const nextState = exitCode === 0 ? STATES.STOPPED : STATES.ERROR;
    this._setState(nextState);
  }

  this.emit('exit', { id: this.meta.id, exitCode });
});
```

**Key finding:** When `exitCode !== 0`, the state machine transitions to `STATES.ERROR`.
When `exitCode === 0`, it transitions to `STATES.STOPPED`.

For `bash -c "echo ...; sleep 1; exit 1"`, exitCode will be 1, so we expect ERROR state.

### SessionHandlers — stateChange broadcast

```js
sessionManager.on('sessionStateChange', ({ id, state, previousState }) => {
  registry.broadcast({ type: 'session:state', id, state, previousState });
});
```

Every state change is broadcast to all connected clients via WS. The UI receives
`session:state` → updates badge.

### SessionManager.subscribe() — auto-resume behavior

```js
if (
  session.meta.mode === 'direct' &&
  !session.pty &&
  (session.meta.status === STATES.STOPPED || session.meta.status === STATES.ERROR)
) {
  try {
    const authEnv = this._buildAuthEnv();
    await session.start(authEnv);
  } catch (err) {
    console.warn(`[SessionManager] auto-resume failed for ${sessionId}:`, err.message);
  }
}
```

**Critical finding:** When a client subscribes to a session that is in ERROR or STOPPED
state with no PTY, the server **auto-resumes** it by calling `session.start()`. This
means subscribing to a failed session will try to restart it.

**Impact on test design:**
- After the process exits with code 1, if we then send `session:subscribe`, the server
  will try to auto-restart the session. We must NOT send subscribe again after the exit.
- If the browser is already subscribed (via the initial auto-subscribe from `session:create`),
  it will continue watching the session WITHOUT triggering auto-resume (auto-resume only
  fires on NEW subscribe calls, not existing viewers).
- The WS that created the session is auto-subscribed. That WS stays connected and receives
  the `session:state` broadcast when the process exits.

### sessionStates.js — ERROR state

```js
export const TRANSITIONS = {
  [STATES.RUNNING]:  [STATES.STOPPING, STATES.ERROR, STATES.STOPPED],
  [STATES.ERROR]:    [STATES.STARTING],
};
```

ERROR is a valid terminal state from RUNNING. From ERROR, only STARTING is allowed
(for restart/auto-resume). The test must verify the session reaches ERROR, not STOPPED.

### Session card UI — isActive() and Delete button logic

From prior design work (T-04, T-16):
- `isActive(session)` returns true for `running` and `starting`
- When NOT active (stopped, error), session card shows: **Refresh** button and **Delete** button
- When active (running, starting), session card shows: **Stop** button (no Delete)

**Expected post-exit state:**
- Badge: shows "error" (or "stopped" if exitCode were 0)
- Buttons: Delete (allowed), Refresh (allowed), NO Stop button
- Terminal: should show the "Error: Invalid API key" output line

---

## 3. Test Flow

### Infrastructure

```
beforeAll:
  1. Kill anything on port 3146
  2. mktemp -d → tmpDir
  3. Create tmpDir/project directory
  4. Write projects.json: { "projects": [...], "scratchpad": [] }
  5. Start server: node server-with-crash-log.mjs with DATA_DIR=tmpDir PORT=3146
  6. Wait up to 25s for server ready (poll GET /)
```

### Test A: State transition via WS (no browser)

This is the core integrity test — browser-independent, tests the state machine directly.

```
1. wsConnect() → get ws1
2. Wait for server 'init' message
3. Send session:create with:
   - projectId: seeded project
   - name: 't49-auth-fail'
   - command: 'bash -c "echo Error: Invalid API key; sleep 1; exit 1"'
   - mode: 'direct'
4. Wait for session:created → capture sessionId
5. Wait for session:state message with id=sessionId and state='running' (confirm session started)
   OR poll REST /api/sessions until status=running (max 10s)
6. Wait for session:state message with id=sessionId and state='error' OR state='stopped'
   (max 15s — process exits after ~1s + PTY teardown latency)
7. ASSERT: state is 'error' (exitCode=1) — NOT 'running'
8. REST GET /api/sessions → find sessionId
9. ASSERT: session still exists (not deleted automatically)
10. ASSERT: session.status === 'error' (not 'running')
11. ASSERT: server process still alive (serverProc.pid → process.kill(pid, 0))
```

**Key assertions:**
- Session reaches 'error' (not stays 'running')
- Session is preserved (not auto-deleted on exit)
- Server survives (no unhandled EventEmitter crash)

### Test B: Browser UI validation

```
1. Open browser, navigate to BASE_URL (waitUntil: 'domcontentloaded')
2. Wait for project to appear in sidebar
3. Click project in sidebar
4. Wait for sessions area (list should show t49-auth-fail session from Test A)
5. ASSERT: Session card badge shows 'error' (NOT 'running')
6. ASSERT: Delete button IS present in card (allowed on non-active sessions)
7. ASSERT: Stop button is NOT present (only for active sessions)
8. Take screenshot
9. Click the session card to open overlay
10. Wait for terminal overlay to open
11. ASSERT: Terminal shows error text (not blank) — check for "Invalid API key" in DOM
    or check that the terminal buffer is non-empty
12. ASSERT: No JS errors in browser console (session:error in UI vs unhandled exception)
13. Take screenshot of overlay
```

**Key assertions:**
- UI correctly shows error state badge
- Delete available (not Stop)
- Terminal contains error output (not blank)
- No JS exception in console

### Test C: Crash log verification

```
1. Read crash.log from tmpDir
2. Parse for 'UnhandledRejection' or 'UncaughtException' lines
3. ASSERT: zero unhandled errors
```

---

## 4. False-PASS Risks

### Risk 1: Session auto-resumes before test can observe ERROR state

**Scenario:** The WS connection from `session:create` is auto-subscribed as a viewer.
When the process exits, `onExit` fires, sets state to ERROR, broadcasts `session:state`.
The browser receives `session:state` → ERROR. BUT: if the test then opens the browser and
navigates, the browser WS connects, subscribes, and triggers auto-resume (because session
is in ERROR with no PTY). The session restarts. By the time Test B reads the badge, it
shows "starting" or "running" again.

**Mitigation:**
- Test B should open the browser BEFORE creating the session (or immediately after),
  so the browser's WS auto-subscribe happens while the session is still running.
- Once subscribed, the browser becomes a viewer and won't re-trigger auto-resume on
  state change — only a NEW `session:subscribe` message would.
- Alternative: do NOT open the browser overlay (don't subscribe via browser WS).
  The REST API reflects the actual state. Use REST for state verification, screenshots
  for UI badge.
- SAFEST: In Test B, navigate to the project page but do NOT click the session card
  (which would trigger subscribe). Just check the badge in the card list. The card
  list reflects the broadcasted `session:state` without subscribing.

### Risk 2: PTY exit fires before 'running' state ever reached

**Scenario:** The bash command exits before the STARTING→RUNNING microtask fires.
The `_wirePty` microtask sets state to RUNNING, but `onExit` fires first and sets
state to ERROR. The session goes STARTING→ERROR, which is a valid transition.

**Impact:** Test step 5 (wait for 'running') would timeout if we require 'running'
as a prerequisite.

**Mitigation:** Don't require 'running' state before 'error'. Instead, wait for either
'running' OR 'error' as the first state message, then wait for 'error' as final state.
With `sleep 1` in the command, there's a 1-second window during which the session WILL
be running, so this risk is low but should be handled.

### Risk 3: Vacuous pass — session state is 'error' but test never confirmed it was 'running' first

**Scenario:** The bash command exits immediately, session goes STARTING→ERROR. The test
asserts state='error' — which is correct, but we haven't proven that auth failure was
simulated (the process ran and emitted output and then exited, not just failed to start).

**Mitigation:** Add an assertion that the terminal output contains "Invalid API key"
(the echo output). This confirms the process ran, produced error output, and then exited.
If the echo output is missing, the test should warn (not necessarily fail, since PTY
output transmission timing can vary).

### Risk 4: Session card shows 'stopped' not 'error' (wrong exit code detection)

**Scenario:** If `bash -c "..."` wraps the exit code and bash itself exits 0 for some
reason, the session would show 'stopped' not 'error'.

**Mitigation:** Test accepts BOTH 'stopped' and 'error' as valid non-running terminal
states. The key assertion is that session is NOT 'running'. The secondary assertion
checks for 'error' since exit code 1 should produce ERROR state per the code.

### Risk 5: Server crashes silently (EventEmitter maxListeners)

**Scenario:** The PTY emits 'exit' but there's no listener registered (somehow `_wirePty`
never ran). Node.js would log "Unhandled 'error' event" and crash. The crash log check
catches this.

**Mitigation:** crash.log assertion in Test C is the safeguard.

---

## 5. Pass / Fail Criteria

### PASS
1. Session reaches 'error' state (WS broadcast AND REST API confirm it)
2. Session is NOT stuck in 'running' after process exits
3. Browser badge shows 'error' or 'stopped' (not 'running')
4. Delete button is available in session card (not just Stop)
5. Terminal contains non-blank output (shows error text)
6. No JS console errors in browser
7. Server process still alive at end of test
8. Zero UnhandledRejection in crash.log

### FAIL
1. Session card stays "running" after process exits with code 1
2. Session badge is blank or shows unknown state
3. Server process died (crash detected)
4. Browser console shows unhandled JS exception
5. Terminal is completely blank (no error output visible)
6. Stop button still present after process exits

---

## 6. Selector Reference (from prior T-04/T-16 tests)

- Project sidebar: `.project-item` or text containing project name
- Sessions area: `#sessions-area`
- Session card: `.session-card`
- Session state badge: `.badge-activity` (text: "▶ running", "⏹ stopped", "✗ error")
- Stop button: `.session-card-actions` → button text "Stop" or `btn-danger`
- Delete button: `.session-card-actions` → button text "Delete"
- Refresh button: `.session-card-actions` → button text "Refresh"
- Session overlay: `#session-overlay`

---

## 7. Expected Result

**PASS** — The codebase correctly handles process exit with non-zero code:
- `_wirePty.onExit()` transitions RUNNING → ERROR when exitCode=1
- `sessionStateChange` is broadcast to all clients
- The UI updates badge to reflect error state
- Server does not crash or throw unhandled errors

The main risk is the auto-resume behavior: if the browser subscribes AFTER the process
exits, the server will try to restart it. Test B must be designed to avoid triggering
auto-resume — navigate to the project page to see the card badge without subscribing
to the session's output stream.

---

## 8. Infrastructure Notes

- Port: 3146
- ProjectStore seed format: `{ "projects": [...], "scratchpad": [] }` (NOT a plain array)
- Server: `node server-with-crash-log.mjs` with DATA_DIR, PORT, CRASH_LOG env vars
- WS endpoint: `ws://127.0.0.1:3146` (no /ws path — check server.js upgrade handler)
- REST: `http://127.0.0.1:3146/api/sessions`
- `waitUntil: 'domcontentloaded'` for all Playwright navigations
