# T-25 Validation — Paste Large Input Into Terminal

**Validator role:** Adversarially review design + execution. Override false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS, with nuances.**

**Sub-Test A (WS-level):**
- Genuine and unambiguous. 5000 chars sent, `END_MARKER_5000` found in PTY echo within 101ms. 5011 chars of output received (5000 chars + bash prompt). No WS disconnection. No truncation. This is a clean, direct measurement.

**Sub-Test B (Browser UI):**
- The ClipboardEvent approach worked (browser paste UI marker found). The full 5000-char WS write while browser watching also confirmed: END_MARKER_5000 appeared in both WS output AND browser terminal rendering. UI responsiveness confirmed. No critical console errors.
- **One nuance:** The `Ctrl+V` clipboard approach failed (expected in headless Chrome without explicit clipboard permission + xterm focus state). The ClipboardEvent dispatch on `.xterm-helper-textarea` is a valid alternative that correctly exercises the xterm paste code path.

### 2. Was the design correct?

**MOSTLY CORRECT — the design correctly anticipated the architecture and risks.**

**Correct predictions:**
- xterm `onData` fires once per paste event with the full string (not per-character) — confirmed
- WS message size for 5KB is within limits (ws library default 100MB) — confirmed
- PTY handles single large write without buffering issues — confirmed (101ms round-trip)
- Browser paste UI is more complex; need ClipboardEvent fallback — confirmed

**Design gap:** The design mentioned `xterm.paste()` as an option but noted it's not directly accessible from `page.evaluate`. The ClipboardEvent dispatch on `.xterm-helper-textarea` (not mentioned in the design) turned out to be the practical solution. This is a valid approach that correctly exercises xterm's internal paste handling.

**Design structural strength:** The two sub-test structure (A: WS-level fundamental, B: browser UI) is excellent. If the WS-level test fails, it's a server/PTY issue. If only the browser test fails, it's a xterm/rendering issue. This layered approach gives diagnostic precision.

**Timing assertions:** The 5s deadline for both A and B is appropriate. The actual timing of 101ms is 50x faster than the limit — showing the system has significant headroom.

### 3. Was the execution faithful to the design?

**FAITHFUL with one necessary adaptation:**

The design described Sub-Test B using clipboard API + Ctrl+V. In execution, Ctrl+V didn't work in headless Chrome, so the executor added a ClipboardEvent dispatch fallback. This fallback:
1. Correctly targets `.xterm-helper-textarea` (the actual input element that xterm monitors)
2. Dispatches the event with the correct `DataTransfer` content
3. Is the correct way to simulate paste in headless environments

This is a proper fix, not a shortcut. The executor didn't skip the browser test or replace it with a purely WS-level assertion — they found the right DOM mechanism.

**Additional assertion added (not in design):** The executor added "full 5000-char WS write while browser watching" as part of Sub-Test B. This is a stronger test than the design specified — it not only confirms the browser paste works but also confirms the browser terminal can render large output streams from WS. Both the WS output AND browser terminal rendering were confirmed positive.

---

## Potential False-PASS Analysis

**T-25A:** Could be vacuous if bash didn't actually receive the input?
- No: output was 5011 chars (more than the sent payload), confirming bash echoed back the full input. The `END_MARKER_5000` appeared in the PTY output stream, not just in a pre-set test string.

**T-25B:** Could the ClipboardEvent be intercepted without reaching xterm?
- The marker appeared in the terminal DOM (confirmed `PASTE_TEST` visible in xterm-screen textContent). This means xterm rendered the text, which means the PTY received the input and echoed it back. Not vacuous.

**Responsiveness check:** Could `new Promise(resolve => setTimeout(() => resolve(true), 100))` always succeed?
- Technically yes, but combined with the successful WS output assertion and terminal rendering assertion, the test is not vacuous overall. A hung tab would fail earlier assertions.

---

## Verdict

**GENUINE PASS** — T-25A directly confirms the fundamental path works with no truncation, no WS drop, and 50x timing headroom. T-25B confirms the browser UI can dispatch paste events to xterm and that the full 5000-char round-trip works while the browser is watching. The design is sound and execution is faithful with a necessary clipboard API adaptation.
