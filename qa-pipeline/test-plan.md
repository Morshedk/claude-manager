# QA Test Plan — ws-reconnect-visibility

## Bug being tested
WebSocket reconnect fails silently when browser tab is backgrounded (timer throttling) AND sent
messages are dropped while disconnected. Four root causes:
1. `setTimeout(connect, 3000)` throttled by Chrome when tab is backgrounded — no visibilitychange listener
2. `send()` silently drops messages when socket not OPEN — no queue
3. `connected = signal(false)` is boolean-only — no "Reconnecting" intermediate state
4. `uncaughtException` handler does not sync-write before `process.exit(1)` — crash logs are lost

## Acceptance Flow Being Replicated
1. Open the app — verify status shows "Connected"
2. Break the connection (`pm2 stop claude-v2-beta`)
3. Observe status changes to "Reconnecting..."
4. While reconnecting: type a message in a terminal input and click Send
5. Restore the connection (`pm2 start claude-v2-beta`)
6. Observe status returns to "Connected" and the queued message is delivered to the terminal
7. Break connection again and wait through all retries
8. Observe final status: "Disconnected"
9. Check Logs tab: confirm retry timing and error details are visible there

---

## Steps

### Phase 1: Baseline — verify Connected state

1. [mcp_tool_call: browser_navigate(url: "http://127.0.0.1:3002")]
   Expected: App loads without error

2. [mcp_tool_call: browser_snapshot()]
   Expected: TopBar shows Connected status text and a green status dot

3. [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.status-text')?.textContent?.trim()")]
   Expected: Returns "Connected"

### Phase 2: Open a session and establish terminal focus

4. [mcp_tool_call: browser_snapshot()]
   Expected: At least one session is accessible in the sidebar

5. [mcp_tool_call: browser_click(element: "first session card in sidebar")]
   Expected: Session terminal overlay opens

6. [mcp_tool_call: browser_wait_for(time: 2)]
   Expected: Terminal renders with a shell prompt

7. [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.xterm-helper-textarea') ? 'found' : 'missing'")]
   Expected: Returns "found" — xterm input is mounted

### Phase 3: Stop server and observe reconnecting state

8. BASH STEP: `pm2 stop claude-v2-beta`
   Expected (bash): PM2 confirms stop

9. [mcp_tool_call: browser_wait_for(time: 2)]
   Expected: WebSocket close event fires; UI transitions away from "Connected"

10. ASSERTION 1 — Reconnecting state visible:
    [mcp_tool_call: browser_snapshot()]
    PASS condition: TopBar status text reads "Reconnecting..."
    FAIL condition (bug present): TopBar immediately shows "Disconnected" — because connected = signal(false)
    is boolean-only; TopBar has no "Reconnecting" branch in its JSX

11. [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.status-text')?.textContent?.trim()")]
    PASS condition: Returns "Reconnecting..."
    FAIL condition (bug present): Returns "Disconnected" or "Connected"

### Phase 4: Send a message while reconnecting (queue test)

12. ASSERTION 2 — Terminal input accessible while reconnecting:
    [mcp_tool_call: browser_evaluate(expression: "const el = document.querySelector('.xterm-helper-textarea'); el ? (el.disabled ? 'disabled' : 'enabled') : 'missing'")]
    PASS condition: Returns "enabled" — input not disabled/hidden during reconnect
    FAIL condition (bug present): Returns "disabled" or "missing"

13. [mcp_tool_call: browser_click(element: ".xterm-helper-textarea")]
    Expected: Terminal input focused

14. [mcp_tool_call: browser_type(text: "echo QUEUED_MESSAGE")]
    Expected: Text enters the terminal input

15. [mcp_tool_call: browser_press_key(key: "Enter")]
    Expected: Send action triggered (queued if fix applied, silently dropped if bug present)

16. [mcp_tool_call: browser_snapshot()]
    Expected: Input accepted keystrokes with no crash

### Phase 5: Restart server and verify reconnect + message delivery

17. BASH STEP: `pm2 start claude-v2-beta`
    Expected (bash): PM2 confirms start

18. [mcp_tool_call: browser_wait_for(time: 5)]
    Expected: WebSocket reconnects; server sends init message

19. ASSERTION 3a — Status returns to Connected:
    [mcp_tool_call: browser_snapshot()]
    PASS condition: TopBar status text reads "Connected"
    FAIL condition (bug present): Status stuck on "Reconnecting..." or shows "Disconnected"

20. [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.status-text')?.textContent?.trim()")]
    PASS condition: Returns "Connected"
    FAIL condition (bug present): Returns "Reconnecting..." or "Disconnected"

21. ASSERTION 3b — Queued message delivered after reconnect:
    [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.xterm-rows')?.textContent ?? ''")]
    PASS condition: Terminal content contains "QUEUED_MESSAGE"
    FAIL condition (bug present): Terminal does NOT contain "QUEUED_MESSAGE" — message silently dropped
    by send() returning early at connection.js:110-113 when socket was not OPEN

### Phase 6: Exhaust retries and verify Disconnected state

22. BASH STEP: `pm2 stop claude-v2-beta`
    Expected (bash): PM2 confirms stop

23. [mcp_tool_call: browser_wait_for(time: 35)]
    Expected: All reconnect retries exhausted (backoff cap reached, retry budget spent)

24. ASSERTION 4 — Final Disconnected state after retries exhausted:
    [mcp_tool_call: browser_snapshot()]
    PASS condition: TopBar shows "Disconnected" (not "Reconnecting...")
    FAIL condition (bug present): Status stuck on "Reconnecting..." — no retry cap

25. [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.status-text')?.textContent?.trim()")]
    PASS condition: Returns "Disconnected"

### Phase 7: Verify retry details in Logs tab only

26. [mcp_tool_call: browser_snapshot()]
    Expected: Logs tab visible in navigation

27. [mcp_tool_call: browser_click(element: "Logs tab in ThirdSpaceTabBar")]
    Expected: Logs panel opens with structured log entries

28. ASSERTION 4 (Logs):
    [mcp_tool_call: browser_evaluate(expression: "Array.from(document.querySelectorAll('[data-log-entry], .log-entry, .log-row')).map(el => el.textContent).join(' ')")]
    PASS condition: Text contains reconnect/retry content ("reconnect", "attempt", "close", "ws")
    FAIL condition (bug present): Log panel empty or no WS reconnect entries

29. [mcp_tool_call: browser_evaluate(expression: "document.querySelector('.status-text')?.textContent?.trim()")]
    Expected: Still "Disconnected" — retry info in Logs only, no main-UI banners

30. BASH STEP (cleanup): `pm2 start claude-v2-beta`
    Expected: Server restored

---

## Pre-fix expected output

**ASSERTION 1 fails**: `store.js` exports `connected = signal(false)` — boolean only. `TopBar.js` has
two branches: "Connected" (true) or "Disconnected" (false). No code path produces "Reconnecting...".
Step 11 evaluate returns "Disconnected", not "Reconnecting...".

**ASSERTION 3b fails**: `connection.js:110-113` returns immediately when socket not OPEN — no queue,
no buffer, no flush on reconnect. "QUEUED_MESSAGE" will not appear in the terminal.

## Post-fix expected output

- ASSERTION 1 PASS: connectionStatus = signal('connected' | 'reconnecting' | 'disconnected').
  On close → 'reconnecting'. TopBar renders "Reconnecting...".
- ASSERTION 2 PASS: Terminal input stays enabled during reconnect.
- ASSERTION 3a PASS: On reconnect → 'connected'. TopBar → "Connected".
- ASSERTION 3b PASS: send() buffers to queue when not OPEN. Flush on connection:open.
  Terminal shows "QUEUED_MESSAGE" after reconnect.
- ASSERTION 4 PASS: After exponential backoff + retry budget exhausted → 'disconnected'. TopBar → "Disconnected".
- ASSERTION 4 (Logs) PASS: Retry details in Logs tab. No main-UI banners.
