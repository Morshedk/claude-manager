# T-10 Validation Report

**Test:** Session Count Badge in Sidebar Matches Live Running Sessions
**Validator:** opus (claude-sonnet-4-6 acting as adversarial validator)
**Date:** 2026-04-08

---

## Q1: Was the outcome valid? Did the badge actually update in real-time?

**Verdict: GENUINE PASS**

The run output provides clear evidence of real-time update — not page-load snapshot behavior:

**Scenario A evidence:**
- Badge confirmed at "3 sessions running" before any stop (`PRE-STOP: badge shows "3 sessions running" ✓`)
- `session:stop` sent via WS
- `sessions:list` broadcast received (logged explicitly)
- Badge confirmed at "2 sessions running" within 3 seconds of the stop (`POST-STOP: badge shows "2 sessions running" ✓`)
- `performance.navigation.type=0` confirmed — no page reload occurred

**Scenario B evidence:**
- Starting state "2 sessions running" confirmed before s2 stop
- After s2 stop: "1 session running" confirmed (correct singular form)
- `session:refresh` sent via WS; `session:refreshed` received, then `sessions:list` broadcast received
- Badge updated to "2 sessions running" within 3 seconds (`AFTER REFRESH: badge shows "2 sessions running" ✓`)
- `performance.navigation.type=0` confirmed — no page reload occurred

The `navigation.type=0` check is the correct adversarial guard against the "updates at load only" failure mode. Since the badge was already at the correct value BEFORE the stop was sent, and the WS broadcast was explicitly awaited before the badge assertion, the sequence proves genuine reactivity: the DOM changed in response to a WS broadcast, not a navigation event.

The singular "1 session running" (not "1 sessions running") was also verified, confirming plural logic is correct.

One minor observation: the `[srv:ERR] duplicate session: factory` error in the Scenario A output is correctly identified as a benign xterm.js headless warning and has no bearing on badge behavior.

**Total assessment: The badge demonstrably updated in real-time without a page reload in both the stop (3→2) and refresh (1→2) directions.**

---

## Q2: Was the design sound?

**Verdict: YES — the design is well-constructed for this test objective**

Strengths:

1. **Correct reactivity chain identified.** The design correctly maps the full update path: `_broadcastSessionsList()` → WS `sessions:list` broadcast → `handleSessionsList()` → `sessions.value = [...]` → Preact signal re-render → `.project-item-badge` DOM update. This is the actual code path in `ProjectSidebar.js` and the WS handler.

2. **Using `bash` instead of Claude for sessions.** This is an excellent design choice. `bash` starts immediately with no TUI initialization wait, making session state changes fast and deterministic. Testing badge reactivity does not require Claude to be running — the test is about the UI's reaction to session state changes, not Claude's behavior.

3. **Two-direction test (stop and refresh).** Scenario A (decrease) and Scenario B (increase) together verify both branches of the reactivity signal. A stale counter that only shows the initial count would fail A. A counter that only refreshes on navigation would fail both. Covering both directions is thorough.

4. **Scoped badge locator.** The design specifies `page.locator('.project-item', { hasText: 'T10-BadgeProject' })` then `.locator('.project-item-badge')` within it. This avoids false matches if multiple projects exist and correctly mirrors `ProjectSidebar.js` DOM structure.

5. **3-second timeout on badge assertions.** The design correctly specifies `{ timeout: 3000 }` to match the "within 3 seconds" requirement from Story 13, and explicitly prohibits `page.reload()` between steps.

6. **WS broadcast awaited before badge assertion.** The design waits for `sessions:list` to arrive before checking the badge. This ensures the test isn't racing the WS delivery — the WS message is confirmed received, then the UI reactivity assertion follows. This is the right sequence: if the message arrived at the WS level but the badge didn't update, that's a genuine UI bug.

7. **Explicit no-reload verification.** `performance.navigation.type !== 1` is a valid Playwright check for this. It correctly distinguishes between a fresh navigation (`type=0`) and a page reload (`type=1`).

Minor design gap: Scenario B starts by opening a fresh browser page (`page.goto(BASE_URL)`) and asserting "2 sessions running" before stopping s2. This is technically a page load check, not a real-time check. However, this is only the baseline setup — the real-time assertion is the update from "2 sessions running" to "1 session running" after the WS stop, and then from "1 session running" to "2 sessions running" after the WS refresh. Both of those transitions are genuine real-time checks. The fresh page open for Scenario B baseline is acceptable.

**The design is sound for testing real-time badge reactivity.**

---

## Q3: Was execution faithful to the design?

**Verdict: YES — implementation matches the design precisely**

| Design requirement | Implementation |
|---|---|
| Isolated server on port 3107, temp DATA_DIR | Lines 78-107: `mktemp`, spawn with env vars, 15s poll on `/api/projects` |
| Create test project via REST API | Lines 111-118: `POST /api/projects`, store `projectId` |
| 3 bash sessions via WS `session:create` | Lines 128-144: loop, `command: 'bash'`, `mode: 'direct'`, wait for `session:created` each |
| Single control WS for all operations | `ctrlWs` in shared state, used across both test blocks |
| Select project by name in sidebar | Line 173: `.project-item` with `hasText: 'T10-BadgeProject'` |
| Badge text check: "3 sessions running" | Line 180: `toHaveText('3 sessions running', { timeout: 5000 })` |
| Wait for `sessions:list` before checking badge | Lines 186-193: `sessionsListPromise` set up before sending stop, awaited before badge assertion |
| Badge text check: "2 sessions running" within 3s | Line 197: `toHaveText('2 sessions running', { timeout: 3000 })` |
| No page reload check: `navigation.type !== 1` | Lines 203-205: `page.evaluate(() => performance.navigation?.type ?? -1)`, `expect(navType).not.toBe(1)` |
| Scenario B: stop s2, check "1 session running" | Lines 235-243: WS stop, `sessions:list` await, `toHaveText('1 session running', { timeout: 3000 })` |
| Singular "session" (not "sessions") | Covered by exact `toHaveText` match |
| Refresh s2, wait for `session:refreshed` then `sessions:list` | Lines 246-252: two separate WS promises, both awaited before badge check |
| Badge updates to "2 sessions running" within 3s | Line 255: `toHaveText('2 sessions running', { timeout: 3000 })` |
| No page reload check in Scenario B | Lines 261-263: same `navigation.type` check |
| Screenshots at each step | Present (A-01, A-02, B-01, B-02) |
| Cleanup: stop sessions, kill server, remove tmpDir | Lines 147-158: `afterAll` handles all cleanup |

One small implementation note: In the test, `waitForWsMessage` for `sessions:list` in Scenario A is set up BEFORE the stop is sent (line 186 before line 189). This is the correct order — setting up the listener first avoids a race where the broadcast arrives before the promise is created. The implementation correctly anticipates this ordering requirement from the design.

The `[srv:ERR] duplicate session: factory` log line corresponds to xterm.js attempting to register a renderer in headless Chromium, which is expected and does not affect test integrity.

**No material deviations from the design were found.**

---

## Summary

| Dimension | Finding |
|---|---|
| Outcome validity | GENUINE PASS — badge updated in real-time in both directions (stop: 3→2, refresh: 1→2), no page reload, plural/singular correct |
| Design soundness | SOUND — correct reactivity chain, bash sessions for speed, two-direction coverage, WS-before-badge sequencing |
| Execution faithfulness | FAITHFUL — implementation matches design on all key requirements with correct listener ordering |

**T-10 result: GENUINE PASS. The sidebar badge real-time reactivity is confirmed working.**
