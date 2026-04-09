# Design: lastLine Server-Side Pipeline

**Feature slug:** lastline-server-pipeline  
**Date:** 2026-04-08  
**Designer:** Stage 1 Design Agent (Opus)

---

## Section 1: Problem & Context

### User Problem

Session cards in the sidebar show session status (running/stopped/error) and a timestamp, but give no indication of what a session is actually doing. A user with 5 running sessions cannot tell which one is waiting for input, which is thinking, and which has crashed — they have to click into each one to read the terminal.

The `session-lastline` div exists in `SessionCard.js` (line 157–159) to solve this: it shows the last line of PTY output as a live preview. But it is never populated.

### What Currently Exists

**Client-side rendering (complete, no changes needed):**
- `public/js/components/SessionCard.js` lines 157–159: renders `.session-lastline` when `session.lastLine` is truthy.
- The `sessions:list` WS message arrives from the server with session meta objects. `lastLine` is absent from those objects, so the div never renders.

**Server-side PTY data path (where the gap is):**
- `lib/sessions/DirectSession.js` line 190–205: `ptyProcess.onData()` handler in `_wirePty()`. Every PTY chunk flows through here, dispatched to all connected viewers. No extraction of `lastLine` happens here.
- `lib/sessions/SessionManager.js` line 229–231: `list()` method returns `{ ...s.meta }` for each session. `meta.lastLine` is never set, so it is always absent.
- `lib/ws/handlers/sessionHandlers.js` line 218–221: `_broadcastSessionsList()` calls `sessions.list()` and broadcasts `{ type: 'sessions:list', sessions }`. Called after every lifecycle mutation (create, stop, refresh, delete).
- `server.js` lines 68–72: On new WebSocket connection, sends `sessions:list` to the new client using `sessions.list()`.

**Existing stripAnsi utility:**
- `lib/watchdog/WatchdogManager.js` lines 61–67: defines a local `function stripAnsi(str)` that strips CSI sequences, OSC sequences, G-set designations, and control characters. This function is not exported; it is private to that module. A similar utility must be created for server-side use, or that one can be extracted to a shared module.

### What Is Missing

1. No code in `DirectSession.js` (or anywhere server-side) extracts the last non-blank line from PTY chunks.
2. `session.meta.lastLine` is never set.
3. No throttling mechanism limits how often `sessions:list` is broadcast due to lastLine updates (currently only broadcast on lifecycle events, not on PTY data).

---

## Section 2: Design Decision

### Overview

Intercept PTY data in `DirectSession._wirePty()`, strip ANSI codes from each chunk, find the last non-blank line, store it in `this.meta.lastLine`, and emit a new `'lastLineChange'` event. `SessionManager` wires this event to a throttled broadcast of `sessions:list`.

### Exact Changes

#### 2.1 Extract `stripAnsi` to a shared utility

**File to create:** `lib/utils/stripAnsi.js`

```
export function stripAnsi(str) { ... }
```

Copy the regex from `WatchdogManager.js` lines 61–67. This is a pure function with no dependencies — extracting it avoids duplicating the regex. The watchdog module can optionally import from here later (not in scope for this feature).

**Why a new file rather than importing from WatchdogManager:** WatchdogManager is a heavy module with many dependencies. Importing from it just for a regex would create unnecessary coupling.

#### 2.2 Add `lastLine` extraction to `DirectSession._wirePty()`

**File to modify:** `lib/sessions/DirectSession.js`

In `_wirePty()`, after the viewer dispatch loop (after line 205), add logic to:
1. Concatenate the incoming `data` chunk with a small rolling buffer of the previous partial line (to handle chunks that split mid-line).
2. Split by `\n` (or `\r\n`), take all complete lines.
3. Strip ANSI codes from each line.
4. Find the last non-blank line (after trimming whitespace).
5. If it differs from `this.meta.lastLine`, update `this.meta.lastLine` and emit `'lastLineChange'`.

**Rolling buffer approach:** PTY data arrives in arbitrary chunks. A line "hello world" may arrive as two chunks: "hello " and "world\n". We need to buffer the incomplete tail of the previous chunk and prepend it to the next chunk before splitting. Keep a `this._lastLineBuffer = ''` on the instance (initialized in the constructor).

**Blank line handling:** If a chunk produces only blank lines after stripping, do not update `lastLine`. Keep the previous non-blank value. This prevents the preview from going blank during shell prompt redraws or between command outputs.

**What NOT to do here:** Do not persist `lastLine` to `SessionStore`. It is ephemeral PTY data, not session configuration. It resets naturally when the session process is restarted (the new PTY will emit new data). On server restart, `lastLine` will be absent from persisted meta — this is acceptable; cards will show no preview until new PTY output arrives.

#### 2.3 Wire `lastLineChange` in `SessionManager._wireSessionEvents()`

**File to modify:** `lib/sessions/SessionManager.js`

In `_wireSessionEvents()` (lines 387–392), add a listener for the new `'lastLineChange'` event.

**Throttling:** Broadcasting `sessions:list` on every PTY chunk would be excessive — Claude can emit hundreds of chunks per second. Use a per-session debounce of **500ms**: after a `lastLineChange` event, schedule a broadcast 500ms later. If another `lastLineChange` fires during that window, reset the timer. This means the `sessions:list` broadcast fires at most twice per second per session for active PTY output.

Implementation: keep a `Map<sessionId, timeoutHandle>` on `SessionManager` (e.g. `this._lastLineTimers = new Map()`). On `lastLineChange`, clear any existing timer for that session and set a new one.

**Why 500ms:** Fast enough to feel live for a human watching the sidebar, slow enough to avoid flooding clients during rapid output (e.g. `ls -la /` or `npm install`).

#### 2.4 No changes to `SessionHandlers._broadcastSessionsList()`

The existing `_broadcastSessionsList()` in `sessionHandlers.js` already calls `sessions.list()`, which already returns `{ ...s.meta }`. Since `meta.lastLine` will be set by the time the broadcast fires, no change is needed here.

#### 2.5 No changes to `SessionCard.js` or `TerminalPane.js`

`SessionCard.js` already renders `session.lastLine` (lines 157–159). `TerminalPane.js` handles PTY display but has no role in `lastLine` computation. Both are out of scope.

### Data Flow

```
PTY emits chunk
  → DirectSession._wirePty().onData handler
    → dispatch to viewers (existing, unchanged)
    → strip ANSI, extract last non-blank line
    → if changed: update meta.lastLine, emit 'lastLineChange'
      → SessionManager._wireSessionEvents() listener
        → debounce 500ms
          → _broadcastSessionsList()
            → sessions:list to all WS clients
              → SessionCard renders session.lastLine
```

### ANSI Stripping Approach

Use the same regex chain as `lib/watchdog/WatchdogManager.js`:
- CSI sequences: `\x1b\[[0-9;]*[a-zA-Z]`
- OSC sequences: `\x1b\][^\x07]*\x07`
- G-set designations: `\x1b[()][AB012]`
- Other escape starters: `\x1b[\[>?=]`
- Non-printable control bytes (except `\n`, `\r`, `\t`): `[\x00-\x09\x0b\x0c\x0e-\x1f]`

After stripping, `trim()` each candidate line before blank-check and before storing.

### Throttling

Per-session debounce of 500ms, implemented in `SessionManager`. Timer is cleared on session deletion to avoid leaks.

### Edge Cases

- **Chunk splits mid-line:** handled by rolling buffer in `DirectSession`.
- **Chunk is all blank after strip:** skip update, keep previous `lastLine`.
- **Session stops:** `lastLine` remains the last value in meta. It will appear in the card until a new session starts. This is desirable — the user can see what the session was doing when it stopped.
- **Session deleted:** clear any pending debounce timer in `SessionManager.delete()`.
- **`lastLine` contains only whitespace:** trim before storing; treat as blank.
- **Very long lines:** truncate at 200 characters before storing (prevents inflating WS payloads for huge single-line outputs like minified JSON).
- **TmuxSession:** TmuxSession PTY data also flows through a viewer callback pattern. However, the `_wirePty` is in `TmuxSession.js`. For scope, only implement for `DirectSession`. TmuxSession support is explicitly out of scope.

### What NOT to Build

- Do not modify `TmuxSession.js` — only `DirectSession.js`.
- Do not persist `lastLine` to `SessionStore`.
- Do not change client-side rendering.
- Do not add `lastLine` to the REST API response (the REST endpoint, if any, already returns `s.meta` which will contain `lastLine` automatically).
- Do not add any UI to configure or disable this feature.

---

## Section 3: Acceptance Criteria

1. **Given** a running direct session with PTY output, **when** a client connects and receives `sessions:list`, **then** the matching session object contains a non-empty `lastLine` string within 1 second of PTY activity.

2. **Given** a `lastLine` value, **when** it is rendered in `SessionCard.js`, **then** it contains no raw ANSI escape sequences (no `\x1b[` substrings, no `\x1b]` substrings).

3. **Given** a session producing rapid output (e.g. 100 lines/second), **when** observing WS messages on the client, **then** `sessions:list` messages due to `lastLine` updates arrive at most 2 per second (consistent with 500ms debounce).

4. **Given** a session whose most recent PTY chunk contains only blank lines (e.g. a shell prompt redraw), **when** `sessions:list` is next broadcast, **then** `lastLine` retains the last non-blank value (does not go blank).

5. **Given** a session whose PTY output ends with a line exceeding 200 characters, **when** `sessions:list` is broadcast, **then** `session.lastLine` is truncated to 200 characters.

6. **Given** a session that is stopped, **when** another client connects and receives `sessions:list`, **then** the stopped session's `lastLine` is the last non-blank line seen before it stopped (it persists in-memory until server restart).

7. **Given** a TmuxSession, **when** PTY output flows, **then** `lastLine` is NOT set (TmuxSession is out of scope). The card renders nothing in the lastline slot.

8. **Given** the server restarts, **when** it re-hydrates sessions from disk, **then** `lastLine` is absent (undefined/null) because it is not persisted. Cards show no preview until new PTY output arrives.

9. **Given** a session is deleted, **when** the deletion is processed, **then** any pending debounce timer for that session is cleared (no ghost broadcast fires after deletion).

10. **Given** a new WebSocket client connects while a session is actively running, **when** it receives the initial `sessions:list`, **then** `lastLine` reflects PTY output seen so far (because `meta.lastLine` is in-memory and included in `list()`).

---

## Section 4: User Lifecycle Stories

### Story 1: Spotting the active session at a glance

A developer has 4 sessions open in the sidebar. Three are stopped. One is running a long Claude analysis. Without clicking into any session, they glance at the sidebar and see the running session's card shows "Analyzing repository structure..." as the last line preview. They immediately know which session to open.

### Story 2: Monitoring progress without staying subscribed

A developer starts a Claude session to refactor a large module. They navigate away to another project. The session card in the sidebar continues to update its preview text every few seconds, showing Claude's current output like "Writing tests for AuthService..." then "Updating imports..." — all without the developer being subscribed to the session's terminal output.

### Story 3: Post-stop diagnosis

A session stops unexpectedly. The developer sees the session card's badge turn to "stopped" and the lastline preview still shows the last thing Claude printed: "Error: Cannot read file 'config.json'". Without opening the terminal, the developer understands what went wrong and can decide whether to restart or investigate.

### Story 4: Multiple concurrent sessions

A developer runs 3 parallel Claude sessions for a large project (frontend, backend, tests). The session list shows all three with live preview text. The developer can tell "the backend session is writing migrations, the frontend session is stuck on a type error, and the test session is running." They click the stuck one immediately.

### Story 5: Page refresh shows recent state

A developer refreshes the browser. The session list loads immediately from the WebSocket `sessions:list` message. Sessions that had PTY output before the refresh show their `lastLine` preview (because it was retained in server memory). Sessions from before the server's last restart show no preview (ephemeral, not persisted).

---

## Section 5: Risks & False-PASS Risks

### Implementation Risks

1. **Buffer accumulation:** If the rolling `_lastLineBuffer` is never flushed (e.g. a session that only produces output without newlines), it will grow unbounded. Mitigation: cap the buffer at 1024 bytes; if the buffer exceeds this without a newline, take the last 200 chars as the current `lastLine` and reset the buffer.

2. **Race condition on session delete + debounce:** If `delete()` is called while a debounce timer is pending, the timer fires after the session is gone and calls `_broadcastSessionsList()` — which is harmless (the deleted session won't appear in the list). But it's a spurious broadcast. Mitigation: clear the timer in `delete()`.

3. **`\r` handling:** PTY output often uses carriage return (`\r`) without newline for in-place updates (spinners, progress bars). If we split only on `\n`, the carriage return lines get mangled. After stripping ANSI, also strip `\r` from each candidate line (or split on both `\r` and `\n`). The WatchdogManager regex does not handle `\r` explicitly. We should handle it in line splitting.

4. **High-frequency output floods SessionManager timers:** 1000 concurrent sessions each emitting output would create 1000 pending timers. At 500ms debounce this is fine in memory, but worth noting as a scaling concern.

5. **ANSI stripping misses some sequences:** The regex from WatchdogManager covers the most common sequences but may miss some (e.g. DEC private modes, bracketed paste). The risk is that residual escape characters appear in `lastLine`. Mitigation: after the regex chain, add a final pass stripping any remaining `\x1b` prefix sequences.

### False-PASS Risks for Tests

1. **Test asserts `lastLine` is non-null but doesn't check for ANSI:** A test could pass by checking `session.lastLine !== undefined` while the value actually contains `\x1b[32m` escape codes. Tests MUST check the actual value doesn't contain `\x1b`.

2. **Test produces output before browser subscribes:** Per the executor protocol, `session:subscribed` fires on subscribe and triggers `xterm.reset()`. If the test writes PTY output before the browser client subscribes, the xterm buffer is cleared. `lastLine` in the server meta is unaffected (it's server-side), but the timing matters. Tests should write output, wait 600ms (longer than debounce), then check `lastLine`.

3. **Vacuous PASS on blank-line test:** A test verifying "blank PTY output doesn't clear lastLine" could vacuously pass if it never successfully set a non-blank `lastLine` first. The test must verify the initial value was set before checking that it survived the blank chunk.

4. **`list()` vs REST endpoint confusion:** Tests must verify `lastLine` in the `sessions:list` WS message, not just a REST endpoint. If a REST endpoint returns stale data, the test could pass the REST check while the WS broadcast is broken.

5. **Throttle test timing sensitivity:** A test checking "at most 2 broadcasts per second" could be flaky if the test machine is under load. Use a wider assertion window (e.g. check that 50 output chunks produce fewer than 10 broadcasts over 5 seconds).
