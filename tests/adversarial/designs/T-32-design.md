# T-32 Design: Session List Empty State Message

**Score:** 10  
**Port:** 3129  
**Type:** Playwright browser test

---

## What We Are Testing

When a project exists but has no sessions, the main content pane must show the empty state message: `"No sessions — start one with the button above"`.

From source inspection of `ProjectDetail.js` (line 59):
```javascript
? html`<div class="sessions-empty">No sessions — start one with the button above</div>`
```

This is rendered when `sessions.length === 0` and a project is selected.

The empty state must appear:
1. Without any error
2. Without a loading spinner persisting indefinitely
3. Without a blank white area (the div must be in the DOM and visible)

---

## Infrastructure Setup

1. Create temp DATA_DIR with `mktemp -d /tmp/qa-T32-XXXXXX`
2. Seed `projects.json` with one project: `{ "projects": [{ id, name, path, createdAt }], "scratchpad": [] }`
3. Launch server on port 3129
4. Poll server ready
5. Open Chromium browser

---

## Exact Actions and Timing

### Step 1: Navigate to the app
- Go to `http://127.0.0.1:3129` with `waitUntil: 'domcontentloaded'`
- Wait for the sidebar to be visible (`.sidebar` or `#sidebar`)
- Wait for the project name to appear in sidebar (the seeded project)

### Step 2: Click the project
- Click the project name in the sidebar
- Wait up to 3s for `#sessions-area` to be visible OR `.sessions-empty` to appear

### Step 3: Verify empty state
- Assert `.sessions-empty` element exists in DOM
- Assert its text content matches "No sessions — start one with the button above"
- Assert no error elements visible (e.g. `.toast-error`, `.error-message`)
- Assert no loading spinner visible (e.g. `.spinner`, `.loading`)
- **PASS:** Empty state message visible, no errors, no infinite spinner
- **FAIL:** Empty state absent, blank, or spinner still showing

### Step 4: Verify "New Claude Session" button is present
- Assert `button` with text "New Claude Session" is visible (from `ProjectDetail.js` area-header)
- This confirms the full project detail view loaded correctly

---

## Pass/Fail Criteria

| Outcome | Condition |
|---------|-----------|
| GENUINE PASS | `.sessions-empty` visible with correct text; no error; no spinner |
| GENUINE FAIL | `.sessions-empty` not found; or text is wrong; or error displayed |
| INCONCLUSIVE | Project not selected, sidebar not found, or page crashed |

---

## False-PASS Risks

1. **Project not selected:** If the project was never clicked (click missed, sidebar not rendered), the main pane shows "Select a project" (the no-project view). The test must verify `.sessions-empty` specifically, NOT the no-project empty state.

2. **Sessions loaded asynchronously:** There might be a brief moment where the sessions list is loading. The test should wait for either `.sessions-empty` OR a session card to appear (with a timeout), then assert it's the empty state.

3. **Sessions.json has sessions from a previous test run leaking in:** The DATA_DIR is fresh temp dir — only the seeded project exists with zero sessions. No risk.

4. **WS connection not established:** The session list is delivered via WS. If WS fails to connect, the sessions list may never update from the default empty state. This could look like a pass. Check: verify the WS connection status indicator shows "Connected" before reading the empty state.

5. **Empty state in wrong element:** The no-project view also has an "empty state" div but with different content. Must use `.sessions-empty` selector specifically, not `.empty-state`.

---

## Implementation Notes for Executor

- Seeded project must have a valid `path` that exists on disk (create tmpDir/project and use that path)
- Sidebar item selector: look for the project name text — may be in `.sidebar-project` or similar class
- Wait for the connected status dot before clicking project: `page.waitForSelector('.status-dot.connected', { timeout: 10000 })`
- After clicking project, use `page.waitForSelector('.sessions-empty', { timeout: 5000 })`
- Read text content with `page.$eval('.sessions-empty', el => el.textContent.trim())`
- Hard throw if WS connection status shows disconnected after 10s
- This test is simple — avoid overcomplicating with WS assertions; just verify the UI renders correctly
