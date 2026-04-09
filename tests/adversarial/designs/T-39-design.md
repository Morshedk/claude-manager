# T-39 Design: Corrupted sessions.json — Server Recovers Without Crash

**Score:** 11 | **Type:** Server-level | **Port:** 3136

---

## What This Test Proves

When `sessions.json` contains invalid JSON, the server must:
1. Start without crashing
2. Serve the app with an empty session list
3. Log the corruption (not silently swallow it)

This tests `SessionStore.load()` and the server initialization path.

---

## Key Architecture Understanding

### SessionStore.load() (from source):
```javascript
async load() {
  try {
    const raw = await readFile(this.sessionsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    // Parse error or other IO error — return empty rather than crashing
    return [];
  }
}
```

**Critical observation**: The catch block returns `[]` silently for parse errors. There is NO logging of the corruption in `SessionStore.load()`. This means:
- Server won't crash ✓
- Empty session list returned ✓
- **No log entry for corruption** — this may be a FAIL for the test criterion "Server logs indicate corruption was detected and handled"

### Server startup flow:
1. `sessions.init()` is called → calls `this.store.load()`
2. If `load()` returns `[]` (from corrupt file), `init()` iterates over empty array → no error
3. Server starts normally

### The logging question:
The test spec requires "Server logs indicate corruption was detected and handled." But `SessionStore.load()` has a comment `// Parse error or other IO error — return empty rather than crashing` — it returns `[]` silently.

**This means the test WILL FAIL the logging criterion** unless we check more carefully. The test spec says this is a FAIL condition: "Or corruption handled silently (no log entry)".

So this test is designed to detect an existing bug: silent handling without logging.

### The test should:
1. Verify server starts (it will — not a bug)
2. Verify app loads with empty session list (it will — not a bug)  
3. Verify server logs contain a corruption notice — **this will FAIL because SessionStore is silent**

---

## Infrastructure

- Port: 3136
- Server: node server-with-crash-log.mjs
- We write invalid JSON to sessions.json BEFORE starting the server
- sessions.json path: `${tmpDir}/sessions.json`

---

## Exact Test Flow

### Step 1: Prepare corrupt sessions.json
- Create tmpDir: `mktemp -d /tmp/qa-T39-XXXXXX`
- Create project directory in tmpDir
- Write valid projects.json (with ProjectStore seed format)
- Write INVALID sessions.json: `{broken json{{` (no closing brace, invalid syntax)
- sessions.json path: `${tmpDir}/sessions.json`

### Step 2: Start server
- Spawn `node server-with-crash-log.mjs` with DATA_DIR=tmpDir, PORT=3136, CRASH_LOG=tmpDir/crash.log
- Collect ALL server stdout and stderr output into a buffer
- Wait up to 15s for HTTP readiness (poll `GET /`)
- If server doesn't respond within 15s: FAIL — server crashed

### Step 3: Server startup check
- Assert HTTP 200 from `GET http://127.0.0.1:3136/` — server started
- Assert no crash log entries (crash.log should be empty or missing)
- Record: server_started = true

### Step 4: REST API check — empty session list
- `GET /api/sessions` — should return `[]` or `{"sessions":[]}`, not an error
- Parse response — assert sessions array is empty
- Record: sessions_empty = (list.length === 0)

### Step 5: Browser check
- Open Playwright browser, navigate to `http://127.0.0.1:3136/` with `waitUntil: 'domcontentloaded'`
- Wait 2s for WS init message and session list
- Observe session list: should show no sessions ("No sessions" empty state or similar)
- Take screenshot

### Step 6: Logging check
- Collect ALL stdout and stderr output captured from the server process
- Search for any mention of: "corrupt", "invalid", "parse", "error", "JSON", "sessions"
- Record what logs were produced
- Evaluate: was corruption logged? (any relevant log line)

### Step 7: Evaluate results
- server_crashed: did server fail to start? (FAIL if true)
- silent_corruption: were sessions served as corrupted data? (FAIL if true)
- sessions_empty: does app show empty session list? (PASS criterion)
- corruption_logged: did server log the corruption? (PASS criterion — likely FAIL in current implementation)

---

## False-PASS Risks

1. **Server never wrote sessions.json — test writes it fresh**: If tmpDir/sessions.json is written CORRECTLY (not corrupted) due to a test bug, server starts with valid data. Mitigation: explicitly read back the file contents before starting server to confirm it's corrupted.

2. **SessionStore creates sessions.json if missing**: If we forget to write the file and `sessions.json` doesn't exist, `ENOENT` is handled (returns `[]`). The test passes but never tested corruption — tested missing-file behavior. Mitigation: verify the file EXISTS (not ENOENT path) and contains the invalid JSON before starting server.

3. **Empty project list appears as correct behavior**: Even with valid sessions.json, the app may show "no sessions" if no sessions exist. The only way to distinguish "loaded empty due to corruption" from "no sessions in file" is to verify sessions.json WAS corrupted before server start. Mitigation: read the file back after writing.

4. **Logging from external source**: If sessions.json error is logged by something OTHER than SessionStore (e.g., WatchdogManager reading the file), a false logging detection could occur. Mitigation: check the exact log message for the word "sessions.json" or "parse error".

5. **INCONCLUSIVE result presented as PASS**: If the test checks `server_started && sessions_empty` but NOT `corruption_logged`, and the spec requires all three, reporting "PASS" is incorrect. Validator should check all three assertions are tested.

---

## Pass / Fail Criteria

**PASS:**
- Server starts without crashing (HTTP 200 on root)
- App loads with empty session list (0 sessions via REST)
- Server logs contain an entry indicating JSON parse failure or corruption detected

**FAIL:**
- Server crashes (no HTTP response after 15s, or crash.log has entries)
- Server silently serves corrupted data (sessions endpoint returns unparsed JSON or garbage)
- Corruption handled silently — no log entry (this is a REAL BUG in current implementation based on SessionStore.load() source)

**Expected outcome based on source code analysis:**
- Server starts: YES (bug-free path)
- Empty sessions: YES (bug-free path)
- Corruption logged: NO (SessionStore.load() has no logging for parse errors)
- **Result: PARTIAL PASS / FAIL on logging criterion**

---

## Implementation Note

The test should be implemented as a Node.js-native test (no Playwright needed for the core assertions). Playwright is optional for the browser check. The primary assertions are:
1. Server process doesn't die
2. REST API returns empty sessions
3. Server output (stdout + stderr) contains evidence of corruption handling
