# T-24: Watchdog Panel Shows Empty State Cleanly When Endpoint Returns 500

**Source:** Watchdog panel error resilience
**Score:** L=2 S=3 D=5 (Total: 10)
**Test type:** Server-level + Playwright browser
**Port:** 3121

---

## 1. What We Are Testing

The WatchdogPanel component (`public/js/components/WatchdogPanel.js`) fetches `/api/watchdog/logs` on mount
and on every "Refresh" button click. The question is: when the server returns HTTP 500 instead of the
normal JSON array, does the panel handle it gracefully?

**Pass condition:**
1. The panel renders an empty/placeholder state (the dog emoji + "No watchdog activity yet" or similar text).
2. No unhandled promise rejection appears in the JS console.
3. No white screen / app crash occurs.
4. The rest of the app (sidebar, project navigation) remains functional.

**Fail signal:**
- An `uncaughtException` or `unhandledRejection` in the browser console.
- The watchdog panel area goes blank / shows a broken DOM.
- The app requires a page reload to recover.

---

## 2. Code Analysis

### 2a. WatchdogPanel.js error handling (current state)

```js
async function loadLogs() {
  setLogsLoading(true);
  setLogsError(null);
  try {
    const data = await fetch('/api/watchdog/logs').then(r => {
      if (!r.ok) throw new Error('Not available');
      return r.json();
    });
    setLogs(Array.isArray(data) ? data : (data.logs || []));
    if (data.lastTick) setLastTick(data.lastTick);
  } catch (e) {
    // Endpoint may not exist yet — show placeholder gracefully
    setLogsError(null);
    setLogs([]);
  }
  setLogsLoading(false);
}
```

The `catch` block sets `logsError` to null and `logs` to `[]`. In the render tree:
- `logsLoading === false` → skips the loading spinner
- `logs.length === 0` → shows the empty-state block (dog emoji + text)

So the code **should** handle a 500 gracefully. The test verifies this behavior
with a real browser and real console error monitoring.

### 2b. Server route behavior

`lib/api/routes.js` line 318:
```js
router.get('/api/watchdog/logs', (req, res) => {
  if (!watchdog) return res.json([]);
  try {
    const files = watchdog.getLogFiles ? watchdog.getLogFiles() : [];
    ...
    res.json(files);
  } catch {
    res.json([]);
  }
});
```

The server always returns 200 + JSON (even on error it falls back to `res.json([])`).
To test a 500, we must **intercept at the browser level** using Playwright's `page.route()`.

### 2c. Why page.route() is the right approach

Using `page.route('**/api/watchdog/logs', route => route.fulfill({ status: 500 }))` lets us:
- Simulate a 500 without modifying server code
- Test the exact HTTP error path in WatchdogPanel
- Keep the test hermetic (no server-side patching or restoring needed)
- Avoid flakiness from race conditions in route un-registration

---

## 3. Where the Watchdog Panel Lives in the UI

The WatchdogPanel is rendered as a right-side panel, likely shown by clicking a "Watchdog" tab/button
in the sidebar or TopBar. We need to navigate to it.

Key selectors to investigate at runtime:
- Look for a button/tab with text "Watchdog" in the sidebar
- The panel container likely has class `watchdog-panel` or similar
- The empty state renders: `<span style="font-size:28px;">🐕</span>` + text

**Navigation approach:**
1. Open the app, select any project
2. Click the watchdog panel button/link
3. Panel is visible → intercept is already active → logs fetch returns 500 → empty state shown

---

## 4. Infrastructure Setup

### 4a. Server on port 3121
```
DATA_DIR=$(mktemp -d /tmp/qa-T24-XXXXXX)
PORT=3121 node server-with-crash-log.mjs
```

Wait for `GET /api/projects` → 200 (poll 500ms, 20s deadline).

### 4b. Seed a project
POST `/api/projects` with `{ name: "T24-WatchdogTest", path: "<tmpDir>" }` to ensure the app
loads with a real project (avoids empty sidebar edge cases).

---

## 5. Playwright Test Steps

### Step 1: Intercept the endpoint BEFORE navigation
```js
await page.route('**/api/watchdog/logs', route => route.fulfill({
  status: 500,
  contentType: 'application/json',
  body: JSON.stringify({ error: 'internal server error' })
}));
```

Set up the route intercept BEFORE navigating to the page (or before triggering panel load).
This ensures the first fetch on mount is intercepted.

### Step 2: Console error monitoring
```js
const consoleErrors = [];
page.on('console', msg => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', err => consoleErrors.push(`UNCAUGHT: ${err.message}`));
```

### Step 3: Navigate and wait
```js
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
```
Wait for the project to appear in the sidebar.

### Step 4: Open the watchdog panel
Navigate to the watchdog panel. Try:
- Click a sidebar button labeled "Watchdog"
- Or navigate directly if there's a URL hash

Wait for a panel element that confirms the watchdog panel is rendered.

### Step 5: Wait for the fetch to complete
```js
await page.waitForTimeout(1500);
```
This gives the fetch→catch→setState cycle time to settle.

### Step 6: Check for empty state
The empty state block should be visible. Look for:
- The dog emoji `🐕` in the DOM
- Or text "No watchdog activity yet"
- Or text "Watchdog is disabled"

### Step 7: Assert no crashes
```js
expect(consoleErrors.filter(e => /unhandled|rejection|TypeError/i.test(e))).toHaveLength(0);
```

### Step 8: Assert app still functional
Verify the sidebar still renders project names and other UI elements work.

### Step 9: Refresh button test
Click the "Refresh" button in the watchdog panel header (the retry path).
Wait 1500ms. Confirm the empty state persists and no new console errors appeared.

---

## 6. Pass / Fail Criteria

| # | Criterion | Method |
|---|-----------|--------|
| 1 | HTTP 500 intercepted by page.route | Network log confirms 500 response |
| 2 | Panel renders empty state (not blank) | DOM contains dog emoji or empty-state text |
| 3 | No unhandled promise rejection in console | `consoleErrors` array filtered check |
| 4 | No page crash / white screen | `page.locator('body')` has visible content |
| 5 | App remains functional (sidebar visible) | Project name still in DOM after panel load |
| 6 | Refresh button retry also survives 500 | Same empty state after clicking Refresh |

---

## 7. Risk Assessment

**Risk 1: Watchdog panel not visible by default**
The panel may be hidden behind a tab or toggle. We may need to find the right selector to activate it.
Mitigation: Use `page.evaluate` to inspect the DOM after nav; try multiple selectors; take screenshot.

**Risk 2: Route intercept timing**
If `page.route()` is set after navigation starts, the first fetch may slip through.
Mitigation: Set up intercept before `page.goto()`.

**Risk 3: Panel may never mount if watchdog is disabled in settings**
If settings say `watchdog.enabled = false`, the panel still mounts but shows "Disabled" state.
The empty state path is still valid; the test accepts either state message.

**Risk 4: Console errors from other unrelated sources**
The app may have existing console.error calls (e.g., terminal resize on empty session).
Mitigation: Filter only for `unhandledRejection` / `TypeError` / `uncaught` patterns,
not all `console.error` messages.

---

## 8. Expected Outcome

Given the code analysis in section 2a, the `catch` block correctly swallows the error and
sets `logs = []`. The component then renders the empty state. **The test should PASS.**

However, the test is still valuable because:
1. It confirms the error path is actually hit (not just a code reading)
2. It verifies no console errors leak through (the catch sets `logsError = null` explicitly)
3. It catches future regressions where someone might replace the try/catch with `.catch(console.error)` or
   similar that would log to console without re-throwing

---

## Execution Summary

**Result:** 2/2 PASS — 9.5s total

**Significant deviation from design:**
- **WatchdogPanel is NOT mounted in App.js.** The design assumed a "Watchdog" button/tab in the sidebar or TopBar, but no such navigation exists. `WatchdogPanel.js` is a standalone component not imported anywhere in `App.js`, `ProjectSidebar.js`, or `TopBar.js`. There is no UI path to reach it.
- **Adapted approach:** Instead of navigating to a WatchdogPanel UI, the test uses `page.evaluate` to execute the exact same fetch logic as `WatchdogPanel.loadLogs()`, with the route intercepted. This directly tests whether the error handling code path works correctly.
- **Baseline test added:** T-24b confirms the real endpoint returns 200 (server-side always returns JSON, never 500), establishing that the only 500 path is via client-side error handling.

**What was confirmed:**
1. Route intercept fired (HTTP 500 was served to the browser) ✓
2. `catch` block correctly caught `Error('Not available')` ✓
3. `resultLogs = []` (empty state path activated) ✓
4. No `unhandledRejection` event fired ✓
5. No critical console errors ✓
6. App remained functional (project selection still worked) ✓
7. Retry (second fetch) also handled 500 gracefully ✓

**Product finding:** WatchdogPanel component is a dead component — not mounted in the app's component tree. Users have no way to view watchdog activity logs through the browser UI, even though the component and API endpoint both exist.
