# Category D: Reconnect & Persistence — Adversarial Test Findings

**Date:** 2026-04-07
**File:** `tests/adversarial/D-reconnect.test.js`
**Results:** 13 PASS / 5 FAIL / 18 total
**Real bugs found:** 2 production bugs + 1 test infrastructure bug

---

## BUGS FOUND

### BUG-D-001 (HIGH): Session viewer map leaks on WebSocket disconnect

**Tests:** D.05 (direct), D.14 (cascading effect)
**Severity:** High — memory leak + session write-to-dead-socket risk

**Symptom:** When a WebSocket client disconnects (clean close or network drop), the
session `viewers` Map retains the disconnected client's callback. Every subsequent PTY
output event calls that callback, which tries to send JSON over a dead WebSocket
(`ws.readyState !== OPEN`). The send is silently swallowed by `clientRegistry.sendWs()`
because it checks `readyState`, but the stale entry remains in the Map forever —
one per disconnected viewer, accumulating until the session is deleted.

**Root cause — `server.js` lines 85–95:**
```js
ws.on('close', () => {
  const client = clientRegistry.get(clientId);
  if (client) {
    for (const subId of client.subscriptions) {
      terminals.removeViewer(subId, clientId);  // ← removes TERMINAL viewers only
    }
  }
  clientRegistry.remove(clientId);              // ← removes client from registry
  // MISSING: sessions.unsubscribe(sessionId, clientId) for each session subscription
});
```

The close handler iterates `client.subscriptions` and calls `terminals.removeViewer()`,
but `terminals` is the `TerminalManager` (project-level terminals), not the `SessionManager`.
There is no corresponding call to `sessions.unsubscribe(sessionId, clientId)`.

`SessionManager.unsubscribe()` calls `session.removeViewer(clientId)` which deletes the
entry from the `viewers` Map. Without this call, the Map never shrinks on disconnect.

**Cascade effect in D.14:** The `session:create` handler auto-subscribes the creating
client. When `wsSetup` creates a session and then closes, its viewer leaks. When `ws1`
and `ws2` subsequently subscribe, `viewers.size` is 3 (leaked + ws1 + ws2) not 2.

**Exact impact:**
- Each viewer entry holds a closure over `clientId` and the `registry.send` function
- On every PTY byte: O(leaked-viewers) send attempts, each checking `readyState` and
  discarding — cost grows proportional to total number of sessions ever viewed × churn
- Sessions with many historical viewers accumulate dead callbacks unboundedly
- No memory is freed until the session is deleted

**Fix — `server.js`:**
```js
ws.on('close', () => {
  const client = clientRegistry.get(clientId);
  if (client) {
    for (const subId of client.subscriptions) {
      terminals.removeViewer(subId, clientId);
      sessions.unsubscribe(subId, clientId);   // ← ADD THIS
    }
  }
  clientRegistry.remove(clientId);
});
```

**Also affects:** The same copy of this pattern in the in-process test server inside
`buildTestServer()` (tests/adversarial/D-reconnect.test.js lines 275–283). This is
a test fidelity issue — the in-process test server was copied from `server.js` with
the same bug, making D.05 a real reproduction of the production bug.

---

### BUG-D-002 (MEDIUM): projects.json written in wrong format by tests D.11 and D.12

**Tests:** D.11, D.12
**Severity:** Medium — test infrastructure bug; exposes a real fragility in ProjectStore

**Symptom:** D.11 and D.12 write `projects.json` as a plain JSON array:
```json
[{"id": "proj-d11", "name": "D11 Project", ...}]
```
But `ProjectStore` expects the format:
```json
{"projects": [{"id": "proj-d11", ...}], "scratchpad": []}
```

`ProjectStore._load()` does `this.data = JSON.parse(raw)`. When `raw` is a plain array,
`this.data` becomes `[]`. The guard `if (!this.data.projects)` then fires (since
`[].projects === undefined` is falsy), setting `this.data.projects = []`. All projects
are silently discarded. The server starts with zero projects, so `session:create` with
projectId `proj-d11` returns `session:error: "Project not found: proj-d11"`.

**Root cause:** Tests D.11 and D.12 copied the wrong JSON format from D.06 (which uses
the REST API to create projects) rather than matching the actual `ProjectStore` schema.

**Compounding issue:** `ProjectStore` silently discards a valid-JSON but wrong-schema
file without logging a warning. If an operator accidentally wrote a plain array to
`projects.json` (perhaps from a script), all projects would disappear on next restart
with no error message.

**Fix for tests:** Change D.11 and D.12 `projectsData` writes to use the correct format:
```js
// Wrong (current):
await writeFile(join(dataDir, 'projects.json'), JSON.stringify(projectsData, null, 2));

// Correct:
await writeFile(
  join(dataDir, 'projects.json'),
  JSON.stringify({ projects: projectsData, scratchpad: [] }, null, 2),
);
```

**Fix for production robustness:** `ProjectStore._load()` should detect and warn when
the file contains a plain array instead of an object, rather than silently dropping data.

---

## OBSERVATIONS (no production bug, but worth noting)

### OBS-D-001: Port conflicts cause test flakiness when test suite is run twice

**Tests:** D.06 (and potentially D.07–D.12)
**Status:** Test infrastructure issue, no production bug

Tests D.06–D.12 spawn subprocess servers on hardcoded ports (3096, 3196–3202). If a
prior test run left a zombie server on port 3096 (e.g. node crashed before cleanup),
D.06 would fail with `EADDRINUSE`. The `finally` block does call `killServer(proc)`, but
if the Jest process is killed by SIGKILL (e.g. timeout), `finally` may not run.

**Observed:** During the first test run, port 3096 was still occupied by a prior zombie,
causing D.07–D.15 to return 37–38 sessions (connecting to the wrong server). This
resolved itself when the zombie was killed between runs.

**Recommendation:** Use ephemeral ports (0) for all subprocess tests via `PORT=0` and
detect the actual port from the server's stdout, similar to the in-process server pattern.

### OBS-D-002: D.07–D.10 and D.15 pass in isolation, consistent with load-from-correct-dataDir

All subprocess tests that write a custom `projects.json` in the correct format (D.07,
D.08, D.09, D.10, D.15) pass reliably in isolation and in the full suite run (after the
port 3096 zombie was cleared). The `DATA_DIR` env var is correctly respected by the
subprocess server. SessionStore correctly loads from the temp dataDir. Unknown status
migration (D.10) works as specified.

### OBS-D-003: SessionStore.save() correctly writes from in-memory Map, not from disk

`SessionStore.save()` iterates the in-memory `sessions` Map and serializes it. It does
NOT read the current disk contents first. This means a corrupted `sessions.json` on disk
does NOT prevent a subsequent save from succeeding. Once D.11/D.12's project format bug
is fixed and `session:create` succeeds, the save will correctly overwrite the corrupted
file with valid data.

### OBS-D-004: SessionStore.upsert() reads disk before writing — potential race window

`SessionStore.upsert()` calls `this.load()` then `this.save()`. Between the load and the
save, another concurrent `upsert()` or `save()` could overwrite the file, and the first
`upsert()` would then overwrite that with stale data. The `SessionManager` mitigates this
by using `store.save(this.sessions)` (which writes from the full in-memory Map) rather
than `upsert()` in most paths. `upsert()` is only called from individual session classes.
This could still race under high concurrency; a mutex/write-queue would eliminate it.

---

## SUMMARY TABLE

| Test | Result | Notes |
|------|--------|-------|
| D.01 | PASS | sessions:list sent on every new WS connection |
| D.02 | PASS | Re-subscribe after reload returns session:subscribed |
| D.03 | PASS | 5 consecutive reloads succeed, no handler accumulation |
| D.04 | PASS | Force-closed WS cleaned from registry; new connection works |
| **D.05** | **FAIL** | **BUG-D-001: viewer not removed on WS close** |
| D.06 | PASS | sessions.json written before SIGKILL; file valid; session-A present |
| D.07 | PASS | 3 sessions from pre-written sessions.json all loaded on restart |
| D.08 | PASS | Tmux session loaded with persisted status (stopped/error in test env) |
| D.09 | PASS | Direct session with status=running auto-resumes or shows stopped |
| D.10 | PASS | 'shell' and 'zombie' statuses migrated to 'stopped', no crash |
| **D.11** | **FAIL** | **BUG-D-002 (test): wrong projects.json format → Project not found** |
| **D.12** | **FAIL** | **BUG-D-002 (test): same — wrong projects.json format** |
| D.13 (test 1) | PASS | Both tabs see same sessions on connect |
| D.13 (test 2) | PASS | Session created in tab 1 broadcast to tab 2 immediately |
| **D.14 (test 1)** | **FAIL** | **BUG-D-001 cascade: viewer count 3 instead of 2** |
| **D.14 (test 2)** | **FAIL** | **BUG-D-001 cascade: viewer count 3 instead of 1 after close** |
| D.15 (test 1) | PASS | Stale session ID returns session:error gracefully, no crash |
| D.15 (test 2) | PASS | 5 sessions loaded from pre-written file; subscribe to stopped → subscribed or error |

**Total: 13 PASS, 5 FAIL**
**Production bugs: 2 (BUG-D-001 is in server.js; BUG-D-002 is primarily in test code but reveals a ProjectStore robustness gap)**
