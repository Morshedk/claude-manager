# Terminal Copy & Scrollbar — Adversarial Validation

**Validator role:** find false PASSes. Every claim below is evidenced against the test source, the implementation source, and the runtime output in `04-test-run-output.txt`.

---

## T-1: Ctrl+C with selection copies text, does NOT send SIGINT

1. **Outcome valid?** **GENUINE PASS (with a caveat)**. The clipboard-population assertion is real: `expect(clipboardText).toContain('COPY_TARGET_abc123')` passed against a live browser + xterm instance, proving the Ctrl+C-on-selection code path executed end-to-end (keydown → `attachCustomKeyEventHandler` → `navigator.clipboard.writeText`). The toast assertion (`toastCount > 0`) is also genuine.
   - **Caveat / partial vacuous**: the companion assertion `expect(hasSIGINT).toBe(false)` is weak. Unlike every other test (T-2 … T-7), T-1 does **not** pass `command: 'bash'` when creating the session (see line 62-74; `command` field is absent → server default = `claude`). If the handler incorrectly returned `true` and SIGINT was also dispatched, the `claude` CLI does not print a visible `^C` marker on SIGINT the way bash does, so `termTextAfter.includes('^C')` would still be `false`. The "no SIGINT" leg of this test is therefore not a reliable discriminator for Risk 1.
   - Net verdict: the copy pathway is genuinely verified; the SIGINT-was-not-sent leg is weakly established. Because the design's Risk 1 explicitly calls out that a test must verify SIGINT is NOT sent, this leg should have used bash. Calling it a pass with reservation.

2. **Design sound?** Mostly. Design calls for verifying both (a) clipboard has selected text and (b) PTY did NOT receive `\x03`. The test design for T-1 relies on the `^C` bash echo as a proxy for (b), which fails when the session runs `claude`. A stronger design would either force bash or instrument the server to count `\x03` bytes written to the PTY.

3. **Execution faithful?** Partially. The test executes but omits `command: 'bash'` that the design (implicitly) and every sibling test require.

---

## T-2: Ctrl+C with NO selection sends SIGINT

1. **Outcome valid?** **GENUINE PASS**. Test uses `command: 'bash'` so `^C` is a reliable SIGINT marker. `STILL_ALIVE` round-trip proves the shell is responsive post-interrupt. `toastCount === 0` confirms no copy branch fired.

2. **Design sound?** Yes — directly targets Risk 5 (handler swallows all Ctrl+C).

3. **Execution faithful?** Yes.

---

## T-3: Scrollbar always visible without hover

1. **Outcome valid?** **GENUINE PASS**. The test inspects actual CSS rules (not just computed styles on the DOM), extracts the alpha value from the thumb background `rgba(...)` and asserts it is > 0, asserts `width: 6px`, and asserts hover alpha > at-rest alpha. It also verifies `scrollHeight > clientHeight` so the scrollbar is semantically needed.

2. **Design sound?** Yes. Correctly addresses Risk 3 (scrollbar CSS overridden) by reading the actual authored rule rather than trusting the vendor cascade. The fix applied in round 3 (tightening the regex to `rgba(\s*255\s*,\s*255\s*,\s*255\s*,\s*0\s*)`) was a correct bug fix — the original `\b` boundary gave false positives.

3. **Execution faithful?** Yes. CSS in `public/css/styles.css` lines 779-795 matches exactly what the test looks for: `width: 6px`, `border-radius: 3px`, thumb `rgba(255,255,255,0.2)` at rest, `rgba(255,255,255,0.4)` on hover, Firefox `scrollbar-color` variants.

   **Note (minor)**: T-3 does not verify Risk 4 ("scrollbar visible but not functional"). It never drags the thumb or checks scroll-to-position behavior. The design doc explicitly lists drag interaction as acceptance criterion #9. This is a **coverage gap**, not a false pass.

---

## T-4: Right-click copies selection, suppresses context menu

1. **Outcome valid?** **GENUINE PASS (weak on one leg)**. Clipboard-population and toast assertions are genuine. The "context menu suppressed" assertion is weak: the test installs a **capture-phase** listener (third arg `true`), which runs before the element-level handler calls `preventDefault()`. The listener therefore always records `defaultPrevented: false`. The test only verifies `contextMenuState.length > 0`, which just proves a `contextmenu` event reached the page — not that it was suppressed. The test's comment acknowledges this ("clipboard being populated proves the handler was called") and uses the clipboard assertion as an indirect proof. That indirection is fair (the implementation at TerminalPane.js:127-134 does call `preventDefault()` in the same `if (sel.length > 0)` block that performs the clipboard write), but the test does not independently verify suppression — a future regression that removes only the `preventDefault()` call would still false-pass this test.

2. **Design sound?** Mostly. The design calls for verifying the browser context menu does NOT appear. A stronger check would attach a bubble-phase listener (capture=false), or check `e.defaultPrevented` after the event bubbles, or verify no native menu element appears in the DOM. The chosen capture-phase approach cannot detect preventDefault.

3. **Execution faithful?** Yes, matches the test design.

---

## T-5: Ctrl+Shift+C copy alt

1. **Outcome valid?** **Part A = GENUINE PASS. Part B = VACUOUS PASS.**
   - **Part A**: clipboard contains `SHIFT_COPY_TEST`, toast fires, no `^C` in the bash output — all genuine.
   - **Part B (vacuous)**: the test is supposed to verify that `Ctrl+Shift+C` without selection does NOT send SIGINT (so `sleep 30` keeps running). The final assertion is `expect(hasSIGINTB).toBe(true)` — and `hasSIGINTB` is computed by checking for `^C` **after also issuing a plain Ctrl+C**. If Ctrl+Shift+C-without-selection wrongly sent SIGINT:
     - `sleep 30` would already be interrupted, shell returns to prompt.
     - The follow-up plain Ctrl+C still prints `^C` at the prompt (bash echoes `^C` for an interrupt at prompt too).
     - `hasSIGINTB` would still be `true`.
     Both correct and incorrect handler behavior produce the same `true` outcome. The test cannot distinguish them. It never verifies that `sleep 30` was still running between the Ctrl+Shift+C and the plain Ctrl+C. This is exactly the "test passed but precondition was never established" pattern — **vacuous**.
     
     (Correct approach: between the Ctrl+Shift+C and the plain Ctrl+C, assert that the terminal has NOT printed `^C` yet, or check that `sleep 30` is in the process list, or time how long the command has been running.)

2. **Design sound?** The design doc for T-5 is correct ("verify `sleep 30` is STILL RUNNING"). The implementation of that design is what went wrong.

3. **Execution faithful?** **No.** The design says "Wait 2 seconds. Verify `sleep 30` is STILL RUNNING (no `^C`, no shell prompt returned)." The executor replaced this with a definitive check that only verifies plain Ctrl+C works later — which is a different (and weaker) assertion. This is a faithfulness failure.

---

## T-6: Copy works in readOnly mode

1. **Outcome valid?** **GENUINE PASS**. Static analysis reads the source and verifies `attachCustomKeyEventHandler` appears before `if (!readOnly)`. Confirmed in TerminalPane.js: `attachCustomKeyEventHandler` at line 104; `if (!readOnly)` at line 167 — handler is outside/before the guard. The functional leg additionally proves the handler fires and clipboard is populated.

2. **Design sound?** Yes — a source-level ordering check is precisely the assertion needed here, because readOnly mode is not easily toggled in the UI. The combination (static structure + functional proof that the same code path works) is sound.

3. **Execution faithful?** Yes.

---

## T-7: Adversarial — rapid Ctrl+C with flickering selection

1. **Outcome valid?** **GENUINE PASS**. The test: installs page-error + console-error listeners, injects a MutationObserver that logs toast DOM insertions (to catch expired toasts), runs 3 rapid select-drag + Ctrl+C cycles against a live streaming process, confirms at least one toast appeared, and confirms the terminal is still responsive via a round-trip (`T7_ALIVE`). All three assertions are real and independently testable.

2. **Design sound?** Yes. The design explicitly says either outcome (process interrupted OR not) is acceptable as long as no crash occurs; test matches.

3. **Execution faithful?** Yes. Fix applied in round 3 (switching from `yes` to a paced `while … sleep 0.05` loop and tracking toast history via MutationObserver) is a legitimate adaptation to xterm's selection-clearing on heavy output, not a test weakening.

---

## T-8: ProjectTerminalPane has identical copy behavior

1. **Outcome valid?** **VACUOUS PASS for the functional leg; GENUINE PASS for the static-analysis leg.**
   - Static analysis (10 string-presence checks on `ProjectTerminalPane.js`) legitimately confirms that all copy-handler elements are in source. Inspecting ProjectTerminalPane.js lines 85-124 confirms all 10 elements are present and structurally identical to TerminalPane.js.
   - The functional leg explicitly **skipped** testing behavior because the terminal tab UI is not exposed ("ProjectTerminalPane is not mounted in the current ProjectDetail UI"). The test returns early without running any functional assertion. The runtime output confirms: "Functional test was skipped — the project terminal is not exposed in the browser UI for a project (no terminal tab button found)."
   - This skip is **pure static analysis**. It cannot detect runtime divergences: wrong xterm reference, missed handler registration timing, `readOnly`-guard regressions specific to ProjectTerminalPane. Every Risk 8 concern ("ProjectTerminalPane changes forgotten" in a structural sense) is covered; runtime behavioral parity is **not** covered.
   - Net: the pass is valid for what it actually tested (source parity), but it is **weaker than the test design promises**. The design's acceptance criterion 10 ("copy behavior is identical to the session terminal — selected text is copied, no SIGINT is sent") is not functionally verified for ProjectTerminalPane.

2. **Design sound?** The design was for a full Playwright functional test. Falling back to source-only verification when the UI surface is absent is reasonable but should be flagged as a gap rather than claimed as a pass for the behavioral acceptance criterion.

3. **Execution faithful?** Partially. The executor bailed out of the functional half rather than surfacing the missing UI as a test-blocker. Per the executor's own notes, this is intentional ("static analysis is sufficient per design") — but the design does not actually say that; the design says `Test type: Playwright browser`.

---

## Overall verdict: **FEATURE PARTIAL**

Implementation is faithful to the design, no security issues, no race conditions — but two tests do not reliably prove what they claim, and one has a known coverage gap.

### Confirmed working (implementation-verified)

- CSS scrollbar is always visible at 6px, brighter on hover (T-3).
- Ctrl+C with selection populates the clipboard and fires a toast (T-1 partial, T-6, T-7).
- Ctrl+C with no selection passes through as SIGINT (T-2).
- Right-click with selection populates the clipboard (T-4).
- Ctrl+Shift+C with selection populates the clipboard (T-5 Part A).
- Copy handler is registered before the `readOnly` guard (T-6 static).
- ProjectTerminalPane contains structurally identical copy-handler source (T-8 static).
- No crashes under rapid-fire stress (T-7).

### False-PASS and coverage findings

1. **T-5 Part B is a VACUOUS PASS.** The assertion `expect(hasSIGINTB).toBe(true)` cannot distinguish a correct Ctrl+Shift+C-no-selection implementation (which does nothing) from a broken one that sends SIGINT. Both paths produce the same `^C` in the final terminal output. Fix: between `Ctrl+Shift+C` and the follow-up plain Ctrl+C, the test must positively assert `sleep 30` is still running (no `^C` yet, no prompt returned).

2. **T-1's "no SIGINT" leg is weakly established.** The session runs `claude` (default command), which does not print `^C` on SIGINT. Every sibling test uses `command: 'bash'`; T-1 should too. This does not affect the genuine clipboard assertion, but it means Risk 1 ("copy AND also SIGINT") is not adequately guarded.

3. **T-4's context-menu suppression check is weak.** Only a capture-phase listener is installed, so `preventDefault` cannot be observed. Suppression is inferred from clipboard-population. A regression that deletes only `e.preventDefault()` (without touching the copy path) would false-pass this test.

4. **T-8 functional leg is skipped.** Acceptance criterion #10 (behavioral parity of ProjectTerminalPane) is not exercised at runtime. The static check is real but narrower than the design promised.

5. **Acceptance criterion #9 (scrollbar drag scrolls the viewport) is not tested** by any test. T-3 verifies appearance only. This is a coverage gap, not a false pass.

### Recommended remediation before declaring feature complete

- Harden T-5 Part B with an intermediate "sleep still running" check.
- Add `command: 'bash'` to T-1 session creation.
- In T-4, add a bubble-phase listener or DOM check to directly verify `preventDefault`.
- Either expose the project terminal in the test harness or explicitly mark criterion #10 as "source-verified only" rather than "passed".
- Add a drag-scrollbar test (criterion #9) or mark as manual-verified.

None of the findings above indicate the implementation is broken — the code review (03-review.md) correctly identifies the implementation as faithful. The test suite is the weaker artifact: it does not adversarially probe the exact failure modes the design enumerated as Risks.
