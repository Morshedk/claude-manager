# T-03 Validation Report

## Q1: Outcome Validity
**INCONCLUSIVE**

Reasoning:

**1. The `\x1bc` regression fix is verified to be in place.** `DirectSession.js` in the v2 codebase does NOT write `\x1bc` to the PTY at any point. The `start()` method (line 40-73) simply calls `pty.spawn()` and then `_wirePty()`. The `refresh()` method (line 142-168) kills the old PTY, resets status, and calls `start()` again. No escape sequences are written to the PTY during spawn. The `_ptyGen` guard (line 71, 192, 212, 233) is present and functioning. So the regression is indeed absent from the current code.

**2. The `scrollMax === 0` check was vacuous.** This is the critical problem. The pre-refresh `scrollState` (run output line 52) shows `scrollMax: 0, bufferLength: 41`. The viewport has 41 rows and the 10 echo lines plus prompt fit entirely within it, so there was never any scrollback to clear. The post-refresh `scrollMax === 0` check (design section 8 criterion 1) passed trivially -- it was 0 before AND after. This means the test never actually verified that `xterm.reset()` cleared scrollback, because there was no scrollback to clear.

The design itself flagged this as "Risk 4" in section 11 and recommended increasing the loop count to 40+ lines to guarantee scrollback. The implementation did NOT apply this mitigation -- it kept the original 10 lines. The execution summary (line 521) acknowledges this but waves it away as non-fatal.

**3. The `T03-LINE-` content was never visible in the browser terminal.** Run output line 56: `T03-LINE- content in terminal: false`. The execution summary (lines 517-519) explains that the browser subscribed fresh, triggering `xterm.reset()` before the old scrollback could render. This means the "old content absent after refresh" check (criterion 2) was also vacuous -- the old content was never there to begin with. The test checked that content which was already absent remained absent. This does not prove that `xterm.reset()` cleared anything.

**4. DOM-based dot detection is reasonable but has a known gap.** The design (section 11 Risk 1) correctly identifies that rendering artifacts might not appear in `textContent`. The test implemented the styled-span mitigation (test file lines 228-249), which partially addresses this. However, the original spec (LIFECYCLE_TESTS.md line 590) explicitly says "inspect the pixel area outside active text for isolated single-pixel dots" -- i.e., pixel inspection was the intended primary method, not DOM scanning. The design deliberately downgraded this to DOM-only (section 7c labels pixel detection "tertiary/fallback"), which is a defensible engineering choice but a deviation from spec intent. Dots that manifest as stale GPU textures or canvas rendering artifacts would not be caught.

**Net assessment:** The test confirmed that (a) the codebase doesn't contain the `\x1bc` bug, (b) no DOM-visible artifacts appeared after refresh, and (c) the session recovers. However, two of the six pass criteria (scrollback reset, old content cleared) were satisfied vacuously because the preconditions were never established. The test did NOT prove that `xterm.reset()` actually clears a populated buffer during refresh -- only that a terminal with no scrollback and no old visible content remains clean after refresh.

## Q2: Design Quality
**HAS GAPS**

Reasoning:

**1. DOM vs. pixel detection tradeoff is well-reasoned but deviates from spec.** The spec (LIFECYCLE_TESTS.md line 590) says "screenshot pixel inspection." The design explicitly chose DOM-based detection as primary and pixel as fallback. This is pragmatically sound (DOM is more stable in headless) but means the test cannot catch renderer-specific artifacts (WebGL texture staleness, canvas glyph cache corruption). The design honestly documents this limitation in section 11 Risk 3.

**2. Using bash instead of Claude is the right call for test reliability.** The original bug was in the PTY lifecycle (kill/respawn/`session:subscribed` broadcast), not in Claude-specific output. Bash reproduces the refresh conditions faithfully. The design correctly explains this in section 2a.

**3. The `_scrollState()` hook exists and works.** Confirmed at `TerminalPane.js` line 104. It returns `{ userScrolledUp, scrollTop, scrollMax, bufferLength, viewportY }` exactly as the design specifies. The hook is properly installed on the viewport element.

**4. The design identified the vacuous-scrollback risk but the implementation didn't fix it.** Section 11 Risk 4 says: "If the terminal viewport is large enough and the 10 echo lines fit entirely within the viewport, there will be no scrollback to clear." Mitigation: "increase the loop count to produce 40 lines." The test file uses 10 lines (line 443) and creates a session with `rows: 30` (line 417), but the actual terminal renders with 41 rows (run output line 52 shows `bufferLength: 41`). The session was created with `rows: 30` but the browser terminal rendered larger -- likely because the overlay sizing doesn't respect the initial `rows` parameter. This discrepancy should have been caught by the pre-check: the design says "assert lastContentRow >= 5" (section 3d), and indeed the test logs a WARNING (run output line 54) but does not abort.

**5. The double-refresh protocol (section 9) is well-designed** for testing the `_ptyGen` generation guard race condition. The round-2 content marker (`T03-ROUND2-`) correctly distinguishes fresh content from round-1 artifacts.

## Q3: Execution Faithfulness
**DEVIATED**

Reasoning:

**1. Double-refresh protocol was executed.** Run output confirms: Round 1 refresh at line 59, Round 2 refresh at line 370. Both rounds ran full verification cycles with artifact scans at t=0, t=2, t=4. This matches section 9.

**2. Screenshots were taken at t=0, t=2, t=4 as specified.** The test file (lines 304-323) takes screenshots at each timestamp. Blank region screenshots are also captured (lines 326-354). This is faithful.

**3. DOM blank-row scanning was implemented.** The `scanForArtifacts` function (test file lines 193-263) implements all three detection methods: blank-row artifact scan (7a), suspicious pattern scan (7b), and styled-span-in-blank-row scan (section 11 Risk 1). This is faithful and even goes beyond the minimum.

**4. Key deviation: pre-refresh content was not visible in browser.** The design (section 3d) says: "If this check fails, the terminal did not render correctly and the test should abort with a diagnostic screenshot rather than give a false PASS." The test logged a WARNING (line 556-557) but continued instead of aborting. The design explicitly says abort. This is a material deviation -- by continuing, the test ran the refresh-and-verify cycle against a terminal that had no old content to clear, making criteria 1 and 2 vacuous.

**5. Deviation: `rows: 30` created but terminal had 41 rows.** The session was created with 30 rows but the browser terminal rendered with 41. No attempt was made to increase line count to compensate (design Risk 4 mitigation not applied).

**6. Pixel inspection (section 7c) was not implemented,** consistent with the design's "Fallback" guidance in section 8. This is a documented, acceptable deviation.

## Overall Verdict
**INCONCLUSIVE -- NEEDS RERUN**

The test correctly confirmed that the `\x1bc` regression is absent from the codebase and that no DOM-visible artifacts appeared. However, two of the six pass criteria were satisfied vacuously because the pre-refresh content was never visible in the browser terminal. The scrollback-reset verification did not test a real scrollback-clearing scenario. The test should have aborted per its own design (section 3d) when `lastContentRow < 5`, but instead continued and reported PASS.

This is not a false positive in the sense that the fix is genuinely present. But it IS a weak pass -- the test did not exercise the specific scenario (clearing a terminal with real scrollback content) that it was designed to verify.

## Recommended next action

1. **Increase line count to 50+ lines** (change `seq 1 10` to `seq 1 50` at test file line 443) so that scrollback is guaranteed to exceed the viewport even with 41 rows.
2. **Enforce the pre-content gate:** Change the `lastContentRow < 5` warning (test file line 555-558) from a `console.warn` to an `expect(...).toBeGreaterThanOrEqual(5)` assertion, matching the design's abort instruction.
3. **Consider opening the browser BEFORE producing the echo lines,** or use a WS subscription that delivers the scrollback to the browser terminal, so the pre-refresh state actually contains the `T03-LINE-` content in the DOM.
4. **Re-run after fixes** to get a genuine pass where scrollback actually exists and is verified to be cleared.
