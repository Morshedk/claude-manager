# T-29 Design: Telegram Badge Persists After Browser Reload

**Score:** 8  
**Port:** 3126  
**Type:** Playwright browser test

---

## What We Are Testing

The `telegramEnabled` flag on a session must survive a browser hard-reload. The badge `<span class="badge badge-telegram">TG</span>` is rendered in `SessionCard.js` only when `session.telegramEnabled` is truthy. Since Preact signals are in-memory only, the session list is re-fetched from the server on page load via the WebSocket handshake. Therefore `telegramEnabled` must be persisted server-side in `sessions.json` and returned in the `sessions:list` WS message after reload.

From source inspection:
- `SessionManager._createDirect()` sets `telegramEnabled: !!telegram` in `meta`
- `DirectSession.toJSON()` returns `{ ...this.meta }` — flat object including `telegramEnabled`
- `SessionStore._wireSessionEvents()` calls `this.store.save(this.sessions)` on every `stateChange`
- `SessionCard.js` line ~130: `${session.telegramEnabled ? html\`<span class="badge badge-telegram">TG</span>\` : null}`
- The WS `sessions:list` message delivers all session metadata to the client on subscribe

**The key question:** Is `telegramEnabled` serialized and loaded back correctly on server restart? (No restart here — just browser reload. The server stays alive. But the field must be in memory and in the WS message.)

---

## Infrastructure Setup

1. Create temp DATA_DIR with `mktemp -d /tmp/qa-T29-XXXXXX`
2. Seed `projects.json` as `{ "projects": [...], "scratchpad": [] }` — NOT a bare array
3. Launch server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT=3126`, `CRASH_LOG`
4. Poll `GET /api/projects` until 200
5. Open Chromium browser (headless), navigate to `http://127.0.0.1:3126` with `waitUntil: 'domcontentloaded'`

---

## Exact Actions and Timing

### Step 1: Select project in browser
- After page load, click the project name in sidebar (e.g. `T29-Project`)
- Wait for sessions list area to appear (`.sessions-empty` or `#sessions-area`)
- This ensures the project is selected before we create the session

### Step 2: Create session with `telegram: true` via WS API
- Open a WS connection to `ws://127.0.0.1:3126`
- Send `session:create` with `{ type, projectId, name: 'T29-tg', command: 'bash', telegram: true }`
- Wait for `session:created` response → extract `sessionId`
- Wait for `session:stateChange` or `sessions:list` showing the session as `running`

### Step 3: Verify TG badge appears in browser (before reload)
- Wait for `.badge-telegram` element to appear in the DOM (up to 5s)
- Assert it exists and contains text "TG"
- This is the "before" proof — the badge was rendered

### Step 4: Hard-reload the browser
- Use `page.evaluate(() => location.reload())` — reliable hard reload
- Wait for `domcontentloaded`
- Re-click the project in the sidebar to navigate back to the session list
- Wait up to 5s for the `.badge-telegram` element to reappear

### Step 5: Assert TG badge is present after reload
- Assert `.badge-telegram` element exists in DOM
- Assert it contains text "TG"
- **PASS:** badge present after reload — `telegramEnabled` was persisted and returned on reconnect
- **FAIL:** badge absent — either not persisted or not included in `sessions:list` payload

---

## Pass/Fail Criteria

| Outcome | Condition |
|---------|-----------|
| GENUINE PASS | `.badge-telegram` visible before reload AND still visible after reload + project re-select |
| GENUINE FAIL | `.badge-telegram` visible before reload but NOT after reload |
| INCONCLUSIVE | Badge never appeared before reload — precondition not established |

---

## False-PASS Risks

1. **Session stale after reload:** The server keeps the session in memory, so `telegramEnabled` may be in memory even if `sessions.json` doesn't persist it. This test does NOT restart the server — it only tests browser reload (in-memory server persistence). If you want to test disk persistence, you'd need a server restart. That's a separate concern; this test specifically covers the in-memory path and WS protocol delivery.

2. **Badge renders even without telegramEnabled:** Check that the badge is tied to `session.telegramEnabled`, not some other flag. From source: it's `${session.telegramEnabled ? html\`<span ...>TG</span>\` : null}` — confirmed correct.

3. **WS race on reload:** After browser reload, WS reconnects and receives `sessions:list`. If the project is not re-selected before the list updates, the sessions may not be shown. The test must re-click the project after reload.

4. **`session:subscribed` wipes state:** On reload, the browser re-subscribes. The `xterm.reset()` wipes terminal buffer, but NOT the session card badges (those come from `sessions:list`, not terminal output). This is not a risk for this test.

5. **Bash session as proxy for telegram:** Since actual Telegram connectivity is not configured, we use `command: 'bash'` with `telegram: true`. The server sets `telegramEnabled: true` on the meta regardless of actual Telegram plugin availability. The badge should render from that flag alone.

---

## Notes on `session:create` WS message

From `sessionHandlers.js` line 82:
```
@param {{ ..., telegram?: boolean }} msg
```
And line 115: `telegram: !!msg.telegram`

So sending `{ type: 'session:create', projectId, name: 'T29-tg', command: 'bash', args: [], telegram: true }` is sufficient.

---

## Implementation Notes for Executor

- Use `chromium.launch({ headless: true })` 
- `page.waitForSelector('.badge-telegram', { timeout: 5000 })` before and after reload
- After reload: `await page.click('[data-project-id="..."]')` or equivalent sidebar click
- Hard abort (throw) if badge not found before reload — cannot test persistence of something that never appeared
- No screenshot needed unless debugging, but optional screenshots are welcome
- Crash log check at end: read crash log, fail if any entries during test window
