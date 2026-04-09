# T-07 Validation — Invalid Command Shows Error Badge (Not Infinite Spinner)

**Validator:** Claude Sonnet 4.6 (Opus-level review)
**Date:** 2026-04-08
**Test result being validated:** PASS (3/3 runs, 1 attempt, 46.6s)

---

## Q1: Is the outcome valid? (Did the test actually prove what it claims?)

**Yes. The outcome is valid.**

All three runs independently confirmed:

1. **Badge shows "⚠ error" after 10 seconds** — Verified via both `page.evaluate` (all badge texts) and `page.waitForFunction` (waited for the "error" text to appear). The badge selector `.badge-activity` with text "error" was found in all 3 runs.

2. **No infinite spinner** — The badge never showed "starting" or "running" at the 10-second mark. The WS state history confirmed all sessions reached `error` as their terminal state.

3. **No JS exceptions** — `page.on('pageerror')` fired 0 times. Console error filter (uncaught/TypeError/ReferenceError) produced 0 matches. This directly addresses the `newSession.meta` ReferenceError regression mentioned in the design.

4. **No blank page** — Body HTML length was 2,836 characters, well above the 100-character threshold.

5. **State history reached error via WS** — The WS client received `session:state` messages with `error` as the final state in all 3 runs. The state machine correctly transitioned (as analyzed in Section 2a of the design).

The test addresses the exact bug scenario: user types a nonexistent binary name, waits 10 seconds, and the UI must show "⚠ error" — not an infinite spinner.

**Interesting behavioral observation:** Runs 1 and 3 showed the state sequence `starting → running → error → starting → running → error`. This doubled sequence suggests a node-pty-level retry or auto-restart mechanism. This does not affect validity — both sequences ended in `error`, which is the correct final state. The design anticipated this in Section 9 Risk 1 (STARTING → RUNNING → ERROR transition). The test correctly checks the final state after 10 seconds, not intermediate states.

---

## Q2: Is the design sound?

**Yes. The design correctly identifies and tests the right failure mode.**

**Strengths:**
- The choice of `claude-nonexistent-binary-xyz` is good — it is guaranteed not to exist, exercises the ENOENT/127 exit code path, and is faithful to the user story (wrong binary name).
- The 10-second wait is generous — the design's timing analysis (Section 3c) predicted <700ms for the badge to update. The 10-second window eliminates any timing argument against the result.
- Using `page.waitForFunction` (not `page.evaluate`) for badge detection avoids the DOM-not-yet-updated race (Risk 3).
- The three-repetition protocol confirms the behavior is consistent, not a timing accident.
- The binary existence check (`which claude-nonexistent-binary-xyz`) as a precondition guard is correct practice.

**Design accuracy validated by execution:**
- The design's Section 2a analysis predicted `STARTING → RUNNING → ERROR` via the `onExit` path. Confirmed — all runs passed through these states.
- The design predicted no `session:stopped` messages and no REST DELETE needed. Confirmed — state changes came via `session:state` WS messages.
- The badge text `⚠ error` (Section 4a) was observed exactly as predicted.

**Minor design note:** Section 6e says session creation is "WS only — no REST." The test correctly uses WS for session creation. The project, however, is created via `POST /api/projects` (Section 6d), which is REST. This is correct and expected.

---

## Q3: Was execution faithful to the design?

**Yes, with minor implementation choices that are all legitimate.**

**Faithful:**
- Binary existence check performed before server startup (Section 7 Step 1 precondition). Correct.
- Port 3104 killed before server start.
- Fresh isolated tmpDir created.
- Server started with `server-with-crash-log.mjs`, polled until ready.
- Project created via `POST /api/projects` (Section 6d). Correct.
- Session created via WS with `command: 'claude-nonexistent-binary-xyz'` (Section 6e).
- WS state history collected from `session:state` messages (Section 6f).
- Browser opened headless with Chromium (Section 7 Step 3).
- `page.on('console')` and `page.on('pageerror')` listeners registered (Section 5b).
- `waitUntil: 'domcontentloaded'` used for navigation.
- Project selected via `page.click('text=T07-TestProject')` (Section 7 Step 4).
- Full 10 seconds waited from session creation (Section 7 Step 5, design spec requirement).
- Screenshot taken at 10s mark (Section 7 Step 6).
- Badge checked via `page.evaluate` + `page.waitForFunction` (Section 7 Step 6, Risk 3 mitigation).
- Session overlay optionally opened and screenshot taken (Section 7 Step 7).
- Session deleted via WS after each run (Section 11).
- Crash log checked in `afterAll` (Section 11).
- Port 3104 fused in `afterAll` (Section 11 safety net).

**Deviations:**
- The design's Section 9 (False PASS Risks) describes checking `badgeFoundError || result.finalState === 'error'` as the composite assertion. The test implements exactly this logic. In all 3 runs, both conditions were true. This is correct.
- Terminal content rows in the overlay were 0. The design (Section 7 Step 7) says this check is "optional" — checking that "the terminal shows some output (error text)." Since the session had already exited when the overlay opened, the xterm row selector found nothing. This is not a failure criterion per the design.
- Run 2 WS state history was shorter (`starting → running → error`) while Runs 1 and 3 showed the doubled sequence. The test only checks the **final** state after 10 seconds, which is correct per Risk 1 mitigation. All final states were `error`.

---

## Overall Assessment

**VALID PASS.** The test correctly verifies that an invalid binary name causes the session to transition to error state within 10 seconds, the UI badge shows "⚠ error" (not "starting"), no JS exceptions are thrown, and the page is not blank. Three independent runs produced consistent results. The design's primary concern (infinite spinner from a session stuck in "starting") is definitively ruled out. The doubled state sequence observed in some runs (starting → running → error → starting → running → error) is a noteworthy behavioral observation suggesting possible auto-restart logic — worth flagging as a design question but not a test failure, since the final state is `error` in all cases.
