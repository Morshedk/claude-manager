# Review: Move Session Between Projects

## Design Fidelity

### Design Decision Checklist

| # | Design Decision | Implemented? | Notes |
|---|----------------|-------------|-------|
| 1 | Replace "Open" button with "Edit" on SessionCard | YES | `handleAttach` removed, `handleEdit` added. Open button gone. |
| 2 | Edit button calls `e.stopPropagation()` | YES | Line 69 of SessionCard.js. |
| 3 | Modal dialog matching EditProjectModal pattern | YES | Same overlay/card/header/body/footer structure. |
| 4 | Session name text input, pre-filled | YES | `useState` initialized from `session.name` via `useEffect`. |
| 5 | Project `<select>` dropdown, pre-selected | YES | Pre-filled with `session.projectId`. |
| 6 | Dropdown disabled when `projects.length <= 1` with helper note | YES | `singleProject` flag, disabled attr, and explanatory text. |
| 7 | Escape to close | YES | `handleKeyDown` checks `e.key === 'Escape'`. |
| 8 | Ctrl/Cmd+Enter to save | YES | `handleKeyDown` checks `e.key === 'Enter' && (e.ctrlKey \|\| e.metaKey)`. |
| 9 | Overlay click-to-close | YES | `onClick=${closeEditSessionModal}` on overlay div. |
| 10 | Client sends `session:update` WS message | YES | `updateSession()` in actions.js sends `CLIENT.SESSION_UPDATE`. |
| 11 | Protocol: `SESSION_UPDATE` client, `SESSION_UPDATED` server | YES | Both added to protocol.js. |
| 12 | Store signals: `editSessionModalOpen`, `editSessionTarget` | YES | Both added to store.js. |
| 13 | Actions: `openEditSessionModal`, `closeEditSessionModal`, `updateSession` | YES | All three added to actions.js. |
| 14 | Server handler: `SessionHandlers.update()` | YES | Delegates to `sessions.update()`, sends confirmation, broadcasts. |
| 15 | `SessionManager.update()` method | YES | Validates session exists, validates projectId exists, updates meta fields, persists. |
| 16 | Updates `projectId`, `projectName`, and `cwd` on move | YES | All three updated in SessionManager.update() lines 373-375. |
| 17 | Broadcasts `sessions:list` after update | YES | `_broadcastSessionsList()` called after sending confirmation. |
| 18 | Sends `session:updated` confirmation to requesting client | YES | Line 211 of sessionHandlers.js. |
| 19 | `SESSION_UPDATED` handler: upsert + close modal + toast | YES | sessionState.js lines 115-119. |
| 20 | EditSessionModal mounted in App.js | YES | Conditionally rendered alongside EditProjectModal. |
| 21 | Session name click still works for attach | YES | Inline `(e) => { e.stopPropagation(); attachSession(session.id); }`. |

### What Was Missed or Done Differently

1. **No "no-op" optimization (AC 10)**: The design says "no unnecessary update is sent" when nothing changes. The implementation always sends `updates.name` (even if unchanged). The `projectId` is only sent when different, but `name` is sent unconditionally. The server handles it idempotently (overwrites with same value + saves), so no data corruption, but it does trigger a broadcast and toast for a no-change save.

2. **Modal stuck on error (documented deviation)**: When `session:update` fails, the server sends `session:error`, which triggers a toast via the existing error handler in sessionState.js. However, the modal's `submitting` state remains `true` because only `SESSION_UPDATED` resets it. The user must manually close the modal and reopen. The implementation notes acknowledge this.

3. **No warning about cwd/resume implications**: Design suggested "Note: moving a session may affect conversation resume." Not implemented. Implementation notes acknowledge this as intentional for v1.

4. **Toast message is always "Session updated"**: Design suggested "Session moved to [project name]" for moves. Implementation uses generic message. Design allowed either form.

## Security Issues

### Server-side validation

1. **`projectId` validated to exist**: YES. `SessionManager.update()` line 371 calls `this.projectStore.get(updates.projectId)` and throws if null. GOOD.

2. **`sessionId` validated to exist**: YES. `SessionManager.update()` line 368 checks `this.sessions.get(sessionId)` and throws if not found. GOOD.

3. **`name` not sanitized on server**: The `name` field is stored as-is (line 379: `session.meta.name = updates.name || null`). There is no length limit, type check, or content sanitization on the server side. A malicious client could send a `name` that is an object, a number, or a very long string. However:
   - Preact's `htm` template engine text-interpolates values (no innerHTML), so XSS via session name in the card is not possible.
   - The existing `session:create` handler also does not sanitize names beyond `.trim()`.
   - This is a single-user app, so the attack surface is minimal.
   - **Recommendation**: Add `typeof updates.name === 'string'` guard and a length cap (e.g., 200 chars) in `SessionManager.update()`.

4. **`projectId` type not checked**: If a client sends `projectId: 123` (number) instead of a string, `projectStore.get(123)` would fail and throw "Project not found", which is safe. No injection risk.

5. **No authorization check**: The `update` handler does not verify the client is authorized. This matches the existing pattern (no handler checks auth), so it is consistent. The app assumes all connected WS clients are trusted.

### Pre-existing security note (not introduced by this feature)

The `MessageRouter._routeSession` dispatches to `this.sessionHandlers[action]` where `action` is derived from the message type. This means a client sending `session:_broadcastSessionsList` or `session:constructor` could invoke internal methods. The `typeof handler === 'function'` check means `constructor` would pass. This is a pre-existing issue in the router, not introduced by this feature.

## Error Handling Gaps

1. **`submitting` stuck on server error**: As noted above. The `SESSION_ERROR` handler in sessionState.js shows a toast but does not reset the modal's `submitting` state. The fix would be to either (a) listen for `SESSION_ERROR` in the modal and reset `submitting`, or (b) have the `SESSION_ERROR` handler call `closeEditSessionModal()` if the modal is open.

2. **No client-side validation before send**: `handleSave` sends the update even if `session.id` is somehow null/undefined. The `session` guard on line 27 protects against null session, but not against a session object with a missing `id`. Low risk since the session object comes from the store.

3. **Network failure during update**: If the WebSocket is disconnected when the user clicks Save, `send()` silently fails (message is dropped). The modal stays open with "Saving..." indefinitely. The user has no feedback that the network is down. This is consistent with how other WS actions (create, stop) behave, but the modal makes it more visible.

## Race Conditions

1. **Session deleted while edit modal is open**: If another client (or the same client in another tab) deletes the session while the modal is open, clicking Save sends `session:update` for a non-existent session. The server returns `session:error` ("Session not found"). The modal stays in submitting state (see error handling gap above). Not a data integrity issue.

2. **Concurrent updates**: Two clients update the same session simultaneously. Last writer wins. Design acknowledges this (Risk 3) and accepts it for v1.

3. **Session list broadcast race**: The `update` handler sends `session:updated` to the requester FIRST, then calls `_broadcastSessionsList()`. This means the requester's `upsertSession()` from `SESSION_UPDATED` runs before the `sessions:list` broadcast arrives. When `sessions:list` arrives, it does a full replace (`sessions.value = msg.sessions || []`), which is correct and converges. No stale data risk.

## Structural Debt Checks

### 1. Dead code
- **`handleAttach` in SessionCard.js**: Fully removed. No orphaned references. CLEAN.
- **"Open" button**: Fully removed. CLEAN.
- No other functions were orphaned by this change.

### 2. Scattered ownership
- Session metadata mutation is handled in ONE place: `SessionManager.update()`. The handler delegates to it. The client action delegates to `send()`. No scattered logic. CLEAN.
- Modal open/close is managed by two signals in store.js and two functions in actions.js, matching the EditProjectModal pattern exactly. CLEAN.

### 3. Effect scope correctness
- `EditSessionModal` has one `useEffect` with dependencies `[editSessionModalOpen.value, session]`. The `session` variable is `editSessionTarget.value`, which is read outside the effect. When the signal changes, the component re-renders, providing a new `session` value to the dependency array. This works correctly because Preact re-renders on signal access.
- **Minor concern**: The dependency array uses `session` (the variable), not `editSessionTarget.value` directly. Since `session = editSessionTarget.value` is evaluated at render time and the value is a new object reference each time the signal changes, the effect fires correctly. ACCEPTABLE.

### 4. Cleanup completeness
- `EditSessionModal` has no event listeners, observers, or timers that need cleanup. The `onKeyDown` is attached declaratively via JSX. CLEAN.
- No `useEffect` returns a cleanup function, which is correct since none is needed. CLEAN.

### 5. Orphaned references
- No references to removed IDs (e.g., "Open" button) or removed function names (`handleAttach`). Verified via grep. CLEAN.
- `session:refreshed` in sessionState.js is a hardcoded string (not using `SERVER.SESSION_REFRESHED` which doesn't exist in protocol.js). This is pre-existing, not introduced by this feature.

## Verdict: FAITHFUL

The implementation matches the design in all material respects. The three acknowledged deviations (error handling in modal, generic toast message, no cwd warning) are explicitly documented in the implementation notes and were permitted by the design. No design decisions were contradicted or silently changed.
