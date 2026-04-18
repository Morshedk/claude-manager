# Release History — claude-web-app-v2

Two environments:
- **Prod** — port 3001, PM2 process `claude-v2-prod`. Stable releases only.
- **Beta** — port 3002, PM2 process `claude-v2-beta`. New features and fixes land here first.

---

## v2.02 — 2026-04-18

**Released to beta:** 2026-04-18
**Released to prod:** 2026-04-18

### New features
- **Terminal copy-to-clipboard** — Ctrl+C / Cmd+C copies selected text instead of sending
  SIGINT when text is highlighted. Ctrl+Shift+C always copies (Linux convention). Right-click
  copies selection and suppresses the browser context menu. Failed clipboard writes show an
  error toast.
- **Clipboard image paste** — Ctrl+V with an image on the clipboard saves it to
  `/tmp/claude-paste-<timestamp>.png` and types the file path into the terminal so Claude
  can read it directly. Text pastes are unaffected.
- **Always-visible terminal scrollbar** — scrollbar is now permanently visible (6px,
  `rgba(255,255,255,0.2)`) rather than only appearing on hover.

### Bug fixes
- **Session events log — missing spaces** — Claude Code renders spaces as `ESC[1C`
  (cursor-forward-1) rather than literal 0x20. The ANSI stripper now converts `ESC[NC` to N
  spaces, so word spacing is preserved in the events log.
- **Session events log — greedy escape catch-all** — the previous `\x1b[^\x1b]*` fallback
  regex could eat entire lines of text if an unrecognised escape sequence appeared mid-line.
  Replaced with `\x1b.` (two-char sequences only).
- **Terminal scroll sensitivity** — raised from 1 line/event to 3 (fast: 5→10) so scrolling
  back through output is not sluggish.

---

## v2.01 — 2026-04-17

**Released to beta:** 2026-04-17  
**Released to prod:** 2026-04-17

### New features
- **Session Events viewer** — every tmux session now writes a persistent `.log` file capturing
  all terminal output (ANSI-stripped, timestamped every 20s). Lifecycle transitions (PTY
  attach/detach, session stop/resume/kill, server start/crash) are injected inline as
  `=== EVENT ===` markers. Click **Events** in the session overlay header to open a
  split panel showing the log alongside the terminal. Download the full log via the ↓ button.
  API: `GET /api/sessionlog/:id/tail`, `/full`, `/status`.

### Bug fixes
- **Blank terminal on session switch-back** — tmux capture-pane scrollback now replays
  correctly when switching between sessions. PTY re-attach on `getScrollback()` was
  causing xterm to render a blank screen.
- **Black-box canvas flash** — xterm.js WebGL canvas no longer flashes as a dark box in
  the top-left corner when opening or switching sessions. Fix: fit before open, not after.
- **sessions.json corruption on crash** — writes are now atomic (write to `.tmp`, then
  rename) so a server crash mid-write no longer corrupts the session store.
- **Refresh on stopped-but-tmux-alive session** — a session showing `stopped` in the UI
  while the tmux process was still running now correctly transitions to `running` on refresh.
- **File manager restored** — file browser split-pane re-enabled after regression.

### Infrastructure
- Playwright config fixed — Jest-based adversarial tests removed from `testMatch` (they
  run under `npm test`, not Playwright). Suite now collects 136 browser tests correctly.
- Version tracking started (this file).

---

## v2.0.0 — 2026-04-09

**Released to beta:** 2026-04-07 (iterative)  
**Released to prod:** 2026-04-09

Initial v2 release. Full rewrite from v1.

### Core features
- **Dual session modes** — Direct (spawns claude process directly) and Tmux (claude inside
  a named `cm-<uuid8>` tmux session; survives server restarts and browser disconnects).
- **Project management** — create/edit/delete projects with filesystem path, name validation,
  autocomplete.
- **Session management** — create, stop, refresh (reconnect/resume), delete. Sessions persist
  across server restarts in `data/sessions.json`.
- **Live terminal streaming** — xterm.js v5.5.0 with WebGL renderer, FitAddon, Unicode11.
  PTY output streamed over WebSocket in real-time.
- **Split view** — session overlay can be split so the session list stays visible alongside
  the terminal.
- **Watchdog** — background agent polls running Claude sessions every 5 minutes, injects
  prompts to keep work moving. Configurable via Settings.
- **WatchdogPanel** — status display showing watchdog enabled/disabled, model, interval,
  last tick, recent log entries.
- **Todo manager** — per-session todo lists with priority filtering. TodoPanel accessible
  from the project detail view.
- **lastLine pipeline** — most recent terminal output line shown on session cards and
  broadcast via WebSocket for live updates.
- **Overlay auto-open** — creating a new session automatically opens the terminal overlay.
- **Telegram integration** — optional Telegram bot notifications for session events.
  Configurable via Settings.
- **File manager** — split-pane file browser for exploring project directories alongside
  the terminal (phase 1: browse + view).
- **Settings** — persistent settings (model, watchdog config, Telegram, theme) stored in
  `data/settings.json`.
- **DA2/OSC/mouse escape filter** — terminal input handler strips cursor-query and mouse
  event escape sequences before forwarding to PTY.

### Bug fixes (pre-prod, on beta)
- Typing after Refresh works without clicking the terminal first (focus auto-wire fix).
- Double-click "Start Session" no longer creates duplicate sessions.
- Refresh on non-Claude (bash) sessions works correctly.
- xterm.reset() on refresh clears stale buffer before tmux replay.
- UX: project name validation, overflow, autofocus on modals.
- Watchdog error event no longer crashes the server.
- Terminal width mismatch on subscribe (use fitted dimensions, not defaults).
