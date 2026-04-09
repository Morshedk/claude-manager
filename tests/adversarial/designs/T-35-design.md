# T-35 Design: Concurrent Session Creates — 5 Sessions Start Without Cross-Bleed

**Score:** 12 | **Type:** Server-level (REST/WS) | **Port:** 3132

---

## What This Test Must Prove

Five simultaneous `session:create` WebSocket messages (each with a unique name) must produce exactly 5 distinct sessions, all reaching `running` or `error` state within a 15-second window. No session should be stuck in `starting` permanently. No two sessions should share a UUID.

---

## Source File Analysis

**`lib/ws/handlers/sessionHandlers.js` — session:create handler:**

- **Dedup guard** (lines 96–104): `const dedupKey = ${clientId}:${msg.projectId}:${name}`. Duplicate within 2s from same client+project+name → silent drop. Since we use **different names** per session and **different client IDs** (5 separate WS connections), this dedup guard will NOT fire. All 5 creates go through.
- **UUID generation:** `uuidv4()` per create call. Each create gets a fresh ID. No shared-state collision risk here.
- **Auto-subscribe on create:** The creating WS client is auto-subscribed to session output. 5 WS clients each get subscribed to their respective session.
- **`SessionManager.create()`:** Creates a `DirectSession` object, stores it, calls `session.start(authEnv)`. Since we use `bash` as the command (not `claude`), startup is near-instant.

**`lib/sessions/DirectSession.js` — start() method:**
- `this._ptyGen = 0` initially; `start()` increments to 1, then `_wirePty(1)` registers handlers.
- `_wirePty` uses a `Promise.resolve().then()` microtask to transition STARTING → RUNNING. Timing: within a few milliseconds of PTY spawn.
- 5 concurrent `start()` calls on 5 different `DirectSession` instances are independent — no shared mutable state between instances.

**`lib/sessions/SessionManager.js`:**
- `create()` adds sessions to an internal Map keyed by session ID. Concurrent creates → 5 distinct Map entries. No lock is needed since Node.js is single-threaded (event loop), but the async nature means we must verify no race corrupts the store.

**Command to use:** `bash` (not `claude`) — PTY spawns in < 1s, reaches RUNNING almost immediately. `bash` waits for input, so sessions stay RUNNING.

**5 different names:** `sess-0`, `sess-1`, `sess-2`, `sess-3`, `sess-4`. 5 separate WS connections (different `clientId` values). No dedup applies.

---

## Infrastructure

- Port: 3132
- Server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT=3132`, `CRASH_LOG`
- Seed: one project with `path: '/tmp'`
- Command: `bash` (fast startup, stays RUNNING)
- WS endpoint: `ws://127.0.0.1:3132/ws`
- No browser — pure Node.js WS client test

---

## Step-by-Step Execution Script

### Step 1: Server startup
Spawn server on port 3132 with isolated tmpDir. Poll until ready. Create project via `POST /api/projects`.

### Step 2: Open 5 WebSocket connections
Open 5 separate WebSocket connections. Each gets its own `clientId` (assigned by server on first message or connection). Wait for all 5 WS connections to be open.

### Step 3: Wait for WS protocol handshake
Each WS connection needs to be ready. Check if server sends an initial message (some servers send a `connected` event). Subscribe to the `open` event on all 5.

### Step 4: Send 5 simultaneous session:create messages
Using `Promise.all()`, send all 5 creates at exactly the same time:

```javascript
await Promise.all([0,1,2,3,4].map(i => {
  ws[i].send(JSON.stringify({
    type: 'session:create',
    projectId,
    name: `sess-${i}`,
    command: 'bash',
    mode: 'direct',
    cols: 80,
    rows: 24
  }));
}));
```

Note: `ws.send()` is not async (it queues in the WS send buffer). The sends are effectively simultaneous.

### Step 5: Collect session:created responses
Each WS client should receive a `session:created` message. Collect them with a timeout of 10 seconds. Use `Promise.all()` with individual WS message listeners.

### Step 6: Wait 10 seconds (as per spec)
After the creates, wait 10 seconds for sessions to reach stable state.

### Step 7: Fetch session list via REST
`GET /api/sessions?projectId=<id>` — or check the appropriate endpoint. Look for the sessions endpoint.

### Step 8: Assert exactly 5 sessions
- Count: exactly 5 sessions exist for the project.
- All IDs unique: `new Set(ids).size === 5`.
- All states: each session is `running` or `error` (not `starting` or `created`).
- No ID collision between sessions.

### Step 9: Verify session isolation
For each pair of sessions (i, j where i ≠ j): `session[i].id !== session[j].id`. Also verify `session[i].name !== session[j].name`.

### Step 10: Cleanup
Close all 5 WS connections. Kill bash sessions. Kill server.

---

## Finding Sessions Endpoint

Check `lib/api/routes.js` for session list endpoint. Look for `GET /api/sessions` or `GET /api/sessions?projectId=`. Alternatively, use WS message `session:list` or get from the `session:created` responses themselves.

---

## Pass / Fail Criteria

**Pass:**
- 5 `session:created` responses received (one per WS client).
- `GET /api/sessions` returns exactly 5 sessions for the project.
- All 5 session IDs are unique.
- All 5 sessions are in `running` or `error` state (not `starting`).
- No crash log entries during the test.

**Fail:**
- Fewer than 5 `session:created` responses (some dropped by race).
- Any two sessions share the same ID.
- Any session stuck in `starting` after 10 seconds.
- Server crash during concurrent creates.

---

## False-PASS Risks

1. **Dedup fires on all 5 (using same name).** Mitigation: use unique names `sess-0` through `sess-4`.

2. **WS clients share the same `clientId`.** If the server assigns `clientId` based on some shared state, all 5 might appear to be from the same client → dedup fires. Mitigation: verify 5 distinct `session:created` responses are received, each with a different session ID.

3. **`session:created` not a message type.** The server might send `session:state` instead. Check `sessionHandlers.js` for the exact response type.

4. **Sessions endpoint returns wrong data.** If the endpoint lists ALL sessions (not filtered by project), count might be >5. Mitigation: filter by `projectId`.

5. **bash exits immediately on stdin close.** When WS closes, bash PTY stdin closes → bash exits → session transitions to STOPPED. Since we wait 10 seconds before checking, and we keep WS connections open, bash should stay RUNNING. Close WS connections only after assertions.

---

## What to look up before implementing

Read `sessionHandlers.js` create response message type (line 100+). Read `routes.js` for the session list endpoint URL.

---

## Validator Checklist

- Were 5 distinct WS connections opened (not 1 connection with 5 sends)?
- Was the session list fetched from the server (not just from WS responses alone)?
- Were all 5 session IDs verified as unique?
- Was the bash PTY kept alive during the 10s wait?
- Were WS connections kept open until after all assertions?
