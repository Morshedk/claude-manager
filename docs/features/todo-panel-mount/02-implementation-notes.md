# Implementation Notes: TodoPanel Mount

## Files Modified

### `public/js/components/ProjectDetail.js`
**What changed:**
1. Added import: `import { TodoPanel } from './TodoPanel.js';` (line 11)
2. Added a "TODOs" tab button alongside the existing "Sessions" and "Watchdog" tab buttons in the `sessions-tab-bar` div. The button has `id="todos-tab-btn"` and `class="tab-btn"` (active when `activeTab === 'todos'`).
3. Added a conditional render branch: when `activeTab === 'todos'`, renders `<TodoPanel projectId={project.id} />` inside a `#todo-panel-container` div.

**Key discovery:** The file had already been modified from what the design document assumed — it already had `useState` imported, a `WatchdogPanel` import, and an existing tab bar with "Sessions" and "Watchdog" tabs. The design described a two-tab system (Sessions/TODOs), but the codebase already had a Sessions/Watchdog tab bar. The implementation correctly extends this to a three-tab bar (Sessions / Watchdog / TODOs).

## Deviations from Design

**Design said:** Two tabs — "Sessions" and "TODOs"  
**Implemented:** Three tabs — "Sessions", "Watchdog", and "TODOs"  
**Reason:** The codebase already had a Watchdog tab from a prior feature (watchdog-panel-mount). Adding TODOs as a third tab preserves the existing Watchdog functionality and is the most conservative/correct interpretation. Removing the Watchdog tab would be a regression.

**Design said:** Tab bar goes in the `area-header` div  
**Implemented:** Tab bar is already in a separate `sessions-tab-bar` div below the `area-header`  
**Reason:** The existing structure placed the tab bar in its own div below the header (consistent with how Watchdog was mounted). Kept this structure for consistency.

## Smoke Test

**Test:** Playwright headless browser
- Started server on port 3220 with a seeded project (`proj-smoke-01`, "Smoke Project")
- Navigated to `http://localhost:3220`
- Located the project in the sidebar and clicked it
- Verified `#todos-tab-btn` exists in the DOM
- Clicked the TODOs tab
- Verified `.todo-header-title` contains "TODO List"
- Verified `.todo-empty` shows "No TODOs yet" empty state
- Verified zero JS console errors

**Result:** All 4 checks passed. No JS errors.

## Things Noticed

1. **`POST /api/todos/:projectId/refresh` endpoint:** Verified this endpoint exists in `routes.js` (lines 304+). The Refresh button in TodoPanel will work correctly.

2. **`selectedProjectId` import:** `ProjectDetail.js` imports `selectedProjectId` from the store but doesn't use it directly (uses `selectedProject.value.id`). This is pre-existing unused import; not touched.

3. **`project.id` vs `selectedProjectId.value`:** Used `project.id` (from `selectedProject.value` which is already assigned to `project`) rather than `selectedProjectId.value` — both would work, but `project.id` is more direct and consistent with how the component already uses `project`.

## Not Done

- No new API endpoints added (none needed — all TODO endpoints already existed).
- Did not modify `App.js` (no changes needed).
- Did not modify `TodoPanel.js` (as instructed).
- Did not add TODO count badge to sidebar (out of scope).
