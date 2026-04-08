# T-01: Double-click "Start Session" Creates Duplicate Sessions

**Source:** Story 3 (Create a Direct-Mode Session)
**Score:** L=4 S=5 D=4 (Total: 13)
**Test type:** Playwright browser test

---

## 1. Infrastructure Setup

### 1a. Temporary data directory

Create an isolated `DATA_DIR` so the test does not pollute or depend on any existing server state:

```
DATA_DIR = mktemp -d
```

### 1b. Start the server

Launch the server on port **3098** with the temporary data directory:

```
DATA_DIR=<tmpdir> PORT=3098 node server-with-crash-log.mjs
```

Wait for the server to respond to `GET http://localhost:3098/api/projects` with a 200 before proceeding. Poll up to 10 seconds, 500ms intervals. If the server does not come up, fail immediately.

### 1c. Create a test project via REST API

Before opening the browser, create a project that sessions will belong to:

```
POST http://localhost:3098/api/projects
Content-Type: application/json
{ "name": "T01-TestProject", "path": "/tmp" }
```

Capture the returned `project.id`. This is the `projectId` used for all session creation in the test.

### 1d. Launch Playwright browser

Open a Chromium page navigated to `http://localhost:3098`. Wait for the WebSocket connection to establish. The signal for readiness is the project appearing in the sidebar. Wait for a DOM element containing the text "T01-TestProject" to become visible within the `#project-list` or sidebar area.

### 1e. Select the test project

Click on the project name "T01-TestProject" in the sidebar. Wait for `#sessions-area` to become visible. Verify the sessions area title contains "T01-TestProject".

---

## 2. Pre-test Assertions

Before executing the double-click scenario, verify:

1. **No sessions exist.** Query `GET http://localhost:3098/api/sessions` and assert the `managed` array is empty (or contains zero sessions for the test project).
2. **UI shows empty state.** Assert that `#project-sessions-list` contains the text "No sessions" (the `.sessions-empty` element).
3. **No session cards in DOM.** Assert `document.querySelectorAll('.session-card').length === 0`.
4. **"New Claude Session" button is visible.** The button with text "New Claude Session" (class `btn btn-primary btn-sm` inside `#sessions-area .area-header`) must be present and clickable.

---

## 3. Exact Action Sequence

### 3a. Open the New Session modal

Click the "New Claude Session" button inside `#sessions-area .area-header`. Wait for the modal overlay to appear (selector: `.modal-overlay`). Verify the modal header contains the text "New Session".

### 3b. Fill in the session name

Locate the session name input: the `<input>` with `placeholder="e.g. refactor, auth, bugfix"` inside the modal (`.modal .form-input` first instance). Type `test-double` into this field.

### 3c. Override the command

Locate the command input: the `<input>` with `placeholder="claude"` (the second `.form-input` in the modal, or more precisely the one with `font-family:var(--font-mono)`). Clear it and type `echo hello` so the session starts instantly without waiting for Claude TUI.

### 3d. Execute the double-click

This is the critical action. The goal is to simulate two rapid clicks on the "Start Session" button within 200ms.

**Selector for the button:** The "Start Session" button is in `.modal-footer` with class `btn btn-primary` and text content "Start Session".

**Playwright approach to achieve sub-200ms double-click:**

Use `page.evaluate()` to programmatically fire two click events in rapid succession. This is necessary because Playwright's `page.click()` is asynchronous and introduces inter-click latency that exceeds 200ms.

```
// Pseudocode for the evaluate block:
const btn = document.querySelector('.modal-footer .btn-primary');
btn.click();
btn.click();
```

Alternatively, use `page.dispatchEvent()` twice in sequence:

```
const btn = page.locator('.modal-footer .btn-primary');
await btn.dispatchEvent('click');
await btn.dispatchEvent('click');
```

The key insight from reading the source: `handleCreate()` in `NewSessionModal.js` calls `createSession()` which calls `send()` on the WebSocket, and then immediately calls `closeNewSessionModal()`. The modal closes after the first click. Therefore, the second `click` event fires on a button that is about to be removed from the DOM (the modal is hidden by setting `newSessionModalOpen.value = false`). The race condition window is:

- First click: `createSession()` sends WS message, `closeNewSessionModal()` sets signal to false
- Preact renders asynchronously (microtask), so the modal may still be in the DOM for the second click
- Second click: if the button is still in the DOM, `handleCreate()` fires again, sending a second `session:create` WS message

**Important:** `page.evaluate()` with two synchronous `.click()` calls is the most reliable way to ensure both clicks happen within the same event loop tick, before Preact can re-render and remove the modal.

### 3e. Wait for settlement

After the double-click, wait 5 seconds. This gives the server time to:
- Process both WS messages
- Spawn PTY processes
- Broadcast `sessions:list` updates
- Complete state transitions to RUNNING

---

## 4. Server-side Verification Steps

### 4a. Count sessions via API

```
GET http://localhost:3098/api/sessions
```

Parse the response. Count sessions in `managed` (or the root array) where `name === "test-double"` AND `projectId === <test-project-id>`.

**Expected:** Exactly 1 session with name "test-double".

**Fail:** 2 or more sessions with name "test-double", OR 2 or more sessions total for the project (since no other sessions were created).

### 4b. Count total sessions for the project

From the same API response, filter all sessions where `projectId === <test-project-id>`. Assert count equals 1.

### 4c. Verify session state

The single session should have `state` or `status` equal to `"running"` or `"stopped"` (since `echo hello` exits immediately, it may have already stopped). It must NOT be `"starting"` (which would indicate a ghost session) or `"error"`.

### 4d. Verify no orphaned PTY processes

Run a server-side check (or use the API) to confirm there is only one session entry. If the test has shell access, check:

```
ps aux | grep 'echo hello' | grep -v grep
```

There should be zero or one matching processes (zero if `echo hello` already completed).

---

## 5. UI Verification Steps

### 5a. Count session cards in DOM

```
document.querySelectorAll('.session-card').length
```

**Expected:** Exactly 1.

### 5b. Verify session card name

The single `.session-card` should contain a `.session-card-name` element with text "test-double".

### 5c. Check for ghost spinner

Inspect the badge inside the session card. The badge text is generated by `getBadgeLabel()` in `SessionCard.js`. Acceptable values: "running" or "stopped". If the badge shows "starting" and remains "starting" for more than 10 seconds, that is a ghost spinner (fail condition).

### 5d. No duplicate session cards

Assert there is no second `.session-card` element anywhere in `#project-sessions-list`.

---

## 6. Repeat Protocol

Race conditions are non-deterministic. A single pass proves nothing.

### 6a. Run the double-click scenario 5 times

After each iteration:
- Delete all sessions for the project via API: `DELETE http://localhost:3098/api/sessions/<id>` for each session, OR use the session delete WS message.
- Wait 2 seconds for cleanup.
- Verify sessions list is empty via API before the next iteration.
- Re-open the modal and repeat from step 3a.

### 6b. Scoring

- **5/5 pass:** Test passes. The system properly prevents duplicates.
- **4/5 pass:** FLAKY. Report as a warning. The system has a race window that occasionally allows duplicates.
- **3/5 or fewer pass:** Test fails. The system has a duplicate creation bug.

### 6c. Iteration tracking

Log the result of each iteration:
```
Iteration 1: API session count = 1, DOM card count = 1 -> PASS
Iteration 2: API session count = 2, DOM card count = 2 -> FAIL (duplicate)
...
```

---

## 7. Pass/Fail Criteria

### PASS (all must hold for every iteration):

1. `GET /api/sessions` returns exactly 1 session with `name === "test-double"` per iteration.
2. DOM contains exactly 1 `.session-card` element per iteration.
3. No session card badge is stuck on "starting" for more than 10 seconds.
4. All 5 iterations produce count = 1.

### FAIL (any one is sufficient):

1. Any iteration produces 2+ sessions with name "test-double" in the API response.
2. Any iteration produces 2+ `.session-card` elements in the DOM.
3. A session card shows "starting" badge for more than 10 seconds (ghost spinner).
4. The server responds with an error on the second `session:create` but the first session is also not created (both fail).
5. 2 or more iterations out of 5 produce duplicates (flaky fail).

---

## 8. Screenshots

Take screenshots at the following moments, saved to `qa-screenshots/T-01-double-click/`:

| Filename | When | Purpose |
|----------|------|---------|
| `iter-N-00-pre-modal.png` | Before opening modal each iteration | Baseline: no session cards |
| `iter-N-01-modal-filled.png` | After typing session name + command | Verify form state |
| `iter-N-02-after-double-click.png` | 1 second after double-click | Capture immediate UI state |
| `iter-N-03-settled.png` | 5 seconds after double-click | Capture final UI state |
| `iter-N-04-FAIL.png` | Only on failure | Capture evidence of duplicate |

Also capture the API response JSON for each iteration as `iter-N-api-response.json` for forensic analysis.

---

## 9. Cleanup Steps

After all iterations complete (pass or fail):

1. **Delete all sessions** created during the test via `DELETE` API calls.
2. **Delete the test project** via `DELETE http://localhost:3098/api/projects/<projectId>`.
3. **Kill the server process** spawned in step 1b. Use the PID captured at spawn time. Send SIGTERM, wait 3 seconds, then SIGKILL if still alive.
4. **Remove the temporary data directory** (`rm -rf $DATA_DIR`).
5. **Close the Playwright browser.**

All cleanup must happen in an `afterAll` block (or equivalent) that runs even if the test throws.

---

## 10. Known Risks and Design Decisions

### Risk 1: The modal closes before the second click lands

**Problem:** `handleCreate()` calls `closeNewSessionModal()` synchronously. If Preact processes the signal update and removes the modal DOM before the second click event is dispatched, the second click never fires, and the test always passes -- but it has not actually tested the race condition.

**Mitigation:** Use `page.evaluate()` with two synchronous `.click()` calls in the same microtask. Since Preact batches signal updates and re-renders asynchronously (via microtask queue), both clicks will fire before the DOM updates. Verify this by logging (via `page.on('console')`) whether `handleCreate` was called once or twice. If it was only called once across all 5 iterations, the test is not exercising the race condition and the result is INCONCLUSIVE, not PASS.

### Risk 2: The WS `send()` silently drops the second message

**Problem:** If the WebSocket `send()` call for the second `session:create` fails silently (e.g., socket buffer full), only one session is created. This is a false PASS -- the system is not deduplicating, it is just getting lucky.

**Mitigation:** Add a WS message counter. Before the double-click, inject a listener via `page.evaluate()` that intercepts outgoing WS messages and counts how many `session:create` messages are sent. After the double-click, read this counter. If counter === 1, the test is INCONCLUSIVE (second click did not fire or was dropped). If counter === 2 and only 1 session exists, that is a genuine PASS.

### Risk 3: Server processes creates sequentially, so the race window is 0

**Problem:** If the server processes WS messages strictly sequentially (Node.js event loop processes one message at a time), and `session:create` is fully `await`ed before the next message is dequeued, there is no concurrency. However, two creates with the same name but different UUIDs would both succeed (the server does not deduplicate by name -- it uses `uuidv4()` for the ID).

**Reality check from source code:** Looking at `SessionManager.create()`, there is NO name-based deduplication. Each call generates a fresh `uuidv4()`. Two rapid `session:create` messages with the same name WILL create two sessions with different IDs but the same name. The server does not guard against this. The only protection is client-side: the modal closing prevents a second click.

**Implication:** This test is actually checking whether the client-side modal dismissal is fast enough to prevent the second click. If `page.evaluate()` with synchronous double-click bypasses the modal close, the test SHOULD FAIL, revealing that the server lacks deduplication. This is the expected finding for this test.

### Risk 4: `echo hello` exits too fast, conflating session count

**Problem:** If `echo hello` exits instantly and the session transitions to STOPPED, the server might clean up the session record before the API check.

**Mitigation:** The `SessionManager` persists sessions even after they stop (they remain in `sessions.json` with status STOPPED). Verify this assumption in the pre-test phase by creating and stopping a session, then checking the API. If stopped sessions are not returned, use `bash -c "sleep 30"` as the command instead.

### Risk 5: `sessions:list` broadcast overwrites the duplicate

**Problem:** After the first `session:create` completes, the server broadcasts `sessions:list` to all clients. If the second `session:create` is still in-flight, the UI might momentarily show two cards, but the next `sessions:list` broadcast might only contain one (if timing is unusual). This would be a UI-level false PASS.

**Mitigation:** Always verify via `GET /api/sessions` (server-side truth), not just DOM state. The API reads from the in-memory `sessions` Map, which is the authoritative source.

### Design Decision: Why `echo hello` and not `bash`

Using `echo hello` means the session starts and exits nearly instantly. This is preferable because: (a) it avoids leaving orphaned bash processes if cleanup fails, (b) it tests the full lifecycle (start -> run -> exit) in each iteration, reducing test wall-clock time. If session persistence of stopped sessions is confirmed in pre-test, this is safe. If not, fall back to `bash -c "sleep 30"` and explicitly stop sessions before deletion.

### Design Decision: Why 5 iterations, not 20

The F-lifecycle lessons say "run at least 5 times." Five is the minimum for a race condition test with a binary outcome. If 0/5 fail, we have ~95% confidence the race window is protected (assuming a 50% hit rate if the bug exists). For a subtler bug with a 10% hit rate, 5 iterations gives only ~41% detection probability. If the test passes 5/5 but the WS message counter shows that 2 messages were sent in at least 3 iterations, consider increasing to 20 iterations.

---

## Execution Summary

**Final result: FAIL**

**Number of attempts needed:** 3 (2 infrastructure debugging + 1 successful full run)

### Deviations from the design

1. **Session deletion method:** The design says `DELETE http://localhost:3098/api/sessions/<id>` but the server has NO REST `DELETE /api/sessions/:id` endpoint. Session deletion is WS-only (`session:delete` message). The test was fixed to use `deleteSessionViaWS()` which sends the WS `session:delete` message.

2. **`playwright.config.js` testMatch:** The existing `playwright.config.js` only matched specific test files. Added `T-01-double-click.test.js` to `testMatch` to allow it to run.

3. **SIGTERM in crash log:** The crash log showed `SIGTERM received` entries, but these were from our own `afterAll` cleanup sending `SIGKILL` to the server process — not a real crash. Added a filter to suppress expected shutdown messages from the crash log output.

### Bugs discovered

**BUG CONFIRMED: Server creates duplicate sessions on rapid double-click**

- Severity: HIGH (Score L=4 S=5 D=4, Total=13)
- Reproducibility: 5/5 (100% — completely deterministic, not just a race)
- Root cause: `SessionManager.create()` has NO name-based deduplication. Each `session:create` WS message generates a new `uuidv4()` ID. Two rapid messages with the same name create two sessions with different IDs but identical names.
- Client-side protection: `NewSessionModal.js` calls `closeNewSessionModal()` synchronously after `createSession()`, but Preact defers DOM updates to the microtask queue. `page.evaluate()` with two synchronous `.click()` calls fires both before Preact can re-render — bypassing the intended protection.
- Evidence: All 5 iterations showed `ws_sends=2`, `API count=2`, `DOM count=2`. Both sessions had state=`stopped` (not `error`) — they were fully created and ran successfully.
- Fix required: Server-side deduplication in `SessionManager.create()` (e.g., reject if a session with the same name AND projectId was created within the last 500ms), OR client-side debounce on the "Start Session" button to prevent double-fire before modal close.

**Infrastructure bug discovered:** No REST `DELETE /api/sessions/:id` endpoint exists. The design doc assumed this endpoint; tests and documentation should use the WS protocol for session deletion.
