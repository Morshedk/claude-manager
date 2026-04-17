# Validation: Delete Toggle + Session Lifecycle Logging

**Validator:** TEST VALIDATOR (adversarial)
**Date:** 2026-04-15
**Method:** Re-ran every test from a clean shell against the current codebase, audited each test's assertions against the design's acceptance criteria, and audited each test against the false-PASS risks the design's own Section 5 enumerated.

---

## Per-test outcomes

### T-1 — Delete mode toggle gates Delete button rendering and persists across reload
- **Outcome valid?** **GENUINE PASS.** Re-ran end-to-end against `tests/adversarial/feat-delete-toggle-T1-mode-toggle.test.js`: 1 passed (18.7 s). DOM count drops to 0 when disarmed; localStorage flips between `'1'` and `'0'`; class flips between `btn-danger` and `btn-ghost`; state survives both reloads.
- **Design sound?** **YES.** Targets ACs 1, 2, 4, 6 plus Risks 1 and 2. Crucially, it queries `.session-card button:has-text("Delete")` count — not visibility — so a CSS-hide regression (Risk 2) would still register the hidden button and fail the count, defending the conditional-render contract.
- **Execution faithful?** **YES.** Beforehand it actually creates and stops two real sessions through the WebSocket flow (not seeded JSON), so the cards under test are real session cards. Click handlers, localStorage writes, and Preact re-renders are all driven via real browser. No assertion was watered down.

### T-2 — Lifecycle log created with all required fields on session create (telegram ON)
- **Outcome valid?** **GENUINE PASS.** Re-ran via Jest: 1 passed (1.24 s). The on-disk entry contains all 9 fields with `summary='lifecycle-test'`, `channelId='tg-chat-test-42'` (string), `projectId='proj-t2'`, `tmuxName=null`, `claudeSessionId` populated.
- **Design sound?** **MOSTLY.** Targets AC 7, AC 9 and Risk 4 (telegram-on path). Type guard `typeof entry.channelId === 'string'` blocks Promise leaks. **However, the design Section 5 Risk 4 explicitly demands two cases — telegram ON and telegram OFF, "two cases, two assertions." T-2 only covers ON; see global gap below.**
- **Execution faithful?** **YES.** Real server, real WS, real on-disk file read. The `pollFile` helper has a real timeout, and the `expect(...).not.toBeNull()` would catch a missing file.

### T-3 — Delete flow produces a 'deleted' entry with meta captured BEFORE delete
- **Outcome valid?** **GENUINE PASS for the fallback path; VACUOUS for the cardSummary path.** Re-ran: 1 passed (1.44 s). It correctly proves Risk 5 (meta read before delete) by asserting `deletedEntry.claudeSessionId === createdEntry.claudeSessionId` with both being non-null UUIDs (`1a108ce1-…` in this run). It correctly proves the `name` fallback by asserting `summary === 'to-delete'` and `length > 0`.
- **Design sound? — partially flawed.** The test design's own description says "exercise the cardSummary path explicitly" then deliberately downgrades to "Simpler choice: skip cardSummary injection and assert fallback to name, so the test is deterministic." This decision means **the design's primary `cardSummary || name || ''` precedence is never exercised by ANY test**. The implementation could be reversed to `session.name || session.cardSummary || ''` (or to `session.cardSummary || ''` without the name fallback) and T-3 would still pass — its deterministic input has only `name` populated, no `cardSummary`. See gap H1 below.
- **Execution faithful?** **YES** to what the design code actually says. The test does what the test design's prose said it would (fallback only).

### T-4 — Double-delete in rapid succession — idempotent delete + single log entry
- **Outcome valid?** **GENUINE PASS.** Re-ran: 1 passed (5.07 s). Final log has exactly 2 entries. Server stays alive. No `session:error`. **The test caught a real implementation bug on first attempt** (3 log entries instead of 2) — the executor responded by adding the `_inProgressDeletes` Set in `sessionHandlers.js`. That fix is in place in the current source and the test now passes against it.
- **Design sound?** **YES** — burst-send of two `session:delete` messages on the same WS within the same `ws.send` synchronous block is the only way to expose the async meta-capture race the review missed (review claimed "first delete removes meta from Map before log-write begins" — wrong, because Map.delete is inside an async method called via await).
- **Execution faithful?** **YES.** No `await` between sends. Real WS. Reads the on-disk file.
- **Side-finding (not the test's target):** The server log emits `[SessionStore] sessions.json corrupted — starting empty: Unexpected end of JSON input` during the burst. This indicates concurrent `SessionStore.remove` writes are racing on `data/sessions.json` — load+save is non-atomic. The lifecycle log is unaffected, but a separate latent bug exists in `SessionStore`. **Not within the scope of this feature**, but worth flagging. T-4 doesn't assert sessions.json integrity, so the issue doesn't affect the verdict for the feature under test.

### T-5 — Log-write failure does NOT break the delete (AC10)
- **Outcome valid?** **GENUINE PASS.** Re-ran: 1 passed (1.63 s). After `session-lifecycle.json` is replaced by a directory of the same name, the delete still broadcasts as successful in `sessions:list`, no `session:error` is sent, server stays alive (HTTP 200). Both write paths (tmp+rename, then direct fallback) are now exercised — both fail with `EISDIR`/`ENOTDIR`, both swallowed by the inner try/catch, then the outer chain `.catch(() => {})` swallows anything escaping `_doLifecycleAppend`.
- **Design sound?** **YES.** EISDIR via directory replacement is a clean, reproducible fault injection that doesn't depend on permission semantics. The G1/G2 fix (`emit('error')` → `console.error`) was a precondition; without it, the missing error listener would have killed the test harness on first failure.
- **Execution faithful?** **YES.** Real fault, real WS, real disk.

### T-6 — 500-entry cap enforced
- **Outcome valid?** **GENUINE PASS.** Re-ran: 1 passed (1.51 s). After 520 sequential `logSessionLifecycle` calls (drained via `await watchdog._lifecycleWriteChain`), array length is exactly 500, `log[0].sessionId === 'session-21'` (events 1-20 evicted), `log[499].sessionId === 'session-520'`, JSON parses cleanly.
- **Design sound?** **YES** for cap enforcement (Risk 7) and for chain integrity under sequential load. **Caveat:** the calls are sequential in a `for` loop, not actually concurrent; this only partially exercises Risk 10 (concurrent-write race). The coverage matrix is honest about this ("Risk 10 — partially").
- **Execution faithful?** **YES.** Direct import of `WatchdogManager`, no mocking, real on-disk file read and parse.

### T-7 — Armed outline + toast + no confirm dialog (Story 2)
- **Outcome valid?** **GENUINE PASS.** Re-ran: 1 passed (10.6 s). Inline outline `rgba(240, 72, 72, 0.35) solid 2px` is present; toggle has both `btn-danger` class and `background: var(--danger-bg)`; toast text contains `"Deleted"` and `"beta"`; beta card is removed from DOM; lifecycle log has the deleted entry; **no native dialog fires** (Playwright `page.on('dialog', …)` sentinel never trips on the alpha delete click).
- **Design sound?** **MOSTLY.** AC 11 (toast) and Risk 8 (armed visual distinctness) are covered. The "no native confirm()" check (sentinel + click + assert sentinel false) is the strongest possible test for the `confirm()` removal — it would fail loudly if the regression returned. **Adversarial weakness:** the toast assertion uses `bodyText.includes('Deleted') && bodyText.includes('beta')`. After clicking Delete on beta, the beta card is gone, but if some unrelated future UI element ever rendered the literal string "Deleted" + "beta" without a real toast firing, this would still pass. Today nothing else does, so practically it's fine. The fix on attempt 2 (rgba space normalization) is a legitimate browser-rendering normalization, not assertion weakening.
- **Execution faithful?** **YES.** Real browser, real server, real WS-created sessions, real on-disk file.

---

## Cross-cutting gaps the test suite leaves open (false-PASS risks)

### H1 — `cardSummary` precedence path is untested
The design Section 2 Part B specifies `summary = session.cardSummary || session.name || ''` and Section 5 Risk 9 explicitly enumerates `cardSummary` evolution as a concern. **No test exercises a session whose `cardSummary` is populated**. T-2 and T-3 both assert the `name` fallback only. T-6 sets `cardSummary: null` deliberately. A reversed implementation (`session.name || session.cardSummary || ''`) would silently pass every existing test. The design test plan acknowledged this and chose "simpler choice: skip cardSummary injection" — that downgrade leaves a real false-PASS hole.

### H2 — `telegram=false → channelId === null` is asserted nowhere
The design Section 5 Risk 4 mitigation says "**two cases, two assertions**." T-2 covers `telegram=true → channelId='tg-chat-test-42'`. T-4 uses `telegram: false` but **never asserts `channelId`** (greppable: `grep channelId tests/.../T4*.test.js` returns zero hits). The on-disk file shows `"channelId": null` correctly, but no `expect(...).toBe(null)` exists. A bug that hard-coded `channelId = 'tg-chat-test-42'` for all sessions would still pass T-4. The coverage matrix claims T-4 covers Risk 4 (telegram off → null) — that claim is false.

### H3 — Promise-leak guard exists for telegram=true but not for telegram=false branch
T-2's `expect(typeof entry.channelId).toBe('string')` defends against a Promise leaking. The telegram-false path returns the literal `null`; if a future bug returned `Promise.resolve(null)` instead, no test would catch it. Low severity (no production trigger today).

### H4 — G3 (store.remove failure mid-delete) is not covered
The test designs document explicitly admitted this gap. A `data/sessions.json` write failure during delete would `return` from the handler before step 3 (lifecycle log). No partial-success coverage exists. Not a feature-blocker; documented limitation.

### H5 — T-4 surfaced a SessionStore corruption bug not covered by any feature test
During T-4's burst, server stderr emitted `[SessionStore] sessions.json corrupted`. This is a separate bug in `SessionStore.remove` (non-atomic load+save under concurrent calls). It is **outside this feature's scope**, but it is reproducible and visible only because this feature now invites burst-delete behavior. The lifecycle log is unaffected; the underlying session JSON is potentially corrupted.

### H6 — Pre-flight fixes were applied to source code, not tests
The executor edited two source files (`WatchdogManager.js` emit→console.error and `sessionHandlers.js` `_inProgressDeletes`) **before running the tests**. These are real and necessary fixes. The implementer's own claim of "Deviations from the design: None" (in `02-implementation-notes.md`) was therefore inaccurate — the implementation as delivered would have crashed T-5's harness and produced 3 log entries on T-4. The current state of the codebase passes all 7 tests, so the feature is shippable, but the audit trail in `02-implementation-notes.md` is misleading.

---

## Verdict mapping (executor's claim vs. validation)

| Test | Executor verdict | Validator verdict | Notes |
|------|------------------|-------------------|-------|
| T-1 | PASS | **GENUINE PASS** | Robust, no false-PASS |
| T-2 | PASS | **GENUINE PASS** (for the telegram=true case) | Misses telegram=false (H2) |
| T-3 | PASS | **GENUINE PASS for fallback / VACUOUS for cardSummary precedence** (H1) | Doesn't exercise the design's primary branch |
| T-4 | PASS (after fix) | **GENUINE PASS** | Test caught a real bug; fix verified |
| T-5 | PASS | **GENUINE PASS** | Real fault injection, real swallow |
| T-6 | PASS | **GENUINE PASS** | Sequential only, not concurrent (acknowledged) |
| T-7 | PASS (after rgba fix) | **GENUINE PASS** | rgba space fix is legitimate normalization |

---

## Overall verdict

**FEATURE PARTIAL.**

What works:
- Delete-mode toggle gates the Delete button via conditional render (not CSS hide). State persists across reloads. Armed outline + danger styling are visually distinct. T-1 and T-7 prove this end-to-end.
- The `confirm()` dialog is genuinely removed; T-7's dialog sentinel proves no native confirm fires.
- Toast appears on delete with the session name (AC 11).
- Lifecycle log writes a `created` entry with all 9 fields when a session is created (T-2).
- Lifecycle log writes a `deleted` entry with meta captured **before** delete (T-3 proves Risk 5 mitigation works).
- 500-entry cap is enforced (T-6).
- Log I/O failure does not break the delete (T-5 with EISDIR fault).
- Double-delete is idempotent and produces only one `deleted` log entry (T-4 — but only after the executor added `_inProgressDeletes`).

What is unverified or weakly verified — admits false-PASS risk:
- **H1 (cardSummary precedence — untested):** The design's stated `cardSummary || name || ''` precedence has no test coverage. A reversed implementation would silently pass the entire suite. This is the most significant gap because it directly invalidates the design's Risk 9 mitigation ("recovery tooling benefits most from matching on what the user visually recognised").
- **H2 (telegram=false → null — unasserted):** Risk 4 explicitly demanded both cases be asserted; only one is. Greppable proof: zero `channelId` assertions in T-4.
- **H4 (store.remove failure — uncovered):** Acknowledged by test designs; a real partial-success path exists in code with no test.

What is broken outside this feature but exposed by it:
- **H5:** `SessionStore.remove` corrupts `data/sessions.json` under concurrent delete (caught in T-4 server logs but not asserted). Latent bug, predates this feature, but the feature's burst-delete affordance makes it more reachable.

**Recommendation:** Before promoting to beta, add two small tests:
1. A unit test that calls `WatchdogManager.logSessionLifecycle({ event: 'created', session: { ..., cardSummary: 'AI X', name: 'user Y' }, channelId: null })` and asserts `log[last].summary === 'AI X'`. Closes H1 in ~10 lines.
2. An assertion in T-4 (or new T-8): `expect(logFinal[1].channelId).toBeNull()`. Closes H2 in 1 line.

Both are cheap and would lift the verdict from PARTIAL to COMPLETE.
