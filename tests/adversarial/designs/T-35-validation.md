# T-35 Validation: Concurrent Session Creates — 5 Sessions Without Cross-Bleed

**Validator role:** Adversarial review — find reasons the PASS is fake or the test is weaker than it appears.

---

## Verdict: GENUINE PASS

**Did the test pass?** Yes.
**Was the design correct?** Yes, with one fix needed (message buffering).
**Was the execution faithful?** Yes, after 3 fix iterations.

---

## Question 1: Did the test actually pass?

Yes. The test confirmed:
- 5 distinct WS connections with 5 distinct clientIds.
- 5 `session:created` responses received (one per WS connection).
- 5 unique session IDs (no collision).
- 5 unique session names (`sess-0` through `sess-4`).
- After 10s: all 5 sessions in `'running'` state via REST API.
- No sessions in `'starting'` or `'created'` (non-terminal) state.
- All 5 IDs from `session:created` match the IDs in the REST API response.
- No crash log entries.

---

## Question 2: Was the design correct?

**Design strength:** Using different names per WS client is critical — prevents the server-side dedup key `clientId:projectId:name` from triggering. The test correctly predicted this and used `sess-0` through `sess-4`.

**Design strength:** Waiting 10 seconds before checking state ensures all sessions have exited the transient STARTING state. Bash is fast (~50ms to RUNNING), so 10s is very conservative.

**Design fix required:** The `init` message type is `'init'`, not `'connected'`. The design said "check for clientId assigned" but didn't specify the exact message type. The executor had to discover this via testing. A stronger design would have read `server.js` line 63 to find `type: 'init'`.

**Design fix required:** The `init` message is sent immediately on WS connect — before the listener in `waitForMsg` was attached. The design didn't anticipate this race. The fix (message buffer `_msgBuffer`) correctly handles it.

---

## Question 3: Was the execution faithful?

Yes. All 5 creates are sent in `Promise.all()` with `ws.send()` calls — effectively simultaneous (1ms). The test verifies uniqueness of both client IDs (server-side unique) and session IDs (server-side unique).

---

## Potential False-PASS Scenarios (evaluated)

1. **Dedup fires on all 5.** If all 5 WS connections somehow had the same clientId (impossible — server uses `uuidv4()` per connection), or if the names were the same (they're not — `sess-0` through `sess-4`), dedup would fire. The test logs 5 distinct clientIds — this is confirmed.

2. **Some sessions fail to start (ERROR state).** The test accepts `error` as a valid final state. Since bash is the command (not claude), errors are unlikely. All 5 reached `running`.

3. **Sessions are from a previous test run (port reuse).** `fuser -k 3132/tcp` clears the port before each run. The test uses a fresh `tmpDir` with an isolated `DATA_DIR`. Session count filter by `projectId` is specific to this run's project.

4. **The 10-second wait hides a stuck-starting race.** If a session was still in `starting` at t=10s, the test would catch it. Bash starts in <100ms. 10s is more than adequate.

---

## Adversarial Finding

The test proves no race condition exists for the current implementation. Node.js is single-threaded, so concurrent `session:create` WS messages are processed sequentially through the event loop. There is no true concurrency in `SessionManager.create()`. The test confirms the sequential processing produces correct results — 5 distinct UUIDs, no Map key collision.

**A stronger test would:** Verify that no PTY file descriptors are leaked after the test (e.g., check `/proc/self/fd` count before and after). This would catch resource leaks from 5 concurrent PTY spawns. Not implemented — but not required for the stated pass criteria.

**Overall verdict:** GENUINE PASS. The concurrent creation scenario works correctly. No session ID collision, no cross-bleed, no stuck sessions.

---

## Bug Report

None. Concurrent session creation is robust.
