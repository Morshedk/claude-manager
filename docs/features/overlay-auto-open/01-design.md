# Design: Overlay Auto-Open After Session Create

**Feature slug:** overlay-auto-open  
**Date:** 2026-04-08  
**Status:** Draft

---

## Section 1: Problem & Context

### User Problem

After clicking "Start Session" in the NewSessionModal and the session card appears, the user must click the card manually to open the terminal overlay. This is friction — the user just asked to create a session and immediately wants to interact with it. The expected UX (as specified in Story 3, step 8 of adversarial test T-11) is that the overlay opens automatically.

### What Currently Exists

**Client-side flow:**

1. `NewSessionModal.js` (`handleCreate`, line ~81): calls `createSession(project.id, { command, name, mode, telegram })` then immediately calls `closeNewSessionModal()`.
2. `actions.js` (`createSession`, line ~66): sends `{ type: 'session:create', projectId, ...options }` over WebSocket — no state change happens here.
3. `sessionState.js` (`initMessageHandlers`, line ~57): registers `on(SERVER.SESSION_CREATED, handleSessionCreated)`.
4. `actions.js` (`handleSessionCreated`, line ~140): calls `upsertSession(msg.session)` — adds the session to the `sessions` signal. **No call to `attachSession()`.** This is the missing step.
5. `SessionOverlay.js` (line ~7): renders only when `attachedSession.value` is truthy, which is driven by `attachedSessionId` signal in `store.js` (line ~35).
6. `actions.js` (`attachSession`, line ~101): sets `attachedSessionId.value = sessionId`. This is never called on session:created.

**Server-side:**

`lib/ws/handlers/sessionHandlers.js` (`create` method, line ~115): after creating the session, auto-subscribes the creating client (lines ~122–125), then sends `{ type: 'session:created', session }` **only to the creating client** (`registry.send(clientId, ...)` — not broadcast). Then it calls `_broadcastSessionsList()` which sends `sessions:list` to all clients.

### What's Missing

`handleSessionCreated` in `actions.js` (line ~140) does not call `attachSession(msg.session.id)`. That single call is what's needed to auto-open the overlay.

The server already sends `session:created` only to the creating client (not broadcast), so this message is inherently scoped to the browser tab that triggered the create. This means we don't need any additional per-client filtering — `session:created` is already client-specific.

---

## Section 2: Design Decision

### What to Build

**One change, one location:**

Modify `handleSessionCreated` in `public/js/state/actions.js` (line ~140) to also call `attachSession(msg.session.id)` (which sets `attachedSessionId.value = msg.session.id`) after upserting the session.

```
// Current:
export function handleSessionCreated(msg) {
  if (msg.session) upsertSession(msg.session);
}

// After:
export function handleSessionCreated(msg) {
  if (msg.session) {
    upsertSession(msg.session);
    attachSession(msg.session.id);
  }
}
```

`attachSession` is already defined in `actions.js` (line ~97) and `attachedSessionId` is already imported in `sessionState.js` indirectly through the store. Since `attachSession` is in the same file (`actions.js`), it can be called directly.

### Data Flow

```
User clicks "Start Session"
  → NewSessionModal.handleCreate()
    → createSession(projectId, opts)   [actions.js:66 — sends WS message]
    → closeNewSessionModal()
  → Server receives session:create
    → creates session, auto-subscribes creating client
    → sends session:created { session } to creating client ONLY
  → Client receives session:created
    → handleSessionCreated(msg)        [actions.js:140]
      → upsertSession(msg.session)     [existing]
      → attachSession(msg.session.id)  [NEW: sets attachedSessionId.value]
  → Preact re-renders
    → attachedSession computed resolves to new session
    → SessionOverlay renders with correct session
```

### Edge Cases and Failure Modes

1. **Rapid double-create:** User clicks "Start Session" twice quickly (before modal closes). The server has a 2-second dedup window keyed on `clientId:projectId:name` (sessionHandlers.js line ~90). If name is empty, the server rejects with "Session name is required" (line ~79). So duplicate creates are blocked server-side. Only one `session:created` fires per dedup window, so `attachedSessionId` ends up set to the one that succeeded. No client-side conflict.

2. **Two sessions created in rapid succession with different names:** Two `session:created` messages arrive. The second one will overwrite `attachedSessionId` with the newer session's ID. This is correct behavior — the last session created wins. The first session is still in the sessions list and accessible via its card.

3. **User on a different project view when session:created arrives:** `handleSessionCreated` is a global handler that fires regardless of which project the user is viewing. Setting `attachedSessionId` will cause the overlay to open. The session's `projectId` is correct. The overlay will show the new session's terminal regardless of `selectedProjectId`. This is acceptable and expected — the user just asked to create this session.

4. **Another browser tab creates a session:** The server sends `session:created` only to the creating client (`registry.send(clientId, ...)` in sessionHandlers.js line ~130). Other tabs get only `sessions:list` from `_broadcastSessionsList()`. So other tabs will NOT auto-open the overlay. This is correct.

5. **Network delay — session:created arrives after user has navigated away:** `attachedSessionId` is set, overlay opens. User closes it manually. No problem — this is the same as current behavior when user opens an overlay.

6. **Session name is required** — server rejects creates with empty name (sessionHandlers.js line ~79). No `session:created` fires. `attachedSessionId` remains unchanged.

### What NOT to Build

- Do NOT change how the overlay closes (detach button, clicking outside).
- Do NOT change behavior on page reload — on reload, `attachedSessionId` starts as `null` (signal default), so no auto-open happens. This is correct.
- Do NOT change the `session:subscribed` or `session:output` handling.
- Do NOT add any UI affordance to disable auto-open.
- Do NOT change how other tabs see session creation.
- Do NOT touch `NewSessionModal.js` — the change belongs in the WS message handler, not the form.
- Do NOT add `projectId` switching — if the user is on a different project, the overlay still opens (the session card will be visible if they navigate back to that project).

---

## Section 3: Acceptance Criteria

1. **Given** a project is selected and the user opens the New Session modal, **when** the user fills in a session name and clicks "Start Session", **then** the terminal overlay (`#session-overlay`) becomes visible without requiring any additional click.

2. **Given** the overlay has auto-opened after session create, **when** the overlay title is inspected (`#overlay-title`), **then** it matches the session's name or ID prefix of the newly created session, not any other session.

3. **Given** the app is loaded fresh (page reload), **when** no session create has occurred in this tab, **then** `#session-overlay` is not visible — no overlay appears automatically from prior session state.

4. **Given** a session is already attached (overlay open), **when** a new session is created from the modal, **then** the overlay switches to the new session (the attached session ID changes to the new one).

5. **Given** two sessions are created in rapid succession with different names, **when** both `session:created` messages arrive, **then** the overlay shows the second (most recently created) session.

6. **Given** tab A and tab B are both open, **when** tab A creates a session, **then** tab B's overlay does NOT auto-open (session:created is not broadcast).

7. **Given** the user closes the overlay (clicks ✕) after auto-open, **when** no new session is created, **then** the overlay remains closed — the auto-open is not sticky/persistent.

---

## Section 4: User Lifecycle Stories

### Story 1: First-Time Session Create
User selects a project, opens the sidebar, sees no sessions. Clicks "New Claude Session". Modal appears. Types "refactor" as session name, selects Sonnet model. Clicks "Start Session". Modal closes immediately. The terminal overlay slides open showing a starting terminal with the session title "refactor". User starts typing commands without having to click anything.

### Story 2: Creating a Second Session While First is Open
User has an existing session "auth" open in the overlay. They click "New Claude Session" again, type "bugfix", click "Start Session". The overlay transitions from showing "auth" to showing "bugfix" — the new session is now active. The "auth" session is still running in the background and accessible via its session card.

### Story 3: Reload Does Not Re-Open Overlay
User creates a session, overlay auto-opens. User reads the terminal output, then reloads the browser tab. On reload, no overlay appears — the user sees the project view with session cards. The user must click a session card to reopen the overlay. Prior session's terminal state is preserved but not automatically attached.

### Story 4: Another Tab Is Unaffected
User has two browser tabs open to the same app. In tab A, they create a new session. Tab A's overlay auto-opens. Tab B shows the new session card appearing in the session list (via sessions:list broadcast) but tab B's overlay does not open. Tab B is undisturbed.

### Story 5: Session Name Required Guard
User opens the modal but leaves the session name empty. (The server requires a name.) Clicks "Start Session". The modal closes client-side, but the server sends back `session:error` (no `session:created`). No overlay opens. A toast error message appears. User must re-open the modal and provide a name.

---

## Section 5: Risks & False-PASS Risks

### Risks

1. **Race: overlay opens before session is truly ready.** The session object in `session:created` may have `status: 'starting'`. The overlay opens, `TerminalPane` subscribes, and output starts streaming. This is correct behavior — the overlay is designed to handle `starting` state (status dot shows warning color). No risk here.

2. **`attachSession` import not available in `handleSessionCreated` scope.** Both functions are in `actions.js` — `attachSession` is already defined in the same file. No import issue.

3. **`upsertSession` called before `attachSession`.** If signals are computed synchronously (Preact signals are), the session must be in the `sessions` array before `attachedSessionId` is set — otherwise `attachedSession` computed would return null. The implementation calls `upsertSession` first, then `attachSession`. Correct order.

### False-PASS Risks

1. **Test asserts `#session-overlay` visible but it was already visible from a previous test** — test must start with a clean state and verify overlay is NOT visible before the create action.

2. **Test clicks the session card instead of verifying auto-open** — test must explicitly NOT click any session card, only click "Start Session" and then check for overlay.

3. **Test passes because WS mock auto-opens overlay** — must test against a real server, not a mocked WS.

4. **`session:created` fires but session is not in `sessions` array yet** — computed `attachedSession` returns null, overlay doesn't render. `upsertSession` must be called before `attachSession`. Test should verify overlay title matches the new session.

5. **Overlay visible check passes because `display:flex` is set but the element is off-screen** — use `isVisible()` in Playwright (which checks bounding box and CSS visibility), not just `isInDOM()`.
