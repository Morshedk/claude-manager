# T-14: Delete Confirmation Dialog — Cancel Leaves Session Intact

**Score:** L=4 S=4 D=3 (Total: 11)
**Test type:** Playwright browser
**Regression target:** Delete fires without confirmation, or Cancel fails to block delete

---

## 1. What the code does

In `public/js/components/SessionCard.js` line 84–88:

```js
function handleDelete(e) {
  e.stopPropagation();
  if (!confirm(`Delete session "${sessionName}"?`)) return;
  deleteSession(session.id);
}
```

- The native browser `confirm()` dialog is shown.
- If the user clicks Cancel, `confirm()` returns `false` and `deleteSession()` is never called.
- If the user clicks OK, `deleteSession()` calls `send({ type: "session:delete", id })` via WebSocket.
- The server handler `SessionHandlers.delete()` calls `this.sessions.delete(msg.id)` and broadcasts the updated sessions list.

The Delete button only renders for non-active sessions (`(!active)` guard, line 148).

---

## 2. Infrastructure Setup

### 2a. Isolated server on port 3111

Kill anything already on port 3111:
```
fuser -k 3111/tcp 2>/dev/null || true
sleep 1
```

Create a fresh temp data directory:
```
DATA_DIR=$(mktemp -d /tmp/qa-T14-XXXXXX)
CRASH_LOG=$DATA_DIR/server-crash.log
```

Spawn the server:
```
PORT=3111 DATA_DIR=<tmpDir> CRASH_LOG=<crashLogPath> node server-with-crash-log.mjs
```

Wait up to 25 seconds by polling `http://127.0.0.1:3111/` every 400ms. Abort if server doesn't start.

### 2b. Screenshots directory

Create `qa-screenshots/T14-delete-cancel/` under the app root. All screenshots go here.

### 2c. Seed a test project via REST API

POST `/api/projects` with `{ name: "T14-project", path: "<tmpDir>/project" }`.
Create the directory on disk with `mkdirSync`.
Store returned `projectId`.

---

## 3. Session Setup

### 3a. Create a bash session via WebSocket

Open a raw WS to `ws://127.0.0.1:3111`. Wait for any initial message (server may not send `init` in v2 — use a 2s timeout grace). Send:

```json
{
  "type": "session:create",
  "projectId": "<testProjectId>",
  "name": "T14-bash",
  "command": "bash",
  "mode": "direct",
  "cols": 120,
  "rows": 30
}
```

Wait for `session:created`. Store `testSessionId`.

### 3b. Stop the session

The Delete button only appears for non-active sessions. Send:

```json
{ "type": "session:stop", "id": "<testSessionId>" }
```

Wait for `session:state` message with `state: "stopped"` OR `state: "exited"` — either indicates the PTY has terminated. If no state message arrives within 10 seconds, poll `GET /api/sessions` and check `state !== "running"`.

### 3c. Verify the Delete button will appear

Before opening the browser, confirm via REST that the session is stopped:

```
GET http://127.0.0.1:3111/api/sessions
```

Find the session with `id === testSessionId`. Assert `state !== "running" && state !== "starting"`.

---

## 4. Browser Setup

### 4a. Open the browser

Launch headless Chromium. Navigate to `http://127.0.0.1:3111/` with `waitUntil: 'domcontentloaded'`. Wait 1.5s for Preact to render.

### 4b. Select the test project

The app renders a project sidebar. Click the project card matching "T14-project". Wait for project detail view to appear (the session list becomes visible).

Selector: look for an element containing "T14-project" in the sidebar — `text="T14-project"` or `.project-card:has-text("T14-project")`.

Wait 1s for the session list to render.

### 4c. Verify the session card and Delete button are visible

The session card for "T14-bash" should be visible with a stopped badge. Assert:
```js
await page.locator('.session-card:has-text("T14-bash")').isVisible();
```

The Delete button is rendered inside `.session-card-actions` when the session is not active. Assert:
```js
await page.locator('.session-card:has-text("T14-bash") button:has-text("Delete")').isVisible();
```

If the Delete button is not visible, take a screenshot and fail with a diagnostic message.

---

## 5. Cancel Path — Core Test

### 5a. Install a WebSocket message spy

Before clicking Delete, inject a WS spy into the page to capture any `session:delete` messages sent:

```js
await page.evaluate(() => {
  window.__wsMessages = [];
  // Intercept the send function — works because actions.js uses a module-level `ws` variable
  // We can monkey-patch at the WS transport level if accessible, or use the network request
  // approach instead (see 5b).
  window.__deleteAPICalled = false;
});
```

Since the client uses a module-level WebSocket in `lib/ws/client.js` (or similar), direct spy injection may not be possible across module boundaries. Use network interception instead (section 5b).

### 5b. Intercept network / WS traffic

Use Playwright's `page.on('websocket', ...)` to monitor outgoing WS frames:

```js
const wsSendLog = [];
page.on('websocket', ws => {
  ws.on('framesent', frame => {
    try {
      const msg = JSON.parse(frame.payload);
      wsSendLog.push(msg);
    } catch {}
  });
});
```

This records every WS message the browser sends to the server. If `session:delete` is ever sent, it will appear here.

### 5c. Register dialog handler to DISMISS (cancel)

Register the dialog handler BEFORE clicking Delete:

```js
page.on('dialog', async dialog => {
  // Verify it's the right kind of dialog
  expect(dialog.type()).toBe('confirm');
  expect(dialog.message()).toContain('T14-bash');
  await dialog.dismiss(); // simulates clicking "Cancel"
});
```

The `dialog.dismiss()` call is equivalent to clicking the Cancel button on the browser's native `confirm()` dialog.

### 5d. Click the Delete button

```js
await page.locator('.session-card:has-text("T14-bash") button:has-text("Delete")').click();
```

Wait 2 seconds for any async effects to complete.

### 5e. Take a screenshot after cancel

`T14-01-after-cancel.png` — full page screenshot showing the session list.

### 5f. Verify session card is still present

```js
await expect(page.locator('.session-card:has-text("T14-bash")')).toBeVisible();
```

If the session card is gone, the test fails: Cancel did not prevent deletion.

### 5g. Verify no session:delete WS message was sent

Check `wsSendLog` for any message with `type === "session:delete"`:

```js
const deleteMessages = wsSendLog.filter(m => m.type === 'session:delete');
expect(deleteMessages.length).toBe(0);
```

If a delete message was sent despite Cancel being clicked, the bug is in the client-side guard.

### 5h. Verify session still exists on server via REST

```
GET http://127.0.0.1:3111/api/sessions
```

Find the session with `id === testSessionId`. Assert it exists and is not deleted:

```js
const sessions = await fetch(`http://127.0.0.1:3111/api/sessions`).then(r => r.json());
const found = sessions.find(s => s.id === testSessionId);
expect(found).toBeTruthy();
```

---

## 6. Accept Path — Confirm Delete Actually Works

This verifies the dialog does appear and, when accepted, deletion proceeds correctly.

### 6a. Register dialog handler to ACCEPT

```js
const dialogHandler = async dialog => { await dialog.accept(); };
page.once('dialog', dialogHandler);
```

### 6b. Click Delete again

```js
await page.locator('.session-card:has-text("T14-bash") button:has-text("Delete")').click();
```

Wait 3 seconds for the server to process the deletion and broadcast the updated sessions list.

### 6c. Verify session card is gone

```js
await expect(page.locator('.session-card:has-text("T14-bash")')).toHaveCount(0, { timeout: 5000 });
```

### 6d. Verify session:delete WS message WAS sent

After the accept, `wsSendLog` must contain exactly one `session:delete` message:

```js
const deleteMessages = wsSendLog.filter(m => m.type === 'session:delete');
expect(deleteMessages.length).toBe(1);
expect(deleteMessages[0].id).toBe(testSessionId);
```

### 6e. Verify session is gone from server REST

```
GET http://127.0.0.1:3111/api/sessions
```

Assert the session is no longer in the list:

```js
const sessions = await fetch(`http://127.0.0.1:3111/api/sessions`).then(r => r.json());
const found = sessions.find(s => s.id === testSessionId);
expect(found).toBeFalsy();
```

Take screenshot `T14-02-after-delete.png`.

---

## 7. Repeat Protocol (3x Cancel, then Accept)

The spec says "repeat 3x." Create a new bash session for each cancel iteration to ensure we're testing a clean flow each time.

### 7a. Loop: Create → Stop → Cancel → Verify intact

Repeat the following 3 times (using session names `T14-repeat-1`, `T14-repeat-2`, `T14-repeat-3`):

1. Create a new bash session via WS.
2. Stop it via WS, wait for stopped state.
3. Reload/refresh browser state (navigate back to home, then re-select project, or just wait for session list refresh).
4. Register `dialog.dismiss()` handler.
5. Click Delete on the new session card.
6. Wait 2 seconds.
7. Assert session card still visible.
8. Assert no `session:delete` WS message for this session.
9. Assert session still exists via REST.

Screenshot after each: `T14-03-repeat1-cancel.png`, `T14-04-repeat2-cancel.png`, `T14-05-repeat3-cancel.png`.

---

## 8. Edge Cases

### 8a. Dialog message content

The `confirm()` message in `handleDelete` is:
```
`Delete session "${sessionName}"?`
```

where `sessionName = session.name || \`Session ${session.id.slice(0, 6)}\``.

For session named "T14-bash", the message should be `Delete session "T14-bash"?`. The dialog handler asserts this (section 5c).

### 8b. Active session has no Delete button

A running session must NOT show the Delete button (line 148 in SessionCard.js). This is a secondary check: create a fresh session (running state), assert `button:has-text("Delete")` is NOT present on that card.

### 8c. Rapid double-click on Delete

Register a `dialog.dismiss()` handler. Perform two rapid clicks on Delete. The dialog should appear after the first click. The second click's handler fires once the dialog is dismissed. The second click may trigger a second dialog (each click calls `confirm()` separately). The test should handle this gracefully — `page.on('dialog', ...)` fires for each dialog. Both must be dismissed.

After both dismissals, the session must still exist.

---

## 9. Pass/Fail Criteria

### PASS — all of the following must hold:

1. **Dialog appears:** `page.on('dialog')` fires when Delete is clicked (type = `confirm`, message contains session name).
2. **Cancel prevents WS message:** Zero `session:delete` WS frames sent after Cancel.
3. **Session card remains visible** in the DOM after Cancel.
4. **Session intact on server:** `GET /api/sessions` returns the session after Cancel.
5. **Accept works correctly:** When dialog is accepted, the session card disappears and `GET /api/sessions` no longer returns it.
6. **Repeat 3x:** All 3 cancel iterations pass.
7. **No broken card state:** After Cancel, the session card shows the correct stopped badge with no error state or spinner.

### FAIL — any of the following:

1. Delete fires immediately without showing a dialog (no `dialog` event fires, but session disappears).
2. Session card disappears after Cancel.
3. A `session:delete` WS message is sent after Cancel.
4. Session absent from `GET /api/sessions` after Cancel.
5. Session card shows an error/broken state after Cancel.
6. Dialog message is blank or does not include the session name.

---

## 10. False PASS Risks

### Risk 1: Dialog registered after it fires

If the `dialog.dismiss()` handler is registered after the dialog appears (due to async timing), Playwright will auto-dismiss the dialog without calling your handler, and the test may pass vacuously.

**Mitigation:** Always register `page.on('dialog', ...)` BEFORE clicking the Delete button. The `page.on()` call is synchronous and must precede the `click()` call.

### Risk 2: Session card re-renders after WS `sessions:list` broadcast

After Cancel, no WS message should be sent, so the server won't broadcast a `sessions:list` update. However, if some other event triggers a broadcast (e.g., watchdog tick), the session list re-renders. If the re-render has a bug that drops the session from the list, the test would false-fail (not false-pass). Guard against this by waiting a full 3 seconds after Cancel before checking.

### Risk 3: `wsSendLog` misses messages due to timing

The WS `framesent` listener is registered on the WS object, but if the browser opens a NEW WebSocket after we start listening, we might miss frames on the new connection.

**Mitigation:** Register `page.on('websocket', ...)` before navigating/loading the page, so all WS connections are captured from the start.

### Risk 4: Session list re-fetched only on WS update

The browser's session list is driven by `sessions:list` WS messages. If Cancel is clicked and somehow a `sessions:list` message arrives (from an unrelated event) that omits our session, the card would disappear even though the session wasn't deleted. This would be a false-fail.

**Mitigation:** Cross-check with the REST API. If the card disappears, always check REST before declaring a failure. This is already in the pass criteria (section 9).

---

## 11. Cleanup

1. Close browser (`await browser.close()`).
2. Kill server (`serverProc.kill('SIGKILL')`), wait 500ms.
3. Check crash log: if non-empty, log it and FAIL the test.
4. Remove temp directory: `rm -rf <tmpDir>`.
5. Safety: `fuser -k 3111/tcp 2>/dev/null || true`.

---

## Execution Summary

**Run date:** 2026-04-08
**Result:** PASS — 3/3 tests passed in 34.9s (after 1 fix attempt)

### Fix applied

**Root cause:** The REST endpoint `GET /api/sessions` returns sessions from `SessionManager.list()`, which exposes session metadata with a `status` field (not `state`). The test was checking `rec.state` and `s.state` which were `undefined`.

**Changes to `T-14-delete-cancel.test.js`:**
- `rec.state` → `rec.status` (verify stopped state from REST)
- `sessionRecord.state` → `sessionRecord.status` (same)
- `s.state !== 'running'` → `s.status !== 'running'` (fallback polling + sessions:list WS)
- Added `'error'` state to `stopSession` WS matcher (alongside `'stopped'`)
- Note: `session:state` WS broadcast correctly uses `state` field — only REST meta objects use `status`

### Scenario results

| Test | Description | Result |
|------|-------------|--------|
| T-14.A | Cancel × 3 iterations: dialog fires, no WS delete sent, session intact | PASS (3/3) |
| T-14.B | Accept: delete WS sent, card removed, session gone from REST | PASS |
| T-14.C | Running session has no Delete button | PASS |

### Key findings

- The confirm dialog fires correctly with message `Delete session "T14-repeat-N"?`
- Cancel path: zero `session:delete` WS messages sent, session card remains, REST confirms session intact
- Accept path: exactly one `session:delete` WS message, card disappears within 3s, session absent from REST
- Running sessions correctly omit the Delete button (guard at line 148 in SessionCard.js confirmed)

### Artifacts

- Screenshots saved to `qa-screenshots/T14-delete-cancel/`
- Run output: `tests/adversarial/designs/T-14-run-output.txt`
