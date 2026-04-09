# Test Designs: TodoPanel Mount

Ports assigned from range 3220–3227.

---

### T-1: TodoPanel reachable via UI — empty state for fresh project
**Flow:**
1. Start server on port 3220 with a seeded project (id: `proj-t1`, name: "Test Project", path: `/tmp`).
2. Navigate to `http://localhost:3220` with `waitUntil: 'domcontentloaded'`.
3. Wait for project list to load (WebSocket init message or wait 2s).
4. Click the project in the sidebar (look for element containing "Test Project").
5. Wait for detail pane to show (wait for `#project-detail.visible`).
6. Assert: `#todos-tab-btn` exists in the DOM.
7. Click `#todos-tab-btn`.
8. Wait 1500ms for TodoPanel to mount and fetch.
9. Assert: `#todo-panel-container` exists in the DOM.
10. Assert: `.todo-header-title` text equals "TODO List".
11. Assert: `.todo-empty` is visible and contains "No TODOs yet".
12. Assert: `#project-sessions-list` does NOT exist (session list was replaced by TodoPanel).

**Pass condition:** All assertions hold. TODOs tab renders TodoPanel with empty state. Sessions list is hidden.
**Fail signal:** `#todos-tab-btn` not found (tab was never rendered); OR clicking it doesn't mount TodoPanel (onClick not wired); OR `.todo-empty` not visible (wrong projectId or API crash); OR sessions list still visible alongside TodoPanel.
**Test type:** Playwright browser
**Port:** 3220

---

### T-2: Add a TODO and see it appear
**Flow:**
1. Start server on port 3221 with seeded project `proj-t2`.
2. Navigate to app, click project, click `#todos-tab-btn`.
3. Wait for empty state to appear (`.todo-empty`).
4. Click the `+ Add` button (button with text `+ Add` or `showAddForm` toggle).
5. Wait for add form to appear (input with placeholder "What needs to be done?").
6. Type "Fix the login bug" in the title input.
7. Leave priority at default (medium).
8. Click the "Add" button in the form.
9. Wait 1500ms for the item to appear.
10. Assert: `.todo-item` exists and `.todo-title` contains "Fix the login bug".
11. Assert: `.todo-empty` no longer exists.
12. Also assert: `POST /api/todos/proj-t2` was called (verify via network interception or just via data persistence in step 12+).
13. Reload the page, click project, click TODOs tab.
14. Assert: "Fix the login bug" still appears (persistence).

**Pass condition:** TODO appears after adding. Survives page reload.
**Fail signal:** TODO appears briefly but vanishes on reload (frontend-only state, not persisted); OR `.todo-item` never appears (API call failed, wrong projectId in request); OR adding with projectId=undefined stores to wrong location.
**Test type:** Playwright browser
**Port:** 3221

---

### T-3: Priority filter works — High filter hides Medium items
**Flow:**
1. Start server on port 3222 with project `proj-t3`.
2. Seed two TODOs via REST API directly before opening the browser:
   - `POST /api/todos/proj-t3` `{ title: "High priority task", priority: "high", estimate: "1h" }`
   - `POST /api/todos/proj-t3` `{ title: "Medium priority task", priority: "medium", estimate: "30m" }`
3. Navigate to app, click project, click `#todos-tab-btn`.
4. Wait for 2 items to appear (verify two `.todo-item` elements exist).
5. Click the "high" filter button (`.todo-filter-btn` with text "high").
6. Wait 500ms.
7. Assert: Only 1 `.todo-item` visible.
8. Assert: Visible item's `.todo-title` contains "High priority task".
9. Assert: "Medium priority task" is NOT visible in `.todo-list`.
10. Click the "all" filter button.
11. Assert: Both items visible again (2 `.todo-item` elements).

**Pass condition:** High filter correctly hides medium items. Resetting to "all" restores both.
**Fail signal:** Both items remain visible after filter (filter buttons rendered but onClick not wired to state); OR filter applies but vacuously because medium item was already hidden for another reason.
**Test type:** Playwright browser
**Port:** 3222

---

### T-4: TODO persists after browser reload
**(Covered partially by T-2. This test focuses specifically on persistence across a cold reload.)**
**Flow:**
1. Start server on port 3223 with project `proj-t4`.
2. Add a TODO via REST directly: `POST /api/todos/proj-t4` `{ title: "Persisted task", priority: "low", estimate: "5m" }`.
3. Navigate to app, click project, click `#todos-tab-btn`.
4. Wait for "Persisted task" to appear in `.todo-list`.
5. Record the current page URL.
6. Close and reopen the browser page (full navigation reload: `page.goto(url)`).
7. Click project, click `#todos-tab-btn`.
8. Assert: "Persisted task" still appears.
9. Assert: Item has correct priority badge ("low" visible in `.todo-priority`).

**Pass condition:** Data survives full page reload. Priority metadata is preserved.
**Fail signal:** Item disappears after reload (either server lost it or projectId mismatch caused wrong project's data to be stored); OR item appears but has wrong priority (serialization bug).
**Test type:** Playwright browser
**Port:** 3223

---

### T-5: Adversarial — Empty title is blocked
**Flow:**
1. Start server on port 3224 with project `proj-t5`.
2. Navigate to app, click project, click `#todos-tab-btn`.
3. Wait for TodoPanel to load.
4. Click `+ Add` button.
5. Wait for add form to appear.
6. Leave title field empty (do not type anything).
7. Click the "Add" button in the form.
8. Wait 500ms.
9. Assert: `.todo-item` does NOT exist (no item was created).
10. Assert: The add form is still visible (form did not close).
11. Also test Enter key: press Enter in the empty title input.
12. Assert: Still no `.todo-item`.
13. Verify via REST: `GET /api/todos/proj-t5` returns `{ items: [] }` — no item was POSTed to server.

**Pass condition:** Empty title submission is a no-op. Form stays open. No server request was made.
**Fail signal:** Empty-title TODO is created (guard `if (!title) return;` in line 78 of TodoPanel.js was not executed); OR item appears with empty/undefined title; OR REST endpoint receives a request with empty title and creates a broken item.
**Test type:** Playwright browser + REST verification
**Port:** 3224

---

### T-6: Project switching — TODOs are isolated per project
**Flow:**
1. Start server on port 3225 with two seeded projects: `proj-t6a` ("Project Alpha") and `proj-t6b` ("Project Beta").
2. Add a TODO to Project Alpha via REST: `POST /api/todos/proj-t6a` `{ title: "Alpha task", priority: "high", estimate: "1h" }`.
3. Navigate to app. Click "Project Alpha" in sidebar. Click `#todos-tab-btn`. Verify "Alpha task" appears.
4. Click "Project Beta" in sidebar (without leaving TODOs tab).
5. Wait 1500ms for TodoPanel to re-fetch for Project Beta.
6. Assert: "Alpha task" is NOT visible in `.todo-list`.
7. Assert: `.todo-empty` is visible (Beta has no TODOs).
8. Verify network: the most recent fetch was to `/api/todos/proj-t6b`, NOT `/api/todos/proj-t6a`.

**Pass condition:** Switching projects re-fetches TODOs for the new project. Alpha's task does not leak into Beta's view.
**Fail signal:** Alpha's TODOs remain visible after switching to Beta (projectId prop didn't update, or useEffect didn't re-run); OR Beta shows Alpha's tasks (wrong projectId was passed to TodoPanel).
**Test type:** Playwright browser + network request verification
**Port:** 3225

---

## Infrastructure Notes for Executor

- Server: `node server-with-crash-log.mjs` with `PORT`, `DATA_DIR`, `CRASH_LOG` env vars
- ProjectStore seed format: `{ "projects": [...], "scratchpad": [] }` — NOT a bare array
- Project object: `{ id, name, path, createdAt, settings }` — path can be `/tmp`
- Wait strategy: `waitUntil: 'domcontentloaded'` + explicit `waitForTimeout` or element waits
- WS URL: bare `ws://host:port` (not `/ws`)
- Sessions REST: `{ managed, detected }` not bare array
- For seeding TODOs before browser: use `fetch()` or `axios` calls to `POST /api/todos/:projectId` against the running server, after a brief startup delay
- Test file location: `tests/adversarial/feat-todo-panel-mount-T*.test.js`
- Up to 3 fix attempts per test — fix infrastructure/selector bugs only, never water down assertions
