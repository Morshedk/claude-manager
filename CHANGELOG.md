# Changelog

All notable changes to claude-web-app-v2 are recorded here.
Format: newest first. Each push to beta/prod that adds user-visible changes gets an entry.

---

## [Unreleased] — on main, not yet promoted

### Added
- **Session recovery API** — `POST /api/sessions/recover` scans tmux for orphan `cm-*` sessions and adopts them back into the server. Scoped per server via `session-lifecycle.json` so prod and beta don't cross-contaminate. Also re-attaches tracked sessions incorrectly marked stopped while tmux is alive
- **Watchdog session audit** — WatchdogManager tracks all session names, tmux names, and Claude session IDs on every tick; alerts to activity log when a session is RUNNING with no connected viewers (1-hour dedup); hourly sweep auto-archives and deletes sessions inactive 7+ days (1 day for TTT test sessions); Telegram-connected sessions are excluded from cleanup; `sessionsListChanged` event triggers live WS broadcast after sweep
- **Embedded session name in tmux names** — tmux sessions are now named `cm-<id8>-<slug>` (e.g. `cm-ab12cd34-my-project`), making the session name recoverable from `tmux ls` without relying on sessions.json
- **TTT test convention in `/test` skill** — test sessions must use `TTT` suffix; skill enforces collision check before starting and cleans up all TTT sessions after
- **Reconnect diagnostics** — connection log now records reconnect attempts with timestamp and reason
- **Pulse system metrics** — TopBar shows live CPU, RAM, and disk usage via `/api/watchdog/state`
- **CommandBuffer** — latency-free terminal input: keystrokes are buffered locally and flushed on send, preventing round-trip lag on slow connections
- **Events bottom tab** — session events panel moved to a bottom tab to avoid shrinking terminal width

### Fixed
- **Sessions lost on server save** — `SessionStore.save()` now merges externally-added entries from disk instead of blindly overwriting them with the in-memory Map

---

## [v2.03] — 2026-04-19

### Added
- **Behavior enforcement hooks** — PreToolUse/Write|Edit hook blocks direct source edits on main; ADR system in `docs/decisions/`; session journal written on Stop
- **Burn rate chart** — WatchdogPanel shows per-session cost lines with 6h x-axis ticks and 10-day window
- **HTML/Markdown preview** — file manager shows Source/Preview toggle for `.html` and `.md` files
- **Copy button in SessionLogPane** — uses shared clipboard utility with `execCommand` fallback for non-HTTPS environments
- **Third space unified tab bar** — terminals, files, and todos share a single tab bar; clickable file paths in session log and terminal open FileBrowser in third space
- **xterm link provider** — file paths in the terminal are clickable and open the file browser
- **tmux as default session mode** — new sessions default to tmux instead of direct

### Fixed
- tmux capture-pane `\n` → `\r\n` to prevent xterm scrollback garbling
- `tmux resize-window` called before `capture-pane` so scrollback is captured at correct dimensions
- xterm fit() timing — microtask re-fit + split-pos pre-init
- Terminal scrollbar visibility, session-switch flash, selection highlight
- `stripAnsi` — cursor-forward converted to spaces; bare CR becomes newline; greedy catch-all fixed
- Session log filters: Unicode spinner prefixes, Claude Code animation fragments, cursor-movement sequences
- Clipboard copy works in non-HTTPS (HTTP) environments via `execCommand` fallback

---

## [v2.02] — 2026-04-18

### Added
- **WatchdogPanel** — session breakdown tiles, burn-rate sparkline, credit snapshot (burn rate, block cost, projection, today's spend)
- **Credit history** — `GET /api/watchdog/credit-history`; rolling history persisted to disk
- **`checkCcusage()`** — billing block snapshot wired into watchdog tick
- **Paste clipboard image into terminal** — images pasted from clipboard are saved as files and the path is inserted into the terminal
- **Terminal copy-to-clipboard** — selection copy + always-visible scrollbar
- **Reconnect button** — clickable reconnect button in TopBar when disconnected
- **PROD/BETA badge** — TopBar shows full version and environment label
- **Scroll sensitivity** — increased terminal scroll speed (1→3, fast 5→10)

### Fixed
- ccusage binary path resolved at startup; `find` used to locate in npx cache (handles symlinks)
- Session log filters: spinner/status lines, blank lines
- Credit history resets to `[]` on fetch error (no stale state)
- Watchdog settings wiring: `intervalMinutes`, `model`, flags

---

## [v2.01] — 2026-04-17

### Added
- **Session events log** — `SessionLogPane` polls session events with timestamps styled as muted `HH:MM:SS` prefix
- **Events toggle in SessionOverlay** — split-panel view showing events alongside the terminal
- **Tmux scrollback capture on server restart** — PTY log catches up on reconnect
- **Session log persisted to disk** — `data/sessionlog/` directory (gitignored)
- Ctrl+V in xterm key handler enables image paste

### Fixed
- `SessionStore.save()` uses unique tmp filename to prevent concurrent-save ENOENT
- Spinner/status-line noise filtered from session log tail
- xterm viewport scroll and scrollbar visibility restored
- `DA2`/`OSC`/mouse escape sequences filtered from xterm input
- Typing after Refresh works without clicking terminal

---

## [v2.00] — 2026-04-09

Initial release of v2 — full rewrite of the web terminal app.

### Architecture
- Node.js/ESM server with WebSocket protocol for live terminal streaming
- **TmuxSession** — Claude runs inside a named tmux session; survives server restarts; PTY attached via `node-pty`
- **DirectSession** — lightweight PTY-only mode (no tmux)
- **SessionStore** — atomic JSON persistence with crash-safe tmp→rename writes
- **WatchdogManager** — periodic health checks, session summarization, credit monitoring
- **ProjectStore** — project metadata with filesystem CWD validation

### Features
- Multi-session management: create, switch, stop, resume sessions
- tmux natural PTY replay on re-attach (scrollback preserved)
- Refresh flow: re-attaches live tmux or recreates dead session with `--resume`
- Session events log infrastructure (lifecycle events)
- WatchdogPanel with basic session health overview
- Terminal resize synced to tmux window dimensions
- PM2-managed servers: `claude-v2-prod` (port 3001) and `claude-v2-beta` (port 3002)
- Git worktree layout: main/beta branches in separate directories
