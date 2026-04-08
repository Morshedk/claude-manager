# Adversarial Test Plan -- claude-web-app-v2

> Generated 2026-04-07. Target: 200+ test cases across 7 categories.
> Adversarial framing: agents WIN by finding real bugs. Agents LOSE by issuing false PASSes.

---

## Architecture Summary (for implementing agents)

- **Server:** Node.js ESM, Express, raw `ws` WebSocket (NOT socket.io)
- **Sessions:** `SessionManager` orchestrates `DirectSession` (node-pty spawn) and `TmuxSession` (tmux + node-pty attach)
- **State machine:** `CREATED -> STARTING -> RUNNING -> STOPPED/ERROR`, transitions enforced by `assertTransition()`
- **WS Protocol:** Client sends `session:*` messages, server responds with typed JSON messages
- **Client:** Preact via CDN importmap, xterm.js v5 with WebGL/Canvas/DOM fallback
- **Persistence:** `sessions.json` on disk via `SessionStore`, atomic write (tmp + rename)
- **Watchdog:** Independent tick loop monitoring hardcoded tmux sessions, Telegram notifications, AI summarization

### Key protocol flow
```
Client -> { type: 'session:create', projectId, mode, ... }
Server -> { type: 'session:created', session: {...} }
Server -> { type: 'sessions:list', sessions: [...] }        (broadcast)
Client -> { type: 'session:subscribe', id, cols, rows }
Server -> { type: 'session:subscribed', id }                 (client calls xterm.reset() here)
Server -> { type: 'session:output', id, data }               (live PTY stream)
Client -> { type: 'session:input', id, data }                (keyboard)
Client -> { type: 'session:resize', id, cols, rows }
Client -> { type: 'session:refresh', id }
Server -> { type: 'session:refreshed', session: {...} }
Client -> { type: 'session:stop', id }
Server -> { type: 'session:state', id, state }               (broadcast)
Client -> { type: 'session:delete', id }
```

### State transitions (from sessionStates.js)
```
CREATED  -> [STARTING]
STARTING -> [RUNNING, ERROR, STOPPED]
RUNNING  -> [STOPPING, ERROR, STOPPED]
STOPPING -> [STOPPED, ERROR]
STOPPED  -> [STARTING]
ERROR    -> [STARTING]
```

---

## Test File Map

| Category | File | Approach | Parallel Group |
|----------|------|----------|----------------|
| A: Session Lifecycle | `tests/adversarial/a-session-lifecycle.test.js` | Jest + mocked PTY | Group 1 |
| B: Terminal Rendering | `tests/adversarial/b-terminal-rendering.test.js` | Playwright + real server + bash | Group 1 |
| C: WS Protocol | `tests/adversarial/c-ws-protocol.test.js` | Jest + real HTTP/WS server + raw WS client | Group 1 |
| D: Reconnect & Persistence | `tests/adversarial/d-reconnect-persistence.test.js` | Playwright + real server | Group 1 |
| E: Watchdog Stress | `tests/adversarial/e-watchdog-stress.test.js` | Jest unit (no tmux/network) | Group 1 |
| F: Haiku Endurance | `tests/adversarial/f-haiku-endurance.test.js` | Playwright + real Claude haiku | Group 2 (sequential) |
| G: Adversarial Edge | `tests/adversarial/g-adversarial-edge.test.js` | Mixed: Jest + Playwright + raw WS | Group 1 |

---

## Existing Test Coverage (DO NOT DUPLICATE)

The following are already covered in `tests/unit/` and `tests/integration/`. New tests must go BEYOND these:

**Already covered in unit tests:**
- SessionManager: basic create/stop/refresh/delete, state transitions, event forwarding, store persistence
- DirectSession: constructor, start/stop/write/resize, _buildArgs, _wirePty stubs
- TmuxSession: constructor, tmuxName generation, start/stop, _attachPty stubs, state transitions
- SessionStore: load/save/upsert/remove, corruption recovery, missing file handling
- WatchdogManager: constructor, start/stop, state persistence, restart counters, rate limit, MCP check, context tokens, resources, Telegram stub, activity logs, learnings, error loop detection, low-power mode, summarizeSession, tick basics, _checkSession basics
- Others: ProjectStore CRUD, SettingsStore, TerminalManager, ProcessDetector, TodoManager

**Already covered in integration tests:**
- WS protocol: init handshake, sessions:list on connect, session:create -> session:created, session:subscribe -> session:subscribed, subscribe to unknown -> session:error, session:input -> write, session:stop -> stopped + sessions:list broadcast, invalid JSON survival, no-type message handling
- Session lifecycle: create -> running, start called once, sessionCreated event, multiple unique IDs, project validation, store persistence, write/resize delegation, subscribe/unsubscribe viewers, live output forwarding, stop/refresh/delete transitions, state machine enforcement, full lifecycle end-to-end

**Already covered in e2e tests:**
- Scrollback dots bug: v1 vs v2 comparison (bullet chars after restart)

### What is NOT covered (our targets):
- Race conditions (concurrent creates, rapid subscribe/unsubscribe)
- Session name edge cases
- Multiple clients on same session
- Double-subscribe behavior
- Client disconnect cleanup verification
- Watchdog with bad API key crash regression
- Watchdog memory leak under rapid ticks
- Large output handling
- Binary data through terminal
- Corrupted sessions.json mid-run
- External tmux kill
- Server restart recovery
- Browser resize -> PTY resize propagation
- Real Claude haiku conversation endurance

---

## Category A: Session Lifecycle

**File:** `tests/adversarial/a-session-lifecycle.test.js`
**Approach:** Jest with mocked DirectSession/TmuxSession PTY (same mock pattern as existing `tests/integration/sessionLifecycle.test.js`). Real SessionManager, real SessionStore, real state machine. Temp data dir per test.
**Setup:** `beforeEach` creates temp dir, initializes ProjectStore with a test project, constructs SessionManager.
**Teardown:** `afterEach` stops all sessions, removes temp dir.

### A.01 — Create direct session with default params
- **Steps:** Call `sessions.create({ projectId: testProject.id })`
- **Pass:** Returns meta with `id`, `mode: 'direct'`, `status: 'running'`, `projectId` matches, `claudeSessionId` is a UUID
- **Adversarial angle:** Could the default command be empty/null? Does `claude` binary name survive?

### A.02 — Create tmux session with default params
- **Steps:** Call `sessions.create({ projectId: testProject.id, mode: 'tmux' })`
- **Pass:** Returns meta with `mode: 'tmux'`, `tmuxName` starts with `cm-`, `status: 'running'`
- **Adversarial angle:** Does tmuxName generation fail if UUID contains special chars?

### A.03 — Create session with custom name
- **Steps:** `sessions.create({ projectId: testProject.id, name: 'My Test Session' })`
- **Pass:** `meta.name === 'My Test Session'`
- **Adversarial angle:** Name with unicode, spaces, quotes -- does it survive JSON roundtrip?

### A.04 — Create session with empty string name
- **Steps:** `sessions.create({ projectId: testProject.id, name: '' })`
- **Pass:** `meta.name` is `''` or `null` (not undefined). Session still works.
- **Adversarial angle:** Empty string should not crash. Check it's stored and retrievable.

### A.05 — Create session with very long name (1000 chars)
- **Steps:** `sessions.create({ projectId: testProject.id, name: 'A'.repeat(1000) })`
- **Pass:** Session creates successfully. Name is stored. No truncation error.
- **Adversarial angle:** Could overflow JSON serialization? Could tmux name exceed shell limits?

### A.06 — Create session with special chars in name
- **Steps:** Names to try: `"test 'quotes' \"double\""`, `"rm -rf / && echo pwned"`, `"$(whoami)"`, `"\`id\`"`, `"<script>alert(1)</script>"`, `"name\nwith\nnewlines"`, `"emoji: \u{1F600}\u{1F4A9}"`
- **Pass:** All create successfully. Name stored exactly. No shell injection, no XSS. Verify via `sessions.get(id).name`.
- **Adversarial angle:** Session name could be interpolated into tmux commands or HTML. This is a security test.

### A.07 — Create session with duplicate name
- **Steps:** Create two sessions with `name: 'duplicate'`
- **Pass:** Both succeed with different IDs. `sessions.list()` contains both.
- **Adversarial angle:** Is name used as a key anywhere? Could it collide?

### A.08 — Create session with nonexistent projectId
- **Steps:** `sessions.create({ projectId: 'nonexistent-uuid' })`
- **Pass:** Throws `"Project not found"`. No session created. `sessions.list().length` unchanged.
- **Adversarial angle:** Could a partial session be left in the Map on error?

### A.09 — Create session with null projectId
- **Steps:** `sessions.create({ projectId: null })`
- **Pass:** Throws. No crash. No orphan session.
- **Adversarial angle:** `projectStore.get(null)` might not throw -- it might return undefined silently.

### A.10 — Create session with undefined projectId
- **Steps:** `sessions.create({})`
- **Pass:** Throws. No crash.
- **Adversarial angle:** Destructuring `{ projectId }` yields `undefined`.

### A.11 — Create session with custom command containing --model flag
- **Steps:** `sessions.create({ projectId: id, command: 'claude --model claude-haiku-4-5-20251001' })`
- **Pass:** `meta.command` contains `--model claude-haiku-4-5-20251001`. Flag preserved through `_buildClaudeCommand`.
- **Adversarial angle:** Does `_buildClaudeCommand` strip unknown flags? Does it preserve order?

### A.12 — Create session with custom command containing --effort flag
- **Steps:** `sessions.create({ projectId: id, command: 'claude --effort low' })`
- **Pass:** `meta.command` contains `--effort low`.
- **Adversarial angle:** What if --effort has no value after it?

### A.13 — Create session with Telegram enabled
- **Steps:** `sessions.create({ projectId: id, telegram: true })`
- **Pass:** `meta.telegramEnabled === true`. Command includes `--channels plugin:telegram@claude-plugins-official`.
- **Adversarial angle:** Does duplicate --channels flag get added if command already has one?

### A.14 — Create session with cols=0, rows=0
- **Steps:** `sessions.create({ projectId: id, cols: 0, rows: 0 })`
- **Pass:** Either uses default (120x30) or throws a clear error. Must NOT crash node-pty.
- **Adversarial angle:** node-pty with 0x0 could segfault or throw.

### A.15 — Create session with negative cols/rows
- **Steps:** `sessions.create({ projectId: id, cols: -1, rows: -5 })`
- **Pass:** Error or defaults applied. No crash.
- **Adversarial angle:** Negative values passed to pty.spawn could cause undefined behavior.

### A.16 — Create session with huge cols/rows (10000x10000)
- **Steps:** `sessions.create({ projectId: id, cols: 10000, rows: 10000 })`
- **Pass:** Either works (terminal is big) or throws a clear error. No OOM.
- **Adversarial angle:** PTY with 10000 cols could allocate large buffers.

### A.17 — Stop a running direct session
- **Steps:** Create session, verify running, call `sessions.stop(id)`
- **Pass:** Status transitions to `stopped`. `session.stop()` called. Store persisted.
- **Adversarial angle:** Is there a race between onExit callback and explicit stop?

### A.18 — Stop a running tmux session
- **Steps:** Create tmux session, verify running, call `sessions.stop(id)`
- **Pass:** Status `stopped`. tmux session killed. PTY nulled.
- **Adversarial angle:** What if tmux kill-session fails (already dead)?

### A.19 — Stop an already-stopped session
- **Steps:** Create, stop, stop again
- **Pass:** Second stop either throws (transition error) or is a no-op. No crash.
- **Adversarial angle:** `stop()` on DirectSession only transitions from RUNNING/STARTING. What happens from STOPPED?

### A.20 — Stop a session in ERROR state
- **Steps:** Force a session into ERROR state, then stop
- **Pass:** Either transitions to STOPPED or throws. No crash.
- **Adversarial angle:** ERROR -> STOPPING is not in the transition table. ERROR -> STARTING is, but not STOPPING.

### A.21 — Delete a running session
- **Steps:** Create session, don't stop, call `sessions.delete(id)`
- **Pass:** Session stopped first, then removed. `sessions.exists(id) === false`. Store persisted.
- **Adversarial angle:** Delete calls stop internally -- what if stop throws?

### A.22 — Delete a stopped session
- **Steps:** Create, stop, delete
- **Pass:** Session removed. No double-stop attempt.
- **Adversarial angle:** The `isLive` check should be false for STOPPED, so stop() is skipped.

### A.23 — Delete a nonexistent session
- **Steps:** `sessions.delete('nonexistent-id')`
- **Pass:** No-op. No throw. (Code has `if (!session) return;`)
- **Adversarial angle:** Could the store.remove() call fail for nonexistent ID?

### A.24 — Refresh a running direct session
- **Steps:** Create direct session, call `sessions.refresh(id)`
- **Pass:** Old PTY killed, new PTY spawned. Session returns to RUNNING. Meta updated.
- **Adversarial angle:** DirectSession.refresh() requires RUNNING state -- what if PTY died between create and refresh?

### A.25 — Refresh a running tmux session (tmux alive)
- **Steps:** Create tmux session, call `sessions.refresh(id)`
- **Pass:** PTY detached and re-attached. State stays RUNNING. stateChange emitted.
- **Adversarial angle:** _attachPty is "idempotent" but what if old PTY is still draining?

### A.26 — Refresh a tmux session with dead tmux
- **Steps:** Create tmux session, externally kill tmux (`tmux kill-session`), call `sessions.refresh(id)`
- **Pass:** New tmux session created with `--resume`. Status transitions STOPPED -> STARTING -> RUNNING.
- **Adversarial angle:** The dead path resets status to STOPPED before calling start(). What if status was already ERROR?

### A.27 — Refresh a stopped direct session (should fail)
- **Steps:** Create, stop, refresh
- **Pass:** Throws `"Cannot refresh direct session ... status=stopped"`.
- **Adversarial angle:** DirectSession.refresh() explicitly checks for RUNNING. But SessionManager.subscribe() has auto-resume for stopped direct sessions -- is there a conflict?

### A.28 — Create 10 sessions sequentially
- **Steps:** Loop 10 creates with unique names
- **Pass:** All 10 in `sessions.list()`. All have unique IDs. All RUNNING.
- **Adversarial angle:** Does UUID collision ever happen? Are there file descriptor leaks?

### A.29 — Create 10 sessions concurrently (Promise.all)
- **Steps:** `Promise.all(Array.from({length:10}, (_, i) => sessions.create({...})))`
- **Pass:** All 10 created. No duplicate IDs. Store has all 10.
- **Adversarial angle:** Concurrent store.save() calls could race -- last write wins, losing earlier sessions.

### A.30 — Rapid create-then-delete cycle (100 iterations)
- **Steps:** Loop 100 times: create session, immediately delete it
- **Pass:** After loop: `sessions.list().length === 0`. No orphan PTYs. No leaked tmux sessions.
- **Adversarial angle:** If delete fires before start() resolves, session could be half-created.

### A.31 — Create session while another is being stopped (concurrency)
- **Steps:** Create session A. Call `sessions.stop(A.id)` and `sessions.create({...})` concurrently.
- **Pass:** Both complete without error. Session A stopped, new session B running.
- **Adversarial angle:** Store save race -- could stop's save() overwrite create's save()?

### A.32 — Subscribe to a running session
- **Steps:** Create session, call `sessions.subscribe(id, 'client-1', callback)`
- **Pass:** Callback registered. `session.addViewer` called with clientId and callback.
- **Adversarial angle:** Subscribe for direct session triggers auto-resume if PTY is gone. Race?

### A.33 — Subscribe to a stopped direct session (auto-resume)
- **Steps:** Create direct session, stop it, subscribe
- **Pass:** Session auto-resumes (start called). Status returns to RUNNING. Viewer registered.
- **Adversarial angle:** What if start() fails during auto-resume? Does subscribe still complete?

### A.34 — Subscribe to a session in ERROR state (auto-resume)
- **Steps:** Force session to ERROR, subscribe
- **Pass:** Auto-resume attempted. If start fails, session stays in ERROR, no throw.
- **Adversarial angle:** The auto-resume code checks `!session.pty && (STOPPED || ERROR)`. What if pty is non-null but broken?

### A.35 — Unsubscribe from a session
- **Steps:** Subscribe then unsubscribe
- **Pass:** Viewer removed. No more output delivered to that callback.
- **Adversarial angle:** Unsubscribe from a session you're not subscribed to -- silent no-op?

### A.36 — Unsubscribe from nonexistent session
- **Steps:** `sessions.unsubscribe('fake-id', 'client-1')`
- **Pass:** No crash. (Code has `if (session)` guard.)
- **Adversarial angle:** Could this leave stale state in clientRegistry?

### A.37 — Write to a running session
- **Steps:** Create, write `'hello\n'`
- **Pass:** `session.write('hello\n')` called.
- **Adversarial angle:** What if PTY is not yet attached (STARTING state)?

### A.38 — Write to a stopped session
- **Steps:** Create, stop, write
- **Pass:** Write is a no-op (DirectSession.write checks `status !== RUNNING`). No crash.
- **Adversarial angle:** Data silently dropped. Should there be an error event?

### A.39 — Resize a session
- **Steps:** Create, resize to 200x50
- **Pass:** `session.resize(200, 50)` called.
- **Adversarial angle:** Does tmux window resize as well? (TmuxSession only resizes the PTY, not `tmux resize-window`.)

### A.40 — List sessions returns copies (not mutable references)
- **Steps:** `const list = sessions.list(); list[0].name = 'mutated';`
- **Pass:** `sessions.get(id).name` is unchanged. (Code uses `{...s.meta}` spread.)
- **Adversarial angle:** Shallow copy -- nested objects could still be shared.

### A.41 — Init with empty sessions.json
- **Steps:** Create empty sessions.json, call `sessions.init()`
- **Pass:** `sessions.list()` returns `[]`. No crash.
- **Adversarial angle:** Empty file vs empty array `[]` vs `{}`.

### A.42 — Init with corrupted sessions.json (invalid JSON)
- **Steps:** Write `"not json {{{" ` to sessions.json, call `sessions.init()`
- **Pass:** Returns empty. No crash. Server starts normally.
- **Adversarial angle:** Load returns `[]` on parse error. But does init() handle that gracefully?

### A.43 — Init with sessions.json containing unknown status values
- **Steps:** Write `[{"id":"x","status":"shell","mode":"direct"}]` to sessions.json
- **Pass:** Status migrated to `stopped`. (Code: `if (!knownStatuses.includes(meta.status)) meta.status = STATES.STOPPED`)
- **Adversarial angle:** What if mode is also unknown? What if id is missing?

### A.44 — Init with sessions.json containing running direct session (auto-resume)
- **Steps:** Write `[{"id":"x","status":"running","mode":"direct",...}]`, init
- **Pass:** Session auto-resumed (start called). If start fails, status set to ERROR.
- **Adversarial angle:** The init code resets to STOPPED before start. What if the session class constructor already set CREATED?

### A.45 — Init with sessions.json containing running tmux session (re-attach)
- **Steps:** Write running tmux session to sessions.json, init (no actual tmux session exists)
- **Pass:** `_attachPty()` fails gracefully (tmux session not alive). Status set to ERROR.
- **Adversarial angle:** `_attachPty` has `if (!this._tmuxSessionAlive()) return;` -- so it silently returns, but status stays RUNNING.

### A.46 — _buildClaudeCommand preserves --model and --effort, strips everything else
- **Steps:** `_buildClaudeCommand('claude --model sonnet --verbose --effort high --resume abc', [])`
- **Pass:** Returns `'claude --model sonnet --effort high'`. No --verbose, no --resume.
- **Adversarial angle:** What about `--channels` flag? (It IS preserved per the code.) What about flags with no value?

### A.47 — _buildResumeCommand includes --resume and --channels
- **Steps:** Session with `claudeSessionId` and `telegramEnabled: true`
- **Pass:** Command includes `--resume <id>` and `--channels plugin:telegram@claude-plugins-official`
- **Adversarial angle:** What if command already has `--channels`? (Code checks `!cmd.includes('--channels')`)

### A.48 — Session stateChange events forwarded to manager
- **Steps:** Create session, collect all `sessionStateChange` events from manager
- **Pass:** Events include `{ id, state: 'starting' }` and `{ id, state: 'running' }`.
- **Adversarial angle:** Are events emitted before or after store persistence?

### A.49 — Multiple sessions list() ordering
- **Steps:** Create 5 sessions with delays, list
- **Pass:** All 5 present. Order is insertion order (Map iteration order).
- **Adversarial angle:** Could delete + re-create change ordering?

### A.50 — Session meta includes createdAt timestamp
- **Steps:** Create session, check meta
- **Pass:** `createdAt` is a valid ISO 8601 string.
- **Adversarial angle:** Is timezone consistent? Is it set before or after start()?

---

## Category B: Terminal Rendering

**File:** `tests/adversarial/b-terminal-rendering.test.js`
**Approach:** Playwright with real server (bash sessions, no Claude binary needed). Server started on ephemeral port with temp data dir. Sessions created via WS protocol. Tests use `page.evaluate()` to inspect xterm state.
**Setup:** Start server, create project via REST API, launch browser.
**Teardown:** Close browser, kill server, remove temp dir.

**Session command:** `bash` (fast, deterministic, no API key needed).

### B.01 — Terminal mounts and has content after session create
- **Steps:** Navigate to app, create a bash session, attach to it. Wait for terminal to appear.
- **Pass:** `.terminal-container` is visible. `xterm.buffer.active.length > 0`.
- **Adversarial angle:** Could terminal mount before WS subscribe completes?

### B.02 — Terminal width matches container on first load
- **Steps:** Create session, measure container width in px, calculate expected cols from font metrics.
- **Pass:** `fitAddon.proposeDimensions().cols` is within 2 of expected. PTY was resized to match.
- **Adversarial angle:** Font not loaded yet -> wrong metrics. WebGL vs Canvas gives different sizes.

### B.03 — xterm.reset() fires on session:subscribed (no stale buffer)
- **Steps:** Create session, type `echo "MARKER_1"` into terminal. Refresh session. Check buffer after refresh.
- **Pass:** "MARKER_1" from before refresh is NOT in the terminal buffer. Buffer was cleared.
- **Adversarial angle:** If session:subscribed arrives after some output, buffer has new data but old data cleared.

### B.04 — No dot/bullet accumulation after multiple refreshes
- **Steps:** Create bash session. Run `printf '\\u2022 item %d\\n' 1 2 3`. Refresh 5 times.
- **Pass:** After each refresh, screenshot shows no bullet characters from previous buffer. Terminal has fresh bash prompt.
- **Adversarial angle:** xterm.reset() must clear scrollback. Some addons (WebGL) might cache rendered tiles.

### B.05 — Scroll position after large output
- **Steps:** Create session. Run `seq 1 1000` (1000 lines of output). Wait for output to complete.
- **Pass:** Terminal auto-scrolled to bottom. Last visible line contains "1000" or a bash prompt.
- **Adversarial angle:** onWriteParsed scroll handler: does `userScrolledUp` correctly detect bottom?

### B.06 — Scroll up pauses auto-scroll, new output does not yank to bottom
- **Steps:** Run `seq 1 100`. Scroll up 50 lines. Run `echo "NEW_OUTPUT"`.
- **Pass:** Viewport stays scrolled up. "NEW_OUTPUT" was written to buffer but viewport did not move.
- **Adversarial angle:** The scroll handler uses `Math.abs(scrollTop - (scrollHeight - clientHeight)) < 5`. Edge cases around this threshold.

### B.07 — Manual scroll to bottom re-enables auto-scroll
- **Steps:** Scroll up, then scroll all the way to bottom. Run `echo "BOTTOM_CHECK"`.
- **Pass:** "BOTTOM_CHECK" is visible at bottom of viewport. Auto-scroll resumed.
- **Adversarial angle:** Does `scrollToBottom()` set `userScrolledUp = false`?

### B.08 — Resize browser window triggers PTY resize
- **Steps:** Create session. Resize browser to 800x400. Wait 500ms. Check PTY dimensions.
- **Pass:** ResizeObserver fired. `session:resize` WS message sent. PTY cols/rows updated.
- **Adversarial angle:** ResizeObserver debouncing? What if fitAddon.fit() throws?

### B.09 — Resize to very narrow window (300px wide)
- **Steps:** Resize to 300x600.
- **Pass:** Terminal still renders. Cols adjusted (likely 30-40). No crash.
- **Adversarial angle:** Very small cols could break line wrapping in Claude output.

### B.10 — Resize to very wide window (3000px wide)
- **Steps:** Resize to 3000x800.
- **Pass:** Terminal uses full width. Cols > 200.
- **Adversarial angle:** Very large cols could cause PTY buffer allocation issues.

### B.11 — Unicode rendering: CJK characters
- **Steps:** Run `echo "中文测试 日本語 한국어"`
- **Pass:** Characters render without overlap or garble. Unicode11 addon loaded.
- **Adversarial angle:** Without Unicode11 before open(), CJK chars have wrong glyph width -> columns misaligned.

### B.12 — Unicode rendering: emoji
- **Steps:** Run `echo "Test: 🎉🔥💻🚀"`
- **Pass:** Emoji render (or show placeholder boxes). No terminal corruption.
- **Adversarial angle:** Some emoji are width-2 but reported as width-1 without Unicode11.

### B.13 — ANSI color rendering
- **Steps:** Run `echo -e "\\033[31mRED\\033[32mGREEN\\033[34mBLUE\\033[0m"`
- **Pass:** Text visible (not garbled). Screenshot shows different colors.
- **Adversarial angle:** WebGL renderer has different color handling than DOM.

### B.14 — Large output stress test: 10,000 lines
- **Steps:** Run `seq 1 10000`
- **Pass:** Terminal does not freeze. Scrollback contains lines. Last line "10000" reachable by scrolling. No OOM.
- **Adversarial angle:** xterm scrollback is 10000 lines. With 10000 lines of output, earliest lines may be evicted. This is expected -- test that scrollback cap works.

### B.15 — Large output stress test: 50,000 characters per line
- **Steps:** Run `python3 -c "print('A'*50000)"`
- **Pass:** Terminal does not crash. Line wraps are handled.
- **Adversarial angle:** Very long lines could exhaust renderer memory.

### B.16 — Alt-screen mode (less): enter and exit
- **Steps:** Run `echo "NORMAL_MODE_MARKER" && less /etc/passwd`. Wait. Press `q`.
- **Pass:** After quitting less, "NORMAL_MODE_MARKER" is visible in scrollback. Alt-screen content gone.
- **Adversarial angle:** Alt-screen bleed: if xterm doesn't properly switch, normal buffer gets overwritten.

### B.17 — DA/DA2 response filtering
- **Steps:** Subscribe to session. Monitor all `session:input` messages sent back to server.
- **Pass:** No messages matching `/^\x1b\[[\?]?\d+[;\d]*[cn]$/` are sent back to server.
- **Adversarial angle:** On session:subscribed, xterm replays scrollback which triggers DA responses. If not filtered, literal `?1;2c` appears in the terminal.

### B.18 — Terminal input: basic typing
- **Steps:** Type `echo hello` then press Enter.
- **Pass:** Command executed. "hello" appears in terminal output.
- **Adversarial angle:** Input events fire xterm.onData -> session:input -> PTY. Any encoding issues?

### B.19 — Terminal input: special keys (Ctrl+C, Ctrl+D, arrow keys)
- **Steps:** Run `cat` (blocking). Press Ctrl+C. Verify bash prompt returns.
- **Pass:** Ctrl+C sends `\x03`. Cat terminated. Prompt visible.
- **Adversarial angle:** Key mapping differences between browsers.

### B.20 — ReadOnly mode blocks input
- **Steps:** Mount TerminalPane with `readOnly: true`. Try typing.
- **Pass:** No `session:input` messages sent to server.
- **Adversarial angle:** `readOnly` only prevents onData subscription. Could clipboard paste bypass this?

### B.21 — WebGL -> Canvas -> DOM renderer fallback
- **Steps:** (Hard to test directly.) Verify that if WebGL context creation fails, Canvas is attempted. If both fail, DOM renderer is used.
- **Pass:** Terminal still renders text regardless of which renderer loaded.
- **Adversarial angle:** In headless Playwright, WebGL may not be available. Test should verify terminal works in all fallback scenarios.

### B.22 — Multiple terminals for different sessions
- **Steps:** Create 2 bash sessions. Attach to session A, type `echo "SESSION_A"`. Switch to session B, type `echo "SESSION_B"`.
- **Pass:** Each terminal shows its own content. No cross-contamination.
- **Adversarial angle:** Shared xterm state, event handlers not properly scoped to sessionId.

### B.23 — Session switch: old terminal disposed, new terminal created
- **Steps:** Attach to session A. Switch to session B. Check DOM.
- **Pass:** Only one `.terminal-container` in DOM. Old xterm disposed. session:unsubscribe sent for A, session:subscribe sent for B.
- **Adversarial angle:** If cleanup effect doesn't fire, old xterm leaks memory and event handlers.

### B.24 — Rapid session switching (10 times in 2 seconds)
- **Steps:** Switch between session A and B 10 times rapidly.
- **Pass:** Final terminal shows correct session. No stale event handlers. No error in console.
- **Adversarial angle:** Race between cleanup and new effect. Could subscribe/unsubscribe messages arrive out of order?

### B.25 — Terminal still functional after browser tab hidden + shown
- **Steps:** Navigate away (page.goto elsewhere), navigate back. Or minimize and restore.
- **Pass:** Terminal re-renders. Output still streaming. No blank screen.
- **Adversarial angle:** WebGL context can be lost when tab is backgrounded.

---

## Category C: WS Protocol

**File:** `tests/adversarial/c-ws-protocol.test.js`
**Approach:** Real HTTP+WS server on ephemeral port. Raw `ws` client (no browser). DirectSession mocked to avoid needing `claude` binary. Tests verify exact message types, ordering, and payloads.
**Setup:** Start server with mocked DirectSession, temp data dir. Create test project.
**Teardown:** Close all WS clients, stop server, remove temp dir.

### C.01 — Connect receives init then sessions:list in order
- **Steps:** Connect WS. Collect first 2 messages.
- **Pass:** Message 1: `type === 'init'`, has `clientId` (UUID), `serverVersion === '2.0.0'`. Message 2: `type === 'sessions:list'`, has `sessions` array.
- **Adversarial angle:** Are these guaranteed to arrive in order? (They're sent synchronously in server.js connection handler.)

### C.02 — session:create returns session:created then sessions:list broadcast
- **Steps:** Connect client A and client B. Client A sends `session:create`.
- **Pass:** Client A receives `session:created` with `session` object. Both A and B receive `sessions:list` broadcast.
- **Adversarial angle:** Does client B get the sessions:list even though it didn't create the session?

### C.03 — session:subscribe returns session:subscribed
- **Steps:** Create session, then send `{ type: 'session:subscribe', id }`.
- **Pass:** Receive `{ type: 'session:subscribed', id }`.
- **Adversarial angle:** Subscribe is async (it calls `sessions.subscribe` which may trigger auto-resume). Could the subscribed message arrive before the resume completes?

### C.04 — session:subscribe -> session:output ordering
- **Steps:** Create session (mock PTY emits "hello"). Subscribe.
- **Pass:** `session:subscribed` arrives BEFORE any `session:output`. Output arrives after.
- **Adversarial angle:** The viewer callback is registered BEFORE the subscribed message is sent. If PTY emits data between addViewer and the send(subscribed), output could arrive first.

### C.05 — Subscribe to unknown session returns session:error
- **Steps:** Send `{ type: 'session:subscribe', id: 'nonexistent' }`.
- **Pass:** Receive `{ type: 'session:error', id: 'nonexistent', error: 'Session not found: nonexistent' }`.
- **Adversarial angle:** Does the error include the bad ID? Is it the right error type (not a generic crash)?

### C.06 — Subscribe with cols and rows triggers resize
- **Steps:** Create session. Subscribe with `{ cols: 200, rows: 50 }`.
- **Pass:** `sessions.resize` called with (id, 200, 50).
- **Adversarial angle:** What if cols/rows are missing from the subscribe message? (Code: `if (msg.cols && msg.rows)` -- falsy check means 0 is treated as missing.)

### C.07 — Double subscribe to same session
- **Steps:** Subscribe to session A. Subscribe to session A again (same client).
- **Pass:** Second subscribe does NOT cause duplicate output. Only one viewer registered per clientId.
- **Adversarial angle:** `addViewer` uses `Map.set(clientId, cb)` which overwrites. But `registry.subscribe` adds to a Set (idempotent). Should be safe -- verify no output doubling.

### C.08 — session:input forwards data to PTY
- **Steps:** Create + subscribe. Send `{ type: 'session:input', id, data: 'test\n' }`.
- **Pass:** `sessions.write(id, 'test\n')` called.
- **Adversarial angle:** Input with no `id` field. Input with wrong `id`. Input with empty data.

### C.09 — session:input with missing id is a no-op
- **Steps:** Send `{ type: 'session:input', data: 'test' }` (no id).
- **Pass:** No crash. `sessions.write(undefined, ...)` calls `this.sessions.get(undefined)` which returns undefined -> early return.
- **Adversarial angle:** Could `undefined` key in Map behave unexpectedly?

### C.10 — session:resize with valid dimensions
- **Steps:** Send `{ type: 'session:resize', id, cols: 80, rows: 24 }`.
- **Pass:** `sessions.resize(id, 80, 24)` called.
- **Adversarial angle:** What about non-integer cols/rows? Strings like "80"?

### C.11 — session:stop transitions session and broadcasts
- **Steps:** Create session. Send `{ type: 'session:stop', id }`.
- **Pass:** Receive `sessions:list` with session status `stopped`. `session:state` broadcast with `state: 'stopped'`.
- **Adversarial angle:** Stop on already-stopped session?

### C.12 — session:refresh returns session:refreshed
- **Steps:** Create session. Send `{ type: 'session:refresh', id }`.
- **Pass:** Receive `{ type: 'session:refreshed', session: {...} }` and `sessions:list` broadcast.
- **Adversarial angle:** Refresh while session is being created? Refresh with cols/rows?

### C.13 — session:delete removes session and broadcasts
- **Steps:** Create session. Send `{ type: 'session:delete', id }`.
- **Pass:** Receive `sessions:list` without the deleted session. Session no longer subscribable.
- **Adversarial angle:** Delete while subscribed. Delete the session you're viewing.

### C.14 — Invalid JSON from client does not crash server
- **Steps:** Send raw bytes `"not json {{{"`
- **Pass:** Server logs warning. Connection stays open. Can send valid message afterward.
- **Adversarial angle:** Binary data, extremely large payload, null bytes.

### C.15 — Message with no type field is ignored
- **Steps:** Send `{ foo: 'bar' }`.
- **Pass:** Server logs warning. No crash. No response.
- **Adversarial angle:** Message with `type: ''` (empty string). Message with `type: null`.

### C.16 — Unknown message type is handled gracefully
- **Steps:** Send `{ type: 'session:nonexistent_action' }`.
- **Pass:** Server logs warning about unknown session action. No crash.
- **Adversarial angle:** Could trigger `undefined is not a function` if not guarded.

### C.17 — Unknown top-level type (not session: or terminal:) goes to systemHandlers
- **Steps:** Send `{ type: 'custom:action' }`.
- **Pass:** Routed to `systemHandlers.handle()`. No crash.
- **Adversarial angle:** If systemHandlers.handle doesn't exist or throws.

### C.18 — Client disconnect removes client from registry
- **Steps:** Connect, note clientId from init message. Close connection. Connect again.
- **Pass:** New clientId is different. Old clientId no longer in registry.
- **Adversarial angle:** Does the close handler run if client disconnects uncleanly (no close frame)?

### C.19 — Client disconnect unsubscribes from all sessions
- **Steps:** Connect, create session, subscribe to it. Disconnect.
- **Pass:** Viewer removed from session. (server.js close handler iterates client.subscriptions and calls removeViewer.)
- **Adversarial angle:** removeViewer is on TerminalManager, not SessionManager. The server.js close handler calls `terminals.removeViewer` but NOT `sessions.unsubscribe`. Is session viewer cleanup missing?

### C.20 — Multiple clients subscribed to same session
- **Steps:** Connect client A and B. Both subscribe to same session. Session emits output.
- **Pass:** Both A and B receive `session:output` with the same data.
- **Adversarial angle:** Viewer Map keys by clientId. If both clients have viewers, both should get callbacks.

### C.21 — Client A unsubscribes, client B still receives output
- **Steps:** A and B subscribe to session. A sends `session:unsubscribe`. Session emits output.
- **Pass:** B receives output. A does not.
- **Adversarial angle:** Does unsubscribe properly remove only A's viewer?

### C.22 — Rapid subscribe/unsubscribe cycle (50 times)
- **Steps:** Loop 50 times: subscribe, unsubscribe.
- **Pass:** No memory leak. Final state: not subscribed. Session has 0 viewers.
- **Adversarial angle:** Race between subscribe response and unsubscribe. Could leave stale subscriptions in registry.

### C.23 — 20 clients connect simultaneously
- **Steps:** Open 20 WS connections in parallel.
- **Pass:** All 20 receive init messages with unique clientIds. All 20 receive sessions:list.
- **Adversarial angle:** Could the clientRegistry run out of memory? UUID collision?

### C.24 — session:state broadcast goes to ALL clients
- **Steps:** Connect 3 clients. One creates a session. Check that all 3 receive state changes.
- **Pass:** All 3 clients receive `session:state` messages during session lifecycle.
- **Adversarial angle:** Broadcast iterates all clients. What if one client's WS is in CLOSING state?

### C.25 — session:create auto-subscribes creating client
- **Steps:** Client sends `session:create`. Check if `session:output` messages arrive without explicit subscribe.
- **Pass:** Creating client receives output automatically. (sessionHandlers.create auto-subscribes.)
- **Adversarial angle:** What if client disconnects between create and auto-subscribe?

### C.26 — Binary data in session:input
- **Steps:** Send `{ type: 'session:input', id, data: '\x00\x01\x02\xff' }`.
- **Pass:** Data forwarded to PTY as-is. Server doesn't crash.
- **Adversarial angle:** JSON encoding of binary data. `\x00` in JSON strings.

### C.27 — Very large session:input (1MB)
- **Steps:** Send `{ type: 'session:input', id, data: 'A'.repeat(1_000_000) }`.
- **Pass:** Server accepts or rejects cleanly. No crash. No hang.
- **Adversarial angle:** No message size limit on WS server. Could exhaust memory.

### C.28 — 100 rapid session:input messages
- **Steps:** Send 100 input messages in quick succession.
- **Pass:** All 100 forwarded to PTY. No lost messages. No crash.
- **Adversarial angle:** Backpressure on the PTY write? Could writes queue up?

### C.29 — session:create with all optional fields missing
- **Steps:** Send `{ type: 'session:create', projectId: id }` (no name, mode, cols, rows, command, telegram).
- **Pass:** Session created with defaults: mode=direct, cols=120, rows=30, name=null.
- **Adversarial angle:** Destructuring defaults in SessionHandlers.create.

### C.30 — Concurrent session:create and session:delete for same project
- **Steps:** Send create and delete (for a different existing session) simultaneously.
- **Pass:** Both complete. New session created. Old session deleted.
- **Adversarial angle:** Store save race condition.

---

## Category D: Reconnect & Persistence

**File:** `tests/adversarial/d-reconnect-persistence.test.js`
**Approach:** Playwright with real server on ephemeral port. Real bash sessions.
**Setup:** Start server, create project + session.
**Teardown:** Kill server, remove temp dir.

### D.01 — Browser reload: session visible after page refresh
- **Steps:** Create session. `page.reload()`. Wait for page to load.
- **Pass:** Session appears in UI. sessions:list contains the session.
- **Adversarial angle:** Does the server's init handler send sessions:list on new connection?

### D.02 — Browser reload: terminal reconnects via WS
- **Steps:** Create bash session, type `echo "BEFORE_RELOAD"`. Reload page. Attach to session.
- **Pass:** Terminal is functional. Can type new commands. (For tmux: old scrollback replayed. For direct: new PTY, but session is same.)
- **Adversarial angle:** On reload, old WS closes -> client disconnect handler runs -> viewer removed. New WS connects -> init + sessions:list. User clicks session -> subscribe -> session:subscribed -> xterm.reset().

### D.03 — Browser reload: no stale event handlers
- **Steps:** Reload 5 times. After each reload, verify no console errors about detached handlers.
- **Pass:** No errors. No duplicate output.
- **Adversarial angle:** Each reload creates a new TerminalPane effect. If cleanup doesn't fire, old handlers accumulate.

### D.04 — WS disconnect: auto-reconnect fires
- **Steps:** Create session. Force-close the WS connection (inject `ws.close()` client-side). Wait 4 seconds.
- **Pass:** New WS connection established. `connection:open` event fires. Terminal re-subscribes.
- **Adversarial angle:** RECONNECT_DELAY is 3000ms. Test must wait at least that long.

### D.05 — WS disconnect: terminal resumes live output
- **Steps:** Attach to bash session. Force-close WS. Wait for reconnect. Run `echo "AFTER_RECONNECT"`.
- **Pass:** "AFTER_RECONNECT" appears in terminal.
- **Adversarial angle:** On reconnect, handleReconnect() calls xterm.reset() then re-subscribes. Could miss output between disconnect and reconnect.

### D.06 — Server restart: sessions.json survives
- **Steps:** Create 2 sessions. Kill server. Read sessions.json from temp dir.
- **Pass:** sessions.json contains both sessions with correct status.
- **Adversarial angle:** If server crashes (SIGKILL), last save might be incomplete. Atomic write (tmp + rename) should protect.

### D.07 — Server restart: sessions visible after restart
- **Steps:** Create 2 sessions. Kill server. Start server again (same data dir). Connect browser.
- **Pass:** sessions:list contains both sessions. (Status may be stopped for direct sessions.)
- **Adversarial angle:** Tmux sessions survive server restart (tmux is external process). Direct sessions die with the server.

### D.08 — Server restart: tmux session reconnects
- **Steps:** Create tmux bash session. Kill server. Start server. Navigate browser.
- **Pass:** Tmux session re-attached via init(). Session status is running. Terminal shows output.
- **Adversarial angle:** Server init calls `_attachPty()` for running tmux sessions. What if tmux died too?

### D.09 — Server restart: direct session marked as stopped
- **Steps:** Create direct session. Kill server. Start server.
- **Pass:** Direct session was running but PTY died with server. On restart, auto-resume attempted.
- **Adversarial angle:** Auto-resume spawns a new PTY. If claude binary not available, session goes to ERROR.

### D.10 — Server restart: unknown status in sessions.json migrated
- **Steps:** Write session with `status: 'shell'` (legacy v1 value) to sessions.json. Start server.
- **Pass:** Session loaded with `status: 'stopped'`. No crash.
- **Adversarial angle:** Any string not in STATES gets migrated to stopped.

### D.11 — sessions.json corrupted mid-run: server survives
- **Steps:** Start server. While running, overwrite sessions.json with garbage. Trigger a save (create new session).
- **Pass:** Save overwrites the garbage. New sessions.json is valid. Server did not crash.
- **Adversarial angle:** Save reads nothing from existing file (it writes from in-memory Map). But what about concurrent load/save?

### D.12 — sessions.json deleted mid-run: server survives
- **Steps:** Delete sessions.json while server running. Trigger a save.
- **Pass:** New sessions.json created. All in-memory sessions persisted.
- **Adversarial angle:** mkdir recursive ensures data dir exists.

### D.13 — Multiple browser tabs: both see same sessions
- **Steps:** Open 2 tabs. Create session in tab 1.
- **Pass:** Tab 2 receives `sessions:list` broadcast. Both tabs show the session.
- **Adversarial angle:** Each tab is a separate WS client with separate clientId.

### D.14 — Multiple browser tabs: both can subscribe to same session
- **Steps:** Both tabs attach to same session.
- **Pass:** Both receive output. Typing in one tab shows up in both.
- **Adversarial angle:** Multiple viewers on same session.

### D.15 — Browser back/forward navigation
- **Steps:** Navigate to session, press browser back, press forward.
- **Pass:** Terminal reconnects on forward navigation. No blank screen.
- **Adversarial angle:** SPA routing. Does the fallback route handler serve index.html?

---

## Category E: Watchdog Stress

**File:** `tests/adversarial/e-watchdog-stress.test.js`
**Approach:** Jest unit tests. Real WatchdogManager class. All tmux/network calls stubbed. No actual tmux sessions.
**Setup:** Temp data dir. Stub `execSync`, `https.request`. Fresh WatchdogManager instance.
**Teardown:** Stop watchdog, remove temp dir.

### E.01 — Watchdog tick with no tmux sessions alive
- **Steps:** Create watchdog. Stub `tmuxSessionExists` to return false for all sessions. Call `tick()`.
- **Pass:** Tick completes. `tick` event emitted. No crash.
- **Adversarial angle:** Dead session + no restart pause -> attempts restart. Restart also fails (stubbed). Should handle gracefully.

### E.02 — Watchdog tick with all tmux sessions alive
- **Steps:** Stub `tmuxSessionExists` true, `tmuxCapture` returns normal output, `tmuxPanePid` returns a PID.
- **Pass:** Tick completes. Restart counters reset. No restart attempted.
- **Adversarial angle:** What if capture returns empty string?

### E.03 — Watchdog tick with rate-limited session
- **Steps:** Stub capture to include "rate limit" text.
- **Pass:** Rate limit detected. Notification sent. Session not restarted.
- **Adversarial angle:** Rate limit detection regex edge cases.

### E.04 — Watchdog tick with credits exhausted
- **Steps:** Set `_creditState = 'exhausted'`. Call `tick()`.
- **Pass:** Tick short-circuits. No session checks. `tick` event emitted with `creditState: 'exhausted'`.
- **Adversarial angle:** Credit check cooldown. If cooldown expired, should check credits and potentially resume.

### E.05 — Watchdog tick with bad API key (regression test)
- **Steps:** Stub `_callClaude` or `checkCredits` to throw an Error. Call `tick()`.
- **Pass:** Error caught. `error` event emitted. Server does NOT crash. Next tick still works.
- **Adversarial angle:** THIS IS THE REGRESSION. The original crash bug was an unhandled rejection in the tick loop.

### E.06 — Watchdog tick: _checkSession with dead session and restart paused
- **Steps:** Set restart count above RESTART_PAUSE_AFTER. Stub session as dead.
- **Pass:** No restart attempted. `restart_paused` event emitted.
- **Adversarial angle:** Restart pause expiry logic.

### E.07 — Watchdog tick: _checkSession with dead MCP
- **Steps:** Stub session alive, MCP not alive.
- **Pass:** PID killed, session restarted.
- **Adversarial angle:** What if kill fails? What if _startSession also fails?

### E.08 — 50 rapid ticks: no memory leak
- **Steps:** Call `tick()` 50 times sequentially.
- **Pass:** `_tickCount === 50`. No growing arrays/Maps. Memory usage stable.
- **Adversarial angle:** Each tick loads state, checks sessions, saves state. File I/O 50 times. Activity log entries capped.

### E.09 — 50 rapid ticks concurrently: re-entrant guard works
- **Steps:** Call `tick()` 50 times via `Promise.all()`.
- **Pass:** Only 1 tick actually executes (re-entrant guard: `if (this._ticking) return`). `_tickCount` is 1 (or very low).
- **Adversarial angle:** The `_ticking` flag is set synchronously. But `tick()` is async. Could two ticks start before the first sets the flag?

### E.10 — Watchdog start/stop lifecycle
- **Steps:** `start()`, verify timer set. `stop()`, verify timer cleared. `start()` again.
- **Pass:** No leaked timers. Second start works.
- **Adversarial angle:** Double start: first start sets timer, second start should clear old timer before setting new one.

### E.11 — Watchdog enabled/disabled via settings
- **Steps:** Create watchdog with settingsStore. Set `watchdog.enabled = false`. Verify tick is a no-op.
- **Pass:** (Note: The current code doesn't check settings in tick. This test may FAIL, revealing a missing feature.)
- **Adversarial angle:** Settings-based enable/disable may not be implemented yet.

### E.12 — Watchdog state persistence: save and load round-trip
- **Steps:** Set restart counts, credit state. `_saveState()`. Create new watchdog from same dir. `_loadState()`.
- **Pass:** Restart counts and credit state preserved.
- **Adversarial angle:** State file corruption. Missing fields.

### E.13 — Watchdog state persistence: corrupt state file
- **Steps:** Write invalid JSON to watchdog-state.json. Call `_loadState()`.
- **Pass:** No crash. Falls through to defaults.
- **Adversarial angle:** Partial JSON, empty file, binary data.

### E.14 — Activity log rotation: max entries enforced
- **Steps:** Append 250 log entries (MAX_LOG_ENTRIES is 200). Read log.
- **Pass:** Log has at most 200 entries. Oldest entries trimmed.
- **Adversarial angle:** Is the rotation applied on write or read?

### E.15 — Learnings: max entries enforced (150)
- **Steps:** Add 200 learnings.
- **Pass:** `getLearnings()` returns at most 150.
- **Adversarial angle:** FIFO or LIFO eviction?

### E.16 — Error loop detection: 2 consecutive error_loop states with same fingerprint
- **Steps:** Record 2 inflight entries with `state: 'error_loop'` and same fingerprint.
- **Pass:** `_detectErrorLoop` returns non-null.
- **Adversarial angle:** Exactly at threshold (2). One below (1) should return null.

### E.17 — Low-power mode: AI failures trigger low-power
- **Steps:** Call `_recordAiFailure()` LOW_POWER_AI_FAIL_THRESHOLD times.
- **Pass:** `isLowPower()` returns true. `_callClaude` rejects.
- **Adversarial angle:** Does `_recordAiSuccess` reset the counter?

### E.18 — Watchdog broadcasts tick to clientRegistry
- **Steps:** Create watchdog with mock clientRegistry. Call `tick()`.
- **Pass:** `clientRegistry.broadcast` called with `{ type: 'watchdog:tick', ... }`.
- **Adversarial angle:** What if clientRegistry is null/undefined?

### E.19 — Watchdog getSummary returns correct structure
- **Steps:** Call `getSummary()`.
- **Pass:** Returns object with `tickCount`, `creditState`, `lowPower`, `sessions`, `sessionCount`.
- **Adversarial angle:** After 0 ticks vs after 50 ticks.

### E.20 — Watchdog resource check: disk full scenario
- **Steps:** Stub `execSync` for `df` to return 99% usage.
- **Pass:** `checkResources` returns alerts array with disk warning. `resourceAlert` event emitted.
- **Adversarial angle:** Different df output formats across OS versions.

### E.21 — killOrphanBuns does not crash with no bun processes
- **Steps:** Stub `execSync` for pkill to throw (no processes found).
- **Pass:** Returns 0. No crash.
- **Adversarial angle:** pkill exit code 1 means no processes matched.

### E.22 — sendTelegram handles network timeout gracefully
- **Steps:** Stub https.request to emit 'error'.
- **Pass:** Promise resolves to `false`. No crash.
- **Adversarial angle:** What if the callback never fires? (Timeout handling.)

### E.23 — summarizeSession with extremely long scrollback (100KB)
- **Steps:** Provide 100KB of captured pane text. Stub `_callClaude`.
- **Pass:** Text is truncated or handled. No OOM. Claude called with reasonable-length prompt.
- **Adversarial angle:** Does the summarize prompt include ALL text?

### E.24 — Watchdog with null/undefined dependencies
- **Steps:** Create WatchdogManager with `{}` (no sessionManager, no detector, etc.).
- **Pass:** Constructor succeeds. `tick()` may fail but emits error, not crash.
- **Adversarial angle:** Null pointer on `this.sessionManager.list()` in tick.

### E.25 — safeToInject edge cases
- **Steps:** Test with empty capture, capture with only whitespace, capture with "Listening" but also "timer".
- **Pass:** Correct boolean return for each case.
- **Adversarial angle:** Regex matching edge cases in terminal output.

---

## Category F: Haiku Endurance (THE MOST IMPORTANT)

**File:** `tests/adversarial/f-haiku-endurance.test.js`
**Approach:** Playwright + real server + real Claude haiku. Single long-running test (~10-15 minutes).
**Prerequisites:** `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` set. `claude` CLI installed.
**Setup:** Start server on port 3097. Create project at `/tmp/haiku-endurance-test/`. Create temp data dir.
**Teardown:** Kill server, clean up tmux sessions, remove temp dirs.

### Test Configuration

```javascript
const HAIKU_CONFIG = {
  port: 3097,
  projectPath: '/tmp/haiku-endurance-test/',
  sessionMode: 'tmux',  // tmux survives server restart
  command: 'claude --model claude-haiku-4-5-20251001',
  messageTimeout: 60_000,  // 60s per message (haiku is fast)
  serverStartTimeout: 10_000,
  sessionCreateTimeout: 30_000,
};
```

### Conversation Script

**System prompt (via first message):**
```
We are building a Python script together. The file is /tmp/haiku-endurance-test/counter.py. 
Each time I say NEXT, add one new function to the script (e.g., func_1, func_2, etc.) 
that prints its own name. After adding the function, respond with exactly:
DONE <N>
where <N> is the total number of functions in the script so far.
Do not include any other text in your response.
```

**Expected response pattern:** `/DONE\s+\d+/`

**Message sequence:**
Each "NEXT" message sends `NEXT\n` as terminal input (simulating user typing "NEXT" + Enter into Claude's prompt).

### F.01 — Phase 1: Initial conversation (5 messages)
- **Steps:**
  1. Create tmux session with haiku command and project path
  2. Wait for Claude prompt (detect `>` or similar prompt indicator in terminal output)
  3. Send the system prompt (first message explaining the task)
  4. Wait for DONE response
  5. Send "NEXT" 4 more times, waiting for "DONE <N>" after each (N = 2, 3, 4, 5)
- **Pass criteria:**
  - All 5 responses match `/DONE\s+[1-5]/`
  - counter.py exists and has 5 functions
  - Response time < 60s each
- **Adversarial angle:** Haiku might not follow the exact format. Allow fuzzy matching: "DONE 5", "DONE: 5", "Done 5".

### F.02 — Phase 2: Session refresh x3 (stress the PTY reconnect)
- **Steps:**
  1. Send `session:refresh` via WS
  2. Wait for `session:refreshed` response
  3. Wait for terminal to show content (Claude prompt)
  4. Send "NEXT", verify "DONE 6"
  5. Repeat refresh + NEXT for messages 7 and 8
- **Pass criteria:**
  - Each refresh completes in < 30s
  - Conversation continues (DONE 6, 7, 8) -- context not lost
  - No dot artifacts in terminal after refresh (take screenshot, check for unicode bullet chars)
  - Terminal width correct after each refresh (measure cols)
- **Adversarial angle:** Refresh kills PTY and re-attaches. Tmux replay could produce stale content. xterm.reset() should clear it.

### F.03 — Phase 3: More messages (5 more, total 13)
- **Steps:** Send NEXT 5 times. Verify DONE 9 through 13.
- **Pass criteria:** All responses correct. counter.py has 13 functions.
- **Adversarial angle:** Context window filling up. Does haiku still remember the task after 13 exchanges?

### F.04 — Phase 4: Browser reload x3 (WS reconnect stress)
- **Steps:**
  1. `page.reload()` -- WS disconnects, page reloads, WS reconnects
  2. Wait for sessions:list in UI
  3. Attach to session, wait for terminal content
  4. Verify terminal is functional (send a test command or NEXT)
  5. Repeat 2 more times
- **Pass criteria:**
  - Session visible after each reload
  - Terminal shows content (not blank)
  - At least one "NEXT" after reloads gets a valid DONE response
  - No console errors
- **Adversarial angle:** On reload, old WS closes, new WS opens. Server must clean up old client. New client must re-subscribe.

### F.05 — Phase 5: More messages (5 more, total ~18)
- **Steps:** Send NEXT 5 times. Verify DONE 14 through 18.
- **Pass criteria:** Conversation intact. Responses correct.
- **Adversarial angle:** We're now at 18 messages. Context window pressure increasing.

### F.06 — Phase 6: Server restart x3 (hardest test)
- **Steps:**
  1. Record current message count
  2. Kill server process (SIGTERM)
  3. Wait 2 seconds
  4. Start server again (same data dir, same port)
  5. Wait for server to be ready (HTTP 200 on `/`)
  6. Navigate browser to app
  7. Verify session visible in sessions:list
  8. Attach to session
  9. Wait for terminal content (tmux session survived, PTY re-attached)
  10. Send "NEXT", verify DONE response with correct count
  11. Repeat steps 2-10 two more times
- **Pass criteria:**
  - Server starts cleanly each time
  - Tmux session survives all 3 restarts (tmux is external to Node)
  - Conversation resumes after each restart
  - sessions.json intact after each restart
  - Watchdog restarts and ticks without crash
  - No server crashes at any point
- **Adversarial angle:** Server restart is the hardest. PTY attachment in init() must find the tmux session. State must be reloaded from sessions.json. The session must be in RUNNING state. If init() auto-resumes and fails, session goes to ERROR.

### F.07 — Phase 7: More messages (total 20+)
- **Steps:** Send NEXT until total reaches 20. Verify DONE 19, 20.
- **Pass criteria:** Conversation reaches 20 messages. counter.py has 20 functions.
- **Adversarial angle:** 20 conversation turns. Context might be getting large.

### F.08 — Phase 8: Final gauntlet (refresh x2, reload x2, restart x2)
- **Steps:**
  1. Refresh, send NEXT, verify DONE
  2. Refresh, send NEXT, verify DONE
  3. Reload, send NEXT, verify DONE
  4. Reload, send NEXT, verify DONE
  5. Restart server, send NEXT, verify DONE
  6. Restart server, send NEXT, verify DONE
- **Pass criteria:**
  - All 6 DONE responses received with incrementing counts
  - Terminal width correct after every reconnect (screenshot + measure)
  - No dot/scrollback artifacts (screenshot analysis)
  - Watchdog still running after final restart (GET /api/watchdog returns summary)
  - counter.py has 26+ functions
- **Adversarial angle:** This is the combination test. Each type of disruption is followed immediately by another. Fastest way to find races.

### F.09 — Final validation
- **Steps:**
  1. Read `/tmp/haiku-endurance-test/counter.py`
  2. Count function definitions
  3. Take final screenshot
  4. Check server logs for any errors/warnings
  5. Check for orphan tmux sessions
- **Pass criteria:**
  - counter.py has >= 20 function definitions
  - Server log has no unhandled rejections
  - No orphan tmux sessions (only the test session)
  - Total test time < 20 minutes

### Haiku Response Detection

```javascript
// Wait for DONE response in terminal output
async function waitForDone(page, expectedN, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    // Read terminal buffer via page.evaluate
    const text = await page.evaluate(() => {
      const term = document.querySelector('.terminal-container')?._xterm;
      if (!term) return '';
      const buf = term.buffer.active;
      let text = '';
      for (let i = Math.max(0, buf.length - 20); i < buf.length; i++) {
        text += buf.getLine(i)?.translateToString(true) + '\n';
      }
      return text;
    });
    
    // Match DONE with any number
    const match = text.match(/DONE\s+(\d+)/i);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n >= expectedN) return n;
    }
    
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for DONE ${expectedN}`);
}
```

---

## Category G: Adversarial / Edge Cases

**File:** `tests/adversarial/g-adversarial-edge.test.js`
**Approach:** Mixed. Some tests use Jest with mocked PTY, some use real server + Playwright, some use raw WS.
**Setup:** Per-test setup depending on approach.

### G.01 — Send 1MB of input to a session (WS client)
- **Steps:** Create session. Send `{ type: 'session:input', data: 'A'.repeat(1_000_000) }`.
- **Pass:** Server accepts. PTY receives data (or truncates). No crash. No OOM.
- **Adversarial angle:** Express JSON limit is 20MB. WS has no limit. PTY write might block.

### G.02 — Send 10MB of input to a session
- **Steps:** Same as G.01 but 10MB.
- **Pass:** Either handled or cleanly rejected. Server survives.
- **Adversarial angle:** WS max payload. Memory pressure.

### G.03 — Create 20 sessions simultaneously (stress test)
- **Steps:** Send 20 `session:create` messages without waiting for responses.
- **Pass:** All 20 created (or some fail with clear errors). Server survives. sessions:list has correct count.
- **Adversarial angle:** 20 PTY spawns at once. File descriptor limits. Store save races.

### G.04 — Kill tmux session externally while subscribed (Playwright)
- **Steps:** Create tmux bash session. Subscribe. Run `tmux kill-session -t <name>` from a separate shell.
- **Pass:** PTY onExit fires. Session transitions to STOPPED. Client receives `session:state` with `stopped`. No crash.
- **Adversarial angle:** The `_wirePty` onExit handler checks `_tmuxSessionAlive()`. If tmux is killed, it returns false, so state goes to STOPPED. But what if the check itself throws?

### G.05 — Corrupt sessions.json then trigger save (Jest)
- **Steps:** Write binary garbage to sessions.json. Call `store.save(sessions)`.
- **Pass:** Garbage overwritten. New valid JSON written.
- **Adversarial angle:** `writeFile` overwrites entirely. But `mkdir` for directory could fail if path is broken.

### G.06 — Start session with invalid working directory
- **Steps:** `sessions.create({ projectId, cwd: '/nonexistent/path' })`
- **Pass:** Either session starts (cwd falls back to process.cwd()) or throws clear error.
- **Adversarial angle:** node-pty with invalid cwd might throw or use process.cwd(). Project path is from projectStore, so invalid path could only happen with corrupted project data.

### G.07 — Session command that exits immediately
- **Steps:** Create direct session with `command: 'echo hello && exit 0'`
- **Pass:** Session starts, runs, then exits. Status transitions to STOPPED (exit code 0). No crash.
- **Adversarial angle:** The PTY closes very quickly. The `onData` first-data RUNNING transition might race with `onExit`.

### G.08 — Session command that exits with error
- **Steps:** Create direct session with `command: 'exit 1'`
- **Pass:** Session starts, exits with code 1. Status transitions to ERROR.
- **Adversarial angle:** Exit code non-zero -> ERROR state. What about segfault (exit code 139)?

### G.09 — Session command that doesn't exist
- **Steps:** Create direct session with `command: 'nonexistent_binary_xyz'`
- **Pass:** pty.spawn throws. Status transitions to ERROR. Error message is clear.
- **Adversarial angle:** Does the error propagate to the WS client?

### G.10 — Send binary data through terminal input (Playwright)
- **Steps:** Use page.evaluate to send `\x00\x01\x02\x03\xff` through xterm.
- **Pass:** Data forwarded. Terminal doesn't crash. (Null bytes might be filtered.)
- **Adversarial angle:** xterm.onData might not emit null bytes. PTY might strip them.

### G.11 — Send control sequences as input
- **Steps:** Send `\x1b[2J` (clear screen), `\x1b[H` (home), `\x1b[?1049h` (alt screen).
- **Pass:** These are output sequences, not input. When sent as input, they're forwarded as-is to the shell. Shell/PTY should handle.
- **Adversarial angle:** Could an attacker inject terminal escape sequences?

### G.12 — WebSocket frame fragmentation
- **Steps:** Send a valid JSON message split across multiple WS frames.
- **Pass:** Server receives complete message. ws library handles reassembly.
- **Adversarial angle:** Unlikely issue but tests ws library behavior.

### G.13 — Connect with subprotocol header
- **Steps:** WS connect with `Sec-WebSocket-Protocol: custom`.
- **Pass:** Server accepts (no protocol negotiation). Or rejects cleanly.
- **Adversarial angle:** Could cause unexpected behavior if server checks subprotocol.

### G.14 — Two clients write to same session simultaneously
- **Steps:** Client A and B both subscribed. A sends "echo A\n", B sends "echo B\n" at same time.
- **Pass:** Both commands reach the PTY. Output contains both "A" and "B" (interleaved is OK).
- **Adversarial angle:** PTY write serialization. Could data interleave mid-line?

### G.15 — Delete session while creating another (race)
- **Steps:** Concurrently: `delete(existingId)` and `create({...})`.
- **Pass:** Both complete. No crash. No orphan state.
- **Adversarial angle:** Store save race.

### G.16 — Create session with command containing shell metacharacters
- **Steps:** `command: 'claude; rm -rf /'`, `command: 'claude | cat'`, `command: 'claude && echo pwned'`
- **Pass:** For direct mode, pty.spawn uses args array (safe). For tmux mode, command is shell-escaped in `bash -c`.
- **Adversarial angle:** SECURITY: tmux `new-session` with `bash -c` wrapping -- is the command properly escaped?

### G.17 — Very rapid resize events (100 in 1 second)
- **Steps:** Send 100 `session:resize` messages in quick succession.
- **Pass:** No crash. Final dimensions are correct. No PTY error.
- **Adversarial angle:** Each resize calls `pty.resize()`. Could overwhelm the PTY.

### G.18 — Session with very long command string (10KB)
- **Steps:** Create session with command of 10000 characters.
- **Pass:** Either creates or fails with clear error. No crash.
- **Adversarial angle:** Shell command length limits (ARG_MAX).

### G.19 — Store save during store load (concurrency)
- **Steps:** Call `store.load()` and `store.save()` concurrently.
- **Pass:** Both complete. File is valid JSON after.
- **Adversarial angle:** Read-during-write could return partial data.

### G.20 — Session output with megabytes of data (direct session)
- **Steps:** Create bash session. Run `dd if=/dev/urandom bs=1024 count=1024 | base64`.
- **Pass:** ~1.3MB of output. Terminal receives it. No crash. Scrollback eventually caps at 10000 lines.
- **Adversarial angle:** Backpressure from WS send. Could queue up memory.

### G.21 — Attach to session, detach, re-attach rapidly (Playwright)
- **Steps:** Attach, detach, attach, detach, attach (5 times in 2 seconds).
- **Pass:** Final attach works. Terminal shows content. No leaked event handlers.
- **Adversarial angle:** Each attach triggers TerminalPane mount/unmount. Cleanup must be synchronous.

### G.22 — Create session with mode: 'invalid'
- **Steps:** `sessions.create({ projectId, mode: 'invalid' })`.
- **Pass:** Falls through to direct mode (else branch). Or throws.
- **Adversarial angle:** The `if (mode === 'tmux') ... else ...` pattern means ANY non-tmux value creates a direct session.

### G.23 — Session with empty command
- **Steps:** `sessions.create({ projectId, command: '' })`.
- **Pass:** Falls back to 'claude' (code: `command || 'claude'`).
- **Adversarial angle:** What about command: ' ' (whitespace only)?

### G.24 — Subscribe then immediately disconnect
- **Steps:** Send subscribe, close WS before server responds.
- **Pass:** Server handles gracefully. Viewer is added then removed on disconnect.
- **Adversarial angle:** The subscribe handler is async. Could the client disconnect before await completes?

### G.25 — 50 clients subscribe to same session, then all disconnect
- **Steps:** 50 WS clients subscribe. Then all close simultaneously.
- **Pass:** All viewers removed. Session still works for new subscriber.
- **Adversarial angle:** Viewer Map iteration during concurrent removeViewer calls.

---

## Agent Assignment and Parallelization

### Group 1: Independent Tests (run in parallel)
These categories have no shared state and can execute simultaneously:

| Agent | Category | Estimated Time | Dependencies |
|-------|----------|----------------|--------------|
| Agent 1 | A: Session Lifecycle | 2 min | Jest only, no server |
| Agent 2 | B: Terminal Rendering | 5 min | Playwright + server |
| Agent 3 | C: WS Protocol | 3 min | Real server + raw WS |
| Agent 4 | D: Reconnect & Persistence | 4 min | Playwright + server restart |
| Agent 5 | E: Watchdog Stress | 1 min | Jest only, no server |
| Agent 6 | G: Adversarial Edge | 4 min | Mixed, own server instances |

Each agent uses its own:
- Temp data directory (avoid file conflicts)
- Ephemeral port (avoid port conflicts): A=none, B=3091, C=3092, D=3093, E=none, G=3094-3096
- Browser instance (for Playwright tests)

### Group 2: Sequential (run alone)
| Agent | Category | Estimated Time | Dependencies |
|-------|----------|----------------|--------------|
| Agent 7 | F: Haiku Endurance | 15 min | Real Claude API, port 3097 |

Category F MUST run alone because:
1. It uses the Claude API (rate limits apply)
2. It restarts the server multiple times (could affect other tests' servers)
3. It creates real tmux sessions (could collide with other tmux tests)

### Total estimated time
- Group 1 (parallel): 5 min (limited by slowest: B or D)
- Group 2 (sequential): 15 min
- **Total wall-clock: ~20 min**

---

## Adversarial Framing for Agents

Each implementing agent should be briefed with this directive:

> **Your mission:** Implement and run these tests. You WIN by finding real bugs in the application. You LOSE by issuing false PASSes -- marking a test as passing when it should fail, or writing a test so weak it can't detect the bug it was designed to find.
>
> **Rules of engagement:**
> 1. Each test must have a clear, automated pass/fail assertion. No "visual inspection" unless taking a screenshot and analyzing it programmatically.
> 2. If a test reveals a bug, document it clearly in the test output with: the exact failure, the code path that triggered it, and your assessment of severity (P0-crash, P1-data-loss, P2-degraded, P3-cosmetic).
> 3. Do not weaken assertions to make tests pass. If the app is wrong, the test should FAIL.
> 4. Timeouts are NOT passes. If a test times out waiting for expected output, that is a FAIL.
> 5. Race conditions must be detected, not hidden. If a test passes 9/10 times and fails 1/10, that is a bug.
> 6. After all tests run, produce a summary: total tests, passed, failed, bugs found with severity.

---

## Test Count Summary

| Category | Test Count |
|----------|-----------|
| A: Session Lifecycle | 50 |
| B: Terminal Rendering | 25 |
| C: WS Protocol | 30 |
| D: Reconnect & Persistence | 15 |
| E: Watchdog Stress | 25 |
| F: Haiku Endurance | 9 (each is a multi-step phase) |
| G: Adversarial Edge | 25 |
| **TOTAL** | **179 named tests** |

With sub-assertions within each test (especially A.06 with 7 name variants, F.08 with 6 gauntlet steps), the effective assertion count exceeds **250**.

---

## Implementation Notes

### Mock pattern for DirectSession/TmuxSession (Categories A, C)
Use the same mock pattern as existing `tests/integration/sessionLifecycle.test.js`:
- Mock at the ESM module level using `jest.unstable_mockModule()`
- DirectSession mock: emit stateChange events on start/stop, maintain meta.status
- TmuxSession mock: same pattern plus tmuxName generation
- SessionStore: real or temp-dir-based (not mocked -- test real persistence)

### Server startup helper (Categories B, C, D, F, G)
```javascript
function startServer(port, dataDir) {
  return spawn('node', ['server.js'], {
    cwd: '/home/claude-runner/apps/claude-web-app-v2',
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
```

### WS client helper (Category C)
```javascript
function connectWS(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws, type, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${type}`)), timeout);
    const handler = (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === type) {
        clearTimeout(timer);
        ws.removeListener('message', handler);
        resolve(msg);
      }
    };
    ws.on('message', handler);
  });
}
```

### Project creation helper (all categories needing a server)
```javascript
async function createTestProject(port, path = '/tmp/test-project') {
  fs.mkdirSync(path, { recursive: true });
  const res = await fetch(`http://127.0.0.1:${port}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test Project', path }),
  });
  return res.json();
}
```
