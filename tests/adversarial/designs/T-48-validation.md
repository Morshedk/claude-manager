# T-48 Validation: Settings Escape Key Discards Changes

**Validator role:** Adversarial review of design + execution  
**Date:** 2026-04-08  
**Verdict:** GENUINE FAIL — real bug confirmed in production code

---

## Question 1: Did the test pass? (actual outcome)

**No — 2 of 3 sub-tests failed.**

- T-48A (no terminal): **FAIL** — Modal still open after Escape
- T-48B (with terminal): **FAIL** — Modal still open after Escape  
- T-48 crash log check: PASS (no server crashes)

Exact failure:
```
[T-48A] Modal open after Escape: true
Error: Modal must be CLOSED after pressing Escape
Expected: false, Received: true

[T-48B] Modal open after Escape: true  
Error: Modal must be CLOSED after Escape even with terminal overlay
Expected: false, Received: true
```

The `SettingsModal` does not handle Escape at all — even without a terminal overlay present. This is a self-contained bug in the modal component.

---

## Question 2: Was the design correct? (meaningful assertions, real failure detection)

**Yes — the design correctly predicted this outcome and tested the right behavior.**

### What the design found in code analysis

The design read `SettingsModal.js` and identified:
- No `onKeyDown` handler on the modal-overlay div
- No global `document.addEventListener('keydown')` for Escape
- The only close paths are: (a) clicking the overlay background (`onClick=${closeSettingsModal}`), (b) clicking Cancel button, (c) clicking Save button

The design predicted: "Escape is NOT handled by SettingsModal explicitly. Expected test outcome for A5: Browser default Escape handling may or may not close the modal."

**This prediction was correct.** The modal does not close on Escape.

### Root cause of the bug

`SettingsModal` uses a `modal-overlay` div with `onClick=${closeSettingsModal}` for click-outside-to-close. There is no equivalent keyboard handler. In HTML, modal dialogs created with `<dialog>` elements get Escape handling for free, but this is a custom div-based modal — Escape must be handled explicitly.

The fix would be to add a `keydown` listener to the modal overlay (or the document) that calls `closeSettingsModal()` on `key === 'Escape'`. Crucially, the handler must call `event.stopPropagation()` to prevent xterm.js from receiving the Escape sequence when the terminal pane is behind the modal.

### Design gaps

The design identified the correct root cause but its "expected finding" section was framed as "based on the code analysis, Escape does NOT close the modal." This is a correct assessment.

One gap: the design hypothesized that with a terminal open (T-48B), xterm might be the interceptor. The actual failure shows the modal doesn't handle Escape even WITHOUT a terminal (T-48A). The xterm interception theory is secondary — the primary issue is that no one handles Escape.

**This does not change the verdict.** The test correctly found the bug. The distinction between "xterm intercepts Escape" and "modal has no Escape handler" is an implementation detail — both result in the same observable failure.

---

## Question 3: Was the execution faithful?

**Yes — the implementation correctly implements the design.**

- Modal opened via Settings button click ✓
- Model changed from "sonnet" to "haiku" ✓
- Change verified in select before Escape ✓
- Escape pressed via `page.keyboard.press('Escape')` ✓
- Modal visibility checked via `getComputedStyle` (not just DOM presence) ✓
- API checked to confirm settings not saved ✓ (not reached due to failure at modal-open check)
- T-48B created a bash session and opened terminal overlay before Settings ✓
- Modal click before Escape to capture focus (sound approach) ✓

One deviation: The executor clicked `'.modal-wide .modal-header'` before pressing Escape to ensure focus is on the modal. This is reasonable but note that it doesn't actually help since the modal has no keydown handler — keyboard focus on the modal header still produces no Escape handling. The test result would be identical without this click.

The design also specified a check for "Escape not forwarded to PTY" (T-48B step B7). This check was not reached in execution because the test failed at the "modal closed" assertion before reaching it. This is correct — failing fast on the primary assertion is appropriate.

---

## The Bug

**`SettingsModal` has no Escape key handler.**

- Severity: Medium-high. Users naturally press Escape to dismiss modals. Discovering that Escape doesn't work is jarring UX. Combined with the fact that xterm captures keystrokes, users with a terminal open who try to dismiss Settings with Escape will send `\x1b` to their running Claude session instead.

- File: `/home/claude-runner/apps/claude-web-app-v2/public/js/components/SettingsModal.js`

- Fix: Add `onKeyDown=${e => { if (e.key === 'Escape') { e.stopPropagation(); closeSettingsModal(); } }}` to the outer `.modal-overlay` div. Ensure `stopPropagation()` is included to prevent xterm from receiving the Escape sequence.

- The same issue likely affects `NewSessionModal`, `NewProjectModal`, and `EditProjectModal` — they should all be audited for Escape handling.

---

## Conclusion

**T-48: GENUINE FAIL**

The test found a real product bug: `SettingsModal` does not close on Escape key press. The behavior is confirmed in both the no-terminal and with-terminal scenarios. The test is correctly implemented and would detect this bug reliably. The fix requires adding an `onKeyDown` handler to the modal overlay with `stopPropagation()`.

The design's code analysis accurately predicted the failure before a single line of test code was written — demonstrating the value of the design phase in the 3-agent pipeline.
