# T-01 Validation Report

## Q1: Outcome Validity
**GENUINE BUG**

Reasoning:

1. **Timing window met.** The test uses `page.evaluate()` with two synchronous `btn.click()` calls on lines 269-273 of the test file. Both clicks execute within the same JavaScript microtask, well under 200ms. This is actually stricter than the spec's "within 200ms" requirement -- both fire in the same event loop turn.

2. **Both clicks reached the server.** The WS interceptor (lines 158-169) monkeypatches `WebSocket.prototype.send` and logs `[T01-WS-SEND]` to the console. The console listener on line 151 increments `wsCreateCount`. All 5 iterations show `ws_sends=2`, confirming both `session:create` messages were dispatched. This rules out the "second click never fired" false-pass scenario identified in the design's Risk 1.

3. **Duplicate sessions are a real bug, not expected behavior.** I verified the server code:
   - `SessionManager.create()` at `/home/claude-runner/apps/claude-web-app-v2/lib/sessions/SessionManager.js:113` generates a fresh `uuidv4()` for every call (line 117). There is zero deduplication by name, projectId, or timing.
   - `sessionHandlers.js:82` (`create()`) calls `this.sessions.create()` without any guard.
   - The client-side `handleCreate()` at `NewSessionModal.js:73` calls `createSession()` then `closeNewSessionModal()` synchronously. But `closeNewSessionModal()` sets a Preact signal (`newSessionModalOpen.value = false`), and Preact re-renders asynchronously. The button remains in the DOM for the second synchronous click.
   - `createSession()` in `actions.js:66` is a bare `send()` with no debounce, no `submitting` guard, no idempotency token.

4. **Is this a realistic user action?** Yes. A physical double-click on a trackpad or mouse routinely produces two click events within 50-200ms. The test's `btn.click(); btn.click()` is actually a conservative simulation -- real double-clicks can be even faster. Some users habitually double-click buttons. This is not an exotic or synthetic attack vector.

5. **Both sessions ran successfully.** All iterations show both sessions with `state=stopped`, not `error`. The server happily created two real PTY processes for the same logical user intent.

## Q2: Design Quality
**SOUND**

Reasoning:

1. **Spec alignment.** The T-01 spec (LIFECYCLE_TESTS.md:567-574) says: "Click 'Start Session' twice as fast as possible (within 200ms). Wait 5 seconds. Count the session cards." The design implements exactly this, with the added rigor of API-side verification (not just DOM counting).

2. **Pass/fail criteria are meaningful.** The spec says "Exactly one session card with name 'test-double' exists. No duplicate." The design checks both API count and DOM count, which catches both server-side and UI-only bugs.

3. **The WS message counter is a critical addition.** The design correctly identifies (Risk 1 and Risk 2) that a PASS is only meaningful if both clicks actually reached the server. The `ws_sends` counter distinguishes three outcomes: INCONCLUSIVE (1 message), GENUINE PASS (2 messages, 1 session), GENUINE FAIL (2 messages, 2 sessions). This is well-designed.

4. **5 iterations is adequate given the result.** The design discusses this tradeoff. Since the bug reproduced 5/5 (100%), 5 iterations is more than sufficient. The 100% reproduction rate actually tells us this is not a race condition at all -- it is a deterministic missing-guard bug.

5. **Minor gap: no `disabled` attribute check.** Many modal implementations set `disabled` on the submit button after first click. The design does not explicitly check whether the button has a `disabled` attribute before the second click fires. However, I verified the source: `NewSessionModal.js` does NOT set `disabled` on the Start Session button (unlike `NewProjectModal.js` which has `disabled=${submitting}` on line 122). So this gap does not affect the result -- the button genuinely has no guard.

6. **False PASS risks are well-documented.** Risks 1-5 in the design are thorough and cover the main ways a test could falsely pass. The mitigations are sound.

## Q3: Execution Faithfulness
**FAITHFUL**

Reasoning:

1. **Double-click implementation matches design.** Lines 269-273 use `page.evaluate()` with synchronous `btn.click(); btn.click();` exactly as specified in section 3d of the design. This ensures both clicks fire before Preact can re-render.

2. **WS message counter implemented correctly.** Lines 158-169 inject a `WebSocket.prototype.send` interceptor via `page.addInitScript()` (runs before page JS loads). Lines 149-155 listen for `[T01-WS-SEND]` console messages. Line 286 reads the count. Line 268 resets it before each iteration. The counter distinguishes INCONCLUSIVE vs GENUINE outcomes on lines 356-359. All iterations reported `ws_sends=2`, confirming the race was exercised.

3. **5-iteration protocol implemented.** The loop on line 236 runs 5 times. Between iterations, sessions are deleted via WS (lines 372-376), with a 2-second wait and verification (lines 379-381). DOM cleanup is verified with `waitForFunction` (lines 384-391).

4. **Both API and DOM verification performed.** Lines 291-305 check API count; lines 317-319 check DOM card count. Both are used in the pass/fail determination on line 347.

5. **Screenshots taken at all specified points.** Lines 244, 264, 278, 284, and 366 capture screenshots matching the design's table in section 8. API responses saved on lines 296-299.

6. **No vacuous assertions found.** The key assertions are:
   - Line 347: `apiCount === 1 && domCardCount === 1 && !isGhostSpinner` -- this is a meaningful conjunction.
   - Line 416: `expect(failCount).toBeLessThanOrEqual(1)` -- this correctly fails the test if 2+ iterations produce duplicates.
   - Line 311: `expect(state).not.toBe('error')` -- this is less critical but still meaningful (ensures sessions were created, not error'd).

7. **One deviation documented honestly.** The design assumed a REST DELETE endpoint; the implementation uses WS-based deletion (lines 118-140). This is documented in the design's Execution Summary. The deviation does not affect test validity -- it is an infrastructure fix.

8. **Minor observation: the `newBtn` selector on line 247 differs from line 230.** Line 230 uses a specific `:has-text("New Claude Session")` selector for the pre-test check, but line 247 inside the loop uses `#sessions-area .area-header button').first()` which just grabs the first button. This is slightly less precise, but since there is only one button in the area header during the test, it works correctly. Not a validity issue.

## Overall Verdict
**CONFIRMED BUG**

The test found a genuine, deterministic, 100%-reproducible bug: the server has no deduplication on `session:create`, and the client has no debounce or `disabled` guard on the Start Session button. Two rapid clicks create two independent sessions with different UUIDs but identical names.

The WS message counter proves both clicks reached the server (not a test artifact). The server code confirms there is no dedup logic. The client code confirms there is no button guard. This is not a race condition -- it is a missing feature.

## Recommended next action

Fix the bug with defense in depth (both client and server):

1. **Client-side (immediate):** Add a `submitting` state guard to `handleCreate()` in `NewSessionModal.js`, similar to the pattern already used in `NewProjectModal.js` (which has `disabled=${submitting}`). Set `submitting=true` before calling `createSession()`, and `disabled=${submitting}` on the button.

2. **Server-side (belt-and-suspenders):** Add a short-lived deduplication window in `SessionManager.create()` or `sessionHandlers.create()`. For example, reject a `session:create` if a session with the same `(name, projectId)` was created within the last 2 seconds, or use a per-client debounce Map keyed on `clientId + name + projectId`.

3. **Re-run T-01 after the fix** to confirm 5/5 GENUINE PASS (ws_sends=2, apiCount=1).
