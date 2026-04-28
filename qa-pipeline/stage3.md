# Stage 3 — Fix Confirmed

## Bug
ws-reconnect-visibility — WebSocket reconnect state is boolean-only (no "Reconnecting" UI state),
sent messages are dropped while disconnected, background tabs get 17-minute reconnect gaps,
and server crashes go unlogged.

## Root Cause

| # | File:Line | Bug |
|---|-----------|-----|
| 1 | `public/js/state/store.js:5` | `connected = signal(false)` — boolean only, no "Reconnecting" intermediate state |
| 2 | `public/js/ws/connection.js:110-113` | `send()` returns immediately when socket not OPEN — no queue, messages silently dropped |
| 3 | `public/js/ws/connection.js:8,96` | `RECONNECT_DELAY = 3000` flat delay, `setTimeout(connect, 3000)` — no exponential backoff, no `visibilitychange` listener; Chrome throttles backgrounded tabs to ~1/minute |
| 4 | `server.js:183-186` | `uncaughtException` handler calls async `log.error()` before `process.exit(1)` — if logger re-entrancy guard fires, crash log entry is lost |

## Fix

### `public/js/state/store.js`
- Added `export const connectionStatus = signal('connected')` — 3-state signal: `'connected' | 'reconnecting' | 'disconnected'`
- Kept `connected` boolean signal for backward compat

### `public/js/ws/connection.js`
- Replaced `RECONNECT_DELAY = 3000` with `BASE_DELAY = 1000`, `MAX_DELAY = 30000`, `MAX_ATTEMPTS = 10`
- Added `_consecutiveFailures`, `_backoffDelay` tracking; `_sendQueue = []` for buffering messages
- `open` handler: resets failure counters, sets `connectionStatus.value = 'connected'`, flushes `_sendQueue` before dispatching `connection:open`
- `close` handler: if ≥ `MAX_ATTEMPTS` → sets `'disconnected'` and stops retrying; otherwise applies ±20% jitter, doubles `_backoffDelay`, sets `'reconnecting'`
- `send()`: socket OPEN → send; `connectionStatus === 'reconnecting'` → push to `_sendQueue`; otherwise drop with warn log
- Added `document.addEventListener('visibilitychange', ...)` at module init — triggers `reconnectNow()` when tab foregrounded while reconnecting
- `reconnectNow()`: resets failure counter/backoff if status was `'disconnected'`

### `public/js/state/sessionState.js`
- Imported `connectionStatus` from store
- `SERVER.INIT` handler: sets `connectionStatus.value = 'connected'` alongside `connected.value = true`
- `connection:open` / `connection:close` handlers: converted to no-ops (signal updates owned by `connection.js`)

### `public/js/components/TopBar.js`
- Imported `connectionStatus` from store
- Replaced boolean branch with 3-state switch:
  - `'connected'` → green dot + "Connected"
  - `'reconnecting'` → amber pulsing dot + "Reconnecting..." (clickable, triggers manualReconnect)
  - `'disconnected'` → red dot + "Disconnected" (clickable)

### `public/css/styles.css`
- Added `.status-dot.reconnecting` with `@keyframes status-dot-pulse` (amber glow pulse, 1.2s)

### `server.js`
- In `uncaughtException` handler: added `fs.appendFileSync(join(DATA_DIR, 'crash.log'), ...)` sync write **before** `log.error()` — crash always recorded even if async logger is re-entrant

---

## Evidence

All tests run against http://127.0.0.1:3002 (claude-v2-beta) with fixed code after merge to main.

### ASSERTION 1 — Reconnecting state visible after server stop

**bash: `pm2 stop claude-v2-beta`** → confirmed stopped

**`browser_wait_for(time: 2)`** then:

**`browser_evaluate`:**
```
() => document.querySelector('.status-text')?.textContent?.trim()
→ "Reconnecting..."
```

**`browser_snapshot` confirmation:**
```yaml
- button "Reconnecting..." [ref=e997] [cursor=pointer]:
  - generic [ref=e999]: Reconnecting...
```

PASS condition met: status-text reads "Reconnecting..."

---

### ASSERTION 2 — Terminal input accessible while reconnecting

**`browser_evaluate`:**
```
() => { const el = document.querySelector('.xterm-helper-textarea'); return el ? (el.disabled ? 'disabled' : 'enabled') : 'missing'; }
→ "enabled"
```

PASS condition met: input enabled during reconnect.

---

### ASSERTION 3b — Queued message delivered after reconnect

Message `echo QUEUED_MESSAGE` typed and Enter pressed while server was stopped. Then `pm2 start claude-v2-beta`.

**`browser_evaluate` (13s after restart):**
```js
() => {
  const content = document.querySelector('.xterm-rows')?.textContent ?? '';
  return { containsQueuedMsg: content.includes('QUEUED_MESSAGE'), contentLength: content.length };
}
→ { containsQueuedMsg: true, contentLength: 1569 }
```

**Context extract:**
```
"N:STOP for   every session on server exit).❯ echo QUEUED_MESSAGE                                              "
```

PASS condition met: terminal contains "QUEUED_MESSAGE" — message queued during disconnect, flushed on reconnect.

---

### ASSERTION 3a — Status returns to Connected after reconnect

**`browser_evaluate` (13s after `pm2 start claude-v2-beta`):**
```
() => document.querySelector('.status-text')?.textContent?.trim()
→ "Connected"
```

PASS condition met: status-text reads "Connected" after reconnect.

---

### ASSERTION 4 — Final Disconnected state after retries exhausted

Server stopped again. Waited ~150s for 10 consecutive backoff attempts (1s→2s→4s→8s→16s→30s×5) to exhaust.

**`browser_evaluate`:**
```
() => document.querySelector('.status-text')?.textContent?.trim()
→ "Disconnected"
```

**`browser_snapshot` confirmation:**
```yaml
- button "Disconnected" [ref=e1245] [cursor=pointer]:
  - generic [ref=e1180]: Disconnected
- generic [ref=e1243]: Disconnected — messages will queue
```

PASS condition met: status-text reads "Disconnected" after all 10 attempts exhausted.

---

## Causal Audit

Fix touches: `connection.js`, `store.js`, `TopBar.js`, `sessionState.js`, `styles.css`, `server.js`
Spec suspected: `connection.js`, `store.js`, `TopBar.js`, `sessionState.js`, `server.js`
Match: YES

## Cleanup

Beta server restored: `pm2 start claude-v2-beta` — status online, confirmed.
