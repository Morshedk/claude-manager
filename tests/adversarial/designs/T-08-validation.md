# T-08 Validation: Creating Project with Non-Existent Path Shows Error

**Date:** 2026-04-08  
**Result:** PASS — 5/5 tests  
**Test file:** `tests/adversarial/T-08-bad-project-path.test.js`  
**Port:** 3105

---

## Verdict: PASS

All pass criteria from the design doc are satisfied after applying two bug fixes.

---

## Bugs Found and Fixed

### Bug 1 (Server): `ProjectStore.create()` accepted any path string
- **Location:** `lib/projects/ProjectStore.js`
- **Root cause:** No `fs.existsSync()` check on the project path before creation
- **Impact:** Any path string — including `/absolutely/nonexistent/path/xyz123` — was stored and returned as `201 Created`
- **Fix:** Added `if (!fs.existsSync(normalized)) throw new Error('Path does not exist: ' + normalized)` before the deduplication check

### Bug 2 (Client): `createProject()` did not check `r.ok`
- **Location:** `public/js/state/actions.js`
- **Root cause:** `.then(r => r.json())` ignores HTTP status; even a `400` response was silently processed as data
- **Impact:** Even if Bug 1 were fixed server-side, the client would not throw into `handleCreate()`'s catch block. The modal would still close and show a success toast.
- **Fix:** Changed to `const r = await fetch(...)` + `const data = await r.json()` + `if (!r.ok) throw new Error(data.error || ...)`

---

## Test Results

| Test | Description | Result |
|------|-------------|--------|
| Pre-conditions | Clean server state (0 projects) | PASS |
| iter-1 | Bad path `/absolutely/nonexistent/path/xyz123` | PASS |
| iter-2 | Bad path `/this/does/not/exist/either` | PASS |
| iter-3 | Bad path `/nonexistent` | PASS |
| Final | 0 projects after all bad-path attempts | PASS |

---

## Pass Criteria Verification

| Criterion | Status |
|-----------|--------|
| Modal stays open after "Create Project" click with bad path | PASS |
| Error propagates: server returns 400, client throws, catch shows toast | PASS |
| Project does NOT appear in sidebar | PASS |
| `GET /api/projects` returns `[]` after failed attempt | PASS |
| Form inputs retain values (name + path), user can retry | PASS |
| No success toast | PASS |

---

## Screenshots
Saved in `qa-screenshots/T-08-bad-path/`:
- `iter-1-01-form-filled.png` through `iter-3-04-sidebar.png`

---

## Files Modified
- `lib/projects/ProjectStore.js` — added fs.existsSync path validation
- `public/js/state/actions.js` — added r.ok check in createProject()
- `tests/adversarial/T-08-bad-project-path.test.js` — fixed modal close in cleanup
