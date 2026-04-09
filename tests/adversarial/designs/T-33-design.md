# T-33 Design: TODO — Add Item With Empty Title Is Blocked

**Score:** 8 | **Type:** Playwright browser | **Port:** 3130

---

## What This Test Must Prove

Two layers block empty-title TODO creation:
1. **Client-side guard:** `addTodo()` in `TodoPanel.js` line 77–78 does `if (!title) return` — silent early return, no API call made.
2. **Server-side guard:** `POST /api/todos/:projectId` at routes.js line 268 does `if (!title) return res.status(400).json({ error: 'Title is required' })`.

The test must verify both layers. A vacuous PASS occurs if the test never actually opens the add form, or if it asserts on the wrong thing.

---

## Source File Analysis

**`TodoPanel.js` — critical findings:**

- `'+ Add'` button toggling: `onClick=${() => setShowAddForm(v => !v)}`, text is `'+ Add'` when closed, `'− Cancel'` when open. CSS class: `btn btn-ghost btn-sm` inside `.todo-header-actions`.
- Add form class: `todo-add-form` (only rendered when `showAddForm === true`).
- Title input: `value=${addTitle}`, `onInput` updates `addTitle`. Placeholder: "What needs to be done?...". Starts empty.
- "Add" button inside form: plain `<button onClick=${addTodo}>Add</button>`. No `type="submit"`, no `disabled`, no `required`.
- `addTodo()`: `if (!title) return;` — form stays open (no state change), no toast, no error message, no API call.
- **The component is NOT mounted in the main App.** It exists as a component file but is not rendered anywhere in the current UI.

**Consequence:** The Playwright test cannot navigate to a UI page and see the TodoPanel. Instead, the test must:
1. Create a minimal test harness HTML page that mounts the TodoPanel component with a real projectId.
2. OR test via the REST API exclusively.

**Decision:** The test will use a **two-part approach**:
- Part A (REST API): Directly call `POST /api/todos/:id` with empty title → expect 400 rejection. This verifies the server guard.
- Part B (Component + Playwright): Serve a minimal `test-harness.html` page from the same server or use `page.setContent()` with the component. Since the full Preact/htm build is served via the server's `/js/` route, use `page.evaluate()` to inject and mount the component into the live app's DOM.

**Simplest approach:** Use `page.evaluate()` to programmatically invoke `TodoPanel`'s logic by calling the fetch API directly from the browser context, AND separately verify the early-return behavior by setting up `page.route()` interception.

**Final test strategy:**
1. Navigate to the live app.
2. Select a project.
3. Use `page.route('**/api/todos/**', ...)` to intercept any POST calls.
4. Via `page.evaluate()`, simulate what clicking "+ Add" then "Add" with empty title would do by directly testing the server API, AND by trying to inject the component.
5. Actually: the cleanest path is to create a test-harness page inline.

**Revised Decision:** Serve a `test-harness.html` from the server's static dir temporarily, OR use `page.setContent()` with a full HTML page that loads Preact and TodoPanel via the server's module URLs.

**Final Final Decision:** Use `page.setContent()` to create a harness page that imports TodoPanel via the server's URL. The server at port 3130 serves `/js/...` files. We can write a harness HTML body and set it up.

Actually the cleanest approach given the constraints: Use the live app page (navigate there), intercept network, then use `page.evaluate()` to:
1. Import `TodoPanel` from the server URL.
2. Mount it into a div.
3. Interact with it.

This is complex. The simplest reliable approach: **test both the API layer and the component guard separately.**

---

## Actual Test Strategy

### Part A: API-level test (verifies server guard)
Use `fetch` from browser context or Node `fetch` to call `POST /api/todos/:projectId` with `{ title: '', priority: 'medium', estimate: '5m' }`. Assert response status is 400.

### Part B: Component behavior test via page.evaluate
1. Navigate to the live app.
2. Select a project.
3. Use `page.route()` to intercept `POST /api/todos/**`.
4. Use `page.evaluate()` to access the TodoPanel's `addTodo` logic by mounting the component via Preact's render into the DOM.

**The most pragmatic implementation:** Write a minimal standalone HTML test harness file to the server's `public/` directory during the test, then navigate to it. Clean it up afterward.

---

## Infrastructure

- Port: 3130
- Server: `node server-with-crash-log.mjs` with `DATA_DIR`, `PORT=3130`, `CRASH_LOG`
- Seed: `POST /api/projects` with `{ name: 'T33-Test', path: '/tmp' }`
- Screenshot dir: `qa-screenshots/T-33-todo-empty-title`

---

## Step-by-Step Execution Script

### Step 1: Server startup
Spawn server on port 3130 with isolated `tmpDir`. Poll `GET /` until 200 (timeout 25s). Seed a project.

### Step 2: Write test harness page
Write `/home/claude-runner/apps/claude-web-app-v2/public/test-harness-T33.html` — a minimal HTML page that:
- Imports Preact + htm from the server's `/vendor/` directory.
- Imports `TodoPanel` from `/js/components/TodoPanel.js`.
- Renders `<TodoPanel projectId="<seeded-project-id>" />` into `#root`.

### Step 3: Navigate to harness page
`page.goto('http://127.0.0.1:3130/test-harness-T33.html', { waitUntil: 'domcontentloaded' })`.
Wait for `.todo-header` to be visible.

### Step 4: Set up network interception
`page.route('**/api/todos/**', ...)` — capture any POST requests, log them, then continue.

### Step 5: Click "+ Add"
`page.click('button:text("+ Add")')`. Wait for `.todo-add-form` to be visible. Take screenshot.

### Step 6: Verify title input is empty, then click "Add"
Assert title input value is `''`. Click the Add button inside the form. Wait 500ms.

### Step 7: Assert form still open and no TODO created
- Assert `.todo-add-form` is still visible (form not dismissed on empty title).
- Assert `.todo-item` count is 0.
- Assert no network POST was intercepted.

### Step 8: API-level test
Using `node-fetch` or the test runner's HTTP, POST `{ title: '', priority: 'medium' }` to `/api/todos/:projectId`. Assert status 400, body contains `{ error: 'Title is required' }`.

### Step 9: Positive-path confirmation (non-vacuous)
Type "Test task" into the title input. Click "Add." Assert `.todo-item` count becomes 1. Assert the item title contains "Test task."

### Step 10: Cleanup
Delete the harness file. Kill server.

---

## Pass / Fail Criteria

**Pass:**
- Form stays open after clicking "Add" with empty title.
- No POST to `/api/todos/` is made from the browser.
- Server rejects direct POST with empty title (400).
- Positive path: valid title creates 1 TODO item.

**Fail:**
- `.todo-item` appears with empty title.
- POST to `/api/todos/` is intercepted with empty title.
- Form closes as if submission succeeded.

---

## False-PASS Risks

1. **Harness page never loads.** Mitigation: hard `throw` if `.todo-header` not visible within 10s.
2. **Import fails (ESM module path issues).** Mitigation: test that component renders the header text "TODO List."
3. **Network interception set up after POST fires.** Mitigation: set up route before clicking Add.
4. **Positive path assertion on wrong selector.** Mitigation: use `.todo-title` text content check.

---

## Validator Checklist

- Was the add form confirmed visible before clicking "Add"?
- Was network interception active before clicking "Add"?
- Was the API-level rejection (400) tested independently?
- Was the positive path genuinely tested (title input, submit, card appears)?
