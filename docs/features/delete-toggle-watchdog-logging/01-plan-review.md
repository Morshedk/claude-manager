# Plan Review (v2): Delete Toggle + Session Lifecycle Logging

**Verdict: APPROVED**

All eight previously flagged defects (D1–D8) are resolved. The design now pins exact strings for localStorage keys, function signatures, field-precedence expressions, and the delete-handler's ordered step list. Every spot-checked file:line citation matches the v2 codebase. The plan can be handed to an implementer with no additional context.

One trivial wording drift in AC7 is noted below as a non-blocking recommendation.

---

## Verification of previously flagged defects

| ID | Previous issue | Status | Evidence in updated design |
|---|---|---|---|
| D1 | `SettingsStore.get()` is async — helper was called synchronously | **FIXED** | Section 2 Part B ("channelId resolution logic") now explicitly states `SettingsStore.get(key)` is async at `lib/settings/SettingsStore.js` line 132, marks `resolveChannelId` as async, requires `await settingsStore.get('telegramChatId')`, and closes with: "Every caller of `resolveChannelId` MUST `await` it; the value is passed into `logSessionLifecycle` as a resolved string or null, never as a Promise." Integration points in `create` (step 1-2) and `delete` (step 3) show the `await` at call sites. |
| D2 | Conflicting instructions for the `delete` handler (`if present, delete` vs. unconditional delete) | **FIXED** | Section 2 Part B now has a single unambiguous ordered list (steps 1–4): read meta → `await this.sessions.delete(msg.id)` unconditional → conditional log if meta captured → broadcast. Edge case 3 now matches exactly and explicitly states "delete call then runs unconditionally". AC12 re-asserts this. |
| D3 | Missing acceptance criterion for the toast | **FIXED** | AC11 added verbatim: "a toast notification appears that contains the deleted session's name (confirming the deletion happened, since no modal was shown)." |
| D4 | Toggle placement in `ProjectDetail.js` not gated on `activeTab === 'sessions'` | **FIXED** | Section 2 Part A now says: "The toggle MUST be rendered **inside** the same `activeTab === 'sessions'` conditional guard that already wraps the 'New Claude Session' button" and repeats this in "Files to modify". Rationale included (Watchdog tab has no session cards). |
| D5 | `summary` precedence ambiguous | **FIXED** | Section 2 Part B pins the expression exactly: `summary = session.cardSummary || session.name || ''`. Rationale given (cardSummary is what the user visually recognised). Empty string (never null) also specified, eliminating null-vs-missing ambiguity for consumers. Note: this flips the original review's suggested order (name-first); the design chose cardSummary-first with a defensible rationale. Acceptable. |
| D6 | Speculative `session.telegramChatId` branch | **FIXED** | Branch is explicitly removed with a call-out: "The previously proposed `session.telegramChatId` branch is **removed** — it has no codebase precedent and would create a silent false-negative path if a typo ever referenced a non-existent field." Only `session.channelId` (documented as future-proofing with an inline code comment) and `settings.telegramChatId` (today's source) remain. |
| D7 | Concurrent-write entry loss | **FIXED** | Section 2 Part B adds an instance-level `_lifecycleWriteChain` serialisation Promise. The mechanism is spelled out concretely: `this._lifecycleWriteChain = this._lifecycleWriteChain.then(() => this._doLifecycleAppend(entry)).catch(() => {})`. Risk 10's mitigation rewrites the weak paragraph into a concrete reference to this mechanism, and scopes the remaining out-of-scope risk (cross-process contention). |
| D8 | Exact localStorage key name missing | **FIXED** | Key pinned: `'claude-delete-mode'`, with value convention `'1'`/`'0'` (matches `splitView`). |

All eight defects resolved.

---

## Citation spot-checks against v2 codebase

Five fresh spot-checks against `/home/claude-runner/apps/claude-web-app-v2/`:

| Claim | Verification | Verdict |
|---|---|---|
| `SessionCard.js` line 105: `if (!confirm(\`Delete session "${sessionName}"?\`)) return;` | Line 105 matches character-for-character. | PASS |
| `SessionCard.js` lines 176-181: Delete button gated on `!active` | Lines 176-181 render `${(!active) ? html\`...\` : null}` wrapping the Delete button. | PASS |
| `sessionHandlers.js` lines 237-245: `delete` handler delegates to `this.sessions.delete(msg.id)` and calls `this._broadcastSessionsList()` | Lines 237-245 match; the current body is `try { await this.sessions.delete(msg.id); } catch ... } this._broadcastSessionsList();`. | PASS |
| `SettingsStore.js` line 132: `async get(key)` | Exact match: `async get(key) { await this._ensureLoaded(); ... }`. Confirms D1 fix is required and correctly documented. | PASS |
| `server.js` line 34: `new SessionHandlers(sessions, clientRegistry, { watchdogManager: watchdog, settingsStore: settings })` | Exact match. Confirms the handler already has both dependencies. | PASS |
| `store.js` lines 57-76: split-view pattern with try/catch localStorage reads | Exact match. Pattern is safe to mirror for `deleteModeEnabled`. | PASS |
| `ProjectDetail.js` lines 55-70 area-header block with `activeTab === 'sessions'` guard | Confirmed: lines 55-69 contain the `<div class="area-header">` with the ternary `${activeTab === 'sessions' ? html\`<button...New Claude Session>\` : null}`. | PASS |
| `WatchdogManager.js` lines 175-199 `_stateFile/_loadState/_saveState` + tmp-rename pattern | Lines 175-199 match; `_saveState` writes via `tmp` then `fs.renameSync`. | PASS |
| `WatchdogManager.js` lines 690-703 `_appendLog` uses `MAX_LOG_ENTRIES` | Lines 690-703 match; tmp-then-rename with best-effort fallback. | PASS |
| `SessionManager.js` lines 393-414 `delete()` (stop-if-live → Map delete → `store.remove`) and "no-op for unknown ids" (line 395 `if (!session) return;`) | Exact match: line 395 is `if (!session) return;` — this validates the AC12 / Edge-case-3 guarantee. | PASS |

Zero mismatches. All citations that matter for implementation are accurate.

---

## Section-by-section compliance (full independent pass)

| Section | Present | Substantive | Notes |
|---|---|---|---|
| 1. Problem & Context | Yes | Yes | Problem is articulated with two distinct sub-problems, each grounded in concrete file:line pointers. "What currently exists" lists every touch point. "What's missing and why" enumerates three gaps. "Notably absent" call-out for `channelId` is honest about the data model limitation. |
| 2. Design Decision | Yes | Yes | Part A (client toggle) and Part B (server logging) both have exact string pins for localStorage key, JSON field shape, summary expression, log cap (500), and ordered step lists for both the `create` and `delete` handler integration. "What NOT to build" is explicit and sufficiently wide. Edge cases section covers 8 real scenarios. "Files to modify" lists every file with rationale. |
| 3. Acceptance Criteria | Yes | Yes | 12 criteria, all in Given/When/Then form. Covers UI toggle default state (AC1), toggle-on reveal (AC2), one-click delete without modal (AC3), toggle-off hide (AC4), running-session guard (AC5), localStorage persistence (AC6), log entry on create (AC7), log entry on delete (AC8), missing-file creation (AC9), log-failure resilience (AC10), toast (AC11), idempotent delete + meta-capture-failure (AC12). Every acceptance criterion is observable from the running app or by inspecting `data/session-lifecycle.json` on disk. |
| 4. User Lifecycle Stories | Yes | Yes | Five stories. Stories 1, 2, 3 are pure in-app journeys. Stories 4 and 5 require the user to open a file browser and inspect `data/session-lifecycle.json`. This is intrinsic to the feature (Section 2 explicitly scopes out a UI viewer), so it is a deliberate UX decision rather than a design defect. Flagged below as a known limitation worth surfacing to the user, not a blocker. |
| 5. Risks & False-PASS | Yes | Yes | 10 risks. Four are genuine false-PASS risks (#1 bad gating, #2 CSS-only hide, #3 swallowed log errors, #4 logged-but-empty-fields). #5 covers the meta-before-delete race (key to AC12). #7 covers unbounded growth. #8 covers UX risk of indistinct armed state. #10 covers concurrent-write entry loss and now references the `_lifecycleWriteChain` mechanism concretely. |

All five sections present and substantive.

---

## Observability / false-PASS check on each acceptance criterion

Each AC must be checkable without trusting code behaviour blindly. Spot-check:

- **AC1 (no Delete button on fresh load)** — observable via DOM query for "Delete" button count == 0 on session cards.
- **AC3 (immediate delete, no modal)** — observable via Playwright: click Delete, assert no `confirm()` dialog, assert card removed within N ms.
- **AC7/AC8 (log entry shape)** — observable via reading `data/session-lifecycle.json` after create/delete and asserting specific fields. Risk #4 mitigation calls out that `channelId` must be verified twice (telegram-on returning the chat id; telegram-off returning null) — this defends against the "log-looks-written-but-is-empty" false-PASS.
- **AC10 (log-failure doesn't break delete)** — harder to test in-app, but achievable by mocking the filesystem or pre-creating a read-only file. Design acknowledges this is observational and acceptable.
- **AC12 (idempotent double-delete)** — observable by sending two `session:delete` messages for the same id in quick succession and asserting (a) no crash, (b) exactly one lifecycle entry.

All 12 ACs have a path from observable behaviour to assertion. No criterion relies on internal state alone.

---

## Lifecycle stories — in-app-ness check

| Story | In-app? | Notes |
|---|---|---|
| 1. Safe browsing (Delete mode off) | Yes | Pure UI journey. |
| 2. Intentional cleanup | Yes | Toggle, click Delete 12 times, toast appears, toggle off. |
| 3. Accidental click saved by toggle | Yes | Finger-slip scenario; the absence of the button is the outcome. |
| 4. Recovering an accidentally deleted session | Partial | Requires opening `data/session-lifecycle.json` outside the app. Intrinsic to the feature's "disk log, no UI view" scope. |
| 5. Audit trail over time | Partial | Same disk-inspection requirement. |

Stories 4 and 5 are partial by design, not by oversight — Section 2's "What NOT to build" explicitly scopes out a UI viewer. The feature as specified is genuinely a disk-only log. This is an acceptable trade-off for v1; surfacing it into the Watchdog tab is correctly queued as a follow-up. Recommendation (non-blocking): the implementer should add a comment in `logSessionLifecycle`'s header summarising the intended recovery workflow so operators know to look for the log.

---

## Failure modes + false-PASS risks — real coverage

The design covers at least three realistic failure modes:

1. **Logged entry with `channelId: null` when telegram is enabled** (Risk #4): real because `SettingsStore.get` is async and forgetting the `await` returns a Promise that JSON-serialises to `{}`. Mitigation via two explicit test cases (telegram-on vs telegram-off).
2. **Delete works but log entry is missing / entry full of nulls** (Risks #3, #5): real because order-of-operations in `SessionHandlers.delete` is subtle (read meta *before* delete). Mitigation via ordered step list + review checklist.
3. **Silent entry loss under concurrent writes** (Risk #10): real because the naive tmp-rename pattern loses lost-update races. Mitigation via `_lifecycleWriteChain` Promise chain — cited concretely.

False-PASS risks explicitly called out: CSS-only hiding letting automation click an invisible button (Risk #2); UI-only tests passing while the log stays empty (Risk #3); log entries present but with a null `channelId` (Risk #4). Each has a concrete mitigation expressible as a test assertion.

---

## Non-blocking observations

### O1 — AC7 wording lags Section 2's pinned expression

AC7 says `summary (derived from \`name\` or \`cardSummary\`)`. Section 2's pinned precedence is `cardSummary || name || ''`. The AC7 wording reverses the order verbally. A strict reader following only AC7 might assert `name`-first and fail the check. Recommendation: tighten AC7 to `summary (derived as \`cardSummary || name || ''\`)` so the acceptance criterion and the design decision speak the same language. This is copy-edit only and not a blocker.

### O2 — Story 4's recovery path is aspirational

Story 4 says the user uses "New Session with the `--resume <claudeSessionId>` flag (via the New Session modal's command field)" to recover. This is plausible but not independently verified in the design (no citation to confirm `--resume` works via the command field today). The recovery workflow may need a smoke-test during implementation. Not a blocker — the feature itself succeeds as long as the log entries are written correctly; recoverability of deleted sessions is a user workflow built on top of it.

### O3 — `WatchdogManager._lifecycleWriteChain` should be initialised in the constructor

The design says "holds a single instance-level Promise chain (e.g. `this._lifecycleWriteChain = Promise.resolve()`)". Implementers should remember to initialise this in the `WatchdogManager` constructor alongside other fields, not lazily on first use. Not a blocker (easy to get right from the description), but a concrete reminder.

---

## Scope boundary

Section 2's "What NOT to build" list is explicit and wide: no restore/undo, no UI view of the log, no log deletion on recreate, no confirmation modal, no delete on running sessions, no bulk delete, no server-side toggle state. This cleanly bounds the feature and prevents scope creep during implementation.

---

## Summary

The revised design is implementable by an independent agent with no additional context. All eight previously flagged defects are fixed with pinned exact strings / ordered steps / explicit rationale. All re-verified citations match the v2 codebase. Twelve observable acceptance criteria cover the behaviour, including both the in-app UI flow and the on-disk log contents. The three non-blocking observations above can be addressed during implementation without a further review cycle.

**Verdict: APPROVED.**
