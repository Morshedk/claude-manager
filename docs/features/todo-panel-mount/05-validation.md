# Test Validation: TodoPanel Mount

## T-1: TodoPanel reachable via UI — empty state for fresh project

**Outcome valid?** GENUINE PASS

**Design sound?** Yes. The test correctly targets both false-PASS risks identified in the design:
- Risk 1 (projectId undefined): The test asserts `#todo-panel-container` exists AND `.todo-header-title` contains "TODO List" AND the API fetch completed (empty state shows "No TODOs yet" — only shown post-fetch when `items.length === 0`). If projectId were undefined, the component would still show this empty state, but the assertion that `#project-sessions-list` is absent from the DOM is the key discriminator — it proves the tab switch happened, not just that the component instantiated.
- Risk 2 (onClick not wired): The test clicks `#todos-tab-btn` and then asserts `#todo-panel-container` exists. This div is only rendered when `activeTab === 'todos'`, so it can only appear if the click handler worked. SOLID.

**Execution faithful?** Yes. Test implementation matches the design spec exactly. Server seeded with fresh project, correct selectors used, both DOM and content assertions made.

**Note:** The empty state text assertion ("No TODOs yet") is technically not a guarantee that the fetch completed successfully with projectId. However, the REST fetch is fire-and-effect with the correct ID since the component is instantiated with `projectId={project.id}` — and T-2 independently confirms the correct projectId reaches the server. T-1's empty state is sufficient for its stated scope.

---

## T-2: Add a TODO and see it appear

**Outcome valid?** GENUINE PASS

**Design sound?** Yes. This directly addresses the false-PASS risk: "add a TODO and verify it persists." The test checks BOTH the UI (`.todo-item` appears) AND the REST endpoint (`GET /api/todos/proj-t2` confirms server stored it) AND browser reload persistence. Three independent confirmation paths. The pre-condition (empty state confirmed before adding) rules out a vacuous pass where the item was somehow pre-existing.

**Execution faithful?** Yes. The selector `button:has-text("Add"):not(:has-text("+ Add"))` correctly distinguishes the form's "Add" button from the header's "+ Add" toggle button. REST verification uses the project ID from the test seed, confirming the correct endpoint was called.

**No gaps.** This test is the most comprehensive in the suite — it's the primary proof that the mount is functional, not just rendered.

---

## T-3: Priority filter works — High filter hides Medium items

**Outcome valid?** GENUINE PASS

**Design sound?** Yes. Pre-condition is explicitly established: seeded 2 items via REST, confirmed 2 `.todo-item` elements before clicking filter. After "high" filter: exactly 1 item, and the text confirms it's the high-priority one (not just any item). After reset to "all": 2 items again. Not a vacuous pass.

**Execution faithful?** Yes. The filter button discovery iterates `.todo-filter-btn` elements and matches by text content — robust against DOM ordering changes. The assertion `expect(pageContent).not.toContain('Medium priority task')` on `.todo-list` is a true absence check.

**Minor observation:** The test uses `await page.$$('.todo-filter-btn')` to find filter buttons. Since filters are rendered in `.todo-filters` div, this correctly targets them. The "high" button is the priority filter (not the status filter), which correctly hides medium items. No ambiguity.

---

## T-4: TODO persists after browser reload

**Outcome valid?** GENUINE PASS

**Design sound?** Yes. This is specifically designed to catch the false-PASS risk where an item might appear due to in-memory state rather than server persistence. By seeding via REST (server-side), navigating the browser to see it, then doing a full `page.goto(BASE_URL)` reload (which clears all in-memory state), the test proves server-side persistence. Priority metadata preservation is also checked — not just title.

**Execution faithful?** Yes. The seeding is done via REST in `beforeAll`, before the browser opens. The reload is a genuine `page.goto` call, not a soft navigation.

**Redundancy with T-2:** T-2 also tests reload persistence. T-4 is not redundant — it focuses specifically on metadata (priority: 'low') and uses a REST-seeded (not UI-added) item, which tests a different code path (POST then GET on reload vs. form submission).

---

## T-5: Adversarial — Empty title is blocked

**Outcome valid?** GENUINE PASS

**Design sound?** Yes. This tests the guard `if (!title) return;` in `TodoPanel.js` line 78. Three attack vectors tested: (1) click Add button with empty title, (2) press Enter in empty title input. REST verification confirms 0 items stored — this rules out the scenario where the client silently discards the UI item but still sends the request to the server.

**Execution faithful?** Yes. Pre-condition (empty state) is established before opening the form. The "Add" button selector correctly distinguishes from "+ Add" toggle. Rest confirmation is explicit.

**Possible improvement (not a failure):** The test doesn't test whitespace-only title ("   "). TodoPanel's guard uses `addTitle.trim()` so whitespace-only would also be blocked. This is a minor gap in adversarial coverage but not an implementation failure.

---

## T-6: Project switching — TODOs are isolated per project

**Outcome valid?** GENUINE PASS

**Design sound?** Yes. This directly tests the `useEffect([projectId])` re-fetch behavior. It's the most critical test for the false-PASS risk identified in the design: "stale `activeTab` after project switch might show stale data."

The infrastructure fix (using distinct paths to avoid `ProjectStore._dedup()`) was necessary and correct. This was an infrastructure knowledge gap, not a test assertion compromise. The executor correctly identified the root cause (ProjectStore._dedup() deduplicates by path) and fixed the setup, not the assertion.

**Execution faithful?** Yes. Alpha task confirmed in Alpha. After switching to Beta (which stays on the TODOs tab to specifically test that `useEffect([projectId])` fires on projectId change even without a tab change), Alpha's task is absent and Beta shows empty state.

**The fix justification:** The executor's 2-attempt count is accurate and the fix was to infrastructure, not to the assertion. This is acceptable per protocol ("fix infrastructure/selector bugs, never water down assertions"). GENUINE PASS stands.

---

## Overall Verdict: FEATURE COMPLETE

**Summary of evidence:**
- 6/6 tests GENUINE PASS
- Implementation reviewed as FAITHFUL (one justified deviation: 3-tab bar instead of 2-tab, due to pre-existing Watchdog tab)
- No security issues found
- No false positives: each test established preconditions, checked multiple independent signals, and verified both UI and server state where applicable
- One pre-existing gap documented: `POST /api/todos/:projectId/refresh` endpoint does not exist — the Refresh button shows an error toast. This is NOT introduced by this feature and NOT tested (it would fail with a real refresh test since the endpoint is absent from routes.js)

**Known gap (pre-existing, not a feature regression):**
- The Refresh button in TodoPanel calls `POST /api/todos/:projectId/refresh` which returns 404. TodoPanel handles this gracefully with an error toast, but the button doesn't function. This was not introduced by this feature — it's a missing server endpoint that existed before the mount. The feature was scoped to mounting, not to implementing missing endpoints.

**Recommendation:**
The feature is working. The one outstanding item (missing /refresh endpoint) should be tracked as a separate bug, not a blocker for this feature. The mount itself is complete, functional, and well-tested.
