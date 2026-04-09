# T-17 Validation Report

**Test:** T-17 — Server Restart: Direct Session Stopped, Tmux Session Running
**Date:** 2026-04-08
**Result:** PASS
**Duration:** 17.9s
**Port:** 3114

---

## Pass/Fail Matrix

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| sessions.json flushed before SIGKILL | Both sessions present | Both present (direct=stopped, tmux=running) | PASS |
| Tmux session survived SIGKILL | Alive in tmux | `cm-153792cc` survived | PASS |
| Direct session id unchanged post-restart | Same id | ea8f0615 = ea8f0615 | PASS |
| Tmux session id unchanged post-restart | Same id | 153792cc = 153792cc | PASS |
| Direct claudeSessionId intact | 02aff066 | 02aff066 | PASS |
| Tmux claudeSessionId intact | 9ccb3e8c | 9ccb3e8c | PASS |
| Direct session status post-restart | stopped or error | stopped | PASS |
| Tmux session status post-restart | running | running | PASS |
| Browser: direct session badge | stopped/error | "⏹ stopped" | PASS |
| Browser: tmux session badge | running | "▶ running" | PASS |
| Refresh uses same session id | Same id (not new) | ea8f0615 = ea8f0615 | PASS |

---

## Vulnerability Confirmed Not Present

The server's persistence model correctly handles SIGKILL:

1. **sessions.json is written during session creation** (not deferred) — both session records were present on disk before the SIGKILL was sent.

2. **Tmux process independence** — The tmux session (`bash` shell) runs in a detached tmux process independent of the Node.js server. SIGKILL to the Node.js process does not kill tmux children.

3. **Server restart correctly detects tmux state** — `session._attachPty()` calls `_tmuxSessionAlive()` and finds the session alive. The session status is correctly reported as `running` after restart.

4. **`claudeSessionId` persistence** — Both session IDs survived SIGKILL through disk persistence, confirming that session resume tracking is intact across server crashes.

5. **Refresh re-uses existing session** — Clicking Refresh on the direct session after restart restarted the PTY under the same session `id`, not a new one.

---

## Observations

1. **Direct session auto-resume behavior** — The design doc noted that `init()` would try to auto-resume direct sessions. In practice, the direct session was already `stopped` in `sessions.json` (echo hello had exited before SIGKILL), so no auto-resume was triggered. The final status was correctly `stopped`.

2. **Tmux re-attachment is instant** — The server found and attached to the existing tmux session within the server startup window, before the API health-check passed.

3. **No data loss** — No session records were lost through the SIGKILL cycle.

---

## Screenshots

Saved to `qa-screenshots/T-17-server-restart/`:
- `01-pre-kill-sessions-api.json` — API state before SIGKILL
- `02-post-restart-sessions-api.json` — API state after restart
- `03-browser-sessions-area.png` — Browser baseline
- `03b-after-project-select.png` — After project selected in sidebar
- `04-direct-session-card.png` — Direct session showing "⏹ stopped"
- `05-tmux-session-card.png` — Tmux session showing "▶ running"
- `06-after-refresh.png` — Direct session after Refresh clicked
- `07-final-state.png` — Final state

---

## Verdict

**PASS** — No fixes required. The server correctly handles SIGKILL by: persisting session data before the kill, detecting tmux session survival on restart, and maintaining `claudeSessionId` integrity throughout.
