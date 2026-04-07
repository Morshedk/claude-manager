# v2 Build Progress

**Goal:** Full rewrite with snapshot-based scrollback (eliminates dot/artifact bug)  
**v2 port:** 3001 | **v1 port:** 3000 (kept running until evaluation passes)

---

## Phases

| Phase | Description | Status | Notes |
|-------|-------------|--------|-------|
| 0 | Scaffolding | ✅ Done | 52 files, server starts, syntax clean |
| 1A | ProjectStore | ✅ Done | ESM port + tests — 39 tests passing |
| 1B | SettingsStore | ✅ Done | ESM port + tests — 32 tests passing |
| 1C | TerminalManager | ✅ Done | ESM port + tests — 29 tests passing |
| 1D | ProcessDetector | ✅ Done | ESM port + tests (18/18 passing) |
| 2a | sessionStates.js | ✅ Done | Implemented in scaffolding |
| 2b | SessionStore | ✅ Done | Persistence layer — 18 tests passing |
| 2c | DirectSession | ✅ Done | headless xterm + serialize — 24 tests passing |
| 2d | TmuxSession | ✅ Done | capture-pane snapshot — 48 tests passing |
| 2e | SessionManager | ✅ Done | Orchestration — 40 tests passing |
| 3A | REST API routes | ✅ Done | Full v1 port — 25 endpoints, security checks, ESM |
| 3B | Session WS handlers | ✅ Done | SessionHandlers class — subscribe/create/input/resize/stop/restart/delete |
| 3C | Terminal/system WS handlers | ✅ Done | makeTerminalHandlers + makeSystemHandlers factories; server wired with real managers; 307 tests passing, server starts cleanly |
| 4 | TodoManager | ✅ Done | ESM port + tests — 59 tests passing |
| 5A | WS client + state store | ✅ Done | connection.js + store.js + actions.js + sessionState.js |
| 5B | Core UI components | ✅ Done | App, TopBar, ProjectSidebar, ProjectDetail, SessionCard, ToastContainer, full CSS port |
| 5C | TerminalPane + SessionOverlay | ✅ Done | TerminalPane + SessionOverlay + ProjectTerminalPane |
| 5D | Secondary UI panels | ✅ Done | FileBrowser, TodoPanel, SettingsModal, NewSessionModal, WatchdogPanel |
| 6A | Review: session core | ✅ Done | Fixed 3 bugs: (1) stateChange event field mismatch (TmuxSession emitted `status` instead of `state`), (2) TmuxSession.addViewer double-sent snapshot via viewer callback AND subscribe protocol, (3) subscribe race condition — snapshot now captured before viewer registration. 306 tests passing. |
| 6B | Review: terminal frontend | ✅ Done | Fixed 5 bugs: WS msg field mismatch (sessionId→id), double-subscribe on attach, dead terminal after reconnect, esm.sh dual-preact instances, missing session:restarted handler. Removed dead useScrollControl hook. Snapshot flow, Unicode11 order, renderer fallback, DA filter, ResizeObserver all correct. |
| 6C | Integration tests | ✅ Done | 62 tests passing (15 WS protocol + 47 session lifecycle) |
| 6D | E2E Playwright scrollback | ✅ Done | v2: PASS — no dot artifacts after restart; fixed loadSessions() to handle {managed,detected} API shape |
| 7A | WatchdogManager | ✅ Done | 77 tests passing |
| 7B | Review: watchdog | ✅ Done | Fixed: server.js missing todoManager/settingsStore/dataDir in WatchdogManager ctor; atomic state writes confirmed; shell injection mitigated via JSON.stringify; restart-loop backoff present; 77/77 tests pass |
| 8 | Evaluation v1 vs v2 | ✅ Done | SWITCH TO v2 — bug fixed, feature parity, 507 tests passing, 10/10 review bugs confirmed fixed |

---

## Key Design Decision: Scrollback Fix

**Problem:** v1 stores raw PTY bytes → replays them → dot artifacts  
**Fix:** Never replay raw bytes. Send a rendered snapshot instead:

- **tmux sessions:** `tmux capture-pane -p -e -J -S -` on subscribe → rendered ANSI text  
- **Direct sessions:** server-side headless xterm mirrors PTY → `serialize()` on subscribe  
- Client receives `session:snapshot` (clean), then `session:output` (live stream)

---

## v1 Dots Bug — Test Status

- Test skill was launched but output was lost during plan mode context switch
- **Re-running now** (background)
