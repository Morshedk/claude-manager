# T-04 Validation — Stop Button Actually Kills the Process

**Validator:** Claude Sonnet 4.6 (Opus-level review)
**Date:** 2026-04-08
**Test result being validated:** PASS (1 attempt, 59.0s)

---

## Q1: Is the outcome valid? (Did the test actually prove what it claims?)

**Yes. The outcome is valid.**

The test used three distinct verification layers for each of the 3 iterations:

1. **Baseline kill-0 check** — confirmed each PTY process was alive before stop was issued. This eliminates the "vacuous pass" risk (Risk 2 in the design) where a process might have died on its own before the stop.

2. **REST API check** — confirmed `status === "stopped"` in the server's in-memory state after the stop.

3. **OS-level kill-0 check** — the critical `process.kill(pid, 0)` throwing `ESRCH` confirms the OS kernel reports the process as dead. This cannot be fooled by in-memory state and directly addresses the "credits still burning" silent failure mode described in the design.

4. **UI badge check (Path A iterations)** — confirmed the DOM shows "stopped" and the Stop button disappeared.

The combination of baseline-alive + OS-dead is the strongest possible proof that the stop operation actually killed the process. The test did not merely trust the API.

**Minor caveat:** The design (Section 1a, step 2) calls for polling `http://127.0.0.1:3101/` until HTTP 200 for server readiness. The test polls `/` via `fetch()` and checks `r.ok`. This is correct.

---

## Q2: Is the design sound?

**Yes. The design is well-constructed.**

**Strengths:**
- The `process.kill(pid, 0)` / ESRCH approach is the gold standard for OS-level process liveness verification. It bypasses all application-layer state.
- The three-iteration protocol with alternating paths (UI, WS, UI) prevents lucky passes and exercises both stop code paths.
- The baseline kill-0 check before stop is essential — without it, a pre-dead process would produce a vacuous pass. The design anticipated this and implemented the guard.
- The false-PASS risks in Section 5 are comprehensive and each has a concrete mitigation.
- The session-still-exists check (stop ≠ delete) is a subtle but correct assertion — stopping a session must not accidentally delete it.

**Minor observations:**
- Risk 4 (PID recycling) is correctly dismissed for the 5-second window. Correct.
- The design notes `pty.kill()` errors are silently swallowed (Section 11 code analysis). The test's OS-level kill-0 check is the only way to catch this failure mode. This is the key insight of the design.
- The "No `init` message" deviation (server doesn't send `init` on WS connect, or sends it before the listener is registered) is a minor implementation mismatch. The test gracefully handles it with `.catch(() => {})`. This does not invalidate the test because `session:create` still proceeds correctly.

---

## Q3: Was execution faithful to the design?

**Yes, with one minor deviation that does not affect validity.**

**Faithful:**
- Fresh isolated temp directory, correct `{ "projects": [...], "scratchpad": [] }` seed format.
- Both stop paths exercised (Path A in iterations 1 and 3, Path B in iteration 2), as specified in Section 7.
- Waited 5 seconds after stop before checking (Section 4b).
- REST check confirmed session still exists AND status is "stopped" (Section 4c).
- OS-level kill-0 check performed with ESRCH verification (Section 4d).
- UI badge and Stop button checks done for Path A iterations (Section 4e).
- Server process liveness checked (Section 6b).
- Crash log checked (Section 6c) — no unhandled errors found.
- Session deleted between iterations (Section 7, step 9).
- `afterAll` cleanup: server killed, temp dir removed, port fused (Section 10).

**Deviation:**
- No `init` message received on WS connect. The design says "Wait for the `init` message (timeout 8s)" in Section 2a. The test's `waitForMsg` times out silently with `.catch(() => {})` and proceeds anyway. This works in practice because `session:create` doesn't require the `init` message to have been received first — the server accepts `session:create` immediately after WS connection. This is a non-breaking deviation.

---

## Overall Assessment

**VALID PASS.** The test correctly verifies that the Stop button kills PTY processes at the OS level across both UI and WS stop paths, repeated 3 times with fresh sessions each time. The design's primary concern (silent failure: UI says stopped, PTY still alive) is directly addressed by the kill-0/ESRCH check, which passed all 3 iterations. No false-pass risks were triggered.
