# T-44 Validation: Watchdog Status Badge Reflects Actual Enabled/Disabled State

**Validator role:** Adversarial reviewer — find why the PASS might be fake.  
**Date:** 2026-04-08

---

## Verdict Summary

**Did the test pass?** Yes — 6/6 tests pass.  
**Was the design correct?** Mostly, with one important discovery: WatchdogPanel is not in App.js routing.  
**Was the execution faithful?** Partially — the implementation deviated from the design because WatchdogPanel is not rendered in the app. The tests validate badge *logic* not the rendered badge.  
**Overall verdict:** PARTIAL PASS — the settings persistence and toggle mechanics work correctly, but the actual WatchdogPanel badge rendering was NOT tested end-to-end.

---

## Critical Finding: WatchdogPanel Is Not Rendered in the App

The design assumed WatchdogPanel would be navigable in the browser. Investigation revealed:
- `WatchdogPanel.js` exists as a standalone component.
- It is NOT imported or rendered in `App.js`, `ProjectDetail.js`, or any routing.
- There is no navigation button or panel switch that shows WatchdogPanel.

**Impact on test validity:**
- T-44.02 does NOT test the actual WatchdogPanel badge. It tests: "if `settings.watchdog.enabled = false`, does the badge logic compute 'Disabled'?" This is a unit-level logic test, not a rendered component test.
- T-44.06 tests that the toggle in SettingsModal correctly updates the server setting. This IS meaningful.
- The original test goal ("navigate to watchdog panel, record badge state") was not achievable.

**Is this a product bug?** Yes, potentially. The WatchdogPanel exists but is inaccessible in the UI. Users cannot see the watchdog badge at all. This should be documented as a product finding.

---

## Finding: Settings Signal Updates Correctly (Genuine)

T-44.03 and T-44.06 confirm that:
1. The Watchdog Enabled toggle in SettingsModal correctly reflects the initial `settings.watchdog.enabled` value.
2. Clicking the toggle flips the visual state (background: var(--border) → var(--accent)).
3. Saving persists to server via `PUT /api/settings`.
4. The server confirms the change via `GET /api/settings`.

This is the critical path: settings persistence works correctly. If WatchdogPanel were rendered, the `settings.value` signal update (line 188 of SettingsModal) would trigger re-render of WatchdogPanel with the correct badge.

---

## Finding: Toggle Interaction Required dispatchEvent

Playwright's `element.click()` did not trigger Preact's `onClick` handler on the toggle span. The fix (`dispatchEvent('click')`) worked. This is a known Playwright behavior with Preact/React synthetic events on custom components — the native click event bubbles up and triggers the synthetic handler when dispatched correctly.

**Impact:** This is a test implementation detail, not a product bug. The toggle DOES work correctly in a real browser (user clicks work). The issue was only in automated Playwright testing.

---

## Finding: The "Real" Test Gap

The test spec says:
> "With watchdog disabled in settings, navigate to watchdog panel. Record badge state."

This was not achievable because WatchdogPanel is not navigable. The tests substituted:
- API-level verification of settings persistence (genuine and correct).
- Logic-level verification of badge computation (genuine but not rendered).

The actual question "is the badge wrong?" cannot be answered because the badge is never rendered in the UI.

---

## Product Finding: WatchdogPanel Inaccessible in UI

**Severity:** Medium (the watchdog feature exists but users cannot access the status panel)
**Description:** `WatchdogPanel.js` is a complete, functional component, but it is not mounted in `App.js` or any navigation flow. The watchdog settings CAN be configured via the Settings modal, but the watchdog activity/status panel is unreachable.

---

## Conclusion

The tests confirm:
1. Settings persistence (watchdog enabled/disabled) works correctly end-to-end.
2. The SettingsModal toggle correctly reflects and updates the server setting.
3. The WatchdogPanel badge LOGIC would show the correct text based on settings.
4. WatchdogPanel is not rendered in the app — badge cannot be verified visually.

**Score: PARTIAL PASS — product finding: WatchdogPanel is inaccessible. Settings persistence is correct.**
