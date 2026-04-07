# Category C — WS Protocol Adversarial Test Findings

**Date:** 2026-04-07  
**Test file:** `tests/adversarial/C-ws-protocol.test.js`  
**Result:** 36 tests, 36 pass — 2 genuine app bugs confirmed

---

## BUG-C1: Stale Session Viewer After Client Disconnect (CONFIRMED — HIGH SEVERITY)

**Test:** C.19  
**Location:** `server.js` lines 85–94  

**Root cause:** The `ws.on('close')` handler in server.js cleans up *terminal* viewers but does NOT call `sessions.unsubscribe()`. The session's internal `viewers` Map retains the dead client's callback indefinitely.

```js
// server.js ws.on('close') handler — THE BUG:
ws.on('close', () => {
  const client = clientRegistry.get(clientId);
  if (client) {
    for (const subId of client.subscriptions) {
      terminals.removeViewer(subId, clientId);   // ✅ terminal viewers cleaned
      // sessions.unsubscribe(subId, clientId);   // ❌ MISSING — session viewers leak
    }
  }
  clientRegistry.remove(clientId);
});
```

**Impact:**
1. Every PTY output event fires the dead client's callback. `clientRegistry.send()` does a no-op readyState check, so no crash — but the callback still executes: wasted CPU on every output event.
2. After a new client subscribes to the same session, `session.viewers.size` is >= 2 (stale + new). The stale entry never gets evicted until the session is deleted.
3. Memory leak: closed WebSocket objects are retained in the viewer Map indefinitely.
4. If the stale callback references anything heavy (closures over large buffers), that memory is held for the session lifetime.

**Confirmed by test C.19b:** After disconnect, new client subscribes — `inst.viewers.size` is 2 (stale + new), not 1.

**Fix:** Add `sessions.unsubscribe(subId, clientId)` inside the close handler loop:
```js
ws.on('close', () => {
  const client = clientRegistry.get(clientId);
  if (client) {
    for (const subId of client.subscriptions) {
      terminals.removeViewer(subId, clientId);
      sessions.unsubscribe(subId, clientId);   // ADD THIS
    }
  }
  clientRegistry.remove(clientId);
});
```

---

## BUG-C2: cols=0 / rows=0 in session:subscribe Silently Skipped (CONFIRMED — LOW SEVERITY)

**Test:** C.06  
**Location:** `lib/ws/handlers/sessionHandlers.js` — `subscribe()` method  

**Root cause:** The resize guard uses a falsy check (`if (msg.cols && msg.rows)`) which treats `0` as missing:

```js
// sessionHandlers.js subscribe():
if (msg.cols && msg.rows) {    // cols=0 or rows=0 are falsy → silently skipped
  this.sessions.resize(id, msg.cols, msg.rows);
}
```

**Impact:** A client explicitly sending `cols: 0, rows: 0` gets no resize call and no error message. The terminal dimension update is silently discarded. While 0x0 terminals are unusual, the silent discard is a protocol surprise — a client can't distinguish "resize was applied" from "resize was ignored." Also, `cols: 120, rows: 0` would skip the resize even though cols is valid.

**Confirmed by test C.06:** `inst.resize` is NOT called when client sends `cols: 0, rows: 0`.

**Fix:** Use an explicit undefined/null check:
```js
if (msg.cols != null && msg.rows != null) {
  this.sessions.resize(id, msg.cols, msg.rows);
}
```

---

## Non-Bugs (Investigated and Ruled Out)

| Test | Finding |
|------|---------|
| C.07 Double subscribe | Safe — `Map.set(clientId, cb)` overwrites; `Set.add(sessionId)` is idempotent. Exactly 1 output delivered. |
| C.14 Malformed JSON | Server survives — catch block returns early, connection stays open. |
| C.22 Rapid sub/unsub | No race condition detected — subscribe is async but unsubscribe is sync; final state is clean in all 50 cycles. |
| C.27 1MB input | No crash, no hang, no message size limit hit — server processes the full payload and remains responsive. |
| C.28 100 rapid messages | All 100 delivered in order — no drops, no reordering. |
| C.04 Output ordering | `session:subscribed` always arrives before `session:output` — ordering is correct. |
| C.25 Auto-subscribe on create | Works correctly — creating client receives output without explicit subscribe. |

---

## Test Infrastructure Fix

The mock `DirectSession` factory was missing a `refresh()` method, causing C.12 to fail with `TypeError: inst.stop.mockImplementationOnce is not a function` (a side-effect of `jest.clearAllMocks()` wiping the implementation). Fixed by:
1. Adding `refresh: jest.fn().mockImplementation(...)` to `makeDirectSessionInstance`
2. Simplifying the C.12 test to not rely on `mockImplementationOnce` after `clearAllMocks`
