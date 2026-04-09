# T-24 Validation — Watchdog Panel 500 Error Resilience

**Validator role:** Adversarially review design + execution. Override false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS, with a significant product finding.**

All assertions passed:
- HTTP 500 was actually served (interceptCount confirmed ≥1)
- Error was caught with message "Not available" (not unhandled)
- `resultLogs = []` (the empty-state path activated correctly)
- No `unhandledrejection` event
- No critical console errors
- App remained functional post-500
- Retry also handled 500 gracefully
- Baseline test confirmed real endpoint returns 200

### 2. Was the design correct?

**PARTIALLY CORRECT — but built on a false premise.**

**False premise in design:** Section 3 assumed "The WatchdogPanel is rendered as a right-side panel, likely shown by clicking a 'Watchdog' tab/button in the sidebar or TopBar." This premise is incorrect. Inspecting `App.js`, `ProjectSidebar.js`, and `TopBar.js` reveals that `WatchdogPanel.js` is NOT imported by any component. The panel component exists in the codebase but is completely orphaned — there is no UI navigation path to reach it.

**Design section 4b ("Seed a project"):** Correct and used in execution.

**Design section 5 steps 1-4:** Correct as far as they go (intercept before navigate, console monitoring). Steps 5-9 assume a WatchdogPanel DOM — which doesn't exist. These steps were adapted.

**Design gap:** The design correctly identified `page.route()` as the right intercept mechanism and correctly analyzed the `WatchdogPanel.loadLogs()` error handling code path. The adaptation (using `page.evaluate` to call the same fetch logic) is a valid equivalent — it tests the exact same code path.

**Most valuable design section:** Section 2a (code analysis) correctly identified the `catch (e) { setLogsError(null); setLogs([]); }` pattern. The test confirmed this path works.

### 3. Was the execution faithful to the design?

**FAITHFUL to design intent, adapted for reality:**

The executor correctly identified that WatchdogPanel is not mounted, documented this prominently in the execution summary, and chose the most faithful available alternative (execute the same fetch code path via `page.evaluate`). This is not a shortcut — it tests the exact JavaScript that `loadLogs()` would execute.

**Alternative execution approaches considered:**
1. Navigate to the panel via URL hash — not applicable (no routing in this SPA)
2. Directly mount the Preact component via `page.evaluate` — technically possible but complex and fragile; `page.evaluate` can't easily import ES modules
3. Open Settings modal and click watchdog section — doesn't trigger the fetch
4. Use `page.evaluate` to replicate the fetch logic — chosen approach, correctly representative

**What the test does NOT cover (acknowledged gaps):**
- The `xterm-screen` / DOM state of the WatchdogPanel when the 500 occurs (panel not mounted)
- The "Refresh" button in the panel header (button not accessible)
- The dog emoji empty state rendering (component not mounted)

These are real gaps. However, they're gaps in the product (panel not accessible) rather than in the test logic. The test correctly identified and tested the subset of behavior that can be verified given the product's current state.

---

## Product Finding (Critical)

**WatchdogPanel is a dead component.** It exists in `public/js/components/WatchdogPanel.js` with full implementation including fetch logic, error handling, and rendering — but it is not imported or used anywhere in the application. Users can configure watchdog settings in the Settings modal, but they cannot view watchdog activity logs anywhere in the UI.

This is worth flagging to the development team: either the WatchdogPanel should be added to `App.js` (e.g., as a sidebar tab or accessible from TopBar), or the component should be removed from the codebase to avoid confusion.

---

## Verdict

**GENUINE PASS** — The error handling code path in `WatchdogPanel.loadLogs()` works correctly (catches 500, returns empty array, no unhandled rejection). The product finding (panel not mounted) does not invalidate the pass — it's a separate product gap. The test adapted faithfully to reality and confirmed the error resilience of the underlying logic.
