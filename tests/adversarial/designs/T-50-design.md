# T-50 Design: Concurrent Refresh on Two Tabs — No Orphaned PTY Processes

**Score:** 11  
**Test type:** Server-level + WS protocol  
**Port:** 3147  
**Date:** 2026-04-08

---

## 1. What the Test Covers

Two WebSocket connections both send `session:refresh` to the same session within 100ms
of each other (via `Promise.all`). The test verifies that only ONE new PTY process is
spawned — not two. The expected failure mode is two PTY processes running simultaneously
for one session, both writing to the session's output channel (garbled output), with one
becoming an "orphan" that runs indefinitely.

---

## 2. Source Analysis

### DirectSession.refresh() — no concurrency guard

```js
async refresh(authEnv = {}) {
  if (this.meta.status === STATES.STARTING) {
    throw new Error(`Cannot refresh ... already starting`);
  }
  if (this.meta.status === STATES.CREATED) {
    throw new Error(`Cannot refresh ... session has never been started`);
  }

  // Kill existing PTY if still alive
  if (this.pty) {
    try { this.pty.kill(); } catch {}
    this.pty = null;
  }

  // Normalise to STOPPED
  if (this.meta.status !== STATES.STOPPED && this.meta.status !== STATES.ERROR) {
    this.meta.status = STATES.STOPPED;
  }

  // Re-start
  await this.start(authEnv);
}
```

**Critical finding:** There is NO mutex or in-progress flag on `refresh()`. Two concurrent
calls will BOTH:
1. Check `this.meta.status` — first caller sees RUNNING, second caller sees... depends
   on timing.

**Race analysis:**

Call A and Call B arrive within ~0ms of each other:
- **Scenario 1 (typical):** Call A runs first synchronously:
  - A: status=RUNNING (not STARTING, not CREATED — passes guard)
  - A: kills PTY → `this.pty = null`
  - A: sets `this.meta.status = STOPPED` (direct assignment, bypasses assertTransition)
  - A: calls `await this.start(authEnv)` → awaits async PTY spawn
  - B: now runs (Node.js is single-threaded) → status is now STARTING (set by A's start())
  - B: status=STARTING → throws "Cannot refresh ... already starting"
  - B: `session:error` is sent to client B

- **Scenario 2 (both in microtask queue before any await):** Both calls are awaited
  concurrently via `Promise.all`. The `refresh()` method is `async` but the status
  checks at the top are synchronous. In Node.js, both `refresh()` calls enter their
  first synchronous block before any `await` yields:
  - A: runs synchronously through the guard, kills PTY, sets status=STOPPED
  - A: hits `await this.start(authEnv)` → yields to event loop
  - B: runs synchronously through the guard — status is now STOPPED (not STARTING yet,
    because `start()` hasn't executed its first line yet due to await)
  - B: NOT in STARTING state — B passes the guard!
  - B: `this.pty` is null (A set it) — no kill needed
  - B: `this.meta.status !== STOPPED` is false — no normalization needed
  - B: calls `await this.start(authEnv)` — SECOND PTY spawned!
  
**This is the bug being tested.** Between A killing the old PTY and setting status=STOPPED,
and A's `start()` setting status=STARTING, there's a synchronous window where B can
see status=STOPPED and also enter `start()`. Two PTY processes spawn.

### start() — what happens when called twice concurrently

```js
async start(authEnv = {}) {
  this._setState(STATES.STARTING);  // First call: STOPPED → STARTING ✓
  // ...
  const myGen = ++this._ptyGen;     // First call: _ptyGen = 2
  this._wirePty(myGen);
}
```

If B's `start()` runs AFTER A's `_setState(STARTING)`:
- B calls `this._setState(STARTING)` → throws `Invalid state transition: starting → starting`
- B fails with an assertion error
- Only one PTY spawns

If B's `start()` runs BEFORE A's `_setState(STARTING)` but AFTER A set status=STOPPED:
- Both see STOPPED → both call `this._setState(STARTING)` → but the FIRST one to run
  it sets status to STARTING, and the SECOND one tries STARTING → STARTING which throws
- In Node.js single-threaded model: the two `await this.start(authEnv)` calls cannot
  run concurrently — `start()` is synchronous up to the pty.spawn() call
- So only one of them can be in `_setState(STARTING)` at a time

**Actually:** Looking more carefully at the execution order when both refreshes are
called with `await Promise.all([refresh1(), refresh2()])`:

```
Both refresh() calls start executing synchronously (they're in the same microtask context):
  refresh_A: check STARTING → no; check CREATED → no; kill pty; set status=STOPPED; 
  refresh_A: calls start() → _setState(STARTING) → status=STARTING
  refresh_A: ptyProcess = pty.spawn(...) ← this is the first async operation
  refresh_A: YIELDS to event loop
  
  refresh_B: check STARTING → YES (A just set it to STARTING)
  refresh_B: throws "Cannot refresh ... already starting"
```

Wait — can BOTH refresh_A and refresh_B's synchronous prologue run before either calls
start()? Let's trace more carefully:

```js
// refresh_A and refresh_B both called with Promise.all
// They are both kicked off as microtasks

// refresh_A runs first (first in array):
if (status === STARTING) → false (status is RUNNING)
if (status === CREATED) → false
// Kill PTY:
this.pty.kill(); this.pty = null;
// Normalize:
this.meta.status = STATES.STOPPED; // status = STOPPED
// Call start (also async):
await this.start(authEnv);
```

At `await this.start(authEnv)` — this starts executing `start()` synchronously:

```js
// Inside start(), called from refresh_A:
this._setState(STARTING); // status = STARTING ← synchronous!
// ... spawn pty ...
ptyProcess = pty.spawn(...); // ← this might be synchronous (node-pty is sync!)
this.pty = ptyProcess;
const myGen = ++this._ptyGen;
this._wirePty(myGen);
// _wirePty registers callbacks (synchronous)
// Then:
Promise.resolve().then(() => { // ← this schedules a microtask for RUNNING transition
  if (gen !== this._ptyGen) return;
  if (status === STARTING) this._setState(RUNNING);
});
// start() returns (no await inside it until the pty.spawn if it's sync)
```

Actually, `start()` has `async` but node-pty's `spawn()` is SYNCHRONOUS! So `start()`
runs completely synchronously (modulo the microtask at the end) without any `await`.

**Revised execution trace:**

```
Promise.all([refreshA(), refreshB()]) kicks off:

[SYNCHRONOUS BLOCK - refresh_A's prologue]:
  status=RUNNING → passes guards
  kill pty, pty=null
  status = STOPPED

[Now: start() called from refresh_A - also synchronous]:
  _setState(STARTING) → status = STARTING
  pty.spawn() → ptyProcessA created (sync)
  this.pty = ptyProcessA
  _ptyGen = 2
  _wirePty(2) → registers onData/onExit for gen=2
  schedule microtask: if gen===_ptyGen → STARTING→RUNNING
  start() returns (no await in hot path)

[refresh_A hits its own `return` — refresh_A is done (it just calls await start() which returned)]

Actually: refresh_A IS async, and `await this.start(authEnv)` 
Since start() is not truly async (no await inside it for the fast path),
`await this.start()` resolves immediately — but the `await` itself 
inserts a microtask boundary. 

After `await this.start()`:
- refresh_A completes
- Now the event loop picks up refresh_B

[SYNCHRONOUS BLOCK - refresh_B's prologue]:
  status=STARTING (A already ran) → THROWS "Cannot refresh ... already starting"
  refresh_B rejects with error
```

**Conclusion from source analysis:** In the typical case (status=RUNNING when both arrive),
the race IS ACTUALLY SAFE because `await this.start()` from refresh_A sets status to
STARTING synchronously before refresh_B's guard check. refresh_B will see STARTING and
throw.

BUT: there's still a possible window. If the session's status is STOPPED when both
arrive (e.g., the previous command already exited before the concurrent refresh):

```
[refresh_A]: status=STOPPED → passes guard (not STARTING, not CREATED)
[refresh_A]: this.pty is null → no kill
[refresh_A]: status !== STOPPED → false → no normalization
[refresh_A]: await this.start() → synchronously: _setState(STARTING), spawn ptcA, return
[Now status = STARTING]

[refresh_B]: status=STARTING → THROWS
```

Same result — SAFE.

**But wait:** What if we use `Promise.all` and the session is RUNNING? The key question
is whether JavaScript's single-threaded event loop guarantees that refresh_A's synchronous
prologue (up to the first `await`) runs COMPLETELY before refresh_B starts at all.

The answer is YES for Promise.all — the promises are resolved in microtask order,
and each `async function` runs synchronously up to its first `await`. But `Promise.all`
schedules both as microtasks... Actually, in JS, when you call `Promise.all([f(), g()])`,
both `f()` and `g()` are called IMMEDIATELY (synchronously) before `Promise.all` even
gets to do anything. So the call order is:

```
f() starts → runs synchronously until first await → suspends → f() Promise created
g() starts → runs synchronously until first await → suspends → g() Promise created
Promise.all([fPromise, gPromise]) evaluates
```

So both prologue synchronous blocks DO run before the awaits. The question is: does
`f()`'s synchronous part run COMPLETELY before `g()`'s synchronous part starts?

**No.** They both run synchronously in the same call stack turn. So:

```
f() called:
  f() body starts executing synchronously
  ... runs until first `await` ...
  f() suspends
g() called:
  g() body starts executing synchronously
  ... runs until first `await` ...
  g() suspends
```

But `f()` runs first (it's called first in `Promise.all([f(), g()])`). The `f()` 
function runs completely synchronously up to its first `await`. Only then does `g()`
start running.

In `refresh()`:
```js
async refresh(authEnv = {}) {
  // Guards (synchronous)
  if (this.meta.status === STATES.STARTING) throw ...
  if (this.meta.status === STATES.CREATED) throw ...
  
  // Kill (synchronous)
  if (this.pty) { this.pty.kill(); this.pty = null; }
  
  // Normalize (synchronous)
  if (...) this.meta.status = STATES.STOPPED;
  
  // First AWAIT:
  await this.start(authEnv);  // ← yield point
}
```

But `this.start(authEnv)` is async. When you call `await asyncFn()`, JavaScript:
1. Calls `asyncFn()` — which runs synchronously until ITS first await
2. `asyncFn()` returns a Promise
3. The `await` in the caller registers a continuation on that Promise
4. Control returns to the caller's caller (the event loop)

`start()` contains:
```js
async start(authEnv = {}) {
  this._setState(STATES.STARTING);  // sync
  const { command, cwd, claudeSessionId } = this.meta;
  const cmdParts = ...;
  const binary = ...;
  const args = this._buildArgs(...);  // sync
  
  let ptyProcess;
  try {
    const pty = require('node-pty');  // sync (cached require)
    ptyProcess = pty.spawn(binary, args, {...});  // SYNCHRONOUS!
  } catch (err) {
    this._setState(STATES.ERROR);
    throw new Error(`Failed to spawn PTY: ${err.message}`);
  }
  
  this.pty = ptyProcess;
  this.meta.pid = ptyProcess.pid;
  this.meta.startedAt = ...;
  const myGen = ++this._ptyGen;
  this._wirePty(myGen);
  // No await inside start()! It's fully synchronous!
}
```

`start()` has NO `await` inside it! It is fully synchronous despite being declared
`async`. Calling `await this.start()` will:
1. Call `start()` → runs completely synchronously → returns undefined (no explicit return)
2. The `async` wrapper turns `undefined` into `Promise.resolve(undefined)`
3. `await Promise.resolve(undefined)` schedules a microtask for the continuation
4. `refresh_A`'s synchronous block is DONE — control yields to microtask queue

So the race window IS:

```
refresh_A called synchronously:
  - Guards check: status=RUNNING → OK
  - Kill PTY: this.pty=null
  - Normalize: status = STOPPED
  - Call start(): ENTIRE start() runs synchronously:
    * _setState(STARTING) → status = STARTING
    * pty.spawn() → PTY_A created
    * this.pty = PTY_A
    * _ptyGen = 2
    * _wirePty(2)
  - start() returns (sync)
  - `await start()` → continuation scheduled as microtask
  - refresh_A's synchronous part is done → YIELDS

refresh_B called synchronously (while refresh_A is at `await start()`, waiting):
  - Guards check: status = STARTING (A set it!) → THROWS "Cannot refresh ... already starting"
  - refresh_B rejects
```

**FINAL CONCLUSION:** The `_ptyGen` guard and the STARTING-state check in `refresh()` 
TOGETHER prevent the double-spawn. Because `start()` is fully synchronous:
1. refresh_A's entire synchronous execution (including setting status=STARTING) completes
   before refresh_B's synchronous execution begins
2. refresh_B sees status=STARTING and rejects

**This means T-50 should PASS on the current codebase.**

However, we should still run the test to VERIFY this property holds. The test is
valuable because:
1. It confirms the theoretical analysis with actual PTY process counts
2. It would catch regressions if `start()` gains an `await` inside it
3. It validates the `_ptyGen` mechanism indirectly

---

## 3. Test Flow

### Infrastructure

```
beforeAll:
  1. Kill port 3147
  2. mktemp -d → tmpDir
  3. Create project directory in tmpDir
  4. Write projects.json: { "projects": [...], "scratchpad": [] }
  5. Start server on port 3147
  6. Wait up to 25s for server ready
```

### Test: Concurrent refresh → only one PTY spawned

```
1. Connect ws1 to server
2. Wait for init message from server
3. Create session via ws1:
   - command: 'bash -c "sleep 30"' (long-running to allow time for refresh)
   - mode: 'direct'
4. Wait for session:created → capture sessionId
5. Poll REST until status='running' (max 10s)
6. Record PID of running PTY: GET /api/sessions → session.pid
7. Connect ws2 to server (second WS connection — simulates second tab)
8. CONCURRENTLY: send session:refresh from BOTH ws1 AND ws2 within 100ms
   const [, ] = await Promise.all([
     sendAndCollect(ws1, {type:'session:refresh', id: sessionId}),
     sendAndCollect(ws2, {type:'session:refresh', id: sessionId}),
   ]);
9. Wait 5 seconds for PTY processes to stabilize
10. REST GET /api/sessions → get session state and PID
11. ASSERT: session is in 'running' state (not error, not broken)
12. ASSERT: session has exactly ONE new pid (different from original pid)
13. OS-level check: ps aux | grep sessionId → count matching processes
    OR: scan /proc for processes with PTY matching session
14. Verify WS responses: exactly ONE session:refreshed received between ws1+ws2
    Other WS should have received session:error (double-refresh blocked)
15. ASSERT: server still alive
```

### PID orphan detection

The most reliable way to check for orphaned PTYs is:
- After the concurrent refresh, record the new PID from REST API
- Check that only ONE process matching `bash.*sleep 30` is running
- Use `ps aux | grep "sleep 30"` count

**Alternative approach:** Use the session ID in the process name. Since we use
`bash -c "sleep 30"`, check `ps aux | grep "sleep 30" | grep -v grep | wc -l`.

If two PTYs were spawned, there would be 2 `sleep 30` processes (one orphaned).

### Session ID uniqueness via ps

To avoid false positives from other tests, use a unique marker command:
```bash
bash -c "sleep 30 && echo T50_DONE"
```
Actually simpler: `bash -c "sleep 99"` with a unique sleep duration (99 seconds) that
won't be used by any other test. Or: use a named marker:
```
bash -c "exec -a T50-session-marker sleep 30"
```

This sets the process name to `T50-session-marker`, making `ps aux | grep T50-session-marker`
uniquely identify this test's processes.

---

## 4. WS Message Collection Strategy

Instead of blocking on a single message, we need to collect ALL WS messages after
sending both refreshes, then analyze what was received.

```javascript
function collectMessages(ws, durationMs) {
  const msgs = [];
  const handler = (raw) => {
    try { msgs.push(JSON.parse(raw)); } catch {}
  };
  ws.on('message', handler);
  return new Promise(resolve => {
    setTimeout(() => {
      ws.off('message', handler);
      resolve(msgs);
    }, durationMs);
  });
}
```

After 5 seconds, examine what ws1 and ws2 each received.

**Expected results:**
- One WS receives `session:refreshed` (success)
- The other WS receives `session:error` with "already starting" message
- Both WS receive `session:subscribed` broadcast (since broadcastToSession fires)
- Both WS receive `session:state` broadcasts for the state transitions

---

## 5. False-PASS Risks

### Risk 1: Vacuous pass — second refresh never sent

**Scenario:** Playwright timing means the second `session:refresh` is sent > 100ms after
the first, by which time the session has already reached RUNNING. The second refresh
would then succeed as a SECOND valid refresh (if allowed from RUNNING). Result: two
sequential refreshes, each valid, but NOT concurrent.

**Mitigation:** Use `Promise.all` with both WS sends happening synchronously (no await
between them). JavaScript will send both messages in the same synchronous block. The
100ms window is easily met.

**Detection:** Log timestamps of each send and the responses. Both sends should be within
1ms of each other. Assert that the SECOND response is a `session:error` (double blocked),
not a `session:refreshed`.

### Risk 2: Both get 'session:refreshed'

**Scenario:** Two PTYs spawned — both refreshes succeed. Two processes running.

**Detection:** This is the bug we're testing for. If BOTH ws1 and ws2 get
`session:refreshed`, we must count PTY processes (ps aux) and assert count=1.
If count=2, FAIL with "ORPHANED PTY DETECTED".

### Risk 3: Neither gets 'session:refreshed'

**Scenario:** Some other error (permission, session not found, etc.) blocks both.

**Detection:** If both get `session:error` and session is still in 'running' (old PTY),
this means the concurrent refresh logic is overly cautious. This is a FAIL (test hangs
forever waiting for refreshed).

**Mitigation:** Set a timeout for waiting for at least one `session:refreshed`. If none
arrives within 10s, diagnose and FAIL.

### Risk 4: ps aux count is wrong (subprocesses)

**Scenario:** `bash -c "sleep 30"` spawns as bash + sleep — two processes. ps count
of `sleep 30` would be 2 per session (bash and sleep).

**Mitigation:** Use a unique exec-a marker or count by session ID in process list.
Better: use `ps aux | grep T50` where the command has a unique T50 marker.

---

## 6. Pass / Fail Criteria

### PASS
1. Exactly ONE `session:refreshed` message received across ws1+ws2
2. Other WS received `session:error` (blocked) OR received nothing for refresh
3. Session is in 'running' state after 5s
4. ps aux shows at most 1 T50-marker process (no orphan)
5. Server still alive

### FAIL
1. BOTH ws1 and ws2 receive `session:refreshed` AND ps shows 2+ T50-marker processes
2. Session reaches 'error' state after concurrent refresh (PTY conflict)
3. Server crashes (crash log)
4. Either: zero `session:refreshed` received (both blocked — overly strict)

---

## 7. Infrastructure Notes

- Port: 3147
- WS endpoint: `ws://127.0.0.1:3147` (no /ws suffix — standard upgrade on root path)
- Command with unique marker: `bash -c "exec -a T50-concurrent-refresh sleep 30"` 
  or simply `bash -c "sleep 30"` and detect by count before/after
- `waitUntil: 'domcontentloaded'` (not used here — this is a server-level test, no browser)
- ProjectStore seed: `{ "projects": [...], "scratchpad": [] }`

---

## 8. Expected Result

**PASS** — Based on source analysis, the concurrent refresh is safe because:
1. `start()` is fully synchronous (no `await` inside it)
2. refresh_A's call to `start()` sets status=STARTING synchronously before any await
3. refresh_B's guard check sees status=STARTING and throws

The test validates this invariant and would catch regressions if `start()` were ever
refactored to include an `await` before setting STARTING state.
