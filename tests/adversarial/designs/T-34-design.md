# T-34 Design: TODO Filters — High Priority Filter Hides Medium Items

**Score:** 8 | **Type:** Playwright browser | **Port:** 3131

---

## What This Test Must Prove

The TODO panel's priority filter buttons (`all`, `high`, `medium`, `low`) correctly show/hide items. After seeding High + Medium + Low priority TODOs, clicking "high" must hide Medium and Low items while keeping the High item visible. Clicking "all" must restore all 3.

The test must verify real DOM hiding (items are gone from `visibleItems`, not just `display:none` via CSS). The filtering is pure client-side: `visibleItems = items.filter(i => i.priority === filterPriority)`.

---

## Source File Analysis

**`TodoPanel.js` — critical findings:**

- **Filter state:** `filterPriority` starts at `'all'`. `filterStatus` starts at `'pending'`.
- **Filter buttons** (lines 135–152): Each priority button has class `todo-filter-btn` (+ `active` if selected). Button text = priority label (`all`, `high`, `medium`, `low`). Selector: `button.todo-filter-btn:text("high")`.
- **Filtering logic** (lines 101–103): `visibleItems = items; if (filterPriority !== 'all') visibleItems = visibleItems.filter(i => i.priority === filterPriority);` — pure JavaScript array filter, no CSS hiding. Items not in `visibleItems` are not rendered at all.
- **TODO item class:** `.todo-item`. Title: `.todo-title`. Priority badge: `todo-priority-high`, `todo-priority-medium`, `todo-priority-low`.
- **Status filter:** Default is `'pending'` — all seeded items must be created as `status: 'pending'` (default). Items will pass the status filter.
- **The component is NOT mounted in the main App.** Same constraint as T-33 — need a test harness page.

**Server validation:** `POST /api/todos/:projectId` accepts `{ title, priority, estimate, blockedBy }`. Priority values: `low`, `medium`, `high`. Default estimate: `'15m'` (applied client-side if empty). Server stores and returns the priority as-is.

**Critical filtering subtlety:** The default `filterStatus` is `'pending'`, which filters out `completed` items. All seeded items must be `pending` (default). If seeded items are somehow `completed`, they won't appear under the default filter. Mitigation: explicitly do NOT check the `completed` checkbox when creating test items.

---

## Infrastructure

- Port: 3131
- Server: same as T-33 but isolated tmpDir
- Seed: one project, then 3 TODOs via API (High priority "Task H", Medium priority "Task M", Low priority "Task L")
- Screenshot dir: `qa-screenshots/T-34-todo-filters`
- Test harness: `public/test-harness-T34.html`

---

## Step-by-Step Execution Script

### Step 1: Server startup
Spawn server on port 3131. Poll until ready. Create project. Seed 3 TODOs:
- `POST /api/todos/:projectId` with `{ title: 'Task H', priority: 'high', estimate: '5m' }`
- `POST /api/todos/:projectId` with `{ title: 'Task M', priority: 'medium', estimate: '5m' }`  
- `POST /api/todos/:projectId` with `{ title: 'Task L', priority: 'low', estimate: '5m' }`

All 3 should return 200 with an item including their `priority` field.

### Step 2: Write test harness page
Write `/home/claude-runner/apps/claude-web-app-v2/public/test-harness-T34.html` — imports Preact, htm, and `TodoPanel`. Renders `<TodoPanel projectId="<id>" />`.

### Step 3: Navigate and wait for items to load
Navigate to harness. Wait for `.todo-header` visible. Wait for `.todo-item` count to reach 3 (default filter = `all` priority + `pending` status).

Take screenshot `01-all-items.png`.

### Step 4: Verify initial state — all 3 visible
Assert: 3 `.todo-item` elements visible. Assert: `.todo-priority-high` text "Task H" visible, `.todo-priority-medium` "Task M" visible, `low` "Task L" visible.

### Step 5: Click "high" filter
Locate `button.todo-filter-btn` with text `'high'`. Click it. Wait 300ms for Preact re-render.

Take screenshot `02-high-filter.png`.

### Step 6: Assert only High item visible
Assert: exactly 1 `.todo-item` visible. Assert: that item contains text "Task H". Assert: no element contains text "Task M" or "Task L" within `.todo-list`.

### Step 7: Click "medium" filter
Click the `medium` filter button. Wait 300ms.

Take screenshot `03-medium-filter.png`.

### Step 8: Assert only Medium item visible
Assert: exactly 1 `.todo-item`. Contains "Task M". No "Task H" or "Task L".

### Step 9: Click "all" filter
Click the `all` filter button. Wait 300ms.

Take screenshot `04-all-restored.png`.

### Step 10: Assert all 3 restored
Assert: 3 `.todo-item` elements. All three tasks visible.

### Step 11: Cleanup
Delete harness file. Kill server.

---

## Pass / Fail Criteria

**Pass:**
- Initial state: 3 items under `all` filter.
- `high` filter: exactly 1 item (Task H), others hidden (not in DOM).
- `medium` filter: exactly 1 item (Task M).
- `all` filter: all 3 items restored.

**Fail:**
- Filter button changes active state but all items remain in DOM.
- Filter resets to `all` after clicking `high` (no re-render).
- Items are CSS-hidden but still in DOM (count includes hidden items).

---

## False-PASS Risks

1. **Status filter hides items.** If seeded items aren't `pending`, the default `filterStatus='pending'` hides them all → count 0 not 3 → hard fail. Mitigation: verify count is 3 before proceeding (throw if not).

2. **Test harness module import fails.** Mitigation: verify `.todo-header` visible with text "TODO List" before counting items.

3. **Preact re-render not awaited.** Filter click changes state synchronously but Preact schedules re-render as microtask. 300ms wait should be sufficient; use `.waitFor({ state: 'visible' })` on the expected item if needed.

4. **Selector for filter buttons.** The button text is lowercase (`high`, not `High`). Confirm with `page.locator('button.todo-filter-btn').allTextContents()`.

5. **Test harness loads stale data.** The harness uses `fetch('/api/todos/:id')` on mount. If the project ID is wrong, it returns empty. Mitigation: verify count > 0 before proceeding.

---

## Validator Checklist

- Was the initial count of 3 items verified before filtering?
- Did the test use DOM count (not text search) to verify items are truly absent?
- Did the `all` restoration test confirm the filter is reversible?
- Was the "medium" filter step included (not just "high")?
