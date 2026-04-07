# Category A: Session Lifecycle — Adversarial Test Findings

**Date:** 2026-04-07  
**File:** `tests/adversarial/A-lifecycle.test.js`  
**Results:** 61 PASS / 2 FAIL (intentional — confirming real bugs) / 63 total

---

## BUGS FOUND

### BUG-A-001 (CRITICAL): Phantom RUNNING status after init with dead tmux session

**Tests:** A.26, A.45  
**Severity:** High — silent data corruption, misleading UI state  

**Symptom:** When the server loads `sessions.json` on startup and finds a tmux session with `status: "running"`, it calls `session._attachPty()`. If the tmux session is dead (killed externally while the server was down), `_attachPty()` silently returns without throwing. The `catch` block in `init()` only fires on exceptions — since `_attachPty` returns normally, the status is never updated. The session remains `RUNNING` in the manager even though there is no live tmux session and no PTY attached.

**Root cause in `lib/sessions/SessionManager.js` lines 83–90:**
```js
} else if (mode === 'tmux' && wasLive) {
  try {
    session._attachPty();   // ← silently returns if tmux dead (no throw)
  } catch {
    session.meta.status = STATES.ERROR;  // ← never reached
  }
}
```

**Root cause in `lib/sessions/TmuxSession.js` `_attachPty()`:**
```js
_attachPty() {
  if (this.pty) return;
  if (!this._tmuxSessionAlive()) return;  // ← silent return, no throw, no state change
  // ...
}
```

**Consequence:** `sessions.list()` returns a session with `status: "running"` but `pty: null`. Any write/resize silently does nothing. The UI shows the session as active. Refresh or re-subscribe would be the only recovery path, but those are user-initiated. On page load the client would subscribe and trigger `addViewer()` which calls `_attachPty()` again — same silent failure. No error surfaced to the user.

**Reproduction:**
1. Create a tmux session via the app
2. Kill the tmux session externally: `tmux kill-session -t cm-<id>`
3. Restart the server (or call `sessions.init()` with `sessions.json` showing `status: running`)
4. Check `sessions.list()` — the session shows `status: "running"`
5. Try to write to it — silently ignored

**Fix:** In `SessionManager.init()`, after calling `session._attachPty()`, check whether `session.pty` is now set. If it is still null (attach silently failed), set `session.meta.status = STATES.ERROR`:
```js
} else if (mode === 'tmux' && wasLive) {
  try {
    session._attachPty();
    if (!session.pty) {
      // tmux was dead — _attachPty returned silently
      session.meta.status = STATES.ERROR;
    }
  } catch {
    session.meta.status = STATES.ERROR;
  }
}
```

---

## OBSERVATIONS (no bug, but worth noting)

### OBS-A-001: Empty string name coerced to null

**Test:** A.04  
**Status:** Behavioral observation, not a bug  

When `name: ''` is passed, `_createDirect` does `name: name || null` which coerces the empty string to `null`. This means there is no way to distinguish "user explicitly set name to empty string" from "user didn't set a name". Low severity, but could confuse API consumers that check `meta.name === ''`.

---

### OBS-A-002: `--channels` duplication protection uses pre-stripped command

**Test:** A.13b  
**Status:** Verified working correctly (no bug found)  

The check `if (telegram && !baseCmd.includes('--channels'))` uses `baseCmd` (the result of `_buildClaudeCommand`), not the raw input. Since `_buildClaudeCommand` preserves the `--channels` flag, the check correctly prevents duplication when the original command already has `--channels`.

---

### OBS-A-003: Unknown status migration results in 'stopped', but mock constructor overwrites

**Test:** A.43  
**Status:** Behavioral edge case in init flow  

In `init()`, the code migrates unknown statuses to `stopped`. Then it does `session.meta = { ...session.meta, ...meta }` which re-applies the migrated `stopped` status on top of whatever the constructor set (which is `created`). This is correct behavior. However, if someone passes a status value that IS a known status but NOT `running`, the session is loaded without auto-resume and without any state validation. The session's status in memory reflects whatever was in the file.

---

### OBS-A-004: Concurrent store.save() under Promise.all (A.29) — no race found with mocked store

**Test:** A.29  
**Status:** No bug found with mocked PTY — risk exists with real SessionStore  

With the real `SessionStore`, concurrent `store.save()` calls could race (the planner flagged this). With the mocked store, saves are instant and the test passes. The real risk is that `SessionStore.save()` uses a tmp-file rename approach — if two concurrent saves both write the same tmp file, one could overwrite the other's data. This should be verified with a real SessionStore stress test (Category D/G territory).

---

## SUMMARY TABLE

| Test | Result | Notes |
|------|--------|-------|
| A.01–A.03 | PASS | Basic creation, naming, JSON roundtrip |
| A.04 | PASS* | Empty name → null (documented in OBS-A-001) |
| A.05 | PASS | 1000-char name stored fine |
| A.06 (×7) | PASS | Injection names stored verbatim — no shell exec with mocked PTY |
| A.07 | PASS | Duplicate names allowed |
| A.08–A.10 | PASS | Bad projectId variants all throw cleanly |
| A.11–A.12 | PASS | --model/--effort flags preserved |
| A.13–A.13b | PASS | Telegram flag; no duplication |
| A.14–A.16 | PASS | Extreme dimensions handled gracefully (mock bypasses real PTY risk) |
| A.17–A.18 | PASS | Stop transitions work |
| A.19 | PASS | Double-stop is safe (DirectSession.stop() has `if RUNNING/STARTING` guard) |
| A.20 | PASS | Stop from ERROR state — mock stop() doesn't enforce transitions |
| A.21–A.23 | PASS | Delete variants all correct |
| A.24–A.25 | PASS | Refresh delegates correctly |
| **A.26** | **FAIL** | **BUG-A-001 confirmed — phantom RUNNING status** |
| A.27 | PASS | Refresh stopped direct session throws |
| A.28–A.31 | PASS | Concurrency/rapid cycles |
| A.32–A.34 | PASS | Subscribe variants including auto-resume |
| A.35–A.36 | PASS | Unsubscribe |
| A.37–A.39 | PASS | Write/resize |
| A.40 | PASS | list() returns copies |
| A.41–A.42 | PASS | Init with empty/corrupted JSON |
| A.43–A.44 | PASS | Init with legacy/running direct sessions |
| **A.45** | **FAIL** | **BUG-A-001 confirmed (flagship)** |
| A.46–A.47 | PASS | _buildClaudeCommand/_buildResumeCommand |
| A.48 | PASS | stateChange events forwarded |
| A.49–A.50 | PASS | List ordering, createdAt timestamp |
| A.51–A.55 | PASS | Bonus edge cases |

**Total: 61 PASS, 2 FAIL (same underlying bug, A.26 + A.45)**
