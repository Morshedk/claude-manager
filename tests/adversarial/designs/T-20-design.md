# T-20: Two Browser Tabs Watching Same Session — One Refreshes, Other Updates

**Score:** L=2 S=4 D=5 (Total: 11)
**Test type:** Playwright browser (two browser contexts = two tabs)
**Port:** 3117

---

## 1. What This Test Proves

When two independent browser tabs both view the same session's terminal overlay and Tab 1 triggers a session refresh:

1. **Tab 2 auto-reconnects** — it receives `session:subscribed` via `broadcastToSession` and resets its xterm buffer
2. **No cross-PTY bleed** — Tab 2 does NOT show output from the old PTY after the refresh
3. **Badge updates propagate** — Tab 2's session card badge transitions running → starting → running (via `sessionStateChange` broadcasts)
4. **Tab 2 does not freeze** — it continues receiving output from the new PTY
5. **No output from old PTY bleeds into Tab 2** — the `_ptyGen` guard in DirectSession prevents old PTY output from reaching any viewer

---

## 2. Infrastructure Setup

### 2a. Isolated server on port 3117

```
PORT=3117
DATA_DIR=$(mktemp -d /tmp/qa-T20-XXXXXX)
```

Spawn `node server-with-crash-log.mjs` with env `{ DATA_DIR, PORT, CRASH_LOG }`. Poll `http://127.0.0.1:3117/api/sessions` every 200ms for up to 10s.

### 2b. Pre-seed projects.json

```json
{
  "projects": [
    {
      "id": "proj-t20",
      "name": "T20-Project",
      "path": "/tmp",
      "createdAt": "2026-01-01T00:00:00Z"
    }
  ],
  "scratchpad": []
}
```

Write to `$DATA_DIR/projects.json` BEFORE starting the server.

### 2c. Screenshot directory

Create `qa-screenshots/T20-two-tabs/` under the app root.

---

## 3. Session Setup (via WebSocket, not browser UI)

### 3a. Create a bash session

Open a raw WebSocket to `ws://127.0.0.1:3117`. Send:

```json
{
  "type": "session:create",
  "projectId": "proj-t20",
  "name": "t20-shared-session",
  "command": "bash",
  "mode": "direct",
  "cols": 120,
  "rows": 30
}
```

Wait for `session:created`. Store `session.id` as `testSessionId`.

**Why bash and not Claude:** Deterministic output timing. The two-tab scenario is about WebSocket broadcast and PTY generation guards, not Claude-specific behavior.

**Why via WS and not browser UI:** Speed and reliability. The browser UI creates sessions through the WS anyway. Pre-creating via WS gives us a clean slate where both tabs start in the same state.

### 3b. Wait for session running

Poll `GET /api/sessions` until the session shows `status === 'running'`. Timeout 10s.

### 3c. Write a unique PRE-REFRESH marker

Send input via WS to write a clearly identifiable string:

```json
{ "type": "session:input", "id": "<sessionId>", "data": "echo T20_PRE_REFRESH_MARKER\r" }
```

Note: use `\r` (carriage return), not `\n` (linefeed) — see JOURNAL.md Bug 1.

Wait 800ms for output to be in the PTY buffer.

---

## 4. Two-Browser-Context Setup

### 4a. Create two independent browser contexts

```js
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const ctx1 = await browser.newContext();
const ctx2 = await browser.newContext();
const page1 = await ctx1.newPage();
const page2 = await ctx2.newPage();
```

Two contexts = two independent WebSocket connections to the server. This simulates two separate browser tabs (or even two different users).

### 4b. Navigate both pages

```js
await page1.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
await page2.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
```

Wait for both pages to show `.status-dot.connected`.

### 4c. Open session overlay in both tabs

In Tab 1:
1. Click `.project-item` containing "T20-Project" to activate the project
2. Click `.session-card` containing "t20-shared-session" to open the overlay
3. Wait for `#session-overlay-terminal .xterm-screen` to be visible

In Tab 2:
1. Same navigation sequence

Both tabs now have `TerminalPane` mounted, which sends `session:subscribe` to the server. The server registers both WebSocket clients as viewers.

After opening both overlays, wait 1.5s for xterm to settle and receive initial PTY output.

### 4d. Verify both tabs show PRE-REFRESH content

In both page1 and page2, check that `T20_PRE_REFRESH_MARKER` is visible in the terminal DOM:

```js
await page.waitForFunction(
  () => {
    const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
    return screen?.textContent?.includes('T20_PRE_REFRESH_MARKER');
  },
  { timeout: 8000 }
);
```

If either tab doesn't show the marker, the test aborts with a diagnostic screenshot.

---

## 5. Pre-Refresh State Capture

Before clicking refresh, capture reference state:

- **Screenshot:** `T20-01-tab1-pre-refresh.png` and `T20-02-tab2-pre-refresh.png`
- **Scroll state:** `vp._scrollState()` on both tabs
- **Content check:** Both terminals contain `T20_PRE_REFRESH_MARKER`

---

## 6. Write a POST-REFRESH Marker (Pre-Seeded)

Write a second unique marker BEFORE clicking refresh. This marker will exist in the OLD PTY output:

```json
{ "type": "session:input", "id": "<sessionId>", "data": "echo T20_OLD_PTY_SENTINEL\r" }
```

Wait 500ms. This sentinel string must NOT appear in Tab 2 after refresh — if it does after the reset, it signals cross-PTY bleed or buffer leak.

---

## 7. Tab 1 Triggers Refresh

### 7a. Click the Refresh button in Tab 1

```js
const refreshBtn = page1.locator('button[title="Refresh session"]');
await refreshBtn.click();
```

### 7b. Wait for toast in Tab 1

```js
await page1.waitForFunction(
  () => document.body.textContent.includes('Refreshing'),
  { timeout: 3000 }
).catch(() => {}); // toast may disappear fast
```

### 7c. Record the refresh timestamp

```js
const refreshTs = Date.now();
```

---

## 8. Core Two-Tab Verification

### 8a. Tab 2 receives session:subscribed (xterm.reset fires)

The server's `SessionHandlers.refresh()` calls `this.registry.broadcastToSession(msg.id, { type: 'session:subscribed', id: msg.id })`. Tab 2 is subscribed to the session, so it receives this message. `TerminalPane.handleSubscribed()` calls `xterm.reset()` when `msg.id === sessionId`.

**Verify:** Within 3 seconds of refresh, Tab 2's terminal no longer contains `T20_PRE_REFRESH_MARKER`:

```js
await page2.waitForFunction(
  () => {
    const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
    for (const r of rows) {
      if (r.textContent.includes('T20_PRE_REFRESH_MARKER')) return false;
    }
    return true;
  },
  { timeout: 5000 }
);
```

If this times out: Tab 2 did NOT call `xterm.reset()` — fail.

### 8b. T20_OLD_PTY_SENTINEL absent from Tab 2 after reset

After `xterm.reset()` clears the buffer, the old PTY sentinel should be gone:

```js
const hasOldSentinel = await page2.evaluate(() => {
  const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
  for (const r of rows) {
    if (r.textContent.includes('T20_OLD_PTY_SENTINEL')) return true;
  }
  return false;
});
expect(hasOldSentinel, 'Tab 2: old PTY sentinel must be absent after refresh reset').toBe(false);
```

### 8c. Badge state in Tab 2 transitions correctly

The `SessionHandlers` constructor registers a listener on `sessionStateChange` that broadcasts `{ type: 'session:state', id, state, previousState }` to ALL clients. Tab 2 receives this and updates its session card badge.

Check that Tab 2's session card shows `running` within 10s of the refresh:

```js
await page2.waitForFunction(
  (name) => {
    const cards = document.querySelectorAll('.session-card');
    for (const card of cards) {
      if (card.textContent.includes(name)) {
        return card.textContent.toLowerCase().includes('running');
      }
    }
    return false;
  },
  't20-shared-session',
  { timeout: 10000 }
);
```

Also check intermediate states (starting) if timing allows via screenshot.

### 8d. Tab 2 receives new PTY output

Write a POST-REFRESH marker via WS after the refresh completes:

```json
{ "type": "session:input", "id": "<sessionId>", "data": "echo T20_POST_REFRESH_MARKER\r" }
```

Wait for it to appear in Tab 2's terminal:

```js
await page2.waitForFunction(
  () => {
    const screen = document.querySelector('#session-overlay-terminal .xterm-screen');
    return screen?.textContent?.includes('T20_POST_REFRESH_MARKER');
  },
  { timeout: 10000 }
);
```

If this times out: Tab 2 is frozen and not receiving new PTY output.

### 8e. Tab 1 also shows post-refresh output

Same check on Tab 1 — verifying that the refreshing tab also works normally:

```js
await page1.waitForFunction(
  () => document.querySelector('#session-overlay-terminal .xterm-screen')?.textContent?.includes('T20_POST_REFRESH_MARKER'),
  { timeout: 10000 }
);
```

---

## 9. Cross-PTY Bleed Detection

### 9a. Write a NEW PTY-only marker (after refresh)

After refresh, write a string that could only have come from the NEW PTY:

```json
{ "type": "session:input", "id": "<sessionId>", "data": "echo T20_NEW_PTY_ONLY_MARKER\r" }
```

Wait for it in both tabs.

### 9b. Verify old PTY sentinel still absent

After the new PTY marker appears, confirm `T20_OLD_PTY_SENTINEL` is still absent from Tab 2. This guards against a race where the old PTY managed to sneak output in between the reset and the new PTY output.

```js
const stillHasOldSentinel = await page2.evaluate(() => {
  const rows = document.querySelectorAll('#session-overlay-terminal .xterm-rows > div');
  for (const r of rows) {
    if (r.textContent.includes('T20_OLD_PTY_SENTINEL')) return true;
  }
  return false;
});
expect(stillHasOldSentinel, 'Tab 2: old PTY bleed must NOT occur even after new output arrives').toBe(false);
```

---

## 10. Screenshots

| File | When |
|------|------|
| `T20-01-tab1-pre-refresh.png` | Tab 1 before refresh |
| `T20-02-tab2-pre-refresh.png` | Tab 2 before refresh |
| `T20-03-tab2-during-refresh.png` | Tab 2 shortly after refresh click |
| `T20-04-tab1-post-refresh.png` | Tab 1 after new PTY output |
| `T20-05-tab2-post-refresh.png` | Tab 2 after new PTY output |

---

## 11. Pass / Fail Criteria

### PASS — all of the following must hold:

1. **Tab 2 xterm.reset fires:** `T20_PRE_REFRESH_MARKER` disappears from Tab 2's terminal within 5s of refresh
2. **No old PTY bleed in Tab 2:** `T20_OLD_PTY_SENTINEL` never appears in Tab 2 after refresh
3. **Tab 2 badge updates:** Session card in Tab 2 shows `running` within 10s of refresh
4. **Tab 2 receives new output:** `T20_POST_REFRESH_MARKER` appears in Tab 2 within 10s
5. **Tab 1 also works:** `T20_POST_REFRESH_MARKER` appears in Tab 1 within 10s
6. **No freeze:** Both tabs respond to new input within 10s of refresh
7. **Session returns to running:** API confirms `status === 'running'` within 10s

### FAIL — any of the following:

1. `T20_PRE_REFRESH_MARKER` still visible in Tab 2 after 5s (no `xterm.reset()` fired)
2. `T20_OLD_PTY_SENTINEL` appears in Tab 2 after the refresh (cross-PTY bleed)
3. Tab 2 session card stays in `starting` or shows wrong state after 10s
4. `T20_POST_REFRESH_MARKER` never appears in Tab 2 (frozen tab)
5. `T20_POST_REFRESH_MARKER` never appears in Tab 1 (Tab 1 broken by its own refresh)
6. Server crash log has entries during the test window

---

## 12. Key Architecture Insights from Code Review

### 12a. How refresh propagates to Tab 2

In `SessionHandlers.refresh()` (line 186 of `sessionHandlers.js`):
```js
this.registry.broadcastToSession(msg.id, { type: 'session:subscribed', id: msg.id });
```

`broadcastToSession` iterates `clients` and sends to any client whose `subscriptions` Set contains the session ID. Since both tabs called `session:subscribe`, both are in that Set. Tab 2 receives `session:subscribed` even though it didn't click refresh.

### 12b. Why xterm.reset fires in Tab 2

In `TerminalPane.js` (line 130-133):
```js
const handleSubscribed = (msg) => {
  if (msg.id !== sessionId) return;
  xterm.reset();
};
```

The session ID check passes, so Tab 2 resets its xterm buffer.

### 12c. Why old PTY can't bleed

In `DirectSession._wirePty()`:
```js
ptyProcess.onData((data) => {
  if (gen !== this._ptyGen) return; // stale PTY guard
  // ...stream to viewers
});
```

When refresh is called, `this.pty.kill()` is called and then `this._ptyGen` is incremented (via `start()` calling `++this._ptyGen`). Any data events from the old PTY's lingering callbacks see `gen !== this._ptyGen` and are dropped before reaching the viewer callbacks.

### 12d. Badge propagation mechanism

`SessionHandlers` constructor (line 18-20):
```js
sessionManager.on('sessionStateChange', ({ id, state, previousState }) => {
  registry.broadcast({ type: 'session:state', id, state, previousState });
});
```

This broadcasts to ALL connected clients, not just subscribers. Tab 2's client receives the state change and can update its session card badge.

---

## 13. Potential Failure Modes

### FM-1: Race between `session:subscribed` broadcast and old PTY final data

If the old PTY has buffered data that node-pty delivers asynchronously after `kill()`, and this fires before `_ptyGen` is incremented (between the kill and the `start()` call), old data could reach viewers. The `_ptyGen` increment in `start()` and the guard in `_wirePty` should prevent this, but it's the primary race condition to watch.

**Test coverage:** `T20_OLD_PTY_SENTINEL` is written to the old PTY immediately before refresh. If this sentinel appears in Tab 2 after the reset, the race condition fired.

### FM-2: Tab 2 gets `session:subscribed` but doesn't call subscribe again

After `xterm.reset()`, Tab 2 has cleared its buffer. But is Tab 2 still in the server's viewer map? Yes — because the server's `subscribe()` call (`this.sessions.subscribe(id, clientId, callback)`) was never cleared. The viewer callback remains registered. New PTY output will still stream to Tab 2's WS.

**Test coverage:** `T20_POST_REFRESH_MARKER` must appear in Tab 2.

### FM-3: Tab 2 WS connection drops during refresh

If the server is under load and the WS close/reopen races with the refresh broadcast, Tab 2 might miss `session:subscribed`. `TerminalPane.js` handles WS reconnect by re-subscribing (`handleReconnect` at line 156), but this requires the WS to actually disconnect and reconnect.

**Test coverage:** The badge update check (session card shows running) serves as a proxy — if the badge updates, at least the `sessions:list` broadcast reached Tab 2.

### FM-4: Both browser contexts share the same WS connection

Playwright `browser.newContext()` creates fully isolated browser contexts with separate cookie jars and network stacks. Each context opens its own WS connection to the server. This is NOT an issue with Playwright but would be with `page.evaluate`-based WS creation.

---

## Execution Summary

**Result:** 1/1 PASS — 14.4s total

**Deviations from design:**
- **Critical deviation:** The design specified writing `T20_PRE_REFRESH_MARKER` in beforeAll (step 3c), BEFORE opening the browser. In execution, this marker was invisible in both tabs after subscription — because `session:subscribed` on initial subscribe triggers `xterm.reset()`, wiping the buffer. This is exactly the "subscribe → content → subscribe wipes it" anti-pattern documented in JOURNAL.md under T-03 lessons. The fix was to write the marker AFTER both tabs had opened the overlay and settled (1.5s sleep after overlay open). **This is a design flaw that execution caught and fixed.**

- **API sessions endpoint:** Design assumed `/api/sessions` returns an array or `{ sessions: [] }`. Actual response is `{ managed: [], detected: [] }`. Fixed in test to use `sessionsData.managed`.

- **OLD_PTY_SENTINEL check:** All cross-PTY bleed checks passed — the sentinel written to the old PTY immediately before refresh was correctly absent from Tab2 after `xterm.reset()`.

**Timing observed:**
- `xterm.reset()` fired within 137-160ms of refresh click
- Badge updated within 176-213ms
- POST_REFRESH_MARKER appeared within 240-256ms

**All 7 pass criteria from design confirmed:**
1. PRE_REFRESH_MARKER disappeared from Tab2 ✓
2. OLD_PTY_SENTINEL absent from Tab2 ✓
3. Badge showed "running" ✓
4. POST_REFRESH_MARKER appeared in Tab2 ✓
5. POST_REFRESH_MARKER appeared in Tab1 ✓
6. No freeze (all within 256ms) ✓
7. API confirms running ✓
