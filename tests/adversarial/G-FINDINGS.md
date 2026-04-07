# Category G: Adversarial Edge Cases — Findings

**Date:** 2026-04-07  
**File:** `tests/adversarial/G-edge-cases.test.js`  
**Results:** Varies 9–12 PASS / 13–16 FAIL per run due to cascading server overload (see BUG-G-002)

---

## BUGS FOUND

### BUG-G-001 (P1 — Incorrect State): exit-0 session auto-resumed by subscribe

**Test:** G.07  
**Severity:** P1 — incorrect session lifecycle, session that should be STOPPED gets restarted invisibly  

**Symptom:** A session with command `bash -c "exit 0"` (immediate exit, code 0) is expected to
transition to `stopped`. Instead, the session ends up `running` because the auto-subscribe
logic in `SessionManager.subscribe()` detects the STOPPED state and auto-resumes the session.

**Root cause in `lib/sessions/SessionManager.js` lines 254–267:**
```js
// Direct session auto-resume: if PTY is gone and session is stopped/error, restart it.
if (
  session.meta.mode === 'direct' &&
  !session.pty &&
  (session.meta.status === STATES.STOPPED || session.meta.status === STATES.ERROR)
) {
  try {
    const authEnv = this._buildAuthEnv();
    await session.start(authEnv);  // ← restarts the session that just exited!
  } catch (err) { ... }
}
```

**Trigger sequence:**
1. `sessions.create()` calls `session.start()` → `bash -c "exit 0"` spawns
2. PTY exits immediately with code 0 → `onExit` fires → status = STOPPED
3. `sessionHandlers.create()` calls `sessions.subscribe(id, clientId, cb)` (auto-subscribe)
4. `subscribe()` sees: mode=direct, !session.pty, status=STOPPED → **calls `session.start()` again**
5. New PTY spawns (now tries to run `claude` command or resume) → status = RUNNING
6. Client sees session as RUNNING — never gets the STOPPED state

**Confirmed by:** Test failure message `Expected value: "running"  /  Received array: ["stopped", "error"]` — the assertion `expect(['stopped', 'error']).toContain(sess.status)` fails because `sess.status === "running"`.

**Impact:** Any fast-exiting direct session gets silently restarted. If the `claude` binary is not
present, the restart attempt emits no user-visible error (just a console warning). The user's
intended behavior (run `bash -c "exit 0"` once) is violated.

**Fix:** The auto-resume on subscribe should NOT fire immediately after create. Options:
1. Skip auto-resume if the session was just created (check `createdAt` vs now).
2. Add a `noAutoResume` flag to `subscribe()` used by the create handler.
3. Only auto-resume on `session:subscribe` (user explicitly re-subscribing), not on the
   create-time auto-subscribe.

---

### BUG-G-002 (P2 — Availability): Server event loop blocked by large PTY write

**Test:** G.02 (10MB input), cascades into G.03-G.25  
**Severity:** P2 — temporary denial of service, server recovers but takes 30–90 seconds  

**Symptom:** After sending a large (1MB+) `session:input` payload via WebSocket, the Node.js
event loop is blocked while writing to the PTY. New WebSocket connections cannot complete the
`init` handshake within 6 seconds. Multiple subsequent tests fail with "Timeout waiting for
init message" — not because the server crashed, but because it is temporarily unresponsive.

**Evidence:**
- G.01 (1MB) PASSES in one run, then G.02 immediately fails with `Timeout waiting for init`
- In other runs G.01 passes and G.02 also passes, but G.03 (20 concurrent sessions) overwhelms
  the server and causes G.04–G.25 to cascade-fail
- Test results are non-deterministic between runs (9–12 pass per run)

**Root cause:** `sessions.write(id, data)` calls `this.pty.write(data)` on node-pty. Writing
10MB to a PTY fd is synchronous (or at least blocks the libuv event loop long enough to starve
the WS accept queue). There is no payload limit on the WebSocket server (`new WebSocketServer({ server: httpServer })` — no `maxPayload` option).

**Impact:** A single malicious client can send a large `session:input` and deny service to
other connected clients for tens of seconds. Not a crash, but a denial of service.

**Fix:**
- Add `maxPayload` to the WebSocket server: `new WebSocketServer({ server: httpServer, maxPayload: 1_000_000 })` (1MB limit)
- Or validate `data` length in the `session:input` handler before passing to PTY

---

### BUG-G-003 (P2 — Resource Leak): Session viewer callbacks not removed on client disconnect

**Test:** Confirmed by code inspection (C.19 adversarial angle, affects G.19/G.20)  
**Severity:** P2 — memory/resource leak, accumulates across many client disconnects  

**Symptom:** When a WebSocket client disconnects, `server.js` close handler only cleans up
`terminals.removeViewer()` — it does NOT call `sessions.unsubscribe()`. Any PTY output
callbacks registered via `SessionManager.subscribe()` remain in the session's viewers Map
forever.

**Root cause in `server.js` lines 85–95:**
```js
ws.on('close', () => {
  const client = clientRegistry.get(clientId);
  if (client) {
    for (const subId of client.subscriptions) {
      terminals.removeViewer(subId, clientId);  // ← only cleans up terminal viewers
      // MISSING: sessions.unsubscribe(subId, clientId)  ← never called!
    }
  }
  clientRegistry.remove(clientId);
});
```

**Impact:** Each session:subscribe that is not matched by a session:unsubscribe (i.e., client
disconnects without unsubscribing) leaks one callback in `session.viewers` Map. Over time (many
client connects/disconnects), the viewers Map grows without bound. Every PTY output chunk is
sent to all these dead callbacks, causing `clientRegistry.send()` to fail silently (the WS is
closed so send is a no-op, but the iteration still happens on every output chunk).

For G.20 (50 clients subscribe + disconnect): 50 stale viewer callbacks per test run remain
in the session. In production with many reconnects over time this becomes O(n*m) overhead on
every PTY output byte.

**Fix:** Add `sessions.unsubscribe(subId, clientId)` alongside `terminals.removeViewer()`:
```js
for (const subId of client.subscriptions) {
  terminals.removeViewer(subId, clientId);
  sessions.unsubscribe(subId, clientId);  // ← add this
}
```

---

## TEST RESULT SUMMARY

| Test | Result | Notes |
|------|--------|-------|
| G.01 — 1MB input | PASS | Server survives |
| G.02 — 10MB input | FAIL (cascade) | Server overwhelmed after G.01 or 10MB write blocks event loop |
| G.03 — 20 concurrent creates | FAIL (cascade) | WS init timeout after G.02 overload |
| G.04 — External tmux kill | PASS/FAIL (flaky) | Depends on run order; when it runs first it passes |
| G.05 — Corrupt sessions.json + save | PASS | Save overwrites garbage cleanly |
| G.06 — Non-existent cwd | PASS/FAIL (cascade) | When not cascaded: project accepts bad path, session created |
| G.07 — exit 0 command | FAIL (real bug) | **BUG-G-001**: session auto-resumed, stays RUNNING |
| G.08 — exit 1 command | PASS | exit 1 → ERROR state correct |
| G.09 — Non-existent binary | PASS/FAIL (cascade) | When not cascaded: server survives nonexistent binary |
| G.10 — Binary input | PASS | Null bytes and escape sequences forwarded without crash |
| G.11 — Shell injection via session name | PASS | JSON.stringify safely encodes injection attempt |
| G.12 — 100 rapid resize events | PASS/FAIL (cascade) | When not cascaded: server survives resize flood |
| G.13 — sessions.json deleted mid-run | PASS | Save recreates file cleanly |
| G.14 — Unknown "shell" status migration | PASS | Status migrated to "stopped" on init |
| G.15 — Two clients write simultaneously | PASS/FAIL (cascade) | When not cascaded: both writes succeed |
| G.16 — Shell metacharacters in command | PASS/FAIL (cascade) | tmux bash-c wrapping handles metacharacters |
| G.17 — Empty command fallback | PASS | command="" falls back to 'claude' |
| G.18 — Whitespace-only command | PASS/FAIL (cascade) | When not cascaded: whitespace → 'claude' fallback |
| G.19 — Subscribe + immediate disconnect | PASS | No crash; viewers cleaned (partially — see BUG-G-003) |
| G.20 — 50 clients subscribe + disconnect | FAIL (cascade) | WS init timeout for new subscriber; BUG-G-003 confirmed |
| G.21 — Concurrent store load + save | PASS | Atomic write (tmp+rename) prevents corruption |
| G.22 — mode: 'invalid' | PASS | Falls through to direct mode |
| G.23 — WS subprotocol header | PASS | Server accepts non-standard subprotocol |
| G.24 — 10KB command string | PASS/FAIL (cascade) | When not cascaded: server handles long command |
| G.25 — Delete + create concurrent | PASS | Atomic store write prevents JSON corruption |

---

## CASCADING FAILURE ROOT CAUSE

The test suite uses a **single shared server** (port 3094) for 22 of 25 tests. Heavy tests
(G.02: 10MB WS payload, G.03: 20 concurrent sessions spawning PTYs, G.20: 50 WS connections)
overwhelm the server's event loop, causing subsequent tests to time out during WS handshake.

The cascade pattern: G.01 passes → G.02 sends 10MB → server event loop saturated → G.02's
own `init` wait times out → G.03 onwards are affected for 30–90 seconds.

**This means the 10MB test (G.02) itself is FAILING** — not because the server crashed, but
because it couldn't respond to a new WS connection within 6 seconds of a 10MB write. This
confirms BUG-G-002: the server event loop is blocked by large PTY writes.

---

## SEVERITY SUMMARY

| Bug | ID | Severity | Status |
|-----|----|----------|--------|
| exit-0 session auto-resumed | BUG-G-001 | P1 | Open |
| Event loop blocked by large PTY write | BUG-G-002 | P2 | Open |
| Session viewer callbacks not removed on disconnect | BUG-G-003 | P2 | Open |
