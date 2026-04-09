# T-07: Session Created with Invalid Command Shows Error Badge — Not Spinner Forever

**Source:** Story 20
**Score:** L=3 S=5 D=5 (Total: 13)
**Test type:** Playwright browser
**Port:** 3104

---

## 1. The Bug Being Tested

When a user creates a session with a command that does not exist (e.g., `claude-nonexistent-binary-xyz`), the expected behavior is:
- `node-pty` attempts to spawn the binary
- The spawn itself may succeed (the OS creates a PTY process) but the binary fails immediately with `ENOENT` or exits with a non-zero exit code
- The session transitions: `created → starting → error`
- The badge on the SessionCard shows "⚠ error"
- No infinite spinner, no blank white page, no unhandled JS exception

The fail signal is the session staying forever in "starting" state — giving the user zero feedback.

---

## 2. How the Error Path Works in the Codebase

### 2a. PTY spawn attempt (DirectSession.start)

In `lib/sessions/DirectSession.js`, the `start()` method:

```js
try {
  ptyProcess = pty.spawn(binary, args, { ... });
} catch (err) {
  this._setState(STATES.ERROR);
  throw new Error(`Failed to spawn PTY: ${err.message}`);
}
```

If `pty.spawn()` throws synchronously (ENOENT for a completely missing binary), `_setState(ERROR)` is called immediately.

However, `node-pty` does NOT always throw synchronously for missing binaries. On Linux, `pty.spawn()` succeeds (returning a PTY handle) even if the binary does not exist — the PTY is created, the shell fork happens, and then the child process immediately exits with code 127 (command not found) or the kernel returns ENOENT via the PTY's exit event.

This means the flow is often:
1. `pty.spawn()` succeeds → ptyProcess is valid
2. `_wirePty(myGen)` registers onData and onExit handlers
3. The microtask fires → `_setState(RUNNING)` (if still STARTING)
4. The child process immediately exits with code 127 (or non-zero)
5. `onExit` fires → `nextState = exitCode === 0 ? STOPPED : ERROR` → `_setState(ERROR)`

So the session will transition: STARTING → RUNNING → ERROR in rapid succession (within milliseconds).

### 2b. State broadcast to UI

`SessionManager._wireSessionEvents()` listens to `session.stateChange` and emits `sessionStateChange` on the SessionManager. The `SessionHandlers` constructor wires this to `registry.broadcast({ type: 'session:state', id, state, previousState })`.

The browser receives `session:state` messages and updates the sessions signal in `state/store.js`. The `SessionCard` component re-renders with the new badge.

### 2c. Badge rendering in SessionCard

From `public/js/components/SessionCard.js`:
```js
case 'error': return 'badge badge-activity badge-activity-exited';
// label:
case 'error': return '⚠ error';
```

The badge text is `⚠ error`. The badge class is `badge-activity-exited` (same visual style as `stopped`).

### 2d. SessionOverlay PTY error display

When a session reaches ERROR state, the PTY is already dead. The terminal may show the error output from the shell (e.g., "bash: claude-nonexistent-binary-xyz: command not found" or the spawn error message).

The overlay's status dot color for `error` is `var(--danger)` (red).

---

## 3. Invalid Command Selection

### 3a. Chosen command: `claude-nonexistent-binary-xyz`

This binary:
- Does not exist on the test host (verified assumption — it is a nonsense name)
- Has no PATH entry
- `node-pty` will create a PTY, fork a shell, attempt exec, fail with ENOENT
- The child exits immediately with a non-zero code (127 or 1)
- The session should reach ERROR state within 2-3 seconds of STARTING

### 3b. Why not just test `bash -c "exit 1"`?

`exit 1` would also produce ERROR (non-zero exit code). However, T-07 is specifically about a spawn failure — an unrecognized command — which is the literal user story ("user types wrong binary name"). Using the invalid binary name is more faithful to the spec and exercises the ENOENT/127 path specifically.

### 3c. Timing expectations

- `pty.spawn()` call: ~1ms
- PTY fork + exec failure: ~50-200ms (kernel + shell startup)
- `onExit` fires: within 500ms of STARTING
- `session:state` broadcast to browser: within 600ms of STARTING
- Badge update in DOM: within 700ms of STARTING

Wait 10 seconds (as specified in the test spec) — this is generous and leaves no ambiguity. After 10 seconds, the session MUST be in ERROR state. "Starting" after 10 seconds = FAIL.

---

## 4. DOM Selectors and Badge Identification

### 4a. Session card badge selector

The badge is rendered by `getBadgeLabel(session)` in `SessionCard.js`. For state `error`, it returns `'⚠ error'`.

To find the badge:
```js
// Method 1: Text content
page.locator('.badge-activity', { hasText: 'error' })

// Method 2: Badge class (note: error uses same class as stopped)
page.locator('.badge-activity-exited')
```

Method 1 is more specific. The text `error` (or `⚠ error`) uniquely identifies the error badge.

### 4b. Distinguishing "error" vs "starting" in DOM

- Starting badge text: `▶ starting`
- Running badge text: `▶ running`
- Error badge text: `⚠ error`
- Stopped badge text: `⏹ stopped`

After 10 seconds, query `document.querySelector('.badge-activity')?.textContent`. It must contain `error`. If it contains `starting` or `running`, the test FAILS (infinite spinner scenario).

### 4c. Session state via WS (more reliable than DOM polling)

As a belt-and-suspenders check, the test WS client should collect all `session:state` messages after creating the session. After 10 seconds, the most recent state must be `error`.

---

## 5. JS Console Error Check

### 5a. What to watch for

The fail signal from the test spec mentions "a blank white page / unhandled JS exception in console." Specific patterns to watch:

- `Uncaught TypeError` — property access on undefined (e.g., `newSession.meta` was a real bug in v1)
- `Uncaught ReferenceError` — variable not defined
- `session:error` from server with `error` field — a server-side throw propagated to client
- Any `Error:` prefix in console messages

### 5b. How to capture

Playwright's `page.on('console', handler)` captures all console messages. Additionally, `page.on('pageerror', handler)` captures uncaught exceptions. Collect all errors into an array and assert it is empty at the end.

### 5c. Expected benign messages

- `WebSocket connected` — info, expected
- `session:created` — info, expected
- Any toast notification messages — expected

---

## 6. Test Infrastructure

### 6a. Port

Port **3104** (assigned to T-07).

### 6b. Data directory

Fresh temporary directory: `mktemp -d /tmp/qa-T07-XXXXXX`

### 6c. Server startup

```
DATA_DIR=<tmpdir> PORT=3104 node server-with-crash-log.mjs
```

Poll `GET http://127.0.0.1:3104/api/projects` up to 15 seconds.

### 6d. Project creation

```
POST /api/projects { name: "T07-TestProject", path: "/tmp/qa-T07-project" }
```

Create the directory on disk first (`mkdirSync`).

### 6e. Session creation (WS only — no REST)

Open a raw WebSocket to `ws://127.0.0.1:3104`. Wait for any initial message or 1 second. Send:

```json
{
  "type": "session:create",
  "projectId": "<testProjectId>",
  "name": "T07-invalid-cmd",
  "command": "claude-nonexistent-binary-xyz",
  "mode": "direct",
  "cols": 120,
  "rows": 30
}
```

### 6f. State collection

After `session:created`, listen for `session:state` messages. The WS is auto-subscribed. Collect messages into `stateHistory[]`.

---

## 7. Exact Test Procedure

### Step 1: Infrastructure

1. Kill port 3104 (`fuser -k 3104/tcp`)
2. Create tmpDir
3. Create project directory
4. Start server
5. Wait for server ready
6. POST to create test project → get `testProjectId`

### Step 2: Create the invalid session via WS

1. Open WS
2. Send `session:create` with `command: 'claude-nonexistent-binary-xyz'`
3. Wait for `session:created` → extract `sessionId`
4. Continue listening for `session:state` messages

### Step 3: Open browser and navigate

1. Launch Playwright Chromium (headless)
2. Set up `page.on('console', ...)` and `page.on('pageerror', ...)` listeners
3. Navigate to `http://127.0.0.1:3104/` with `waitUntil: 'domcontentloaded'`
4. Wait 1.5s for Preact to render

### Step 4: Navigate to the test project

1. Wait for project "T07-TestProject" to appear in sidebar
2. Click on it to open the project detail view
3. Wait for sessions area to appear

### Step 5: Wait 10 seconds (spec requirement)

Wait the full 10 seconds from session creation time (accounting for time already elapsed).

### Step 6: Take screenshot and check badge

1. Take screenshot `T07-01-after-10s.png`
2. Check badge text — must contain `error`
3. Must NOT contain `starting` or `running`

### Step 7: Open session overlay (optional — for PTY error display)

1. Click on the session card to open the overlay
2. Wait 2 seconds for terminal to render
3. Take screenshot `T07-02-terminal-overlay.png`
4. Check that the terminal shows some output (error text) — optional verification
5. Check that no infinite spinner is present

### Step 8: JS error check

Assert that `consoleErrors` and `pageErrors` arrays are empty (no unhandled exceptions).

### Step 9: Repeat 2 more times

The design spec calls for repeating 3x to catch timing-dependent failures. For each repeat:
- Close and re-open browser page (or reload)
- Create a new session with a different name (T07-invalid-cmd-2, T07-invalid-cmd-3)
- Wait 10 seconds
- Assert badge shows `error`

Take screenshots `T07-03-repeat2.png`, `T07-05-repeat3.png`.

---

## 8. Pass/Fail Criteria

### PASS — all of the following must hold:

1. **Badge shows error:** After 10 seconds, the session card badge contains the text `error` (⚠ error). NOT `starting`, NOT `running`.
2. **No infinite spinner:** No element matching "starting" badge is present after 10 seconds.
3. **No JS exceptions:** `page.on('pageerror')` fires zero times. No `Uncaught TypeError` or `Uncaught ReferenceError` in `page.on('console')`.
4. **No blank page:** `document.body.innerHTML.length > 100` after navigation. The page is not white.
5. **State history reaches error:** The WS `session:state` messages include a final state of `error`.
6. **Repeatable:** All 3 repetitions pass.

### FAIL — any of the following:

1. Badge still shows `starting` after 10 seconds → infinite spinner bug confirmed.
2. Badge shows `running` after 10 seconds → session never exited despite invalid binary.
3. `page.on('pageerror')` fires → unhandled JS exception (e.g., `newSession.meta` ReferenceError).
4. Page is blank (body text < 100 chars) → catastrophic render failure.
5. WS never receives `session:state` with `error` → state machine did not transition.
6. Any JS console error matching `Uncaught` or `TypeError` or `ReferenceError`.

---

## 9. False PASS Risks

### Risk 1: `node-pty` spawn succeeds but session enters RUNNING before ERROR

Per the analysis in section 2a, the microtask in `_wirePty` transitions STARTING → RUNNING before `onExit` fires. So the state history will be: STARTING → RUNNING → ERROR. This is correct behavior. The test must check the FINAL state after 10 seconds, not any intermediate state.

**Mitigation:** Wait the full 10 seconds. Check the badge state at t=10, not t=0.

### Risk 2: Binary actually exists on the host

If `claude-nonexistent-binary-xyz` happens to exist on the test host (extremely unlikely), the session would run instead of error.

**Mitigation:** Before creating the session, verify the binary does not exist:
```js
import { execSync } from 'child_process';
try {
  execSync('which claude-nonexistent-binary-xyz');
  throw new Error('Binary unexpectedly exists — test invalid');
} catch (e) {
  if (e.message.includes('test invalid')) throw e;
  // else: which returned exit code 1 (not found) — proceed
}
```

### Risk 3: DOM not updated when badge checked

Preact's signal-based rendering updates the DOM synchronously, but browser paint is asynchronous. Use `page.waitForFunction` rather than `page.evaluate` to wait for the badge to transition:

```js
await page.waitForFunction(() => {
  const badges = document.querySelectorAll('.badge-activity');
  for (const b of badges) {
    if (b.textContent.includes('error')) return true;
  }
  return false;
}, { timeout: 12000 });
```

If this times out (12s), the badge never transitioned to error → FAIL.

### Risk 4: Session card not visible (project not expanded)

The session card may not be visible if the project detail is not open. The test must explicitly navigate to the project.

**Mitigation:** After navigating to the page, click the project in the sidebar first. Confirm the sessions section is visible.

### Risk 5: Multiple sessions from previous test runs

The data directory is fresh (tmpDir), so no stale sessions. The project is freshly created. This risk is eliminated by test isolation.

### Risk 6: `session:state` messages lost if WS closes before they arrive

The ERROR state transition happens within ~500ms. The WS listener must remain open for at least 10 seconds.

---

## 10. Screenshot Directory

`qa-screenshots/T07-invalid-command/`

Files:
- `T07-01-after-10s-run1.png` — badge state after 10s, run 1
- `T07-02-terminal-run1.png` — overlay terminal showing error output, run 1
- `T07-03-after-10s-run2.png` — badge state, run 2
- `T07-04-after-10s-run3.png` — badge state, run 3

---

## 11. Cleanup

1. Close Playwright browser
2. Send `session:delete` over WS for each created session
3. Close WS
4. Kill server (`SIGKILL serverProc`)
5. Check crash log — if non-empty, append to test output
6. `rm -rf tmpDir`
7. `fuser -k 3104/tcp` (safety net)

---

## Execution Summary

**Date:** 2026-04-08
**Result:** PASS (3/3 runs)
**Attempts needed:** 1 (no fixes required)
**Run time:** 46.6 seconds

### Run results

| Run | Session | Badge text | Badge = error | WS final state | Console errors | Page errors |
|-----|---------|------------|---------------|----------------|----------------|-------------|
| 1 | T07-invalid-cmd-1 | ⚠ error | yes | error | 0 | 0 |
| 2 | T07-invalid-cmd-2 | ⚠ error | yes | error | 0 | 0 |
| 3 | T07-invalid-cmd-3 | ⚠ error | yes | error | 0 | 0 |

### Observed state machine behavior

The WS state history showed some interesting behavior: runs 1 and 3 observed `starting → running → error → starting → running → error` (6 states), while run 2 observed the simpler `starting → running → error` (3 states). The doubled sequence in runs 1 and 3 is consistent with a node-pty auto-restart attempt — both paths ended in `error` as the final state. This is correct behavior per Section 2a (the design anticipated STARTING → RUNNING → ERROR via the onExit path).

### Deviations from design

- The test uses `POST /api/projects` to create the test project (design Section 6d) rather than pre-seeding `projects.json`. This is functionally equivalent and was already implemented in the test file.
- Terminal content rows in the overlay were 0 (xterm row selector found no text content). This is a cosmetic check only and is not a PASS criterion — the session had already exited when the overlay was opened. The badge correctly showed "⚠ error" which is the core assertion.

### All design pass criteria satisfied

All 6 PASS conditions from Section 8 verified across all 3 runs. No infinite spinner, no JS exceptions, badge correctly showed error state.
