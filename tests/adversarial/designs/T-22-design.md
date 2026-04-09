# T-22 Design: Delete session while overlay is open

## Test Goal
Verify that deleting a session while its terminal overlay is still open (via split view) results in graceful overlay closure, no repeated subscribe messages to the server, no JS exceptions, and clean removal of the session card.

---

## Code Path Analysis

### How the overlay knows what to show
`SessionOverlay` reads `attachedSession.value` — a computed signal derived from:
```js
export const attachedSession = computed(() =>
  sessions.value.find(s => s.id === attachedSessionId.value) ?? null
);
```
If `sessions.value` no longer contains the attached session ID, `attachedSession.value` becomes `null`, and `SessionOverlay` returns early (`if (!session) return null`).

**Key insight:** When the server broadcasts `sessions:list` after a delete, `handleSessionsList` replaces `sessions.value` with the new array (which omits the deleted session). This will set `attachedSession.value` to `null`, causing the overlay to unmount automatically — IF `attachedSessionId` is also cleared or if the signal chain propagates correctly.

### The hidden risk: `attachedSessionId` is NOT cleared on delete
Looking at `actions.js`, there is no handler for session deletion that calls `detachSession()`. The flow is:
1. Client sends `session:delete` → server deletes → broadcasts `sessions:list`
2. `handleSessionsList` updates `sessions.value` (removed session gone)
3. `attachedSessionId.value` still holds the deleted session's ID
4. `attachedSession` computed returns `null` (session not in list)
5. `SessionOverlay` returns `null` — overlay disappears ✓

This part works correctly due to the computed signal chain.

### The subscribe loop risk: TerminalPane cleanup
`TerminalPane` is mounted while the overlay is visible. Its cleanup hook fires when it unmounts (when overlay disappears). The cleanup sends `session:unsubscribe`. 

But here's the critical question: **does TerminalPane unmount before or after a re-subscribe attempt?**

The `connection:open` handler in TerminalPane re-subscribes on WS reconnect. This is NOT triggered here (no reconnect occurs). So no spurious re-subscribe from that path.

However, TerminalPane's effect depends on `[sessionId]`. When the overlay unmounts (because `attachedSession` becomes null), TerminalPane unmounts too and cleanup fires — sending `session:unsubscribe` to a session that no longer exists. The server's `subscribe` handler checks `sessions.exists(id)` and would return an error for the deleted session. But this is `unsubscribe`, which is handled more leniently.

### The repeat-subscribe risk
`TerminalPane` sends `session:subscribe` once on mount. It re-sends on `connection:open` (reconnect). Neither of these fires on delete. So after deletion:
- Overlay unmounts → TerminalPane unmounts
- Cleanup sends `session:unsubscribe` (harmless — server may log it but no error to client)
- No further subscribe messages are sent ✓

### Potential failure modes

1. **Race condition:** `sessions:list` arrives, overlay unmounts, TerminalPane sends unsubscribe to deleted session. Server may send `session:error` back. The `session:error` handler shows a toast. **Risk:** User sees a toast error when deleting from the overlay.

2. **attachedSessionId stale state:** After the overlay closes via this path, `attachedSessionId.value` still holds the deleted session ID. If the user opens a new session, this should be overwritten. But if something tries to re-attach the old session ID (unlikely), it could fail.

3. **Delete from SessionCard requires stopped state:** Looking at SessionCard, the Delete button only renders when `!isActive(session)`. The test spec says "open a stopped session" — so this is the correct precondition. A running session has no Delete button visible.

4. **confirm() dialog in headless Playwright:** SessionCard's `handleDelete` calls `confirm(...)`. Playwright must handle this dialog via `page.on('dialog', ...)`.

---

## Test Strategy

### Setup
1. Seed a project via REST API
2. Create a stopped session via WS (or create + wait for it to stop, OR just create directly via REST seeding if possible)
3. The cleanest approach: create a session via WS, let it reach `stopped` state naturally (or stop it after create)

### Split View Flow
1. Navigate to project page
2. Click "Open" on session card → overlay appears
3. Enable split view (click "Split" button) → session list visible alongside overlay
4. Click "Delete" on the session card (visible in split left panel)
5. Handle the confirm() dialog — accept it
6. Assert: overlay disappears (no `#session-overlay` in DOM)
7. Assert: session card is gone from list
8. Assert: no console errors of type 'error'
9. Assert: no repeated `session:subscribe` messages sent after delete

### WS message monitoring
Use `page.on('websocket', ...)` to intercept frames and detect any post-delete subscribe messages.

### Console error monitoring
Use `page.on('console', msg => ...)` to collect errors before assertions.

---

## Expected Pass Criteria
- `#session-overlay` not present in DOM after delete
- Session card for deleted session not present in DOM
- Zero JS console errors
- Zero `session:subscribe` WS frames sent after the delete message
- No infinite loop of WS messages

## Expected Risk Areas
- `confirm()` dialog must be auto-accepted via Playwright dialog handler
- Timing: must wait for `sessions:list` broadcast after delete before asserting
- The session must be in `stopped` state for the Delete button to appear
- Server sends `session:error` after `session:unsubscribe` to deleted session → may trigger toast (acceptable, not a console error)
