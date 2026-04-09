# T-38 Design: 10-Project Sidebar — Layout and Navigation at Scale

**Score:** 8 | **Type:** Playwright browser | **Port:** 3135

---

## What This Test Proves

With 10 projects in the sidebar, all having long names (50 characters each):
1. All 10 projects are visible/reachable (sidebar scrolls or all fit)
2. Long names don't overflow and break the sidebar layout
3. Clicking each project shows the correct (independent) session list
4. Active highlighting moves correctly when switching projects

This tests `ProjectSidebar.js`, CSS layout, and the `selectProject` action's closure safety.

---

## Key Architecture Understanding

### ProjectSidebar.js (from source):
- Renders `projectList.map(p => ...)` with `key=${p.id}` — Preact keyed render, no closure capture bug
- Uses `onClick=${() => selectProject(p.id)}` — arrow function per item, captures `p.id` at render time
- `selectProject` is an action that sets `selectedProjectId.value = id` (a Preact signal)
- Session filtering: `allSessions.filter(s => s.projectId === projectId && ...)` — correct per-project filter

### Potential bugs:
- **CSS overflow**: `.project-item-name` has no `overflow: hidden` or `text-overflow: ellipsis` — long names may extend past container
- **Sidebar scroll**: `#project-list` div — need to verify it has `overflow-y: auto` or `scroll` in CSS; if not, 10 items may push content off screen
- **Closure capture**: In Preact, `projectList.map(p => ...)` with `() => selectProject(p.id)` should be correct (p is block-scoped per iteration). Not a classic `var i` closure bug. But worth verifying.
- **Session list cross-contamination**: Sessions are filtered by `projectId`. With 10 projects each having 0 sessions (none started), the correct display is "empty session list" for each. We need to create 1 session per project to verify independence.

### Sessions via REST API:
- Create sessions via `POST /api/sessions` or via WS `session:create`
- For this test, we create 1 session per project via WS before opening the browser
- Sessions start as `direct` bash sessions (not claude) for speed
- After creating sessions, verify each project's session list shows exactly 1 session

---

## Infrastructure

- Port: 3135
- 10 projects with 50-char names
- 1 session per project (bash mode for speed, not claude)
- ProjectStore seed: 10 project entries in `{ "projects": [...] }` format

---

## Exact Test Flow

### Step 1: Server setup
- Kill any process on port 3135
- Create tmpDir, create 10 project directories
- Write projects.json with 10 projects, IDs `proj-t38-01` through `proj-t38-10`
- Project names: 50-char strings like `"Project Alpha — Long Name For Layout Test #01"` (padded to exactly 50 chars)
- Start server, wait for readiness

### Step 2: Create 1 session per project via WS (before browser)
- Open WS connection
- For each project, send `session:create` with `{ projectId, name: 'session-for-proj-N', command: 'bash', mode: 'direct' }`
- Wait for `session:created` response for each
- Close WS

### Step 3: Open browser
- Navigate to `http://127.0.0.1:3135` with `waitUntil: 'domcontentloaded'`
- Wait 2s for project list to render

### Step 4: Sidebar scroll verification
- Count project items: `document.querySelectorAll('.project-item').length` — expect 10
- Verify sidebar is scrollable if needed: check if `#project-list` has scrollHeight > clientHeight
- Scroll sidebar to bottom: `document.getElementById('project-list').scrollTop = 999999`
- After scroll, verify 10th project is visible (scrollIntoView)
- Take screenshot of sidebar

### Step 5: Name overflow check
- For each project item, check if `.project-item-name` clientWidth <= parentElement clientWidth
- Check if any text is truncated or if it overflows the container
- Record any names that overflow (clientWidth > parentWidth = layout bug)

### Step 6: Click each project in sequence, verify session list
- For i in 1..10:
  - Click project item by index or by name
  - Wait 500ms for Preact re-render
  - Verify `.project-item.active` matches the clicked project (check `project-item-name` text)
  - Count session cards: `document.querySelectorAll('.session-card').length` — expect 1
  - Verify session card name contains `session-for-proj-N` (the name we set)
  - Record: `{ projectClicked: N, sessionCardsShown: count, activeHighlight: ... }`

### Step 7: Cross-contamination check
- Click project 1 — verify exactly 1 session card, named correctly
- Click project 5 — verify exactly 1 session card, named correctly  
- Click project 10 — verify exactly 1 session card, named correctly
- Click project 1 again — verify still shows project 1's session (not leaked)

### Step 8: Final screenshot
- Take full-page screenshot showing sidebar and session list

---

## False-PASS Risks

1. **Empty session lists for all projects**: If sessions were never created or not associated with the right projectId, all projects show 0 sessions — clicking any project shows "empty" which looks the same for all. Test PASSES vacuously because "empty == empty for all". Mitigation: create 1 session per project and verify count == 1 for each.

2. **Active highlighting not checked**: If we just check session count without checking which project is highlighted, a bug where the wrong project's sessions show could pass undetected. Must verify both highlight AND session content.

3. **Overflow measured incorrectly**: `clientWidth` vs `scrollWidth` — must use `scrollWidth > clientWidth` to detect overflow, not just `clientWidth`. A long name in a flex container may push the parent wider, making both appear equal.

4. **Sidebar scrollability — only testing first visible 5**: If sidebar doesn't scroll and only 5 projects fit, the test might only loop through the visible ones. Must explicitly verify `project items length == 10` before iterating.

5. **Preact keyed render confusion**: When clicking project 5 then project 1, Preact re-renders the session list. If the `sessions.value` signal updates correctly but the component doesn't re-filter, old sessions persist. Must have a short wait after click before asserting.

---

## Pass / Fail Criteria

**PASS:**
- 10 project items visible/reachable in sidebar (scrolling if needed)
- No project name overflows its sidebar container (`scrollWidth <= clientWidth + tolerance`)
- Clicking each of 10 projects shows exactly 1 session card
- Session card name matches the one created for that specific project
- Active highlight (`project-item.active`) moves to the clicked project

**FAIL:**
- Fewer than 10 project items found (scroll unreachable)
- Any project name overflows container with visible text clipping or CSS overflow
- Project N shows project M's session (wrong session data rendered)
- Active highlight stays stuck on one project regardless of clicks

**INCONCLUSIVE:**
- Server fails to create sessions (session:created not received)
- Browser fails to load project list
