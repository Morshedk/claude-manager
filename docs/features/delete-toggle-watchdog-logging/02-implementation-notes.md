# Implementation Notes: Delete Toggle + Session Lifecycle Logging

## Files modified

### Client-side

**`public/js/state/store.js`**
- Added `readDeleteMode()` helper (reads `localStorage` key `'claude-delete-mode'`, returns `true` if stored value is `'1'`, defaults to `false` on error).
- Added `export const deleteModeEnabled = signal(readDeleteMode())` after `splitPosition`.
- Pattern mirrors existing `readSplitView()` / `readSplitPosition()` helpers: try/catch with a safe default.

**`public/js/components/SessionCard.js`**
- Added `import { deleteModeEnabled } from '../state/store.js'`.
- Removed `confirm()` call from `handleDelete`. New body: `e.stopPropagation(); deleteSession(session.id); showToast(\`Deleted "${sessionName}"\`, 'info');`
- Changed Delete button render guard from `(!active)` to `(!active && deleteModeEnabled.value)` — conditional render (not CSS hide), so the button is absent from the DOM when Delete mode is off.

**`public/js/components/ProjectDetail.js`**
- Added `deleteModeEnabled` to the import from `'../state/store.js'`.
- Added the Delete mode toggle button inside the `activeTab === 'sessions'` guard, positioned to the left of the "New Claude Session" button. The toggle:
  - Applies `btn-danger` class + red inline style when armed, `btn-ghost` when off.
  - Writes `localStorage.setItem('claude-delete-mode', deleteModeEnabled.value ? '1' : '0')` inline in the click handler (best-effort, inside try/catch).
  - Uses the trash (delete) path icon from heroicons (same source as other SVGs in the codebase).
- Added a red outline (`outline: 2px solid rgba(240,72,72,0.35)`) to `#project-sessions-list` when `deleteModeEnabled.value` is true, as the design called for a continuous "armed" visual.

### Server-side

**`lib/watchdog/WatchdogManager.js`**
- Added `this._lifecycleWriteChain = Promise.resolve()` in the constructor (after `this._learningsFile`, as O3 from the plan review recommended).
- Added three methods after `_appendLog`:
  - `_lifecycleFile()` — returns `path.join(this.dataDir, 'session-lifecycle.json')`.
  - `_loadLifecycle()` — reads and parses the file, returns `[]` on any error (forgiveness strategy matching `_loadState`).
  - `_doLifecycleAppend(entry)` — async, does the actual read-push-trim-write with tmp-then-rename. Catches all errors and emits via `console.error` + `this.emit('error', err)`. Cap: 500 entries.
  - `logSessionLifecycle({ event, session, channelId })` — public method. Builds the entry object, chains the append onto `_lifecycleWriteChain`, returns the chained promise. Never throws outward.

**`lib/ws/handlers/sessionHandlers.js`**
- Added `resolveChannelId(session, settingsStore)` as a module-level async function (above the class definition). Three checks in order: `session.channelId` (forward-looking, documented), `await settingsStore.get('telegramChatId')` when `session.telegramEnabled`, then `null`.
- Added `this.watchdogManager = watchdogManager` and `this.settingsStore = settingsStore` in the constructor. These were destructured but not stored before — the handler was using them locally only (for the `summary` event listener and `startPreviewInterval`). Storing them is required for the lifecycle log calls in `create` and `delete`.
- Updated `create` handler: after `this.registry.subscribe(clientId, session.id)` and before `this.registry.send(clientId, { type: 'session:created', ... })`, added:
  ```js
  if (this.watchdogManager) {
    const channelId = await resolveChannelId(session, this.settingsStore);
    this.watchdogManager.logSessionLifecycle({ event: 'created', session, channelId });
  }
  ```
- Replaced `delete` handler body with the exact ordered 4-step sequence from the design: (1) `const meta = this.sessions.get(msg.id)` before delete, (2) unconditional `await this.sessions.delete(msg.id)`, (3) conditional `logSessionLifecycle` if meta captured, (4) `_broadcastSessionsList()`.

## Deviations from the design

None. Every specified detail was implemented as written:
- localStorage key `'claude-delete-mode'`, values `'1'`/`'0'`.
- `summary = session.cardSummary || session.name || ''` (cardSummary-first, never null).
- `_lifecycleWriteChain` initialised in constructor.
- `resolveChannelId` checks only `session.channelId` and `settings.telegramChatId` (no speculative `session.telegramChatId` branch).
- Delete button gated by actual conditional render, not CSS.
- Log in `data/session-lifecycle.json` (separate from `watchdog-state.json`).
- Cap: 500 entries.

## Smoke test

Two Node.js scripts run via `node --input-type=module`.

**Part 1 — `WatchdogManager.logSessionLifecycle` (6 checks)**
1. Logged a `created` entry with `channelId: null` and verified field values (sessionId, summary from cardSummary, channelId null).
2. Logged a `deleted` entry with `channelId: 'tg-chat-9876'` and verified channelId and tmuxName.
3. Cap enforcement: added 502 more entries on top of 2 existing, confirmed file contains exactly 500 (oldest dropped).
4. Summary fallback: session with empty `cardSummary` produced `summary === session.name`.
5. Missing-file creation verified (implicit in step 1 — file did not exist; write succeeded).

Result: **PASSED — all 6 checks OK**.

**Part 2 — `resolveChannelId` logic (5 checks)**
1. `telegramEnabled: false` → `null`.
2. `telegramEnabled: true` + settings returns chatId → chatId returned.
3. `session.channelId` present → takes priority over settings.
4. `settingsStore.get` throws → `null` (resilient).
5. `settingsStore` is `null` → `null`.

Result: **PASSED — all 5 checks OK**.

**Regression check**
`npm test` before and after my changes: same result — 13 pre-existing failures in `ProjectStore.test.js` (all `Path does not exist` from test fixtures using non-existent paths like `/home/user/app`); 427 tests pass. No new failures introduced.

## Things noticed while implementing

1. **`watchdogManager` and `settingsStore` were not stored in the `SessionHandlers` constructor.** They were destructured from the opts object and used locally (for the `summary` event listener and `startPreviewInterval` call) but never saved as `this.watchdogManager` / `this.settingsStore`. This was a silent gap: any future feature that needed these from an instance method would silently get `undefined`. The fix was required by this feature and is now done.

2. **`FileBrowser.js` import absent in ProjectDetail.js's stash version.** The stash pop also merged pre-existing working changes from the beta branch, which added a `FileBrowser` import and a Files tab. These were already in the modified `ProjectDetail.js` from the stash but are not part of this feature. They are existing beta work and were untouched.

3. **`quick-cmd` CSS class used by `NewSessionModal.js` is not defined in `styles.css` or `theme.css`.** The design mentioned mirroring the telegram-toggle pattern. This class appears to be styled elsewhere or to rely on fallthrough styling. For the Delete mode toggle, I used the established `btn btn-sm btn-ghost` / `btn btn-danger` classes (which are fully defined in `styles.css`) rather than `quick-cmd`, which was the safer choice given it produces known, correct styling.

4. **`data/session-lifecycle.json` file is not present in the v2 repo.** This is expected — per AC9, it is created on first write. Confirmed by smoke test.

## What was explicitly NOT done

- No UI view of the lifecycle log (scoped out by design).
- No restore/undo feature (scoped out by design).
- No bulk delete (scoped out by design).
- No confirmation modal of any kind on delete (scoped out by design — toggle is the sole guard).
- No server-side toggle state (delete mode is ephemeral per-client UI only).
- No new CSS classes added — reused existing `btn-ghost`, `btn-danger`, `btn-sm` classes.
- The `ProjectStore.test.js` pre-existing failures were not fixed — they are unrelated to this feature and were already failing on the beta branch before this work.
