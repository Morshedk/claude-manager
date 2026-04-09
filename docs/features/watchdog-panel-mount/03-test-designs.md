# Test Designs: WatchdogPanel Mount

Port range: 3210–3217

## Test 1: WatchdogPanel Reachable via UI Click — No Console Errors
**File:** `tests/adversarial/feat-watchdog-panel-reach.test.js`
**Port:** 3210

**Setup:**
- Start server with isolated DATA_DIR, port 3210
- Seed one project via POST /api/projects
- Navigate to app, click the project in sidebar
- Collect console errors via `page.on('console')`

**Steps:**
1. Navigate to `http://127.0.0.1:3210`
2. Wait for `#sessions-area` to be visible
3. Assert: Watchdog tab button `#watchdog-tab-btn` is visible
4. Click `#watchdog-tab-btn`
5. Wait for `#watchdog-panel-container` to be visible
6. Assert: `#watchdog-panel-container` is in DOM and visible
7. Assert: No JS errors in console (filter for `error` level messages)
8. Assert: Page has no uncaught exceptions

**Pass criteria:** `#watchdog-panel-container` visible, zero console errors of type `error`.

---

## Test 2: WatchdogPanel Renders ENABLED/DISABLED Badge Correctly
**File:** `tests/adversarial/feat-watchdog-panel-badge.test.js`
**Port:** 3211

**Setup:**
- Two sub-tests: watchdog enabled vs disabled
- Control via `settings.json` file in DATA_DIR before server start

**Sub-test A — Disabled (default):**
1. Start server (no settings file → watchdog.enabled defaults to false/unset)
2. Navigate, click project, click Watchdog tab
3. Find the badge span inside `#watchdog-panel-container`
4. Assert badge text is "Disabled" (case-insensitive)

**Sub-test B — Enabled:**
1. Write `settings.json` with `{ "watchdog": { "enabled": true } }` to DATA_DIR
2. Start server
3. Navigate, click project, click Watchdog tab
4. Assert badge text is "Enabled"

**Pass criteria:** Badge text matches expected value for each configuration.

---

## Test 3: Panel Survives Browser Reload — Still Reachable
**File:** `tests/adversarial/feat-watchdog-panel-reload.test.js`
**Port:** 3212

**Setup:**
- Start server, seed project
- Navigate to app, select project, click Watchdog tab, verify it renders

**Steps:**
1. Navigate, select project, click Watchdog tab
2. Verify `#watchdog-panel-container` visible
3. `page.reload()` — wait for `domcontentloaded`
4. Select project again (tab state resets to 'sessions' after reload — expected)
5. Click `#watchdog-tab-btn` again
6. Assert `#watchdog-panel-container` is visible
7. Assert no console errors after reload

**Pass criteria:** WatchdogPanel reachable after full page reload with no errors.

---

## Test 4: Adversarial — Panel Handles /api/watchdog/logs 500 Gracefully
**File:** `tests/adversarial/feat-watchdog-panel-500.test.js`
**Port:** 3213

**Setup:**
- Start server normally
- Intercept `/api/watchdog/logs` via `page.route()` to return HTTP 500 with body `{"error":"Internal Server Error"}`

**Steps:**
1. Set up route intercept: `page.route('**/api/watchdog/logs', route => route.fulfill({ status: 500, body: '{"error":"Internal"}' }))`
2. Navigate, select project, click Watchdog tab
3. Wait for `#watchdog-panel-container`
4. Assert: No JS `error`-level console messages
5. Assert: Panel body still renders (container visible)
6. Assert: Panel shows empty state (dog emoji or "No watchdog activity" text)
7. Assert: "Refresh" button is present and clickable (panel not frozen)

**Pass criteria:** Panel renders in degraded-but-functional state, no crash, empty log shown.

---

## Test 5: Default Tab Is Sessions (Regression Guard)
**File:** `tests/adversarial/feat-watchdog-panel-default-tab.test.js`
**Port:** 3214

**Setup:**
- Start server, seed project with one session

**Steps:**
1. Navigate to app, select project
2. Assert `#project-sessions-list` is visible (Sessions tab is default)
3. Assert `#watchdog-panel-container` does NOT exist in DOM (or is hidden)
4. Assert "New Claude Session" button is visible
5. Click `#watchdog-tab-btn`
6. Assert `#watchdog-panel-container` is now visible
7. Assert `#project-sessions-list` is now gone from DOM (or hidden)
8. Assert "New Claude Session" button is NOT visible
9. Click Sessions tab button
10. Assert `#project-sessions-list` is visible again
11. Assert "New Claude Session" button is visible again

**Pass criteria:** Tab switching is clean — no ghost DOM elements, button visibility correct per tab.
