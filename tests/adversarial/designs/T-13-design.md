# T-13: Submitting New Project With Empty Name Shows Validation Error

**Source:** T-13 adversarial test spec  
**Score:** L=4 S=2 D=3 (Total: 9)  
**Test type:** Playwright browser test

---

## 1. Infrastructure Setup

### 1a. Temporary data directory

Create an isolated `DATA_DIR` so the test does not pollute or depend on any existing server state:

```
DATA_DIR = fs.mkdtempSync('/tmp/T-13-')
```

Seed with minimal valid ProjectStore state (no projects needed for this test):
```json
{ "projects": [], "scratchpad": [] }
```

### 1b. Start the server

Launch the server on port **3110** with the temporary data directory:

```
DATA_DIR=<tmpdir> PORT=3110 node server-with-crash-log.mjs
```

Poll `GET http://localhost:3110/api/projects` every 500ms up to 10 seconds. If no 200 response, fail immediately.

### 1c. Launch Playwright browser

Open a Chromium page navigated to `http://localhost:3110`. Use `waitUntil: 'domcontentloaded'`. Wait for the sidebar to be visible (`#project-sidebar`).

---

## 2. Component Analysis (from source reading)

### NewProjectModal.js — key validation logic

```js
async function handleCreate() {
  const trimmedName = name.trim();
  const trimmedPath = path.trim();
  if (!trimmedName) {
    showToast('Project name is required', 'error');
    return;  // ← early return, modal stays open, no API call
  }
  if (!trimmedPath) {
    showToast('Project path is required', 'error');
    return;  // ← same
  }
  // ...proceeds to createProject(trimmedName, trimmedPath)
}
```

**Correct behavior verified:** The validation fires client-side before any API call. Two distinct validation paths:
1. Empty name (with or without path) → toast "Project name is required"
2. Non-empty name + empty path → toast "Project path is required"

### Toast DOM structure (from App.js ToastContainer)

Toasts render as inline `<div>` elements inside a fixed container at bottom-right. No special class or id — text content is the selector anchor. The toast disappears after 3000ms (default duration).

**Selector strategy:** `page.locator('text=Project name is required')` or `div:has-text("Project name is required")` within the toast container.

### Modal selector

The modal renders when `newProjectModalOpen.value` is true. Outer wrapper: `div.dialog-overlay`. Inner dialog: `div.modal[role="dialog"][aria-label="New Project"]`.

Input fields:
- Name: `#new-project-name` (or `input[placeholder="e.g. My App"]`)
- Path: `#new-project-path` (or `input[placeholder="e.g. /home/user/my-app"]`)

Submit button: `button.btn.btn-primary` with text "Create Project" (inside `.dlg-footer`).
Cancel button: `button.btn.btn-ghost` with text "Cancel".

---

## 3. Exact Action Sequence

### Scenario A: Empty name, valid path (primary test case — 3 repetitions)

1. Open modal by clicking the "New Project" button (`button.sidebar-new-btn`).
2. Wait for `div.dialog-overlay` to be visible.
3. Assert `#new-project-name` is present and empty.
4. Assert `#new-project-path` is present and empty.
5. **Leave name field blank.**
6. Fill path field with `/tmp/test-project-path`.
7. Click the "Create Project" button (`div.dialog-overlay .btn-primary`).
8. Assert toast appears: `div:has-text("Project name is required")` — wait up to 3 seconds.
9. Assert modal is still open: `div.dialog-overlay` still visible.
10. Assert no project was created: `GET /api/projects` returns `[]`.
11. Close modal with Cancel button.
12. Wait 500ms.
13. Repeat from step 1 (3 times total). Each iteration must pass all assertions.

### Scenario B: Empty path, valid name (second variant — 2 repetitions)

1. Open modal.
2. Fill name field with `Test Project B`.
3. **Leave path field blank.**
4. Click "Create Project".
5. Assert toast: `div:has-text("Project path is required")` — wait up to 3 seconds.
6. Assert modal still open.
7. Assert no project created: `GET /api/projects` returns `[]`.
8. Close modal with Cancel button.
9. Wait 500ms.
10. Repeat (2 times total).

### Scenario C: Both fields empty (edge case — 1 pass)

1. Open modal.
2. Leave both fields blank.
3. Click "Create Project".
4. Assert toast: `div:has-text("Project name is required")` (name checked first per code).
5. Assert modal still open.
6. Close modal.

### Scenario D: Whitespace-only name (trimming test — 1 pass)

1. Open modal.
2. Fill name with `   ` (3 spaces).
3. Fill path with `/tmp/valid-path`.
4. Click "Create Project".
5. Assert toast: `div:has-text("Project name is required")` (name.trim() === "").
6. Assert modal still open.
7. Assert no project created.
8. Close modal.

---

## 4. Assertions (per iteration)

### Must pass:

1. **Toast appears within 3 seconds** — `div:has-text("Project name is required")` is visible.
2. **Modal stays open** — `div.dialog-overlay` is still visible after the toast appears.
3. **No project created** — `GET /api/projects` returns an empty array `[]`.
4. **No API call made** — Monitor network requests: `POST /api/projects` must NOT have been called.

### Fail conditions:

- Modal closes after clicking "Create Project" with empty name (silent failure).
- Toast does not appear within 3 seconds.
- Toast text differs from "Project name is required" (e.g., missing, or different message).
- `GET /api/projects` returns a newly created project.
- A `POST /api/projects` network request was observed.

---

## 5. Network Monitoring

Use Playwright's `page.on('request')` or route interception to capture all POST requests to `/api/projects`. After each submit-with-empty-name click, assert that no POST was observed.

```js
const apiCalls = [];
page.on('request', req => {
  if (req.url().includes('/api/projects') && req.method() === 'POST') {
    apiCalls.push({ url: req.url(), postData: req.postData() });
  }
});
```

After each validation-triggering click, assert `apiCalls.length === 0` (or no new entries since the last check).

---

## 6. Pass/Fail Criteria

### PASS (all must hold):

1. Scenario A: All 3 iterations pass all 4 assertions.
2. Scenario B: Both iterations pass all 4 assertions.
3. Scenario C: Single run passes.
4. Scenario D: Whitespace-only name triggers "Project name is required".
5. No `POST /api/projects` calls observed in any scenario.

### FAIL (any one is sufficient):

1. Modal closes without showing a toast on empty-name submit.
2. Toast text does not contain "Project name is required".
3. A project appears in `GET /api/projects` after an empty-name submit.
4. A `POST /api/projects` network request is made.
5. Toast is shown but modal also closes (partial failure).

---

## 7. Screenshots

Save to `qa-screenshots/T-13-validation/`:

| Filename | When | Purpose |
|---|---|---|
| `A-iter-N-01-modal-opened.png` | After modal opens | Confirm empty state |
| `A-iter-N-02-after-submit.png` | After clicking Create with empty name | Capture toast + modal |
| `A-iter-N-03-modal-still-open.png` | 1s after submit | Confirm modal not closed |
| `B-01-path-validation.png` | After path-empty submit | Capture "path required" toast |
| `C-01-both-empty.png` | After both-empty submit | Capture name-checked-first behavior |
| `D-01-whitespace.png` | After whitespace-name submit | Confirm trim() works |

---

## 8. Cleanup

1. Kill server process (SIGTERM → SIGKILL after 3s).
2. Remove temporary DATA_DIR.
3. Close Playwright browser.

---

## 9. Known Risks

### Risk 1: Toast disappears before assertion
Default toast duration is 3000ms. The assertion must check within that window. Use `page.waitForSelector('div:has-text("Project name is required")', { timeout: 3000 })` not a delayed check.

### Risk 2: Whitespace toast text mismatch
The source shows `showToast('Project name is required', 'error')` — no period at end. Ensure assertion matches exactly (case-sensitive partial match is fine).

### Risk 3: Modal overlay click-to-close race
The outer `div.dialog-overlay` has `onClick=${closeNewProjectModal}`. Clicking "Create Project" must use the inner button, not anywhere near the overlay edge, to avoid inadvertently triggering `closeNewProjectModal`.

### Risk 4: Dialog selector specificity
The modal uses inline styles, no dedicated CSS class on the outer overlay besides `dialog-overlay`. Use `div.dialog-overlay` as the stability selector.

---

## Execution Summary

**Run date:** 2026-04-08
**Result:** PASS — 4/4 tests passed in 21.8s

### Scenario results

| Scenario | Description | Iterations | Result |
|----------|-------------|-----------|--------|
| A | Empty name + valid path → name-required toast | 3/3 | PASS |
| B | Valid name + empty path → path-required toast | 2/2 | PASS |
| C | Both fields empty → name checked first | 1/1 | PASS |
| D | Whitespace-only name (trim test) | 1/1 | PASS |

### Key findings

- All 4 assertions held across every iteration: toast appeared within 3s, modal stayed open, no POST `/api/projects` fired, server returned 0 projects.
- No fixes needed — test passed on first run.
- Selectors (`#new-project-name`, `#new-project-path`, `div.dialog-overlay`, `.dlg-footer .btn-primary`) matched the live DOM exactly.

### Artifacts

- Screenshots saved to `qa-screenshots/T-13-validation/` (9 images)
- Run output: `tests/adversarial/designs/T-13-run-output.txt`
