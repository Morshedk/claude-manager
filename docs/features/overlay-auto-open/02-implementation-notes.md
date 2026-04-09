# Implementation Notes: Overlay Auto-Open After Session Create

**Implementer:** Stage 2 Agent  
**Date:** 2026-04-08

---

## Files Modified

### `public/js/state/actions.js`

**What changed:** Modified `handleSessionCreated` (line 195) to call `attachSession(msg.session.id)` after `upsertSession(msg.session)`.

Before:
```js
export function handleSessionCreated(msg) {
  if (msg.session) upsertSession(msg.session);
}
```

After:
```js
export function handleSessionCreated(msg) {
  if (msg.session) {
    upsertSession(msg.session);
    attachSession(msg.session.id);
  }
}
```

**Why this works:** `attachSession` (defined at line 104 in the same file) sets `attachedSessionId.value = sessionId`. This signal drives `attachedSession` (a Preact computed in `store.js`), which `SessionOverlay.js` uses to determine whether to render. Since `upsertSession` is called first, the session object is in the `sessions` array when `attachSession` runs — the computed `attachedSession` resolves correctly.

**No imports needed:** Both `attachSession` and `handleSessionCreated` are in `actions.js`. `attachSession` is already defined above `handleSessionCreated` in the same module scope.

---

## Deviations from Design

None. The implementation matches the design exactly.

---

## Smoke Test

**Method:** Playwright headless browser test (script at `/tmp/smoke-overlay-auto-open.mjs`).

**What it did:**
1. Spun up an isolated server on port 3232 with a seeded project (`TestProject`)
2. Navigated to the app, confirmed `#session-overlay` was NOT visible before create
3. Selected the project, opened the New Session modal, filled session name "smoke-test-session"
4. Clicked "Start Session" — did NOT click any session card
5. Waited for `#session-overlay` to become visible

**Result:** `PASS` — overlay appeared automatically with title "smoke-test-session". Full output:
```
[smoke] overlay not in DOM before create — correct
[smoke] clicked Start Session, waiting for overlay...
[smoke] PASS: overlay appeared automatically! Title: smoke-test-session
[smoke] RESULT: PASS
```

---

## Observations

1. **Order matters:** `upsertSession` must come before `attachSession`. If `attachSession` fired first, `attachedSession` computed would return `null` (session not yet in array) and the overlay wouldn't render until the next signal update. The design specified this order correctly.

2. **Server sends `session:created` only to creating client:** Confirmed in `lib/ws/handlers/sessionHandlers.js` line ~130: `this.registry.send(clientId, { type: 'session:created', session })` — not a broadcast. So auto-open is inherently scoped to the creating tab.

3. **Session name is required by server:** The server rejects creates with empty name (sessionHandlers.js line ~79). The modal's `handleCreate` calls `closeNewSessionModal()` before the WS response arrives, so if the server rejects, no overlay opens and a `session:error` toast would appear. This is acceptable — the modal closes but no overlay appears.

4. **The `submitting` state in NewSessionModal is set but never reset:** After `handleCreate()` sets `setSubmitting(true)`, the modal closes immediately via `closeNewSessionModal()`. Since the modal unmounts and remounts fresh (per the `useEffect` on `newSessionModalOpen.value`), the state resets on next open. No bug — this is pre-existing behavior outside scope.

---

## What Was NOT Done

- No changes to `NewSessionModal.js` — the fix is in the WS message handler, not the form.
- No changes to `SessionOverlay.js` — it already handles `attachedSessionId` correctly.
- No changes to `sessionState.js` — the handler registration already wires `SESSION_CREATED` to `handleSessionCreated`.
- No changes to server-side code — the server already sends `session:created` correctly.
- No UI affordance to disable auto-open (out of scope per design).
