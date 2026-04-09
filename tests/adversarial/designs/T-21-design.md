# T-21 Design: Low Credit Mode — new sessions use lcModel command

**Designed by:** Opus (design phase)
**Date:** 2026-04-08
**Score:** L=3 S=4 D=4 (Total: 11)

---

## Test Objective

Verify that when Low Credit Mode is enabled AND active, the New Session modal:
1. Pre-fills the command field with the low-credit model command (Haiku)
2. Shows a visible "LOW CREDIT MODE ACTIVE" warning badge in orange/warning color

---

## Code Archaeology

### SettingsModal.js — How settings are saved

From `public/js/components/SettingsModal.js`:

- `buildCommandPreview({ model, thinking, flags, lcEnabled, lcActive, lcModel, lcThinking, lcFlags })`:
  - Line 13: `const useLowCredit = lcEnabled && lcActive`
  - When `useLowCredit`, uses `lcModel`, `lcThinking`, `lcFlags` instead of session defaults
  - `MODEL_IDS.haiku = 'claude-haiku-4-5-20251001'`
  - So if `lcModel='haiku'`, preview becomes `claude --model claude-haiku-4-5-20251001`

- `handleSave()` (line 149–195): POSTs to `/api/settings` with shape:
  ```json
  {
    "lowCredit": {
      "enabled": true,
      "active": true,
      "defaultModel": "haiku",
      "extendedThinking": false,
      "defaultFlags": ""
    }
  }
  ```
  Then sets `settings.value = data` from server response.

- The modal has three separate toggles for Low Credit Mode:
  1. "Enable Low Credit Mode" → `lcEnabled`
  2. "Activate Now" → `lcActive`
  3. "Low Credit Model" select → `lcModel` (default: 'haiku')

### NewSessionModal.js — How the command is built

From `public/js/components/NewSessionModal.js`:

- `buildDefaultCommand(s)` (line 19–33):
  - `const useLowCredit = lc && lc.enabled && lc.active`
  - If `useLowCredit`, uses `lc.defaultModel` (not `session.defaultModel`)
  - `MODEL_IDS.haiku = 'claude-haiku-4-5-20251001'`
  - Result: `claude --model claude-haiku-4-5-20251001`

- `isLowCredit` (line 45): `s && s.lowCredit && s.lowCredit.enabled && s.lowCredit.active`

- Warning badge (lines 135–139):
  ```html
  <div style="font-size:11px;font-weight:700;color:var(--warning);padding:4px 8px;background:rgba(232,160,32,0.1);border-radius:var(--radius-sm);margin-bottom:8px;display:inline-block;">
    LOW CREDIT MODE ACTIVE
  </div>
  ```
  Uses `color:var(--warning)` — orange/warning color.

- useEffect (line 57–72): On modal open, re-reads `settings.value` and calls `buildDefaultCommand(s2)`.
  **Critical:** The command is reset on every modal open from the live settings signal. So if settings were saved before opening the modal, the command will reflect the saved settings.

### store.js — Settings signal

- `settings` is a Preact signal, initialized as `{}`.
- `settings.value` is updated in `SettingsModal.handleSave()` after successful API save.
- `NewSessionModal` reads `settings.value` directly on render AND in the useEffect.

---

## Test Flow Design

### Pre-conditions

- App running on port 3118
- At least one project exists (seed via ProjectStore)
- Settings API (`PUT /api/settings`) must respond correctly

### Step-by-step Flow

1. Navigate to `http://localhost:3118` (waitUntil: 'domcontentloaded')
2. Seed a project (POST `/api/projects`) so we have something to select
3. Select the project in the sidebar
4. Open Settings modal (click gear/settings button)
5. Wait for modal to appear
6. Enable "Low Credit Mode" toggle (lcEnabled)
7. Enable "Activate Now" toggle (lcActive)
8. Verify "Low Credit Model" select shows "Haiku" (it defaults to haiku — verify or set it)
9. Click "Save Settings"
10. Wait for success toast / modal to close
11. Open "New Session" modal (click "+ New Session" or equivalent button)
12. Wait for modal to appear

### Assertions

**A1:** Command field value contains `claude-haiku-4-5-20251001`
- Selector: `input.form-input` with `font-family: var(--font-mono)` (the command input)
- Or use placeholder "claude" to identify it
- Value must include `claude --model claude-haiku-4-5-20251001`

**A2:** "LOW CREDIT MODE ACTIVE" badge is visible
- Text content: `LOW CREDIT MODE ACTIVE`
- Color: `var(--warning)` (orange — approximately `rgb(232, 160, 32)` or similar)
- Must be visible (not hidden, opacity > 0)

**A3:** Warning badge has orange/warning styling
- Element has `color` using CSS variable `--warning`
- Or inline style contains `var(--warning)`

---

## Failure Modes & False-Pass Risks

### Risk 1: Settings not persisted before modal opens
**Mitigation:** Wait for toast "Settings saved" to appear after clicking Save, before opening New Session modal.

### Risk 2: useEffect doesn't re-fire if modal was already open
**Mitigation:** Ensure New Session modal is fully closed when Settings modal is open. The useEffect depends on `newSessionModalOpen.value` changing.

### Risk 3: Command input identified by wrong selector
**Mitigation:** The command input has `font-family: var(--font-mono)` in its inline style. Can also locate by placeholder "claude". Alternatively, find input within the form group that has label text "Command".

### Risk 4: `settings.value` not updated before modal opens
**Mitigation:** The `handleSave` sets `settings.value = data` synchronously after API success. The New Session modal reads `settings.value` in its useEffect triggered on open. The timing should be fine if we wait for modal close before opening New Session.

### Risk 5: Low Credit Model not set to Haiku
**Mitigation:** The default for `lc.defaultModel` in SettingsModal is 'haiku' (line 111). But we should explicitly verify/set it. The test should set the "Low Credit Model" select to "Haiku" explicitly.

### Risk 6: Badge rendered but not visible (display:none / opacity:0)
**Mitigation:** Use `isVisible()` assertion, not just textContent check.

---

## Key Selectors

Based on SettingsModal.js rendering:

- Settings button / gear icon: Look for a button that opens settings — probably in TopBar
- "Enable Low Credit Mode" toggle: Find toggle within row with label text "Enable Low Credit Mode"
  - The toggle uses `onClick` on the `.toggle-slider` span, not a regular checkbox change
  - Safer: click the `<span class="toggle-slider">` within the settings row
- "Activate Now" toggle: Same approach within "Activate Now" row
- "Low Credit Model" select: `<select>` within "Low Credit Model" row
- "Save Settings" button: `.btn-primary` with text "Save Settings"
- New Session button: Look for "+ New Session" or equivalent in project detail view
- Command input in New Session modal: `input` with `font-family: var(--font-mono)` and placeholder "claude"
- Warning badge: element with text "LOW CREDIT MODE ACTIVE"

---

## Expected Test Result

- **PASS**: Command shows `claude --model claude-haiku-4-5-20251001`, badge visible with orange color
- **FAIL signal**: Command still shows `claude --model claude-sonnet-4-6`, or badge absent

The feature is fully implemented in code (verified in code review above). The test should PASS provided the Settings API correctly saves and returns the settings with `lowCredit.enabled=true, lowCredit.active=true, lowCredit.defaultModel='haiku'`.

---

## Playwright Test Architecture

```
test('T-21: Low Credit Mode — new sessions use lcModel command', async ({ page }) => {
  // 1. Navigate
  // 2. Seed project via API
  // 3. Select project
  // 4. Open Settings → Enable LC → Activate → Save
  // 5. Wait for save confirmation
  // 6. Open New Session modal
  // 7. Assert command = haiku command
  // 8. Assert badge visible + orange
});
```

Use `--reporter=line` and `--timeout=120000` per pipeline spec.

---

## Execution Summary

**Run date:** 2026-04-08
**Result:** PASS (1/1)
**Time:** 10.7s

### Bug found and fixed
`GET /api/settings` and `PUT /api/settings` in `lib/api/routes.js` called async `settings.getAll()` and `settings.update()` without `await`. The route handlers returned Promises to `res.json()` instead of resolved values, causing the API to return a Promise object `{}` instead of actual settings. Fixed by making both handlers `async` and adding `await`.

### Assertion results
- A1: Command field = `claude --model claude-haiku-4-5-20251001` — PASS
- A2: "LOW CREDIT MODE ACTIVE" badge visible — PASS (found=true, visible=true, opacity=1)
- A3: Badge color = `rgb(232, 160, 32)` (`var(--warning)`) — PASS
- API verification: `lowCredit: { enabled: true, active: true, defaultModel: 'haiku', extendedThinking: false, defaultFlags: '' }` — PASS

### Flow confirmed working
Settings modal enables LC mode → saves correctly → New Session modal reads `settings.value` → pre-fills haiku command → displays warning badge in orange.
