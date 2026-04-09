# T-05: Refresh Direct Session Preserves Conversation — Uses --resume

**Source:** Story 8 (Refresh a Direct Session)
**Score:** L=4 S=5 D=4 (Total: 13)
**Test type:** Playwright browser (sentinel protocol with conversation continuity check)

---

## 1. Infrastructure Setup

### 1a. Isolated server

Every test run must start a fresh, disposable server instance on port 3102 with a temporary data directory so state does not leak from prior tests.

```
PORT = 3102
DATA_DIR = $(mktemp -d /tmp/qa-T05-XXXXXX)
CRASH_LOG = $DATA_DIR/server-crash.log
```

Start the server using the crash-logging wrapper:

```
node server-with-crash-log.mjs
```

Spawn via `child_process.spawn` with `{ stdio: 'pipe', detached: false }`. Capture stdout/stderr to console. Store the process handle in `serverProc` for cleanup.

Wait for server readiness by polling `http://127.0.0.1:3102/` (GET) every 400ms, up to a 25-second deadline. Fail immediately if the server does not respond within 25s.

### 1b. Seed a test project

Before opening the browser, seed the data directory with a `projects.json` file so we don't have to use the UI project-creation flow. Create the file at `$DATA_DIR/projects.json` with content:

```json
{"projects":[{"id":"proj-t05","name":"T05-Project","path":"/tmp/qa-T05-project","createdAt":"2026-01-01T00:00:00Z"}],"scratchpad":[]}
```

Also create the project directory `/tmp/qa-T05-project` on disk so that Claude can create its conversation file there. The conversation file path is `~/.claude/projects/-tmp-qa-T05-project/<claudeSessionId>.jsonl` (the path encoding replaces `/` with `-` including the leading slash).

**Important:** Seed the file BEFORE starting the server so the server picks it up on startup.

### 1c. Screenshot directory

Create `qa-screenshots/T05-resume-on-refresh/` under the app root. All screenshots go there.

---

## 2. Session Creation

### 2a. Connect via WebSocket and create the session

Open a raw WebSocket connection to `ws://127.0.0.1:3102`. Send `session:create`:

```json
{
  "type": "session:create",
  "projectId": "proj-t05",
  "name": "T05-haiku",
  "command": "claude --model claude-haiku-4-5-20251001 --dangerously-skip-permissions --strict-mcp-config",
  "mode": "direct",
  "cols": 120,
  "rows": 30
}
```

Wait for `session:created` (up to 15s). Store `session.id` as `testSessionId`. Store `session.claudeSessionId` as `claudeSessionId` — this is the session ID used for the conversation file.

**Key detail:** `session:create` auto-subscribes the creating WS client to session output. Use `attachAndCollect(wsCreate, testSessionId)` to build the collector — do NOT send `session:subscribe` again (that would be a duplicate subscribe and cause unexpected behavior).

### 2b. Wait for RUNNING status

Poll `GET http://127.0.0.1:3102/api/sessions` every 300ms until the session's status is `"running"`, up to 30 seconds. If it never reaches RUNNING, abort with a clear error.

### 2c. Wait for Claude TUI ready

After RUNNING, the Claude TUI takes an additional 8-10 seconds to fully initialize. Sending input before TUI is ready results in silent loss — the input is never processed.

Poll the output buffer every 300ms up to 30 seconds. The signal: `buffer.includes('bypass')`. This is the footer text shown when `--dangerously-skip-permissions` is active. Once seen (or buffer length exceeds 2000), the TUI is ready.

---

## 3. Pre-Refresh Sentinel Protocol

### 3a. Send sentinel setup

Clear the buffer. Send:

```
session:input: "For this conversation reply to each message with ONLY the text ACK_N where N increments from 1. Nothing else. Begin now.\r"
```

**Critical:** The string must NOT contain `ACK_1` literally. The PTY echoes input back to the output stream ~2-3 seconds after sending. If `ACK_1` appears in the prompt text, `buffer.includes('ACK_1')` matches the echo before Claude responds — a false positive.

Wait for `ACK_1` in the buffer, up to 45 seconds. If it does not arrive, the test aborts (model unavailable or auth failed).

### 3b. Send one more message to confirm the protocol is working

After receiving ACK_1, wait 3 seconds (for TUI to return to input prompt). Clear the buffer. Send:

```
session:input: "NEXT\r"
```

Wait for `ACK_2`, up to 30 seconds.

After both ACK_1 and ACK_2 are confirmed, take a screenshot: `T05-01-pre-refresh-acks-received.png`.

---

## 4. Stop the Session (Pre-Refresh Drain)

Before refreshing via the UI, the test spec says "Stop the session." This is implemented by sending `session:stop` via WebSocket:

```json
{ "type": "session:stop", "id": "<testSessionId>" }
```

Poll the session status until it reaches `"stopped"`, up to 10 seconds.

**Why stop before refresh?** The test spec describes: "Create a direct session. Use sentinel protocol ... Stop the session. Click 'Refresh.'" The stop+refresh is the exact user flow being tested. It also ensures the conversation file has been fully flushed to disk before `_claudeSessionFileExists()` is called on refresh.

Wait 2 seconds after STOPPED to give Claude time to flush the conversation file to `~/.claude/projects/-tmp-qa-T05-project/<claudeSessionId>.jsonl`.

---

## 5. Open Browser and Trigger Refresh

### 5a. Open the browser

Launch headless Chromium. Navigate to `http://127.0.0.1:3102/` with `waitUntil: 'domcontentloaded'`. Wait for the "Connected" indicator (`.status-connected` or `body.textContent.includes('Connected')`), up to 30 seconds.

Wait 1.2 seconds for Preact rendering and project/session list hydration.

### 5b. Select the project and session

Click the project "T05-Project" in the sidebar. Wait for the sessions area to show. Wait for the session card "T05-haiku" to be visible. Click the session card to open `SessionOverlay`. Wait for `#session-overlay` to be visible (up to 10 seconds).

### 5c. Locate and click the Refresh button

Inside the session overlay, find the Refresh button. It is typically rendered as a button with text "Refresh" or an icon with `title="Refresh"`. Try these selectors in order:

1. `#session-overlay button:has-text("Refresh")`
2. `#session-overlay [title="Refresh"]`
3. `#session-overlay button[aria-label="Refresh"]`
4. `.session-toolbar button:has-text("Refresh")`

Wait for the button to be visible (up to 5 seconds). Take a screenshot before clicking: `T05-02-before-refresh.png`.

Click the Refresh button.

### 5d. Wait for refresh to complete

After clicking Refresh, poll `GET /api/sessions` until the session status returns to `"running"`, up to 30 seconds. Take a screenshot after reaching RUNNING: `T05-03-after-refresh.png`.

---

## 6. Post-Refresh Sentinel Protocol (Conversation Continuity Check)

### 6a. Close the original WS and open a fresh subscriber

Close `wsCreate`. Open a new WebSocket and subscribe to the session:

```json
{ "type": "session:subscribe", "id": "<testSessionId>", "cols": 120, "rows": 30 }
```

Wait for `session:subscribed` ack (up to 10 seconds). Attach a new buffer collector.

### 6b. Wait for Claude TUI ready after refresh

After refresh, a new PTY spawns and Claude TUI must initialize again. Poll for `buffer.includes('bypass')` or `buffer.length > 2000`, up to 30 seconds.

### 6c. Send "NEXT" and check for ACK_3

This is the core continuity assertion. Send:

```
session:input: "NEXT\r"
```

Wait for `ACK_3` in the buffer, up to 45 seconds.

**Why ACK_3?** Before the refresh, we established ACK_1 and ACK_2. The conversation file on disk has Claude's context up to ACK_2. If `--resume <claudeSessionId>` was passed on restart, Claude loads that context and the next response should be ACK_3 (continuing the count). If `--resume` was NOT used (fresh start), Claude has no memory of the protocol and will respond with ACK_1 instead — a clear fail signal.

**Why "NEXT" not a new sentinel prompt?** Because "NEXT" contains no ACK literal, so PTY echo does not cause a false positive. The raw message "NEXT\r" triggers Claude to give the next ACK in its count. If Claude has memory, it responds ACK_3. If not, it asks what we're talking about or responds with ACK_1 (starting over).

### 6d. The false-PASS risk: "coincidental ACK_3"

There is a subtle risk: if we resend the sentinel prompt after refresh (as F.09 does after a planned fresh-start), Claude could produce ACK_3 by coincidence because we told it "start from N=3." To avoid this, we deliberately send only "NEXT\r" — no new sentinel setup — and expect ACK_3 to arrive without any explicit instruction to start at 3. Claude should produce ACK_3 only if it has genuine memory from the resumed conversation.

If Claude responds with anything other than `ACK_3` (e.g., a message saying "I don't have context" or "ACK_1"), the test fails.

---

## 7. --resume Verification (Server-Side Check)

### 7a. Verify conversation file exists before refresh

Before refreshing, programmatically check that the conversation file exists on disk:

```javascript
const encodedPath = '/tmp/qa-T05-project'.replace(/\//g, '-'); // → "-tmp-qa-T05-project"
const sessionFile = path.join(
  process.env.HOME || '/home/claude-runner',
  '.claude', 'projects', encodedPath, claudeSessionId + '.jsonl'
);
const fileExists = fs.existsSync(sessionFile);
```

Assert `fileExists === true`. If the file doesn't exist, the `--resume` path can't work and the test is moot.

### 7b. Inspect server logs for --resume flag

After the refresh, check the server's stdout capture for a line containing both `--resume` and `claudeSessionId`. The server's `console.log` output from `DirectSession._buildArgs()` or PTY spawn will show the command being run.

Alternatively, read the crash log (even on clean runs, the server may log startup lines) from `$DATA_DIR/server-crash.log`.

**This is belt-and-suspenders:** ACK_3 is the primary proof. The --resume flag in logs is a secondary confirmation that the mechanism fired correctly.

---

## 8. Repeat Protocol (3 Iterations)

Race conditions and non-determinism require repetition. Run the entire flow (session create → ACK_1+2 → stop → refresh → wait for TUI → NEXT → ACK_3) **3 times**.

Between iterations:
1. Delete the current session via WS: `{ "type": "session:delete", "id": "<testSessionId>" }`
2. Wait 2 seconds for cleanup.
3. Remove the conversation file for this claudeSessionId from disk (to prevent --resume from resuming the old session into the next iteration).
4. Re-create the project directory `/tmp/qa-T05-project` (it may have been cleaned).
5. Verify via `GET /api/sessions` that the session is gone before proceeding.

### Iteration scoring

- 3/3 pass: PASS. Refresh reliably loads the --resume path.
- 2/3 pass: FLAKY. Report as a warning. One failure deserves investigation.
- 1/3 or 0/3: FAIL. --resume is not reliably triggered.

Log per-iteration results:

```
Iteration 1: conversation_file_exists=true, ACK_3_received=true, --resume_in_logs=true → PASS
Iteration 2: ...
```

---

## 9. Pass/Fail Criteria

### PASS (all must hold for every iteration):

1. `ACK_1` and `ACK_2` received before refresh (proves sentinel was established).
2. Conversation file (`<claudeSessionId>.jsonl`) exists on disk before refresh.
3. Session returns to `"running"` after refresh (within 30s).
4. `ACK_3` received after refresh without sending a new sentinel prompt (proves conversation continuity).
5. All 3 iterations pass.

### FAIL (any one is sufficient):

1. `ACK_1` or `ACK_2` never arrives (sentinel failed — test inconclusive, not a real fail of --resume).
2. Conversation file does not exist before refresh (--resume can't fire — likely a cwd encoding bug).
3. Session does not return to `"running"` after refresh (refresh mechanism broken).
4. Response after refresh is NOT `ACK_3` — Claude responds with `ACK_1`, says "I don't have context", or times out (--resume failed to load conversation).
5. 2+ iterations fail.

### INCONCLUSIVE (must report but not as PASS or FAIL):

- `ACK_3` arrived but the conversation file did not exist before refresh (Claude responded correctly but not via --resume — perhaps it used a different memory mechanism or the response was a hallucination).
- The server logs don't show `--resume` but ACK_3 still arrives (flag not logged, not necessarily wrong).

---

## 10. Screenshots

All saved to `qa-screenshots/T05-resume-on-refresh/`:

| Filename | When | Purpose |
|----------|------|---------|
| `iter-N-01-pre-refresh-acks.png` | After ACK_2 received | Baseline: sentinel working |
| `iter-N-02-before-refresh.png` | Before clicking Refresh | Shows session state |
| `iter-N-03-after-refresh-running.png` | After session returns to RUNNING | Refresh completed |
| `iter-N-04-ACK3-received.png` | After ACK_3 received (or failure) | Core assertion result |
| `iter-N-FAIL.png` | Only on failure | Evidence capture |

---

## 11. Cleanup

In `afterAll` (runs even if test throws):

1. Kill the server process (`SIGKILL`).
2. Print crash log contents to console if non-empty.
3. Remove the temp data directory (`rm -rf $DATA_DIR`).
4. Remove `/tmp/qa-T05-project` directory.
5. Close all WebSocket connections.
6. Close the Playwright browser.

---

## 12. Known Risks and Design Decisions

### Risk 1: False-PASS via coincidental ACK_3

**Problem:** What if Claude, with no prior context, happens to respond "ACK_3" to "NEXT"? This is astronomically unlikely but theoretically possible.

**Mitigation:** Use a deliberately large starting number in iteration 2 (e.g., start at ACK_10/ACK_11) and in iteration 3 (ACK_20/ACK_21). A fresh Claude would start at 1. Only a resumed session would continue from 11 or 21. This makes coincidental matching statistically impossible across 3 iterations.

**Implementation:** Iteration 1 uses ACK_1/ACK_2/ACK_3. Iteration 2 uses ACK_10/ACK_11/ACK_12. Iteration 3 uses ACK_20/ACK_21/ACK_22. The sentinel prompt establishes the starting number explicitly in each iteration, and the post-refresh "NEXT" must yield the third ACK in the sequence.

### Risk 2: Conversation file not written before refresh

**Problem:** Claude may not have flushed its `.jsonl` file by the time we check `_claudeSessionFileExists()`. If the file doesn't exist, `--resume` is not passed, and we'd get a false-FAIL (system working as designed: no file → no resume).

**Mitigation:** Wait 2 full seconds after session STOPPED before refreshing. Also, explicitly assert the file exists BEFORE clicking Refresh. If it doesn't exist, mark the iteration as INCONCLUSIVE (not FAIL) and log a warning.

### Risk 3: The `claudeSessionId` is not returned in `session:created`

**Problem:** If `session:created` doesn't include `claudeSessionId`, we can't compute the file path to verify it exists.

**Mitigation:** Check the `session:created` response structure. Based on `DirectSession.toJSON()` → `{ ...this.meta }`, the `claudeSessionId` field should be present as a flat field on the session object. Verify this in the test setup. Fall back to checking all `.jsonl` files in the `~/.claude/projects/-tmp-qa-T05-project/` directory if `claudeSessionId` is null.

### Risk 4: PTY echo of "NEXT" matches ACK-containing strings

**Problem:** The PTY echoes `NEXT\r` back as output. Could `buffer.includes('ACK_3')` match something in the echo?

**Mitigation:** "NEXT" contains no digits and no "ACK" substring. The echo of `NEXT\r` is `NEXT\r\n` — it will not match `ACK_3`. Safe.

### Risk 5: The session's cwd encoding is different from expected

**Problem:** `_claudeSessionFileExists()` encodes `cwd` by replacing `/` with `-`. But what `cwd` does the session actually use? From JOURNAL.md: "The cwd used is `project.path` (set by `SessionManager._createDirect`), NOT any `cwd` parameter passed in `session:create`."

**Mitigation:** The project `path` is `/tmp/qa-T05-project`. The encoded form is `-tmp-qa-T05-project`. The test file existence check must use this exact encoding. Verify in the test by actually running `ls ~/.claude/projects/` after ACK_2 to see what directory was created.

### Risk 6: --resume not logged; pass is unverifiable via logs

**Problem:** The server may not log the exact command invoked per PTY spawn.

**Mitigation:** ACK_3 is the primary behavioral proof. The log check is secondary. If ACK_3 arrives and the conversation file existed, the --resume path is proven by behavior even without log evidence.

### Design Decision: Why stop before refresh (not refresh directly from RUNNING)

The test spec says "Stop the session. Click 'Refresh.'" This is the user story's explicit flow. Testing refresh from STOPPED also:
1. Ensures conversation file is fully flushed (Claude flushes on exit).
2. Tests the STOPPED → STARTING transition path in `refresh()`.
3. Prevents any ambiguity about whether `_claudeSessionFileExists()` races with a still-running Claude process.

### Design Decision: Why not use browser Refresh button throughout

The browser Refresh button is the user-facing trigger being tested. We click it in step 5c rather than using `session:refresh` via WS, because the test explicitly names this as "Click Refresh" in the user story. This tests the full stack including the UI's Refresh button handler → WS message → server → `DirectSession.refresh()`.

### Design Decision: Why 3 iterations with escalating ACK numbers

Three iterations with ACK_1/ACK_2/ACK_3, ACK_10/ACK_11/ACK_12, and ACK_20/ACK_21/ACK_22 accomplish two things: (1) they test the behavior multiple times to catch non-determinism, and (2) the escalating numbers make any "coincidental pass" statistically impossible. A fresh Claude session always starts counting from 1 — it cannot produce ACK_12 or ACK_22 by coincidence in response to a plain "NEXT" message.
