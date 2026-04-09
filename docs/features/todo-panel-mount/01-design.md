# Design: TodoPanel Mount in App

## Section 1: Problem & Context

### User Problem
Users have no UI path to reach the TODO panel. `TodoPanel.js` is a complete, working component (at `public/js/components/TodoPanel.js`) with full CRUD UI — add, complete, delete, filter by priority and status, reward claim — but it is never imported or rendered anywhere in the application. All TODO API endpoints exist and work (`GET/POST/PUT/DELETE /api/todos/:projectId`, reward endpoint). The component needs only a mount point.

### What Currently Exists

- **`public/js/components/TodoPanel.js`** — complete component accepting `{ projectId }` prop. Lines 12-216. Handles its own data fetching via REST. Has loading/empty/list states.
- **`public/js/components/ProjectDetail.js`** — the main content area for a selected project. Lines 15-88. Currently shows only: sessions list (with "New Claude Session" button), a vertical resize handle, and a terminals area. No tab system exists.
- **`public/js/components/WatchdogPanel.js`** — complete component requiring no props. Lines 10-124. Uses `settings` signal from store.
- **`public/js/components/App.js`** — root component. Lines 55-72. Renders `TopBar`, `ProjectSidebar`, and `ProjectDetail` in a shell layout. No reference to `TodoPanel` anywhere.
- **`public/js/state/store.js`** — signals including `selectedProject`, `selectedProjectId` (lines 15-20). A `todos` signal at line 50 exists but is unused by any component.
- **`lib/api/routes.js`** — TODO API fully wired: lines 258-304 cover GET/POST/PUT/DELETE and reward endpoints. The `refresh` endpoint (`POST /api/todos/:projectId/refresh`) is called in `TodoPanel.js` line 45 — need to verify it exists.

### What's Missing

1. `TodoPanel` is never imported in `App.js` or `ProjectDetail.js`.
2. No navigation mechanism allows switching between "Sessions" and "TODOs" views within a project.
3. `ProjectDetail.js` has no tab system — it shows everything in a single vertical stack.

### Refresh Endpoint Check
The `TodoPanel` calls `/api/todos/:projectId/refresh` (POST). I need to verify this exists.

---

## Section 2: Design Decision

### Mount Location: Tab in ProjectDetail

Add a tab bar to `ProjectDetail` that toggles between two views:
- **Sessions** tab (default): current sessions list + "New Claude Session" button
- **TODOs** tab: renders `<TodoPanel projectId={project.id} />`

This mirrors the pattern of WatchdogPanel being accessible via a separate route in other apps. A tab bar in the project detail header area is the most natural, low-footprint integration: no sidebar changes, no new routes, no modal.

### Files to Modify

1. **`public/js/components/ProjectDetail.js`** — Add a `useState` hook for `activeTab` (default: `'sessions'`). Add tab buttons in the `area-header` section. Conditionally render either the sessions list or `<TodoPanel projectId={project.id} />`. Import `TodoPanel` and `useState`.

2. **`public/js/components/App.js`** — No changes required. `ProjectDetail` is already mounted; internal tab state is self-contained.

### Data Flow

- `selectedProject.value` already provides `project.id` inside `ProjectDetail`.
- `TodoPanel` receives `projectId` as a prop and manages its own data fetching via `useEffect([projectId])`.
- No new signals or state in `store.js` are needed — `TodoPanel` is fully self-contained.

### Tab Navigation Mechanism

In `ProjectDetail`, add local state:
```
const [activeTab, setActiveTab] = useState('sessions');
```

Render tab buttons in the header area:
- "Sessions" button → sets `activeTab = 'sessions'`
- "TODOs" button → sets `activeTab = 'todos'`

Style active tab with `var(--accent)` color, inactive with `var(--text-secondary)`. Use `class="tab-btn active"` / `class="tab-btn"` for testability.

### Conditional Rendering

When `activeTab === 'sessions'`: render the existing sessions area (unchanged).
When `activeTab === 'todos'`: render `<TodoPanel projectId={project.id} />` in place of the sessions area. The terminals area below the resize handle is always visible regardless of tab.

### Project ID Passing

`project.id` is available as `selectedProject.value.id` inside `ProjectDetail`. Pass it directly as `projectId` prop: `html\`<${TodoPanel} projectId=${project.id} />\``.

### Refresh Endpoint

`TodoPanel` calls `POST /api/todos/:projectId/refresh`. If this endpoint doesn't exist in `routes.js`, the refresh button will show a toast error but won't break anything — the component handles the error gracefully (lines 47-51 in `TodoPanel.js`). No API changes are required for the mount.

### What NOT to Build

- Do not redesign `TodoPanel` itself (as instructed).
- Do not add a global TODO badge/counter to the TopBar or sidebar.
- Do not add persistent tab state to `store.js` (local `useState` is sufficient).
- Do not add WatchdogPanel to the tab bar in this feature (separate concern).
- Do not change the terminals area rendering.

---

## Section 3: Acceptance Criteria

1. **Given** a project is selected in the sidebar, **when** the user looks at the detail pane header, **then** they see "Sessions" and "TODOs" tab buttons.

2. **Given** the project detail is showing, **when** the user clicks the "TODOs" tab, **then** the sessions list disappears and the TodoPanel renders in its place, showing either a list of TODOs or the "No TODOs yet" empty state.

3. **Given** the user is on the "TODOs" tab for a fresh project, **when** the panel finishes loading, **then** the text "No TODOs yet" is visible.

4. **Given** the user is on the "TODOs" tab, **when** the user clicks "+ Add", fills in a title, and clicks "Add", **then** the new TODO appears in the list immediately.

5. **Given** the user has added TODOs with different priorities, **when** the user selects the "high" priority filter, **then** only high-priority items are shown (medium and low items disappear).

6. **Given** the user has added a TODO and refreshed the browser, **when** the user navigates back to the project and opens the TODOs tab, **then** the previously added TODO is still present (persistence via server-side storage).

7. **Given** the user is on the "TODOs" tab, **when** the user clicks "× " on a TODO, **then** that TODO is removed from the list.

8. **Given** the user is on the "TODOs" tab, **when** the user clicks the checkbox on a pending TODO, **then** the item shows a strikethrough and its status changes to completed.

9. **Given** the user is on the "Sessions" tab (default), **when** they switch to "TODOs" and back to "Sessions", **then** the sessions list is visible again with all session cards.

10. **Given** the user tries to add a TODO with an empty title, **when** they click "Add" or press Enter, **then** nothing is submitted and the form remains open (empty title guard in `TodoPanel.js` line 78).

---

## Section 4: User Lifecycle Stories

### Story 1: First-time discovery
A user selects a project they've been working on. They notice two tabs in the detail pane: "Sessions" and "TODOs". Curious, they click "TODOs". The panel loads and shows a clipboard icon with "No TODOs yet". They click "+ Add", type a task description, select "high" priority, and click "Add". The item appears instantly. They switch back to "Sessions" and see their session cards are still there, unchanged.

### Story 2: Daily TODO triage
A user opens the app and selects their active project. They click the "TODOs" tab. They see 8 pending items from yesterday. They use the "high" priority filter to focus on urgent items. They complete two high-priority items by clicking their checkboxes. One item shows a "Claim Reward" button — they click it and see a video break embed. They delete two stale items with the × button.

### Story 3: Browser reload persistence
A user adds three TODO items while working on a project. They close the browser and open it later. They select the project from the sidebar, click the "TODOs" tab, and all three items are still there — the server persisted them.

### Story 4: Project switching
A user has two projects. They add a TODO to Project A via the TODOs tab. They then click Project B in the sidebar. The detail pane updates to show Project B's sessions. If they click the TODOs tab for Project B, they see an empty state (or Project B's own TODOs) — not Project A's TODOs. The `projectId` prop changes and `useEffect([projectId])` in `TodoPanel` triggers a fresh load.

### Story 5: Filter navigation
A user has TODOs across multiple priorities. They click "high" filter — only high-priority items show. They click "completed" status filter — only completed high-priority items show (or the "No items match" message). They click "all" priority and "pending" status — they're back to the default view of all pending items.

---

## Section 5: Risks & False-PASS Risks

### Implementation Risks

1. **Tab state not scoped to project**: If `activeTab` state persists across project switches (it won't, because `ProjectDetail` re-reads `selectedProject.value` but doesn't remount on project change), a user might switch projects and find themselves on the "TODOs" tab for the new project. This is acceptable behavior but worth noting.

2. **Missing refresh endpoint**: `POST /api/todos/:projectId/refresh` may not exist in routes.js. The Refresh button in `TodoPanel` will show a toast error. This is not a blocker but should be verified.

3. **`useState` import missing**: `ProjectDetail.js` currently does not import `useState` from `preact/hooks`. The implementer must add this import.

4. **Tab layout clashes with existing header**: The `area-header` div in `ProjectDetail` currently has the "Sessions — {project.name}" title and "New Claude Session" button. The tab buttons need to be added without breaking this layout or making it feel cramped.

### False-PASS Risks

1. **TodoPanel renders but projectId is undefined**: A test that checks for the DOM presence of `.todo-empty` would pass even if `projectId` is undefined, because `TodoPanel` renders the empty state when `items.length === 0` even before fetching. The test must verify that the API call is made with the correct project ID, or add a TODO and verify it persists.

2. **Tab click not wired**: A test that checks "TODOs tab exists" would pass if the tab button is rendered but `onClick` is not wired. Must verify tab switching actually shows `TodoPanel` content.

3. **Stale `activeTab` after project switch**: A test that switches projects might see the TODO panel from the previous project's data if `TodoPanel` doesn't re-fetch on `projectId` change. The `useEffect([projectId])` in `TodoPanel` handles this, but the test should explicitly verify cross-project isolation.

4. **`POST /api/todos/:projectId/refresh` 404**: The refresh button test could be a false-PASS if the endpoint 404s silently (the toast appears but test only checks toast, not the actual data refresh).
