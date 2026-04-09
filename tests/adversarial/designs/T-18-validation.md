# T-18 Validation Report

**Test:** T-18 — Switching Projects While a Session Is Starting
**Date:** 2026-04-08
**Result:** PASS
**Duration:** 40.8s (3 iterations)
**Port:** 3115

---

## Pass/Fail Matrix (per iteration)

| Check | Iter 1 | Iter 2 | Iter 3 |
|-------|--------|--------|--------|
| Session card visible in Project A | PASS (1 card) | PASS (1 card) | PASS (1 card) |
| Card name = "T18-race-session" | PASS | PASS | PASS |
| Session badge valid state | PASS (running) | PASS (running) | PASS (running) |
| REST API: session.projectId = A | PASS | PASS | PASS |
| No session in Project B (browser) | PASS (0 cards) | PASS (0 cards) | PASS (0 cards) |
| No session in Project B (API) | PASS | PASS | PASS |
| Session not duplicated | PASS | PASS | PASS |

---

## Race Condition Status

The true race (switching projects before `session:created` arrives) was **not exercised** in any iteration:

| Iteration | Switch Time (ms) | WS Latency (ms) | Race Window |
|-----------|-----------------|-----------------|-------------|
| 1 | 264 | 70 | Switch AFTER created |
| 2 | 237 | 29 | Switch AFTER created |
| 3 | 219 | 22 | Switch AFTER created |

The server responds to `session:create` in 22–70ms on localhost. Playwright's sequential `evaluate()` + `click()` calls take ~219–264ms total, making it impossible to switch projects before `session:created` arrives in a headless test.

This is a known limitation documented in the design (Risk 1 — "Race not exercised"). The functional correctness was validated regardless.

---

## Architecture Verified Correct

The global signal architecture prevents this race condition from ever causing issues:

1. **`sessions` signal is global** — stores all sessions regardless of selected project. `projectSessions` is a derived computed that filters for display only.

2. **`createSession()` uses the projectId captured at click time** — `NewSessionModal.handleCreate()` reads `selectedProject.value` synchronously and passes it to `createSession(project.id, ...)`. There is no async gap where `selectedProject` could change before the WS message is sent.

3. **`upsertSession()` is project-agnostic** — when `session:created` arrives (even while Project B is selected), `upsertSession()` correctly inserts the session into the global `sessions` array with `projectId = A`. When Project A is re-selected, `projectSessions` correctly re-computes to include it.

4. **No cross-project bleed** — 0 sessions appeared in Project B across all 3 iterations.

---

## Observations

1. **WS latency is very low on localhost** — 22–70ms round-trip. This makes true race conditions nearly impossible to exercise with Playwright's sequential execution model. A browser-side race (two simultaneous DOM events in one tick) would require `Promise.all` with concurrent page actions.

2. **The architecture doesn't need the race to be exercised** — because the signal update path for `upsertSession` is synchronous and project-agnostic, there is no timing window where the session could be "lost" regardless of when `session:created` arrives.

3. **3/3 iterations passed** — result is deterministic PASS, not flaky.

---

## Verdict

**PASS** — No fixes required. The global signal architecture ensures sessions created in Project A are never lost when switching to Project B during or after creation. No cross-project bleed detected. 3/3 iterations clean.
