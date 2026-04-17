# Session 3 — 2026-04-17 — Session Death Investigation

## Symptom reported

User saw tmux pane `[exited]` appearing in the browser terminal at erratic intervals.
"It just said exited" / "even while I was typing" / "the timing seems erratic."
Both running sessions were affected. Timing was not fixed (not every 30s, not every 5min).

---

## Investigation path

**Ruled out:**
- 30-second WatchdogManager tick (summarizeSession is read-only, can't kill panes)
- WS reconnect causing blank (was a symptom of the real issue, not the cause)
- Claude CLI built-in timeout (strings in binary show "WebSocket timed out from inactivity" but doesn't apply here)
- `remain-on-exit` pane death (tmux daemon was independent of server crashes)

**Found:** crash.log (from `server-with-crash-log.mjs`) showed repeated SIGTERMs:
```
[2026-04-17T11:40:44.429Z] SIGTERM received — server exiting (pid=1595488)
[2026-04-17T11:44:57.856Z] SIGTERM received — server exiting (pid=1753882)
[2026-04-17T11:46:52.136Z] SIGTERM received — server exiting (pid=1759390)
```

**Source of SIGTERMs:** PM2 daemon (PID 162466 — parent of both server processes). Confirmed via:
```
ps -p 1744256 -o pid,ppid,command
# → PPID = 162466 = PM2 v6.0.14 God Daemon
```

**Root cause of PM2 cascade:** During debugging, `node server-with-crash-log.mjs` was
started manually (outside PM2) to test rollbacks. This held port 3001 while PM2's
managed process also tried to start → EADDRINUSE → rapid restart loop.

PM2 `claude-v2-prod` had **1173 restarts** (created Apr 16, confirming many prior restarts).
Each failed start corrupted `sessions.json` mid-write (non-atomic `writeFile`).

---

## Why tmux sessions survive server crashes

`tmux show-options -g destroy-unattached` → `off`

When node-pty dies with the server, `tmux attach-session` loses its PTY master → gets
SIGHUP → exits (detaches as client). The tmux daemon keeps the session alive.

On server restart, `SessionManager.init()` loads sessions.json and for each RUNNING
TmuxSession calls `_attachPty()`. If the tmux session is alive → PTY reconnects. If dead
→ marks STOPPED. No `tmux kill-session` is called during normal restart.

---

## What was actually dead vs alive after the cascade

- `cm-6657b58f` (questions session — this Claude Code conversation): **tmux ALIVE** ✓  
  Re-attached after server restart. Browser could subscribe to it.
- `cm-020f1c8c` (bugfixv2): **tmux DEAD** ✗  
  Killed during the crash cascade (likely `tmux kill-session` from a manual restart step).

---

## Fixes applied

### 1. Atomic sessions.json writes (committed `dae3235`)

`lib/sessions/SessionStore.js` — write to `.tmp` then `rename()` atomically.

```js
// Before (broken — truncates file if server killed mid-write):
await writeFile(this.sessionsFile, JSON.stringify(metas, null, 2), 'utf8');

// After (atomic — rename is POSIX-guaranteed atomic):
const tmp = this.sessionsFile + '.tmp';
await writeFile(tmp, JSON.stringify(metas, null, 2), 'utf8');
await rename(tmp, this.sessionsFile);
```

### 2. Code rollback reverted

Three rollback levels were applied earlier in the session trying to find a regression.
Rollbacks removed the scrollback replay fix from `e2d16c6` without fixing anything
(the problem was infrastructure, not app code). Code restored to HEAD (`3f139c0`).

### 3. `remain-on-exit` turned off

Set to `on` during debugging — caused `[exited]` text to appear in tmux pane scrollback
when PTYs reconnected, surfacing in the browser terminal as a ghost `[exited]` string.

```bash
tmux set-option -g remain-on-exit off
```

Note: this was NOT in `~/.tmux.conf` — just an in-memory tmux server setting. Will reset on tmux server restart.

---

## Infrastructure state

| App | Port | PM2 name | Restarts (total) | Status |
|-----|------|----------|-----------------|--------|
| v2 prod | 3001 | `claude-v2-prod` (id=1) | 1175 | Running (PID 1805175) |
| v2 beta | 3002 | `claude-v2-beta` (id=2) | 53 | Running (PID 1594691) |
| v1 | 3000 | `claude-web-app` (id=0) | 2194 | Running (PID 1884753) |

Both v2 prod and beta run `server-with-crash-log.mjs` from `/home/claude-runner/apps/claude-web-app-v2`.
`DATA_DIR` env: prod → `data/`, beta → `data-beta/`.

---

## Critical operational rules

**Never start the server manually outside PM2.**

```bash
# WRONG — holds the port, causes PM2 cascade:
node server-with-crash-log.mjs
node server.js

# RIGHT:
pm2 restart claude-v2-prod
pm2 logs claude-v2-prod --lines 50
pm2 show claude-v2-prod
```

If port 3001 is stuck after a manual start:
```bash
lsof -i :3001           # find the non-PM2 process
kill <that-pid>          # kill it
# PM2 will restart automatically
```

---

## Open items / backlog (carry forward)

### Inherited from session 2
- **Live demo of refresh-typing fix**: "restart" session in v2 couldn't restart (low-power mode). Use a fresh bash session to demo instead.
- **Session card click quirk**: `.session-card-preview` has `e.stopPropagation()` — click `.session-card-name` to open overlay.
- **Tmux session cleanup**: Old debug sessions (`focus-test-*`, `fix-test-*`, `dbg-*`, `scrollback-test-*`, `ws-fix*`) are safe to kill.

### New from this session
- **Original root cause unresolved**: The sessions-dying complaint predates today's debugging session. The Apr 16 PM2 restarts (02:52–03:07) were from development work. Whether there was a separate pre-existing bug is unknown — the crash cascade from this session's work obscured any prior pattern.
- **`remain-on-exit` not persisted**: The `tmux set-option -g remain-on-exit off` was applied to the running tmux server but not written to `~/.tmux.conf`. If tmux restarts, the option resets to whatever the default is (likely `off`). No action needed unless panes start staying visible after exit.
- **HANDOVER.md**: This file exists as an untracked file in the repo root. Was written by a previous session but never committed. It describes bug investigation approach for the black-box flash and blank-terminal-on-switch issues. Content is superseded by git commits `3f139c0` and `e2d16c6`. Safe to delete or commit.

---

## Key conventions confirmed (same as session 2)

- Port map: v1=3000, v2-prod=3001, v2-beta=3002
- PM2 is the only correct way to manage the server
- Chromium: `/home/claude-runner/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome`
- `\r` (not `\n`) for PTY input submission to Claude Code TUI
- xterm DOM rows only work with DOM renderer — use screenshots or WS sniffing for Playwright tests
