# T-44 Design: Watchdog Status Badge Reflects Actual Enabled/Disabled State

**Score:** 11  
**Test type:** Playwright browser  
**Port:** 3141  
**Date:** 2026-04-08

---

## 1. What This Test Covers

This test verifies that the WatchdogPanel's enabled/disabled badge correctly reflects the actual setting from the server. Specifically:
- When watchdog is disabled in settings, the badge shows "Disabled" in muted color.
- When watchdog is enabled in settings (via the Settings modal), the badge shows "Enabled" in green.
- The change is reflected without a full page reload (or if a reload is required, the badge shows the correct state after reload — it must NOT be silently wrong).

The failure mode is: badge always shows "Enabled" regardless of the actual `watchdog.enabled` setting value.

---

## 2. Source Analysis

### WatchdogPanel.js — Badge logic

```js
const s = settings.value || {};
const wdSettings = s.watchdog || {};
const enabled = wdSettings.enabled !== false;  // ← defaults to true if missing

const statusColor = enabled ? 'var(--accent)' : 'var(--text-muted)';

<span style=${`...background:${enabled ? 'rgba(0,200,100,0.12)' : 'var(--bg-raised)'};color:${statusColor};`}>
  ${enabled ? 'Enabled' : 'Disabled'}
</span>
```

**Key finding:** `enabled = wdSettings.enabled !== false` — the default is TRUE when `watchdog.enabled` is absent. This means:
- If settings are never saved, watchdog defaults to enabled.
- The badge shows "Enabled" or "Disabled" based on the in-memory `settings` signal.
- When `settings.value` updates (via the Settings modal save), Preact re-renders WatchdogPanel automatically.

**Risk 1:** If `settings.value` is not updated after save, the badge won't change without a reload. 
Looking at `SettingsModal.js` line 188: `settings.value = data || {};` — the signal IS updated after a successful save. So the WatchdogPanel should update in real-time without a reload.

**Risk 2:** The `settings` signal might not be populated initially. WatchdogPanel is only rendered when the user navigates to the watchdog view (not on initial app load). By the time the user navigates there, settings should have been fetched.

### How settings are loaded in the browser

From `state/store.js` (not yet read, but from actions.js pattern), settings are fetched on app startup. Let me reason from the SettingsModal: it reads `settings.value` — this signal must be populated by an initial fetch somewhere.

### SettingsModal.js — Save path

```js
const res = await fetch('/api/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(updates),
});
// ...
settings.value = data || {};  // ← signal updated
showToast('Settings saved', 'success');
closeSettingsModal();
```

The `settings.value` signal update triggers all components that read `settings.value` to re-render. Since WatchdogPanel reads `settings.value` at the top level (not in a hook), it will re-render whenever the signal changes.

### Server settings endpoint

`PUT /api/settings` saves to disk and returns the updated settings. `GET /api/settings` loads from disk. The `/api/settings` endpoint must persist the `watchdog.enabled` field correctly.

---

## 3. How to Navigate to WatchdogPanel

The WatchdogPanel is shown in the right panel. Looking at App.js structure, we need to determine how to navigate to the watchdog view. Based on TopBar.js, there's a Settings button but no explicit "Watchdog" nav button shown. Let me check what triggers WatchdogPanel to render.

Based on the existing WatchdogPanel.js, it's a panel in the sidebar or main content. The test must find the correct way to navigate to it. We'll check App.js for the routing logic.

If there's no direct navigation to WatchdogPanel, we can test the badge indirectly by:
1. Checking the badge text rendered anywhere the settings signal is used.
2. Or directly inspecting the settings value via API.

**Test approach:** 
- Use the Settings modal to save `watchdog.enabled = false`.
- Verify via `GET /api/settings` that the setting was persisted.
- Navigate to the Watchdog panel (find the correct nav mechanism).
- Assert badge shows "Disabled."
- Use Settings modal to save `watchdog.enabled = true`.
- Assert badge shows "Enabled."

---

## 4. Exact Test Steps

### Infrastructure Setup
1. Start server on port 3141, fresh DATA_DIR.
2. Seed `projects.json` with one project.
3. Seed `settings.json` with `{ watchdog: { enabled: false, ... } }` — start with watchdog disabled.

### Phase 1: Navigate to app, check Watchdog panel shows "Disabled"

1. Navigate to `http://127.0.0.1:3141` with `waitUntil: 'domcontentloaded'`.
2. Wait for app to connect (poll for `.project-item` or connection status).
3. Find the Watchdog panel navigation element and click it. (Must identify from App.js — likely a sidebar item or TopBar button.)
4. Wait for WatchdogPanel to render.
5. Assert badge text = "Disabled".
6. Assert badge color is muted (not green).

### Phase 2: Enable watchdog via Settings modal

1. Click Settings button in TopBar (gear icon button titled "Settings").
2. Wait for settings modal to open.
3. In the Watchdog section, find the "Enabled" toggle and enable it (ensure it shows as ON).
4. Click "Save Settings."
5. Wait for success toast "Settings saved."
6. Modal closes automatically.

### Phase 3: Navigate back to Watchdog panel, assert "Enabled"

1. Navigate back to the Watchdog panel.
2. Assert badge text = "Enabled."
3. Assert badge has green color (`rgba(0,200,100,0.12)` background).

### Phase 4: API-level confirmation

1. `GET /api/settings` must return `{ watchdog: { enabled: true, ... } }`.

### Phase 5: No-reload requirement check

The settings signal is updated in-memory on save, so WatchdogPanel should update without a reload. Verify this by checking the badge after save WITHOUT doing a page reload.

---

## 5. Pass/Fail Criteria

### PASS
- Badge shows "Disabled" when `watchdog.enabled: false` in settings (initial state).
- After enabling watchdog via Settings modal, badge shows "Enabled" — without reload.
- API confirms `watchdog.enabled: true` after save.

### FAIL
- Badge shows "Enabled" when `watchdog.enabled: false` in settings (frozen at default).
- Badge doesn't change after Settings save (signal not updated, or WatchdogPanel not re-reading signal).
- Requires full page reload to see the change (acceptable if documented — not silently wrong).

---

## 6. False-PASS Risks

### Risk 1: Settings not initialized with `watchdog.enabled: false`
If `settings.json` is absent, `wdSettings.enabled !== false` evaluates to `true` (default enabled). The badge shows "Enabled" from the start. The test starts with watchdog DISABLED in `settings.json` to avoid this.

### Risk 2: Watchdog panel navigation unknown
We may not find the correct way to navigate to WatchdogPanel from the source without reading App.js. We need to read App.js to find the navigation mechanism.
**Mitigation:** Read App.js before implementation.

### Risk 3: Badge change confirmed via text but color not verified
The test should check both text content AND background style to confirm the badge is in the correct visual state. Just checking "Disabled" text passes even if the color is wrong.

### Risk 4: WatchdogPanel renders initial "Enabled" before settings signal updates
If `settings.value` is initially empty (`{}`), then `wdSettings.enabled !== false` → true → badge shows "Enabled" for a brief moment. Then the settings signal updates and the badge changes to "Disabled."
**Mitigation:** Wait for the badge to show "Disabled" with a polling loop (timeout 5s) rather than asserting immediately after navigation.

---

## 7. Implementation Notes

- Must read App.js to understand how to navigate to the WatchdogPanel.
- The Settings modal toggle for watchdog enabled/disabled uses a click on the toggle slider (not a checkbox input). The selector is the `<span class="toggle-slider">` inside the settings row labeled "Enabled" within the Watchdog section.
- After clicking "Save Settings," wait for the toast with text "Settings saved" to appear (selector: text matching).
