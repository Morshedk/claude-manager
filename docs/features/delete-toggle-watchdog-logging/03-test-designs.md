# Test Designs: Delete Toggle + Session Lifecycle Logging

Six adversarial tests covering every lifecycle story and every implementation gap identified in `03-review.md`. Each test runs against a real isolated server with a dedicated DATA_DIR and port. No mocking of `SessionManager`, `WatchdogManager`, or `SettingsStore`.

**Common setup contract for every test**:
- Spawn `node server.js` with `PORT=<N>` and `DATA_DIR=<fresh tmp dir>`. Wait for HTTP 200 on `/`. Kill cleanly in `afterAll`.
- Seed a project via `POST /api/projects` (or by writing `data/projects.json`) before driving session CRUD.
- Assertions about the lifecycle log read `<DATA_DIR>/session-lifecycle.json` directly (not through a client API — none exists).
- All tests must FAIL on the pre-implementation codebase: on v2 before this feature, the delete confirm() dialog would block step progression, no lifecycle file would exist, and the Delete button would always be visible regardless of toggle state.

---

### T-1: Delete mode toggle gates Delete button rendering and persists across reload
**Flow:**
1. Start server on port 3360 with fresh DATA_DIR.
2. Seed a project and create two stopped sessions (via REST: POST `/api/sessions` then POST `/api/sessions/{id}/stop`, or via the WS create flow followed by a stop).
3. Open Playwright browser at `http://127.0.0.1:3360`, select the project.
4. Assert: no button with accessible text "Delete" exists on any `.session-card` element — DOM query `page.locator('.session-card button:has-text("Delete")').count() === 0`.
5. Click the "Delete mode" toggle in the area header.
6. Assert: the toggle now has class `btn-danger` (not `btn-ghost`), AND every non-running session card now has a visible "Delete" button.
7. Reload the page (`page.reload()`).
8. After reload, assert: the toggle is still armed (`btn-danger`), Delete buttons still render on cards.
9. Click the toggle again.
10. Assert: Delete buttons vanish from the DOM (count === 0), toggle class returns to `btn-ghost`.
11. Reload once more.
12. Assert: toggle remains disarmed.

**Pass condition:** DOM queries match at every step; localStorage key `claude-delete-mode` contains `'1'` after step 6, `'0'` after step 10.

**Fail signal:** Delete buttons visible on fresh load (regression to pre-feature state); toggle state lost on reload (localStorage read broken); CSS-hiding trick lets button exist in DOM with `display:none` (Risk 2 from design).

**Test type:** Playwright browser

**Port:** 3360

---

### T-2: Lifecycle log created with all required fields on session create (telegram ON path)
**Flow:**
1. Start server on port 3361. Fresh DATA_DIR.
2. Pre-seed `<DATA_DIR>/settings.json` with `{ "telegramChatId": "tg-chat-test-42" }`.
3. Seed a project.
4. Open WS connection to `ws://127.0.0.1:3361/ws`; send `{ type: 'session:create', projectId, name: 'lifecycle-test', telegram: true, mode: 'direct' }`. Wait for `session:created` reply.
5. Wait up to 2 s for the `_lifecycleWriteChain` to settle (poll the file).
6. Read `<DATA_DIR>/session-lifecycle.json`. Assert:
   - File exists (AC9).
   - Contains exactly one entry.
   - Entry `.event === 'created'`, `.sessionId` equals the new session id, `.summary === 'lifecycle-test'` (cardSummary empty so falls through to name — G4), `.channelId === 'tg-chat-test-42'` (Risk 4 defense), `.projectId` equals the seeded project id, `.projectName` matches, `.tmuxName === null` (direct mode), `.claudeSessionId` is a non-empty string.

**Pass condition:** All eight field assertions match.

**Fail signal:** File missing (log call never ran); `channelId: null` when telegram is true (missing `await` on `settingsStore.get`); `channelId` serialised as `"[object Promise]"` or `{}` (Promise leaked into JSON, Risk 4); `summary === null` or `undefined` (design requires empty string).

**Test type:** WS + filesystem (server-level)

**Port:** 3361

---

### T-3: Delete flow produces a `deleted` entry with meta captured BEFORE delete (Risk 5 / G4)
**Flow:**
1. Start server on port 3362. Fresh DATA_DIR.
2. Pre-seed settings with `telegramChatId: "tg-chat-del-99"`.
3. Seed project. Create a session with `name: 'to-delete'`, `telegram: true`, `mode: 'direct'`. Wait for `session:created`.
4. Poll the log file; wait for the `created` entry to appear.
5. Force-populate cardSummary on the in-memory meta by poking the session through the watchdog — OR simply accept the fallback. To exercise the cardSummary path explicitly: set `session.cardSummary = 'AI summary X'` via the watchdog's summary event (fire a dummy `summary` event on `WatchdogManager`). Alternative: monkey-patch the session's meta before delete by updating via `session:update` to change name, then verify the right string wins in the log. Simpler choice: **skip cardSummary injection** and assert fallback to name, so the test is deterministic.
6. Send `{ type: 'session:delete', id: sessionId }` via WS.
7. Wait for `sessions:list` broadcast to reflect the session's absence.
8. Wait up to 2 s; re-read log file.
9. Assert:
   - Log contains exactly two entries: `created` then `deleted` for the same sessionId.
   - The `deleted` entry's `.claudeSessionId` equals the `created` entry's `.claudeSessionId` (identity preserved — proves meta was captured before deletion, not nulled out).
   - The `deleted` entry's `.summary` is a non-empty string equal to `'to-delete'` (the session name fallback).
   - The `deleted` entry's `.channelId === 'tg-chat-del-99'`.

**Pass condition:** Two entries, matching claudeSessionId, non-null identity fields on the deleted entry.

**Fail signal:** `deleted` entry with `.claudeSessionId === null` or `.tmuxName === null` AND `.summary === ''` simultaneously — indicates meta was read AFTER the delete (Risk 5). No entry written at all — log call failed silently (Risk 3).

**Test type:** WS + filesystem (server-level)

**Port:** 3362

---

### T-4: Double-delete in rapid succession — idempotent delete + single log entry (AC12, Risk 4)
**Flow:**
1. Start server on port 3363. Fresh DATA_DIR.
2. Seed project. Create a session `name: 'double-del'`, `mode: 'direct'`, `telegram: false`.
3. Wait for `session:created` and for `created` log entry to appear on disk.
4. Send TWO `session:delete` messages **for the same sessionId** in immediate succession (no await between sends). Use a single WS `send()` call burst.
5. Wait up to 3 s.
6. Assert:
   - The server does NOT crash (WS connection stays open; subsequent `sessions:list` request succeeds).
   - The log file contains exactly TWO entries total: one `created`, one `deleted`. NOT three (no double-log).
   - No `session:error` reply was received for either delete (unless filesystem store failed, which this test does not simulate).

**Pass condition:** 2 entries total in log; server alive; zero `session:error` replies.

**Fail signal:** Three log entries (two `deleted` for the same id — would indicate step 3's `if (meta)` guard is wrong). Server crash (would indicate an unhandled rejection in the chain). Unhandled `session:error` back to client.

**Test type:** WS + filesystem (server-level)

**Port:** 3363

---

### T-5: Log-write failure does NOT break the delete (AC10, G2)
**Flow:**
1. Start server on port 3364. Fresh DATA_DIR.
2. Seed project. Create a session `name: 'log-fail-sess'`.
3. Wait for `created` log entry on disk.
4. Force log-write failure: `chmod 0555 <DATA_DIR>` (read-only) OR `chmod 0000 <DATA_DIR>/session-lifecycle.json` so writes fail. Alternative on systems where chmod is unreliable: replace the file with a directory of the same name (`rm -f <file> && mkdir <file>`) — `fs.writeFileSync` will throw `EISDIR`.
5. Send `session:delete` via WS.
6. Wait for `sessions:list` broadcast.
7. Assert:
   - The session is gone from `sessions:list` broadcast (delete succeeded client-visibly).
   - No `session:error` reply (unless `store.remove` throws; this test does not trigger that path).
   - Server process is alive (hit `GET /` and expect 200).
8. Restore permissions in afterAll.

**Pass condition:** Delete broadcasts as successful; server remains responsive.

**Fail signal:** Server crash (emit('error') with no listener in a future refactor); `session:error` reply propagating the log I/O failure to the user (violates AC10); WS connection closed.

**Test type:** WS + filesystem (server-level)

**Port:** 3364

---

### T-6: 500-entry cap enforced (Risk 7)
**Flow:**
1. Start server on port 3365. Fresh DATA_DIR.
2. Seed project.
3. In a loop, create 260 sessions and delete each one immediately (total: 520 lifecycle events). Between each create and delete, wait for `session:created` reply. Use direct mode and minimal name to keep each cycle fast. **Skip real Claude spawn** by setting `command: '/bin/true'` so the PTY exits immediately — but note: direct mode uses `claude` binary; if that's not available in test env, use `command: '/bin/sh -c "sleep 10"'` and kill via stop before delete. Simpler: use `mode: 'direct'` with a mocked command environment; or skip to using the `WatchdogManager.logSessionLifecycle()` method directly via a tiny Node script that imports WatchdogManager and calls it 520 times.
4. After the loop, wait up to 5 s for the write chain to drain (`await watchdog._lifecycleWriteChain`).
5. Read `<DATA_DIR>/session-lifecycle.json`.
6. Assert:
   - Array length is exactly 500.
   - The first entry in the array corresponds to the 21st event (events 1–20 dropped).
   - The last entry corresponds to event 520.
   - JSON parses without error.

**Pass condition:** `length === 500`, oldest 20 events correctly evicted.

**Fail signal:** Length > 500 (cap not enforced — log grows unbounded, Risk 7); length < 500 with events lost mid-stream (serialisation chain broken, Risk 10); JSON parse failure (concurrent-write race corrupted the file).

**Test type:** Direct Node import of `WatchdogManager` (isolated from HTTP/WS stack to exercise the cap deterministically) — launches no server, uses a fresh DATA_DIR.

**Port:** 3365 (reserved; no server actually binds it, but the test harness reserves the port for consistency)

---

### T-7: Armed outline visually distinct + toast confirms delete (AC11, Risk 8) — Story 2 end-to-end
**Flow:**
1. Start server on port 3366. Fresh DATA_DIR.
2. Seed project. Create three stopped sessions: "alpha", "beta", "gamma" (all direct mode, telegram off). Wait for all three to appear in `sessions:list`.
3. Open Playwright browser. Navigate to the project.
4. Assert: delete buttons absent on all three cards.
5. Click the "Delete mode" toggle.
6. Assert:
   - The `#project-sessions-list` container has an inline `outline:` style containing `rgba(240,72,72,0.35)` (armed outline present — Risk 8 defense).
   - The toggle button's inline style contains `background:var(--danger-bg)` or the computed background colour differs from the disarmed state (visual distinctness).
7. Click Delete on "beta".
8. Assert within 1 s:
   - A toast with text containing `"Deleted"` AND `"beta"` appears in the `.toast-container` or equivalent (AC11).
   - The card for "beta" is no longer in the DOM.
   - `sessions:list` broadcast (or `/api/sessions`) no longer contains a session named "beta".
9. Wait for the `deleted` log entry on disk:
   - `.event === 'deleted'`, `.summary === 'beta'`, `.sessionId` matches the previously known id.
10. Click Delete on "alpha" — no confirm dialog appears (Playwright would hang on a native dialog; use `page.on('dialog', d => d.dismiss())` as a sentinel, and assert the handler was NEVER called).

**Pass condition:** Armed outline visible; toast appears with correct name; log entry persisted; no native confirm dialog fires.

**Fail signal:** No outline (Risk 8 mitigation missing); no toast (AC11 violated); native `confirm()` dialog intercepted (regression — confirm not removed); card removed from DOM but log entry missing (silent log failure, Risk 3).

**Test type:** Playwright browser + filesystem

**Port:** 3366

---

## Coverage matrix

| Lifecycle story (Section 4 of design) | Covered by |
|---|---|
| Story 1: Safe browsing, toggle off | T-1 (steps 3–4) |
| Story 2: Intentional cleanup | T-7 (full end-to-end) |
| Story 3: Accidental click saved by toggle | T-1 (step 4 — button absent) |
| Story 4: Recovering deleted session | T-3 (proves identity fields are preserved for recovery) |
| Story 5: Audit trail over time | T-6 (cap + ordering) |

| Implementation gap from review | Covered by |
|---|---|
| G1/G2 — emit('error') crash / log-failure user impact | T-5 |
| G3 — store.remove failure partial-success | (Not covered; would require fs fault injection on `data/sessions.json`. Documented as known limitation; adding T-8 for this would require file-locking primitives beyond the current test harness scope.) |
| G4 — cardSummary vs name fallback | T-2 (name fallback), T-3 (explicit assertion on `.summary === 'to-delete'`) |
| G5 — forward-looking session.channelId | Not tested (unreachable from production flow, per design) |
| G6 — ordering latency | Not tested (non-functional observation only) |

| False-PASS risk from design Section 5 | Covered by |
|---|---|
| Risk 1: Delete button visible when toggle off | T-1 |
| Risk 2: CSS-only hide | T-1 (asserts DOM count === 0, not visibility) |
| Risk 3: Log write silently swallowed | T-2, T-3 (direct disk assertion) |
| Risk 4: channelId always null | T-2 (telegram ON), T-4 (telegram OFF → null) |
| Risk 5: Meta read after delete | T-3 |
| Risk 7: Log grows unbounded | T-6 |
| Risk 8: Armed state indistinct | T-7 |
| Risk 10: Concurrent-write race | T-6 (partially — exercises 520 sequential calls, serialisation chain under load) |

## Pre-implementation sanity

Every test should FAIL against the pre-feature codebase:
- T-1: Delete button is always visible on fresh load (no `deleteModeEnabled` gate) → step 4 fails.
- T-2, T-3, T-4, T-5, T-7: `data/session-lifecycle.json` never exists → file-read assertions fail.
- T-6: `WatchdogManager.logSessionLifecycle` does not exist → import/call fails at module load.

Each test makes the feature testable on its own terms and fails the original v2 codebase.
