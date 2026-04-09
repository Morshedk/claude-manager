# T-19 Validation: Session card lastLine updates while overlay is open

**Date:** 2026-04-08
**Overall result:** FAIL (feature not implemented — confirmed finding)
**Tests run:** 2 (1 fail expected, 1 diagnostic pass)

---

## Fix Applied

Single line fix in `tests/adversarial/T-19-lastline-updates.test.js`:
- Changed `m.type === 'server:init'` to `m.type === 'init'` (server sends `type: 'init'`, not `type: 'server:init'`)

---

## Test Results

### Test 1: lastLine on session card updates within 3s — FAIL (expected)

| Check | Result | Detail |
|-------|--------|--------|
| Infrastructure setup | PASS | Server started, project created, bash session created |
| WS init message received | PASS | After fix: `type: 'init'` correctly matched |
| Session card visible after project click | PASS | `.session-card` found in DOM |
| Overlay opened | PASS | `#session-overlay` appeared |
| Split view active | PASS | Overlay style includes `left: 50%` |
| Session card visible in split mode | PASS | `.session-card` visible alongside overlay |
| `.session-lastline` appears within 3s of echo | FAIL | Element never appears in DOM |
| ANSI codes absent | N/A | Not reached (lastLine not present) |
| Second echo updates lastLine | N/A | Not reached |

**Failure reason:** `lastLine` feature not implemented server-side. `session.meta.lastLine` never set.

### Test 2: API diagnostic — PASS

| Check | Result | Detail |
|-------|--------|--------|
| `session.meta.lastLine` before echo | undefined | Not set |
| `session.meta.lastLine` after echo | undefined | Not set |
| Session defined in API | PASS | Session found in `/api/sessions` |

---

## Root Cause Analysis

The design correctly predicted this failure. No server-side code:
1. Reads PTY output chunks
2. Strips ANSI codes
3. Extracts the last non-empty line
4. Updates `session.meta.lastLine`
5. Includes `lastLine` in `sessions:list` broadcast

The `sessions:list` message always has `lastLine: undefined` for every session.

**Session meta fields present:** `id, projectId, projectName, name, command, cwd, mode, claudeSessionId, tmuxName, telegramEnabled, createdAt, status, pid, startedAt`
**Missing:** `lastLine`

---

## Verdict

The test correctly identifies that the `lastLine` feature is not implemented. The test infrastructure works (infrastructure, WS, overlay, split view all function correctly). The actual feature under test (server-side lastLine computation from PTY output) is absent.

**Action required:** Implement server-side lastLine computation in `DirectSession.js` or `sessionHandlers.js` for this test to pass.
