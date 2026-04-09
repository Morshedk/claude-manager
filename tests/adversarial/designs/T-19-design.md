# T-19: Session card lastLine updates while overlay is open

**Source:** LIFECYCLE_TESTS.md — T-19
**Score:** L=4 S=2 D=4 (Total: 10)
**Test type:** Playwright browser test
**Port:** 3116

---

## 1. Architecture Analysis

### How lastLine is supposed to work

`SessionCard.js` (line 157–159) renders:
```js
${session.lastLine ? html`
  <div class="session-lastline">${session.lastLine}</div>
` : null}
```

`session.lastLine` comes from the `sessions` signal in `store.js`. The signal is updated via:
- `handleSessionsList(msg)` in `actions.js` — replaces `sessions.value` wholesale with the array from `sessions:list` broadcast
- `upsertSession(session)` — merges a partial session object into the array (used by `handleSessionState`, `handleSessionCreated`, `session:refreshed`)

### How lastLine gets onto session.meta (server side)

**Critical finding:** There is NO code in `DirectSession.js`, `SessionManager.js`, or `sessionHandlers.js` that:
1. Reads PTY output chunks
2. Strips ANSI codes
3. Extracts the last non-empty line
4. Updates `session.meta.lastLine`

The `sessions:list` broadcast in `sessionHandlers.js._broadcastSessionsList()` calls `this.sessions.list()` which returns `{ ...s.meta }` for each session. If `meta.lastLine` is never set server-side, `lastLine` will be `undefined` in every `sessions:list` broadcast.

**This means T-19 is testing a feature that may not be implemented.** The expected behavior (lastLine updates while overlay is open) requires:
1. Server-side: PTY output → strip ANSI → extract last line → store in `meta.lastLine` → broadcast `sessions:list`
2. Client-side: receive `sessions:list` → `upsertSession` → Preact re-renders `SessionCard`

The client-side wiring is present (the `sessions:list` handler and `upsertSession` are correct). The missing piece is the server-side `lastLine` computation.

### Session output pipeline while overlay is open

When the overlay is open, `TerminalPane` is mounted. In `TerminalPane.js`:
- `session:output` messages are handled locally — they call `xterm.write(msg.data)` only
- There is no handler that extracts `lastLine` from output and updates session state

The `sessions:list` broadcast only fires on lifecycle mutations (create, stop, refresh, delete) — NOT on every PTY output chunk.

### ANSI stripping

The server has `stripAnsi()` in `lib/todos/TodoManager.js` and `lib/watchdog/WatchdogManager.js` but neither is wired into the session output pipeline for lastLine purposes.

---

## 2. Infrastructure Setup

### 2a. Temporary data directory

```
tmpDir = mktemp -d /tmp/qa-T19-XXXXXX
```

### 2b. Start the server

```
DATA_DIR=<tmpdir> PORT=3116 node server-with-crash-log.mjs
```

Wait for `GET http://localhost:3116/api/projects` → 200. Poll up to 15 seconds, 500ms intervals.

### 2c. Create a test project via REST API

```
POST http://localhost:3116/api/projects
{ "name": "T19-Project", "path": "/tmp" }
```

Capture `project.id`.

Seed `projects.json` directly or rely on the API. The client uses `waitUntil: 'domcontentloaded'` and needs the project visible in the sidebar.

### 2d. Launch Playwright browser

Navigate to `http://localhost:3116`. Wait for the project "T19-Project" to appear in the sidebar (up to 10s).

### 2e. Create a session via WebSocket

Use a WS client to send `session:create` with:
- `projectId`: the created project id
- `name`: "T19-session"
- `command`: "bash" (use bash so we can send predictable echo output)
- `mode`: "direct"

Wait for `session:created` response. Capture `session.id`.

**Why bash:** Claude TUI has a complex startup sequence and takes 8-10s. Bash responds to `echo` immediately, making lastLine testing deterministic.

---

## 3. Exact Action Sequence

### 3a. Select the project in the sidebar

Click on "T19-Project" in the sidebar. Wait for the sessions area to show the session card for "T19-session".

### 3b. Click the session card to open the overlay

Click on the "T19-session" card (or the "Open" button). This calls `attachSession(session.id)`, which sets `attachedSessionId.value`, causing `SessionOverlay` to render.

Wait for `#session-overlay` to be visible (up to 5s).

### 3c. Switch to split view

Click the "Split" button in the overlay header. This calls `toggleSplit()`, setting `splitView.value = true`. The overlay shrinks to the right half and the session list becomes visible on the left.

**Selector:** The "Split" button is in `.overlay-actions` with text "Split" (or "Full" when already split). From `SessionOverlay.js`:
```js
<button onClick=${toggleSplit} ...>
  ${isSplit ? 'Full' : 'Split'}
</button>
```

Wait for `#session-overlay` to have `left: 50%` style (confirming split mode). Or simply wait 500ms after clicking.

### 3d. Verify the session card is visible

In split mode, the left half shows the project detail with session cards. Confirm that `.session-card` with the session name "T19-session" is visible in the DOM.

### 3e. Read the initial lastLine value

```js
const initialLastLine = document.querySelector('.session-lastline')?.textContent ?? '';
```

If `.session-lastline` does not exist, `lastLine` is empty/undefined.

### 3f. Send a unique predictable output line via session input

Send the string `echo T19_MARKER_LINE_$(date +%s)\r` via `session:input` WS message to the bash session.

This will cause bash to output a line like `T19_MARKER_LINE_1712345678` to the PTY.

Wait 3 seconds for the output to propagate.

### 3g. Check the session card's lastLine element

Query `.session-lastline` in the DOM. Check:
1. **Does it exist?** If not, `lastLine` is still undefined — FAIL.
2. **Does it contain "T19_MARKER"?** If yes — PASS for content update.
3. **Does it contain any raw ANSI sequences?** Check for `\x1b`, ESC (char code 27), `\u001b`. If yes — FAIL for ANSI leakage.

### 3h. Send a second line and re-check within 3 seconds

Send `echo T19_SECOND_LINE\r`. Wait up to 3 seconds, polling every 500ms. Check that `.session-lastline` updates to show the new content.

---

## 4. Pass/Fail Criteria

### PASS (all must hold):

1. `.session-lastline` appears within 3 seconds of bash emitting output
2. The text content matches the most recent output line (contains "T19_MARKER" or "T19_SECOND_LINE")
3. No raw ANSI escape sequences are visible in `.session-lastline` text (no `\x1b`, no `ESC[`)
4. The lastLine updates again when a second echo is sent (not just a one-time flash)

### FAIL (any one is sufficient):

1. `.session-lastline` never appears (lastLine is never populated)
2. `.session-lastline` text does not match the bash output (stale or wrong content)
3. Raw `\x1b[...` sequences are visible in the card text
4. The lastLine shows the entire output buffer truncated mid-escape-sequence
5. The lastLine updates ONLY when the overlay is closed (meaning it only updates on `sessions:list` broadcast from lifecycle events, not from output)

---

## 5. Key Risks and Expected Findings

### Risk 1: lastLine is never populated — the feature is not implemented

**Probability: HIGH.** Code analysis shows no server-side code that computes `lastLine` from PTY output. `session.meta.lastLine` is never set. The `sessions:list` broadcast will always have `lastLine: undefined`.

**Expected outcome:** `.session-lastline` never appears in the DOM. The test will FAIL with a clear "feature not implemented" finding.

**Evidence to collect:** Show that `session.meta` in the API response (`GET /api/sessions`) does not contain a `lastLine` field.

### Risk 2: lastLine is populated from lifecycle events but not from output

**Scenario:** If `sessions:list` is broadcast on every state change and `lastLine` is somehow computed (e.g., from a scrollback buffer), it would update only on state transitions, not continuously.

**Test coverage:** The test covers this by checking that lastLine updates within 3 seconds of output — lifecycle-only updates would miss this window since bash stays in RUNNING state.

### Risk 3: lastLine updates but contains raw ANSI sequences

**Scenario:** If a naive `lastLine` extraction takes the raw PTY output without stripping ANSI codes.

**Test coverage:** Explicit ANSI check using regex `/\x1b\[[\x00-\x7F]*/` or checking for character code 27.

### Risk 4: Split view doesn't show the session card alongside the overlay

**Mitigation:** Read `SessionOverlay.js` — `splitView.value = true` causes `left: 50%` on the overlay, leaving the left half for `ProjectDetail` to render session cards. Verify `.session-card` is in the DOM after split toggle.

---

## 6. Assertions

### Assertion A — lastLine element appears
```js
await page.waitForSelector('.session-lastline', { timeout: 3000 });
```
If this times out → FAIL (lastLine never populated).

### Assertion B — Content matches echo output
```js
const text = await page.locator('.session-lastline').textContent();
expect(text).toContain('T19_MARKER');
```

### Assertion C — No ANSI sequences
```js
const text = await page.locator('.session-lastline').textContent();
expect(text).not.toMatch(/\x1b|\u001b/);
expect(text).not.toContain('[32m'); // common ANSI color code fragment
```

### Assertion D — Updates within 3 seconds
```js
// After sending second echo, poll for 3 seconds
await expect(page.locator('.session-lastline')).toContainText('T19_SECOND_LINE', { timeout: 3000 });
```

---

## 7. Screenshots

Save to `qa-screenshots/T19-lastline/`:

| Filename | When |
|----------|------|
| `01-project-selected.png` | After selecting T19-Project |
| `02-overlay-open.png` | After opening session overlay |
| `03-split-view.png` | After switching to split view |
| `04-after-echo.png` | 3 seconds after sending echo |
| `05-final-state.png` | End of test |
| `06-FAIL.png` | Only on failure |

---

## 8. Cleanup

In `afterAll`:
1. Kill session via WS `session:stop` then `session:delete`
2. Delete project via `DELETE /api/projects/<id>`
3. Kill server process (SIGTERM → wait 3s → SIGKILL)
4. Remove tmpDir

---

## 9. Execution Summary

**Run date:** 2026-04-08
**Result:** 1 FAIL (expected — feature not implemented), 1 PASS (diagnostic)
**Fix applied:** Changed `server:init` to `init` in `wsWaitFor` call (server sends `type: 'init'`, not `type: 'server:init'`)

### Test 1 — lastLine updates (main test): FAIL (expected)
- `.session-lastline` never appears in DOM after sending `echo T19_MARKER_...` to bash session
- API confirms `session.meta.lastLine` is `undefined` before and after echo
- Session meta keys: `id, projectId, projectName, name, command, cwd, mode, claudeSessionId, tmuxName, telegramEnabled, createdAt, status, pid, startedAt` — no `lastLine` field
- Root cause confirmed: No code in `DirectSession.js`, `SessionManager.js`, or `sessionHandlers.js` computes `lastLine` from PTY output. The `sessions:list` broadcast always omits `lastLine`.
- Split view worked correctly: overlay appeared at `left: 50%`, session card was visible alongside terminal

### Test 2 — API diagnostic: PASS
- Confirmed server-side: `session.lastLine = undefined` before echo, `undefined` after echo
- Feature is not implemented — `lastLine` is a pure client-side rendering concern with no server backing

### Finding
The `lastLine` feature is not yet implemented. The client-side `SessionCard.js` renders `.session-lastline` when `session.lastLine` is truthy, but no server code ever sets this field. The test correctly documents this gap.
