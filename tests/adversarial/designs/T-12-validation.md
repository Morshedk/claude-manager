# T-12 Validation: Tmux Session Survives Browser Tab Close and Re-Open

**Date:** 2026-04-08  
**Result:** PASS — 1/1 test (no fixes needed)  
**Test file:** `tests/adversarial/T-12-tmux-survives-close.test.js`  
**Port:** 3109

---

## Verdict: PASS

All pass criteria from the design doc are satisfied. No application code changes were required.

---

## Behavior Confirmed

The tmux session survival chain worked correctly end-to-end:

1. **WS close handler** (`server.js`) calls only `sessions.unsubscribe()`, NOT `sessions.stop()` — tmux session not killed on disconnect ✓
2. **`TmuxSession.removeViewer()`** removes clientId from viewers map without touching the PTY or the underlying tmux process ✓
3. **PTY remains attached** after all viewers disconnect — `tmux attach-session` process stays running on the node-pty master ✓
4. **Session card shows "running"** after browser reopen — server's in-memory status not corrupted by WS close ✓
5. **Bidirectional I/O** works after reopen — new viewer receives PTY output and keyboard input is forwarded ✓

---

## Test Results

| Check | Description | Result |
|-------|-------------|--------|
| Tmux session creation | Card shows "running", mode=tmux, tmuxName matches `cm-<id[:8]>` | PASS |
| OS-level session alive (pre-close) | `tmux has-session -t cm-<id>` returns 0 | PASS |
| Pre-close marker in terminal | `T12_PRE_CLOSE_<ts>` echo visible in xterm-screen | PASS |
| Tmux alive after browser close (5s) | `tmux has-session` still returns 0 after 5s wait | PASS |
| `tmux ls` contains session | `tmuxLsOutput.includes(tmuxName)` | PASS |
| Pre-close marker in pane history | `tmux capture-pane -p -S -` contains marker | PASS |
| Session card "running" in browser2 | After fresh browser navigate, card shows running | PASS |
| Tmux alive after browser reopen | Second `tmux has-session` check passes | PASS |
| API confirms running | `GET /api/sessions` → status=running after reopen | PASS |
| Terminal non-blank | `xterm-screen` textContent 54,887 chars (far from blank) | PASS |
| Bidirectional I/O | `T12_POST_OPEN_<ts>` appears in terminal within 8s | PASS |
| No crash log entries | Zero server crash events during test window | PASS |

---

## Key Observation

The pre-close marker was NOT visible in browser2's terminal (logged as INFO, not FAIL). This is by design: the PTY was never detached on browser1 close — the `tmux attach-session` node-pty process stayed running. Browser2 joined the existing PTY stream and received only new output going forward. The tmux pane history (confirmed via `capture-pane -S -`) preserved the marker — this is the authoritative check.

---

## Pass Criteria Verification

| Criterion | Status |
|-----------|--------|
| `tmux has-session` exits 0 (both after 5s wait and after browser reopen) | PASS |
| Session card shows "running" after browser reopen | PASS |
| Terminal not blank after reopen (`textContent.length > 0`) | PASS |
| `tmux capture-pane` contains pre-close marker | PASS |
| Post-open I/O marker appears in terminal | PASS |

---

## Screenshots
Saved in `qa-screenshots/T12-tmux-survives-close/`:
- `00-initial.png` — initial app state
- `01-modal-tmux.png` — New Session modal in Tmux mode
- `T12-01-before-close.png` — terminal with pre-close marker
- `T12-02-after-reopen-card.png` — session card showing "running"
- `T12-03-terminal-after-reopen.png` — terminal overlay after reopen
- `T12-04-post-open-io.png` — post-open I/O marker confirmed

---

## Files Modified
- None (application behavior was already correct)
- `playwright.config.js` — added T-12 to testMatch list
