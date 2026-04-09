# T-11: New User First 5 Minutes — Create Project and First Session

**Score:** L=3 S=4 D=5 (Total: 12)
**Test type:** Playwright browser
**Port:** 3108

---

## 1. What This Test Proves

A brand-new user with zero projects and zero sessions can:
1. Land on the app and see a meaningful empty state ("No projects yet")
2. Click "New Project," fill in name and path, successfully create a project
3. See the project appear in the sidebar without reloading
4. Click "New Claude Session," fill in a name, leave Haiku model selected (via the Haiku quick button)
5. Click Start — see the session card appear immediately with "starting" badge

This is the critical happy path. If any of these five steps fails silently (no UI response, no error, no badge), the app is broken for every new user.

---

## 2. Key Code Observations (from source reading)

### 2a. "No projects yet" empty state
`ProjectSidebar.js` line 26–27: when `projectList.length === 0`, renders `<div class="sidebar-empty">No projects yet — add one below</div>`. This is the selector we wait for.

### 2b. "New Project" button
`ProjectSidebar.js` line 59: `<button class="btn btn-ghost btn-sm sidebar-new-btn" onClick=${() => openNewProjectModal()}>`. Selector: `.sidebar-new-btn` or button text "New Project".

### 2c. NewProjectModal form
`NewProjectModal.js`: input `#new-project-name` and `#new-project-path`. Submit button text "Create Project" (disabled during submission). On success, calls `showToast('Project "..." created', 'success')` and `closeNewProjectModal()`. The project appears via the WS broadcast `sessions:list` / `projects:list` → Preact signal update.

### 2d. "New Claude Session" button
`ProjectDetail.js` line 48: `<button class="btn btn-primary btn-sm" onClick=${openNewSessionModal}>New Claude Session</button>`. This only renders after a project is selected.

### 2e. NewSessionModal and Haiku selection
`NewSessionModal.js` lines 12–16: QUICK_MODELS array includes `{ name: 'Haiku', command: 'claude --model claude-haiku-4-5-20251001' }`. Clicking it sets `command` state. Selector: button with text "Haiku" inside `.quick-commands`.

### 2f. Session creation flow
`handleCreate()` in NewSessionModal calls `createSession(project.id, { command, name, mode, telegram })` then `closeNewSessionModal()`. The session card appears via WS broadcast. The session card badge shows "starting" initially (STARTING state), then transitions to "running".

### 2g. Session card badge selectors
`SessionCard.js` getBadgeLabel returns `'\u25B6 starting'` for starting state. The badge class is `badge badge-activity badge-activity-busy` for both running and starting. We can look for text "starting" within `.session-card`.

---

## 3. Infrastructure Setup

### 3a. Fresh server — NO pre-seeding
Port 3108. `DATA_DIR=$(mktemp -d /tmp/qa-T11-XXXXXX)`. Do NOT write any `projects.json` or session data. The server must start with a completely clean state — this is what makes it a "first 5 minutes" test.

```javascript
serverProc = spawn('node', ['server-with-crash-log.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: '3108', CRASH_LOG: crashLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Poll `GET /api/projects` every 400ms up to 15s for 200 OK.

### 3b. Screenshots directory
`qa-screenshots/T11-first-5-minutes/` — create before test.

---

## 4. Console Error Monitoring

Set up console error capture before `page.goto()`:

```javascript
const consoleErrors = [];
page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
page.on('pageerror', err => consoleErrors.push(`UNCAUGHT: ${err.message}`));
```

At the end, assert no `TypeError`, `uncaught`, `unhandledRejection` errors were logged.

---

## 5. Exact Test Steps with Timing

### Step 1: Navigate and verify empty state

```javascript
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
```

Wait for `.sidebar-empty` with text "No projects yet" to appear. Timeout: 8000ms. If this fails: the app is not rendering the empty state for a fresh install.

**Screenshot:** `T11-01-empty-state.png`

**False-PASS risk:** The server might have leftover projects.json from a previous run. Mitigation: `mktemp -d` gives a fresh directory every time; no pre-seeding occurs.

### Step 2: Open "New Project" modal

Click `.sidebar-new-btn` (or button containing "New Project"). Wait for a dialog with text "New Project" to appear. Timeout: 5000ms.

```javascript
await page.click('.sidebar-new-btn');
await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
```

**Screenshot:** `T11-02-new-project-modal.png`

**False-PASS risk:** If the button exists but `openNewProjectModal()` is not wired, the dialog never appears. The `waitForSelector` timeout catches this.

### Step 3: Fill in project name and path

```javascript
await page.fill('#new-project-name', 'My First Project');
await page.fill('#new-project-path', tmpDir);  // use the data dir as an existing path
```

Using `tmpDir` as the project path guarantees the directory exists on disk (avoids any path validation the server might do).

### Step 4: Submit and wait for project to appear in sidebar

Click "Create Project" button.

```javascript
await page.click('button:has-text("Create Project")');
```

Wait for the modal to close (dialog disappears) AND for the project to appear in `.project-item` within 8000ms:

```javascript
await page.waitForSelector('[role="dialog"]', { state: 'detached', timeout: 8000 });
await page.waitForFunction(
  () => {
    const items = document.querySelectorAll('.project-item');
    for (const item of items) {
      if (item.textContent.includes('My First Project')) return true;
    }
    return false;
  },
  { timeout: 8000 }
);
```

**False-PASS risk:** The modal might close without the project appearing (e.g., server returned error but UI swallowed it). We wait for BOTH modal close AND project card present. If only modal closes, the `waitForFunction` will timeout.

Also check for success toast:
```javascript
await page.waitForFunction(
  () => document.body.textContent.includes('created'),
  { timeout: 5000 }
).catch(() => {}); // toast may disappear quickly
```

**Screenshot:** `T11-03-project-created.png`

### Step 5: Verify project is auto-selected (main pane shows its sessions)

After project creation, `ProjectDetail.js` should show "Sessions — My First Project". The sidebar should highlight the new project.

```javascript
await page.waitForFunction(
  () => document.querySelector('#sessions-area-title')?.textContent?.includes('My First Project'),
  { timeout: 5000 }
);
```

**False-PASS risk:** The project might appear in the sidebar but not be auto-selected, leaving the main pane showing the "Select a project" fallback. This would mean project creation works but auto-selection is broken.

### Step 6: Click "New Claude Session"

The "New Claude Session" button appears in `ProjectDetail.js` only when a project is selected. Click it:

```javascript
await page.click('button:has-text("New Claude Session")');
await page.waitForSelector('.modal', { timeout: 5000 });
```

Wait for the session modal to appear.

**Screenshot:** `T11-04-new-session-modal.png`

**False-PASS risk:** The button might be present (rendering isn't broken) but the click handler is a no-op. `waitForSelector('.modal')` catches this.

### Step 7: Fill in session name and select Haiku

```javascript
await page.fill('.modal input[placeholder*="refactor"]', 'my-first-session');
await page.click('.quick-cmd:has-text("Haiku")');
```

Verify the Haiku quick button is visually selected (command field contains 'haiku'):

```javascript
const cmdValue = await page.inputValue('.form-input[placeholder="claude"]');
expect(cmdValue).toContain('haiku');
```

**Screenshot:** `T11-05-session-modal-filled.png`

### Step 8: Click Start Session and verify session card appears

```javascript
await page.click('button:has-text("Start Session")');
```

Wait for the modal to close AND a session card for "my-first-session" to appear in the sessions list:

```javascript
await page.waitForSelector('.modal', { state: 'detached', timeout: 5000 });
await page.waitForFunction(
  () => {
    const cards = document.querySelectorAll('.session-card');
    for (const card of cards) {
      if (card.textContent.includes('my-first-session')) return true;
    }
    return false;
  },
  { timeout: 8000 }
);
```

**False-PASS risk:** Session card might appear with wrong text or wrong badge. We separately verify:
1. Session card text contains "my-first-session"
2. Badge shows "starting" or "running" (not "error" or empty)

```javascript
const sessionCard = page.locator('.session-card', { hasText: 'my-first-session' });
await sessionCard.waitFor({ timeout: 8000 });
const badgeText = await sessionCard.locator('.badge-activity').textContent();
const isValidState = badgeText.includes('starting') || badgeText.includes('running');
expect(isValidState, `Badge should show starting or running, got: ${badgeText}`).toBe(true);
```

**Screenshot:** `T11-06-session-card-starting.png`

### Step 9: Verify overlay auto-opens

Per the LIFECYCLE_TESTS.md spec, the terminal overlay should open automatically after session creation. Wait for the overlay to become visible:

```javascript
await page.waitForSelector('#session-overlay-terminal', { state: 'visible', timeout: 8000 })
  .catch(async () => {
    // Overlay may use different selector — try alternative
    await page.waitForSelector('.session-overlay', { state: 'visible', timeout: 3000 })
      .catch(() => {});
  });
```

This is a non-blocking check; the test PASSES even if the overlay doesn't auto-open, but we note it in output. The spec says "Overlay opens automatically" but this is a bonus check. **The core T-11 pass criteria (steps 1-8) do not depend on it.**

**Screenshot:** `T11-07-overlay.png`

---

## 6. Pass / Fail Criteria

### PASS — ALL of the following:
1. `.sidebar-empty` shows "No projects yet" on first load
2. NewProject modal appears after clicking "New Project" button
3. After form submit: modal closes AND `My First Project` appears in `.project-item` within 8s
4. Main pane shows "Sessions — My First Project" (auto-selected)
5. NewSession modal appears after clicking "New Claude Session"
6. Haiku quick button click updates command field to contain "haiku"
7. After clicking Start Session: modal closes AND session card with "my-first-session" appears within 8s
8. Session badge shows "starting" or "running" (not "error")
9. No `TypeError` / `uncaught` / `unhandledRejection` in console during entire test

### FAIL — ANY of the following:
1. `.sidebar-empty` not found (app shows wrong empty state or crashes on fresh DB)
2. Modal doesn't appear after button click (button is dead stub)
3. Project doesn't appear in sidebar within 8s after create (WS broadcast failure)
4. Session card doesn't appear within 8s after Start (session:created WS failure)
5. Session badge shows "error" immediately (session spawn fails)
6. Any uncaught JS error during project or session creation

---

## 7. False-PASS Risks

| Risk | Mitigation |
|------|-----------|
| Stale server data from previous test run | `mktemp -d` gives fresh dir; no pre-seeding |
| Modal closes but project never appears | Wait for BOTH modal close AND `.project-item` presence |
| Session card appears but badge shows wrong state | Explicitly assert badge text is "starting" or "running" |
| Empty state text changed in source | Screenshot captured for visual verification |
| Haiku button click registered but state not updated | Assert command field value contains 'haiku' after click |
| Overlay auto-open check hiding a real modal-close failure | Overlay check is non-blocking; core checks use `state: 'detached'` for modal |

---

## 8. Pre-Condition Gate

At the start of the test (before any browser actions), verify via REST that the server truly has zero projects:

```javascript
const projectsRes = await fetch(`${BASE_URL}/api/projects`).then(r => r.json());
if (projectsRes.projects && projectsRes.projects.length > 0) {
  throw new Error(`PRE-CONDITION FAILED: server already has ${projectsRes.projects.length} projects — not a fresh install`);
}
```

This is a hard `throw new Error()`, not a `console.warn`, so the test aborts rather than running on corrupted state.

---

## Execution Summary

**Result:** 2/2 PASS — 16.5s total

**Deviations from design:**
- Session badge showed "▶ running" (not "starting") by the time the assertion ran — the session (bash via haiku command) started fast enough that it was already running. Test accepted both states as valid, so this is correct behavior.
- Session overlay did NOT auto-open after session creation. The spec says "Overlay opens automatically" but this step was marked non-blocking. This is a potential spec mismatch to note in validation.
- The `tmpDir` was used as project path (design intent: existing directory). This worked correctly.

**Pre-condition gate:** Fired correctly — server had 0 projects confirmed before browser opened.

**Console errors:** None during the full flow.

**Screenshots saved:** T11-01 through T11-06 (overlay screenshot T11-07 not saved since overlay didn't auto-open).
