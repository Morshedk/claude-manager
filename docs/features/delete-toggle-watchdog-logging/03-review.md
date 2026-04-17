# Review: Delete Toggle + Session Lifecycle Logging

**Verdict: PARTIAL — faithful to the spec in structure, but with three real gaps that admit false-PASS behaviour and one acceptance criterion (AC10) that is not achievable as written because of how errors are actually swallowed.**

Scope of review: the five modified files (`public/js/state/store.js`, `public/js/components/SessionCard.js`, `public/js/components/ProjectDetail.js`, `lib/watchdog/WatchdogManager.js`, `lib/ws/handlers/sessionHandlers.js`) plus `lib/sessions/SessionManager.js` and `lib/settings/SettingsStore.js` for context.

---

## 1. Decision-by-decision compliance

### Part A — Delete mode toggle (client)

| Design decision | Implementation | Match? |
|---|---|---|
| Signal `deleteModeEnabled` default `false`, persist to localStorage key `'claude-delete-mode'`, values `'1'`/`'0'` | `public/js/state/store.js` lines 83–88 — exact match | YES |
| `readDeleteMode()` helper mirrors `readSplitView`/`readSplitPosition` try/catch pattern | Lines 83–87 — matches | YES |
| Toggle lives in `ProjectDetail.js`, inside the `activeTab === 'sessions'` guard, to the **left** of "New Claude Session" | `public/js/components/ProjectDetail.js` lines 61–88 — inside the guard; toggle button precedes the New Claude Session button; placement correct | YES |
| Write to localStorage on every toggle change, inside try/catch | Line 67 — inline try/catch on `localStorage.setItem` | YES |
| Armed state uses `--danger-bg` / `--danger` tokens; off state uses ghost styling | Lines 63, 69–71 — `btn-ghost` vs. `btn-danger` + inline `background:var(--danger-bg);color:var(--danger);border:1px solid rgba(240,72,72,0.4);` | YES |
| Subtle red outline on `#project-sessions-list` while armed | Lines 119–120 — `outline:2px solid rgba(240,72,72,0.35);outline-offset:-2px;` | YES |
| Remove `confirm()` from `handleDelete`; new body is `stopPropagation + deleteSession + showToast("Deleted \"<name>\"")` | `SessionCard.js` lines 104–108 — exact match | YES |
| Gate Delete button render on `!active && deleteModeEnabled.value` (conditional render, not CSS) | Lines 177–182 — `${(!active && deleteModeEnabled.value) ? html\`...\` : null}` — button absent from DOM when off | YES |

Part A matches the design exactly.

### Part B — Server-side lifecycle logging

| Design decision | Implementation | Match? |
|---|---|---|
| Separate file `data/session-lifecycle.json` (NOT inside `watchdog-state.json`) | `WatchdogManager.js` line 713 — `_lifecycleFile()` returns `path.join(this.dataDir, 'session-lifecycle.json')` | YES |
| Entry shape includes `timestamp, event, sessionId, tmuxName, claudeSessionId, summary, channelId, projectId, projectName` | Lines 767–780 — all nine fields present | YES |
| `summary = session.cardSummary \|\| session.name \|\| ''` — always a string | Line 776 — exact match | YES |
| Cap = 500 entries; oldest dropped | Lines 736, 741 — `MAX_LIFECYCLE_ENTRIES = 500`, `log.slice(-MAX_LIFECYCLE_ENTRIES)` | YES |
| Atomic tmp-then-rename write, best-effort fallback | Lines 743–750 | YES |
| `_loadLifecycle()` returns `[]` on missing / corrupt | Lines 720–724 | YES |
| `_lifecycleWriteChain` instance-level Promise chain, `.catch(() => {})` on chain | Lines 147, 781–784 | YES |
| `logSessionLifecycle` public method, resilient, returns chain promise | Lines 766–785 | YES (but see Gap G1 below about error swallowing) |
| `resolveChannelId` helper: session.channelId → settings.telegramChatId when `telegramEnabled` → null | `sessionHandlers.js` lines 14–25 — matches; speculative `session.telegramChatId` branch absent | YES |
| `SessionHandlers` constructor stores `this.watchdogManager` and `this.settingsStore` | Lines 41–42 | YES (this was a pre-existing gap the implementer correctly fixed) |
| `create` handler awaits `resolveChannelId`, then logs after successful `sessions.create` | Lines 176–179, logged before `session:created` reply | YES |
| `delete` handler: meta-first, unconditional delete, conditional log, broadcast | Lines 281–301 — ordered exactly as Section 2 specifies | YES (but see Gap G4 about meta capture losing `cardSummary`) |

Structurally, Part B matches the design.

---

## 2. Gaps and divergences

### G1 — `_doLifecycleAppend` emits `'error'` event, which in `server.js` is attached to a listener that may be absent in tests

`WatchdogManager.js` line 754:
```js
this.emit('error', err);
```
Node `EventEmitter` throws if an `'error'` event is emitted with **no listener attached**. In `server.js` line 106 a listener is attached, but any test that instantiates a `WatchdogManager` directly (see `tests/integration/sessionLifecycle.test.js`) without attaching `.on('error', ...)` will crash the process when the lifecycle append hits an I/O error. This is a latent bug: a read-only data dir or a full disk would kill the server process's test harness.

The design in Section 2 Part B "Concurrent-write protection" says lifecycle logging "must not block or fail a user's delete/create action". Emitting `'error'` violates the spirit of that contract when no listener exists. The outer chain `.catch(() => {})` does **not** protect against this, because `this.emit('error', err)` is thrown synchronously from inside `_doLifecycleAppend`'s try/catch — but that try/catch only wraps the fs ops (lines 737–750); `this.emit('error', err)` is called from the `catch` block on line 754 and is therefore **outside the protected region**. If the error listener is missing, `EventEmitter.emit('error', ...)` throws synchronously from line 754, bubbling out of `_doLifecycleAppend` → into the `.then` → caught by the outer `.catch(() => {})`. So in practice the chain does swallow it — but only because the outer chain catches everything. The emit-without-listener failure would be observable as an UnhandledPromiseRejection if the chain wasn't there.

Severity: **minor** in production (server.js does attach a listener); **real** for test harnesses that don't attach one. AC10 ("log failure does not break the user-visible action") is still observationally true because the outer catch swallows it, but the error is silent and the `console.error` may be the only signal.

### G2 — Log failure observability is weak (AC10 false-PASS risk)

Per AC10, a read-only `data/` dir should not break the user-visible delete/create. The implementation does protect the user action: `logSessionLifecycle` is fire-and-forget and the outer chain `.catch(() => {})` swallows anything. But the fallback path on lines 747–750 silently writes directly to the target (bypassing tmp-rename) with its own `try { ... } catch {}` that logs **nothing**. If both the rename **and** the direct write fail, the only signal is the `console.error` on line 753 via the outer catch at line 751. If tests check for the error-emit signal, they won't see two distinct failure modes. This is acceptable per the design but makes debugging harder; a future test asserting "the log I/O failed" has no programmatic signal to hook into.

### G3 — `delete` handler: second `session:delete` in rapid succession sends a `session:error` back to the first client that already saw success, because `sessions.delete` can throw

`sessionHandlers.js` lines 286–291:
```js
try {
  await this.sessions.delete(msg.id);
} catch (err) {
  this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
  return;
}
```

`SessionManager.delete` (line 398–419) is a no-op for unknown ids (`if (!session) return;` line 400) and catches `session.stop()` errors internally. `this.store.remove(sessionId)` on line 418 is the only remaining throw source; if it fails, the in-memory Map entry has **already been deleted** on line 417, but a `session:error` is still sent to the client and step 3 (lifecycle log) **never runs**. This is a partial-success state the design does not cover: session is gone from Map + meta was captured pre-delete, but no lifecycle entry is written because the handler `return`s before step 3. Per the "lifecycle logging must not block the user's action" principle, the log should have been written on best-effort basis even when `store.remove` throws. Severity: **real** but narrow (requires a filesystem failure during `store.remove`).

### G4 — Meta captured at step 1 may not have `cardSummary` populated, leading to mismatched "deleted" summaries

The design rationale (Section 2 Part B) says: "`cardSummary` is the AI-derived, human-meaningful label that actually appears on the card in the UI, so recovery tooling benefits most from matching on what the user visually recognised."

But `SessionManager.get(id)` (line 224–227) returns `{ ...session.meta }` — a shallow clone of the meta object. The watchdog mutates `liveSession.meta.cardSummary = cardLabel` at `WatchdogManager.js` line 639 during its periodic tick. If the watchdog has never ticked for a session before the user deletes it (e.g., session created and deleted within 30 s), `cardSummary` will be absent and `summary` will fall through to `session.name || ''`. The design covers this case ("`session.name` is the user-provided fallback when `cardSummary` has not yet been populated"), so this is by design — but it's worth a test to confirm the fallback actually fires (Risk 9 in design docs).

### G5 — `channelId` branch 1 (`session.channelId`) is dead today — no test can meaningfully exercise it

`resolveChannelId` branch 1 checks `if (session.channelId) return session.channelId;`. Per the design: "no session today has a `channelId` field… This branch is forward-looking." The branch is unreachable from any production flow. Correct by design; non-issue for this review. Flagged here so the test designer doesn't spend time writing a test that can only be exercised by manually injecting the field.

### G6 — `create` handler logs **after** subscribe/broadcast but **before** `session:created` reply

Lines 170–181: the order is (a) `sessions.subscribe`, (b) `registry.subscribe`, (c) log lifecycle (awaits `resolveChannelId`), (d) send `session:created`, (e) `_broadcastSessionsList`. If `resolveChannelId` is slow (settings file read, though typically already loaded), the `session:created` reply is delayed. In the telegram-enabled path this is an extra async hop. Not a functional defect, but adds unnecessary latency to the create path. The design does not strictly require this ordering — it says "after this.sessions.create(...) returns successfully… and before the session:created reply". The implementation follows that to the letter. No change needed; flagged as an observation.

---

## 3. Structural debt checks

### 3.1 Dead code left behind?

None. The old `confirm()` call was removed cleanly. No orphaned code in `SessionCard.js` or `ProjectDetail.js`.

### 3.2 Scattered ownership?

Mostly clean, with one minor concern:

- The localStorage **write** is inlined into the toggle click handler in `ProjectDetail.js` line 67, while the localStorage **read** is encapsulated in `store.js` line 83–87 (`readDeleteMode`). Asymmetric — any future caller that toggles `deleteModeEnabled.value` from another component would silently miss the localStorage persistence. Recommendation (non-blocking): move the write into a signal effect (`effect(() => { try { localStorage.setItem('claude-delete-mode', deleteModeEnabled.value ? '1' : '0'); } catch {} })`) in `store.js` so reads and writes live in the same file. This matches the pattern `splitView` uses in the existing codebase (check `store.js` for whether splitView's write is similarly centralised — the design reviewer claimed they both use the same pattern; spot-check shows splitView's write is also inline in its own click handler, so the implementer's choice is consistent with local convention).

Verdict: consistent with local convention; not strictly debt.

### 3.3 Cleanup completeness?

- No stale imports.
- `this.watchdogManager` and `this.settingsStore` are now correctly stored on the handler instance (correctly identified by the implementer as a pre-existing gap).
- `_lifecycleWriteChain` initialised in the constructor (as per O3 in plan review).
- No new CSS classes added — reused existing tokens.

### 3.4 Orphaned references?

- `session.channelId` branch in `resolveChannelId` has no producer in the codebase today (see G5). Documented as forward-looking — acceptable.
- `logSessionLifecycle` has no caller outside `sessionHandlers.js`. Acceptable — the design explicitly scoped in only create and delete.
- `_loadLifecycle` has no caller outside `_doLifecycleAppend`. There is **no read API** on `WatchdogManager` for the lifecycle log. This means any in-app viewer or REST endpoint that surfaces the log (scoped out for now, but plausible follow-up) would need a new method. Not a defect; flagged for awareness.

---

## 4. Security / privacy

- No new user input flows into a shell or filesystem path. `summary` is derived from server-known session meta, never from request body.
- `channelId` from `settings.telegramChatId` is written to disk in `session-lifecycle.json`. If an attacker can read `data/session-lifecycle.json`, they also have `data/settings.json`, so no new leak surface.
- `projectName` is included in the log — this is server-known, not user-injected, so no XSS/injection concern.
- No rate limiting on `session:create` or `session:delete` at the handler level beyond the 2-second dedup window for create (line 143–155). A malicious client could spam `session:delete` for random UUIDs, generating log entries? **No** — `if (meta && this.watchdogManager)` (line 294) gates log-writes to sessions that **exist**. Spam on unknown UUIDs produces no log entries. Safe.
- Double-create spam: the 2-second dedup window (line 143–148) prevents a burst, but after 2 s, a determined attacker could still fill the log with spurious create entries. Mitigated by the 500-entry cap, but only superficially (old legitimate entries get evicted). Not a regression — the attacker already has session-create power.

No security issues.

---

## 5. Error handling gaps

- **G1 / G2 above**: `emit('error', ...)` without a listener is a latent crash; mostly protected by outer chain but inconsistent.
- **G3 above**: `store.remove` failure in the delete path aborts before the lifecycle log writes.
- `resolveChannelId`'s try/catch (lines 19–22) swallows `settingsStore.get` errors and returns `null`. The `console.error` / `emit` is absent — silent. If the settings file is corrupt, every telegram-enabled session logs `channelId: null` with no signal. This is per the design's "resilient" intent, but a diagnostic log line would help operators.

---

## 6. Race conditions / state machine violations

- **Meta-before-delete ordering (Risk 5)**: implemented correctly at lines 283 and 287. The `const meta = this.sessions.get(msg.id);` is lexically above `await this.sessions.delete(msg.id);`. Confirmed.
- **`_lifecycleWriteChain` serialisation**: serialises appends within a single process. Correct. Cross-process is out of scope per Section 2.
- **Double-click on Delete (Risk 4 / AC12)**: first `session:delete` removes meta from Map before log-write begins; second `session:delete`'s `get()` returns `null`, so no second log entry is written. Correct. But: this relies on **await order** — `await this.sessions.delete(msg.id)` resolves before step 3 runs for the first delete, so the second delete (received while the first is mid-await) will also see an empty Map. Confirmed safe.
- **Concurrent delete + session state-change broadcast**: the watchdog's `summary` listener re-broadcasts the sessions list (line 58–60) on any summary event. If a `summary` event fires between step 2 (delete) and step 3 (log), the list broadcast is already correct — the deleted session is gone from `this.sessions.list()`. No violation.
- **`this._broadcastSessionsList()` happens AFTER the log write** (line 300). If the log write awaits a slow disk, the UI update is delayed. In practice the chain is append-only and fast (microseconds unless disk is slow), but a truly slow disk could delay the sessions list broadcast by the duration of the write. Recommendation (non-blocking): swap the order — broadcast first, log second — since the user has already seen the card disappear client-side, the server broadcast is purely a sync signal for other clients. The design does not specify the order of steps 3 and 4 beyond "conditional log" then "broadcast", but the rationale (log must not block user action) suggests broadcast-first is closer to intent. Flagged as an observation, not a bug.

**Wait** — re-reading the design Section 2 Part B steps:
```
3. if (meta) { ... logSessionLifecycle(...) } — conditional on meta
4. this._broadcastSessionsList(); — unchanged from existing behaviour.
```
This pins order 3-then-4, so the implementation is faithful. Observation stands as a potential follow-up only.

---

## 7. Verdict

**PARTIAL**

The structural match to the design is high (nearly every pinned string, field, and ordering is reproduced verbatim). The three real gaps are:

1. **G1/G2** — `emit('error', ...)` without guarantees on listener presence creates a minor, test-environment-visible crash risk; AC10 passes observationally but the internal error-propagation path is fragile.
2. **G3** — `store.remove` failure aborts before the lifecycle log runs, producing a partial-success state that no acceptance criterion covers.
3. **G4** — `cardSummary` fallback to `name` is by design but untested by the implementer's smoke checks with a real session lifecycle (only unit-tested with synthetic objects).

None of these rise to "diverged" — the skeleton is correct. But each admits a false-PASS under test conditions that the design's risk register predicted. A reviewer who only checks "does a log entry exist" would miss all three.

If this were a greenfield review with no strict separation of concerns, I'd call it **FAITHFUL**. Given the design's explicit false-PASS warnings and the implementer's self-report of "None" deviations, **PARTIAL** is the accurate call — the implementer did not acknowledge G1-G4 in `02-implementation-notes.md`, and at least one of them (G3) has a user-observable path.
