# Development Journal — claude-web-app-v2

*A living record of hard-won learnings, bugs found, architectural decisions, and context useful for future Claude sessions working on this codebase.*

---

## Session: F Lifecycle Test — Getting It To Pass

**Date:** 2026-04-08  
**Outcome:** F lifecycle test (full end-to-end with real Claude haiku) passes in ~1.8 minutes, all 16 steps.

### The Three Bugs

#### Bug 1: `\n` vs `\r` for Claude TUI input

Claude Code's TUI treats `\n` (linefeed) as a multiline newline — the text appears in the input area but is never submitted. The correct character is `\r` (carriage return, 0x0D), which maps to the Enter key in the PTY.

**Symptom:** Sentinel message sent, Claude displays it in input area, never responds. Test times out waiting for ACK_1.  
**Fix:** All `session:input` data strings end with `\r`, not `\n`.  
**Verified by:** `diag-input.mjs` — with `\r`, ACK_1 arrived at +3.6s. With `\n`, never arrived.

#### Bug 2: TUI initialization timing

`waitForStatus('running')` fires ~300ms after PTY spawn (Node.js microtask). Claude's TUI takes **8-10 seconds** to fully render and reach input-ready state. Sending input before the TUI is ready results in silent message loss — no error, no indication.

**Symptom:** ACK_1 never arrives even with `\r`, but only when sent immediately after status=running.  
**Fix:** After session reaches RUNNING, poll `buffer.includes('bypass')` (Claude's footer says "bypass permissions on" when `--dangerously-skip-permissions` is active). This text appears only when the TUI is fully rendered.  
**Timeout:** 30s (generous for cold auth start).  
**Gotcha:** Do NOT put the literal you're waiting for in the sentinel text — PTY echoes input back ~2-3s later and creates a false positive.

#### Bug 3: PTY generation race condition on refresh (root cause of F.09 failure)

When `DirectSession.refresh()` is called:
1. Old PTY killed → `this.pty = null`  
2. New PTY spawned → `_wirePty()` registers new handlers  
3. Session transitions STOPPED → STARTING → RUNNING (via microtask)  
4. **Old PTY's `onExit` fires asynchronously**, sees `status === RUNNING`, calls `_setState(STOPPED)` — killing the new session.

**Symptom:** F.09 sends `session:refresh`, receives `session:refreshed`, but `waitForStatus('running', 20000)` times out. Session went RUNNING → STOPPED due to stale exit event.  
**Fix:** `_ptyGen` counter in `DirectSession.js`. Each `start()` increments the generation. `onData`, `onExit`, and the microtask RUNNING transition all guard `if (gen !== this._ptyGen) return`.  
**File:** `lib/sessions/DirectSession.js`

### Other Lessons

**`sessionData.cwd` not `sessionData.meta.cwd`:** `DirectSession.toJSON()` returns `{ ...this.meta }` — all fields are flat. Accessing `.meta.cwd` returns `undefined`.

**Conversation file path encoding:** Claude stores conversation files at `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl`. The encoded-cwd replaces all `/` with `-` (including leading slash). So `/tmp/qa-F/project` → `-tmp-qa-F-project`. The `cwd` used is `project.path` (set by `SessionManager._createDirect`), NOT any `cwd` parameter passed in `session:create`.

**`session:create` auto-subscribes:** When a client sends `session:create` via WS, the server auto-subscribes that client to session output. Do NOT send a separate `session:subscribe` — use `attachAndCollect(wsCreate, sessionId)` to wire the buffer without sending a duplicate subscribe message.

**WS code=1005:** "No Status Received" — appears when a WS connection closes without a proper close frame. In tests, this is expected when calling `ws.close()` without a status argument. It is NOT a server error.

**Sentinel protocol:** Use `ACK_N where N increments from 1` (not `ACK_1` literally) in the prompt to avoid PTY echo false positives. Wait >1.5s or check that the buffer length grew substantially before trusting an ACK match.

---

## Architecture: Session Lifecycle State Machine

```
CREATED → STARTING → RUNNING → STOPPED
                  ↘ ERROR ↗
```

- `assertTransition()` enforces valid transitions — throws on invalid ones
- Direct assignment to `meta.status` bypasses the guard (used in `refresh()` to force RUNNING→STOPPED directly)
- `_setState()` calls `assertTransition()` and emits `stateChange`
- Valid: STOPPED → STARTING (needed for refresh/auto-resume)
- Valid: ERROR → STARTING (needed for auto-resume on subscribe)

---

## Architecture: WS Auto-Subscribe on Session Create

When `session:create` is handled server-side, the creating client is automatically added as a viewer. This means:
- The creating WS gets PTY output immediately without a separate `session:subscribe`
- If you close the creating WS and open a new one, you must send `session:subscribe` explicitly
- The F test uses `attachAndCollect(wsCreate, sessionId)` to avoid the double-subscribe problem

---

## Architecture: Refresh Flow

```
Client: session:refresh →
Server: DirectSession.refresh() →
  1. kill old PTY
  2. this.pty = null
  3. force status to STOPPED if not already
  4. call this.start(authEnv) →
     - _setState(STARTING)
     - spawn new PTY
     - increment _ptyGen
     - _wirePty(myGen): register handlers with generation guard
     - microtask: if gen === _ptyGen → _setState(RUNNING)
  5. broadcastToSession: session:subscribed (triggers xterm.reset() on all clients)
  6. send to requester: session:refreshed
```

**Critical:** `--resume <claudeSessionId>` is passed on restart if `_claudeSessionFileExists()` returns true. The file is at `~/.claude/projects/<encoded-cwd>/<claudeSessionId>.jsonl`.

---

## Testing Infrastructure Patterns

### Server startup (from F-lifecycle.test.js)

```javascript
serverProc = spawn('node', ['server-with-crash-log.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Poll until ready
const deadline = Date.now() + 25000;
while (Date.now() < deadline) {
  try { const r = await fetch(`${BASE_URL}/`); if (r.ok) break; } catch {}
  await sleep(400);
}
```

### Port assignments (avoid conflicts)
- 3097: F-lifecycle test
- 3098: T-01
- 3099: T-02  
- 3100: T-03
- (continue from 3101 for additional tests)

### attachAndCollect vs subscribeAndCollect

```javascript
// Use when WS was already auto-subscribed (e.g. the session:create WS)
const collector = attachAndCollect(existingWs, sessionId);

// Use when connecting a NEW WS to an existing session
const collector = await subscribeAndCollect(sessionId);
```

### Waiting for Claude TUI ready

```javascript
// After session reaches RUNNING, wait for "bypass" in buffer
const deadline = Date.now() + 30000;
while (Date.now() < deadline) {
  if (collector.getBuffer().includes('bypass') || collector.getBuffer().length > 2000) break;
  await sleep(300);
}
```

---

## Testing Strategy: 3-Agent Pipeline Per Test

Each lifecycle test goes through three agents:

1. **Designer (Opus)** — reads source files, produces a prose execution script in markdown. No code. Covers: infrastructure, exact actions with timing, repeat protocol, pass/fail criteria, false-PASS risks.

2. **Executor (Sonnet)** — implements and runs the test exactly as designed. Up to 3 fix attempts. Documents deviations. Appends `## Execution Summary` to the design doc.

3. **Validator (Opus)** — adversarially reviews design + execution output. Answers three questions:
   - Did the test pass? (actual outcome)
   - Was the design correct? (meaningful assertions, real failure detection)
   - Was the execution faithful? (did the code match the design?)
   A false PASS from Executor can be overridden by Validator.

**Designs saved to:** `tests/adversarial/designs/T-XX-design.md`  
**Test files:** `tests/adversarial/T-XX-*.test.js`  
**Run outputs:** `tests/adversarial/designs/T-XX-run-output.txt`

---

## Lifecycle Tests: 50 Ranked Tests

Full specs in `LIFECYCLE_TESTS.md` Part 2. Top 5 by score:

| # | Test | Score | Type |
|---|------|-------|------|
| T-01 | Double-click "Start Session" → no duplicates | 13 | Playwright |
| T-02 | Browser hard-reload → session still running | 13 | Playwright |
| T-03 | Refresh clears terminal buffer, no dot artifacts | 13 | Playwright (visual) |
| T-04 | Stop button actually kills the process | 13 | WS + REST |
| T-05 | Refresh preserves conversation via --resume | 13 | Playwright (sentinel) |

---

## Design Phase Findings (T-01 through T-03)

### T-01: Double-click race — expected to FAIL (real bug found)

The Opus designer read `NewSessionModal.js` and `SessionManager.create()` and found:
- **No server-side deduplication.** `SessionManager.create()` generates a fresh `uuidv4()` for every call with zero name-based dedup logic. Two rapid `session:create` WS messages WILL produce two distinct sessions.
- **No client-side debounce.** `handleCreate()` calls `closeNewSessionModal()` synchronously, but Preact re-renders asynchronously. Two synchronous `.click()` calls in the same JS tick both execute `handleCreate()` before the modal unmounts.
- **Race window is real.** The test is expected to FIND the bug, not confirm it's fixed.
- Design includes a WS message counter to distinguish "second click never fired" (INCONCLUSIVE) from "two creates sent, one session returned" (genuine PASS if server deduplicates).

### T-02: Browser reload — signals reset on reload (test must account for this)

The designer found:
- `selectedProjectId` and `attachedSessionId` are in-memory Preact signals — they reset to `null` on browser reload. The user must re-select project and re-open overlay after reload. The test must simulate this.
- WS reconnect: `connection.js` auto-reconnects with 3s delay. `TerminalPane` re-subscribes only on mount, triggered by `connection:open`. Since TerminalPane unmounts on reload, re-subscribe only happens when user re-opens the overlay.
- Cache bypass: CDP `Network.setCacheDisabled` is the only reliable Playwright mechanism (not `location.reload(true)`).
- "Live output" precisely defined: non-blank terminal + unique typed marker echoes back within 5s + PID unchanged.
- 8 false-PASS risks identified and mitigated.

### T-03: Dot artifacts — DOM introspection path found

The designer found:
- Exact refresh button selector: `button[title="Refresh session"]` (from `SessionOverlay.js` line 128).
- `TerminalPane.js` line 132 calls `xterm.reset()` on `session:subscribed` — confirmed the fix path.
- `_scrollState()` test hook at line 104 exposes `bufferLength`, `scrollMax`, `scrollTop` for DOM introspection without hacking xterm internals.
- Three-layer dot detection: (1) DOM textContent scan of blank rows, (2) pattern matching for known artifact signatures, (3) pixel inspection as non-blocking warning. DOM approach is primary since headless Chrome uses DOM renderer.

---

## 3-Agent Pipeline: Bugs Fixed After Adversarial Review

### T-01: Double-click duplicate session — FIXED

**Root cause:** `SessionManager.create()` generates a fresh UUID for every call with zero dedup; `NewSessionModal.handleCreate()` has no `submitting` guard.

**Fix applied (2026-04-08):**
- `public/js/components/NewSessionModal.js`: Added `submitting` state, set to `true` in `handleCreate()`, added `disabled=${submitting}` to Start Session button.
- `lib/ws/handlers/sessionHandlers.js`: Added 2-second dedup window keyed on `clientId:projectId:name`. Silent drop for duplicate within window.

**Post-fix test result:** T-01 5/5 GENUINE PASS — `ws_sends=2` confirmed both clicks reached server, server correctly deduplicated.

### T-03: Vacuous pass from wrong test flow order — FIXED

**Root cause:** Test wrote 50 lines via WS, THEN opened browser. When browser subscribed, `session:subscribed` broadcast triggered `xterm.reset()` on the client — clearing the scrollback before it could render. Result: `scrollMax=0` both before and after refresh (vacuous, no real clearance tested).

**Fix applied (2026-04-08):**
1. Reordered flow: Open browser + click session card FIRST, then produce 50 lines. Browser subscribes to an empty session, `xterm.reset()` fires on empty terminal (no data lost). Lines stream into the already-subscribed terminal.
2. Changed `console.warn` abort gate to `throw new Error(...)` — test now hard-aborts if `lastContentRow < 5`.
3. Added assertion: `scrollMax > 0` before refresh (warns if missing, proving real scrollback existed).

**Post-fix test result:** T-03 PASS — `scrollMax=180` before refresh, `scrollMax=0` after. Old content cleared. No artifacts at t=0, t=2, t=4.

**Key lesson:** `session:subscribed` is sent on INITIAL subscribe, not only on refresh. Any time a client subscribes to a session, it receives `session:subscribed` → `xterm.reset()`. If you produce content before the browser connects, the first subscribe wipes it. Always subscribe before producing test content when testing scrollback.

### T-02: Crash log check hardened

**Fix applied (2026-04-08):** Changed `console.warn` to `expect(testWindow.length).toBe(0)` — crash log entries during test window now fail the test as the design requires.

---

## Known Product Issues (found during testing)

1. **`--resume` continuity not fully tested in F lifecycle:** After refresh, the F test re-establishes a *new* sentinel starting from ACK_11 rather than verifying Claude remembers the previous 10 messages. T-05 specifically tests this.

2. **New Project modal — previously dead stub in v1:** The "New Project" button existed but did nothing. Fixed in v2. F.04 now passes.

3. **WS code=1005 after refresh:** The mainSub WS closes after `session:refresh`. This is expected — the test explicitly calls `mainSub.close()` and re-subscribes. In the real browser UI, the WS stays open and receives `session:subscribed` to trigger xterm.reset().

4. **Session cwd uses project.path not session:create cwd param:** `SessionManager._createDirect` sets `cwd: project.path` regardless of any `cwd` field sent in the `session:create` WS message.

---

## Deployment Status

- **v1** (claude-web-app): Running on production, 219 restarts in 14h as of 2026-04-07
- **v2** (claude-web-app-v2): F lifecycle test passing. Adversarial tests T-01/T-02/T-03 all passing. Pending deployment to replace v1.
- **v2 test suite:** 657 unit/integration tests passing (1 test suite flaky: A.34, D-reconnect — pre-existing port conflict issue in full-suite runs, passes in isolation)
