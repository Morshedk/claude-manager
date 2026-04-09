# T-08: Creating Project with Non-Existent Path Shows Error — Modal Stays Open

**Source:** Story 20
**Score:** L=3 S=3 D=4 (Total: 10)
**Test type:** Playwright browser test

---

## 1. Infrastructure Setup

### 1a. Temporary data directory

Create an isolated `DATA_DIR` so the test does not pollute or depend on existing server state:

```
DATA_DIR = mktemp -d /tmp/qa-data-XXXXXX
```

Seed a valid `projects.json` to ensure correct structure:

```json
{ "projects": [], "scratchpad": [] }
```

### 1b. Start the server

Launch the server on port **3105** with the temporary data directory:

```
DATA_DIR=<tmpdir> PORT=3105 node server.js &
```

Wait for the server to respond to `GET http://localhost:3105/api/projects` with a 200 before proceeding. Poll up to 10 seconds, 500ms intervals. If the server does not come up, fail immediately.

### 1c. Launch Playwright browser

Open a Chromium page navigated to `http://localhost:3105`. Use `waitUntil: 'domcontentloaded'`.

Wait for the `#project-sidebar` element to be visible. This confirms the app shell is rendered.

---

## 2. Pre-test Assertions

Before executing the test, verify:

1. **Sidebar visible.** `#project-sidebar` is present in DOM.
2. **No projects in sidebar.** The `.sidebar-empty` element is present (text "No projects yet — add one below") — confirms a clean slate.
3. **New Project button visible.** The `.sidebar-new-btn` (text "+ New Project" or similar) is present and enabled.
4. **API confirms empty.** `GET http://localhost:3105/api/projects` returns `[]`.

---

## 3. Understanding the Bug Surface

### 3a. What the server actually does

`ProjectStore.create()` in `lib/projects/ProjectStore.js` does NOT validate that the path exists on disk. It calls `fs.existsSync()` only for deduplication data file and its own save directory — not the project path. Any path string is accepted and stored.

The `POST /api/projects` route returns `201 Created` with the new project object for ANY non-duplicate path — including completely fictitious paths like `/absolutely/nonexistent/path/xyz123`.

### 3b. What the client does

`createProject()` in `public/js/state/actions.js` calls `fetch('/api/projects', ...)` and then does `.then(r => r.json())`. It does NOT check `r.ok`. If the server returns 400, the JSON `{ error: "..." }` is returned without throwing. The component's `catch` block in `handleCreate()` is only reached for network errors, not HTTP 4xx/5xx responses.

However for a non-existent path, the server returns **201** (success), so `data.id` will be set, `selectedProjectId.value = data.id` will fire, `closeNewProjectModal()` will be called, and a success toast will show.

### 3c. Expected behavior (pass condition)

An error toast appears explaining the failure. The modal stays open. The project does NOT appear in the sidebar.

### 3d. Actual likely behavior (predicted fail condition)

The modal closes with a success toast. The project WITH the non-existent path appears in the sidebar. Silent creation of an invalid project entry.

---

## 4. Modal Selectors

From `NewProjectModal.js`:

| Element | Selector |
|---------|----------|
| Modal overlay | `.dialog-overlay` |
| Modal dialog | `.modal[role="dialog"]` |
| Modal header | `.dlg-header h2` (text "New Project") |
| Name input | `#new-project-name` |
| Path input | `#new-project-path` |
| Cancel button | `.dlg-footer .btn-ghost` (text "Cancel") |
| Create button | `.dlg-footer .btn-primary` (text "Create Project") |
| Create button disabled | `.dlg-footer .btn-primary[disabled]` |

### How to detect "modal stays open"

After clicking "Create Project":

1. Wait 2 seconds for async completion.
2. Assert that `.dialog-overlay` is still present in DOM (`isVisible()`).
3. Assert that `.modal[role="dialog"]` is still present and visible.
4. Negative assertion: `closeNewProjectModal()` must NOT have been called — confirmed by modal still existing.

If `.dialog-overlay` disappears after the create attempt, that is a FAIL regardless of whether a toast appears.

---

## 5. Toast Selectors

Toasts are rendered via the `toasts` signal in `state/store.js`. The toast component renders elements with class reflecting the type.

From the app's toast rendering (check `public/js/app.js` or equivalent):

- Container: `#toast-container` or `.toast-container` or `.toasts`
- Individual toast: `.toast` or `.toast-item`
- Error toast: `.toast.error` or `.toast[data-type="error"]` or containing text "Failed"

A **meaningful** error toast check must:
1. Assert the toast appears (visible in DOM) within 2 seconds of the create attempt.
2. Assert the toast type is "error" (not "success").
3. Assert the toast message contains relevant failure text (e.g., "Failed to create project" or similar).

A toast that says "Project created successfully" is a FAIL even if the modal somehow stayed open.

---

## 6. Sidebar Check

After the create attempt:

1. Wait 3 seconds for any async state updates.
2. Query `GET http://localhost:3105/api/projects` — must return `[]` (no projects created).
3. In DOM, assert `.project-item` count is 0.
4. Assert `.sidebar-empty` is still visible (the "No projects yet" placeholder).

The sidebar uses the `projects` signal. If `loadProjects()` is called after a 201 response, the new (invalid) project entry will appear. If the sidebar shows a project with name "Bad Path Project", that is a FAIL.

---

## 7. Exact Action Sequence

### 7a. Open the New Project modal

Click the `.sidebar-new-btn` button. Wait for `.dialog-overlay` to appear. Verify `.dlg-header h2` text is "New Project".

### 7b. Fill in the project name

Type "Bad Path Project" into `#new-project-name`.

### 7c. Fill in the non-existent path

Type "/absolutely/nonexistent/path/xyz123" into `#new-project-path`.

### 7d. Take a screenshot

Save as `T-08-01-form-filled.png` in `qa-screenshots/T-08-bad-path/`.

### 7e. Click "Create Project"

Click `.dlg-footer .btn-primary`. The button shows "Creating…" briefly while `submitting` state is true.

### 7f. Wait for async resolution

Wait 2 seconds. The fetch to `/api/projects` resolves.

### 7g. Take a screenshot

Save as `T-08-02-after-create.png`.

---

## 8. Verification Steps

### 8a. Modal state check

- Assert `.dialog-overlay` is visible → if not, FAIL("modal closed after invalid path creation")
- Assert `#new-project-name` is in DOM → if not, FAIL("modal removed from DOM")

### 8b. Toast check

- Assert a toast element is visible within 3 seconds.
- Assert the toast is an error type (not success).
- Assert the toast does NOT say "created" — it should say something like "Failed to create project" or an error message.
- If the toast says "Project 'Bad Path Project' created" → FAIL("success toast shown for invalid path")
- If no toast appears → FAIL("no feedback given to user")

### 8c. Sidebar check

- Assert `.project-item` count in DOM is 0.
- Assert `GET /api/projects` returns `[]`.
- If "Bad Path Project" appears in the sidebar → FAIL("project with nonexistent path created")

### 8d. User can retry

- Assert the form inputs still contain the values ("Bad Path Project" and "/absolutely/nonexistent/path/xyz123").
- Assert the user can modify the path and try again (inputs are editable).

---

## 9. Repeat Protocol (3x)

Run the full scenario 3 times to check consistency:

**Iteration 1:** Path = `/absolutely/nonexistent/path/xyz123`
**Iteration 2:** Path = `/this/does/not/exist/either`
**Iteration 3:** Close and reopen the modal, use path = `/nonexistent`

For each iteration:
- Reset: use the Cancel button (or Escape key) to close the modal after the error, then reopen.
- Confirm project count remains 0 throughout all iterations.

---

## 10. Pass/Fail Criteria

### PASS (all must hold for every iteration):

1. Modal stays open after clicking "Create Project" with a nonexistent path.
2. An error toast appears (not a success toast).
3. The project does NOT appear in the sidebar.
4. `GET /api/projects` returns `[]` after the failed attempt.
5. The form inputs are still editable (user can correct and retry).

### FAIL (any one is sufficient):

1. Modal closes after clicking "Create Project" with a nonexistent path.
2. A success toast appears ("Project created").
3. "Bad Path Project" appears in the sidebar `#project-list`.
4. `GET /api/projects` returns a project with the nonexistent path.
5. No toast appears at all (silent failure).
6. The "Create Project" button becomes permanently disabled.

---

## 11. Screenshots

Save all screenshots to `qa-screenshots/T-08-bad-path/`:

| Filename | When |
|----------|------|
| `iter-N-01-form-filled.png` | After filling name + bad path, before clicking Create |
| `iter-N-02-after-create.png` | 2 seconds after clicking Create |
| `iter-N-03-FAIL.png` | If any fail condition is triggered |
| `iter-N-04-sidebar.png` | After checking sidebar state |

---

## 12. Cleanup

After all iterations (pass or fail):

1. Delete any accidentally-created projects via `DELETE http://localhost:3105/api/projects/<id>` for each.
2. Kill the server process. Send SIGTERM, wait 3 seconds, SIGKILL if still alive.
3. Remove the temporary data directory (`rm -rf $DATA_DIR`).
4. Close the Playwright browser.

All cleanup in an `afterAll` block that runs even on failure.

---

## 13. Known Risks and Design Decisions

### Risk 1: Server accepts nonexistent paths (predicted bug)

`ProjectStore.create()` has no filesystem validation. The server will return 201 for any path string, including nonexistent ones. This means the "pass condition" described in the spec (error toast, modal stays open) is almost certainly NOT met by the current implementation.

**Implication:** This test is expected to FAIL, confirming the bug exists.

### Risk 2: `createProject` in actions.js does not check `r.ok`

The fetch chain `.then(r => r.json())` ignores HTTP status codes. Even if a future fix added server-side path validation (returning 400), the client would not throw — it would receive `{ error: "..." }` as data, not throw into the catch block. This is a **second bug** that must be fixed alongside server-side validation.

**Test implication:** Even after adding server-side path validation, the client will need to check `r.ok` and throw for the modal to stay open. The test will catch BOTH layers of the bug.

### Risk 3: Toast auto-dismiss timing

The toast duration is 3000ms. The test must assert toast presence quickly (within 2s of create attempt completing). Use `page.waitForSelector('.toast', { timeout: 3000 })` to catch it.

### Risk 4: Modal selector ambiguity

The `.modal` class may exist on multiple elements. Use `role="dialog"` + `aria-label="New Project"` for precision: `page.locator('[role="dialog"][aria-label="New Project"]')`.

### Design Decision: Use REST API not WebSocket

Unlike T-01 (sessions), project creation uses REST (`POST /api/projects`), not WebSocket. The `createProject()` action in `actions.js` makes a direct `fetch()` call. No WS message interception needed.

### Design Decision: Why 3 iterations

The behavior here is deterministic, not a race condition. 3 iterations with different invalid paths confirms the bug is systematic (not path-specific) and that modal state resets correctly between attempts.

---

## Execution Summary

**Date:** 2026-04-08  
**Result:** PASS (5/5 tests) — after bug fix

### Run 1 (pre-fix): FAIL — 3/5 failed
The test correctly detected the predicted bug: `POST /api/projects` accepted any path string and returned `201 Created` regardless of filesystem existence. The modal closed with the project appearing in the sidebar. The `createProject()` action in `actions.js` did not check `r.ok`, so no error was thrown.

### Fixes applied:
1. **`lib/projects/ProjectStore.js` `create()`** — Added `fs.existsSync(normalized)` check before creating the project. Throws `Error: Path does not exist: <path>` for nonexistent paths. Server returns `400 Bad Request`.
2. **`public/js/state/actions.js` `createProject()`** — Changed `.then(r => r.json())` to await response separately, check `if (!r.ok) throw new Error(data.error || ...)`. This causes the error to propagate to `handleCreate()`'s catch block, which shows the error toast and leaves the modal open.
3. **Test cleanup** — Changed modal close from `Escape` key press (which didn't work for the dialog-overlay) to Cancel button click.

### Run 2 (post-fix): PASS — 5/5
- Modal stays open for all 3 bad path iterations ✓
- Error propagates correctly via 400 → `r.ok` check → throw → toast ✓
- No projects created in API or sidebar after 3 attempts ✓
- Form inputs remain editable and retain values ✓
- Console logs confirm server error: `Path does not exist: /absolutely/nonexistent/path/xyz123`

### Verdict: EXPECTED BEHAVIOR NOW ENFORCED
The test exposed a real double-layer bug (server: no fs validation; client: no `r.ok` check). Both were fixed. The test now passes reliably across all 3 iterations.
