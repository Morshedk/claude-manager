# Test Designs: lastLine Server-Side Pipeline

**Date:** 2026-04-08  
**Designer:** Stage 3 Test Design Agent (Opus)

---

## Infrastructure Notes

- Server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT`, `CRASH_LOG` env vars
- ProjectStore seed: `{ "projects": [{ "id": "proj-1", "name": "Test", "path": "/tmp" }], "scratchpad": [] }`
- WS URL: bare `ws://localhost:PORT` (not `/ws`)
- Init message type: `'init'`
- Session create: `{ type: 'session:create', projectId, name, command: 'bash', mode: 'direct' }`
- Sessions list REST: GET `/api/sessions` → `{ managed, detected }` — use `managed` array
- After PTY input, wait at minimum 800ms (500ms debounce + 300ms buffer)

---

### T-1: lastLine appears in sessions:list after PTY output
**Port:** 3200  
**Test type:** WS protocol + REST  
**Flow:**
1. Start server with temp DATA_DIR
2. Connect WS, wait for `init`
3. Create direct session with `bash` command
4. Wait for `session:created`
5. Send PTY input: `echo hello_lastline_test\n`
6. Wait 1000ms (debounce 500ms + margin)
7. Fetch `GET /api/sessions`
8. Find session in `managed` array by ID

**Pass condition:** `session.lastLine === 'hello_lastline_test'` (exact string, no whitespace, no ANSI)

**Fail signal:** `session.lastLine` is `undefined`, `null`, empty string, or contains the raw ANSI escape sequence `\x1b[` — meaning either the extraction didn't run, the debounce never fired, or stripping failed.

---

### T-2: ANSI codes are stripped — raw escape sequences don't appear
**Port:** 3201  
**Test type:** WS protocol + REST  
**Flow:**
1. Start server with temp DATA_DIR
2. Connect WS, wait for `init`
3. Create direct session with `bash` command
4. Wait for `session:created`
5. Send PTY input that produces ANSI output: `printf '\033[32mgreen_text\033[0m\n'\n`
6. Wait 1000ms
7. Fetch `GET /api/sessions`, find session

**Pass condition:**
- `session.lastLine` is truthy
- `session.lastLine` does NOT contain `\x1b` (escape character)
- `session.lastLine` does NOT match `/\\x1b\[/` or `/\\u001b/`
- `session.lastLine` ideally contains `green_text` (the visible content)

**Fail signal:** `session.lastLine` contains raw `\x1b` bytes — ANSI stripping failed. A test that only checks `lastLine !== undefined` would vacuously pass on a broken stripping implementation.

---

### T-3: lastLine updates as new output arrives
**Port:** 3202  
**Test type:** WS protocol + REST  
**Flow:**
1. Start server with temp DATA_DIR
2. Connect WS, wait for `init`
3. Create direct session with `bash` command
4. Wait for `session:created`
5. Send: `echo first_marker\n`
6. Wait 1000ms, fetch REST, capture `lastLine` → should be `'first_marker'`
7. Send: `echo second_marker\n`
8. Wait 1000ms, fetch REST, capture new `lastLine` → should be `'second_marker'`

**Pass condition:** First check shows `'first_marker'`, second check shows `'second_marker'`. The `lastLine` value must have changed between observations.

**Fail signal:** `lastLine` stays as `first_marker` on second check (not updating), OR is undefined on first check (initial population broken). A false pass would be checking only the second marker without verifying the first was set first.

---

### T-4: sessions:list WS broadcast carries lastLine
**Port:** 3203  
**Test type:** WS protocol (message listener)  
**Flow:**
1. Start server with temp DATA_DIR
2. Connect WS, collect all `sessions:list` messages
3. Wait for `init`
4. Create direct session with `bash` command
5. Wait for `session:created`
6. Send: `echo ws_lastline_marker\n`
7. Wait 1500ms for debounce + broadcast
8. Check all received `sessions:list` messages after the echo command

**Pass condition:** At least one `sessions:list` message received AFTER the echo command contains a session object with `lastLine === 'ws_lastline_marker'`. This verifies the WS broadcast path, not just the REST endpoint.

**Fail signal:** All `sessions:list` messages have `lastLine: undefined`. This means the `SessionHandlers` listener for `'lastLineChange'` is not wired, or the debounce timer never fires.

---

### T-5: Blank PTY output does not clear lastLine (adversarial)
**Port:** 3204  
**Test type:** WS protocol + REST  
**Flow:**
1. Start server with temp DATA_DIR
2. Connect WS, wait for `init`
3. Create direct session with `bash` command
4. Wait for `session:created`
5. Send: `echo non_blank_marker\n`
6. Wait 1000ms, fetch REST, verify `lastLine === 'non_blank_marker'` (precondition)
7. Send blank output: `printf '\n\n\n'\n` (three blank lines, no visible content)
8. Wait 1000ms, fetch REST again

**Pass condition:** After step 8, `session.lastLine` is still `'non_blank_marker'` (unchanged by blank output). The blank chunk must not have overwritten the last known non-blank line.

**Fail signal:** `lastLine` becomes `''`, `null`, or `undefined` after the blank output. This would be a regression where blank PTY chunks clear the preview. A vacuous false-pass would occur if the precondition in step 6 was never verified (i.e. `lastLine` was never set to `'non_blank_marker'` in the first place — but then the test would fail on precondition, which is the correct failure signal).

---

### T-6: Throttle — rapid output triggers bounded broadcasts
**Port:** 3205  
**Test type:** WS protocol (message counter)  
**Flow:**
1. Start server with temp DATA_DIR
2. Connect WS, collect `sessions:list` messages with timestamps
3. Wait for `init`
4. Create direct session with `bash` command
5. Wait for `session:created`
6. Send 20 echo commands in rapid succession with 50ms gaps: `echo line_N\n` for N in 1..20 (total ~1s of rapid output)
7. Wait an additional 1500ms for debounce to settle
8. Count how many `sessions:list` messages arrived during the 2500ms window that were caused by lastLine updates (exclude the initial one on connect and the one on session:create)

**Pass condition:** Fewer than 6 `sessions:list` broadcasts during the 2500ms window. With 500ms debounce and 1s of rapid output, the expected count is 1-3 broadcasts.

**Fail signal:** 20 broadcasts (one per echo command) — debounce not working. OR 0 broadcasts — lastLine updates not triggering broadcasts at all. This test catches both the under-fire and over-fire failure modes.

**Note for executor:** Filter `sessions:list` messages to count only those that arrive after the `session:created` message and where the matching session has a non-null `lastLine`. The initial `sessions:list` on connect and the one from `session:create` should be excluded.

---

## Coverage Map

| Lifecycle story | Tests covering it |
|---|---|
| Story 1: Spotting active session at a glance | T-1, T-4 |
| Story 2: Monitoring progress without subscribing | T-3, T-4 |
| Story 3: Post-stop diagnosis (lastLine persists) | T-5 (partial — blank persistence) |
| Story 4: Multiple concurrent sessions | T-6 (implied — debounce per session) |
| Story 5: Page refresh shows recent state | T-1 (REST endpoint includes lastLine) |

| Design risk | Test targeting it |
|---|---|
| ANSI stripping failure | T-2 |
| Debounce not wired | T-6 |
| WS broadcast path broken | T-4 |
| Blank lines clearing lastLine | T-5 |
| lastLine never populated | T-1 |
| lastLine not updating | T-3 |
