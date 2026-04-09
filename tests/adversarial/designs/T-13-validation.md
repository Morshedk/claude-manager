# T-13 Validation: Submitting New Project With Empty Name Shows Validation Error

**Date:** 2026-04-08
**Result:** PASS
**Tests:** 4/4 passed in 21.8s (no fixes required)

---

## Pass/Fail Verdict

**PASS** — all criteria from the design spec hold.

---

## Criteria Checklist

| # | Criterion | Result |
|---|-----------|--------|
| 1 | Scenario A: All 3 iterations pass all 4 assertions | PASS |
| 2 | Scenario B: Both iterations pass all 4 assertions | PASS |
| 3 | Scenario C: Single run — name checked before path | PASS |
| 4 | Scenario D: Whitespace-only name triggers name-required toast | PASS |
| 5 | No `POST /api/projects` calls in any scenario | PASS |

---

## Assertion Results (per scenario)

### Scenario A — Empty name + valid path (3 iterations)
Each iteration confirmed:
- Toast "Project name is required" appeared within 3s
- `div.dialog-overlay` remained visible after submit
- No `POST /api/projects` network request observed
- `GET /api/projects` returned `[]`

### Scenario B — Valid name + empty path (2 iterations)
Each iteration confirmed:
- Toast "Project path is required" appeared within 3s
- Modal stayed open
- No API call made
- No project created on server

### Scenario C — Both fields empty
- "Project name is required" toast shown (name validated first, per code)
- Modal stayed open
- No API call made

### Scenario D — Whitespace-only name
- `name.trim() === ''` logic triggered correctly
- Toast "Project name is required" shown
- Modal stayed open
- No API call made

---

## Fail Conditions Checked (none triggered)

- Modal closes after empty-name submit: NOT observed
- Toast does not appear within 3s: NOT observed
- `POST /api/projects` was called: NOT observed
- Project created on server: NOT observed

---

## Implementation Verified

`NewProjectModal.js` `handleCreate()` correctly:
1. Calls `name.trim()` before validation
2. Returns early with `showToast('Project name is required', 'error')` if name is empty
3. Returns early with `showToast('Project path is required', 'error')` if path is empty
4. Only calls `createProject()` when both fields are non-empty after trimming

---

## Screenshots

Saved to `qa-screenshots/T-13-validation/`:
- `A-iter-1-01-modal-opened.png`, `A-iter-1-02-after-submit.png`, `A-iter-1-03-modal-still-open.png`
- `A-iter-2-*`, `A-iter-3-*` (same pattern)
- `B-iter-1-01-path-validation.png`, `B-iter-2-01-path-validation.png`
- `C-01-both-empty.png`
- `D-01-whitespace-name.png`
