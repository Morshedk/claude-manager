# T-20 Validation — Two Browser Tabs Watching Same Session

**Validator role:** Adversarially review design + execution. Override false PASSes.

---

## Three Questions

### 1. Did the test pass?

**YES — GENUINE PASS.**

The run output shows all 7 pass criteria met with specific timing observations:
- `xterm.reset()` fired within 137-160ms of refresh (Tab2's PRE_REFRESH_MARKER disappeared)
- Cross-PTY bleed check: OLD_PTY_SENTINEL was absent from Tab2 immediately after reset (checked synchronously with `page2.evaluate`)
- Badge updated to "running" within 176-213ms
- POST_REFRESH_MARKER appeared in Tab2 within 240-256ms
- Tab1 also received POST_REFRESH_MARKER
- API confirmed running state

These are real, observable results with sub-second timings. No vacuous assertions.

### 2. Was the design correct?

**MOSTLY CORRECT — one significant design error found and self-corrected:**

**Design error:** Section 3c specified writing `T20_PRE_REFRESH_MARKER` in `beforeAll`, before any browser opens. This conflicts with the fundamental lesson from T-03 (documented in JOURNAL.md): "session:subscribed fires on initial subscribe, not just refresh. Any time a client subscribes to a session it receives session:subscribed → xterm.reset()." Content written before the browser connects gets wiped on first subscribe.

**Self-correction:** The executor recognized this pattern and moved the marker write to AFTER both tabs had opened overlays and settled (1.5s). This is the correct approach and is exactly what the JOURNAL.md T-03 lesson teaches.

**Design gap not mentioned:** The design didn't warn about the API sessions endpoint format (`{ managed, detected }` vs array). This is an infrastructure detail that the design should have specified from reading `lib/api/routes.js`.

**Core design strengths:**
- The three-tier sentinel protocol (PRE_REFRESH_MARKER → OLD_PTY_SENTINEL → POST_REFRESH_MARKER) correctly tests all three failure modes
- The `waitForFunction` DOM row scan approach for checking absence is correct
- Badge update check via `page2.waitForFunction` on `.session-card` text is appropriate
- The `_ptyGen` guard analysis in section 12c is architecturally correct

**FM-1 coverage:** The design flagged the old PTY data race. The OLD_PTY_SENTINEL was written immediately before refresh click, and remained absent after xterm.reset(). This confirms the `_ptyGen` guard is working correctly.

### 3. Was the execution faithful to the design?

**FAITHFUL with the necessary marker-timing deviation:**

The executor correctly identified the subscribe-before-content ordering problem. The fix (move PRE_REFRESH_MARKER write to after overlay open + 1.5s settle) is a **correct fix**, not a shortcut. It mirrors the T-03 fix documented in JOURNAL.md.

All 7 pass criteria from the design were checked in order:
1. `T20_PRE_REFRESH_MARKER` disappears from Tab2 DOM rows ✓
2. `T20_OLD_PTY_SENTINEL` absent via `page2.evaluate` ✓
3. Badge shows "running" via `waitForFunction` ✓
4. `T20_POST_REFRESH_MARKER` in Tab2 via `waitForFunction` ✓
5. `T20_POST_REFRESH_MARKER` in Tab1 via `waitForFunction` ✓
6. Cross-PTY bleed check after new output ✓
7. API state confirmed via fetch ✓

**One concern:** The OLD_PTY_SENTINEL check happens immediately after `xterm.reset()` fires. But the old PTY's `onData` handlers with stale generation may fire asynchronously *after* the check. The test checks at one point in time and the check passes — but there's a timing window. However, given the `_ptyGen` guard drops stale data before it reaches viewers (before any broadcast), this is a genuine protection, not just timing luck.

---

## Verdict

**GENUINE PASS** — All 7 criteria verified with real DOM and API assertions. The critical design flaw (marker-before-subscribe) was identified and fixed by the executor using documented best practices. The `_ptyGen` cross-PTY bleed guard is confirmed working.
