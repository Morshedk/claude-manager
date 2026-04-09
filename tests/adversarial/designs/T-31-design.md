# T-31 Design: Settings Cancel Discards Changes

**Score:** 10  
**Port:** 3128  
**Type:** Playwright browser test

---

## What We Are Testing

The Settings modal has a **Cancel** button that calls `closeSettingsModal()` — it does NOT call `handleSave()`. When the user opens Settings, changes the Default Model selector, then clicks Cancel, the change must be discarded.

From source inspection of `SettingsModal.js`:
- Local state (`sessModel`, etc.) is initialized from `settings.value` when the modal opens (via `useEffect` on `settingsModalOpen.value`)
- `handleSave()` calls `PUT /api/settings` and updates the signal
- Cancel button: `onClick=${closeSettingsModal}` — closes modal without saving
- On next open, `useEffect` re-runs and re-syncs from `settings.value` (unchanged since no PUT was made)

**The key implementation detail:** `useEffect` in Preact re-runs when `settingsModalOpen.value` changes. So when the modal re-opens after Cancel, it re-reads from `settings.value` which was NOT updated (since `handleSave` was not called). The local `sessModel` state resets to the persisted value.

**Additional assertion:** No `PUT /api/settings` network request should be made when Cancel is clicked.

---

## Infrastructure Setup

1. Create temp DATA_DIR with `mktemp -d /tmp/qa-T31-XXXXXX`
2. Seed `projects.json` as `{ "projects": [...], "scratchpad": [] }`
3. Launch server on port 3128
4. Poll server ready
5. Open Chromium browser, navigate with `waitUntil: 'domcontentloaded'`

---

## Exact Actions and Timing

### Step 1: Open Settings and record initial model
- Click the gear icon / Settings button in the top bar (`button[title="Settings"]`)
- Wait for modal to appear (`.modal-wide` or `h2` containing "Settings")
- Read the current value of the Default Model selector: `select.form-select` (first one in Session Defaults section, value = "sonnet" by default)
- Record as `modelBefore`

### Step 2: Change the model
- Select "opus" from the Default Model dropdown (the SessionDefaults one, first `select.form-select`)
- Verify the select now shows "opus"
- Do NOT click Save

### Step 3: Click Cancel
- Click the Cancel button: `button.btn.btn-ghost` with text "Cancel" (or `onClick=${closeSettingsModal}`)
- Wait for modal to disappear (`.modal-wide` to be hidden/removed)

### Step 4: Verify no PUT request was made
- Track network requests via Playwright `page.route()` or `page.on('request', ...)` to monitor `PUT /api/settings`
- Assert no PUT to `/api/settings` was made during Steps 1–3

### Step 5: Reopen Settings and verify model unchanged
- Click Settings button again
- Wait for modal to appear
- Read the Default Model selector value again
- Assert it equals `modelBefore` (i.e., "sonnet", not "opus")
- **PASS:** Model shows original value after Cancel + reopen
- **FAIL:** Model shows "opus" (change was erroneously persisted)

---

## Pass/Fail Criteria

| Outcome | Condition |
|---------|-----------|
| GENUINE PASS | Default Model shows original value on modal reopen; no PUT request was made |
| GENUINE FAIL | Default Model shows "opus" after Cancel; or PUT request was made |
| INCONCLUSIVE | Modal not found, selector not found, or initial state already "opus" |

---

## False-PASS Risks

1. **Modal re-syncs from settings.value:** If `settings.value` was somehow mutated client-side on Cancel (it shouldn't be — only `handleSave` updates it), the modal would show the wrong value but NO PUT would be made. This would be a client-side state corruption. The test must check both: no PUT AND correct model shown.

2. **Select value vs display text:** The select has `<option value="sonnet">Sonnet</option>` etc. The `value` attribute is what we compare — read with `page.$eval('select.form-select', el => el.value)`.

3. **Multiple selects:** There are multiple `select.form-select` elements (Session Default Model, Watchdog Model, Low Credit Model). Must target the FIRST one under Session Defaults. Use `page.$eval('.settings-section:first-of-type select.form-select', ...)` or more specifically find by position in DOM.

4. **Preact signal reactivity race:** After modal closes and reopens, the `useEffect` runs on `settingsModalOpen.value` change. There may be a brief moment where local state shows the changed value before the effect runs. Use `await page.waitForTimeout(200)` after modal opens before reading the value.

5. **Settings not loaded yet on initial open:** The `settings.value` signal is loaded from `GET /api/settings` on app boot. If the modal opens before settings load, `sess.defaultModel` falls back to `'sonnet'`. This is the correct default and is fine for the test.

---

## Network Request Monitoring

Use Playwright's `page.on('request', ...)` to monitor for PUT to `/api/settings`:

```javascript
const putRequests = [];
page.on('request', req => {
  if (req.method() === 'PUT' && req.url().includes('/api/settings')) {
    putRequests.push(req.url());
  }
});
// ... test actions ...
expect(putRequests.length).toBe(0); // no saves made
```

---

## Implementation Notes for Executor

- Selector for Settings button: `button[title="Settings"]`
- Selector for modal: `.modal-wide` or check `h2` text "Settings"
- First model select in Session Defaults: select within first `.settings-section`
- Cancel button: the `button.btn.btn-ghost` with text "Cancel" in modal footer
- Reopen Settings after cancel by clicking the button again
- Hard throw if modal is not found or settings section not found
- This is a pure UI test — no WS needed
