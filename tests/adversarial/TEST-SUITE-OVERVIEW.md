# Adversarial Test Suite — Overview

> Last updated: 2026-04-24
> Baseline: **140 pass / 99 fail** (of ~239 tests across 148 test files)

## Purpose

This suite is an **adversarial** test collection — every test is written to find real bugs, not to pass. A false PASS is treated as worse than a false FAIL. Tests are run against an isolated in-process server (ephemeral port + temp data dir) so they never touch production data.

The suite covers:

- Category A–G: deep unit/integration tests of server internals (lifecycle, WS protocol, reconnect, watchdog, edge cases)
- T-01 through T-52: full Playwright browser-level UI regression tests
- feat-* series: per-feature test suites written at the time each feature shipped
- B-rendering: 25 xterm.js rendering adversarial scenarios
- da-osc-filter, refresh-bug, qa-black-box: targeted regression groups

---

## Test File Table

### Category Tests (A–G): Server internals, no browser

| Filename | What it tests | Category |
|----------|---------------|----------|
| `A-lifecycle.test.js` | Session state machine transitions (create → running → stopped → deleted), restart behavior, orphan cleanup | Server/unit |
| `B-rendering.test.js` | 25 xterm.js rendering scenarios: mount, fitAddon, reset on subscribe, CJK/emoji/ANSI, scroll, resize, alt-screen, DA filter, multi-session isolation | Rendering (Playwright) |
| `C-ws-protocol.test.js` | 30 raw WebSocket protocol scenarios: subscribe ordering, double-subscribe, disconnect without unsubscribe, message framing | Server/WS |
| `D-reconnect.test.js` | Browser reload persistence, WS reconnect, session survival, state recovery after server bounce | Reconnect (Playwright + WS) |
| `E-watchdog.test.js` | 25 WatchdogManager unit tests: stuck detection, recovery attempts, threshold logic, state transitions | Server/unit |
| `F-bug-reproductions.test.js` | Regression tests for specific historic bugs (e.g., dead New Project button stub) | Regression |
| `F-lifecycle.test.js` | Extended lifecycle scenarios: rapid create/delete, concurrent sessions, cleanup races | Server/unit |
| `G-edge-cases.test.js` | Edge cases: 1MB/10MB input, 20 concurrent creates, malformed WS frames, very long session names | Server/WS |

### T-Series Tests (T-01 – T-52): Full Playwright UI flows

| Filename | What it tests | Category |
|----------|---------------|----------|
| `T-01-double-click.test.js` | Double-clicking Open does not open two overlays | UI behavior |
| `T-02-browser-reload.test.js` | Sessions persist and re-appear after full browser reload | UI behavior |
| `T-03-refresh-artifacts.test.js` | Clicking Refresh does not leave stale terminal artifacts | UI behavior |
| `T-04-stop-kills-process.test.js` | Stop button actually kills the PTY process | UI behavior |
| `T-05-resume-on-refresh.test.js` | Refresh button reconnects to live session without restarting it | UI behavior |
| `T-06-ws-reconnect.test.js` | WS reconnect restores session list without page reload | UI behavior |
| `T-07-invalid-command-error.test.js` | Invalid command shows error state, not spinner | UI behavior |
| `T-08-bad-project-path.test.js` | Project with non-existent path shows error on session create | UI behavior |
| `T-09-settings-persist.test.js` | Settings changes survive page reload | UI behavior |
| `T-10-sidebar-badge.test.js` | Sidebar shows running/stopped badge counts correctly | UI behavior |
| `T-11-first-5-minutes.test.js` | First-run UX: project creation, session creation, Haiku quick-cmd button | UI behavior |
| `T-12-tmux-survives-close.test.js` | Tmux session survives browser tab close and reconnects | UI behavior (tmux) |
| `T-13-project-name-validation.test.js` | Project name field rejects empty/too-long names | UI behavior |
| `T-14-delete-cancel.test.js` | Delete confirmation cancel does not delete session | UI behavior |
| `T-15-scroll-freeze.test.js` | Terminal does not freeze scroll when user has scrolled up | UI behavior |
| `T-16-refresh-during-starting.test.js` | Refresh during "starting" state does not create duplicate session | UI behavior |
| `T-17-server-restart-recovery.test.js` | UI recovers cleanly after server process restart | UI behavior |
| `T-18-project-switch-race.test.js` | Rapid project switching does not show sessions from wrong project | UI behavior |
| `T-19-lastline-updates.test.js` | Last-line preview on session card updates as new output arrives | UI behavior |
| `T-20-two-tabs-refresh.test.js` | Two browser tabs stay in sync when one refreshes a session | UI behavior |
| `T-21-low-credit-mode.test.js` | Low-credit mode uses lcModel command for new sessions | UI behavior |
| `T-22-delete-with-overlay.test.js` | Deleting a session while its overlay is open closes the overlay | UI behavior |
| `T-23-telegram-unconfigured.test.js` | Telegram feature is disabled with explanation when not configured | UI behavior |
| `T-24-watchdog-500.test.js` | Watchdog panel shows 500-entry cap correctly | UI behavior |
| `T-25-paste-large-input.test.js` | Pasting 100KB of text into terminal does not hang or crash | UI behavior |
| `T-26-split-view.test.js` | Split-screen view renders both panes without overlap | UI behavior |
| `T-27-resize-pty.test.js` | Resizing the browser window sends PTY resize to server | UI behavior |
| `T-28-no-delete-while-running.test.js` | Delete button absent on running session card; Stop button present | UI behavior |
| `T-29-telegram-badge-reload.test.js` | Telegram badge survives page reload | UI behavior |
| `T-30-tmux-pid-unchanged.test.js` | Tmux session PID unchanged after Refresh (no restart) | UI behavior (tmux) |
| `T-31-settings-cancel.test.js` | Settings modal cancel discards unsaved changes | UI behavior |
| `T-32-empty-state.test.js` | Empty project shows correct "No sessions" message; area title contains project name | UI behavior |
| `T-33-todo-empty-title.test.js` | Todo panel blocks submission of empty title | UI behavior |
| `T-34-todo-filters.test.js` | Todo priority filter shows/hides items correctly | UI behavior |
| `T-35-concurrent-sessions.test.js` | 5 concurrent sessions all reach running state without interference | UI behavior |
| `T-36-restart-starting-state.test.js` | Session in "starting" state recovers after server restart | UI behavior |
| `T-37-ws-drop-replay.test.js` | Output replay on reconnect does not duplicate lines | UI behavior |
| `T-38-sidebar-scale.test.js` | Sidebar renders correctly with 20+ projects | UI behavior |
| `T-39-corrupted-sessions.test.js` | Corrupted sessions.json does not crash server on load | UI behavior |
| `T-40-special-char-names.test.js` | Session names with special characters render without XSS or garbling | UI behavior |
| `T-41-upload-interrupt.test.js` | File upload interruption does not leave UI in broken state | UI behavior |
| `T-42-badge-independence.test.js` | Running badge count is per-project, not global | UI behavior |
| `T-43-haiku-endurance.test.js` | 20-message Claude haiku conversation with 5x Refresh and 3x Reload | Claude-API-required |
| `T-44-watchdog-badge.test.js` | Watchdog badge appears when session is stuck | UI behavior |
| `T-45-stop-refresh-race.test.js` | Clicking Stop then Refresh immediately does not cause double-start | UI behavior |
| `T-46-ws-reconnect-session.test.js` | WS reconnect after network drop resumes session output | UI behavior |
| `T-47-session-cards-layout.test.js` | 10 session cards render without zero-height, overflow, or clipped buttons | UI behavior |
| `T-48-settings-escape.test.js` | Pressing Escape closes settings modal | UI behavior |
| `T-49-auth-fail-graceful.test.js` | Auth failure shows error message, not blank screen | UI behavior |
| `T-50-concurrent-refresh.test.js` | 3 concurrent Refresh clicks do not produce duplicate sessions | UI behavior |
| `T-51-refresh-typing.test.js` | Refresh while typing in terminal does not drop keystrokes | UI behavior |
| `T-52-session-switch-no-garble.test.js` | Switching sessions does not show previous session's output in new terminal | UI behavior |

### feat-* Series: Per-feature regression suites

| Filename prefix | Feature area | Category |
|-----------------|--------------|----------|
| `feat-delete-toggle-T1–T9` | Delete-mode toggle, armed state, log cap, Telegram card summary | UI behavior |
| `feat-file-manager-T1–T8` | File manager: image new-tab, split drag, markdown render, XSS, path resolution, REST routing | UI behavior |
| `feat-lastline-T1–T6` | Last-line preview: appears, ANSI stripped, updates, WS broadcast, blank preserved, throttle | UI behavior |
| `feat-move-session-T1–T6` | Move/rename session: different project, rename-only, multi-client sync, invalid ids, browser UI, rapid submit | UI behavior |
| `feat-overlay-auto-open-T1–T4` | Overlay auto-opens after session create, correct session, no reopen on reload, rapid creates | UI behavior |
| `feat-paste-image` | Paste image via clipboard into terminal | UI behavior |
| `feat-reconnect-status-indicator-T1–T4` | Reconnect status dot: not clickable when connected, click triggers reconnect, same-origin safety, rapid clicks | UI behavior |
| `feat-session-cards-T1–T7` | Session cards: DOM structure, preview update, watchdog summary, settings preview count, ANSI strip, wrench modal, btn CSS regression | UI behavior |
| `feat-split-screen-ux-T1–T6` | Split screen: path dropdown, default split, drag persist, scrollbar hover, resize handles, poisoned localStorage | UI behavior |
| `feat-terminal-copy-scrollbar-T1–T8` | Ctrl+C copies vs SIGINT, scrollbar always visible, right-click copy, rapid Ctrl+C, readonly copy | UI behavior |
| `feat-todo-panel-mount-T1–T6` | Todo panel: empty state, add todo, priority filter, persist reload, empty title blocked, project isolation | UI behavior |
| `feat-watchdog-panel-*` | Watchdog panel: 500-entry list, badge, default tab, reach, reload | UI behavior |

### Other targeted groups

| Filename prefix | What it tests | Category |
|-----------------|---------------|----------|
| `da-osc-filter-T1–T5` | DA2/OSC/mouse leak through WS onData filter, normal input and arrow keys pass through | UI behavior |
| `refresh-bug-T1,T2,T3,T5` | Resize-after-refresh, smoke terminal works, dimension mismatch, handle subscribed resize | UI behavior |
| `qa-black-box-T1–T7` | Black-box: visible content, fit dimensions, split toggle, no-GPU, refresh reconnect, subscribe dims, rapid switch | UI behavior |
| `bug-blank-terminal-switch-back-T1` | Blank terminal regression after switching sessions back | UI behavior |
| `image-paste-xterm-T1-ctrl-v` | xterm image paste via Ctrl+V | UI behavior |

---

## Known Baseline (2026-04-24)

**140 pass / 99 fail** across the full suite.

### Why tests fail by category

| Category | Typical failure reason |
|----------|------------------------|
| **Claude-API-required** (`T-43`) | Requires a real `claude` binary and valid API credentials. Fails in CI and on machines without Claude installed. |
| **Infrastructure-dependent** (some tmux tests) | `T-12`, `T-30` require a tmux binary and specific tmux session naming conventions. |
| **Stale UI selectors** | Tests written against older UI components reference CSS classes or button text that has since changed (e.g., `.session-card-actions` renamed to `.session-card-actionbar`, `.area-title` not containing "Sessions"). Fixed in `T-28`, `T-47`, `T-32`. |
| **B-rendering infra bugs** | `B-rendering.test.js` used `server.js` (wrong entrypoint), `networkidle` (hangs with WebSocket), and hardcoded `APP_DIR`. Fixed in `B-rendering.test.js`. |
| **Flaky timing** | A subset of tests fail intermittently due to tight timeouts on slow CI machines. These are WARN-level, not hard failures. |
| **Feature not yet shipped** | A small number of tests cover planned features (Telegram deep integration, upload interruption) that are partially implemented. |

### Tests that always pass (infra tests)

The A, C, E category tests (Jest unit tests against mocked PTY) are stable infrastructure tests with no external dependencies — they pass consistently. G-edge-cases also passes reliably.

---

## How to Run the Tests

Use the `run-t-tests` skill to run the T-series safely. This skill:

1. Kills orphaned tmux sessions (cm-\* not in the session store) before and after
2. Runs detached so test output does not flood the Claude context
3. Logs every run to `data/test-history.jsonl` with git commit, pass/fail counts, and categorized failures
4. Summarizes results concisely at the end

### Invoke via Claude Code

```
/run-t-tests
```

### Run a single test file manually

```bash
cd /home/claude-runner/apps/claude-web-app-v2
npx playwright test tests/adversarial/T-28-no-delete-while-running.test.js --reporter=line --timeout=120000
```

### Run B-rendering

```bash
npx playwright test tests/adversarial/B-rendering.test.js --reporter=line --timeout=120000
```

### Run all T-series only (no A–G category tests)

```bash
npx playwright test tests/adversarial/T-*.test.js --reporter=line --timeout=120000
```

### Important: never run against production

All tests spawn their own isolated server on a dedicated ephemeral port with a temp data dir. They do **not** connect to `claude-v2-prod` (port 3001) or `claude-v2-beta` (port 3002).
