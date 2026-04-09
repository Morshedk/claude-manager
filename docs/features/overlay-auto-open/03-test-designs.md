# Test Designs: Overlay Auto-Open After Session Create

**Designer:** Stage 3 Agent  
**Date:** 2026-04-08  
**Review verdict:** FAITHFUL — tests proceed.

---

## T-1: Overlay opens automatically after Start Session — no card click

**Flow:**
1. Start isolated server on port 3230 with seeded project `{ id: "proj-1", name: "AutoTest", path: "/tmp" }`
2. Navigate to `http://127.0.0.1:3230` with `waitUntil: 'domcontentloaded'`
3. Wait for WS init (wait for project "AutoTest" to appear in sidebar, timeout 10s)
4. Click sidebar item "AutoTest" to select project
5. Assert `#session-overlay` is NOT visible (pre-condition gate)
6. Click "New Claude Session" button
7. Wait for modal to appear
8. Fill the session name input (placeholder "e.g. refactor, auth, bugfix") with "auto-open-test"
9. Click "Start Session"
10. Do NOT click any session card
11. Wait for `#session-overlay` to become visible (timeout 15s)
12. Assert `#overlay-title` text contains "auto-open-test"

**Pass condition:**
- `#session-overlay` is visible without any session card click
- `#overlay-title` contains "auto-open-test"
- Pre-condition: overlay was NOT visible before the create action

**Fail signal:**
- Timeout waiting for `#session-overlay` — overlay never appeared
- Overlay appeared but `#overlay-title` is wrong (showing a different session)
- Pre-condition fails (overlay was already visible before action) — vacuous pass caught

**Test type:** Playwright browser  
**Port:** 3230

---

## T-2: Overlay shows correct session (not a different session's terminal)

**Flow:**
1. Start isolated server on port 3231 with seeded project `{ id: "proj-1", name: "CorrectSession", path: "/tmp" }`
2. Navigate to app, select "CorrectSession" project
3. Create first session named "session-alpha" via modal — wait for overlay to open
4. Record overlay title (should be "session-alpha")
5. Close overlay via ✕ button (id: `btn-detach`)
6. Wait for overlay to disappear
7. Create second session named "session-beta" via modal — wait for overlay to open
8. Assert `#overlay-title` text contains "session-beta" (not "session-alpha")
9. Assert the WS is subscribed to "session-beta"'s session ID (check via REST `/api/sessions` that beta's ID differs from alpha's, and overlay shows beta)

**Pass condition:**
- First overlay shows "session-alpha"
- Second overlay shows "session-beta", not "session-alpha"
- The session IDs are distinct

**Fail signal:**
- Second overlay still shows "session-alpha" (attachedSessionId stuck on first)
- Overlay shows neither name (attachedSession computed returned null)
- Title is ambiguous (session name not in title at all)

**Test type:** Playwright browser  
**Port:** 3231

---

## T-3: Browser reload does NOT re-open overlay automatically

**Flow:**
1. Start isolated server on port 3232 with seeded project
2. Navigate to app, select project, create session named "reload-test"
3. Wait for overlay to auto-open — confirm `#session-overlay` visible
4. Reload the page (`page.reload({ waitUntil: 'domcontentloaded' })`)
5. Wait 3 seconds for WS reconnect and data load
6. Assert `#session-overlay` is NOT visible after reload

**Pass condition:**
- Overlay is visible after create (confirming auto-open worked)
- After reload, overlay is NOT visible (signal resets to null on fresh page load)

**Fail signal:**
- Overlay persists after reload (would indicate `attachedSessionId` is stored in localStorage or some persistent state — which it should NOT be)
- Overlay is not visible even before reload (pre-condition fails — auto-open didn't work)

**Test type:** Playwright browser  
**Port:** 3232

---

## T-4: Adversarial — creating two sessions rapidly, overlay shows last-created

**Flow:**
1. Start isolated server on port 3233 with seeded project
2. Navigate to app, select project
3. Open modal, fill name "rapid-first", click "Start Session" — do NOT wait for overlay
4. Immediately open modal again (click "New Claude Session"), fill name "rapid-second", click "Start Session"
5. Wait 10 seconds total for both `session:created` messages to arrive
6. Assert `#session-overlay` is visible
7. Assert `#overlay-title` text contains "rapid-second" (the last created)
8. Verify via REST `/api/sessions` that both sessions were created (managed array length ≥ 2)

**Pass condition:**
- Both sessions exist on server
- Overlay shows "rapid-second" (the last-created session's name)
- Overlay does not flicker between both sessions in a broken state

**Fail signal:**
- Overlay shows "rapid-first" (first create won, second create's auto-open didn't override)
- Only one session was created (server dedup kicked in — names are different so dedup shouldn't apply)
- Overlay is not visible at all (both auto-opens cancelled each other)

**Note on server dedup:** The dedup key is `clientId:projectId:name`. Since the names differ ("rapid-first" vs "rapid-second"), both creates will succeed. The client may close the modal before the first session:created arrives, so the second create happens before the first response. Both session:created messages fire, second one sets attachedSessionId last. This is the expected behavior.

**Test type:** Playwright browser  
**Port:** 3233

---

## Test Infrastructure Notes

- Server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT`, `CRASH_LOG` env vars
- Data dir: `mktemp -d /tmp/qa-feat-overlay-XXXXXX`
- ProjectStore seed format: `{ "projects": [...], "scratchpad": [] }` — NOT a bare array
- `waitUntil: 'domcontentloaded'`
- WS URL: bare `ws://host:port`
- Sessions REST: `GET /api/sessions` returns `{ managed, detected }`
- Button label: "New Claude Session"
- Session name input: placeholder "e.g. refactor, auth, bugfix"
- Overlay element: `#session-overlay`
- Overlay title: `#overlay-title`
- Close button: `#btn-detach`
- Session name is REQUIRED by server — always fill name input before clicking Start Session
- Pre-create, assert overlay NOT visible (prevents vacuous pass)
