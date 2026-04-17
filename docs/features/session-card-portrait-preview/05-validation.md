# Session Card Portrait Preview -- Test Validation

Date: 2026-04-09
Validator role: Adversarial (find false PASSes)

---

## T-1: Portrait card DOM structure

**Outcome: GENUINE PASS**

**Design sound?** Yes. The test checks all four structural sections (titlebar, tags, preview, actionbar), verifies flex-direction is column (not the old row layout), confirms the preview is a `<pre>` element (not xterm canvas), and asserts the legacy `.session-card-actions` class is absent. This covers the core layout acceptance criteria (AC #1) and would catch regressions to the old card format.

**Execution faithful?** Yes. The test code (T1 lines 96-181) matches the design (03-test-designs.md T-1 steps 1-11) exactly. All nine assertion points from the design are present in the test:
- `.session-card-titlebar` with `.session-card-name` containing "test-portrait" (step 9a)
- `.session-card-summary` with non-empty text (step 9b)
- `.session-card-tags` with at least one `.badge` (step 9c)
- `pre.session-card-preview` (step 9d)
- `.btn-icon` in `.session-card-actionbar` (step 9e)
- No `.session-card-actions` legacy element (step 10)
- `flex-direction: column` (step 11)

**Minor note:** The test does not verify the 5-7 word limit on the summary or the em-dash separator styling. These are cosmetic details not in the acceptance criteria and not claimed by the test.

---

## T-2: Preview lines update after PTY output

**Outcome: GENUINE PASS**

**Design sound?** Yes. This test exercises the core preview pipeline end-to-end: PTY input -> ring buffer -> 20s interval -> `getPreviewLines()` -> `stripAnsi()` -> `session.meta.previewLines` -> REST API response. The use of a unique marker string (`PREVIEW_MARKER_T2_UNIQUE_12345`) prevents false passes from stale/placeholder content. The 25s wait (20s interval + 5s margin) is correctly calibrated. This covers AC #2.

**Execution faithful?** Yes. The test code (T2 lines 46-123) follows the design steps: create session, subscribe, send distinctive input via `session:input`, wait 25s, check REST API for `previewLines` containing the marker. The sentinel check is strong -- a vacuous pass would require the marker string to appear in previewLines without the preview pipeline functioning, which is not possible.

**Risk assessment:** Could this pass vacuously? Only if `previewLines` were populated by some mechanism other than the preview interval (e.g., the echo command appearing in the PTY input echo). But the pipeline requires `getPreviewLines()` -> `stripAnsi()` -> `meta.previewLines`, so even if the content source is trivial, the pipeline itself is exercised. Genuine.

---

## T-3: cardSummary after watchdog

**Outcome: GENUINE FAIL**

**Design sound?** Yes. The test correctly targets AC #4 (watchdog generates cardSummary). The 90s timeout with continuous WS monitoring and REST fallback is thorough. The test creates a direct-mode session with >500 bytes of output to exceed `MIN_DELTA_FOR_SUMMARY`.

**Execution faithful?** Yes. The test code matches the design.

**Verification of the reported bug:** The bug is CONFIRMED REAL. Here is the evidence:

1. At WatchdogManager.js line 1050, inside the managed-sessions summarization loop:
   ```
   if (!this.tmuxSessionExists(tmuxName)) continue;
   ```
   This line runs for ALL managed sessions, including direct-mode sessions.

2. For direct-mode sessions, `tmuxName` resolves to `ms.tmuxName || ms.name`. Direct-mode sessions do not create tmux windows, so `tmuxSessionExists()` calls `tmux list-sessions` and the session name is never found, returning `false`.

3. The `continue` skips `summarizeSession()`, so `cardLabel` is never extracted and `liveSession.meta.cardSummary` (line 635) is never set.

4. This means cardSummary is ONLY populated for tmux-mode sessions. Direct-mode sessions will always show "No summary yet." This is a real feature gap -- the design document (Section 2) does not distinguish between modes for summary generation.

**Impact:** This breaks AC #4 for any direct-mode session. The feature works correctly for tmux-mode sessions.

---

## T-4: Settings change affects preview count

**Outcome: GENUINE PASS**

**Design sound?** Yes. Tests AC #7 (settings change takes effect). The two-phase approach (measure before change, measure after change) with the specific assertion that the count decreased from <=20 to <=10 is sound. The 25s wait on each phase accounts for the 20s interval.

**Execution faithful?** Yes. The test code matches the design. The observed values (17 before, 10 after) confirm the setting takes effect. The setting is re-read on each tick, not cached.

**Could this be vacuous?** No. The before/after comparison with different line count limits proves the setting change propagated. A false pass would require the preview count to independently drop to <=10 between the two measurements, which is not plausible given the session produced 40 lines of output.

---

## T-5: Adversarial ANSI stripping

**Outcome: GENUINE FAIL**

**Design sound?** Yes. The test uses real ESC bytes via `$'...'` ANSI-C quoting, tests multiple escape families (CSI, OSC, private modes, G-set, cursor movement), includes a CLEAN_SENTINEL_LINE control to verify the echo commands worked, and checks both the REST API data and the browser DOM for XSS vectors. This is a strong adversarial test covering AC #9.

**Execution faithful?** Yes. The three-attempt progression is well-documented. Attempts 1-2 were infrastructure issues (wrong shell, literal backslashes). Attempt 3 used correct ESC bytes and found real bugs.

**Verification of the three reported bugs:**

All three are CONFIRMED REAL by source code analysis of `lib/utils/stripAnsi.js`:

**(a) Private-mode CSI sequences leave `?`-param residue (`?2004l`, `?25l`):**
- The CSI regex is `/\x1b\[[0-9;]*[a-zA-Z]/g` -- it matches ESC + `[` + digits/semicolons + letter.
- Private-mode sequences like `\x1b[?2004l` have `?` between `[` and the digits. The regex pattern `[0-9;]*` does not include `?`, so the CSI regex does NOT match.
- The "other escape starters" regex `/\x1b[\[>?=]/g` then matches `\x1b[` (just those two bytes), leaving `?2004l` as visible text residue.
- Fix: The CSI regex should be `/\x1b\[[\?]?[0-9;]*[a-zA-Z]/g` (or more broadly, `/\x1b\[[?!>]*[0-9;]*[a-zA-Z]/g`).

**(b) `\r` (carriage return) not stripped:**
- The control byte regex is `/[\x00-\x09\x0b\x0c\x0e-\x1f]/g`. The range `\x00-\x09` covers 0-9, then `\x0b\x0c` covers 11-12, then `\x0e-\x1f` covers 14-31. This deliberately SKIPS `\x0a` (LF=10) and `\x0d` (CR=13).
- The comment says "keep \n \r \t" -- CR preservation is intentional in the code.
- However, for preview lines (which are split by `\n`), a CR within a line is a control character that should not appear in displayed text. It is a bug in the context of preview lines, even if it was a deliberate choice for other use cases of `stripAnsi`.

**(c) `[31m` residue from command echo context:**
- This is a subtler issue. When the user types `printf $'\x1b[31m...'` into the terminal, the PTY echo shows the command text. The shell interprets `$'\x1b[31m'` and sends actual ESC bytes to the terminal for the OUTPUT, but the command echo in the ring buffer may contain the literal characters `[31m` without a preceding ESC byte (because the shell strips the `$'...'` quoting from the echo). This produces `[31m` text that is not an ANSI escape sequence -- it is literal text from the command echo. This is arguably not a stripAnsi bug but rather an artifact of testing methodology (the command itself is visible in PTY output). However, it still produces garbled-looking text in preview lines.

**Revised assessment of bug (c):** INCONCLUSIVE. The `[31m` residue may be from the command echo line (the user's typed command), not from actual ANSI output. If so, it is not a stripAnsi bug -- it is an inherent limitation of showing raw PTY scrollback that includes command echo. The test design does not distinguish between command echo lines and output lines. Bugs (a) and (b) are unambiguously real.

---

## T-6: Wrench icon opens EditSessionModal

**Outcome: GENUINE PASS**

**Design sound?** Yes. Tests AC #6 (wrench icon, no "Open" button, edit modal opens). The test verifies `title="Edit session"`, confirms the modal appears with a pre-filled name input, and checks that the session overlay did not open (stopPropagation working).

**Execution faithful?** Yes. The test code matches the design. The assertion that `inputValue === 'wrench-test'` confirms the edit modal opened for the correct session. The absence of canvas elements (terminal) after clicking the wrench confirms stopPropagation prevented session attach.

**Could this be vacuous?** No. The pre-filled input value matching the session name is a strong signal. A false pass would require either (a) a modal appearing with the correct session name by coincidence, or (b) the session attaching AND a modal appearing simultaneously, neither of which is plausible.

---

## T-7: Duplicate .btn-icon CSS regression

**Outcome: GENUINE FAIL (expected)**

**Design sound?** Yes. This is a regression detection test for a known CSS bug identified in 03-review.md. The test asserts the CORRECT values (padding: 0px, 24x24) and fails because the actual computed values show padding: 6px from the later CSS rule.

**Execution faithful?** Yes. The test matches the design exactly. The observed values (padding: 6px, width: 24px, height: 24px) match the prediction from the review document -- the later `.btn-icon { padding: 6px; }` rule at line 587 overrides the portrait-specific `padding: 0` at line 379 because both selectors have equal specificity and the later one wins.

**Verification:** CONFIRMED. The CSS file has:
- Line 379-393: `.btn-icon { ... padding: 0; width: 24px; height: 24px; ... }`
- Line 587: `.btn-icon { padding: 6px; border-radius: var(--radius-sm); color: var(--text-secondary); }`

Same selector, later position wins for `padding`. The width/height are unaffected because line 587 does not set them.

**Fix:** Either increase the specificity of the portrait rule (e.g., `.session-card-actionbar .btn-icon`) or remove the duplicate generic rule at line 587.

---

## Summary Table

| Test | Claimed | Validated | Verdict |
|------|---------|-----------|---------|
| T-1  | PASS    | GENUINE PASS | Layout correct, all sections present |
| T-2  | PASS    | GENUINE PASS | Preview pipeline works end-to-end |
| T-3  | FAIL    | GENUINE FAIL | Watchdog skips direct-mode sessions via `tmuxSessionExists` gate |
| T-4  | PASS    | GENUINE PASS | Settings change propagates to next sweep |
| T-5  | FAIL    | GENUINE FAIL | stripAnsi misses private-mode CSI (`?2004l`) and preserves CR |
| T-6  | PASS    | GENUINE PASS | Wrench opens edit modal, stopPropagation works |
| T-7  | FAIL    | GENUINE FAIL (expected) | Duplicate CSS rule overrides padding to 6px |

No VACUOUS PASSes found. No false PASSes found. All four PASSes are genuine. All three FAILs are genuine.

---

## Overall Verdict: FEATURE PARTIAL

### Bugs that must be fixed before promotion

1. **T-3: cardSummary not generated for direct-mode sessions** (severity: HIGH)
   - Location: `lib/watchdog/WatchdogManager.js` line 1050
   - The `tmuxSessionExists()` gate blocks summarization for all non-tmux sessions. Direct-mode sessions never receive a cardSummary.
   - Fix: Add a branch that uses `DirectSession.getPreviewLines()` (the scrollback buffer) instead of `tmux capture-pane` for direct-mode sessions. The `summarizeSession()` method needs a code path that reads from the session's preview buffer when no tmux window exists.
   - Without this fix, the feature's "5-7 word summary" (a primary differentiator described in all four user lifecycle stories) only works for tmux-mode sessions. Most new sessions created via the web UI default to direct mode.

2. **T-5: stripAnsi misses private-mode CSI sequences** (severity: MEDIUM)
   - Location: `lib/utils/stripAnsi.js` line 9
   - The CSI regex `/\x1b\[[0-9;]*[a-zA-Z]/g` does not match sequences with `?`, `>`, or `!` intermediate bytes (e.g., `\x1b[?2004l` for bracketed paste, `\x1b[?25l` for cursor hide).
   - These are extremely common in real terminal output (every shell session with bracketed paste emits them).
   - Fix: Change the CSI regex to `/\x1b\[[?!>]*[0-9;]*[a-zA-Z]/g`.
   - Without this fix, preview lines will routinely contain `?2004l` and `?25l` garbage text.

### Bugs acceptable as known debt (fix in follow-up)

3. **T-5: CR (`\r`) not stripped from preview lines** (severity: LOW)
   - Location: `lib/utils/stripAnsi.js` line 14
   - The control byte regex intentionally preserves `\r`. For preview lines, CR should be stripped (or CR+following-content should replace the line prefix, simulating carriage return behavior).
   - This is a design trade-off: `stripAnsi` is used in multiple contexts, and changing CR behavior globally could break other callers. A targeted fix (strip CR in `getPreviewLines()` after `stripAnsi`) is safer.
   - Impact: Occasional `\r` bytes in preview text. Visible as invisible characters in `<pre>`, may cause minor rendering artifacts in some browsers.

4. **T-7: Duplicate `.btn-icon` CSS rule** (severity: LOW)
   - Location: `public/css/styles.css` lines 379 and 587
   - The wrench button gets 6px padding instead of 0px. Visually, the button is slightly larger than intended but still functional.
   - Fix: Add `.session-card-actionbar .btn-icon` specificity to the portrait rule, or delete the generic rule at line 587 if it is unused elsewhere.

### What is working

The core feature pipeline is solid:
- Portrait card layout renders correctly with all four sections (T-1)
- Terminal preview pane populates with real PTY output on a 20s interval (T-2)
- Settings changes to preview line count take effect on the next sweep (T-4)
- Wrench icon edit button works with proper stopPropagation (T-6)
- No XSS vectors in preview rendering (T-5 DOM check passed)

### Promotion criteria

Fix bugs #1 and #2 above, then re-run T-3 (with a tmux-mode session as interim workaround, or after the direct-mode fix) and T-5. If both pass, the feature is promotable with bugs #3 and #4 as documented known debt.
