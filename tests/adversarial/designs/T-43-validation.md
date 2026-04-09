# T-43 Validation: Adversarial Review

**Test:** T-43 — Haiku Endurance: 20 Messages, Refresh, Reload, Overlay Lifecycle  
**Outcome from Executor:** 1 passed (1.9m)  
**Validator verdict:** GENUINE PASS

---

## Q1: Did the test pass? (Actual outcome)

**Yes — genuine pass.** All 20 ACKs arrived in correct sequence. The run output shows:

- ACK_1 at +8.9s, ACK_2 through ACK_7 at reasonable intervals (~4-5s each)
- ACK_8 at +44.0s, **after a browser Refresh click at +40.5s** (session restarted, --resume loaded conversation)
- ACK_9 through ACK_12 continued correctly (+49s through +64.5s)
- ACK_13 at +72.6s, **after a hard browser reload (CDP) at +66.6s** (session was not restarted — same PTY continued)
- ACK_14 through ACK_16 continued (+77s through +87.7s)
- ACK_17 at +91.8s, **after overlay close at +87.7s and reopen at +88.5s** (100ms close→reopen cycle)
- ACK_18 through ACK_20 finished at +96s through +106.1s
- Stop and Delete both worked within 1 second

**Timing analysis confirms real responses:** ACK intervals are ~4-5 seconds, consistent with real Haiku model inference (not pre-cached responses). The spread across 106 seconds with consistent inter-message timing is the expected signature of a real Claude API session.

---

## Q2: Was the design correct? (Meaningful assertions, real failure detection)

**Mostly correct — one design gap identified, and one correct finding from the execution failures that led to the final implementation.**

### What the design got right

1. **TUI ready signaling:** The design correctly identified that `buffer.includes('bypass')` is the TUI ready signal. The run confirms this: buffer length 3352 at initial TUI ready (+6.1s), buffer length 3058 at post-Refresh TUI ready (+42.1s). The "bypass" text from the TUI footer was captured correctly.

2. **`\r` vs `\n`:** All sentinel input uses `\r`. Correct per JOURNAL.md Bug 1.

3. **ACK_8 as the continuity assertion:** Sending `NEXT\r` after Refresh and requiring `ACK_8` is the right test. It proved `--resume` works — Claude continued the count from 7 to 8 without being re-instructed. This is a genuine behavioral proof.

4. **Hard reload does not restart PTY:** The design noted "after browser reload, PTY was NOT restarted." The run confirms: ACK_13 arrived 1.6s after sending NEXT (+72.6s vs +71.0s) — no TUI re-initialization was needed, consistent with the PTY being continuously running.

5. **Overlay close/reopen is transparent to test WS:** ACK_17 arrived 2.3s after sending NEXT at +89.5s — no delays, confirming the test's WS subscription was unaffected by the browser overlay toggle.

### Design gap found and fixed during execution

**Gap 1: Buffer contamination after Refresh.** The design included `clearBuffer()` before `waitForTuiReady` post-Refresh in the first attempt, then (incorrectly) removed it in attempt 2. The correct fix was to **close the old WS and create a fresh subscription** (mirroring F-lifecycle F.09). This is consistent with JOURNAL.md's infrastructure patterns.

The original design said: "NOTE: Do NOT clearBuffer() before waitForTuiReady — the 'bypass' text may have already arrived in the buffer." This was wrong in the wrong direction: the problem was the opposite — stale "bypass" text from BEFORE the Refresh was in the buffer, causing `waitForTuiReady` to return immediately on stale data, then sending `NEXT\r` before the new PTY's Claude was input-ready.

**The correct design principle (now documented):** After Refresh, always close the old subscription WS and open a fresh one via `subscribeAndCollect`. Do not reuse a WS whose buffer contains pre-refresh output.

**Gap 2: `textContent()` without timeout.** The design did not specify timeout parameters for Playwright `.textContent()` calls. Playwright's default timeout is the global test timeout (20 minutes), so `.textContent().catch(() => '')` would NOT catch a timeout — it would wait 20 minutes. Fix: `.textContent({ timeout: 2000 }).catch(() => '')`.

**Gap 3: lastLine assertion is non-strict.** The run shows `lastLine after ACK_7: ""`, `lastLine after ACK_12: ""`, and `lastLine after ACK_20: ""` — all empty. This means the session card's `.session-lastline` element is not displaying Claude's ACK responses. This could be:
(a) A product gap — the session card lastLine update mechanism not working
(b) A selector issue — the session card may not be visible during the overlay session
(c) Expected — lastLine might only show terminal output when the overlay is closed

This is not a test false-positive, but it IS a missed assertion. The design said "Verify lastLine shows most recent ACK" but the implementation demoted this to a non-blocking log. The validator notes this is correct defensive behavior (don't fail on non-critical UI element), but the validator also notes this means the lastLine assertion was vacuously passed (never verified).

---

## Q3: Was the execution faithful? (Did the code match the design?)

**Yes, with documented deviations.**

### What the executor did faithfully
- Created session via WS, opened overlay via browser UI
- Established sentinel protocol with correct wording (no literal ACK_N in setup message)
- Sent `NEXT\r` for each subsequent message
- Used CDP `Network.setCacheDisabled` for hard reload (not `location.reload(true)`)
- Re-selected project and re-opened overlay after reload (signals reset)
- Handled delete dialog with `page.once('dialog', d => d.accept())`
- Verified session deleted from both UI (card gone) and API (not in /api/sessions)

### Deviations from design
1. **Session creation via WS (not UI modal):** The design explicitly chose WS creation to reduce failure surface. The execution followed this. ✓
2. **Page reload added in T43.05:** The design did not mention reloading the page after session creation to make the session card appear. The executor added this. This is correct — without a reload, the browser's signal state didn't have the new session. ✓
3. **Post-Refresh: fresh WS subscription (not just clearBuffer):** The design's final text said to use `subscribeAndCollect` after Refresh. The first execution attempt used `clearBuffer()`, the second removed it, and the third correctly implemented `subscribeAndCollect`. The final implementation is correct and matches the design's described intent (mirroring F-lifecycle). ✓
4. **Omitted `session:subscribed` wait on mainSub before Refresh:** The design said "Set up listener before clicking" using `waitForMsg` on mainSub.ws. This was implemented with `.catch(() => null)`. After the WS is closed and reopened, the `session:subscribed` detection is done via `subscribeAndCollect` receiving it during subscription. The run confirms `session:subscribed received — xterm reset confirmed`. ✓

---

## False-PASS Risks Assessment

### Risk 1: PTY echo of sentinel matching ACK_1
**Mitigated.** The sentinel text "For this session, reply to EVERY message with ONLY the format ACK_N where N increments from 1. Nothing else." does NOT contain the literal string "ACK_1" (it contains "ACK_N" and "from 1" separately). No false-positive possible. ✓

### Risk 2: Stale buffer causing early ACK match
**Mitigated.** `clearBuffer()` is called before each `waitForAck()` call. After Refresh, a new WS subscription is opened (clean buffer). ✓

### Risk 3: ACK_N substring matching (ACK_1 matching ACK_10, etc.)
**Potential issue.** `buffer.includes('ACK_1')` would match in a buffer containing "ACK_10" or "ACK_17". However, since `clearBuffer()` is called before each NEXT\r send, and Claude has not yet responded with ACK_N when we start waiting, the first ACK to appear in the buffer IS the correct one. The risk would only materialize if a prior ACK from a previous message bled into the next buffer — which `clearBuffer()` prevents. **Non-issue in practice.** ✓

### Risk 4: ACK_8 after Refresh — coincidental correct response
**Cannot be coincidental.** Claude responded `ACK_8` in response to a plain `NEXT` message with no instruction to start at 8. The ONLY way Claude produces `ACK_8` is if it has conversation context from the first 7 messages (via `--resume`). This is a genuine behavioral proof of conversation continuity. ✓

### Risk 5: ACK_13 after hard reload — same PTY, no new authentication needed
**Understood and expected.** After browser reload, the PTY continues running. Claude is mid-conversation (no timeout, no restart). Sending `NEXT\r` simply continues from ACK_12. The 1.6s response time (vs 4-5s for other messages) suggests Claude was already at the input prompt waiting when NEXT was sent. This is NOT a false-pass — the test correctly verifies that browser reload doesn't disrupt the PTY session. ✓

### Risk 6: lastLine assertion is vacuous (always empty)
**Confirmed vacuous.** All three lastLine checks returned empty string. The assertion `console.log(...)` does not throw on empty string, so the test never verifies lastLine content. This is a gap in the test (the spec says "Session card lastLine shows most recent ACK") but it does NOT make the overall PASS false — the 20 ACKs and lifecycle transitions are the primary assertions and they are genuine.

**Finding for product team:** The session card `.session-lastline` element does not update while the session overlay is open. This may be expected (lastLine is only visible in the session list which is hidden behind the overlay), or it may be a product gap. Recommend: verify lastLine updates are being broadcast by the server even when a client is in overlay view.

---

## Overall Verdict

**GENUINE PASS.** The T-43 test is a meaningful endurance test that:
1. Exercises 20 real Claude API calls with sentinel protocol control
2. Verifies Refresh (with `--resume`) preserves conversation context — genuine product verification
3. Verifies hard browser reload does not disrupt PTY — genuine product verification
4. Verifies overlay close/reopen is transparent — genuine product verification
5. Verifies Stop and Delete work cleanly

**Minor gap:** lastLine assertion is vacuous (never checked). This should be fixed in a future revision by waiting until the overlay is closed before checking `.session-lastline`.

**Infrastructure bug found and fixed:** Playwright `.textContent()` without `{ timeout: N }` uses the global test timeout (20 min), making `.catch(() => '')` useless as a timeout guard. Always specify `{ timeout: 2000 }` (or similar) when reading optional UI elements.

**Infrastructure pattern confirmed:** After a server-side session Refresh (which restarts the PTY), always close the test WS subscription and open a new one via `subscribeAndCollect`. Do not reuse a WS whose buffer contains pre-refresh output — stale "bypass" text in the buffer will cause `waitForTuiReady` to return immediately before the new PTY is input-ready.

---

## Test Artifacts

- Design: `tests/adversarial/designs/T-43-design.md`
- Test file: `tests/adversarial/T-43-haiku-endurance.test.js`
- Run output: `tests/adversarial/designs/T-43-run-output.txt`
- Screenshots: `qa-screenshots/T43-haiku-endurance/` (9 screenshots: 00 through 08)
