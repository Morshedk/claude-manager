# T-42 Validation: Multi-Project Badge Counts Are Fully Independent

**Validator role:** Adversarial reviewer — find why the PASS might be fake.  
**Date:** 2026-04-08

---

## Verdict Summary

**Did the test pass?** Yes — 3/3 tests pass.  
**Was the design correct?** Yes — strong design with false-PASS mitigations.  
**Was the execution faithful?** Yes — followed design closely.  
**Overall verdict:** GENUINE PASS — the test correctly validates badge independence with meaningful assertions.

---

## Analysis of Each Sub-Test

### T-42.01 — Initial badges

The test:
1. Creates 3 sessions in Project Alpha before the browser opens.
2. Navigates the browser and polls for `.project-item-badge` text.
3. **Critical assertion:** Project Alpha badge must contain "3 session" — not just "has sessions." If sessions didn't load (projectId missing, WS not delivering, etc.), this would FAIL not vacuously pass.
4. Project Beta must show "idle."

The design's key mitigation (assert Project A is non-zero before testing independence) was correctly implemented. The polling loop has an 8-second timeout. The first poll immediately returned "3 sessions running" — which confirms the server was delivering `sessions:list` via WS and Preact was rendering correctly.

**Verdict:** Genuine. The pre-condition (3 sessions showing) was verified before testing independence.

---

### T-42.02 — Stop one session; badges decrement

The test:
1. Connects a NEW WS to the running server.
2. Sends `session:stop` for session 1.
3. Waits for `sessions:list` broadcast to confirm session is stopped (WS-level confirmation, not just UI).
4. THEN polls the browser for the badge change.
5. Asserts Alpha → "2 sessions running", Beta → still "idle".

**Risk considered:** Could the WS confirmation arrive before the broadcast reaches the browser? No — the Playwright page and the WS test client both connect to the same server. The server broadcasts `sessions:list` to ALL clients on every state change. The test WS receives it first (since it's listening), then the browser receives the same broadcast and re-renders. The 300ms polling interval is adequate.

**Verdict:** Genuine. The decrement from 3→2 on Project Alpha and the unchanged "idle" on Project Beta are meaningful assertions.

---

### T-42.03 — API-level verification

Server-side confirmation: `GET /api/sessions` returns `{ managed: [...], detected: [...] }`. The test correctly accesses `sessionsBody.managed` (not the raw response). Zero sessions for Project Beta in server state.

**Verdict:** Genuine confirmation at the API level, not just UI level.

---

## Identified Weakness: T-42.02 Opens a Second Browser Page (Not First)

Each test opens a new `browser.newPage()`. T-42.02 navigates to the app again — which means it has its own WS connection lifecycle. The sidebar badges it sees are from a fresh WS connection that receives the initial `sessions:list` from the server.

**Is this a problem?** No. The server sends the current sessions list on WS connect. If one session is already stopped before T-42.02's browser page connects, the badge would already show 2. But the test first confirms the initial state (polling for "3 session"), THEN stops one, THEN polls for "2 session."

Wait — actually, in T-42.02, the page navigates BEFORE the stop is issued. So:
1. Browser connects → receives `sessions:list` with 3 running.
2. Test polls until "3 session" confirmed (or times out).
3. Stop issued via test WS.
4. Server broadcasts updated `sessions:list` to all clients including browser.
5. Browser re-renders.
6. Test polls for "2 session."

This is correct flow. No issue.

---

## Identified Weakness: No Simultaneous Stress Test

The test uses 3 sessions and then 2 — it doesn't test simultaneous creation/stopping across both projects. A truly adversarial test might create sessions in both projects simultaneously and check for race conditions in badge updates. However, this is beyond the test's stated scope and the underlying `getRunningCount()` filter is deterministic (no async reads), so races in the filter are not possible.

---

## Conclusion

T-42 is a **genuine, well-designed test** that:
- Establishes meaningful pre-conditions (verifies 3 running before testing independence).
- Tests the actual failure mode (cross-project contamination via shared counter).
- Validates at both UI level (Playwright badge text) and API level (server sessions list).
- Uses WS-level confirmation before checking UI, avoiding timing races.

The code under test (`getRunningCount()` in `ProjectSidebar.js`) correctly filters by `projectId`. The test confirms this behavior holds end-to-end.

**Score: GENUINE PASS**
