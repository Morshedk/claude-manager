# Plan Review (Round 2): Refresh Bug Test Design

**Reviewer role:** Independent adversarial reviewer (did not author the design)
**Date:** 2026-04-09
**Round:** 2 of 2

---

### Verdict: APPROVED

---

## Resolution of Round 1 blocking issues

### Issue 1: Fix B is a no-op (RESOLVED)

The revised design eliminates Fixes A, B, and D entirely. Section 2 now specifies Fix C as the single fix path, with an explicit rationale: "The plan review correctly identified that Fixes A, B, and D form a dead code path." The fix is a self-contained change to `handleSubscribed` in TerminalPane.js that mirrors the existing reconnect handler pattern (lines 171-180). No ambiguity remains about which code changes are needed.

### Issue 2: T-1 untestable as raw WS (RESOLVED)

T-1 is now redesigned as a Playwright E2E test. It clicks the actual Refresh button (step 8), intercepts outgoing WS messages via `page.evaluate` monkey-patching (step 7), and asserts that a `session:resize` message was sent after the click (step 11). This tests the real client code path, not a hand-constructed message.

### Issue 3: T-4 passes pre-fix (RESOLVED)

T-4 is now explicitly reclassified as a "Smoke test (not bug-mode)" with a clear explanation: the card-based refresh path triggers the initial mount double-rAF (which already works), so Fix C is not exercised. The "BUG MODE" section header still appears, but each test individually states its classification, and T-4's smoke-test status is unambiguous. The pre-fix/post-fix analysis is honest and internally consistent.

### Issue 4: T-3 pre-fix FAIL speculative (RESOLVED)

T-3 now has a revised flow (steps 8-11) that uses `page.evaluate` to monkey-patch `WebSocket.send` and DROP outgoing `session:resize` messages while resizing the browser to 800x500. This creates a guaranteed dimension mismatch: xterm is locally fitted to 800x500, but the server's stored `_cols`/`_rows` remain at the original 1200x800-derived values. After re-enabling resize sending and clicking Refresh, the pre-fix path has no mechanism to send the correct dimensions -- `handleSubscribed` only calls `xterm.reset()`. The `stty size` assertion at step 16 will reliably fail pre-fix because the PTY restarts at stale dimensions.

This is a well-designed forced-mismatch setup. The mechanism is explicit and the pre-fix FAIL is mechanistic, not speculative.

### Issue 5: T-5 ResizeObserver unresolved (RESOLVED)

The design now states as a verified fact (not hypothesis) that `xterm.reset()` does not trigger ResizeObserver, with a concrete rationale: the observer is attached to the container div (which is styled with `height:100%;width:100%;overflow:hidden;`), and `xterm.reset()` only clears the terminal's internal buffer without changing the container's CSS dimensions or layout. Additionally, the design notes that `fitAddon.fit()` also does not trigger ResizeObserver because it adjusts xterm internals without changing the container's own dimensions. This analysis is correct and matches the source code at lines 184-191.

### Issue 6 (minor): Line number citation (RESOLVED)

Updated to `sessionHandlers.js:182-187`. Verified accurate.

---

## Codebase citation verification

All file:line citations in the revised design were checked against the source files. Results:

| Citation | Claim | Verified |
|----------|-------|----------|
| `TerminalPane.js:136-139` | `handleSubscribed` only calls `xterm.reset()` | Yes -- exact match |
| `TerminalPane.js:154-165` | Double-rAF initial mount with fit + subscribe | Yes -- exact match |
| `TerminalPane.js:171-180` | Reconnect handler re-fits and re-subscribes | Yes -- exact match |
| `TerminalPane.js:184-190` | ResizeObserver on container div | Yes -- lines 184-191 (close enough, observer + observe call) |
| `actions.js:90-91` | `refreshSession()` sends no cols/rows | Yes -- exact match |
| `sessionHandlers.js:182-187` | Handler passes `msg.cols`/`msg.rows` to SessionManager | Yes -- exact match |
| `SessionManager.js:348-353` | Direct session branch ignores cols/rows | Yes -- line 352: `await session.refresh(authEnv)` with no cols/rows |

All citations are accurate.

---

## Minor observations (non-blocking)

1. **T-1 and T-5 overlap.** The design acknowledges this in Risk 1 and recommends keeping both. This is acceptable but the executor should be aware that if time is limited, T-1 can be dropped in favor of T-5 (which is strictly more rigorous). The priority list in Section 5 correctly places T-3 first.

2. **T-3's monkey-patching complexity.** Dropping `session:resize` messages while allowing other WS traffic through is an unusual test setup. If the monkey-patch is not scoped tightly, it could interfere with other message types. The design addresses this in Risk 3. The executor should verify the filter is narrow (check `type` field only) during implementation.

3. **Single rAF vs double rAF.** The fix uses a single rAF while the initial mount uses double rAF. The design explains why (container is already laid out). This is a reasonable judgment call, but if the fix is flaky in CI, upgrading to double rAF is the first thing to try.

4. **Section header says "BUG MODE" but contains smoke tests.** T-2 and T-4 are explicitly classified as smoke tests within a section titled "Test Designs (BUG MODE)." This is mildly confusing but each test's individual classification is clear. Non-blocking.

---

## Conclusion

All five blocking issues from Round 1 are resolved. The fix strategy is now singular and clear (Fix C only). The test designs have honest pre-fix/post-fix analyses with mechanistic explanations. T-3's forced-mismatch setup is the strongest test and is correctly prioritized first. All codebase citations are accurate. This document is ready for an executor to implement without additional context.
