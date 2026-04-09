# T-05 Validation Report

**Test:** Refresh Direct Session Preserves Conversation via --resume
**Validator:** opus (claude-sonnet-4-6 acting as adversarial validator)
**Date:** 2026-04-08

---

## Q1: Was the outcome valid?

**Verdict: INCONCLUSIVE — test did not run; server startup failure**

The run output shows a single hard failure:

```
Error: Test server failed to start within 25s
```

The server never became responsive on port 3102 within the 25-second deadline. The test aborted in `beforeAll` before any sentinel protocol, session creation, browser interaction, or ACK exchange occurred. There is zero behavioral evidence either way — no ACK_1, no ACK_3, no conversation file check.

**Root cause of the server failure:** The test does `fuser -k 3102/tcp` before starting the server, then `await sleep(1000)`, then spawns `server-with-crash-log.mjs`. Manual verification (a test spawn during this validation) confirms the server DOES start and respond on 3102 when given sufficient time. The most likely cause of the 25s timeout failure is:

1. A prior test or process was holding port 3102 and `fuser -k` did not cleanly release it before the 1-second sleep expired.
2. A leftover `node` process from a previous run was still binding the port when the new server tried to listen, causing it to fail silently (no `EADDRINUSE` crash because `server-with-crash-log.mjs` traps uncaught exceptions but the error may have been emitted before the trap was active, or the server logged nothing to stdout before dying).

There is no crash log excerpt in the run output, and the server stdout (`[srv]`) shows nothing — consistent with the process dying before even writing the listening line.

**Bottom line on validity:** The run outcome is infrastructure failure, not a pass or fail of the --resume behavior. No behavioral conclusion can be drawn.

---

## Q2: Was the design sound?

**Verdict: YES — the design is rigorous and well-structured**

Strengths:

1. **Correct code path exercised.** The design correctly targets `DirectSession._buildArgs()` → `_claudeSessionFileExists()` → `--resume <claudeSessionId>`. The code review confirms this path exists exactly as described: if the `.jsonl` file is present, `--resume` is pushed; if not, `--session-id` is used. The design tests the right mechanism.

2. **Escalating ACK numbers eliminate false-positive risk.** Using ACK_1/2/3, ACK_10/11/12, ACK_20/21/22 across three iterations makes a coincidental `ACK_N` response from a fresh Claude session essentially impossible. A fresh Claude always starts at 1. This is a strong adversarial design choice.

3. **Sentinel prompt does not embed ACK literals.** The design explicitly warns about PTY echo and avoids putting `ACK_N` text in the prompt itself. The prompt says "increments from N" — the number N is in the prompt but `ACK_N` is not. This correctly sidesteps the echo-before-response false-positive trap.

4. **Stop before refresh ensures file flush.** Stopping the session before clicking Refresh forces Claude to write its conversation `.jsonl` to disk. The 2-second wait after STOPPED adds a sensible margin.

5. **Conversation file existence check before refresh.** The design requires asserting `fs.existsSync(convFilePath)` before clicking Refresh, so a missing file is caught as INCONCLUSIVE rather than silently producing a false FAIL.

6. **Fresh WS subscriber after refresh.** Closing `wsCreate` and opening a new subscriber avoids stale buffer artifacts from before the refresh contaminating the ACK_3 check.

7. **Real Refresh button click (UI path).** Using Playwright to find and click the Refresh button tests the full stack: UI handler → WS `session:refresh` message → `DirectSession.refresh()` → PTY respawn. This is the correct end-to-end test for Story 8.

Minor design gap: The design mentions checking server logs for `--resume` in the stdout capture (section 7b), but the server does not log the actual command-line arguments in the captured output stream. This secondary check would likely always be inconclusive. The design acknowledges this risk (Risk 6) and correctly makes ACK_3 the primary proof. Not a soundness problem.

**The design is sound for testing the actual `--resume` code path.**

---

## Q3: Was execution faithful to the design?

**Verdict: YES — the implementation closely follows the design**

The test file (`T-05-resume-on-refresh.test.js`) matches the design on every key point:

| Design requirement | Implementation |
|---|---|
| Isolated server on port 3102, temp DATA_DIR | Lines 64-99: `mktemp`, spawn with `DATA_DIR`/`PORT` env, 25s readiness poll |
| Seed `projects.json` before server start | Lines 68-77: written to `tmpDir/projects.json` with correct structure |
| Session create via WS, wait for `session:created` | Lines 282-302: correct message type and field extraction |
| Auto-subscribe: no duplicate `session:subscribe` | Lines 306-308: `attachAndCollect(wsCreate, testSessionId)` — no extra subscribe sent |
| Wait for TUI ready (`bypass` signal) | Lines 233-241: polls buffer for 'bypass' or length > 2000 |
| Sentinel prompt: no ACK literals in prompt text | Line 325: "...increments from ${startN}..." — no `ACK_N` string in the sent text |
| Wait for `ACK_1` (up to 45s) | Line 328: `collector.waitForAck(iter.start, 45000)` |
| 3-second pause before sending NEXT | Line 333: `await sleep(3000)` |
| Stop session, wait for STOPPED, 2s flush wait | Lines 344-351: `session:stop`, `waitForStatus('stopped', 15000)`, `sleep(2000)` |
| Conversation file existence check | Lines 355-378: `fs.existsSync(convFilePath)`, INCONCLUSIVE warning if missing |
| Browser Refresh button click via Playwright | Lines 382-461: multi-selector fallback, error on no button found |
| Wait for RUNNING after refresh | Lines 465-467: `waitForStatus('running', 30000)` |
| Fresh WS subscribe after refresh | Lines 472-475: `collector.close()`, `subscribeAndCollect(testSessionId)` |
| Wait for TUI ready after refresh | Line 476: `waitForTuiReady(collector, 30000)` |
| Send NEXT, expect `ACK_expected` (no new sentinel) | Lines 480-514: plain `"NEXT\r"`, `waitForAck(iter.expected, 45000)` |
| 3 iterations with escalating numbers | Lines 249-253: `[{1,2,3}, {10,11,12}, {20,21,22}]` |
| Between-iteration cleanup (delete session, remove file) | Lines 522-537: delete session via WS, `fs.unlinkSync` on conversation file |
| Pass requires all 3 iterations | Lines 557-561: `expect(passCount).toBe(iterations.length)` |
| Screenshots per iteration | Present throughout |

One implementation note: The `session:stop` command is sent via `collector.send('session:stop', {})` (line 344). The `send` helper prepends `id: sessionId` from the collector, so the message correctly includes the session ID. This matches the design's `{ "type": "session:stop", "id": "<testSessionId>" }`.

**No material deviations from the design were found.**

---

## Summary

| Dimension | Finding |
|---|---|
| Outcome validity | INCONCLUSIVE — infrastructure failure (port not released before server spawn) |
| Design soundness | SOUND — correctly targets `--resume` code path, escalating ACK numbers prevent false positives |
| Execution faithfulness | FAITHFUL — implementation matches design on all key requirements |

**Action required:** Re-run T-05 after ensuring port 3102 is fully clear. The recommended fix is to increase the sleep after `fuser -k` from 1000ms to 2000ms, or to explicitly wait for the port to be free (poll `fetch(BASE_URL)` expecting a connection-refused response before spawning the server). The test itself is well-built and should be trusted to produce a genuine signal on a clean run.
