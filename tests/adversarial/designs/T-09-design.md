# T-09: Settings Persist Across Browser Reload

**Source story:** Story 16  
**Score:** L=5 S=4 D=3 (Total: 12)  
**Test type:** Playwright browser  
**Port:** 3106

---

## 1. Architecture Analysis

### 1a. Settings persistence path (server side)

Settings are stored in `SettingsStore` (`lib/settings/SettingsStore.js`). On `PUT /api/settings`, the store calls `deepMerge()` on the in-memory object and then `writeFile()` to `$DATA_DIR/settings.json`. This means settings ARE persisted to disk after save.

### 1b. Settings loading path (client side)

**Critical finding:** `loadSettings()` is defined in `public/js/state/actions.js` (line 41) but is **never called during app initialization**. The `sessionState.js` `initMessageHandlers()` function wires `on(SERVER.INIT)` to only call `loadProjects()` and `loadSessions()` — NOT `loadSettings()`.

On WS connect, the server sends `init` and `sessions:list` but NOT `settings:updated`.

The `settings` signal in `store.js` initializes as `signal({})` (empty object). Values are only populated when:
1. `PUT /api/settings` succeeds → response body written to `settings.value`
2. `settings:updated` WS message arrives (triggered by `settings:get` or `settings:update` WS messages — neither of which is sent on initialization)
3. `loadSettings()` is explicitly called (nothing calls it)

**Implication for T-09:** When the user hard-reloads and opens SettingsModal, the `settings.value` signal is `{}`. The modal's `useEffect` re-syncs from `settings.value` but since it's empty, all local state falls back to defaults (`'sonnet'`, `false`, `''`). The form will show **defaults, not persisted values** — unless the component itself fetches `/api/settings`.

Wait — let me re-check. The SettingsModal's `useEffect` runs when `settingsModalOpen.value` changes. If `settings.value` is `{}`, then `s2 = {}`, `sess2 = {}`, `sess2.defaultModel` is `undefined`, and `setSessModel(undefined || 'sonnet')` = `'sonnet'`. So the modal shows Sonnet even if Haiku was saved.

**This is the fail condition the test must detect.**

### 1c. Command preview computation

`buildCommandPreview()` in `SettingsModal.js` is a pure function called during render, using local state variables `sessModel`, `sessThinking`, etc. It returns strings like:
- `claude --model claude-haiku-4-5-20251001` (haiku, no thinking)
- `claude --model claude-haiku-4-5-20251001 --effort max` (haiku + thinking)
- `claude --model claude-sonnet-4-6` (sonnet, no thinking)

The preview is rendered inside a `div.form-input` with `font-family:var(--font-mono)`.

### 1d. False-PASS risks

**Risk A: LocalStorage vs server persistence.**  
The form values could be stored in `localStorage` and restored on reload, making the UI *appear* to persist without the server actually having the values. Test MUST verify via `GET /api/settings` from Node.js (not from browser) that the values are on the server before AND after reload.

**Risk B: Test writes settings but doesn't actually reload hard.**  
Using `page.reload()` without CDP cache disable might serve stale JS from cache. Must use CDP `Network.setCacheDisabled(true)` before reload.

**Risk C: settings signal populated between reload and modal open.**  
If something triggers `loadSettings()` between page load and modal open, the modal would show correct values even if the initialization path is broken. To guard against this, the test must check `settings.value` in the browser context RIGHT BEFORE opening the modal.

**Risk D: Defaults match saved values.**  
If we test with the default model (Sonnet), we can't distinguish "loaded from server" from "fell back to default." ALWAYS use non-default values: Haiku for model, `true` for extended thinking.

---

## 2. Infrastructure Setup

### 2a. Isolated server

Spawn a dedicated test server on port 3106 with a fresh temporary data directory.

```
PORT=3106
DATA_DIR=$(mktemp -d /tmp/qa-T09-XXXXXX)
```

Start with `server-with-crash-log.mjs`. Wait for ready by polling `http://127.0.0.1:3106/` up to 25s.

### 2b. Screenshot directory

Create `qa-screenshots/T09-settings-persist/` under the app root.

### 2c. Create a test project via REST API

`POST /api/projects` with `{ name: "T09-project", path: "<tmpDir>/project" }`. Store `projectId`.

Seed `$DATA_DIR/projects.json` using the correct format:
```json
{ "projects": [{ "id": "proj-t09", "name": "T09-Project", "path": "/tmp", "createdAt": "2026-01-01T00:00:00Z" }], "scratchpad": [] }
```

---

## 3. Settings Save Flow

### 3a. Navigate to app

`page.goto('http://127.0.0.1:3106', { waitUntil: 'domcontentloaded' })`

Wait for `.status-dot.connected` — WebSocket connected.

### 3b. Open SettingsModal

Click the settings button in TopBar. Selector: `button[title="Settings"]` or the button with a gear icon in `#topbar`. Look at `TopBar.js`: it uses `onClick=${openSettingsModal}`. The exact selector should be the settings button — check DOM for `button` with "Settings" text or appropriate class.

Wait for the modal to appear: `[data-modal="settings"]` or `.modal-wide` containing "Session Defaults" text.

Take screenshot: `01-settings-before-change.png`

### 3c. Change Default Model to Haiku

The model select is `select.form-select` (first one in Session Defaults section). Select option value `"haiku"`.

Selector: within the Session Defaults section, find the `select.form-select` for "Default Model."

Since there are multiple `select.form-select` elements (session model, watchdog model, low-credit model), we must be precise. The first `select.form-select` in the modal body is the session model selector.

Use: `page.locator('.modal .settings-section').first().locator('select.form-select')`

### 3d. Toggle Extended Thinking ON

The Extended Thinking toggle for session settings is the first `.toggle-slider` in the Session Defaults section.

Use: `page.locator('.modal .settings-section').first().locator('.toggle-slider').first()`

Click it. Verify the background color changes to `var(--accent)` (the checked state).

### 3e. Verify command preview shows haiku + thinking

The command preview `div.form-input[style*="font-mono"]` (the last one in the modal body) should now read:
`claude --model claude-haiku-4-5-20251001 --effort max`

### 3f. Click Save

Click `button.btn-primary` in `.modal-footer` (the "Save Settings" button).

Wait for: the modal to close (settingsModalOpen becomes false, modal disappears).

Wait for: a success toast to appear containing "Settings saved".

Take screenshot: `02-settings-saved.png`

### 3g. Verify server received settings (pre-reload check)

From Node.js test runner:
```
GET http://127.0.0.1:3106/api/settings
```

Assert:
- `data.session.defaultModel === 'haiku'`
- `data.session.extendedThinking === true`

This confirms server-side persistence BEFORE the reload.

---

## 4. Hard Reload

### 4a. Reload procedure

```js
const cdp = await page.context().newCDPSession(page);
await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
await page.reload({ waitUntil: 'domcontentloaded' });
```

### 4b. Verify page loaded

Wait for `#topbar` to be visible.
Wait for `.status-dot.connected` (WS reconnected).

Take screenshot: `03-after-reload.png`

### 4c. Verify settings NOT in client signal (before modal open)

From browser context, evaluate:
```js
// If loadSettings() was never called, settings signal should be empty or missing session.defaultModel
window.__signalSettings && window.__signalSettings.value
```

Actually, the signals are module-level — evaluate via script injection:
```js
// Check the current settings signal value right after reload
document.querySelector('#app').__preactSignals
```
This is fragile. Instead, verify the false-PASS risk differently: after reload, check `GET /api/settings` returns correct values (this is already covered), then open modal and check what it shows.

---

## 5. Post-Reload Settings Verification

### 5a. Open SettingsModal again

Click the settings button in TopBar.

Wait for modal visible: `.modal-wide` containing "Session Defaults".

Take screenshot: `04-settings-after-reload.png`

### 5b. Verify model is still Haiku

Read the selected value of the session model select:
```js
page.locator('.modal .settings-section').first().locator('select.form-select').inputValue()
```

Assert: value is `"haiku"` (not `"sonnet"`).

### 5c. Verify Extended Thinking is still ON

Read the toggle state. The toggle has a hidden checkbox with `type="checkbox"`. Its `checked` property reflects the state.

```js
page.locator('.modal .settings-section').first().locator('input[type="checkbox"]').first().isChecked()
```

Assert: `checked === true`

### 5d. Verify command preview shows haiku + thinking

```js
page.locator('.modal-body .form-input[style*="mono"]').last().textContent()
```

Assert: contains `claude-haiku-4-5-20251001` AND `--effort max`

Take screenshot: `05-settings-verified.png`

---

## 6. Repeat Protocol (2x with Different Values)

### Round 1: Haiku + Extended Thinking ON (as above)

### Round 2: Opus + Extended Thinking OFF

After verifying Round 1, close the modal. Save settings with `{ defaultModel: 'opus', extendedThinking: false }`. Hard reload. Open modal. Verify model is `'opus'`, thinking is `false`, preview shows `claude --model claude-opus-4-6`.

This catches regressions where only some settings persist (e.g., model saves but thinking toggle resets).

### Round 3: Haiku + Extended Thinking ON (repeat for confidence)

Repeat round 1 values. Hard reload. Verify same values survive.

---

## 7. Server-Side Verification

After each round, from Node.js:
- `GET /api/settings` → verify `session.defaultModel` and `session.extendedThinking` match what was saved.
- This confirms the server wrote to disk, not just in-memory.

To confirm on-disk persistence (strongest test): stop the server, read `$DATA_DIR/settings.json` directly, verify values, restart server, check again. This proves writes went to disk and not just RAM.

However, stopping/restarting the server mid-test is complex. Instead: after the browser reload (which doesn't affect the server), the server's in-memory state still has the values. The disk persistence is tested by restarting the entire server process between save and verification.

**Disk persistence test (optional enhanced check):**
1. Save settings with Haiku + thinking.
2. STOP the server (`serverProc.kill('SIGTERM')`).
3. Restart the server (new `spawn`).
4. `GET /api/settings` → if values persist across server restart, disk write confirmed.
5. This is the gold standard for persistence.

Include this as an additional assertion after round 1.

---

## 8. Pass/Fail Criteria

### PASS — all of the following:

1. After Save, `GET /api/settings` returns `session.defaultModel === 'haiku'` and `session.extendedThinking === true`.
2. After hard reload, SettingsModal shows model select value `"haiku"`.
3. After hard reload, Extended Thinking toggle shows `checked === true`.
4. After hard reload, command preview contains `claude-haiku-4-5-20251001` and `--effort max`.
5. Same conditions hold for Round 2 (Opus, no thinking) and Round 3 (Haiku, thinking).
6. After server restart, `GET /api/settings` still returns the last saved values (disk persistence confirmed).

### FAIL — any of the following:

- After reload, model select shows `"sonnet"` (default, meaning settings not loaded from server).
- After reload, Extended Thinking toggle is `false` (unchecked) when it was saved as `true`.
- After reload, command preview shows `claude --model claude-sonnet-4-6` (default command, not haiku).
- `GET /api/settings` returns default values after save (server didn't persist).
- Only some settings persist (model saves but thinking resets — partial persistence bug).
- Settings persist across browser reload (localStorage trick) but NOT across server restart (in-memory only bug).

---

## 9. Exact Selectors Reference

| Element | Selector |
|---------|---------|
| Settings button (TopBar) | `#topbar button` containing gear icon, or `button[aria-label="Settings"]` or the last button in `#topbar` |
| Modal overlay | `.modal-overlay` |
| Modal container | `.modal.modal-wide` |
| Session Defaults section | `.modal-body .settings-section:first-of-type` or first `.settings-section` |
| Session model select | `.modal-body .settings-section:first-of-type select.form-select` |
| Extended Thinking toggle (session) | First `.toggle-slider` in session defaults section |
| Extended Thinking checkbox (hidden) | First `input[type="checkbox"]` in session defaults section |
| Command preview div | Last `.form-input` in `.modal-body` (has `font-family:var(--font-mono)`) |
| Save button | `.modal-footer .btn-primary` |
| Cancel button | `.modal-footer .btn-ghost` |
| Toast notification | `.toast` or fixed-position div at bottom-right |

---

## 10. Key Implementation Notes

### waitUntil: 'domcontentloaded'

Never use `networkidle` — the persistent WebSocket connection prevents networkidle from ever resolving.

### CDP cache disable

Use CDP `Network.setCacheDisabled(true)` before every hard reload to ensure no stale JS is served from browser cache.

### Settings signal initialization gap

The client-side `settings` signal starts as `{}` after every reload. Settings are only populated when the modal calls `loadSettings()` implicitly — but looking at the code, `SettingsModal`'s `useEffect` re-syncs from `settings.value` when the modal opens. If `settings.value` is `{}`, the modal shows defaults.

**However,** `SettingsModal.js` reads from `settings.value` in its render function (`const s = settings.value || {}`). If `loadSettings()` was called somewhere before the modal opened, the modal would show correct values. But `loadSettings()` is never called from init code.

This means the test will likely FAIL at the "verify after reload" step — which is the BUG to catch. The test documents this failure case precisely.

### ProjectStore seed format

Always use `{ "projects": [...], "scratchpad": [] }` format for `projects.json`. Plain arrays fail silently.

---

## 11. Screenshots

| Filename | Timing |
|---------|--------|
| `01-settings-before-change.png` | Modal open, before any changes |
| `02-settings-saved.png` | After save, toast visible |
| `03-after-reload-round1.png` | After hard reload, before modal reopen |
| `04-settings-after-reload-round1.png` | Modal open post-reload round 1 |
| `05-settings-after-reload-round2.png` | Modal open post-reload round 2 |
| `06-settings-after-reload-round3.png` | Modal open post-reload round 3 |
| `07-after-server-restart.png` | After server restart persistence check |

---

## 12. Cleanup

In `afterAll` (regardless of test outcome):
1. Kill server process (`SIGTERM`, then `SIGKILL` if needed).
2. Close Playwright browser.
3. Remove temp data dir (`fs.promises.rm(tmpDir, { recursive: true, force: true })`).
4. Keep screenshots on failure, remove on pass.

---

## Execution Summary

**Date:** 2026-04-08  
**Result:** PASS (1/1 test)

### Run 1 (pre-fix): FAIL — multiple issues
1. `extendedThinking` was not saved (server received `false` even after toggle click)
2. Hard reload test couldn't find `#topbar` — cross-test state dependency: tests split across multiple `test()` calls shared page state, but Playwright re-runs `beforeAll` for each failing test, giving subsequent tests a fresh server with no prior settings
3. Settings modal showed defaults (sonnet, false) after reload — the primary bug: `loadSettings()` was never called during app initialization

### Fixes applied:
1. **`public/js/state/sessionState.js`** — Added `loadSettings()` call in the `on(SERVER.INIT)` handler, alongside existing `loadProjects()` and `loadSessions()`. Added `loadSettings` import from actions.js. This ensures the `settings` signal is populated on every page load/reload, so `SettingsModal` shows persisted values when opened.
2. **Test structure** — Merged all rounds and the server-restart check into a single `test()` function to avoid cross-test state dependency. Browser, page, and server are created once in `beforeAll` and shared throughout.
3. **Toggle click** — Changed from Playwright `.click()` to `page.evaluate(() => slider.click())` to properly fire the Preact onClick handler. Also added `await sleep(200)` after toggle click for Preact state to settle, plus post-click verification.
4. **readModalState** — Changed checkbox state reading from Playwright `isChecked()` to `page.evaluate()` to reliably read `checked` property of hidden inputs.

### Run 2 (post-fix): PASS — 1/1
- Round 1 (haiku + thinking=true): server confirmed, hard reload → modal shows haiku + --effort max ✓
- Round 2 (opus + thinking=false): server confirmed, hard reload → modal shows opus, no --effort max ✓  
- Round 3 (haiku + thinking=true): server confirmed, hard reload → modal shows haiku + --effort max ✓
- Disk persistence: settings.json on disk has correct values after server kill ✓
- Server restart: server reloads settings from disk, modal shows correct values ✓

### Verdict: SETTINGS PERSISTENCE NOW WORKING
The primary bug (`loadSettings()` never called on init) was fixed. Settings now load from server on every connect/reconnect, ensuring the SettingsModal always shows persisted values after hard reload.
