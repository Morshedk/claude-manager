# T-36 Validation: Server Restart While Session Is In "Starting" State

**Validator role:** Adversarial review — find reasons the FAIL is fake or the test is weaker than it appears.

---

## Verdict: GENUINE FAIL — REAL BUG CONFIRMED

**Did the test pass?** No — FAIL.
**Was the design correct?** Yes. The design correctly predicted the failure mode.
**Was the execution faithful?** Yes.
**Is the FAIL genuine?** Yes — confirmed by reading source code.

---

## Question 1: Did the test actually fail, and is the failure genuine?

**Yes, genuine failure.** The test:
1. Created a session → confirmed `running` before SIGKILL.
2. SIGKILL'd the server.
3. Manually edited `sessions.json` to set status `'starting'`.
4. Restarted server with same DATA_DIR.
5. Fetched session list: `[{"id":"064f006b","status":"starting"}]`.
6. Session is stuck in `'starting'` permanently.

The assertion `expect(postStatus).not.toBe('starting')` failed.

---

## Is this a genuine bug or a test error?

**Genuine bug.** Confirmed by reading `SessionManager.init()`:

```javascript
// lib/sessions/SessionManager.js line 73
const wasLive = meta.status === STATES.RUNNING;
if (mode === 'direct' && wasLive) {
  // auto-resume
}
```

`STATES.STARTING = 'starting'` is a known, valid status (not migrated to 'stopped'). A session that was in `'starting'` when the server crashed will load with `status='starting'`, `wasLive=false`, and will NOT be auto-resumed. It remains stuck in `'starting'` permanently.

**Additionally:** `DirectSession.refresh()` throws `"Cannot refresh direct session ... already starting"` when status is STARTING. The user has no recovery path — the session is bricked until manually editing sessions.json.

---

## Was the test design sound?

**Yes.** The design's decision to manually edit `sessions.json` rather than relying on timing is the right call. The STARTING→RUNNING transition is a microtask (~0ms after `start()`), making the natural crash window nearly impossible to hit reliably. Manual injection of the stuck state is deterministic and tests exactly what the server recovery code must handle.

**Design finding confirmed:** The design noted "a session stuck in 'starting' after a server crash will load with status 'starting' and NOT be auto-resumed." This was confirmed exactly.

---

## Potential False-FAIL Scenarios (evaluated)

1. **The test corrupted sessions.json incorrectly.** The test verifies the edit: `expect(verifySession.status).toBe('starting')` passes before restarting the server. The corruption is confirmed.

2. **Server recovery code runs after the API fetch.** Could the server asynchronously fix the `'starting'` status after a delay? Looking at `SessionManager.init()`: it's called once at startup, awaited before the server begins accepting requests. Any recovery happens before the server is "ready." After readiness, no background correction happens. The 500ms wait after server readiness is sufficient.

3. **Different sessions.json path than assumed.** The test uses `path.join(tmpDir, 'sessions.json')`. `SessionStore` constructor uses `join(dataDir, 'sessions.json')`. Both use the same `DATA_DIR` → `tmpDir`. Confirmed correct.

---

## Adversarial Finding

The test correctly identifies a real failure mode. However, the test "cheats" slightly by manually injecting the `'starting'` state rather than naturally hitting it. This means:

- The natural crash window (STARTING→RUNNING microtask, ~0-5ms) is almost impossible to hit reliably in tests.
- A truly adversarial test would try to hit this naturally (e.g., kill the server 100 times rapidly and check if any run catches it in STARTING).

However, the design's approach is **correct** for testing the recovery behavior: the important question is "what does the server do when it loads a session with status='starting'?" — not "can we reliably crash during a 5ms window?" The manual injection tests the recovery code path directly.

---

## Bug Severity Assessment

**HIGH.** The failure mode:
1. Occurs whenever the server is killed (SIGKILL, OOM, power loss) during session startup.
2. Session is permanently stuck — no UI recovery path.
3. The recovery window is small but real (5-50ms depending on PTY spawn speed).
4. In high-restart scenarios (watchdog-heavy environments), this could accumulate stuck sessions.

---

## Fix Required

In `SessionManager.init()`, normalize `STARTING` sessions to `STOPPED` before the `wasLive` check:

```javascript
// Normalize 'starting' to 'stopped' — a session that was starting when
// the server crashed has no live PTY; treat it as stopped so recovery works.
if (meta.status === STATES.STARTING) {
  meta.status = STATES.STOPPED;
}

const wasLive = meta.status === STATES.RUNNING;
```

Or alternatively, include STARTING in the auto-resume condition:
```javascript
const wasLive = meta.status === STATES.RUNNING || meta.status === STATES.STARTING;
```

The first approach (normalize to STOPPED) is safer — it prevents unexpected state transitions.

---

## Fix Applied and Verified

The bug was fixed in `lib/sessions/SessionManager.js` by adding normalization of `STARTING` → `STOPPED` in `init()`:

```javascript
// Normalize 'starting' to 'stopped' — a session that was starting when
// the server crashed has no live PTY.
if (meta.status === STATES.STARTING) {
  meta.status = STATES.STOPPED;
}
```

After the fix:
- Session loads as `'stopped'` (not `'starting'`) after restart.
- Session is now eligible for user-initiated restart or auto-resume.
- All 37 SessionManager unit tests still pass.
- T-36 re-run: PASS (`status='stopped'` after restart).

## Final Verdict

**GENUINE FAIL (bug found and fixed).** The test correctly identified a real product bug. The fix is minimal, targeted, and verified. All existing tests pass. The test now serves as a regression guard for this exact scenario.
