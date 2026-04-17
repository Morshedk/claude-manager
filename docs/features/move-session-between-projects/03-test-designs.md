# Test Designs: Move Session Between Projects

## Setup (shared across all tests)

Each test spins up an isolated server instance:

```js
const DATA_DIR = `/tmp/test-move-session-${PORT}`;
// Seed projects.json:
// { "projects": [
//   { "id": "proj-a", "name": "Project Alpha", "path": "/tmp/project-a", "createdAt": "..." },
//   { "id": "proj-b", "name": "Project Beta", "path": "/tmp/project-b", "createdAt": "..." }
// ], "scratchpad": [] }
//
// Seed sessions.json (empty array []) — sessions are created per-test.
// Start server: PORT=<port> DATA_DIR=<dir> node server.js
```

WS URL: `ws://localhost:<port>` (bare, no `/ws` path).

REST API shapes:
- `GET /api/projects` returns array of project objects
- `GET /api/sessions` returns `{ managed: [...], detected: [...] }`

WS protocol:
- On connect, server sends `{ type: "init", clientId }` then `{ type: "sessions:list", sessions: [...] }`
- Client sends `{ type: "session:create", projectId, name, ... }` and receives `{ type: "session:created", session }`
- Client sends `{ type: "session:update", id, name?, projectId? }` and receives `{ type: "session:updated", id, session }`
- After any mutation, server broadcasts `{ type: "sessions:list", sessions: [...] }` to ALL clients

---

### T-1: Move session to a different project (Story 1 -- correcting misplaced session)
**Flow:**
1. Start server on port 3400 with two seeded projects (proj-a, proj-b)
2. Connect WS client, wait for `init`
3. Create a session under proj-a: `{ type: "session:create", projectId: "proj-a", name: "misplaced", mode: "direct" }`
4. Wait for `session:created`, capture session ID
5. Send `{ type: "session:update", id: sessionId, projectId: "proj-b" }`
6. Wait for `session:updated` response
7. Verify `session:updated` payload has `projectId === "proj-b"`, `projectName === "Project Beta"`, `cwd === "/tmp/project-b"`
8. Wait for `sessions:list` broadcast
9. Find the session in the broadcast list; verify its `projectId === "proj-b"`
10. `GET /api/sessions` and verify the moved session has `projectId: "proj-b"` in the `managed` array
11. Read `DATA_DIR/sessions.json` from disk and verify `projectId`, `projectName`, `cwd` are all updated

**Pass condition:** All seven assertions pass: updated response fields correct, broadcast reflects move, REST reflects move, disk reflects move (projectId, projectName, cwd all changed).
**Fail signal:** `session:updated` still shows `projectId: "proj-a"`, or `sessions.json` on disk still has old `projectName`/`cwd`. On a pre-implementation codebase, the server returns `session:error` because `sessionHandlers.update` does not exist.
**Test type:** WS protocol
**Port:** 3400

---

### T-2: Rename session without moving (Story 3)
**Flow:**
1. Start server on port 3401 with one seeded project (proj-a only)
2. Connect WS client, wait for `init`
3. Create session under proj-a with name "vague"
4. Wait for `session:created`
5. Send `{ type: "session:update", id: sessionId, name: "auth refactor" }`
6. Wait for `session:updated`
7. Verify response has `name === "auth refactor"`, `projectId === "proj-a"` (unchanged)
8. Wait for `sessions:list` broadcast, verify name changed in the list
9. Send `{ type: "session:update", id: sessionId, name: "" }` (empty name)
10. Wait for `session:updated`, verify `name === null` (empty name becomes null)

**Pass condition:** Name updates correctly to "auth refactor", then to null on empty string. Project assignment unchanged.
**Fail signal:** Server errors on `session:update`, or name field is not updated, or projectId changes unexpectedly.
**Test type:** WS protocol
**Port:** 3401

---

### T-3: Multi-client synchronization (Story 5)
**Flow:**
1. Start server on port 3402 with two seeded projects
2. Connect WS client A, wait for `init`
3. Connect WS client B, wait for `init`
4. Client A creates a session under proj-a, both clients receive `sessions:list` broadcast
5. Client A sends `{ type: "session:update", id: sessionId, projectId: "proj-b" }`
6. Client A receives `session:updated` confirmation
7. Client B receives `sessions:list` broadcast (but NOT `session:updated` -- that goes only to requester)
8. Verify: In client B's received `sessions:list`, the session has `projectId === "proj-b"`
9. Verify: Client B did NOT receive a `session:updated` message (it is not the requester)

**Pass condition:** Client B sees the moved session via broadcast without requesting anything. Client B does not receive `session:updated`.
**Fail signal:** Client B's sessions list still shows the session under proj-a, OR client B receives `session:updated` (leaking the confirmation to non-requesters), OR no broadcast arrives at client B at all.
**Test type:** WS protocol (two concurrent WebSocket connections)
**Port:** 3402

---

### T-4: Move to non-existent project (adversarial)
**Flow:**
1. Start server on port 3403 with one seeded project (proj-a)
2. Connect WS client, wait for `init`
3. Create a session under proj-a
4. Send `{ type: "session:update", id: sessionId, projectId: "proj-nonexistent" }`
5. Wait for `session:error` response
6. Verify error message contains "Project not found"
7. Verify session is unchanged: `GET /api/sessions` shows session still under proj-a with original name/cwd
8. Send `{ type: "session:update", id: "session-nonexistent", name: "hacked" }`
9. Wait for `session:error` response
10. Verify error message contains "Session not found"

**Pass condition:** Both invalid updates produce `session:error` with descriptive messages. No data is corrupted. The session remains under proj-a.
**Fail signal:** Server crashes, returns `session:updated` with undefined fields, or silently succeeds. On pre-implementation codebase, the handler does not exist so the server logs a warning but sends no error to the client.
**Test type:** WS protocol
**Port:** 3403

---

### T-5: Browser UI -- Edit button opens modal, move session disappears from list (Story 1)
**Flow:**
1. Start server on port 3404 with two seeded projects and one session under proj-a
2. Launch Playwright browser, navigate to `http://localhost:3404`, waitUntil: `domcontentloaded`
3. Click on "Project Alpha" in the sidebar to select it
4. Wait for session card to appear
5. Verify there is NO button with text "Open" on the session card
6. Click the "Edit" button on the session card
7. Verify the Edit Session modal is visible with heading "Edit Session"
8. Verify the name input is pre-filled with the session's name
9. Verify the project dropdown has "Project Alpha" selected
10. Select "Project Beta" from the project dropdown
11. Click "Save"
12. Wait for modal to close (disappear from DOM)
13. Wait for toast "Session updated" to appear
14. Verify the session card is no longer visible under Project Alpha
15. Click "Project Beta" in the sidebar
16. Verify the session card appears under Project Beta

**Pass condition:** Edit button exists (no Open button), modal opens with correct pre-fill, save moves the session, session disappears from source project and appears in target project.
**Fail signal:** "Open" button still exists, modal does not open, session stays in Project Alpha after save, or session does not appear in Project Beta.
**Test type:** Playwright browser
**Port:** 3404

---

### T-6: Rapid double-submit and running session move (adversarial)
**Flow:**
1. Start server on port 3405 with two seeded projects
2. Connect WS client, wait for `init`
3. Create a session under proj-a (mode: "direct"), wait for `session:created`
4. Verify session status is "running" (direct sessions auto-start)
5. Send TWO `session:update` messages in rapid succession (no await between):
   - First: `{ type: "session:update", id: sessionId, projectId: "proj-b", name: "moved" }`
   - Second: `{ type: "session:update", id: sessionId, projectId: "proj-a", name: "moved-back" }`
6. Collect all received messages for 2 seconds
7. Verify: received exactly 2 `session:updated` messages and at least 2 `sessions:list` broadcasts
8. Verify: the final state (from last `sessions:list`) shows the session under proj-a with name "moved-back" (last writer wins)
9. Verify: the session status is still "running" (move did not kill the PTY)
10. Send `{ type: "session:input", id: sessionId, data: "echo hello\n" }` to confirm PTY is alive
11. Wait for `session:output` to confirm the session is still streaming

**Pass condition:** Both updates succeed without error. Final state is consistent (last writer wins). Running PTY is not interrupted by metadata update. Session still accepts input after move.
**Fail signal:** Server errors on one or both updates, session status changes to stopped/error, PTY stops streaming, or final state is inconsistent (e.g., projectId from first update but name from second).
**Test type:** WS protocol
**Port:** 3405
