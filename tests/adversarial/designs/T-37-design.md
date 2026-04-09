# T-37 Design: WS Drop During Streaming — Buffer Replays Correctly on Reconnect

**Score:** 12 | **Type:** Playwright browser + WS protocol | **Port:** 3134

---

## What This Test Proves

When the WebSocket connection is dropped mid-stream (while terminal output is flowing), and the browser auto-reconnects, the terminal should display a coherent buffer with no:
- Duplicate lines (double-replay of scrollback)
- Partial ANSI escape sequences corrupting rendering

This tests the reconnect + re-subscribe flow in `connection.js` and `TerminalPane.js`.

---

## Key Architecture Understanding

### WS reconnect flow (from source):
1. `connection.js` auto-reconnects after 3s on close (`RECONNECT_DELAY = 3000`)
2. On reconnect, `dispatch({ type: 'connection:open' })` fires
3. `TerminalPane.js` (line 156-165): On `connection:open`, calls `xterm.reset()` then sends `session:subscribe` again
4. Server receives `session:subscribe`, registers viewer, sends `session:subscribed`, then replays scrollback via viewer callback
5. `TerminalPane` on `session:subscribed`: calls `xterm.reset()` (line 131-133)
6. Result: xterm is reset twice — once preemptively on reconnect, once on receiving `session:subscribed`

### The double-replay risk:
- If the client re-subscribes and the server replays, and the client does NOT clear xterm first, content would be duplicated
- But `xterm.reset()` is called on `session:subscribed`, so each reconnect clears the buffer before replay
- The real risk is: does the server actually replay the full correct scrollback, or does it replay a partial/garbled buffer?

### How bash output works (for test):
- Session is created with command `bash` (not claude)
- We send `seq 1 200` + `\r` to produce 200 lines of predictable output
- We can use a sentinel line to know when streaming finishes

---

## Infrastructure

- Port: 3134
- App dir: `/home/claude-runner/apps/claude-web-app-v2`
- Server: `node server-with-crash-log.mjs` with DATA_DIR, PORT, CRASH_LOG env vars
- tmpDir: `mktemp -d /tmp/qa-T37-XXXXXX`
- ProjectStore seed format: `{ "projects": [...], "scratchpad": [] }`

---

## Exact Test Flow

### Step 1: Server setup
- Kill any process on port 3134
- Create tmpDir with project directory
- Write projects.json with the correct seed format
- Spawn server, wait up to 25s for HTTP readiness

### Step 2: Create a bash session via WS
- Open WebSocket to `ws://127.0.0.1:3134`
- Wait for `init` message
- Send `session:create` with `{ projectId, name: 'bash-stream', command: 'bash', mode: 'direct' }`
- Wait for `session:created` response, capture `sessionId`
- Wait for `session:subscribed` (auto-subscribe on create)
- Wait for `session:state` with `state: 'running'`

### Step 3: Send 200 lines of output
- Send WS input: `seq 1 200\r` (note: `\r` not `\n`)
- Wait for output to contain "200" (the last line of seq output)
- Wait 1 additional second for output to settle

### Step 4: Open Playwright browser
- Navigate to `http://127.0.0.1:3134` with `waitUntil: 'domcontentloaded'`
- Wait for project list to load
- Click the project in sidebar
- Click the session card to open terminal overlay
- Wait for TerminalPane to mount (observe terminal container)
- Wait 2s for scrollback to fully render in xterm

### Step 5: Record pre-disconnect state
- Evaluate `document.querySelector('.xterm-viewport')?._scrollState()` to get `bufferLength` and `scrollMax`
- Assert `bufferLength > 10` (content is present — if 0 or near 0, abort as INCONCLUSIVE)
- Scroll up in terminal to simulate user having scrolled up

### Step 6: Kill the WebSocket connection mid-stream
- Use `page.evaluate(() => { window._ws && window._ws.close(); })` — but `_ws` may not be exposed
- Alternative: `page.evaluate(() => { const ws = Object.values(window).find(v => v instanceof WebSocket); if (ws) ws.close(); })`
- Better approach: evaluate the connection module directly
- Actual approach: since `connection.js` stores `_ws` as module-level private, use:
  `page.evaluate(() => { Array.from(document.querySelectorAll('*')).forEach(e => {}); })` — won't work
- **Best approach**: Intercept via Playwright's `page.route()` to abort WS — but WebSocket routing is limited
- **Correct approach**: Use `page.evaluate()` to find and close the WebSocket:
  ```javascript
  page.evaluate(() => {
    // WebSocket is stored in module scope, but we can find it via global event handlers
    // connection.js exposes `connect` but not `_ws` — however the WS object itself
    // is accessible via the module's closure
    // We can find it by checking `performance.getEntriesByType('resource')` — no
    // Actually: just enumerate all open WebSocket connections:
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    // The WS URL is `${proto}//${location.host}`
    // We can't enumerate WebSockets via JS directly
    // HOWEVER: connection.js creates `_ws = new WebSocket(...)` 
    // We can intercept by monkey-patching BEFORE the page loads — but we're already loaded
    // PRAGMATIC: use CDP to abort the WS transport
  })
  ```
- **Final approach for this test**: Use Playwright CDP session to close the WS:
  ```javascript
  const cdpSession = await page.context().newCDPSession(page);
  // Get all open WebSockets via CDP
  // OR: simply use page.evaluate to call the app's own disconnect function if exposed
  ```
- **Simplest that works**: Expose the WS close via `page.evaluate`:
  ```javascript
  await page.evaluate(() => {
    // Monkey patch: intercept the WebSocket constructor retrospectively
    // The WS object is created at app init — we need a reference
    // Best bet: look for it in the global scope or via performance entries
    // connection.js line 8: let _ws = null; — module private, not on window
    // 
    // PRAGMATIC SOLUTION: block network and force close
    // Use XMLHttpRequest abort trick — nope, WS is different
    //
    // ACTUAL SOLUTION: use page.evaluate to run CDP directly isn't possible
    // Use: context.setOffline(true) to simulate network drop
  });
  ```

### Step 6 (revised): Use `page.context().setOffline(true)` to simulate network drop
- This cuts off the WS connection (server-side the socket will eventually close)
- Wait 1s for connection to drop
- Bring network back: `await page.context().setOffline(false)`
- Wait 4s for reconnect timer (3s + buffer)
- Wait for `connection:open` to fire (terminal should re-subscribe)
- Total wait: 5s after network restored

### Step 7: Produce additional output after reconnect
- Open a NEW WebSocket from the test process (Node.js)
- Send `session:subscribe` to get viewer
- Send input: `echo RECONNECT_MARKER_T37\r`
- Wait for `RECONNECT_MARKER_T37` to appear in WS output (confirms session still alive)

### Step 8: Assertions in browser
- `bufferLength` post-reconnect must be > 0
- Scan terminal textContent: count occurrences of specific line numbers (e.g. line "100")
  - If "100" appears more than once, that's a duplicate-replay bug
- Check terminal text does not contain known ANSI corruption patterns (stray ESC sequences as literals)
- `scrollMax` should be > 0 (content has depth)
- Scroll state should be coherent (not at scrollMax = 0 if content exists)

---

## False-PASS Risks

1. **Vacuous buffer check**: `bufferLength > 0` passes if reconnect produced even 1 byte. Must verify substantial content exists (>100 lines or line "200" visible).

2. **Network offline test doesn't actually close WS**: Some browsers/environments may not respect `setOffline`. Verify by checking if `connection:close` event fired in the app.

3. **Test produces output AFTER browser opens** — if `seq 1 200` runs before browser subscribes, the `session:subscribed` event triggers `xterm.reset()` and wipes it. **Mitigation**: Open browser FIRST, click into session to subscribe terminal, THEN run `seq 1 200`. Wait for line "200" to appear in xterm.

4. **Double xterm.reset() issue**: `handleReconnect` in TerminalPane calls `xterm.reset()` on `connection:open` AND the server sends `session:subscribed` which also calls `xterm.reset()`. If the reconnect clears the buffer BEFORE the replay, and the replay only sends live output (not scrollback), the terminal will appear empty. Check: does `subscribe()` in SessionHandlers replay scrollback? Look at `this.sessions.subscribe()`.

5. **Line duplication from double-replay**: If somehow xterm is NOT reset before replay, and replay adds lines on top of existing lines, `"100"` will appear at two positions. The DOM check is the verification.

---

## Pass / Fail Criteria

**PASS:**
- Terminal shows coherent content after reconnect (bufferLength > 50 lines)
- No line number appears more than once in terminal text (no double-replay)
- Terminal text contains no raw ANSI escape sequences visible as text (e.g., `\x1b[`, `?1;2c`)
- Session remains alive after reconnect (RECONNECT_MARKER_T37 visible or session state is running)

**FAIL:**
- Terminal empty after reconnect (buffer wiped but not replayed)
- A specific line number found twice in terminal text (double-replay)
- Raw ANSI characters visible in terminal output as text
- Session died during reconnect

**INCONCLUSIVE:**
- Cannot determine buffer state from DOM
- Network offline didn't actually close the WS (detect: session:subscribed never received after reconnect)

---

## Session Subscribe Scrollback Review

Check `lib/sessions/SessionManager.js` `subscribe()` to understand if scrollback is replayed on re-subscribe. This is the critical question: after WS reconnect, does the server send scrollback to the new subscriber, or only live output from that point?

If scrollback IS replayed: xterm.reset() before replay prevents duplication — no bug expected.
If scrollback is NOT replayed: terminal will be empty or only show new output — this may be "by design" or may be a bug depending on spec.
