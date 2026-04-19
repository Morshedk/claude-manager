# Design: Tmux Default, Third Space Tabs, Clickable Filepaths, Scroll Fix

**Date:** 2026-04-18  
**Branch:** qa/2026-04-18-no-timestamps-in-events-log  
**Status:** Approved

---

## Overview

Six focused changes to the web app UI and session defaults:

1. Make tmux the default session type
2. Redesign the "third space" (below the sessions list) as a unified tab bar
3. Wire up the `+` button to create new terminal tabs
4. Make file paths in terminal output clickable — opens the Files tab
5. Style session event timestamps to be more visually distinct
6. Fix mouse scroll and missing scrollbar in terminal

---

## 1. Tmux as Default

**Problem:** Both the server and the new session modal default to `'direct'` mode. Users have to manually switch to tmux every time.

**Change:**
- `lib/sessions/SessionManager.js:133` — change `mode = 'direct'` to `mode = 'tmux'` in the `create()` param default
- `public/js/components/NewSessionModal.js:46` — change the fallback from `'direct'` to `'tmux'`

**Constraints:**
- Existing sessions keep their current `meta.mode` — no migration
- The modal still allows users to switch to direct manually

---

## 2. Third Space Unified Tab Bar

**Mental model:** The area below the sessions list is a "project workspace" — not sessions, not the active terminal overlay. It holds everything project-adjacent: raw terminals, file manager, todos.

**Current state:** A terminals bar with a dead `+` button, plus Todos and Files living as tabs in the upper tab row (alongside Sessions and Watchdog).

**New state:** The third space gets a unified tab bar:

```
[+]  [Terminal 1 ×]  [Terminal 2 ×]  [Files]  [Todos]
─────────────────────────────────────────────────────
  active tab content
```

- `+` creates a new Terminal tab (dynamic, closeable with ×)
- `Files` and `Todos` are permanent tabs — always present, not closeable
- Only one tab is active at a time; its content fills the panel below
- If no terminal tabs exist, `Files` is active by default
- The upper tab row simplifies to: `Sessions | Watchdog`

**Tab bar component:** Extract into a new `ThirdSpaceTabBar` component or handle inline in `ProjectDetail.js`. Given the complexity, a dedicated component is cleaner.

**Active tab state:** Stored as a signal in `ProjectDetail` — either `'files'`, `'todos'`, or a terminal ID string.

---

## 3. Wire the `+` Button

**Problem:** `#btn-new-terminal` has no click handler. The `terminal:create` WS message type and `ProjectTerminalPane` component already exist — just not connected.

**Flow:**
1. Click `+` → send `terminal:create` WS message `{ projectId, cwd: project.path }`
2. Server (`TerminalManager`) creates PTY, responds with `terminal:created { terminalId }`
3. Client adds a new terminal tab and switches to it
4. `ProjectTerminalPane` mounts for that `terminalId`
5. Terminal tab shows a close button (×); clicking it sends `terminal:destroy` and removes the tab

**Split mode:** Works automatically — ProjectDetail (left panel) is always visible in split mode; the third space is part of it.

**Tab label:** "Terminal" + sequential number (Terminal 1, Terminal 2, …). Numbers don't reuse within a session.

---

## 4. Clickable Filepaths

**Problem:** File paths appear as plain text in terminal output and event logs. Users have to manually navigate to them in the file manager.

**Scope:** Terminal output rendered in `TerminalPane` (xterm.js). Event log entries in the session events panel.

**Detection:** Apply a regex to detect file paths before rendering as plain text:
- Absolute paths: `/` followed by at least one path segment (e.g. `/home/user/project/src/file.js`)
- Tilde paths: `~/...`
- Conservative — only linkify strings that unambiguously look like file paths (not URLs, not flags like `--no-verify`)

**Pattern (approximate):**
```
/(\/[\w.\-/]+\.\w+|~\/[\w.\-/]+)/g
```

**On click:**
1. Switch third space to the `Files` tab
2. Call `FileBrowser.navigateTo(path)` — navigate directory listing to the file's parent, select the file

**xterm.js note:** xterm doesn't support inline HTML. Use xterm's `linkProvider` API (or the `@xterm/addon-web-links` pattern) to register a custom link matcher for file paths. For event logs (plain HTML), wrap detected paths in `<a>` tags at render time.

---

## 5. Session Event Timestamp Styling

**Problem:** Timestamps in the session events log blend in with content — hard to scan.

**Change:** Style timestamps with:
- Smaller font size (10–11px vs 12px body)
- Muted color (`var(--text-muted)` / ~`#666`)
- Monospace font to align columns
- Optional: subtle `|` or `·` separator between timestamp and content

Implementation: CSS class `.event-timestamp` applied to the timestamp `<span>` in the events renderer.

---

## 6. Terminal Scroll Fix

**Problem:** Mouse scroll stopped working in the terminal, and the scrollbar has disappeared.

**Likely cause:** xterm.js `scrollback` option reset, or the terminal container lost its overflow CSS, or a recent change disabled the xterm `ScrollbarAddon` / native scrollbar styles.

**Fix approach:**
1. Audit `TerminalPane.js` — verify `scrollback` option is set (e.g. `scrollback: 1000`)
2. Check `styles.css` for the `.xterm-viewport` / `.xterm-scroll-area` rules — ensure `overflow-y: scroll` is intact
3. Ensure xterm terminal `options.scrollOnUserInput` is not inadvertently set to false
4. Re-enable scrollbar visibility if it was hidden by a recent style change

---

## Backlog (out of scope for this branch)

- **Move Watchdog to global** — currently a per-project tab but is instance-wide; belongs in topbar or global settings
- **Mouse wheel scroll toggle** — user preference to enable/disable wheel scrolling in the terminal
- **Copy/paste from terminal + session events** — selection and clipboard support
- **Session events recording while disconnected** — persist event stream server-side even when no client is connected

---

## Files to Change

| File | Change |
|------|--------|
| `lib/sessions/SessionManager.js` | Default mode → `'tmux'` |
| `public/js/components/NewSessionModal.js` | Default fallback → `'tmux'` |
| `public/js/components/ProjectDetail.js` | Third space tab bar, active tab state, remove Todos/Files from upper tabs |
| `public/js/components/TerminalPane.js` | Clickable filepath link provider, scroll fix |
| `public/js/ws/client.js` (or equivalent) | Handle `terminal:created` response |
| `public/css/styles.css` | Timestamp styling, tab bar styles, scroll/scrollbar fix |

**New component (optional but recommended):**
- `public/js/components/ThirdSpaceTabBar.js` — encapsulates the `+` button, tab rendering, active state

---

## Success Criteria

- New sessions default to tmux without any user action
- Third space shows a unified tab bar; clicking Todos/Files/Terminal tabs switches content
- Clicking `+` opens a new working terminal tab
- File paths in terminal output and event logs are clickable and navigate the Files tab
- Event timestamps are visually distinct and easy to scan
- Mouse scroll works in terminal; scrollbar is visible
