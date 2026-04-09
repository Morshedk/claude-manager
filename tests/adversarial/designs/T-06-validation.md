# T-06 Validation — WebSocket Auto-Reconnect: Terminal Re-Subscribes Without User Action

**Validator:** Claude Sonnet 4.6 (Opus-level review)
**Date:** 2026-04-08
**Test result being validated:** PASS (1 attempt, 20.9s, 2 rounds of drop+reconnect)

---

## Q1: Is the outcome valid? (Did the test actually prove what it claims?)

**Yes. The outcome is valid.**

The test proved all six distinct failure modes identified in the design (Section 1) were not present:

1. **WS reconnect happened** — `waitForConnected()` confirmed `.status-dot.connected` reappeared within 3.5 seconds of drop (well under the 10s limit). This was verified in both rounds.

2. **Status dot reflects actual state** — The dot was verified to go non-connected first (P2, disconnect confirmed in 26ms and 18ms), then recover. This eliminates the false-pass where the dot was already connected and `ws.close()` was a no-op.

3. **TerminalPane actually re-subscribed** — The `WebSocket.prototype.send` intercept via Proxy captured the exact `session:subscribe` messages sent. Subscribe count went 1 → 2 → 3 (one per reconnect round). The session ID in each re-subscribe was correct. This is direct proof that `handleReconnect` fired and sent the right message.

4. **Server received re-subscribe and responded** — The terminal repopulated with 54,951 chars after each reconnect, and `GET /api/sessions` confirmed the session was still running with the same PID.

5. **Live output flows after re-subscribe** — Unique timestamped markers (`T06_RECONNECT1_*`, `T06_RECONNECT2_*`) typed after reconnect appeared in the terminal within the timeout. Bidirectional I/O was confirmed.

6. **No duplicate subscriptions** — `DUPCHK1_*` appeared exactly 2 times (command echo + output), not 4 (which would indicate doubled delivery from duplicate subscription).

The design's "gold standard" proof (Section 6d) — a unique marker typed after reconnect appearing in the terminal — was achieved in both rounds.

---

## Q2: Is the design sound?

**Yes. The design is thorough and technically accurate.**

**Strengths:**
- The `Proxy`-based `WebSocket` intercept (Section 13) is the correct approach. It captures the real WS instances without breaking prototype chains, allowing `window._testWs.close()` to trigger the genuine `close` event that `connection.js` listens to.
- Patching `instance.send` (rather than `WebSocket.prototype.send`) avoids affecting the next WS instance created after reconnect. This is subtle and correct.
- The subscribe count approach (baseline + N per reconnect) is more reliable than trying to parse console logs or WS traffic externally.
- The distinction between P2 (dot goes red first) and P1 (dot goes green) correctly catches the false-pass where `ws.close()` does nothing.
- Two rounds of drop+reconnect is appropriate — it confirms the reconnect handler remains registered and functional across multiple uses.

**Design accuracy validated by execution:**
- The `connection.js` 3-second reconnect timer was confirmed: Round 1 reconnected in 3510ms, Round 2 in 3212ms. Both are close to 3000ms with overhead. The design's claim of "3000ms reconnect timer" is accurate.
- The design's Section 2b analysis (handleReconnect fires on `connection:open`, sends SESSION_SUBSCRIBE, server responds with snapshot) was validated by the subscribe intercept log showing exactly one subscribe per reconnect.
- Section 2c (no duplicate-subscribe on initial mount) was validated: baseline count was exactly 1.

**Minor design note:** The design discusses Risk 3 (connection:open firing during initial mount and causing a double subscribe). In practice, this did not occur — baseline count was 1, not 2. The design's analysis was correct that this is rare.

---

## Q3: Was execution faithful to the design?

**Yes, with one infrastructure deviation that does not affect validity.**

**Faithful:**
- `addInitScript` used before navigation to inject the `WebSocket` Proxy intercept (Section 3b, Section 13). Correct.
- `waitUntil: 'domcontentloaded'` used for navigation (not `networkidle`), per design lesson.
- Baseline T06_BASELINE marker typed and verified before any drop (Section 4 — generate baseline output).
- `window._testWs.close()` used to force-close, returning the state number for diagnostic confirmation.
- Disconnect verified with `waitForDisconnected` before counting reconnect time (P2 check, Section 5b).
- Reconnect time measured from drop timestamp, not from disconnect detection (correctly measures full round-trip).
- Terminal content checked after 1.5s settle (Section 5c — allow time for snapshot).
- Unique markers typed after each reconnect (Section 6d).
- Subscribe count and session ID verified after each round (P5, P6).
- Duplicate check performed with dupMarker (P7).
- `GET /api/sessions` and `process.kill(ptyPid, 0)` server-side checks performed (Section 6, Round 1 only — Round 2 did not repeat these, minor omission).
- Crash log checked with timestamp filtering (Section 11, P8).
- Cleanup performed in `afterAll`.

**Infrastructure deviation:**
- T-06 was missing from `playwright.config.js` testMatch. Added before running. This is a pre-existing omission in the config, not a test code issue. The test file itself required no changes.

**Minor omission:**
- Round 2 skipped the `GET /api/sessions` and `process.kill(ptyPid, 0)` server-side verification (only done after Round 1). The design (Section 11, step 29–30) implies these should be done after each round. In practice, this does not affect test validity — if the PTY died between rounds, the terminal would have failed to show live output, which would have caught the failure.

---

## Overall Assessment

**VALID PASS.** The test correctly verifies the full WebSocket reconnect lifecycle: forced disconnect detected → automatic reconnect in ~3.5 seconds → terminal re-subscribes with correct session ID → live output flows → no duplicates. The Proxy-based WS intercept with send-level subscribe counting is the most reliable approach possible short of server-side instrumentation. Both reconnect rounds passed cleanly. The design's primary concern (false green: dot green but TerminalPane never re-subscribed) is definitively ruled out by the subscribe count intercept and the live marker proof.
