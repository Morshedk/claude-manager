---
# QA Spec

## Bug
WebSocket reconnect fails silently when browser tab is backgrounded (timer throttling) AND sent messages are dropped while disconnected. Users see a stuck "disconnected" state with no feedback, no retry, and lost messages.

## Acceptance Criteria
Given: The app has an active WS connection and the server becomes unreachable (SSH tunnel drop, server restart, etc.)
When:  The connection is lost — whether the tab is in foreground or background
Then:
  1. Status immediately changes to "Reconnecting..." (visible in the UI)
  2. User can type into any terminal input and click Send — the message is queued (not dropped)
  3. On successful reconnect: queued messages are sent, status changes to "Connected"
  4. If all retries are exhausted: status changes to "Disconnected"
  5. Retry timing, error details, and next-retry countdown appear in the Logs tab only — not in the main UI

## Acceptance Flow (from user)
1. Open the app — verify status shows "Connected"
2. Break the connection (SSH tunnel drop / `pm2 stop claude-v2-beta`)
3. Observe status changes to "Reconnecting..."
4. While reconnecting: type a message in a terminal input and click Send
5. Restore the connection (`pm2 start claude-v2-beta`)
6. Observe status returns to "Connected" and the queued message is delivered to the terminal
7. Break connection again and wait through all retries
8. Observe final status: "Disconnected"
9. Check Logs tab: confirm retry timing and error details are visible there

Expected observable outcome: Three distinct UI states (Connected / Reconnecting / Disconnected). Messages typed while disconnected are not lost. Error detail stays in Logs.

## Specific Instance
Reproducible: Yes — triggered by any server stop (pm2 stop) or tunnel drop
Session: Any active session

## Preliminary Investigation

**Root causes found (2026-04-27 investigation):**

### Bug 1: Browser timer throttling kills reconnect when tab is backgrounded
- `public/js/ws/connection.js:8` — `RECONNECT_DELAY = 3000` flat delay, no backoff
- `connection.js:96` — `setTimeout(connect, RECONNECT_DELAY)` — no Page Visibility API
- Chrome/Chromium throttles `setTimeout` to ~1/minute for backgrounded tabs
- Evidence: beta connection log shows 17–18 minute gaps between socket errors at 11:55, 12:12, 12:22
- At 12:22 (tab came to foreground) errors became rapid-fire every 3s — tab fidelity restored
- Fix: `document.addEventListener('visibilitychange', ...)` → call `reconnectNow()` on tab focus

### Bug 2: No message queue — sends silently dropped while disconnected
- `connection.js:110-114` — `send()` checks `ws.readyState !== OPEN`, logs warn, returns
- Nothing is buffered; user messages sent during disconnect are permanently lost
- Fix: buffer sends in a queue while disconnected, flush on reconnect

### Bug 3: No "Reconnecting" UI state — only boolean connected/disconnected
- `public/js/state/store.js` — `connected = signal(false)` (boolean only)
- UI has no "reconnecting" intermediate state
- Fix: `connectionStatus = signal('connected' | 'reconnecting' | 'disconnected')`

### Bug 4: Server crashes silently — uncaughtException not logged
- `server.js:183-186` — `log.error()` called before `process.exit(1)` in uncaughtException handler
- If logger hits re-entrancy guard (`_writing = true`), crash exits with no log entry
- Evidence: 139 server restarts visible in PM2, zero crash stack traces in app.log.jsonl
- Fix: `fs.appendFileSync(CRASH_LOG, ...)` sync write before calling `log.error()`

**Files to modify:**
- `public/js/ws/connection.js` — backoff, visibility hook, send queue
- `public/js/state/store.js` — connectionStatus signal (3 states)
- `public/js/state/sessionState.js` — handle new connectionStatus signal
- `public/js/components/TopBar.js` (or StatusBar) — display 3-state status
- `server.js` — sync crash log in uncaughtException handler

## Confirmed
true
