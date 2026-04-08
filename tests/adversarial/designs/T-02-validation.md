# T-02 Validation Report

## Q1: Outcome Validity
**GENUINE PASS**

Reasoning:

1. **Live output assertion was meaningful.** The test generates a unique marker per round (`T02_ROUND_N_<timestamp>`) AFTER the reload, types it into the terminal via `page.keyboard.type()` + `page.keyboard.press('Enter')`, then waits for that exact string to appear in `#session-overlay-terminal .xterm-screen` textContent (lines 215-223 of the test, invoked at line 304-305). Because the marker includes `Date.now()`, it cannot be satisfied by stale/cached content. This proves bidirectional I/O: keystrokes reach PTY, PTY output reaches xterm. The run output confirms three distinct marker timestamps: `T02_ROUND_1_1775646455264`, `T02_ROUND_2_1775646459848`, `T02_ROUND_3_1775646463051` (run output lines 66, 96, 126).

2. **PTY process verified alive via kill -0.** Check 6 (lines 282-287) calls `process.kill(ptyPid, 0)` from the Node.js test runner. This is an OS-level liveness check, not relying on the API's status field. All 3 rounds confirmed PID 492643 alive (run output lines 60, 90, 120).

3. **PID stability verified.** Check 5 (line 278) asserts `session.pid === ptyPid` from the REST API, confirming the PTY was not respawned. PID 492643 was constant across all rounds (run output lines 58, 88, 118).

4. **Server-side state verified independently.** Check 5 fetches `GET /api/sessions` from the Node.js test runner (not from the browser), parses the response, and asserts `status === 'running'` and PID match (lines 274-279).

5. **False-PASS risk coverage (design Section 12):**
   - Risk 1 (PTY dead but API says running): Mitigated by kill-0 check. **Covered.**
   - Risk 2 (stale content, not live): Mitigated by unique post-reload marker. **Covered.**
   - Risk 3 (WS reconnect unreliable): Mitigated by 3 rounds all-must-pass. **Covered.**
   - Risk 4 (session ID changed): Mitigated by Check 5 ID comparison. **Covered.**
   - Risk 5 (overlay opens but no subscribe): Mitigated by marker echo-back test. **Covered.**
   - Risk 6 (browser cache used): Mitigated by CDP `Network.setCacheDisabled`. **Covered.**
   - Risk 7 (duplicate subscribe): Partially covered -- browser console errors/warnings are logged (line 333-335) but no assertion fails the test on console errors. The run output shows no `[browser:err]` lines, so this did not manifest. **Partially covered -- no hard assertion.**
   - Risk 8 (WS masks broken REST): Mitigated by Check 5 REST call from test runner. **Covered.**

**One gap found:** The crash log check (lines 473-494) explicitly does NOT fail the test on crash log entries (line 487: `// Not failing the test for crash log warnings -- could be benign`). The design doc Section 7d says crash log entries during the test window ARE a fail. This is a deviation from the design, but did not affect the outcome since the crash log was clean during the test window (run output line 130: `no entries during test window`). The SIGTERM entries visible in the crash log dump (lines 144-146) occurred during afterAll cleanup, after the test completed.

## Q2: Design Quality
**HAS GAPS**

Reasoning:

1. **Seed format error (known).** The design doc Section 1 step 2 shows seeding `projects.json` as a plain array. This was wrong. The execution summary documents this and the fix was applied. Not a current risk since the test was updated.

2. **CDP cache disable vs. Ctrl+Shift+R.** The design's concern (Risk 6) is valid. CDP `Network.setCacheDisabled` disables the HTTP cache entirely for all requests, which is actually MORE aggressive than Ctrl+Shift+R. A real hard reload bypasses cache only for the main document and its subresources loaded during that navigation; CDP disables caching globally. This means the test is stricter than the real scenario, which is fine for a pass -- if anything, it makes the test harder to pass, not easier. **Not a false-PASS risk.**

3. **3 rounds is adequate but not robust.** For a timing-sensitive test involving WS reconnection, 3 rounds with sub-2-second reconnect times (907ms, 1162ms, 1288ms) gives reasonable confidence. The design correctly acknowledges this is the minimum. The variation between rounds (overlay open vs closed) adds meaningful coverage. For a production reliability suite, 10+ rounds would be better, but 3 is defensible for an adversarial test.

4. **Missing assumption: `networkidle` vs `domcontentloaded`.** The design specifies `waitUntil: 'networkidle'` for initial navigation (Section 2, step 3 of Playwright browser setup), but the execution correctly notes this would hang forever because of the persistent WebSocket connection. This is a design error that was correctly caught and fixed in execution. However, the design doc was NOT updated to reflect this (Section 2 still says `networkidle`).

5. **Assumption about `selectedProjectId` reset on reload.** The design (Section 4, "What happens on reload") correctly notes that Preact signals reset to null, requiring re-selection. The test handles this by calling `selectProject()` in every round. **Sound assumption, properly implemented.**

6. **No assertion on WS message count or subscribe message.** The design mentions (Risk 7) that duplicate `session:subscribe` messages could be sent. The test does not instrument the WS to count subscribe messages. This is a minor gap -- it would catch a regression where the server handles duplicate subscribes poorly. However, the marker echo-back test indirectly catches any resulting failure.

## Q3: Execution Faithfulness
**FAITHFUL (with minor deviations)**

Reasoning:

1. **WS message counter / unique marker echo-back approach:** The design does not explicitly call for a WS message counter as a required check. It mentions it only in Risk 7 as something to "observe." The test does NOT implement WS message counting. However, the unique marker echo-back approach (the core freshness test) IS implemented faithfully. Each round generates `T02_ROUND_N_<timestamp>`, types it, and waits for it in the terminal DOM. **Faithful to the required checks.**

2. **3 rounds with different configurations:** The design specifies Round 1 = overlay open, Round 2 = overlay closed, Round 3 = overlay open. The test implements exactly this:
   - Line 435: `=== ROUND 1: overlay OPEN at reload ===`
   - Line 443-444: closes overlay, then `=== ROUND 2: overlay CLOSED at reload ===`
   - Line 453: `=== ROUND 3: overlay OPEN at reload ===`
   Run output confirms the same pattern. **Faithful.**

3. **PTY PID captured and compared before/after reload:** PID captured at line 394 (`ptyPid = sess.pid`), compared in Check 5 at line 278 (`expect(session.pid).toBe(ptyPid)`) and Check 6 at line 283 (`process.kill(ptyPid, 0)`). Run output confirms PID 492643 was stable. **Faithful.**

4. **Live output test -- meaningful marker echo:** As analyzed in Q1, the marker approach at lines 304-305 is the correct implementation of the design's Check 8. The marker is unique per round and per timestamp. **Faithful.**

5. **Documented deviations (from execution summary):**
   - `domcontentloaded` instead of `networkidle` -- justified and correct.
   - Seed format fix -- required, bug in design.
   - `keyboard.press('Enter')` instead of `\n` in `keyboard.type()` -- practical fix for xterm/PTY input.
   - Extra screenshot added -- no impact on test correctness.
   
6. **Crash log handling deviation (not documented):** The design (Section 7d) says crash log entries during the test window are a fail. The implementation (line 487) only warns, does not fail. This was NOT listed in the execution summary's "Deviations from design" section. **Undocumented deviation.** However, in this specific run, the crash log was clean, so this did not produce a false PASS.

7. **Screenshot directory cleanup:** Design Section 11 says "Remove screenshot directory only on PASS (keep on FAIL for debugging)." The afterAll (lines 102-133) does NOT clean up the screenshot directory at all -- it only cleans the data dir. This is a minor deviation that favors debugging (screenshots always kept). **Harmless.**

## Overall Verdict
**CONFIRMED PASS**

The test genuinely exercises browser hard-reload with cache bypass, verifies PTY survival via OS-level kill-0, confirms bidirectional I/O with unique timestamped markers, and checks server-side state via REST API independently of the browser. All 8 false-PASS risks from the design are mitigated (7 fully, 1 partially). The two deviations from design (crash log warn-not-fail, networkidle change) are justified and did not affect the outcome. The PID remained stable at 492643 across all 3 rounds, WS reconnect was consistent (907-1288ms), and terminal content was verified bidirectionally each round.

## Recommended next action

1. **Fix the crash log handling** (line 486-488 of the test): change from `console.warn` to `expect(testWindow.length).toBe(0)` to match the design's Section 7d requirement. This is a latent false-PASS risk if a future run has an unhandled exception that gets silently swallowed.

2. **Update the design doc** to correct the two known errors: (a) seed format should be `{ projects: [...], scratchpad: [] }` not a plain array; (b) `waitUntil` should be `domcontentloaded` not `networkidle`. These errors in the design doc will trip up anyone writing similar tests.

3. **No rerun needed.** The pass is genuine. The gaps found are documentation and defensive-hardening issues, not outcome-affecting.
