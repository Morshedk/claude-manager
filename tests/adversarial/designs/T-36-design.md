# T-36 Design: Server Restart While Session Is In "Starting" State

**Score:** 12 | **Type:** Server-level | **Port:** 3133

---

## What This Test Must Prove

If the server is SIGKILL'd while a session is transitioning from `starting` to `running`, the session should NOT be stuck in `starting` after server restart. The server must either detect the inconsistency and fix it (mark as `stopped`), or simply not crash. The session state must be navigable — user can see it and optionally restart it.

---

## Source File Analysis

**Relevant code paths:**

**`lib/sessions/SessionStore.js`** (likely): Persists session metadata to disk. On server start, it loads persisted sessions. If a session was persisted with `status: 'starting'`, the recovery logic must handle it.

**`lib/sessions/SessionManager.js`** — startup/recovery:
- On startup, loads sessions from store.
- For `direct` sessions with `status: 'running'` or `status: 'starting'`, attempts auto-resume (spawning a new PTY).
- For a `starting` session that was killed mid-startup, there's no PTY to attach to — the auto-resume either succeeds (spawns fresh) or fails (transitions to ERROR/STOPPED).

**`lib/sessions/DirectSession.js`** — `_wirePty` transition:
- STARTING → RUNNING happens via `Promise.resolve().then()` microtask.
- This microtask fires ~0ms after `start()`. But if server is SIGKILL'd before this microtask runs, the persisted state will be `STARTING` (since `_setState(STARTING)` is synchronous and `store.save()` happens in `_setState`).

**The race window:**
1. `session:create` received → `session.start()` called → `_setState(STARTING)` → store saved (status=starting).
2. Within 500ms: SIGKILL → store NOT updated since STARTING→RUNNING hasn't fired yet.
3. Server restart: loads store, finds session with `status='starting'`.

**What happens on recovery?** Need to read `SessionManager.js` startup code to see if it handles `starting` status.

**SIGKILL timing:** `execSync('kill -9 <pid>')` kills immediately — the PTY spawned for the session also dies (PTY processes are children of the server, so SIGKILL propagates).

**After restart:** Load the session list. Check session status. If auto-resume fires on `starting` sessions, the session might:
a. Successfully restart and reach `running` (best case).
b. Fail to start and reach `error` or `stopped` (acceptable).
c. Remain stuck in `starting` (FAIL).
d. Cause a server startup crash (FAIL).

---

## Key Question: How Does SessionManager Handle "starting" on Load?

Check `SessionManager.js` startup. Common patterns:
- Treat `starting` as equivalent to `stopped` on load (conservative).
- Attempt auto-resume (optimistic).
- Leave as-is (bug — causes stuck state).

The test will discover which behavior is implemented.

---

## Infrastructure

- Port: 3133
- Server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT=3133`, `CRASH_LOG`
- Seed: one project with `path: '/tmp'`
- Command for session: `bash` (avoids Claude authentication delays)
- Crash log: essential for detecting server startup crash after restart

---

## Step-by-Step Execution Script

### Step 1: Start server (first instance)
Spawn server on port 3133. Poll until ready. Create project.

### Step 2: Trigger session start via WS
Open a WS connection. Send `session:create` with `command: 'bash'`, `mode: 'direct'`, `name: 'starting-test'`. Wait for `session:created` response — capture the session ID.

Wait for `session:state` message with `state: 'starting'` (this confirms the session was saved as `starting`).

**Critical timing:** We want to kill the server AFTER the session is saved as `starting` but BEFORE it transitions to `running`. The STARTING→RUNNING transition is a microtask (0ms). This means we need to kill within that ~0ms window, which is nearly impossible to hit reliably.

**Alternative approach:** Kill immediately after receiving `session:created` — the session may already be `running` by then. The test should handle both cases:
- If killed while `starting`: session will be persisted as `starting`.
- If killed while `running`: session will be persisted as `running`.

The interesting case is `starting`. To maximize the chance of hitting it:
- Use a command that takes time to start: something that delays before producing output.
- OR: intercept the server to pause at STARTING.

**Practical approach:** Use a session command that sleeps before producing output (e.g., `bash -c 'sleep 1 && echo ready'`). Kill the server within 500ms of `session:created`. The PTY spawns, but the microtask to STARTING→RUNNING may or may not have fired.

Actually the microtask fires asynchronously via `Promise.resolve().then()` — this is a Node.js microtask queue. The transition happens in the same event loop iteration. By the time `session:created` is sent back to the WS client and we receive it, the state is likely already RUNNING.

**Better approach:** Kill within 300ms of sending `session:create` (before even receiving `session:created`). The session is created and `start()` is called, but the STARTING→RUNNING microtask might not have fired if the Node.js event loop is busy. However, this is still a tight window.

**Most reliable approach:** Manually set the session status to `starting` in the persisted store file BEFORE restarting the server. This simulates the crash scenario without relying on timing.

**Decision:**
1. Start session, wait for it to be RUNNING.
2. Stop server (SIGKILL).
3. Directly edit the persisted session JSON to set `status: 'starting'`.
4. Restart server.
5. Verify server starts without crash.
6. Check session status via API.

This is deterministic and tests the real recovery behavior.

---

## Step-by-Step Execution Script (Revised)

### Step 1: Start server (first instance)
Spawn server. Poll until ready. Create project.

### Step 2: Create and start a session
WS `session:create` with `command: 'bash'`, `name: 'starting-test'`. Wait for `session:created`. Wait 2 seconds for RUNNING state.

### Step 3: Find and read the persisted store file
The store file should be at `<tmpDir>/sessions.json` or similar. Read it to find the session entry.

### Step 4: SIGKILL the server
`process.kill(serverProc.pid, 'SIGKILL')`. Wait 500ms for process to die.

### Step 5: Corrupt the persisted state
Edit `<tmpDir>/sessions.json` (or equivalent) to set the session's `status` to `'starting'`. Save the file.

### Step 6: Restart server with same DATA_DIR
Spawn a new server process on port 3133, same `DATA_DIR`, same `CRASH_LOG`. Poll until ready (timeout 25s). Check crash log — must be empty.

### Step 7: Fetch session list
`GET /api/sessions?projectId=<id>` (or appropriate endpoint). Find the session by ID. Check its status.

**Expected:**
- Status is NOT `'starting'` (must be `stopped`, `running`, `error`, or any non-`starting` state).
- Server responded 200 to the endpoint (not crashed).

### Step 8: Check crash log
Read the crash log file. Assert no new entries were written after server restart. If the server crashed on startup due to the `starting` state, the crash log will have content.

### Step 9: Verify server is responsive
`GET /api/projects` — must return 200 with the seeded project. Server should be fully functional after restart.

### Step 10: Cleanup
Kill server. Delete tmpDir.

---

## Pass / Fail Criteria

**Pass:**
- Server restarts without crash (crash log empty after restart).
- Session status is NOT `'starting'` (any other status is acceptable: `stopped`, `running`, `error`).
- Server is responsive to API requests after restart.

**Fail:**
- Server crashes on startup (crash log has content OR server never comes online).
- Session stuck in `'starting'` permanently after restart.
- `GET /api/sessions` throws 500 or server errors.

---

## Finding the Session Store File

Read `lib/sessions/SessionStore.js` to find where sessions are persisted. Common patterns:
- `path.join(dataDir, 'sessions.json')` — a single JSON file.
- `path.join(dataDir, 'sessions/', sessionId + '.json')` — per-session files.
- SQLite or similar (unlikely for a small project).

The store file path is essential for Step 5.

---

## False-PASS Risks

1. **Store file not found / wrong path.** If the corruption doesn't take effect, the test doesn't actually simulate the `starting` stuck case. Mitigation: read the file after editing to verify the status field was changed.

2. **Server auto-recovers `starting` to `running`** (i.e., attempts to auto-resume bash). This would result in `running` status after restart — this is a PASS (better than expected). Distinguish from "stuck in starting" which is a FAIL.

3. **The session ID changes after restart.** If the store isn't loaded, a new empty project is presented. Mitigation: verify the project and session ID are present after restart before checking status.

4. **Crash log path wrong.** If `CRASH_LOG` isn't where we think it is, we can't verify startup crash. Mitigation: use an absolute path in tmpDir.

5. **SIGKILL propagates to test process.** Mitigation: `serverProc.kill('SIGKILL')` kills only the server child process, not the test runner.

---

## Validator Checklist

- Was the session status actually set to `'starting'` in the store before restart (verify by reading file)?
- Was the crash log checked after restart (not just before)?
- Was the session status checked by fetching the actual session list (not just from WS messages)?
- Was the server functionality verified post-restart (not just "port is open")?
