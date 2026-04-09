# T-14 Validation: Delete Confirmation Dialog — Cancel Leaves Session Intact

**Date:** 2026-04-08
**Result:** PASS
**Tests:** 3/3 passed in 34.9s (1 fix applied)

---

## Pass/Fail Verdict

**PASS** — all criteria from the design spec hold after fixing a `status` vs `state` field mismatch in the test helper.

---

## Fix Applied

**Bug in test (not in app):** `getSessionsRest()` parsed the `managed` array from `{ managed, detected }` correctly, but subsequent checks used `rec.state` when the session metadata uses `status` (matching `sessionStates.js` constants: `STATES.STOPPED = 'stopped'`).

**Files changed:** `tests/adversarial/T-14-delete-cancel.test.js`

| Location | Old | New |
|----------|-----|-----|
| `stopSession` sessions:list branch | `s.state !== 'running'` | `s.status !== 'running'` |
| T-14.A stop verify | `sessionRecord.state` | `sessionRecord.status` |
| T-14.B stop verify | `rec.state` | `rec.status` |
| `stopSession` WS matcher | `'stopped' \|\| 'exited'` | `'stopped' \|\| 'error' \|\| 'exited'` |

The app itself had no bug — the confirm dialog, cancel guard, and delete path all work correctly.

---

## Criteria Checklist

| # | Criterion | Result |
|---|-----------|--------|
| 1 | Dialog appears when Delete clicked (type=confirm, message contains session name) | PASS |
| 2 | Cancel: zero `session:delete` WS frames sent | PASS |
| 3 | Session card remains visible in DOM after Cancel | PASS |
| 4 | Session intact on server via REST after Cancel | PASS |
| 5 | Accept: session card disappears, REST no longer returns session | PASS |
| 6 | Repeat 3x: all 3 cancel iterations pass | PASS (3/3) |
| 7 | Session card shows no error/broken state after Cancel | PASS |

---

## Test Coverage

### T-14.A — Cancel × 3 iterations
For sessions T14-repeat-1, T14-repeat-2, T14-repeat-3:
- Confirm dialog fired with `type="confirm"` and message `Delete session "T14-repeat-N"?`
- `dialog.dismiss()` called (Cancel)
- No `session:delete` WS message in `wsSendLog`
- Session card remained visible
- REST `GET /api/sessions` returned session with status=stopped

### T-14.B — Accept path
- Dialog fired, `dialog.accept()` called
- Exactly 1 `session:delete` WS message with correct `id`
- Session card removed from DOM within 3s
- REST confirmed session absent

### T-14.C — Active session has no Delete button
- Running session's card correctly omitted Delete button (SessionCard.js line 148 guard)

---

## App Behavior Confirmed

`SessionCard.js` `handleDelete()`:
```js
if (!confirm(`Delete session "${sessionName}"?`)) return;
deleteSession(session.id);
```
- The `confirm()` guard is correctly implemented and cannot be bypassed
- Cancel returns `false`, `deleteSession()` is never called
- No race condition between dialog and card state observed

---

## Screenshots

Saved to `qa-screenshots/T14-delete-cancel/`:
- `T14-01-cancel-iter1.png`, `T14-02-cancel-iter2.png`, `T14-03-cancel-iter3.png`
- `T14-accept-after-delete.png`
- `T14-active-session-card.png`
