# T-46 Design: WS Reconnect Restores Terminal Subscription for Active Session

**Port:** 3143  
**Score:** 13  
**Type:** WS protocol + Playwright browser

---

## Test Goal

Verify that when the WebSocket drops while a terminal overlay is open, the TerminalPane automatically re-subscribes to the active session on reconnect — without any user action — and that new PTY output streams into the terminal after reconnect.

---

## Code Path Analysis

### connection.js — Reconnect dispatch

`connection.js` line 53–57: On WS `close`, `connection:close` is dispatched and `setTimeout(connect, 3000)` schedules a reconnect. On reconnect success (`open` event), `connection:open` is dispatched.

### TerminalPane.js — Re-subscribe on reconnect

`TerminalPane.js` lines 152–165 contain the critical handler:

```js
const handleReconnect = () => {
  xterm.reset();
  const dims = fitAddon.proposeDimensions();
  send({
    type: CLIENT.SESSION_SUBSCRIBE,
    id: sessionId,
    cols: dims?.cols || cols,
    rows: dims?.rows || rows,
  });
};
on('connection:open', handleReconnect);
```

This handler is registered during the `useEffect` and removed during cleanup. As long as `TerminalPane` remains mounted (i.e., the session overlay is not closed), `handleReconnect` fires on every `connection:open` event, sending a fresh `session:subscribe`.

### The disconnect flow — what is lost

When WS drops:
1. Server sees WS close → removes all subscriptions for that client WS
2. Client sees WS `close` → dispatches `connection:close` → sets `connected = false`
3. After 3s, client reconnects → new WS assigned to `_ws`
4. Server sends `init` → client dispatches `connection:open`
5. `handleReconnect` fires → sends `session:subscribe` with correct `sessionId`
6. Server replies with `session:subscribed` (triggers `xterm.reset()`) then replays scrollback
7. Live PTY output resumes

### Key question

Does `TerminalPane` listen for `connection:open` and re-subscribe? **Yes, it does** (lines 155–166). The handler is wired in the same `useEffect` that wires session output handlers.

### False-PASS risks

1. **Test closes overlay before dropping WS** — TerminalPane unmounts, `handleReconnect` removed, no re-subscribe sent. Test would show failure if assertions looked for subscribe. But if test checks only "reconnect happens" (status dot), that would vacuously pass.

2. **Terminal shows stale cached content** — scrollback from before disconnect might still be visible even if no new content came. Checking `.xterm-screen` text length alone doesn't prove live output arrived after reconnect. Must send a unique marker command AFTER reconnect and wait for it to appear.

3. **`window._testWs` proxy tracks initial WS only** — After reconnect, `connection.js` calls `new WebSocket(...)` again. The Proxy constructor intercept captures both the old and the new WS, updating `window._testWs` each time. This is correct; the proxy must track the latest instance.

4. **Subscribe count double-counts** — The initial TerminalPane mount sends a subscribe, then reconnect sends another. Asserting `subCount === 2` after one reconnect confirms exactly one re-subscribe happened.

5. **PTY session dies during WS drop** — Using a `bash` session (not Claude) avoids TUI startup delays. The PTY keeps running regardless of WS state. Must verify via `/api/sessions` that PID is still alive after reconnect.

6. **`connection:open` fires before TerminalPane is mounted** — On initial page load, `connection:open` fires from the WS `open` event. But `handleReconnect` is only registered inside the `useEffect` which runs after the component mounts. On initial load, `connect()` is called from `main.js` before the component mounts. If the WS connects before the component mounts, `handleReconnect` is not yet registered and initial subscribe is handled by the explicit `send(SESSION_SUBSCRIBE)` in section 7 of the useEffect. The test should verify the *reconnect* subscribe path, not the initial one. Starting state must be: component mounted, initial subscribe sent, then drop WS.

---

## Infrastructure Setup

### Server startup
```js
serverProc = spawn('node', ['server-with-crash-log.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: '3143', CRASH_LOG: crashLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Poll `GET /api/sessions` until response is 200 (up to 10s).

### Project seed
```json
{
  "projects": [
    { "id": "proj-t46", "name": "T46-Project", "path": "/tmp", "createdAt": "2026-01-01T00:00:00Z" }
  ],
  "scratchpad": []
}
```

### WS proxy intercept (injected via `page.addInitScript` BEFORE navigation)

```js
window._subscribeCount = 0;
window._lastSubscribeId = null;
window._wsInstances = [];

const NativeWS = window.WebSocket;
window.WebSocket = new Proxy(NativeWS, {
  construct(target, args) {
    const instance = new target(...args);
    window._wsInstances.push(instance);
    window._testWs = instance; // always latest
    const origSend = instance.send.bind(instance);
    instance.send = function(data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'session:subscribe') {
          window._subscribeCount++;
          window._lastSubscribeId = msg.id;
        }
      } catch {}
      return origSend(data);
    };
    return instance;
  }
});
```

---

## Exact Test Execution Steps

### Step 1: Navigate and wait for connection
- `goto(BASE_URL, { waitUntil: 'domcontentloaded' })`
- Wait for `.status-dot.connected` (up to 8s)

### Step 2: Select project
- Click `.project-item` containing "T46-Project"
- Wait for project to be selected (active class)

### Step 3: Create a bash session
- Click "New Claude Session" button (`#sessions-area .btn-primary`)
- Fill session name: "t46-bash"
- Fill command field: "bash"
- Click "Start Session"
- Wait for `.session-card` showing "t46-bash" + "running" badge (up to 8s)
- Confirm via `GET /api/sessions` that the session exists with `status === 'running'` and `pid > 0`
- Record `sessionId` and `ptyPid`

### Step 4: Open terminal overlay
- Click session card for "t46-bash"
- Wait for `#session-overlay` visible (up to 5s)
- Wait for `#session-overlay-terminal .xterm-screen` visible (up to 5s)
- Wait 500ms for xterm to settle

### Step 5: Record baseline subscribe count and send baseline marker
- Sleep 300ms to let any pending subscribes settle
- Record `baselineSubCount = window._subscribeCount` (expect >= 1)
- Type `echo T46_BASELINE` + Enter
- Wait for "T46_BASELINE" in `#session-overlay-terminal .xterm-screen` textContent (up to 8s)
- Verify `window._testWs.readyState === WebSocket.OPEN`

### Step 6: Force-close the WS
- `page.evaluate(() => { window._testWs.close(); })`
- Wait for `.status-dot.connected` to DISAPPEAR (i.e., `waitForFunction(() => !document.querySelector('.status-dot.connected'))`, up to 5s)
- Record disconnect timestamp

### Step 7: Wait for auto-reconnect (no user action)
- Wait for `.status-dot.connected` to reappear (up to 10s)
- Record reconnect duration
- Assert reconnect < 10000ms
- Verify status text contains "Connected"

### Step 8: Verify re-subscribe was sent
- Sleep 500ms to allow `handleReconnect` to fire and message to be sent
- `resubCount = window._subscribeCount`
- Assert `resubCount === baselineSubCount + 1` (exactly one re-subscribe after reconnect)
- Assert `window._lastSubscribeId === sessionId` (correct session ID used)

### Step 9: Verify live output after reconnect
- Sleep 1000ms to allow `session:subscribed` + scrollback replay to arrive
- Check terminal not blank: `#session-overlay-terminal .xterm-screen` textContent length > 0
- Type unique marker `echo T46_RECONNECT_<timestamp>` + Enter
- Wait for marker to appear in terminal (up to 8s) — this proves live output flows

### Step 10: No duplicate output check
- Type `echo T46_DUPCHECK_<timestamp>` + Enter
- Wait for it to appear
- Sleep 200ms settle time
- Count occurrences in terminal textContent
- Assert count <= 3 (echo shows: command echo + output = typically 2; >3 indicates duplicate subscription)

### Step 11: Server state unchanged
- `GET /api/sessions` → session must still be `running`, same `pid`
- `process.kill(ptyPid, 0)` → PTY process must still be alive

### Step 12: Second round (reliability)
- Repeat Steps 6–11 with a second WS drop
- Assert `window._subscribeCount === baselineSubCount + 2` after two reconnects

### Step 13: Crash log check
- Read crash log, filter to test window
- Assert no crash entries

---

## Pass / Fail Criteria

| Check | PASS | FAIL |
|-------|------|------|
| Auto-reconnect | `.status-dot.connected` reappears < 10s | Still disconnected at 10s |
| Re-subscribe sent | `subscribeCount = baseline + 1` | Count unchanged after reconnect |
| Correct session ID | `lastSubscribeId === sessionId` | Wrong ID or null |
| Terminal not blank | `xterm-screen` textContent length > 0 after reconnect | Empty terminal |
| Live output | Unique typed marker appears after reconnect | Marker not found in 8s |
| No duplicates | Marker count <= 3 | Count > 3 (doubled output) |
| PTY alive | Session still running in API, PID same | Session stopped or PID changed |
| No crashes | Crash log empty | Any server exception during test |

---

## What a Vacuous PASS Would Look Like

If the test checks "terminal not blank" without checking that new typed input echoes back, the test would pass even if `handleReconnect` were broken — because old scrollback from before the drop might still be displayed in the xterm buffer (xterm doesn't clear on WS drop, only on `session:subscribed`). The live marker check (Step 9) is the definitive proof that the subscription is working.

If `window._subscribeCount` stays at baseline after reconnect, it means `handleReconnect` never fired — the re-subscribe mechanism is broken — even if the terminal appears to have content.
