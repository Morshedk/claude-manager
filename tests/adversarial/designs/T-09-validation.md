# T-09 Validation: Settings Persist Across Browser Reload

**Date:** 2026-04-08  
**Result:** PASS — 1/1 test  
**Test file:** `tests/adversarial/T-09-settings-persist.test.js`  
**Port:** 3106

---

## Verdict: PASS

All pass criteria from the design doc are satisfied after applying one app fix and restructuring the test.

---

## Bug Found and Fixed

### Bug: `loadSettings()` never called during app initialization
- **Location:** `public/js/state/sessionState.js` — `initMessageHandlers()`
- **Root cause:** The `on(SERVER.INIT)` handler called `loadProjects()` and `loadSessions()` but NOT `loadSettings()`. The `settings` signal initialized as `{}` and was only populated when:
  1. `PUT /api/settings` succeeded (i.e., user saved settings in current session)
  2. `settings:updated` WS message arrived (not sent on init)
- **Impact:** After any hard browser reload, `SettingsModal` showed defaults (`sonnet`, `false`) regardless of what was previously saved. The UI appeared to not persist settings.
- **Fix:** Added `loadSettings()` call in `on(SERVER.INIT)` handler + added `loadSettings` to import list from actions.js

---

## Test Restructure

The original 7-test structure had a cross-test state dependency: each test assumed the prior test's browser/server/page state. When a test failed mid-suite, Playwright re-ran `beforeAll` for subsequent tests, creating a fresh server with no prior settings — causing cascade failures.

**Resolution:** Consolidated all rounds into a single `test()` function. Server and browser created once in `beforeAll`, page used throughout. If any assertion fails, the whole test fails (no false partial passes).

---

## Test Results

| Phase | Description | Result |
|-------|-------------|--------|
| Round 1 save | haiku + thinking=true → server confirms | PASS |
| Round 1 reload | Hard reload → modal shows haiku + --effort max | PASS |
| Round 2 save | opus + thinking=false → server confirms | PASS |
| Round 2 reload | Hard reload → modal shows opus, no --effort max | PASS |
| Round 3 save | haiku + thinking=true → server confirms | PASS |
| Round 3 reload | Hard reload → modal shows haiku + --effort max | PASS |
| Disk persistence | settings.json on disk has correct values | PASS |
| Server restart | Server reloads from disk, modal shows correct values | PASS |

---

## Pass Criteria Verification

| Criterion | Status |
|-----------|--------|
| After Save, `GET /api/settings` returns saved defaultModel + extendedThinking | PASS |
| After hard reload, SettingsModal shows correct model value | PASS |
| After hard reload, Extended Thinking toggle shows correct state | PASS |
| After hard reload, command preview contains correct model + flags | PASS |
| All 3 rounds pass (haiku+on, opus+off, haiku+on) | PASS |
| After server restart, `GET /api/settings` returns last saved values (disk persistence) | PASS |

---

## Screenshots
Saved in `qa-screenshots/T09-settings-persist/`:
- `01-settings-before-change.png` through `08-settings-after-server-restart.png`

---

## Files Modified
- `public/js/state/sessionState.js` — added `loadSettings()` to INIT handler
- `tests/adversarial/T-09-settings-persist.test.js` — restructured to single test, fixed toggle interaction
