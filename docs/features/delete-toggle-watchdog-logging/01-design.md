# Delete Toggle + Session Lifecycle Logging to Watchdog

## Section 1: Problem & Context

### User problems this solves

Two related problems with session deletion in the v2 app:

1. **Deletion is too fiddly and also too destructive.** Today, every delete requires a native browser `confirm()` dialog (see `public/js/components/SessionCard.js` line 105: `if (!confirm(\`Delete session "${sessionName}"?\`)) return;`). The modal stops keyboard flow, interrupts muscle-memory clicks, and cannot be dismissed without keyboard/mouse coordination. Simultaneously, the Delete button is always visible on any card whose session is not running/starting (see `SessionCard.js` lines 176-181 — the "Delete" button renders whenever `!active`). This makes accidental clicks easy on cards that look similar, and the only guard is the modal the user now wants removed. So the user needs both: (a) remove the confirmation modal, and (b) hide the Delete button by default behind an explicit "Delete mode" toggle that the user must turn on before any delete buttons appear.

2. **There is no recovery path after deletion.** `SessionManager.delete(sessionId)` at `lib/sessions/SessionManager.js` lines 393-414 stops the session (if live), removes it from the in-memory `this.sessions` Map, and calls `this.store.remove(sessionId)` which rewrites `data/sessions.json` without that record (see `lib/sessions/SessionStore.js` lines 79-83). After this, the session record is gone from `sessions.json` entirely. If the user deletes by accident (which becomes more likely under the new one-click delete flow), the only forensic trail is the previous `sessions.json` file (no backup exists) and possibly the Claude conversation `.jsonl` file in `~/.claude/projects/...` keyed by `claudeSessionId`. Without knowing the `claudeSessionId` or `tmuxName` of the deleted session, the user cannot locate the remnants to restore them.

Per the feature request, the fix is to write a lifecycle log entry (create + delete) to the watchdog state directory containing enough identity fields to reconstruct the session manually: `tmuxName`, `claudeSessionId`, `summary` (the `cardSummary` / `name` if set), and `channelId` (the Telegram chat identifier associated with the session, if one exists).

### What currently exists (v2)

**Client-side delete flow**

- `public/js/components/SessionCard.js` lines 103-107: `handleDelete` uses `confirm()` and calls `deleteSession(session.id)` on confirmation.
- `public/js/components/SessionCard.js` lines 156-184: the action bar renders Edit (always), Stop/Refresh (conditional on `active`), and Delete (only when `!active`).
- `public/js/state/actions.js` line 95-97: `deleteSession(sessionId)` sends the `session:delete` WebSocket message.
- `public/js/state/store.js` lines 79-105: UI state signals are defined here; a new `deleteModeEnabled` signal needs to live alongside these.

**Server-side delete flow**

- `public/js/ws/protocol.js` line 10: `SESSION_DELETE: 'session:delete'` (client->server).
- `lib/ws/handlers/sessionHandlers.js` lines 237-245: `SessionHandlers.delete` delegates to `this.sessions.delete(msg.id)` and broadcasts `sessions:list`.
- `lib/sessions/SessionManager.js` lines 393-414: `SessionManager.delete` stops the session if live, deletes the map entry, and calls `store.remove()`.
- `lib/sessions/SessionManager.js` line 177 + line 211: `create` paths emit a `sessionCreated` event with the meta. Delete currently does not emit a matching `sessionDeleted` event — we will need one (or direct injection from `SessionHandlers`).

**Watchdog state storage**

- `lib/watchdog/WatchdogManager.js` lines 175-199: `_stateFile()`, `_loadState()`, `_saveState()` — the state file is `data/watchdog-state.json` and currently contains only `_state` (per-watchdog-session restart counters), `_creditState`, and `updatedAt`. See the current shape in `data/watchdog-state.json` (already just 20 lines: `_state.factory`, `_state.factory2`, `_creditState`, `updatedAt`).
- `lib/watchdog/WatchdogManager.js` lines 138-141: The watchdog also writes per-session activity JSON files under `data/activity-logs/<sessionName>.json` (via `_appendLog` at lines 690-703). This directory already exists and is safe to extend or use as a pattern for the new log.
- `server.js` line 34: `SessionHandlers` is constructed with `{ watchdogManager: watchdog, settingsStore: settings }` — so the handler already has a reference to the watchdog instance and can call new methods on it.

**Session meta shape (what we have to log)**

From actual `data/sessions.json`: `id`, `projectId`, `projectName`, `name`, `command`, `cwd`, `mode`, `claudeSessionId`, `tmuxName` (null for direct mode until tmux is created — set by `TmuxSession` constructor at `lib/sessions/TmuxSession.js` line 30 to `cm-<id-prefix>`), `telegramEnabled`, `status`, `startedAt`, `exitedAt`, `previewLines`, `cardSummary`.

Notably absent: there is no `channelId` field on sessions today. The closest concept is the Telegram chat identifier held in `settings.telegramChatId` (see `lib/settings/SettingsStore.js` line 27), which is app-wide, not per-session. Sessions only record `telegramEnabled: boolean` (line 166 in SessionManager).

### What's missing and why

1. No "Delete mode" UI toggle exists. The only on/off UI toggles today are things like the split-view toggle (`store.js` line 63) and telegram-enabled in the new-session modal (`NewSessionModal.js` line 51). The feature needs a client-side UI toggle with no server persistence, with its visual target being the Delete button rendering.
2. No lifecycle log exists. Neither `SessionManager` nor `WatchdogManager` records a create/delete audit trail. The watchdog activity logs only capture AI summaries on tick; they are never written at session create/delete boundaries.
3. The concept of `channelId` on a session is not currently modeled. The feature requirement says to include it "if it exists" — which we will interpret as: read it from the session meta if present (future-proofing), and fall back to `settings.telegramChatId` at the moment of logging when `session.telegramEnabled === true`. If neither yields a value, log `channelId: null`.

---

## Section 2: Design Decision

### Part A — Delete mode toggle (client-only)

**What to build**

Introduce a single boolean UI signal `deleteModeEnabled` in `public/js/state/store.js`, default `false`. This signal controls whether the Delete button renders on any `SessionCard`. There is no server round-trip; the toggle is a purely client-side UI affordance. Persist it to `localStorage` using the same pattern as `splitView` and `splitPosition` (`store.js` lines 57-76) so it survives page reloads.

**localStorage key**

The exact key name is `'claude-delete-mode'`. Value stored as the string `'1'` for ON and `'0'` (or absent) for OFF, matching the boolean-as-string convention used by `splitView`. Read on module initialization; write on every toggle change inside an effect or the toggle click handler.

**Where the toggle lives**

Place the toggle in `public/js/components/ProjectDetail.js` inside the area-header row at line 55-70, to the left of the existing "New Claude Session" button. The toggle MUST be rendered **inside** the same `activeTab === 'sessions'` conditional guard that already wraps the "New Claude Session" button (the block that spans roughly lines 55-70 and is gated by the `activeTab === 'sessions'` ternary). Concretely: the Delete-mode toggle becomes a sibling of the existing "New Claude Session" button inside that guarded block, positioned to its left. Rationale: the Watchdog tab has no session cards to delete, so the toggle is meaningless there and must not render on other tabs. Alternative placements considered and rejected:
- `TopBar.js`: would be visible even when no project is selected (the section where delete mode is meaningless), adding visual clutter for an edge-case action.
- Inside each `SessionCard`: defeats the purpose of a single master switch.
- `SettingsModal.js`: burying a one-click safety gate two levels deep in a modal reintroduces the fiddliness this feature is designed to eliminate.

**Toggle button visual design**

A small pill-style button labelled "Delete mode" with an off/on visual state, mirroring the telegram-toggle pattern already used in `NewSessionModal.js` line 185-189 (class `quick-cmd telegram-toggle` + `active` when on). When OFF: ghost-styled, neutral border, dim text. When ON: red/danger accent background so its "armed" state is unmistakable (use existing `--danger` and `--danger-bg` CSS variables seen at `styles.css` lines 581-582). Include a subtle trash icon and the word "Delete mode". Consider showing a small warning strip or a red outline around the project-sessions list while the toggle is ON, to continuously signal the armed state — implementable as a conditional CSS class on the `#project-sessions-list` container.

**Behaviour changes in `SessionCard.js`**

1. Import `deleteModeEnabled` from `state/store.js`.
2. Remove the `confirm()` call on line 105. The new `handleDelete` body becomes a single call: `e.stopPropagation(); deleteSession(session.id); showToast(\`Deleted "${sessionName}"\`, 'info');`.
3. Wrap the Delete button render on lines 176-181 in an additional guard so it renders only when `!active && deleteModeEnabled.value`. The existing `!active` guard remains — never show Delete on running sessions (Stop is the correct action there).

**Data flow**

Delete mode state flows: user click on toggle -> `deleteModeEnabled.value = !deleteModeEnabled.value` -> Preact signal triggers re-render of every `SessionCard` -> cards conditionally render Delete buttons. The toggle value is also written to `localStorage` in an effect inside `ProjectDetail.js` or directly inside the toggle button's click handler. No WebSocket traffic, no REST call, no server state involved.

### Part B — Session lifecycle logging to watchdog (server-side)

**Storage format and location**

Add a new persisted file alongside the existing watchdog state: `data/session-lifecycle.json`. Do NOT embed the log inside `watchdog-state.json` because (a) that file is rewritten on every watchdog tick (every 30 seconds, see `_saveState()` called at the end of `tick()` in `WatchdogManager.js` line 1104) and risks clobbering lifecycle entries if a concurrent write happens; (b) `watchdog-state.json` is a state snapshot while the lifecycle log is append-only; mixing the two breaks that invariant.

File shape: a JSON array of entries, capped at some reasonable size (e.g. 500 entries), oldest dropped when full. Each entry:

```
{
  "timestamp": "2026-04-14T10:20:30.123Z",
  "event": "created" | "deleted",
  "sessionId": "<uuid>",
  "tmuxName": "cm-12345678" | null,
  "claudeSessionId": "<uuid>" | null,
  "summary": "<resolved string>" | "",
  "channelId": "<telegram chat id>" | null,
  "projectId": "<uuid>" | null,
  "projectName": "<name>" | null
}
```

We add `projectId`/`projectName` for free because they are already on the meta and help pinpoint which project the session belonged to when reconstructing. Per the feature request, the four required fields are present: `tmuxName`, `claudeSessionId`, `summary`, `channelId`.

**`summary` field precedence** — resolved at the moment of logging with this exact expression:

```
summary = session.cardSummary || session.name || ''
```

Rationale: `cardSummary` is the AI-derived, human-meaningful label that actually appears on the card in the UI, so recovery tooling benefits most from matching on what the user visually recognised. `session.name` is the user-provided fallback when `cardSummary` has not yet been populated (e.g. brand-new session before the first watchdog tick). If both are missing/empty, the empty string is written (never `null`), to guarantee the field type is always a string and avoid null-vs-missing ambiguity for consumers.

**New API surface on `WatchdogManager`**

Add three methods to `lib/watchdog/WatchdogManager.js` (near `_appendLog` lines 690-703 so log-related code is grouped):

- `_lifecycleFile()` — returns `path.join(this.dataDir, 'session-lifecycle.json')`.
- `_loadLifecycle()` — reads the file, returns `[]` on missing/corrupted.
- `async logSessionLifecycle({ event, session, channelId })` — public **async** method that appends one entry. Accepts the raw session meta (as passed by SessionManager/SessionHandlers) plus an already-resolved `channelId` (string or null) computed at the call site. Internally: loads the array, pushes the new entry, trims to the cap (e.g. last 500), writes atomically via `write-tmp-then-rename` (the same pattern used by `_saveState` at lines 191-197 and `_appendLog` at lines 695-698).

The method must be resilient: any I/O failure is caught and logged but never thrown upward, because lifecycle logging is strictly observational — it must not block or fail a user's delete/create action.

**Concurrent-write protection**

To avoid silent entry loss under concurrent append operations (two `logSessionLifecycle` calls interleaving read-modify-write), `WatchdogManager` holds a single instance-level Promise chain (e.g. `this._lifecycleWriteChain = Promise.resolve()`). Every call to `logSessionLifecycle` appends its work to the chain: `this._lifecycleWriteChain = this._lifecycleWriteChain.then(() => this._doLifecycleAppend(entry)).catch(() => {})`. This serialises appends within a single process without adding an external dependency. The method returns the chain member's promise so callers may await it in tests; production callers need not await.

**Where lifecycle logging is invoked**

The cleanest integration point is `SessionHandlers` in `lib/ws/handlers/sessionHandlers.js`, because it already receives the `watchdogManager` reference via its constructor (`server.js` line 34). Both `create` and `delete` flows become async throughout (the delete handler already uses `await this.sessions.delete(...)`).

**`SessionHandlers.create` (lines 102-147)** — after `this.sessions.create(...)` returns successfully on line 126 and before the `session:created` reply on line 142:

1. `const channelId = await resolveChannelId(session, this.settingsStore);`
2. `this.watchdogManager.logSessionLifecycle({ event: 'created', session, channelId });` (fire-and-forget; method is internally resilient, but the `channelId` MUST be awaited before this call because it comes from an async settings lookup).

**`SessionHandlers.delete` (lines 237-245)** — replace the existing two-line body with this exact ordered sequence (no conditional guards on the delete call itself):

1. `const meta = this.sessions.get(msg.id);` — may be null if the session is already gone. This MUST run before step 2.
2. `await this.sessions.delete(msg.id);` — unconditional. This runs regardless of whether `meta` was captured. `SessionManager.delete` is already a no-op for unknown ids (line 395), so an already-deleted session is safely idempotent. The delete operation MUST NOT be skipped because meta was null.
3. `if (meta) { const channelId = await resolveChannelId(meta, this.settingsStore); this.watchdogManager.logSessionLifecycle({ event: 'deleted', session: meta, channelId }); }` — the log entry is conditional on having captured meta (because without it, every log field would be null and the entry is useless). Meta-capture failure only affects logging; it never affects the delete.
4. `this._broadcastSessionsList();` — unchanged from existing behaviour.

Rationale for doing this in the handler rather than inside `SessionManager`: `SessionManager` has no watchdog or settings dependency and we should not invert that relationship just for logging. The handler is already the "glue layer" with both handles.

**channelId resolution logic**

`SettingsStore.get(key)` is **async** (confirmed at `lib/settings/SettingsStore.js` line 132: `async get(key)` returns a Promise). The helper must therefore be async and its result must be awaited at every call site. Implement as a small async helper inside `SessionHandlers` (or a tiny utility near the top of the file) with exactly two checks, in order:

1. If `session.channelId` is truthy, return it. This branch is **forward-looking**: no session today has a `channelId` field (see Section 1 "Notably absent"), but the session-meta shape may gain one in a follow-up release once Telegram access supports per-chat routing (see `lib/api/routes.js` around line 360 — `access.pending` / `access.allowFrom`). Including this branch now means no change is needed to lifecycle logging when that field is added. Document this intent in a code comment above the branch.
2. Else, if `session.telegramEnabled === true` and `settingsStore` is provided, `await settingsStore.get('telegramChatId')` inside a try/catch. If the awaited value is truthy, return it. On any error, fall through.
3. Otherwise return `null`.

The previously proposed `session.telegramChatId` branch is **removed** — it has no codebase precedent and would create a silent false-negative path if a typo ever referenced a non-existent field. Only `session.channelId` (future-proofing, explicitly documented) and `settings.telegramChatId` (today's source) are consulted.

Every caller of `resolveChannelId` MUST `await` it; the value is passed into `logSessionLifecycle` as a resolved string or null, never as a Promise.

**What NOT to build**

- **No restore/undo feature** in this release. The lifecycle log is a manual recovery aid only; the user will reconstruct deleted sessions by reading the log and using existing "New Session" flows. Scope creep into a one-click undo would require persisting full PTY state, which is out of scope.
- **No UI view of the lifecycle log.** It lives on disk only, for now. If the user asks to surface it in a Watchdog panel tab later, that's a separate feature.
- **No deletion of the log on session recreation.** Entries are historical records; recreating a session with the same name does not rewrite history.
- **No confirmation modal of any kind on delete.** The Delete mode toggle is the sole guard.
- **No Delete button on running/starting sessions.** The existing `!active` guard stays. Users must Stop first.
- **No bulk delete.** Out of scope.
- **No server-side toggle state.** Delete mode is ephemeral per-client UI.

### Edge cases and failure modes

1. **Watchdog logging I/O error** (e.g. disk full, permission denied): the `logSessionLifecycle` implementation catches and swallows errors. The delete/create call must succeed even if logging fails. The error is logged via `console.error` or via `this.emit('error', err)`, which `server.js` line 106 already handles.
2. **Session meta has `tmuxName: null`** (a direct-mode session): log `tmuxName: null`. The feature does not require every entry to have a tmux name; the field is captured because it may exist.
3. **Session being deleted is already missing from the Map** (race or double-click): `SessionHandlers.delete` reads `const meta = this.sessions.get(msg.id)` first. Per the ordered steps above, the delete call `await this.sessions.delete(msg.id)` then runs **unconditionally** — it is a no-op for unknown ids (`SessionManager.delete` returns silently, line 395) so this is safe. Only the lifecycle-log call is guarded by `if (meta)`; meta-capture failure suppresses only the log entry, never the delete. This guarantees AC12.
4. **Double-click on Delete button**: the button click causes `deleteSession()` -> WS message -> server delete. A second click while the first is in flight sends a second `session:delete` with the same id. Server handles both; the first removes, the second is a no-op. Lifecycle log sees only one "deleted" entry because the second pass has no meta to log. Acceptable.
5. **localStorage access blocked** (private browsing, disabled storage): the delete-mode read/write should be wrapped in try/catch just like the existing `readSplitView`/`readSplitPosition` helpers. Default to `false` when read fails.
6. **`channelId` contains an integer** (Telegram chat IDs are usually numeric strings but sometimes stored as numbers): serialize whatever comes out of `settingsStore.get('telegramChatId')` — JSON accepts both. Recovery tooling can coerce as needed.
7. **Log file grows unbounded**: cap to 500 entries; oldest dropped when the cap is exceeded. The existing `_appendLog` uses `MAX_LOG_ENTRIES = 200` at line 45; we use 500 here because lifecycle events are rarer than watchdog summaries, and 500 entries covers roughly a year of normal use.
8. **Corrupted log file** (bad JSON): `_loadLifecycle` returns `[]` on parse failure; new entries start fresh. Prior history is lost but the app keeps working. (Same forgiveness strategy as `SessionStore.load()` at `lib/sessions/SessionStore.js` lines 36-38 and `_loadState` at `WatchdogManager.js` lines 179-184.)

### Files to modify

**Client**
- `public/js/state/store.js` — add `deleteModeEnabled` signal (with localStorage read/write helpers using key `'claude-delete-mode'`) near lines 57-76.
- `public/js/components/ProjectDetail.js` — add the Delete-mode toggle button inside the `activeTab === 'sessions'` guard in the area-header row at lines 55-70, positioned to the left of the existing "New Claude Session" button.
- `public/js/components/SessionCard.js` — remove `confirm()` from `handleDelete` (line 105); add a `showToast(\`Deleted "${sessionName}"\`, 'info')` call after `deleteSession(session.id)`; gate Delete button render on `deleteModeEnabled.value` (lines 176-181); import both the signal and `showToast`.

**Server**
- `lib/watchdog/WatchdogManager.js` — add `_lifecycleFile()`, `_loadLifecycle()`, the instance-level `_lifecycleWriteChain` serialisation promise, and the async `logSessionLifecycle({ event, session, channelId })` method.
- `lib/ws/handlers/sessionHandlers.js` — add the async `resolveChannelId(session, settingsStore)` helper (only checks `session.channelId` for future-proofing, then awaits `settingsStore.get('telegramChatId')` when `session.telegramEnabled`); make `create` and `delete` flows await it; invoke `logSessionLifecycle` from `create` after success, and from `delete` in the ordered sequence described above (read meta -> unconditional delete -> conditional log -> broadcast).

**No changes needed in**: `server.js` (watchdog is already passed to handlers), `SessionManager.js`, `SessionStore.js`, `protocol.js`, `api/routes.js`.

---

## Section 3: Acceptance Criteria

1. **Given** a fresh page load with any number of non-running sessions, **when** the user inspects each session card, **then** no Delete button is visible on any card.
2. **Given** a project view with session cards, **when** the user clicks the "Delete mode" toggle in the area header, **then** the toggle visually changes to an armed/red state AND every non-running session card now shows a Delete button.
3. **Given** Delete mode is ON, **when** the user clicks Delete on a session card, **then** the session is deleted immediately without any modal/confirm/dialog appearing, and the card disappears from the list.
4. **Given** Delete mode is ON, **when** the user clicks the toggle again, **then** all Delete buttons vanish from the cards without affecting any sessions.
5. **Given** a running or starting session, **when** Delete mode is ON, **then** the Delete button does NOT appear on that session card (the existing `!active` guard still applies); the user sees Stop instead.
6. **Given** the user enables Delete mode and refreshes the page, **when** the page reloads, **then** Delete mode remains enabled (or disabled, whatever its last state was) because it is persisted to localStorage.
7. **Given** a session is created via the New Session modal, **when** the server completes creation successfully, **then** `data/session-lifecycle.json` contains a new entry with `event: "created"`, the session's `id`, `tmuxName` (or null for direct mode), `claudeSessionId`, `summary` (derived from `name` or `cardSummary`), and `channelId` (the Telegram chat id if telegram is enabled, else null).
8. **Given** a session is deleted via Delete mode, **when** the server processes the delete, **then** `data/session-lifecycle.json` contains a new entry with `event: "deleted"` and the same identity fields the session had immediately before deletion.
9. **Given** `data/session-lifecycle.json` does not exist, **when** the first create or delete event fires, **then** the file is created and contains a single entry (no crash on missing file).
10. **Given** writing to `data/session-lifecycle.json` fails (e.g. directory is read-only), **when** the user deletes a session, **then** the session is still deleted successfully and the UI updates correctly — the log failure does not break the user-visible action.
11. **Given** Delete mode is ON, **when** the user clicks Delete on a session card, **then** a toast notification appears that contains the deleted session's name (confirming the deletion happened, since no modal was shown).
12. **Given** a session whose meta is no longer in the in-memory Map at the moment of delete (e.g. deleted twice in rapid succession), **when** the server processes the second `session:delete`, **then** the delete call still runs (as a no-op) without crashing, and no lifecycle entry is written for the second attempt. Meta-capture failure must not prevent the delete from running.

---

## Section 4: User Lifecycle Stories

### Story 1: Safe browsing with Delete mode off

The user opens the app and browses their project. They see their sessions listed in cards, each with Edit and Stop/Refresh buttons. They hover over cards, click to attach, click Edit to rename — nothing they do can delete a session. They close the tab and reopen later; the state is unchanged.

### Story 2: Intentional cleanup

The user has finished a week of work and has 12 stopped sessions they no longer need. They click the "Delete mode" toggle in the area header; it turns red/armed. The session cards now show Delete buttons. They click Delete on the first stale session — it disappears instantly, a toast confirms "Deleted '<name>'". They continue clicking Delete on the rest, getting through all 12 in about fifteen seconds. They toggle Delete mode off. The cards now look back to their normal state.

### Story 3: Accidental click saved by the toggle

The user is navigating the session list quickly and their finger slips toward where the Delete button used to always live. Because Delete mode is OFF (the default), there is no Delete button at that position — nothing happens. The user realizes they almost deleted a session and feels relieved that the toggle prevented it.

### Story 4: Recovering an accidentally deleted session

The user meant to delete session A but in Delete-mode-on they accidentally clicked Delete on session B — which hosted an important in-progress conversation. Session B is gone from the UI. The user opens a file browser or terminal and inspects `data/session-lifecycle.json`. They find the most recent entry with `event: "deleted"` and the name "session B"; it includes the `claudeSessionId` and the `tmuxName`. They use New Session with the `--resume <claudeSessionId>` flag (via the New Session modal's command field) to restart the conversation. The tmux session is gone but the conversation continues.

### Story 5: Audit trail over time

The user has been using the app for several weeks. They want to know what sessions existed last Tuesday. They open `data/session-lifecycle.json` and see a chronological log of create/delete events with timestamps, names, and project assignments. They can trace the evolution of their workspace without having to parse Claude's internal `.jsonl` files.

---

## Section 5: Risks & False-PASS Risks

### Risk 1: Delete button visible when Delete mode is off

**Risk**: The gating condition in `SessionCard.js` is wrong — e.g., `deleteModeEnabled.value || !active` instead of `!active && deleteModeEnabled.value`. The Delete button remains visible regardless of toggle state, defeating the whole feature.

**Mitigation**: The acceptance criterion #1 explicitly requires "no Delete button is visible on any card" on fresh load. A Playwright test should assert zero Delete-labeled buttons exist in the DOM when the toggle is off.

### Risk 2: False-PASS — toggle only hides the button visually but click still works

**Risk**: If Delete mode is implemented purely via CSS `display: none`, the button may still be clickable via automated tools or via accessibility trees, and any test driving the DOM directly could "pass" by clicking the hidden button. More importantly, the user would see no button but a hidden one still counts as confusing.

**Mitigation**: Gate by *not rendering* the button in JSX (return `null` when off), not by CSS. This ensures neither a human nor an automation tool can invoke it when the toggle is off.

### Risk 3: Lifecycle log not written when create/delete succeeds

**Risk**: The `logSessionLifecycle` call is added but swallowed errors are not caught. A bug in the file path or a typo in field names could silently produce no log entries while create/delete succeed, and tests that only check UI state would pass.

**Mitigation**: Acceptance criteria 7 and 8 explicitly require reading `data/session-lifecycle.json` and verifying entry contents. Tests must inspect the file on disk, not just UI state.

### Risk 4: False-PASS — log written but missing required fields

**Risk**: The log is written but `channelId` is always null because the resolution logic incorrectly reads from a non-existent settings path. An assertion that checks "the log contains an entry" passes, while the `channelId` field silently remains useless.

**Mitigation**: Acceptance criterion 7 requires `channelId` to equal the Telegram chat id "if telegram is enabled". A test must create a session with `telegram: true`, with settings containing a `telegramChatId`, and assert the logged `channelId` equals that value. Separately, a test with `telegram: false` must assert `channelId` is null. Two cases, two assertions.

### Risk 5: Race between delete and log-write

**Risk**: `SessionHandlers.delete` could accidentally read the meta AFTER calling `this.sessions.delete()`, returning null and logging an entry full of nulls (except `sessionId` from the message). The feature would appear to work but entries would be unusable.

**Mitigation**: Order in the handler is critical — meta MUST be read before delete. Code review checklist item: the line that reads `this.sessions.get(msg.id)` must appear lexically above `this.sessions.delete(msg.id)`. Tests should assert at least one non-null identity field (e.g. `tmuxName` for tmux-mode sessions) in a "deleted" log entry.

### Risk 6: localStorage persistence failure silently resets toggle

**Risk**: A try/catch around localStorage writes swallows errors. In private browsing mode, the toggle would appear to persist during the session but reset to OFF on every reload without any user-visible feedback. This isn't a data-loss bug, but it subtly degrades UX.

**Mitigation**: Acceptable trade-off — matches the existing behaviour of `splitView`/`splitPosition` in `store.js`. Document in code comments that this is best-effort persistence.

### Risk 7: Log file grows without bound in a test loop

**Risk**: An automated test that creates + deletes thousands of sessions would grow `session-lifecycle.json` indefinitely if the cap is forgotten. Eventually the JSON parse on startup is slow or fails.

**Mitigation**: The cap of 500 entries must be enforced on every append (same pattern as `_appendLog` using `MAX_LOG_ENTRIES`). A unit test that appends 600 entries and verifies the file contains exactly 500 is cheap and catches this.

### Risk 8: Delete mode active state not visually distinct

**Risk**: If the armed toggle looks too similar to the off state, users may think Delete mode is still off, click Delete (which is visible), and expect "nothing will happen". Their accidental click deletes a session they didn't mean to.

**Mitigation**: Use the existing `--danger-bg` / `--danger` CSS tokens (already defined, used by `.btn-danger`) for the armed toggle background so the "armed" state reads as red/red-tinted, not as ghost/neutral. Optionally apply a red outline or warning strip to the session list while armed. Visual review during QA should confirm the state difference is obvious at a glance.

### Risk 9: Session with name changes between create and delete — summary mismatch

**Risk**: The user creates a session named "foo", later renames it to "bar" via Edit, then deletes it. The "created" log entry shows `summary: "foo"` while the "deleted" log entry shows `summary: "bar"`. If a recovery tool correlates by `summary`, it fails.

**Mitigation**: Log entries are keyed by `sessionId` (UUID, immutable), not by `summary`. Any recovery tool should correlate by `sessionId`. Document this in the code comment where `logSessionLifecycle` is defined.

### Risk 10: `logSessionLifecycle` called during high-rate creates (watchdog restart loops)

**Risk**: The watchdog itself restarts sessions (`lib/watchdog/WatchdogManager.js` line 1146 `this._startSession(sess)`), and if in the future watchdog also goes through `SessionHandlers.create`, rapid lifecycle log writes could contend for the file. Today this is not a path — watchdog restarts use tmux directly, not `SessionHandlers.create` — but it is a latent risk. Without serialisation, two concurrent appenders would each read the existing array, each push their own new entry, and the last renamer would win — silently dropping the other's entry.

**Mitigation**: `WatchdogManager` serialises appends through a single instance-level Promise chain (`_lifecycleWriteChain`; see "Concurrent-write protection" in Section 2 Part B). All `logSessionLifecycle` calls queue behind prior ones within the same process, so no entry is lost to a lost-update race. The tmp-file-then-rename write remains atomic on POSIX as a second layer of protection against partial writes on crash. Cross-process contention (multiple Node instances writing the same file) is out of scope — the app runs as a single process.
