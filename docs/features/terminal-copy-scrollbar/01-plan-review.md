# Plan Review: Terminal Copy & Scrollbar

**Reviewer:** Independent plan reviewer (adversarial)
**Date:** 2026-04-15
**Design document:** `docs/features/terminal-copy-scrollbar/01-design.md`

---

### Verdict: APPROVED

This design document is ready for implementation. It is unusually thorough: all five required sections are present and substantive, file:line citations are accurate and verifiable, the data flow is described end-to-end for all three interaction paths, scope boundaries are explicit, and the risk section identifies real failure modes including false-PASS scenarios.

---

## Verification of codebase citations

I spot-checked every file:line reference in the document against the actual codebase. Results:

| Claim | Actual | Status |
|-------|--------|--------|
| `TerminalPane.js` line 12: `selectionBackground: 'rgba(0,212,170,0.25)'` | Line 12 | Correct |
| `TerminalPane.js` line 54: `rightClickSelectsWord: true` | Line 54 | Correct |
| `TerminalPane.js` line 77: `xterm.open(container)` | Line 77 | Correct |
| `TerminalPane.js` line 80: WebGL addon | Line 80 | Correct |
| `TerminalPane.js` line 92: `xtermRef.current = { xterm, fitAddon }` | Line 92 | Correct |
| `TerminalPane.js` lines 125-132: onData with DA/OSC/mouse filters | Lines 125-132 | Correct |
| `TerminalPane.js` line 131: `send({ type: CLIENT.SESSION_INPUT, ... })` | Line 131 | Correct |
| `TerminalPane.js` line 37: `readOnly` parameter | Line 37 | Correct |
| `TerminalPane.js` line 124: `if (!readOnly)` | Line 124 | Correct |
| `TerminalPane.js` line 212: cleanup return | Line 212 | Correct |
| `ProjectTerminalPane.js` line 12: `selectionBackground` | Line 12 | Correct |
| `ProjectTerminalPane.js` line 51: `rightClickSelectsWord: true` | Line 50 | Off by 1 (minor) |
| `ProjectTerminalPane.js` line 73: `xterm.open(container)` | Line 73 | Correct |
| `ProjectTerminalPane.js` line 81: `xtermRef.current = { xterm, fitAddon }` | Line 81 | Correct |
| `ProjectTerminalPane.js` line 154: cleanup return | Line 154 | Correct |
| `styles.css` lines 779-799: terminal scrollbar section | Lines 779-799 | Correct |
| `index.html` line 11: `styles.css`, line 12: `xterm.min.css` | Lines 11-12 | Correct |
| `xterm.min.css` line 7: `user-select: none` on `.xterm` | Line 7 | Correct |
| `App.js` lines 19-50: `ToastContainer` | Lines 19-50 | Correct |
| `SessionOverlay.js` line 199: `TerminalPane` mounted | Line 199 | Correct |
| `actions.js`: `showToast` export | Line 132 | Correct |

All citations check out. The ProjectTerminalPane `rightClickSelectsWord` is on line 50 rather than 51, which is a trivial off-by-one that does not affect implementation.

---

## Section-by-section assessment

### Section 1: Problem & Context -- Pass

Clearly identifies two distinct problems (copy and scrollbar), explains what exists today, identifies the exact blocking mechanisms (vendor CSS `user-select: none`, no `navigator.clipboard.writeText` call, no `customKeyEventHandler`), and enumerates what is missing. The distinction between xterm's canvas-based selection (which already works visually) and the missing clipboard wiring is well articulated.

### Section 2: Design Decision -- Pass

- Four capabilities (A-D) are clearly scoped.
- Every file to modify is named with exact insertion points (after line 92, after line 81, lines 779-799).
- Functions/methods to add are described precisely: `attachCustomKeyEventHandler`, `contextmenu` listener, `showToast` import, cleanup.
- Data flow is described end-to-end for all three paths (copy, no-selection SIGINT, right-click).
- The "Files NOT to modify" section is explicit and well-reasoned.
- Edge cases (clipboard permission denial, empty selection, Ctrl+Shift+C, Cmd+C, readOnly mode, multiple terminals, large selections, WebGL compatibility) are addressed individually.

### Section 3: Acceptance Criteria -- Pass

All 10 criteria follow the Given/When/Then pattern and describe observable outcomes from the running application. None are internal state assertions. The criteria cover both positive paths (copy works) and negative paths (SIGINT still works when no selection). Criterion 10 explicitly guards against the "forgot ProjectTerminalPane" risk.

### Section 4: Lifecycle Stories -- Pass

All five stories are written as user journeys with specific, observable actions and outcomes. They are not feature lists or technical steps. Stories cover the happy path (Story 1), the dual-behavior nuance (Story 2), scrollbar discovery (Story 3), the ProjectTerminalPane variant (Story 4), and the failure/degradation path (Story 5).

### Section 5: Risks & False-PASS Risks -- Pass

Eight risks are identified, most of which are specific to this feature rather than generic. Notably:
- Risk 1 (copy but also SIGINT) and Risk 5 (handler swallows ALL Ctrl+C) both identify false-PASS scenarios with specific guidance on what a test must verify.
- Risk 2 (handler registration timing) identifies an xterm.js-specific ordering requirement.
- Risk 3 (CSS load order specificity) is grounded in the actual `index.html` load order (styles.css before xterm.min.css).
- Risk 7 (right-click event ordering) demonstrates understanding of browser event sequencing.

---

## Minor observations (non-blocking)

1. **Off-by-one line reference.** `ProjectTerminalPane.js` `rightClickSelectsWord` is on line 50, not line 51 as stated. Does not affect implementation.

2. **Fire-and-forget clipboard write.** The design notes that `navigator.clipboard.writeText()` returns a Promise and is "fire-and-forget" (Section 2.4, step 6), but Section 2.5 says the handler should catch rejections and show an error toast. These are consistent in intent (catch but don't await before returning false) but the implementer should be aware that returning `false` synchronously while the promise is still pending means the error toast will appear after the key event has already been suppressed. This is the correct behavior (you don't want to send SIGINT just because the clipboard write failed), but it is worth a code comment.

3. **CSS load order risk is real but already mitigated.** Risk 3 correctly identifies that `styles.css` loads before `xterm.min.css` (lines 11-12 of `index.html`). The terminal scrollbar selectors in `styles.css` (`.xterm-viewport`) match the vendor's selectors at equal specificity, meaning the vendor rules win due to later load order. However, the current hover-only scrollbar CSS already works in production (the hover effect does take effect), which means the existing selectors are already winning despite the load order. This is likely because the custom rules are more specific (e.g., `.xterm:hover .xterm-viewport` vs bare `.xterm-viewport`). The implementer should verify the always-visible styles actually apply, but this is not a design gap -- the risk is acknowledged.

4. **ProjectTerminalPane has no readOnly mode.** The design correctly notes that `readOnly` only applies to `TerminalPane.js` and that the `customKeyEventHandler` should be registered regardless. `ProjectTerminalPane` has no `readOnly` parameter, so this is a non-issue there, but the design does not explicitly call this out for ProjectTerminalPane. Not a problem for implementation.

5. **No acceptance criterion for the copy-failure toast.** Story 5 describes the clipboard-unavailable scenario and the error toast, but no acceptance criterion in Section 3 covers the failure path ("Copy failed -- check clipboard permissions" toast). This is a very edge case (only non-HTTPS, non-localhost), so it is non-blocking, but an implementer relying only on Section 3 might skip the error handling. The edge case coverage in Section 2.5 is sufficient guidance.
