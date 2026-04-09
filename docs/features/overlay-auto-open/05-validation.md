# Validation: Overlay Auto-Open After Session Create

**Validator:** Stage 5 Agent  
**Date:** 2026-04-08

---

## T-1: Overlay opens automatically after Start Session — no card click

**1. Outcome valid?** GENUINE PASS

The precondition was explicitly checked: the test asserted `#session-overlay` was NOT in the DOM before the create action. After clicking "Start Session" (without clicking any session card), the test waited for `#session-overlay` to become visible and asserted `#overlay-title` contains "auto-open-test". These are the correct observations that confirm the feature works. The test cannot vacuously pass because:
- If the implementation were missing (no `attachSession` call), the overlay would never appear and `waitForSelector` would timeout.
- The pre-condition check prevents a false pass if an overlay was already open from a previous state.

**2. Design sound?** Yes. The test directly covers Acceptance Criteria #1 from the design. The fail signal (timeout) is exactly what happens on a pre-implementation codebase. The selector fix (CSS class instead of text=) is a legitimate infrastructure fix, not a weakening of assertions.

**3. Execution faithful?** Yes. The test matched the design exactly: select project, open modal, fill name, click Start Session, do NOT click card, assert overlay visible and title correct.

---

## T-2: Overlay shows correct session (not a different session's terminal)

**1. Outcome valid?** GENUINE PASS

The test creates two distinct sessions sequentially and verifies the overlay shows the correct one each time. The assertion `expect(title2).toContain('session-beta')` combined with `expect(title2).not.toContain('session-alpha')` is a strong correctness check. The pre-condition (overlay was closed between creates) prevents stale state. The REST assertion (`managed.length >= 2`) confirms both sessions truly exist on the server, ruling out a case where the second create silently failed and the test was vacuously checking an empty overlay state.

**2. Design sound?** Yes. This covers Acceptance Criteria #2 (overlay title matches the correct session) and Lifecycle Story 2 (switching between sessions). A broken implementation where `attachedSessionId` doesn't update would show "session-alpha" on the second overlay — the test would catch this.

**3. Execution faithful?** Yes. The implementation matched the design precisely.

---

## T-3: Browser reload does NOT re-open overlay automatically

**1. Outcome valid?** GENUINE PASS

The test first confirms auto-open worked (overlay visible after create — this is the precondition gate). Then it reloads and checks overlay is NOT visible. If `attachedSessionId` were persisted in localStorage (a potential false-implementation), the overlay would reopen after reload and this test would FAIL — which is the correct behavior. The "not in DOM" outcome means the Preact component is fully absent, not just hidden with CSS.

**2. Design sound?** Yes. This covers Acceptance Criteria #3 and Lifecycle Story 3 (reload does not reopen overlay). The design explicitly stated this behavior should NOT change — the signal starts as null on page load, and this test verifies it.

**3. Execution faithful?** Yes. `page.reload({ waitUntil: 'domcontentloaded' })` followed by `await sleep(3000)` is a reasonable wait. The WS reconnect happens automatically (3s is well within reconnect window) and sessions:list would reload but not set `attachedSessionId`.

---

## T-4: Adversarial — two rapid creates, last-created wins

**1. Outcome valid?** GENUINE PASS (with caveat)

The test was redesigned from Playwright UI to WS protocol level because the overlay auto-open feature itself blocks rapid UI double-create (overlay covers the button). This is **actually a good sign** — it means the feature works as designed.

The WS-level test is a genuine verification of the adversarial concern: it confirms:
1. Two distinct `session:created` messages arrive in order
2. The second message arrives last (correct ordering for "last wins")
3. Both sessions exist on the server

However, there is a **minor caveat**: the test does NOT assert in a browser context that `attachedSessionId` ends up pointing to the second session. It proves that at the WS/server level, the conditions for "last wins" are met (two messages in order), and relies on the implementation logic `handleSessionCreated` being called sequentially (which is guaranteed by the single-threaded JS event loop). This is a valid inference rather than a direct UI assertion.

The test is not VACUOUS because the pre-condition of both sessions existing is asserted, and the order of messages is verified.

**2. Design sound?** The redesign was necessary and sound. The original design's fail signal ("overlay shows rapid-first") cannot be tested via UI when the feature works correctly (overlay opens on first create, blocking button access). The WS approach directly tests the server-side behavior and the ordering guarantee that makes "last wins" work. The test design correctly identified that the concern is about WS message ordering, not UI timing.

**3. Execution faithful?** Reasonably faithful. The key concern (ordering of session:created messages) is tested. The assertion that `lastAttachedId = secondCreated.session.id` and "last wins" behavior is noted as the expected signal flow — this is a valid inference from the implementation that was reviewed.

---

## Overall Verdict

**FEATURE COMPLETE**

All 4 tests are GENUINE PASS. The implementation is a minimal 3-line change (`actions.js` lines 195-200) that correctly adds `attachSession(msg.session.id)` after `upsertSession(msg.session)` in `handleSessionCreated`. The review found it FAITHFUL to the design.

### Confidence Assessment

- **High confidence:** T-1 (direct browser test of the feature), T-2 (correct session identity), T-3 (reload isolation)
- **Good confidence with caveat:** T-4 (adversarial ordering via WS; browser-level "last wins" not directly asserted but correctly inferred)

### No False PASSes Found

- T-1's pre-condition gate prevents vacuous pass
- T-2's `not.toContain('session-alpha')` prevents stale-state false pass
- T-3's precondition (overlay must open first) prevents vacuous pass on reload
- T-4's ordering verification and server-side confirmation prevents vacuous pass

### Security / Edge Case Review

One known edge case from the design (malformed `session:created` with `msg.session.id === undefined`) remains untested. This is low severity (server always sends valid IDs) and was documented in both the design and review as out of scope. Not a gap in the feature's correctness.
