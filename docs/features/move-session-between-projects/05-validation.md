# Validation: Move Session Between Projects

## Test-by-Test Analysis

### T-1: Move session to a different project

**1. Outcome valid? GENUINE PASS**

The test establishes a real precondition (session created under proj-a via `session:create`), performs the mutation (`session:update` with `projectId: 'proj-b'`), and verifies the result at four independent levels: WS response payload, WS broadcast, REST API, and on-disk JSON. All four verification layers check `projectId`, `projectName`, and `cwd`. The precondition (session exists under proj-a) is confirmed by the successful `session:created` response before the move is attempted.

**2. Design sound? YES**

This test targets the core happy path -- the most important failure mode is "move does not actually persist." The four-layer verification (WS response, broadcast, REST, disk) catches shallow implementations that might update in-memory state but skip persistence, or persist but not broadcast. The design is thorough.

**3. Execution faithful? YES**

The code matches the test design point-for-point. Steps 1-11 of the design are all present. The WS state machine correctly sequences create -> move -> verify. The disk read includes a 300ms flush delay, which is reasonable given `SessionStore.save()` is async. No shortcuts taken.

---

### T-2: Rename session without moving

**1. Outcome valid? GENUINE PASS**

Precondition established: session created with name "vague" under proj-a. First mutation renames to "auth refactor" -- verified via WS response and broadcast. Second mutation sends empty string -- verified that it becomes `null`. The `projectId` is checked to remain `proj-a` after rename, confirming no accidental move.

**2. Design sound? YES**

Tests the rename-only path and the edge case of empty-string-to-null coercion. Would catch a bug where name updates accidentally mutate projectId, or where empty names are stored as empty strings rather than null.

**3. Execution faithful? YES**

The three-phase state machine (create -> rename -> empty) matches the design exactly. Both the "auth refactor" assertion and the null assertion are present. One minor gap: the design says to verify via `sessions:list` broadcast for the rename, which the code does (line 100-101 waits for broadcast after rename). The empty-name phase does not wait for its broadcast before resolving, but this is acceptable since the `session:updated` response is the primary verification target for that step.

---

### T-3: Multi-client synchronization

**1. Outcome valid? GENUINE PASS**

Two real WebSocket connections are established to the same server. Client A performs the create and move. Client B's message collector is set up before the move occurs (line 93). The test verifies both a positive assertion (B received `sessions:list` with the moved session) and a negative assertion (B received zero `session:updated` messages). The 2-second wait (line 124) is generous enough to capture any delayed broadcast.

**2. Design sound? YES**

This directly tests the broadcast isolation property: the requester gets `session:updated`, other clients get only `sessions:list`. This would catch a bug where `session:updated` is broadcast to all clients (privacy leak / duplicate processing), or where the broadcast is missing entirely.

**3. Execution faithful? YES**

Matches design steps 1-9. Both clients connect, both wait for `init`, client A creates and moves, client B's messages are collected and filtered. The negative assertion (`bUpdatedMessages.toHaveLength(0)`) is correctly implemented.

One subtlety worth noting: Client B's message collector starts AFTER the `init` wait, but the `waitForMessage` for `init` uses a one-shot handler that removes itself. The subsequent `ws.on('message', ...)` on line 93 only captures messages after `init`. This means if any `session:updated` were sent during the `init` exchange, it would be missed -- but that is not possible given the test flow, so this is fine.

---

### T-4: Move to non-existent project (adversarial)

**1. Outcome valid? GENUINE PASS**

Both adversarial inputs are tested: invalid projectId and invalid sessionId. The `waitForOneOf` helper correctly waits for either `session:error` OR `session:updated`, and then asserts it is specifically `session:error`. This is important -- it would catch a false pass where the server silently returns `session:updated` with garbage data. The REST API check after the failed update confirms no data corruption.

**2. Design sound? YES**

Tests both validation branches in `SessionManager.update()`: the session-not-found check (line 368) and the project-not-found check (line 372). Would catch missing validation, silent no-ops, or server crashes on invalid input.

**3. Execution faithful? YES**

Matches design steps 1-10. The error message assertions use `toMatch(/Project not found/i)` and `toMatch(/Session not found/i)`, which match the actual error strings thrown by `SessionManager.update()`. The data-integrity check after the first error (REST API shows session still under proj-a) confirms no partial mutation occurred.

---

### T-5: Browser UI -- Edit button opens modal, move session disappears from list

**1. Outcome valid? GENUINE PASS**

This is the only test that exercises the full client-side UI path. The session is pre-created via WS in `beforeAll`, then Playwright drives the browser through: selecting a project, verifying no "Open" button, clicking "Edit", checking modal pre-fill, selecting a different project, saving, verifying modal close, verifying toast, verifying session disappears from source project, verifying session appears in target project.

The test run output notes it took 2 attempts due to a Chromium executable path issue (not a test logic issue). The retry with the correct path passed.

**2. Design sound? YES**

This is the only test that verifies the UI contract: button labels, modal content, pre-fill values, and visual session movement between projects. Pure WS tests cannot catch UI rendering bugs, missing modal components, or broken event handlers. This test would catch: Edit button missing, modal not opening, pre-fill not working, dropdown not listing projects, Save not triggering WS message, session not visually moving.

**3. Execution faithful? YES, with one minor observation**

The code matches design steps 1-16. Selectors are reasonable (`.session-card button:has-text("Edit")`, `.form-input[placeholder="e.g. auth refactor"]`, `select.form-input`). The project dropdown selection uses `selectOption('proj-b')` which matches the option values.

Minor observation: Step 14 (verify session no longer under Alpha) iterates over `.session-card` elements and checks text content for "misplaced-session". This is correct -- if any card contains that text, the test throws. The variable `alphaHasMisplaced` on line 184 is declared but never used (dead code), but this does not affect test correctness since the check is done via the loop's throw.

---

### T-6: Rapid double-submit and running session move (adversarial)

**1. Outcome valid? GENUINE PASS**

The test creates a direct-mode session (which auto-starts), verifies it is running, sends two rapid `session:update` messages without awaiting, then verifies: both succeeded (0 errors, 2 updated messages), last-writer-wins semantics (final state is proj-a + "moved-back"), session status remains running, and PTY is still alive (accepts input and produces output).

The PTY liveness check (sending `echo pty_still_alive\n` and waiting for `session:output`) is a genuine end-to-end verification that metadata updates do not disrupt the running process.

**2. Design sound? YES**

Tests two critical properties: (a) concurrent updates are handled without corruption or errors (race condition safety), and (b) metadata updates do not interfere with running PTY processes. Would catch: mutex/lock issues causing one update to fail, status accidentally changing to stopped/error during update, or PTY being killed as a side effect of metadata mutation.

**3. Execution faithful? YES**

Matches design steps 1-11. The rapid-fire sends are genuinely concurrent (no await between them). The 2-second collection window is sufficient. The PTY liveness check with a 5-second timeout is generous. The status assertion uses `toContain` against `['running', 'starting']` which accounts for startup timing.

---

## Known Gaps from Review (03-review.md)

### 1. Modal "Saving..." spinner never resets on server error (no SESSION_ERROR listener)

**Tested? NO -- not covered by any test.**

Confirmed in code: `sessionState.js` line 107 handles `SESSION_ERROR` with `showToast(msg.error, 'error')` but does NOT call `closeEditSessionModal()` or reset `submitting`. The `EditSessionModal` component only resets `submitting` when `editSessionModalOpen.value` changes (via `useEffect` on line 19-24), which only happens if the user manually closes the modal.

T-4 tests invalid inputs but only at the WS protocol level. No test opens the modal, triggers an error, and verifies that the "Saving..." state resets or that the user can re-submit. This is a genuine UX bug that remains untested.

**Severity: Low.** The user can close the modal and reopen it (the `useEffect` resets `submitting`). But the spinner is misleading -- it suggests the request is still in flight when it has already failed.

### 2. Toast always says "Session updated" not "Session moved to [project name]"

**Tested? PARTIALLY -- T-5 asserts `text=Session updated` appears, confirming the generic message. But no test asserts the ABSENCE of the project-name variant.**

This is an acknowledged deviation in `02-implementation-notes.md`. The design allowed either form. The review flagged it. No test verifies context-aware toast messages. This is not a bug per se -- it is a conscious UX simplification.

**Severity: Cosmetic.** Not a correctness issue.

### 3. `name` field not sanitized (no length limit, no type check)

**Tested? NO -- not covered by any test.**

The review identified that `SessionManager.update()` line 379 does `session.meta.name = updates.name || null` with no type guard or length cap. A malicious client could send `name: 12345` (number) or `name: "x".repeat(10000000)` (giant string).

No test sends a non-string name or an extremely long name. T-2 only tests normal strings and empty string.

**Severity: Low for single-user app.** Preact's `htm` text interpolation prevents XSS. But a giant name could bloat `sessions.json` and cause UI layout issues.

### 4. `handleSave` always sends `name` even if unchanged (no-op round-trip)

**Tested? NO -- not explicitly tested.**

Confirmed in code: `handleSave()` (line 30-32) always sets `updates.name = trimmedName || null`. Even if the user opens the modal and clicks Save without changing anything, `name` is sent. The server handles it idempotently (overwrites with same value), but this triggers a broadcast and toast for a no-change save.

No test verifies AC 10 ("no unnecessary update is sent"). The implementation deviates from the acceptance criterion. The server does not error, so this is not a data integrity issue, but it is a false-positive toast ("Session updated" when nothing changed).

**Severity: Low.** Cosmetic -- user sees "Session updated" toast even when nothing was changed.

---

## Additional Findings

### 5. `handleSave` sends `name: null` when session had no name and user didn't type one

If a session has `name: null` and the user opens Edit and clicks Save without typing anything, `trimmedName` is `""`, so `updates.name = null`. The server receives `name: null`, and since `null !== undefined`, the `if (updates.name !== undefined)` branch on line 378 fires, setting `session.meta.name = null || null = null`. This is idempotent and harmless, but it still triggers a save + broadcast. Connected to gap #4 above.

### 6. Server handler always passes `msg.name` to SessionManager even when client omits it

In `sessionHandlers.js` line 208: `name: msg.name`. If the client sends `{ type: 'session:update', id, projectId: 'proj-b' }` without a `name` field, then `msg.name` is `undefined`, and `updates.name` is `undefined`, so the `if (updates.name !== undefined)` guard in SessionManager correctly skips the name update. This is safe. However, `handleSave` in the modal ALWAYS includes `name`, so this guard never actually fires in practice from the UI. Only raw WS clients (like the tests) can trigger the name-omission path.

### 7. No test for Escape-to-close or Ctrl+Enter-to-save (AC 6, AC 7)

T-5 tests Save via button click but does not test keyboard shortcuts (Escape to close, Ctrl+Enter to save). These are acceptance criteria 6 and 7. The implementation code for both is present (`handleKeyDown` on lines 40-42 of EditSessionModal.js), but neither is verified by any test.

---

## Overall Verdict

**FEATURE PARTIAL**

**Rationale:**

All six tests are GENUINE PASSes. The core feature works: sessions can be moved between projects, renamed, and the changes persist correctly. Multi-client sync works. Error handling for invalid inputs works. The UI correctly shows Edit instead of Open, the modal pre-fills correctly, and visual session movement works. Running sessions survive metadata updates.

However, the feature has documented-but-untested gaps:

1. **Modal spinner stuck on server error** -- known UX bug, no test coverage, no fix
2. **No input sanitization on name** -- known security recommendation, no test coverage, no fix
3. **No-op save triggers broadcast + toast** -- deviates from AC 10, no test coverage
4. **Keyboard shortcuts (Escape, Ctrl+Enter) untested** -- AC 6 and AC 7 unverified

None of these gaps represent data corruption or feature-breaking issues. The core move-session functionality is solid and well-tested across protocol, persistence, multi-client, adversarial, and browser layers. The gaps are UX polish and input validation hardening.
