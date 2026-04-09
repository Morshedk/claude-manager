# T-46 Validation: WS Reconnect Restores Terminal Subscription

**Validator role:** Adversarial review of design + execution  
**Date:** 2026-04-08  
**Verdict:** GENUINE PASS

---

## Question 1: Did the test pass? (actual outcome)

**Yes — genuine pass.** The test ran in 18.7s and all assertions passed.

Key evidence from run output:
- Round 1: WS closed (`closed_from_state_1`), disconnect detected in 24ms, reconnect in 3471ms
- Round 1: Subscribe count went from 1 → 2 (exactly +1, correct)
- Round 1: `lastSubscribeId` matches session ID
- Round 1: Terminal had 54,951 chars after reconnect (not blank)
- Round 1: Live marker `T46_R1_1775678606957` appeared in terminal
- Round 1: Duplicate check marker appeared 2x (within <=3 threshold)
- Round 2: Subscribe count went 2 → 3 (exactly +1 again)
- Round 2: Live marker appeared
- No server crashes

---

## Question 2: Was the design correct? (meaningful assertions, real failure detection)

**Yes — the design is well-constructed.**

### Strengths

1. **Subscribe count is the gold standard assertion.** By injecting a `WebSocket.send` proxy before navigation, the test counts every `session:subscribe` message. This definitively proves `handleReconnect` fired — not just that the terminal shows text.

2. **`lastSubscribeId === sessionId` guards against wrong-session re-subscribe.** A naive reconnect that sends `session:subscribe` for the wrong session would produce output for the wrong session. This assertion catches that.

3. **Live marker after reconnect (not just pre-reconnect content).** The baseline marker `T46_BASELINE` was sent before the drop. The live markers (`T46_R1_*`, `T46_R2_*`) are typed AFTER reconnect, proving new keystrokes reach the PTY and responses come back through the subscription.

4. **Duplicate output check.** A broken reconnect that adds a second subscription without removing the first would double-deliver PTY output. Counting marker occurrences (expect <=3) detects this.

5. **Two rounds.** Confirming the mechanism works twice prevents "it works by coincidence on first reconnect" false passes.

6. **PID unchanged** assertion confirms the PTY process wasn't restarted during the test (that would be a different fix path that shouldn't have happened here).

### Minor design gaps (not blocking)

- The `window._testWs` proxy only captures instances created after `addInitScript` runs. Since the initial `connect()` in `main.js` runs after navigation, this correctly captures the first WS instance. However, if browser re-used a cached WS (not applicable here), the proxy would miss it. Low risk in practice.

- The design didn't test that `xterm.reset()` fires on reconnect (caused by `session:subscribed` → `handleSubscribed`). The test shows the terminal is NOT blank after reconnect (54,951 chars) which suggests `xterm.reset()` fired and then scrollback was replayed. This is implicitly tested but not explicitly asserted.

---

## Question 3: Was the execution faithful? (did the code match the design?)

**Yes — the implementation matches the design closely.**

The executor implemented all key design elements:
- WS proxy injected via `addInitScript` before navigation ✓
- Baseline subscribe count recorded before WS drop ✓
- Subscribe count asserted as `baseline + 1` after round 1, `baseline + 2` after round 2 ✓
- `lastSubscribeId === sessionId` asserted ✓
- Live marker typed after reconnect (unique timestamp suffix) ✓
- Duplicate check via regex count ✓
- PID check via API ✓
- Two rounds ✓
- Crash log check ✓

One minor deviation: the design specified `window._wsInstances` array tracking but the implementation only tracks `window._testWs` (latest instance). This is sufficient for the subscribe count — the `send` proxy is applied per-instance regardless.

---

## Conclusion

**T-46: GENUINE PASS**

The test proves that `TerminalPane.js`'s `handleReconnect` handler fires on `connection:open` and correctly sends `session:subscribe` for the active session. The feature works as designed. The test is a real detector — a failure in `TerminalPane.js` (removing the `on('connection:open', handleReconnect)` line, for example) would cause `subscribeCount` to remain at `baselineSubCount` and the live marker to fail to appear (since the server would no longer route PTY output to this client).
