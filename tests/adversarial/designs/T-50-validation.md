# T-50 Validation: Concurrent Refresh on Two Tabs — No Orphaned PTY Processes

**Date:** 2026-04-08  
**Validator role:** Adversarial review of design + execution  
**Result:** GENUINE PASS with significant design correction

---

## Question 1: Did the test pass? (Actual outcome)

**YES — GENUINE PASS.**

The test run output confirms:
- T-50a: Both refreshes succeeded (2 `session:refreshed` received), but exactly 1 marker
  process detected via ps after stabilization. No orphaned PTY.
- T-50b: Sequential refreshes produce unique PIDs; old PTYs killed (confirmed via
  `process.kill(pid, 0)` → ESRCH). Exactly 1 marker process after 2 refreshes.
- T-50c: No crash log entries.

The **critical invariant holds**: no orphaned PTY processes exist even when both
concurrent refresh requests succeed.

---

## Question 2: Was the design correct? (Meaningful assertions, real failure detection)

**PARTIALLY CORRECT — the design made an incorrect prediction but the test still found
the real answer.**

### The Design's Incorrect Prediction

The design predicted:
> "refresh_A sets status=STARTING synchronously before refresh_B runs"
> "refresh_B sees STARTING and throws 'Cannot refresh ... already starting'"
> "Expected: exactly ONE session:refreshed"

**What actually happened:** BOTH session:refreshed received (2, not 1). No session:error.

The design's analysis of the single-threaded event loop was technically correct
(JavaScript IS single-threaded), but it failed to account for the async gap between
WS message receipt and handler execution:

1. WS message from ws1 arrives → event scheduled in async queue
2. WS message from ws2 arrives → SEPARATE event scheduled in async queue
3. Event loop processes ws1's message: full refresh cycle executes synchronously 
   (RUNNING → kill PTY → start → STARTING → RUNNING via microtask)
4. Event loop processes ws2's message: sees RUNNING (not STARTING!), executes refresh

The design assumed the two WS messages would be processed within a single synchronous
block. They are not — each WS `message` event is a separate callback on the event loop.
The Node.js WS library emits each incoming message as a separate event. There is real
time between receiving ws1's message and ws2's message being processed.

**The full refresh cycle completes (including STARTING→RUNNING microtask) before the
second WS message's handler begins.** So the second refresh sees RUNNING, not STARTING.

### Was the false-PASS risk #1 addressed?

Risk #1 was "vacuous pass — second refresh never sent." The test mitigated this by
sending both messages synchronously:
```js
ws1.send(...refresh...);
ws2.send(...refresh...);
```
The log confirms "Both session:refresh messages sent within 0ms" — both were sent
within the same JS tick. This was correct.

However, the mitigated risk was wrong. The actual risk was the opposite: the test
assumed the SECOND refresh would be blocked, but it was not. The design was falsely
confident that its theoretical analysis was correct.

### Did the test still find the right answer?

**YES.** Despite the design's incorrect prediction about the mechanism, the test
correctly answered the real question: **Are there orphaned PTY processes after concurrent
refresh?** Answer: **NO.**

The test correctly:
1. Sent two concurrent refresh requests
2. Observed the actual server behavior (both succeeded)
3. Verified via ps that only 1 PTY exists after completion
4. Verified session is in healthy RUNNING state
5. Verified server survived

This is the correct outcome for the spec: the `_ptyGen` mechanism prevents orphaned
PTYs even when two refreshes execute sequentially.

### Was the assertion change acceptable?

The executor changed the key assertion from:
```js
expect(allRefreshed.length).toBe(1);  // original — WRONG
```
to:
```js
expect(allRefreshed.length).toBeGreaterThanOrEqual(1);  // updated — CORRECT
```

This is the RIGHT fix. The original assertion was based on incorrect design reasoning.
The updated assertion correctly tests the actual invariant: "at least one refresh
succeeded" (not "exactly one").

The **real invariant** being tested is: "no orphaned PTY after concurrent refresh."
That invariant is correctly tested by the marker process count assertion.

---

## Question 3: Was the execution faithful? (Code matches design)

**YES — with documented deviations.**

### Deviations

1. **exec -a not available:** Design assumed `exec -a "marker-name" sleep 60` could be
   used to name the process. In practice, `/bin/sh` on this system doesn't support `exec -a`.
   Fix: used `tmpDir` path as the ps search key (the full script path appears in ps).
   This was a correct workaround — the script path uniquely identifies this test's processes.

2. **Both refreshes succeeded:** The design predicted one would be blocked. The code
   was correctly adapted to handle this actual behavior while still testing the core invariant.

3. **ps marker count not checked at time of failure:** T-50a originally failed
   when asserting exactly-one session:refreshed. The marker count assertion was only
   reached in the corrected test. Had both refreshes succeeded AND left two orphaned PTYs,
   the marker count assertion would have caught it with `expected: 1, received: 2`.

---

## Critical Finding: Design Gap on Refresh Concurrency

**The design made a fundamental error** in its execution model analysis. It assumed that
because JavaScript is single-threaded, refresh_A's synchronous block would complete
before refresh_B's synchronous block begins. This is correct for code within the SAME
function call, but INCORRECT for SEPARATE event loop callbacks.

When two WebSocket clients send messages nearly simultaneously:
- Each message is received as a SEPARATE `message` event on the WebSocket server
- Each event is processed in its own turn of the event loop
- Between two event loop turns, ALL pending microtasks (including `STARTING→RUNNING`)
  execute
- So by the time the second WS message's handler runs, the first refresh has FULLY
  COMPLETED (including the RUNNING transition)

**Corrected understanding of the refresh race:**

The `_ptyGen` guard correctly handles this scenario. When the second refresh executes:
1. It kills the PTY spawned by the first refresh
2. Increments `_ptyGen` (now gen=3, was 2)
3. Spawns a third PTY
4. The second PTY's `onExit` fires with gen=2 ≠ _ptyGen=3 → ignored
5. Only the third PTY (from the second refresh) is alive

This is the correct behavior. No orphan. The `_ptyGen` mechanism is the actual safety
net, not the STARTING state guard.

**The STARTING state guard** only matters for truly concurrent JavaScript calls (not
realistic via WS) or for immediate double-refresh from the SAME event loop tick (which
the T-16 tests already cover).

---

## Overall Verdict

**GENUINE PASS — the core invariant (no orphaned PTY) is correctly validated.**

### What the test proves

1. When two browser tabs send `session:refresh` concurrently, the server processes them
   sequentially (Node.js event loop)
2. Both refreshes may succeed — this is acceptable behavior (each refresh kills the
   previous PTY before spawning a new one)
3. After both refreshes complete, exactly ONE PTY process exists (confirmed via ps)
4. The `_ptyGen` mechanism correctly kills stale PTY processes
5. The server does not crash from double-refresh
6. Old PTY processes are reliably killed after each refresh (confirmed in T-50b with
   process.kill(pid, 0) → ESRCH)

### The design found a real behavior, but with wrong reasoning

The test was designed to detect "two PTYs alive simultaneously" — the actual behavior
was "two sequential refreshes, one PTY alive after each." Both behaviors leave exactly
one PTY alive, so the invariant holds. The test correctly passes.

### Score: 11/11 (test passes expected PASS outcome, core invariant verified)

The _ptyGen mechanism is the real safety net for orphaned PTY processes, and T-50b
provides the most rigorous validation of it through sequential refresh verification
with OS-level process checking.
