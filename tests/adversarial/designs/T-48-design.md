# T-48 Design: Settings Escape Key Discards Changes

**Port:** 3145  
**Score:** 8  
**Type:** Playwright browser

---

## Test Goal

Verify that pressing Escape while the Settings modal is open:
1. Closes the modal
2. Does NOT save any changes made in the form
3. Does not get intercepted by the terminal pane's keyboard capture

---

## Code Path Analysis

### SettingsModal.js — Escape handling (or lack thereof)

Reading `SettingsModal.js` carefully: The modal renders with a `modal-overlay` div that has `onClick=${closeSettingsModal}` (line 203). This means clicking *outside* the modal content closes it.

**Critical finding:** There is NO `onKeyDown` handler on the modal itself for Escape. The modal does NOT explicitly handle Escape.

The `modal` inner div (line 207) has `onClick=${e => e.stopPropagation()}` to prevent outside-click from reaching inner click. This prevents the overlay click handler from firing when clicking inside.

**Question: Who handles Escape?**

Looking at the component tree:
- `App.js` — no global `keydown` listener
- `TerminalPane.js` — `xterm.onData` handles keyboard input to the PTY. xterm.js itself captures keyboard events when focused.
- No global `document.addEventListener('keydown', ...)` visible in any component

**The subtle issue:** xterm.js captures keyboard events on the terminal element when it has focus. The terminal element is rendered inside `#session-overlay-terminal` which is inside `SessionOverlay`. When the Settings modal is open AND a session overlay is also open, xterm.js has focus and can intercept Escape.

However, when Settings modal is open without a terminal overlay, Escape might work via the browser's default behavior (some browsers dispatch `keydown` for Escape to close modals if the element has a role=dialog). But there is no explicit Escape handler.

**Most likely behavior based on the code:**
- Escape is NOT handled by SettingsModal explicitly
- If a terminal is focused (xterm has focus), xterm intercepts Escape and sends it to the PTY as an escape sequence (`\x1b`) — the modal does NOT close
- If the modal itself or an input within it has focus, browser passes Escape to whichever element handles it. Since no `keydown` handler is registered, Escape does nothing (modal stays open)

**This is the bug the test is designed to find.** The expected behavior is that Escape closes the modal. The actual behavior, based on the code, is likely that Escape does NOT close the modal (it gets swallowed by xterm or ignored).

### What the test must distinguish

1. **Escape closes modal AND discards changes** — genuine PASS (desired behavior)
2. **Escape does NOT close the modal** — FAIL (xterm intercepts or no handler)
3. **Escape closes modal AND saves changes** — FAIL (changes should be discarded)
4. **Escape partially closes but changes leak through** — FAIL

### The save flow

`handleSave()` (line 149) sends `PUT /api/settings`. This is only called when the user clicks "Save Settings". Closing via Cancel or `closeSettingsModal()` does NOT persist changes — local form state is discarded when the modal unmounts.

Therefore: if the modal closes via Escape (calling `closeSettingsModal()`), changes are NOT saved. The only risk is if some intermediate save mechanism exists, which it does not.

### Re-open and verify

When the modal reopens, the `useEffect` (line 120) re-syncs local state from `settings.value` signal. If settings were not actually saved to the API, `settings.value` retains its old value and the form re-populates with the original value.

---

## Infrastructure Setup

### Server startup
```js
serverProc = spawn('node', ['server-with-crash-log.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: '3145', CRASH_LOG: crashLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

### Project seed
```json
{
  "projects": [
    { "id": "proj-t48", "name": "T48-Project", "path": "/tmp", "createdAt": "2026-01-01T00:00:00Z" }
  ],
  "scratchpad": []
}
```

No session needed for the core test. However, we must test BOTH cases:
1. Settings modal open WITHOUT a terminal overlay (no xterm focus issue)
2. Settings modal open WITH an active session overlay (xterm focus issue)

---

## Exact Test Execution Steps

### Sub-test A: Escape closes modal when no terminal is open

#### A1: Navigate and connect
- `goto(BASE_URL, { waitUntil: 'domcontentloaded' })`
- Wait for `.status-dot.connected`

#### A2: Record original default model
- Open Settings: click Settings button in TopBar (`.btn-ghost` with title "Settings")
- Wait for settings modal visible (`.modal-wide`, up to 5s)
- Read current default model value: `page.locator('.modal .form-select').first().inputValue()`
- Save as `originalModel`
- Close modal via Cancel button

#### A3: Verify API initial state
- `GET /api/settings` — record `initialSettings.session.defaultModel`

#### A4: Open settings and change model
- Click Settings button again
- Wait for modal visible
- Change the Default Model select to a different value from `originalModel`
  - If `originalModel === 'sonnet'`, change to `'haiku'`
  - If `originalModel === 'haiku'`, change to `'sonnet'`
  - Record `changedTo`
- Verify the select actually changed: re-read its value

#### A5: Press Escape
- `page.keyboard.press('Escape')`
- Wait 500ms

#### A6: Assert modal is closed
- Assert `.modal-wide` is not visible (or not in DOM)
- This is the primary assertion for "Escape closes the modal"

#### A7: Assert settings NOT saved
- `GET /api/settings` — read `currentSettings.session.defaultModel`
- Assert `currentSettings.session.defaultModel === initialSettings.session.defaultModel`
- This is the primary assertion for "Escape discards changes"

#### A8: Re-open and verify original value shown
- Click Settings button again
- Wait for modal visible
- Read default model select value again
- Assert it matches `originalModel` (re-sync from signal, NOT from changed local state)
- Close modal via Cancel

### Sub-test B: Escape behavior with terminal overlay open

#### B1: Create a bash session and open terminal overlay
- Select "T48-Project"
- Create bash session "t48-bash"
- Wait for session card running badge
- Click session card to open overlay
- Wait for `#session-overlay` visible
- Wait for xterm screen visible
- Sleep 500ms (let xterm capture focus)

#### B2: Open Settings while terminal overlay is active
- Click Settings button in TopBar
- Wait for `.modal-wide` visible (up to 5s)
- Assert modal IS visible (it should open even with terminal focused)

#### B3: Change default model (same as A4)
- Change the Default Model select (focus moves to the modal)
- Record `changedToB`

#### B4: Press Escape
- `page.keyboard.press('Escape')`
- Wait 500ms

#### B5: Assert modal closed
- Check `.modal-wide` not visible

#### B6: Assert settings NOT saved
- `GET /api/settings`
- Assert `defaultModel` unchanged from initial

#### B7: Verify xterm did NOT receive Escape as input
- If terminal overlay is still open (xterm visible), type a marker: `echo T48_ESCAPE_CHECK`
- The `\x1b` escape character should NOT appear as visible text in the terminal
- This verifies that Escape was consumed by the modal close, not forwarded to PTY

---

## Key Timing and Implementation Notes

### Focus management
The `SettingsModal` renders with `z-index: 200` (the overlay div style). When it opens, clicks land on modal elements. Browser focus should move to whatever is clicked within the modal. If no element auto-focuses, browser focus stays on xterm.

**Risk:** If the modal opens but never captures focus from xterm, `page.keyboard.press('Escape')` in Playwright dispatches to the xterm element, which sends `\x1b` to the PTY — not to the modal. The modal would not close.

### The Playwright `keyboard.press` behavior
Playwright's `keyboard.press('Escape')` dispatches a `KeyboardEvent` to the focused element. If xterm has focus and no `stopPropagation` intercepts it at the modal level, xterm processes Escape as PTY input.

### Expected finding
Based on the code analysis: **SettingsModal does NOT handle Escape.** There is no `onKeyDown` on the modal-overlay div, no global `document.addEventListener('keydown')` for Escape.

Expected test outcome for A5 (no terminal open): Browser default Escape handling may or may not close the modal. If the select input has focus, Escape might close the select dropdown but not the modal.

Expected test outcome for B4 (terminal open): xterm likely intercepts Escape. Modal stays open. Test FAILS.

**The test is designed to find this bug.** A PASS would require Escape to close the modal without saving.

---

## Pass / Fail Criteria

| Check | PASS | FAIL |
|-------|------|------|
| Modal closes on Escape (no terminal) | `.modal-wide` not in DOM after Escape | Modal still visible |
| Settings not saved (no terminal) | API defaultModel unchanged | API defaultModel changed to new value |
| Re-open shows original value | Select shows `originalModel` | Select shows `changedTo` |
| Modal closes on Escape (with terminal) | `.modal-wide` not in DOM | Modal stays open (xterm intercept) |
| Settings not saved (with terminal) | API unchanged | API changed |
| Escape not forwarded to PTY | No `\x1b` echo in terminal | Terminal shows escape char |

---

## What a Vacuous PASS Would Look Like

If the test only checks "modal is closed" without verifying the settings API is unchanged, it would pass even if Escape triggers an auto-save before closing. The API check is mandatory.

If the test skips the "with terminal overlay" sub-test, it misses the xterm focus interception scenario — which is the most likely real-world failure mode. Users typically have a terminal open when they access settings.

If the test clicks Cancel instead of pressing Escape, it proves nothing about Escape handling (Cancel calls `closeSettingsModal()` explicitly).
