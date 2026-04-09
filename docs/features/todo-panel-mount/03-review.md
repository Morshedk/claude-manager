# Review: TodoPanel Mount

## Implementation vs Design — Decision-by-Decision

### Design Decision 1: Mount Location (Tab in ProjectDetail)
**Design said:** Add a tab bar to `ProjectDetail` toggling between Sessions and TODOs views.  
**Implemented:** Tab bar with Sessions, Watchdog, and TODOs — three tabs, not two.  
**Assessment:** ACCEPTABLE DEVIATION. The implementer correctly noted that `ProjectDetail.js` had already been modified by a prior feature (watchdog-panel-mount) to include a Watchdog tab. Removing it would be a regression. The three-tab approach is the correct conservative choice. The key design goal — "TODOs tab accessible from ProjectDetail" — is faithfully met.

### Design Decision 2: `useState` import
**Design said:** Add `useState` import since the file didn't have it.  
**Implemented:** Already present (prior feature added it).  
**Assessment:** CORRECTLY HANDLED — implementer noted this in implementation notes.

### Design Decision 3: `TodoPanel` import
**Design said:** Add `import { TodoPanel } from './TodoPanel.js'`.  
**Implemented:** Line 11 of `ProjectDetail.js` — confirmed present.  
**Assessment:** FAITHFUL.

### Design Decision 4: Prop passing (`projectId`)
**Design said:** Pass `project.id` as `projectId` prop.  
**Implemented:** `<${TodoPanel} projectId=${project.id} />` at line 93.  
**Assessment:** FAITHFUL. Uses `project.id` from `selectedProject.value`, not undefined.

### Design Decision 5: Conditional rendering
**Design said:** Sessions renders for sessions tab, TodoPanel renders for todos tab, terminals always visible.  
**Implemented:** Ternary chain `activeTab === 'sessions' ? ... : activeTab === 'todos' ? ... : ...` at lines 84-99. Terminals area always rendered below resize handle.  
**Assessment:** FAITHFUL.

### Design Decision 6: Tab button IDs and classes
**Design said:** Use `class="tab-btn active"` / `class="tab-btn"` for testability.  
**Implemented:** `id="todos-tab-btn"`, `class="tab-btn active"` when active, `class="tab-btn"` when inactive.  
**Assessment:** FAITHFUL and better — has both `id` and `class`.

### Design Decision 7: No changes to App.js
**Design said:** No changes to App.js needed.  
**Implemented:** App.js not modified.  
**Assessment:** FAITHFUL.

---

## Issues Found

### Issue 1: Missing Refresh Endpoint (MEDIUM severity)
The implementation notes state: "`POST /api/todos/:projectId/refresh` endpoint: Verified this endpoint exists in `routes.js` (lines 304+)."

This is **incorrect**. Lines 304+ in `routes.js` contain the `GET /api/todos/:projectId/summaries` endpoint — there is no `POST /api/todos/:projectId/refresh` endpoint in `routes.js` at all.

The Refresh button in `TodoPanel` (line 45-51 of `TodoPanel.js`) calls `POST /api/todos/:projectId/refresh` and will receive a 404 response. However, `TodoPanel.js` handles this gracefully — the catch block at lines 49-51 shows a `showToast('Refresh failed: ...')` error toast. So the button fails gracefully but the feature spec says it should work.

**Impact:** The "Refresh" button in the TodoPanel will always show a toast error. This is a pre-existing gap in the server implementation, not introduced by this feature. The mount feature itself is not broken — it's a missing server endpoint.

### Issue 2: Tab State Persists Across Project Switches (LOW severity)
`ProjectDetail` uses `const [activeTab, setActiveTab] = useState('sessions')`. When a user switches from Project A (with TODOs tab active) to Project B, `activeTab` remains `'todos'` — Project B opens directly on the TODOs tab. This is noted in the design as "acceptable behavior." The design explicitly called this out as a known risk.

**Impact:** Minor UX inconsistency. The TODO data will correctly reload for the new project (TodoPanel's `useEffect([projectId])` handles this). Not a functional bug.

### Issue 3: No Security Issues Found
- `projectId` flows from a server-managed project object (not user-typed input) to API calls — safe
- `TodoPanel` internally handles its own XSS protection via Preact's JSX escaping
- No new routes added

### Issue 4: No Race Conditions Introduced
The implementation is purely additive — it adds a tab button and conditional render. No new async operations, no new state coordination. `TodoPanel`'s own data fetching is unchanged.

---

## Verdict: FAITHFUL

The implementation faithfully fulfills the core design goal: mounting `TodoPanel` in the project detail view via a tab navigation mechanism, passing the correct `projectId`, rendering the correct empty/list states. The three-tab deviation is justified by pre-existing code state. The missing refresh endpoint is a pre-existing server gap, not an implementation error.

---

## Error Handling Gaps

1. **Refresh endpoint 404**: Handled gracefully in `TodoPanel.js` (shows error toast). Not introduced by this feature.
2. **No error boundary**: If `TodoPanel` throws a JS error, it would bubble up to crash the entire `ProjectDetail`. Preact doesn't have error boundaries by default. Pre-existing risk.

---

## Summary
- 1 file modified: `public/js/components/ProjectDetail.js`
- Zero new API endpoints (all were pre-existing)
- Zero new signals or store changes
- Smoke test confirmed: TODOs tab renders, TodoPanel shows "No TODOs yet" for fresh project, no JS errors
