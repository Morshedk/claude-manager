# T-02: Browser Hard-Reload Reconnects and Shows Live Session

**Test type:** Playwright browser test
**Source:** Story 10 (Browser Reload -- Reconnect Without Data Loss)
**Score:** L=5 S=5 D=3 (Total: 13)

---

## 1. Infrastructure Setup

### Isolated server

Every run must start a fresh, disposable server instance so no state leaks from prior tests.

1. Create a temporary data directory: `DATA_DIR=$(mktemp -d /tmp/t02-XXXXXX)`.
2. Seed it with a `projects.json` containing one test project. The project `path` should point to a real, innocuous directory (e.g., `/tmp`). This avoids needing the UI project-creation modal. Example seed content:
   ```json
   [{ "id": "proj-t02", "name": "T02-Project", "path": "/tmp", "createdAt": "2026-01-01T00:00:00Z" }]
   ```
   Write this file to `$DATA_DIR/projects.json` before starting the server.
3. Start the server:
   ```
   DATA_DIR=$DATA_DIR PORT=3099 node server-with-crash-log.mjs
   ```
   Spawn via `child_process.spawn` with `{ stdio: 'pipe', detached: false }`. Capture the child process handle for cleanup.
4. Wait for the server to be ready by polling `http://127.0.0.1:3099/api/sessions` (GET) with a 200ms interval, up to 8 seconds. The server is ready when the response is a valid JSON object.
5. Record the server PID for later verification (`serverProcess.pid`).

### Playwright browser

1. Launch a Chromium browser via `chromium.launch({ headless: true })`.
2. Create a single browser context with `context.newPage()`.
3. Navigate to `http://127.0.0.1:3099` with `page.goto(url, { waitUntil: 'networkidle' })`.
4. Wait for the TopBar status dot to show "Connected": poll for the selector `.status-dot.connected` to exist in the DOM, timeout 8 seconds.

---

## 2. Session Setup

### Why bash, not claude

The `claude` binary takes 8-10 seconds to start its TUI, which introduces flaky timing. Instead, the session command should be `bash` -- it starts instantly, stays alive indefinitely, and produces output on demand.

### Create the session via WebSocket

The session is created through the UI to match real user flow:

1. **Select the project** in the sidebar: click the element matching `.project-item` that contains text "T02-Project". Verify it gains the `active` class.
2. **Open the New Session modal**: click the button containing text "New Claude Session" (selector: `#sessions-area .btn-primary`).
3. **Fill the session name**: type "t02-bash-session" into the session name input (`.modal .form-input` -- the first input in the modal body).
4. **Set the command to `bash`**: clear the command input (the second `.form-input` in the modal body, the one with `font-family:var(--font-mono)`) and type `bash`.
5. **Ensure mode is Direct**: the "Direct" button should already be active (default). Verify the button with text "Direct" has the active background color (`var(--accent)`).
6. **Click "Start Session"**: click the `.btn-primary` inside `.modal-footer`.
7. **Wait for the session card to appear** with status "running": poll for a `.session-card` element whose inner text includes both "t02-bash-session" and "running", timeout 8 seconds.

### Confirm "running" via API

After the card appears, call `GET /api/sessions` and parse the JSON response. Find the session with `name === "t02-bash-session"`. Assert:
- `status === "running"` (or `state === "running"`)
- `pid` is a positive integer
- `mode === "direct"`

Record the session `id` and `pid` for later use. These are critical invariants for post-reload checks.

### Generate baseline terminal output

To later prove the terminal shows "live output," we need to produce identifiable content:

1. **Attach to the session**: click the session card (`.session-card` containing "t02-bash-session"), which calls `attachSession()`.
2. **Wait for the SessionOverlay** to appear: poll for `#session-overlay` to be visible, timeout 5 seconds.
3. **Wait for the terminal** to mount: poll for `#session-overlay-terminal .xterm-screen` to exist, timeout 5 seconds.
4. **Type a unique marker command**: use `page.keyboard.type('echo T02_MARKER_ALPHA\n')`. This sends keystrokes through xterm -> WS -> PTY -> bash. The terminal should display both the command and the output `T02_MARKER_ALPHA`.
5. **Verify the marker appeared in the terminal**: poll for the xterm buffer to contain "T02_MARKER_ALPHA" by evaluating in the page context:
   ```js
   document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes('T02_MARKER_ALPHA')
   ```
   Timeout: 3 seconds.

---

## 3. Pre-Reload State Capture

Before reloading, capture these values for comparison:

| Field | How to capture | Purpose |
|-------|---------------|---------|
| `sessionId` | From the `GET /api/sessions` call above | Verify the session persists with the same ID after reload |
| `ptyPid` | From the API response `pid` field | Verify the PTY process is still alive after reload |
| `serverPid` | From `serverProcess.pid` | Sanity check -- server must not have crashed |
| `preReloadScreenText` | `page.evaluate(() => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent)` | Baseline for "the terminal had content" |
| `preReloadTimestamp` | `Date.now()` | Used to judge timing of post-reload recovery |

Also take a screenshot: `pre-reload.png`.

---

## 4. Exact Reload Procedure

### What "hard reload" means in Playwright

Playwright does not have a native "hard reload (bypass cache)" API. The options are:

1. `page.reload()` -- standard reload (may use cache).
2. `page.evaluate(() => location.reload(true))` -- the `true` argument was historically "force reload" but is ignored by modern browsers (deprecated per spec).
3. **CDP cache disable + reload** (recommended approach):
   ```js
   const cdp = await page.context().newCDPSession(page);
   await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
   await page.reload({ waitUntil: 'domcontentloaded' });
   ```
   This uses Chrome DevTools Protocol to disable the HTTP cache entirely, then performs a normal reload. This is the most reliable Playwright equivalent of Ctrl+Shift+R.

### Procedure

1. Before reload: **close the session overlay** by pressing Escape (or clicking `#btn-detach`). This is important because the overlay mounts/unmounts TerminalPane -- we want to test the full lifecycle of reconnect, not just a component that stayed mounted.
   - Actually, reconsider: in a real user scenario, the user might have the overlay open when they hit Ctrl+Shift+R. Test BOTH paths (overlay open at reload time, overlay closed at reload time) across the 3 repetitions. Alternate: rounds 1 and 3 reload with overlay open, round 2 reloads with overlay closed.
2. Disable cache via CDP as described above.
3. Execute: `await page.reload({ waitUntil: 'domcontentloaded' })`.
4. Record `reloadTimestamp = Date.now()`.

### What happens on reload (expected behavior from code analysis)

When the page reloads:
- All JavaScript state is destroyed (Preact signals, xterm instances, WS connection).
- `main.js` re-executes: calls `connect()` (opens new WS), `initMessageHandlers()`, and `render(App)`.
- On WS open, server sends `init` (with `clientId`) and `sessions:list` (with all sessions).
- `initMessageHandlers` receives `init` -> sets `connected.value = true`, calls `loadProjects()` and `loadSessions()`.
- The `sessions:list` message populates `sessions.value` with all sessions including our bash session (still running server-side).
- The sidebar re-renders with the project list. The session cards re-render.
- **Critically**: `selectedProjectId` and `attachedSessionId` signals reset to `null` on reload (they are in-memory Preact signals, not persisted). So the user must re-select the project and re-open the session overlay. This is expected behavior.

---

## 5. Post-Reload Verification Sequence

Each check has a timeout and a specific measurement method.

### Check 1: Page loaded successfully (timeout: 5s)

- Wait for `#app` to be in the DOM.
- Wait for `#topbar` to be visible.
- **Measurement**: `page.waitForSelector('#topbar', { state: 'visible', timeout: 5000 })`.

### Check 2: WebSocket reconnects and TopBar shows "Connected" (timeout: 8s)

- Wait for `.status-dot.connected` to appear.
- Also verify the adjacent `.status-text` contains "Connected".
- **Measurement**: `page.waitForSelector('.status-dot.connected', { timeout: 8000 })`.
- **Record**: `wsReconnectTime = Date.now() - reloadTimestamp`.
- **Assert**: `wsReconnectTime < 5000` (must connect within 5 seconds per the pass condition).

### Check 3: Project list loads and project is visible (timeout: 5s)

- Wait for `#project-list` to contain a `.project-item` with text "T02-Project".
- **Measurement**: `page.waitForFunction(() => document.querySelector('#project-list')?.textContent?.includes('T02-Project'), { timeout: 5000 })`.

### Check 4: Select the project, session card shows "running" (timeout: 5s)

- Click the `.project-item` containing "T02-Project".
- Wait for `#project-sessions-list` to contain a `.session-card` with text including "t02-bash-session" and "running".
- **Measurement**: `page.waitForFunction(() => { const cards = document.querySelectorAll('.session-card'); return [...cards].some(c => c.textContent.includes('t02-bash-session') && c.textContent.includes('running')); }, { timeout: 5000 })`.
- **Fail signal**: The card shows "stopped", "exited", "error", or the card is missing entirely.

### Check 5: Server-side verification -- session still running (timeout: 2s)

- `GET http://127.0.0.1:3099/api/sessions`.
- Parse JSON, find the session by `id === sessionId` (captured pre-reload).
- Assert `status === "running"` (or `state === "running"`).
- Assert `pid === ptyPid` (the PID must be unchanged -- same process, not respawned).
- **Measurement**: HTTP fetch from Node.js test runner (not from browser).

### Check 6: PTY process still alive (timeout: 1s)

- From the Node.js test runner, execute: `process.kill(ptyPid, 0)` (signal 0 checks existence without killing).
- This must NOT throw. If it throws with ESRCH, the PTY died.
- **Measurement**: try/catch around `process.kill`.

### Check 7: Open the session overlay (timeout: 5s)

- Click the session card (the `.session-card` containing "t02-bash-session") to attach.
- Wait for `#session-overlay` to be visible.
- Wait for `#session-overlay-terminal .xterm-screen` to exist.
- **Measurement**: `page.waitForSelector('#session-overlay', { state: 'visible', timeout: 5000 })` then `page.waitForSelector('#session-overlay-terminal .xterm-screen', { timeout: 5000 })`.

### Check 8: Terminal shows live output -- the "freshness test" (timeout: 8s)

This is the most critical check. See Section 6 for the full definition of "live output."

1. Wait 500ms for the terminal to receive its initial data burst (the `session:subscribed` -> `session:output` flow replays current PTY screen state).
2. Generate a NEW unique marker: `T02_POST_RELOAD_${Date.now()}`.
3. Type into the terminal: `page.keyboard.type('echo T02_POST_RELOAD_XXXX\n')` (replacing XXXX with the timestamp).
4. Poll the xterm screen text content for the marker string, up to 5 seconds:
   ```js
   page.waitForFunction(
     (marker) => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes(marker),
     marker,
     { timeout: 5000 }
   )
   ```
5. If found, the terminal is alive and bidirectional (input goes in, output comes back).

### Check 9: Take screenshot

Capture `post-reload-round-N.png` for visual inspection.

---

## 6. "Live Output" Definition

"Live output" is precisely defined as ALL of the following conditions being true:

### Condition A: Terminal is not blank

After opening the overlay and waiting 1 second, `#session-overlay-terminal .xterm-screen` has `textContent.trim().length > 0`. A blank terminal (length === 0) is a fail.

### Condition B: Terminal accepts new input and displays new output

A unique marker string generated AFTER the reload (e.g., `T02_POST_RELOAD_1712345678901`) is typed into the terminal. Within 5 seconds, that exact marker string appears in the xterm screen's text content. This proves:
- Keyboard input reaches the PTY (client -> WS -> server -> PTY).
- PTY output reaches the terminal (PTY -> server -> WS -> xterm).
- The round trip is functioning.

### Condition C: The output is from the SAME process, not a respawned one

The PTY PID must be identical to the pre-reload PID. If the server killed and respawned the bash process during reload, that would be a bug (the session should survive browser reload without any server-side change). This is verified in Check 6 above.

### What does NOT count as live output

- The terminal displaying cached/stale content from before the reload (this is actually fine as a starting state, but Condition B must also pass).
- The terminal showing a bash prompt but not responding to input.
- The terminal showing error messages like "Session not found."

---

## 7. Server-Side Verification

These checks run from the Node.js test runner (not from inside the browser).

### 7a. REST API check

```
GET http://127.0.0.1:3099/api/sessions
```

Parse the response. The `managed` array must contain a session object where:
- `id` matches the pre-reload `sessionId`
- `status` (or `state`) is `"running"`
- `pid` matches the pre-reload `ptyPid`
- `name` is `"t02-bash-session"`
- `projectId` is `"proj-t02"`

### 7b. Process liveness check

```js
try {
  process.kill(ptyPid, 0); // signal 0 = existence check
  // PASS: process exists
} catch (err) {
  if (err.code === 'ESRCH') {
    // FAIL: process does not exist
  }
}
```

### 7c. Server process liveness check

Verify the server process itself did not crash during reload:
```js
try {
  process.kill(serverProcess.pid, 0);
  // PASS: server is alive
} catch {
  // FAIL: server crashed
}
```

### 7d. Crash log check

After the test, read `$DATA_DIR/../crash.log` (or wherever `CRASH_LOG` env pointed). If it contains any `UnhandledRejection` or `UncaughtException` lines timestamped during the test window, that is a fail even if all other checks passed.

---

## 8. Repeat Protocol

### Why repeat

Browser reload timing is nondeterministic. WS reconnect has a 3-second delay built into `connection.js` (the `RECONNECT_DELAY` constant). A single pass could be luck.

### Repetition count: 3

Run the entire reload cycle (Sections 4 + 5) three times in sequence, without restarting the server or recreating the session. The same bash session must survive all 3 reloads.

### Variation across rounds

| Round | Overlay state at reload time | Notes |
|-------|------------------------------|-------|
| 1 | Overlay OPEN (terminal visible) | Tests: does TerminalPane unmount/remount cleanly? |
| 2 | Overlay CLOSED (detached before reload) | Tests: does session survive reload when no client is subscribed? |
| 3 | Overlay OPEN (terminal visible) | Repeat of round 1 for confidence |

For rounds where overlay is closed before reload: after reload, the test must re-select the project AND re-open the session overlay to verify.

### Per-round unique marker

Each round uses a distinct marker: `T02_ROUND_1_<timestamp>`, `T02_ROUND_2_<timestamp>`, `T02_ROUND_3_<timestamp>`. All three must appear in the terminal after their respective reloads. This proves each round's bidirectional path is independently functional.

### Pass threshold

All 3 rounds must pass ALL checks. If any single check in any round fails, the entire test fails. There is no "2 out of 3" tolerance -- that would mask intermittent bugs.

---

## 9. Pass/Fail Criteria

### PASS -- all of the following must be true across all 3 rounds:

1. After each reload, `.status-dot.connected` appears within 5 seconds.
2. After each reload, the session card for "t02-bash-session" shows "running" (not "stopped", "error", or missing).
3. After each reload, `GET /api/sessions` returns the session with `status === "running"` and the original PID unchanged.
4. After each reload, `process.kill(ptyPid, 0)` succeeds (PTY alive).
5. After each reload, the terminal overlay opens and `xterm-screen` has non-empty text content.
6. After each reload, a newly typed unique marker appears in the terminal within 5 seconds (bidirectional live output proven).
7. The server process did not crash (PID alive, no crash log entries).

### FAIL -- any of the following:

- Session shows "stopped" or "error" after any reload.
- Session card is missing after any reload (session was deleted or lost).
- Terminal is blank (empty `textContent`) after opening overlay.
- Typed marker does not appear within 5 seconds (terminal frozen or input broken).
- PTY PID changed between rounds (process was respawned -- browser reload should not cause server-side respawn).
- PTY PID is dead (ESRCH from `process.kill`).
- TopBar status dot stays `.error` (red) for more than 5 seconds after reload.
- Server process crashed during the test.
- Crash log contains unhandled exceptions during the test window.

---

## 10. Screenshots

Capture the following screenshots to the `qa-screenshots/t02-hard-reload/` directory:

| Filename | When | What it should show |
|----------|------|---------------------|
| `00-pre-session.png` | After navigating, before creating session | The app with project sidebar, no sessions |
| `01-session-running.png` | After session created and overlay open | Terminal with bash prompt, marker ALPHA visible |
| `02-pre-reload-round-1.png` | Just before first reload | Terminal overlay open with content |
| `03-post-reload-round-1.png` | After first reload, overlay reopened, marker typed | Connected dot, session card running, terminal with round-1 marker |
| `04-post-reload-round-2.png` | After second reload, overlay reopened | Same as above but with round-2 marker |
| `05-post-reload-round-3.png` | After third reload, overlay reopened | Same as above but with round-3 marker |
| `06-final-api-state.png` | N/A (not a screenshot -- save as JSON) | Save the final `GET /api/sessions` response as `06-final-api-state.json` for debugging |

---

## 11. Cleanup

Cleanup must run in `afterAll` (or equivalent) regardless of test outcome:

1. **Kill the server process**: `serverProcess.kill('SIGTERM')`. Wait up to 3 seconds for it to exit. If it does not exit, `serverProcess.kill('SIGKILL')`.
2. **Kill the bash PTY** (if still alive): `process.kill(ptyPid, 'SIGKILL')`. Wrap in try/catch since it may already be dead.
3. **Close the Playwright browser**: `browser.close()`.
4. **Remove the temp data directory**: `rm -rf $DATA_DIR`. Use `fs.promises.rm(dataDir, { recursive: true, force: true })`.
5. **Remove screenshot directory** only on PASS (keep on FAIL for debugging).

Order matters: kill server before removing data dir to avoid the server trying to write to a deleted directory.

---

## 12. False PASS Risks and Mitigations

### Risk 1: Session appears "running" but PTY is dead

**Scenario**: The server's in-memory session state says "running" but the actual bash process exited. The REST API would still report "running" because the state machine was not updated.

**Mitigation**: Check 6 explicitly calls `process.kill(ptyPid, 0)` to verify the OS-level process exists. Do NOT rely solely on the API's `status` field.

### Risk 2: Terminal shows stale pre-reload content, not live output

**Scenario**: The xterm buffer retained cached DOM from before reload (unlikely with hard reload, but possible with service workers or aggressive caching). The text content check passes because the old marker is still there.

**Mitigation**: The freshness test (Check 8) types a NEW unique marker generated AFTER the reload. The old marker string cannot appear unless the round trip is working. The marker includes `Date.now()` to guarantee uniqueness across rounds.

### Risk 3: WS reconnect happens to work once but is unreliable

**Scenario**: The 3-second `RECONNECT_DELAY` in `connection.js` means the WS reconnect fires once after reload, but timing varies. One round passes by luck.

**Mitigation**: Three rounds with all-must-pass requirement. The WS reconnect path is exercised 3 times. Additionally, the 5-second timeout for the "Connected" dot is generous but tracked -- if any round takes close to 5 seconds, it flags a latent timing issue even if it technically passes.

### Risk 4: TerminalPane re-subscribes to the wrong session

**Scenario**: After reload, `attachedSessionId` is `null`. The user re-selects the session. But what if the session IDs changed server-side? The terminal would subscribe to a non-existent session.

**Mitigation**: Check 5 verifies the session ID is unchanged after reload. The session store persists to `sessions.json` and the server does not reassign IDs on page reload (there is no server-side event triggered by browser reload).

### Risk 5: The overlay opens but TerminalPane never sends session:subscribe

**Scenario**: The `useEffect` in `TerminalPane.js` depends on `sessionId`. If the Preact render cycle has a bug, the effect might not fire, and no `session:subscribe` message is sent. The terminal would mount but stay blank.

**Mitigation**: Check 8's freshness test catches this -- if no subscribe was sent, no output arrives, and the typed marker never echoes back. Additionally, Check 8 Condition A requires non-empty text content after 1 second.

### Risk 6: The test passes because `page.reload()` used browser cache

**Scenario**: Without cache bypass, the browser might serve the old JavaScript from cache, and the "reconnect after reload" is trivially easy because the WS connection object was somehow preserved (it is not -- WS always drops on reload, but the concern is about stale JS serving a different code path).

**Mitigation**: CDP `Network.setCacheDisabled` is set to true before every reload. This is the definitive Playwright mechanism for cache bypass. The test explicitly verifies this is in place.

### Risk 7: The `connection:open` handler in TerminalPane re-subscribes even on initial load

**Scenario**: Looking at line 156-166 of `TerminalPane.js`, there is a `handleReconnect` handler on `connection:open`. On initial mount, the effect already sends a `session:subscribe` (line 147). If `connection:open` also fires during the initial mount (because the WS is already open or opens right after), it could send a DUPLICATE subscribe. The server might handle this gracefully or might not.

**Mitigation**: This is not a false-PASS risk per se -- it is a potential bug to observe. The test should log console warnings from the browser (`page.on('console', ...)`) and flag any `[ws] handler error` messages. If duplicate subscribes cause issues, the test will catch it via Check 8 (terminal content will be garbled or missing).

### Risk 8: Server sends `sessions:list` on new WS connection, masking a broken loadSessions path

**Scenario**: Looking at `server.js` lines 68-72, the server sends `sessions:list` immediately on every new WS connection. So even if `loadSessions()` (which does `GET /api/sessions`) fails, the client still gets the session list via WS. The test would pass even if the REST endpoint is broken.

**Mitigation**: Check 5 explicitly calls the REST API from the test runner. If the REST endpoint is broken, Check 5 fails. But this is also why the test should not ONLY rely on the REST API -- the browser-side checks (session card visible) verify the WS path independently.

---

## Execution Summary

**Final result: PASS**

**Number of attempts needed: 2**

### Attempt 1 (FAIL — timeout at 120s)

Two bugs caused failure:

1. **Wrong seed format for `projects.json`**: The test seeded the file as a plain JSON array `[{...}]` but `ProjectStore` expects `{ "projects": [...], "scratchpad": [] }`. The server loaded an empty project list, so `T02-Project` never appeared in the sidebar.

2. **Missing explicit timeout on locator click**: `page.locator('.project-item').filter({hasText:...}).first().click()` uses the test's global timeout (120s) when the element doesn't exist, silently hanging the test rather than failing fast.

### Attempt 2 (PASS — 28.2s)

Fixed both issues:
- Seed file now uses `{ projects: [...], scratchpad: [] }` format.
- All `locator.click()` calls now have explicit `waitFor({ state: 'visible', timeout: 5000 })` guards before clicking.
- Terminal input uses `page.keyboard.press('Enter')` rather than `\n` in `keyboard.type()`.

### Deviations from design

- **Design says `page.goto(url, { waitUntil: 'networkidle' })`** for initial navigation. The template (`F-lifecycle.test.js`) uses `waitUntil: 'domcontentloaded'` — adopted that approach because a persistent WebSocket connection prevents `networkidle` from ever firing.
- **Design says seed with a plain array** (`[{ "id": "proj-t02", ... }]`). The actual `ProjectStore` requires `{ "projects": [...] }` wrapper — this is an error in the design doc's seed example.
- **Screenshot filenames**: Design listed filenames `00` through `06`. Implementation follows this numbering but adds a pre-round-2 overlay-closed screenshot (`03-pre-reload-round-2-overlay-closed.png`).
- **`test.setTimeout(120000)` inside the test**: The global playwright.config.js timeout is 1.2M ms, so this inner override was used to match the run command's `--timeout=120000`. The 2nd attempt completed in 28.2s so this was fine.

### Bugs discovered

- **`ProjectStore` seed format not documented**: The design doc (Section 1, step 2) shows the seed as a plain JSON array but the actual `ProjectStore` class requires `{ "projects": [...], "scratchpad": [] }`. Any test that tries to seed projects by writing a plain array will silently get an empty project list.

### Key metrics (from passing run)

| Metric | Round 1 | Round 2 | Round 3 |
|--------|---------|---------|---------|
| WS reconnect time | 1162ms | 1288ms | 907ms |
| PTY PID unchanged | yes (492643) | yes (492643) | yes (492643) |
| Terminal non-blank | yes (54887 chars) | yes (54887 chars) | yes (54887 chars) |
| Marker appeared | yes | yes | yes |
| Server crashed | no | no | no |
