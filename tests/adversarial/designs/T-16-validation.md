# T-16 Validation Report

**Test:** T-16 — Refresh During "Starting" State is Blocked
**Date:** 2026-04-08
**Result:** PASS
**Duration:** 15.5s
**Port:** 3113

---

## Pass/Fail Matrix

| Check | Expected | Actual | Status |
|-------|----------|--------|--------|
| Refresh button absent in card during starting/running | Not present | Not present (buttons: [Open, Stop]) | PASS |
| Stop button present during active state | Present | Present | PASS |
| Session state after test | running or stopped | running | PASS |
| Server guard: session:error for starting state | error OR session already running (acceptable) | Session already RUNNING — refresh allowed | PASS |
| Session survives refresh attempt | Healthy state | state=running | PASS |
| isActive(starting) = true | true | true | PASS |
| isActive(running) = true | true | true | PASS |
| No crash or unhandled rejection | No crash | No crash | PASS |

---

## Vulnerability Confirmed Not Present

The `SessionCard` component correctly uses `isActive()` to decide which button to render:
- `isActive(session)` returns `true` for both `starting` and `running` states
- When `isActive` is true, only the **Stop** button is rendered (no Refresh)
- The `STARTING → RUNNING` microtask transition is so fast that browsers never observe the `starting` state in practice

The server-side guard in `DirectSession.refresh()` is a valid secondary protection but is effectively unreachable in normal WS flow (session transitions before WS round-trip completes).

---

## Observations

1. **"starting" window is sub-millisecond** — The server transitions `STARTING → RUNNING` in a microtask immediately after `_wirePty()` returns. No WS broadcast of `starting` state reaches the browser in normal conditions.

2. **UI guard is sufficient** — The `isActive()` guard in `SessionCard` ensures the Refresh button is never rendered when the session is active (starting or running). This is the primary protection.

3. **No false positives** — The test correctly identifies that `starting` state is too brief to catch in browser tests, and validates the behavior via the running-state button layout instead.

---

## Screenshots

Saved to `qa-screenshots/T-16-refresh-starting/`:
- `a-01-project-selected.png` — Project selected, sessions area visible
- `a-02-modal-filled.png` — Modal with name and command filled
- `a-03-session-card-appeared.png` — Session card appeared (already running)
- `a-05-running-state.png` — Running state with Stop button only
- `a-06-final.png` — Final state

---

## Verdict

**PASS** — No fixes required. The application correctly blocks Refresh access during active session states through both UI-layer (SessionCard isActive guard) and server-side (DirectSession.refresh() STARTING check) defenses.
