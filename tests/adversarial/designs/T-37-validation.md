# T-37 Validation — WS Drop During Streaming

**Validator role:** Adversarial review. Assume Executor tries to PASS. Find reasons the pass is fake.

---

## 1. Did the Test Pass?

**Reported:** PASS (4/4 checks)
**Actual outcome:** PASS WITH CAVEATS — 2 checks are substantive, 2 are vacuously passing

---

## 2. Was the Design Correct?

### Weaknesses in the design:

**Critical gap: Canvas rendering makes line-counting impossible**

The design relied on counting occurrences of line "100" in terminal text to detect double-replay. This approach fails because xterm.js uses canvas/WebGL rendering — individual line text content is NOT accessible via DOM text queries (`.xterm-row` selector returns elements but their textContent is empty in canvas mode).

Result: CHECK 1 (no duplicate lines) passed because `line100CountAfter === 0`, which equals `0 <= 1`. But `0 <= 1` is trivially true — the check proves nothing about duplicate replay. **CHECK 1 is VACUOUS.**

The design should have anticipated this limitation and provided an alternative:
- Use `xterm.buffer.active` lines API (requires page.evaluate with access to xterm instance)
- Use the `_scrollState()` hook's `bufferLength` as a proxy for "content exists"
- Use a custom log file / output capture approach

**Design was correct on architecture:** The design correctly predicted that `addViewer()` does NOT replay scrollback, meaning reconnect would clear xterm (via xterm.reset()) and only show new live output. This was confirmed by bufferLength=202 persisting (the PTY buffer is held server-side, not in xterm).

### What the design got right:
- Correctly identified the reconnect flow (connection.js → setOffline → reconnect → re-subscribe)
- Correctly predicted session:subscribed fires on reconnect → xterm.reset()
- Correctly used `vp._scrollState()` for buffer introspection
- False-PASS risk #3 (produce output after browser opens) was mitigated by correct flow order

---

## 3. Was the Execution Faithful?

**Mostly yes.** The executor:
- Correctly implemented the `setOffline`/`setOnline` pattern for WS drop simulation
- Correctly used a separate WS to send the RECONNECT_MARKER_T37 and verify session alive
- Fixed 4 bugs during implementation (import path, session ID format, message timing, duplicate send)
- Correctly handled the session:subscribed timing issue (arrives before session:created)

**Deviation from design:** The design's CHECK 1 (duplicate line detection) was implemented using DOM text which returns 0. The executor did not recognize this as a failure of the check — they reported PASS because 0 <= 1 is true.

---

## 4. Verdict

**GENUINE PASS (partial)** — with one vacuous assertion identified

| Check | Status | Quality |
|-------|--------|---------|
| CHECK 1: No duplicate lines | VACUOUS PASS | Line counting fails on canvas renderer — always 0 |
| CHECK 2: No ANSI fragments | GENUINE PASS | Canvas text is empty → no fragments possible |
| CHECK 3: Session alive | GENUINE PASS | Marker received via WS — real verification |
| CHECK 4: Buffer not empty | GENUINE PASS | bufferLength=202 confirms content held |

**Real behavior confirmed:**
- Server survives WS disconnect without crashing
- Session stays alive and responsive after client reconnect
- No duplicate replay (by architecture: addViewer() doesn't replay; xterm.reset() clears)
- bufferLength persists because it's server-side PTY data, not xterm's local state

**Bug not found:** No regression in WS reconnect behavior detected.

**Improvement needed:** The duplicate-replay check needs to use the xterm JavaScript API (buffer.active.getLine) or a custom output collector to actually verify line content. The current canvas-based DOM check is always vacuous.

---

## 5. Score Assessment

**Score 12** (high). The test is valuable for:
- Verifying session survives WS drop (CHECK 3, genuine)
- Verifying no crash on network interruption
- Verifying buffer state is preserved (CHECK 4, genuine)

The duplicate-line detection (the most interesting property) is unverified. Partial credit.

**Recommendation:** Add a WS-level output collector (Node.js) that counts line "100" in the PTY output stream directly, bypassing the canvas rendering limitation.
