# Session Log Feature + Playwright Config Fix — 2026-04-17

## What was built

**SessionLog (v2.01)** — persistent, human-readable logging of tmux terminal output with
session event annotations injected inline.

Key components:
- `lib/sessionlog/SessionLogManager.js` — pipe-pane capture, 20s tick (ANSI strip → `.log`),
  `injectEvent()` for session events, `tailLog()`/`logPath()`/`status()` for API layer
- Hooks in `TmuxSession.js` — PTY:ATTACH, PTY:DETACH, SESSION:KILLED, SESSION:STOP,
  SESSION:REFRESH, SESSION:RESUME at each lifecycle transition
- Hooks in `SessionManager.js` — SERVER:START injected when tmux sessions re-attach on restart
- Hooks in `server-with-crash-log.mjs` — SERVER:CRASH injected into all active session logs
  on SIGTERM/SIGHUP
- `GET /api/sessionlog/:id/tail`, `/full`, `/status` endpoints
- `SessionLogPane.js` — browser polling pane (3s interval), tail-anchored auto-scroll,
  session event color-coding (=== lines in amber, --- timestamps in muted)
- "Events" button in `SessionOverlay.js` — toggles 50/50 terminal + log split

**Terminology note:** These annotations are called "session events" throughout the code and
UI (not "lifecycle events"). The pane header says "Session Events".

---

## playwright.config.js — why some tests were removed

The Playwright config previously listed ~7 test files that import from `@jest/globals`
rather than `@playwright/test`. These are Jest-based adversarial tests (WebSocket protocol,
watchdog, reconnect tests in the C/D/E/G categories, and some feat-lastline/feat-overlay
tests). Playwright cannot load `@jest/globals` — it throws:

```
SyntaxError: The requested module '@jest/globals' does not provide an export named 'expect'
```

This caused the entire Playwright suite to collect 0 tests and exit with code 1.

**The fix:** removed the following files from `playwright.config.js` testMatch (they remain
in `tests/adversarial/` and run correctly under `npm test` via Jest):

- `feat-lastline-T1-basic-appears.test.js` through `feat-lastline-T6-throttle.test.js`
  — these are WS-level Jest tests, not browser Playwright tests
- `feat-overlay-auto-open-T4-rapid-creates.test.js`
  — jest-based; T1/T2/T3 remain in Playwright config (they're proper browser tests)

**What still runs under Playwright:** 136 tests across 66 files — all T-01 through T-51
(except T-35/T-36 which were never in the Playwright config), B-rendering, F-lifecycle,
F-bug-reproductions, feat-watchdog-panel-*, feat-split-screen-ux-*, feat-overlay-auto-open-T1/T2/T3.

**What runs under Jest (`npm test`):** 400 unit/integration/adversarial tests including
all C/D/E/G category tests and the feat-lastline/* tests.

These are not the same tests — they test different layers (browser UI vs raw server protocol).
Nothing was lost; the split was just not reflected in the config.

---

## Deployment

- Tagged `v2.01` on `main`
- `claude-v2-prod` (port 3001) restarted on v2.01
- `claude-v2-beta` (port 3002) restarted on v2.01
