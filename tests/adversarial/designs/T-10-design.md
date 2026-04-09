# T-10: Session Count Badge in Sidebar Matches Live Running Sessions

**Source story:** Story 13
**Score:** L=5 S=3 D=4 (Total: 12)
**Test type:** Playwright browser
**Port:** 3107

---

## 1. What We Are Testing

The `ProjectSidebar` component renders a `.project-item-badge` element for each project. When `running > 0`, the element has the class `has-sessions` and its text reads `${running} session${running !== 1 ? 's' : ''} running`. When zero sessions are running, it reads `idle`.

The badge is reactive: it reads from `sessions.value` (a Preact signal), which is updated in two ways:
1. **Bulk replace** — `sessions:list` broadcasts → `handleSessionsList` sets `sessions.value = msg.sessions`
2. **Upsert** — `session:state` broadcasts → `handleSessionState` calls `upsertSession({ id, state, status })`

The server triggers `_broadcastSessionsList()` after every lifecycle mutation (create, stop, refresh, delete). It also emits `session:state` events via `sessionManager.on('sessionStateChange', ...)`.

**Key reactivity chain:**
```
server: _broadcastSessionsList()
  → WS broadcast: { type: 'sessions:list', sessions: [...] }
  → client: handleSessionsList() → sessions.value = [...]
  → ProjectSidebar re-renders: getRunningCount() is recalculated
  → .project-item-badge text updates in DOM
```

**Badge condition checked (from ProjectSidebar.js line 16):**
```js
s.status === 'running' || s.state === 'running'
```
Both fields are checked, so `handleSessionState` updating only `state` is sufficient.

---

## 2. Infrastructure Setup

### 2a. Isolated server

Spawn a dedicated test server on port **3107** using `server-with-crash-log.mjs` with a fresh temp directory:

```
PORT=3107
DATA_DIR=$(mktemp -d /tmp/qa-T10-XXXXXX)
CRASH_LOG=$DATA_DIR/server-crash.log
```

Server process captured as `serverProc`, killed in `afterAll`. Wait for readiness by polling `GET /api/projects` every 500ms for up to 15 seconds.

### 2b. Screenshot directory

Create `qa-screenshots/T10-sidebar-badge/` under the app root.

### 2c. Create test project via REST API

POST to `/api/projects` with `{ name: "T10-BadgeProject", path: "<tmpDir>/project" }`.

Create the project directory on disk with `mkdirSync`. Store `projectId`.

---

## 3. Session Creation Strategy

We need 3 sessions. We do NOT need Claude TUI — use `bash` as the command for fast, deterministic sessions.

Create all 3 via WebSocket `session:create` messages. Each must use:
```json
{ "type": "session:create", "projectId": "<pid>", "name": "T10-sess-N", "command": "bash", "mode": "direct", "cols": 80, "rows": 24 }
```

Wait for `session:created` response after each. Store session IDs: `s1`, `s2`, `s3`.

After creation, all 3 sessions will be in `running` state (bash spawns immediately).

**Important:** Use a single WS connection for all control messages. The creating client is auto-subscribed per `sessionHandlers.js` — no separate subscribe needed.

---

## 4. Scenario A: 3 Created → Stop One → Verify Badge Shows 2

### 4a. Navigate to app

Open Playwright browser, navigate to `http://127.0.0.1:3107` with `waitUntil: 'domcontentloaded'`.

Select the test project by clicking `.project-item` containing "T10-BadgeProject".

### 4b. Pre-stop verification: badge shows "3 sessions running"

After creating all 3 bash sessions and selecting the project, assert:
- The `.project-item-badge.has-sessions` element for T10-BadgeProject contains text `3 sessions running`.
- Timeout: 3000ms (server broadcasts `sessions:list` after each create).

Take screenshot: `A-01-before-stop.png`

### 4c. Stop session 1 via WebSocket

Send over the control WS:
```json
{ "type": "session:stop", "id": "<s1>" }
```

Wait for `sessions:list` broadcast (or `session:state` broadcast with `state: 'stopped'` for s1). Implement as a Promise that resolves when next `sessions:list` arrives.

### 4d. Assert badge updates to "2 sessions running" — without page reload

Assert:
- The badge text is `2 sessions running` within **3 seconds** of the stop.
- The class still includes `has-sessions`.
- **No page reload occurred** — verify by checking a persistent DOM property (e.g., a unique `data-test-load-id` attribute set at page open, or simply that the page URL didn't change and `performance.navigation.type === 0`).

Take screenshot: `A-02-after-stop.png`

**Fail signal:** Badge still shows `3 sessions running` → stale count, not real-time.

### 4e. Verify badge text is exact

```js
await expect(badgeEl).toHaveText('2 sessions running');
```

---

## 5. Scenario B: Start Second Session → Verify Badge Updates to 2 Running

After Scenario A we have: s1=stopped, s2=running, s3=running.

### 5a. Stop s2 via WS

Wait for `sessions:list` broadcast confirming s2 is stopped.

Assert badge shows `1 session running` within 3 seconds.

Take screenshot: `B-01-after-s2-stop.png`

### 5b. Restart s2 via WS refresh

Send:
```json
{ "type": "session:refresh", "id": "<s2>" }
```

Wait for `session:refreshed` response. Then wait for `sessions:list` broadcast with s2 in running state.

### 5c. Assert badge updates to "2 sessions running" — without page reload

Same real-time check: badge shows `2 sessions running` within **3 seconds**.

Take screenshot: `B-02-after-s2-start.png`

**Fail signal:** Badge still shows `1 session running` → refresh state change not reflected in sidebar.

---

## 6. Timing Assertions

All badge update assertions must use `{ timeout: 3000 }` — the spec requires "within 3 seconds — without a page reload."

Do NOT use `page.reload()` between scenario steps.

---

## 7. Badge Selector Strategy

From `ProjectSidebar.js`:
```html
<div class="project-item-badge has-sessions">2 sessions running</div>
```

Locator: select by project card containing the project name, then `.project-item-badge` within it.

```js
const projectItem = page.locator('.project-item', { hasText: 'T10-BadgeProject' });
const badge = projectItem.locator('.project-item-badge');
```

This scopes the badge to the specific project, avoiding false matches if multiple projects are shown.

---

## 8. Repeat the Full Suite 2×

The test runs both Scenario A and Scenario B in a single test (repeat the badge-check assertions inline). This satisfies the "repeat 2×" requirement without a separate test declaration.

Alternatively: define one `test` block for Scenario A and one for Scenario B, both sharing the same `beforeAll` server setup. This is cleaner for failure isolation.

Recommended: two separate `test()` blocks — Scenario A (stop reduces count) and Scenario B (refresh increases count).

---

## 9. Cleanup

In `afterAll`:
1. Kill any remaining bash sessions via `session:stop` WS or `session:delete`.
2. Kill the server process (`serverProc.kill('SIGTERM')`).
3. Wait 500ms.
4. Remove the temp dir (`fs.rmSync(tmpDir, { recursive: true, force: true })`).

---

## 10. Key Failure Modes to Detect

| Failure mode | How detected |
|---|---|
| Badge shows stale count after stop | `toHaveText('2 sessions running')` with timeout=3000 fails |
| Badge never shows `has-sessions` class | `toHaveClass(/has-sessions/)` assertion fails |
| Badge only updates on page reload | We never reload; if badge updates only after reload, assertion times out |
| Wrong plural ("1 sessions running") | Exact `toHaveText` catches this |
| Badge shows "idle" when session is running | `has-sessions` class check + text check |
| `sessions:list` broadcast missing after stop | Badge never updates — timeout |
| `session:state` broadcast shape mismatch | `handleSessionState` doesn't upsert correctly → stale state |

---

## 11. WS Helper Pattern

Use raw `ws` npm module for control messages (same pattern as T-01/T-02/T-03 tests):

```js
const WebSocket = await import('ws');
const ws = new WebSocket.default(`ws://127.0.0.1:3107`);

// Wait for init
await new Promise(resolve => ws.once('message', d => { JSON.parse(d); resolve(); }));

// Helper: send + collect responses
function sendWs(msg) { ws.send(JSON.stringify(msg)); }

function waitForWsMessage(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS timeout')), timeout);
    function onMsg(d) {
      const m = JSON.parse(d);
      if (predicate(m)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(m);
      }
    }
    ws.on('message', onMsg);
  });
}
```

---

## 12. Data Seed Note

Sessions are created live via WS — no need to seed `projects.json` manually. The REST API + WS `session:create` is the intended path and exercises the real code path.

**ProjectStore seed format** (for reference if needed):
```json
{ "projects": [{ "id": "<uuid>", "name": "T10-BadgeProject", "path": "/tmp/...", "createdAt": "..." }], "scratchpad": [] }
```
