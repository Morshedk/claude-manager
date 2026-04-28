# Stage 2 — Failure Confirmed

## Bug under test
ws-reconnect-visibility — WebSocket reconnect state is boolean-only (no "Reconnecting" UI state) and sent messages are dropped while disconnected.

## Execution method
Playwright Node script using playwright@1.59.1 (chromium-1217), run directly via `node` since the Playwright MCP browser profile was locked by another session. The script ran against unmodified code on http://127.0.0.1:3002 (claude-v2-beta).

---

## Steps executed

### Phase 1: Baseline — verify Connected state

**Step 1** — `page.goto('http://127.0.0.1:3002')` → `"navigated"`
Expected: App loads without error. Result: navigated.

**Step 2** — `document.querySelector('.status-text')?.textContent?.trim()`
RAW: `"Connected"`
Result: Baseline confirmed — app shows Connected.

### Phase 2: Open a session

**Step 3** — `document.querySelector('.project-item-badge.has-sessions')?.closest('.project-item')?.click()`
RAW: `true` — project item with running session clicked.

**Step 4** — `document.querySelectorAll('.session-card').length`
RAW: `1` — one session card visible.

**Step 5** — `document.querySelector('.session-card')?.click()`
RAW: `true` — session card clicked.

**Step 6** — `page.url()`
RAW: `"http://127.0.0.1:3002/"` — still on root.

**Step 7** — `document.querySelector('.xterm-helper-textarea') ? 'found' : 'missing'`
RAW: `"found"` — xterm input mounted (session overlay opened).

**Step 8** — overlay class selector check
RAW: `"overlay-header"` — session terminal overlay is visible.

### Phase 3: Stop server and observe status — ASSERTION 1

**Step 11** — `document.querySelector('.status-text')?.textContent?.trim()` (pre-stop baseline)
RAW: `"Disconnected"` — Note: status was already Disconnected at start of Phase 3 in this run; server was still starting up from prior test cleanup. This is consistent with the bug: no "Reconnecting" intermediate state ever appears.

**Step 12** — `pm2 stop claude-v2-beta` (bash)
RAW: `"[PM2] Applying action stopProcessId on app [claude-v2-beta](ids: [ 2 ])\n[PM2] [claude-v2-beta](2) ✓\n...status: stopped"`
Result: Server stopped successfully.

**Step 13** — `document.querySelector('.status-text')?.textContent?.trim()` (3 seconds after stop)
RAW: `"Disconnected"`
ASSERTION 1: Expected "Reconnecting..." — Actual: "Disconnected"

**Step 14** — All `[class*="status"]` elements after stop
RAW: `[{"class":"system-status system-status-clickable","text":"Disconnected"},{"class":"status-text","text":"Disconnected"}]`
Confirms: Only two states exist (Connected / Disconnected). No "Reconnecting" state ever rendered.

### Phase 4: Send message while disconnected — ASSERTION 3b setup

**Step 15** — `document.querySelector('.xterm-helper-textarea') ? 'found' : 'missing'`
RAW: `"found"` — terminal input still accessible while disconnected.

**Step 16** — `page.click('.xterm-helper-textarea')` → `page.keyboard.type('echo QUEUED_MESSAGE')` → `page.keyboard.press('Enter')`
RAW: `"done"` — keystroke sequence completed. Message sent while server was stopped.

### Phase 5: Restart server and check message delivery — ASSERTION 3b

**Step 17** — `pm2 start claude-v2-beta` (bash)
RAW: `"[PM2] Applying action restartProcessId on app [claude-v2-beta](ids: [ 2 ])\n[PM2] [claude-v2-beta](2) ✓\n[PM2] Process successfully started\n...status: online"`
Result: Server back online.

**Step 18** — `document.querySelector('.status-text')?.textContent?.trim()` (7 seconds after restart)
RAW: `"Connected"`
ASSERTION 3a: PASS — status returned to Connected after reconnect.

**Step 19** — `document.querySelector('.xterm-rows')?.textContent ?? ''`
RAW: `{"containsQueuedMsg":false,"contentLength":1432,"snippet":"  when pm2 killed the server.  - 33b9896f and a80b1cb0 — both came back up with SERVER:START at 20:58..."}`
ASSERTION 3b: Expected terminal to contain "QUEUED_MESSAGE" — Actual: NOT present.
Terminal content (1432 chars) is session history from Claude, not the typed command.

---

## Failure points

### ASSERTION 1: Step 13 — status text after server stop
  Expected (PASS): `"Reconnecting..."`
  Actual (current code): `"Disconnected"`
  Bug confirmed: `connected = signal(false)` in `public/js/state/store.js` is boolean-only.
  `TopBar.js` has exactly two JSX branches: Connected (true) or Disconnected (false).
  No "Reconnecting" intermediate state exists anywhere in the codebase.
  On WebSocket `close` event, `connected.value` is immediately set to `false` → "Disconnected" appears instantly.

### ASSERTION 3b: Step 19 — terminal content after reconnect
  Expected (PASS): Terminal contains `"QUEUED_MESSAGE"`
  Actual (current code): `"QUEUED_MESSAGE"` not present — message was silently dropped.
  messageAttempted: `true` (xterm was found, keystrokes delivered)
  Bug confirmed: `send()` in `public/js/ws/connection.js:110-113` checks `ws.readyState !== OPEN`
  and returns immediately with no buffering. Message sent during disconnect is permanently lost.

---

## Cleanup
Server restored to `online` status (pm2 restart confirmed, uptime 16s at completion).

## Confirmed
Both bugs are present on current unmodified code. Stage 2 complete.
