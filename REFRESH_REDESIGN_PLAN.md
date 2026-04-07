# Refresh Redesign Implementation Plan

Target design: `/home/claude-runner/apps/claude-web-app/docs/refresh-redesign.md`

---

## Phase 1: State machine (no dependent code yet)

### File: `lib/sessions/sessionStates.js`

1. Remove `SHELL: 'shell'` from the `STATES` object.
2. Remove the `[STATES.SHELL]` entry from `TRANSITIONS`.
3. Remove `STATES.SHELL` from the `[STATES.RUNNING]` allowed-transitions array.
   - `RUNNING` transitions become: `[STATES.STOPPING, STATES.ERROR, STATES.STOPPED]`

**Before:**
```js
export const STATES = {
  CREATED: 'created',
  STARTING: 'starting',
  RUNNING: 'running',
  SHELL: 'shell',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
};

export const TRANSITIONS = {
  [STATES.CREATED]:  [STATES.STARTING],
  [STATES.STARTING]: [STATES.RUNNING, STATES.ERROR, STATES.STOPPED],
  [STATES.RUNNING]:  [STATES.SHELL, STATES.STOPPING, STATES.ERROR, STATES.STOPPED],
  [STATES.SHELL]:    [STATES.RUNNING, STATES.STOPPING, STATES.STOPPED],
  [STATES.STOPPING]: [STATES.STOPPED, STATES.ERROR],
  [STATES.STOPPED]:  [STATES.STARTING],
  [STATES.ERROR]:    [STATES.STARTING],
};
```

**After:**
```js
export const STATES = {
  CREATED: 'created',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
};

export const TRANSITIONS = {
  [STATES.CREATED]:  [STATES.STARTING],
  [STATES.STARTING]: [STATES.RUNNING, STATES.ERROR, STATES.STOPPED],
  [STATES.RUNNING]:  [STATES.STOPPING, STATES.ERROR, STATES.STOPPED],
  [STATES.STOPPING]: [STATES.STOPPED, STATES.ERROR],
  [STATES.STOPPED]:  [STATES.STARTING],
  [STATES.ERROR]:    [STATES.STARTING],
};
```

---

## Phase 2: TmuxSession — remove `_tmuxRunningClaude`, remove SHELL, rename restart to refresh, change alive-path logic

### File: `lib/sessions/TmuxSession.js`

#### 2a. Remove `_tmuxRunningClaude()` method entirely (lines 258-268)

Delete the entire method.

#### 2b. Update state-transition comment at top of class (line 16-18)

**Before:**
```
 *   CREATED -> STARTING -> RUNNING -> SHELL -> STOPPED
 *                                  -> STOPPED
```

**After:**
```
 *   CREATED -> STARTING -> RUNNING -> STOPPED
```

#### 2c. Remove SHELL from `write()` (lines 129-132)

**Before:**
```js
if (
  this.meta.status !== STATES.RUNNING &&
  this.meta.status !== STATES.SHELL
) return;
```

**After:**
```js
if (this.meta.status !== STATES.RUNNING) return;
```

#### 2d. Remove SHELL from `addViewer()` (lines 161-164)

**Before:**
```js
if (!this.pty && (
  this.meta.status === STATES.RUNNING ||
  this.meta.status === STATES.SHELL
)) {
```

**After:**
```js
if (!this.pty && this.meta.status === STATES.RUNNING) {
```

#### 2e. Rename `restart()` to `refresh()` and rewrite the alive-path logic (lines 185-232)

The current code uses `respawn-pane -k` which kills Claude. The new logic:

- **Tmux alive path:** Detach PTY (kill it) then re-attach (call `_attachPty()`). tmux replays scrollback naturally. No `respawn-pane`. No state transition needed (stay RUNNING).
- **Tmux dead path:** Create a new tmux session with `--resume`. This is a full re-creation. Transition STOPPED -> STARTING -> RUNNING.

**New `refresh()` method:**
```js
/**
 * Refresh the client's connection to this session.
 *
 * Tmux alive: detach PTY, re-attach (tmux natural replay).
 * Tmux dead:  create new tmux session with --resume.
 *
 * @param {string} claudeCmd  — resume command (e.g. "claude --resume <id>")
 * @param {object} authEnv
 * @param {{ cols?: number, rows?: number }} [opts]
 */
async refresh(claudeCmd, authEnv = {}, { cols, rows } = {}) {
  if (cols) this._cols = cols;
  if (rows) this._rows = rows;

  if (this._tmuxSessionAlive()) {
    // ── Tmux alive path: detach + re-attach ──
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }
    this._attachPty();
    // Stay in current state (RUNNING). Emit stateChange so clients know
    // to reset their xterm buffer.
    this.emit('stateChange', { id: this.meta.id, state: this.meta.status });
    return;
  }

  // ── Tmux dead path: recreate tmux session with --resume ──
  // Reset state so start() transition is legal
  if (this.meta.status !== STATES.STOPPED && this.meta.status !== STATES.ERROR) {
    this.meta.status = STATES.STOPPED;
  }
  await this.start(claudeCmd, authEnv);
}
```

Key differences from old `restart()`:
- No `respawn-pane -k`.
- No `STATES.SHELL` checks.
- Alive path is pure detach/re-attach.
- Dead path delegates to `start()` (which creates new tmux session).

#### 2f. Update `_wirePty()` onExit handler (lines 321-339)

Remove the `_tmuxRunningClaude()` check that transitions to SHELL. When the PTY exits and tmux is alive, just stay in current state (PTY detached but tmux still running is normal). When tmux is dead, transition to STOPPED.

**Before:**
```js
this.pty.onExit(() => {
  this.pty = null;
  if (
    this.meta.status === STATES.RUNNING ||
    this.meta.status === STATES.SHELL
  ) {
    if (!this._tmuxSessionAlive()) {
      this._setState(STATES.STOPPED);
      this.store.upsert(this.meta).catch(() => {});
    } else if (!this._tmuxRunningClaude()) {
      this._setState(STATES.SHELL);
      this.store.upsert(this.meta).catch(() => {});
    }
  }
});
```

**After:**
```js
this.pty.onExit(() => {
  this.pty = null;
  if (this.meta.status === STATES.RUNNING) {
    if (!this._tmuxSessionAlive()) {
      this._setState(STATES.STOPPED);
      this.store.upsert(this.meta).catch(() => {});
    }
    // If tmux alive, PTY just detached — stay RUNNING
  }
});
```

---

## Phase 3: DirectSession — add refresh(), add auto-resume on subscribe

### File: `lib/sessions/DirectSession.js`

#### 3a. Add a `refresh()` method

The design says: Claude running -> kill PTY, spawn new with `--resume`. Claude exited -> throw (no recovery).

The `_buildArgs` method currently falls back to `--session-id` when no conversation file exists. Per the design, refresh should throw if no conversation file. However, `_buildArgs` is used by both `start()` and implicitly by refresh. We should add validation in refresh itself.

**New method (add after `stop()`):**
```js
/**
 * Refresh: kill current PTY and re-spawn with --resume.
 * Only works when PTY is alive (RUNNING state).
 * Throws if no conversation file exists (nothing to resume).
 *
 * @param {object} authEnv
 * @returns {Promise<void>}
 */
async refresh(authEnv = {}) {
  if (this.meta.status !== STATES.RUNNING) {
    throw new Error(
      `Cannot refresh direct session "${this.meta.id}": status=${this.meta.status}, no recovery path`
    );
  }

  // Verify conversation file exists before killing anything
  if (this.meta.claudeSessionId && !this._claudeSessionFileExists(this.meta.claudeSessionId)) {
    throw new Error(
      `Cannot refresh: no conversation file for session ${this.meta.claudeSessionId}`
    );
  }

  // Kill existing PTY
  if (this.pty) {
    try { this.pty.kill(); } catch { /* ignore */ }
    this.pty = null;
  }

  // Reset state so assertTransition allows STARTING
  this.meta.status = STATES.STOPPED;

  // Re-start (will use --resume since conversation file exists)
  await this.start(authEnv);
}
```

#### 3b. No changes to `_buildArgs` needed

The existing `_buildArgs` correctly picks `--resume` when a conversation file exists. The `refresh()` method validates the file exists before proceeding, so `_buildArgs` will always pick `--resume` on the refresh path.

---

## Phase 4: SessionManager — rename restart to refresh, add direct subscribe auto-resume

### File: `lib/sessions/SessionManager.js`

#### 4a. Remove all STATES.SHELL references

Three locations:
1. **Line 68** (`init()` auto-resume): Change `meta.status === STATES.SHELL` to just check `STATES.RUNNING`.
   ```js
   // Before
   const wasLive = meta.status === STATES.RUNNING || meta.status === STATES.SHELL;
   // After
   const wasLive = meta.status === STATES.RUNNING;
   ```

2. **Line 336** (`delete()` isLive check): Remove `STATES.SHELL`.
   ```js
   // Before
   const isLive =
     session.meta.status === STATES.RUNNING ||
     session.meta.status === STATES.STARTING ||
     session.meta.status === STATES.SHELL;
   // After
   const isLive =
     session.meta.status === STATES.RUNNING ||
     session.meta.status === STATES.STARTING;
   ```

#### 4b. Rename `restart()` to `refresh()` and update logic

**Before (lines 300-322):**
```js
async restart(sessionId, { cols, rows } = {}) { ... }
```

**After:**
```js
/**
 * Refresh a session's client connection.
 * Tmux: delegates to TmuxSession.refresh().
 * Direct: delegates to DirectSession.refresh().
 * @param {string} sessionId
 * @param {{ cols?: number, rows?: number }} [opts]
 * @returns {Promise<object>} updated session meta
 */
async refresh(sessionId, { cols, rows } = {}) {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const authEnv = this._buildAuthEnv();

  if (session.meta.mode === 'tmux') {
    const claudeCmd = this._buildResumeCommand(session);
    await session.refresh(claudeCmd, authEnv, { cols, rows });
  } else {
    await session.refresh(authEnv);
  }

  await this.store.save(this.sessions);
  return { ...session.meta };
}
```

#### 4c. Add direct subscribe auto-resume

Modify `subscribe()` to auto-call `refresh()` for direct sessions with no active PTY:

**Before (lines 233-236):**
```js
async subscribe(sessionId, clientId, callback) {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  session.addViewer(clientId, callback);
}
```

**After:**
```js
async subscribe(sessionId, clientId, callback) {
  const session = this.sessions.get(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  session.addViewer(clientId, callback);

  // Direct session auto-resume: if PTY is gone but session was running,
  // automatically refresh so browser page refresh reconnects seamlessly.
  if (
    session.meta.mode === 'direct' &&
    !session.pty &&
    (session.meta.status === STATES.STOPPED || session.meta.status === STATES.ERROR)
  ) {
    try {
      const authEnv = this._buildAuthEnv();
      await session.refresh(authEnv);
    } catch (err) {
      // Auto-resume failed — not fatal, session just stays stopped
      console.warn(`[SessionManager] auto-resume failed for ${sessionId}:`, err.message);
    }
  }
}
```

#### 4d. Update `_buildResumeCommand()` for refresh

The existing `_buildResumeCommand` falls back to `--session-id` when no conversation file exists. Per the design, refresh should always use `--resume`. Change the method:

**Before (line 443-444):**
```js
const hasConversation = this._claudeSessionFileExists(cwd, claudeSessionId);
const flag = hasConversation ? '--resume' : '--session-id';
```

**After:**
```js
// For refresh, always use --resume. If no conversation file exists,
// the tmux dead path still creates a new session — Claude handles
// --resume gracefully for new session IDs.
const flag = '--resume';
```

#### 4e. Remove `forceResume()` method (lines 355-375)

This method is superseded by `refresh()`. Remove it entirely. (If any callers exist, they should be updated to use `refresh()`.)

---

## Phase 5: WS handler — rename session:restart to session:refresh

### File: `lib/ws/handlers/sessionHandlers.js`

#### 5a. Rename the `restart()` method to `refresh()`

The MessageRouter dispatches based on the action suffix of the message type. A message `{ type: 'session:refresh' }` will call `this.sessionHandlers['refresh']()`. So the method name must be `refresh`.

**Before (lines 144-160):**
```js
async restart(clientId, msg) {
  try {
    const session = await this.sessions.restart(msg.id, {
      cols: msg.cols,
      rows: msg.rows,
    });
    this.registry.send(clientId, { type: 'session:restarted', session });
  } catch (err) { ... }
}
```

**After:**
```js
/**
 * session:refresh — refresh a session's connection.
 * @param {string} clientId
 * @param {{ type: string, id: string, cols?: number, rows?: number }} msg
 */
async refresh(clientId, msg) {
  try {
    const session = await this.sessions.refresh(msg.id, {
      cols: msg.cols,
      rows: msg.rows,
    });
    this.registry.send(clientId, { type: 'session:refreshed', session });
  } catch (err) {
    this.registry.send(clientId, { type: 'session:error', id: msg.id, error: err.message });
    return;
  }
  this._broadcastSessionsList();
}
```

Note: response type changes from `session:restarted` to `session:refreshed`.

---

## Phase 6: Client — protocol, actions, components

### File: `public/js/ws/protocol.js`

Change:
```js
SESSION_RESTART: 'session:restart',
```
to:
```js
SESSION_REFRESH: 'session:refresh',
```

### File: `public/js/state/actions.js`

Rename `restartSession` to `refreshSession` and update the message type:

**Before (line 89-91):**
```js
export function restartSession(sessionId) {
  send({ type: CLIENT.SESSION_RESTART, id: sessionId });
}
```

**After:**
```js
export function refreshSession(sessionId) {
  send({ type: CLIENT.SESSION_REFRESH, id: sessionId });
}
```

### File: `public/js/state/sessionState.js`

Update the handler for the response message:

**Before (line 99-101):**
```js
on('session:restarted', (msg) => {
  if (msg.session) upsertSession(msg.session);
});
```

**After:**
```js
on('session:refreshed', (msg) => {
  if (msg.session) upsertSession(msg.session);
});
```

### File: `public/js/components/SessionCard.js`

1. **Import:** Change `restartSession` to `refreshSession` (line 5).
2. **Handler (line 80-84):**
   ```js
   // Before
   function handleRestart(e) {
     e.stopPropagation();
     restartSession(session.id);
     showToast('Restarting session...', 'info');
   }
   // After
   function handleRefresh(e) {
     e.stopPropagation();
     refreshSession(session.id);
     showToast('Refreshing session...', 'info');
   }
   ```
3. **`getBadgeClass` (line 21):** Remove the `case 'shell':` line.
4. **`getBadgeLabel` (line 35):** Remove the `case 'shell':` line.
5. **`isActive` (line 47):** Remove `s === 'shell'` from the check.
   ```js
   // Before
   return s === 'running' || s === 'shell' || s === 'starting';
   // After
   return s === 'running' || s === 'starting';
   ```
6. **Button label (line 147):** Change `>Restart</button>` to `>Refresh</button>`.
7. **Button onClick (line 146):** Change `onClick=${handleRestart}` to `onClick=${handleRefresh}`.

### File: `public/js/components/SessionOverlay.js`

1. **Import (line 4):** Change `restartSession` to `refreshSession`.
2. **Handler (lines 23-26):**
   ```js
   // Before
   const handleRestart = () => {
     restartSession(session.id);
     showToast('Restarting session\u2026', 'info');
   };
   // After
   const handleRefresh = () => {
     refreshSession(session.id);
     showToast('Refreshing session\u2026', 'info');
   };
   ```
3. **Status color map (line 44):** Remove `shell: 'var(--accent)'` entry.
4. **isActive check (line 47):**
   ```js
   // Before
   const isActive = session.status === 'running' || session.status === 'shell';
   // After
   const isActive = session.status === 'running';
   ```
5. **Button (lines 125-131):** Change `handleRestart` to `handleRefresh`, label from `Restart` to `Refresh`, title from `"Restart session"` to `"Refresh session"`.

---

## Phase 7: Test updates

### File: `tests/unit/TmuxSession.test.js`

#### 7a. Remove `_tmuxRunningClaude()` test suite (lines 522-548)

Delete the entire `describe('TmuxSession -- _tmuxRunningClaude()')` block (3 tests).

#### 7b. Remove SHELL-related tests

- **`write() forwards data to PTY when SHELL`** (lines 292-300): Delete this test.
- **`calls tmux respawn-pane -k when SHELL`** (lines 409-420): Delete this test.
- **`transitions from SHELL to RUNNING after restart`** (lines 443-451): Delete this test.
- **`PTY exit with bash in pane -> transitions to SHELL`** (lines 601-618): Delete this test.

#### 7c. Rename restart test suite to refresh and update behavior

Rename `describe('TmuxSession -- restart()')` to `describe('TmuxSession -- refresh()')`.

Update these tests:

1. **`calls tmux respawn-pane -k when RUNNING`** -- Rewrite entirely:
   - The new behavior does NOT call `respawn-pane`. Instead, it kills the PTY and re-attaches.
   - New test: `'alive path: kills PTY and re-attaches (no respawn-pane)'`
   - Assert: `mockPtyKill` was called, `mockPtySpawn` was called (for re-attach), NO `respawn-pane` in any execSync call.

2. **`kills existing PTY before respawning`** -- Keep but rename to `'alive path: kills existing PTY before re-attach'`.

3. **`transitions back to RUNNING after restart`** -- Keep but update: call `refresh()` instead of `restart()`. Assert status remains RUNNING.

4. **`wraps command with exec bash so tmux stays alive`** -- Remove (no longer relevant; alive path doesn't run a command).

5. **`injects OAuth token in env prefix when provided`** -- Remove (alive path doesn't inject env; dead path delegates to `start()`).

6. **`throws when tmux session is dead`** -- Rewrite: dead path should call `start()` instead of throwing. Mock `start()` to verify it's called. OR: the dead path requires the session to be in STOPPED/ERROR state first, so if we test with RUNNING status and dead tmux, the method should reset to STOPPED and call start().

7. **`updates cols/rows when provided`** -- Keep, just call `refresh()` instead of `restart()`.

8. **Add new test:** `'dead path: resets state and calls start()'` -- Set status to RUNNING, make `_tmuxSessionAlive()` return false. Call `refresh(cmd, authEnv)`. Assert `start()` was called (need to spy or check that the tmux new-session execSync call happened).

#### 7d. Update `makeAlive` helper (lines 72-81)

Remove the `_tmuxRunningClaude` / `list-panes` mock logic from `makeAlive()`:
```js
// Before
function makeAlive(session) {
  mockExecSync.mockImplementation((cmd) => {
    if (typeof cmd === 'string' && cmd.includes('list-panes')) {
      return 'node\n';
    }
    return '';
  });
}
// After
function makeAlive(session) {
  mockExecSync.mockReturnValue('');
}
```

### File: `tests/unit/DirectSession.test.js`

#### 7e. Add refresh tests

Add a new `describe('DirectSession -- refresh()')` block:

1. **`refresh() kills PTY and re-starts when RUNNING`** -- Start session, then call `refresh(authEnv)`. Assert PTY was killed, session transitions through STARTING to RUNNING.

2. **`refresh() throws when not RUNNING`** -- Set status to STOPPED, call `refresh()`, assert it throws with "no recovery path".

3. **`refresh() throws when no conversation file exists`** -- Mock `_claudeSessionFileExists` to return false. Call `refresh()`, assert it throws with "no conversation file".

### File: `tests/integration/sessionLifecycle.test.js`

#### 7f. Rename restart tests

1. Rename `describe('Restart')` to `describe('Refresh')`.
2. Update the test to call `mgr.refresh()` instead of `mgr.restart()`.
3. Update the mock tmux session instance (in `beforeEach`) to have `refresh: jest.fn()` instead of `restart: jest.fn()`.
4. Update mock direct session instance: add a `refresh` mock method that stops then re-starts.
5. Update the full lifecycle test (line 605) to call `mgr.refresh()` instead of `mgr.restart()`.

#### 7g. Remove SHELL from state machine tests

- Remove test: `assertTransition allows running -> shell` (implicit; there's no explicit test for this but the SHELL entry is tested via TmuxSession tests).
- The `RUNNING -> RUNNING is not allowed` test stays (still true).

---

## Execution Order

To avoid broken intermediate states, apply changes in this order:

1. **Phase 1: sessionStates.js** -- Remove SHELL state. This will cause tests that reference SHELL to fail, but no runtime code is affected yet since the server isn't running tests.

2. **Phase 2: TmuxSession.js** -- Remove `_tmuxRunningClaude()`, all SHELL refs, rename `restart()` to `refresh()`, rewrite alive-path logic.

3. **Phase 3: DirectSession.js** -- Add `refresh()` method.

4. **Phase 4: SessionManager.js** -- Rename `restart()` to `refresh()`, remove SHELL refs, add auto-resume in `subscribe()`, update `_buildResumeCommand`, remove `forceResume()`.

5. **Phase 5: sessionHandlers.js** -- Rename handler method from `restart` to `refresh`, update response message type.

6. **Phase 6: Client files** -- Update protocol.js, actions.js, sessionState.js, SessionCard.js, SessionOverlay.js.

7. **Phase 7: Tests** -- Update all three test files to match the new API.

---

## Verification Steps

After all changes are applied:

1. **Run unit tests:**
   ```bash
   cd /home/claude-runner/apps/claude-web-app-v2 && npm test
   ```
   All tests must pass. Zero references to `SHELL`, `_tmuxRunningClaude`, `respawn-pane`, `restart` (in session context), or `session:restarted` should remain in test files.

2. **Syntax validation:**
   ```bash
   node -c lib/sessions/sessionStates.js && \
   node -c lib/sessions/TmuxSession.js && \
   node -c lib/sessions/DirectSession.js && \
   node -c lib/sessions/SessionManager.js && \
   node -c lib/ws/handlers/sessionHandlers.js
   ```
   (Client files are not CommonJS so skip `node -c` for them, but they'll be validated by the test runner.)

3. **Grep audit — confirm no stale references:**
   ```bash
   grep -rn 'STATES\.SHELL\|_tmuxRunningClaude\|respawn-pane\|session:restart[^e]\|session:restarted\|restartSession\|SESSION_RESTART' \
     lib/ public/js/ tests/
   ```
   Must return zero results.

4. **Grep confirm new names exist:**
   ```bash
   grep -rn 'session:refresh\|refreshSession\|SESSION_REFRESH\|\.refresh(' \
     lib/ public/js/ tests/
   ```
   Must show hits in all expected files.

---

## Files Changed Summary

| File | Changes |
|------|---------|
| `lib/sessions/sessionStates.js` | Remove SHELL state and transitions |
| `lib/sessions/TmuxSession.js` | Remove `_tmuxRunningClaude()`, SHELL refs; rename `restart()` to `refresh()` with detach/re-attach alive path; simplify `_wirePty` onExit |
| `lib/sessions/DirectSession.js` | Add `refresh()` method |
| `lib/sessions/SessionManager.js` | Rename `restart()` to `refresh()`; remove SHELL refs; add auto-resume in `subscribe()`; remove `forceResume()`; update `_buildResumeCommand` |
| `lib/ws/handlers/sessionHandlers.js` | Rename `restart` to `refresh`; response type `session:refreshed` |
| `public/js/ws/protocol.js` | `SESSION_RESTART` to `SESSION_REFRESH` |
| `public/js/state/actions.js` | `restartSession` to `refreshSession`; message type update |
| `public/js/state/sessionState.js` | Handler for `session:refreshed` instead of `session:restarted` |
| `public/js/components/SessionCard.js` | Remove shell badge/status; rename Restart to Refresh; update import + handler |
| `public/js/components/SessionOverlay.js` | Remove shell status; rename Restart to Refresh; update import + handler |
| `tests/unit/TmuxSession.test.js` | Remove SHELL tests, `_tmuxRunningClaude` tests; rewrite restart suite as refresh suite |
| `tests/unit/DirectSession.test.js` | Add refresh test suite |
| `tests/integration/sessionLifecycle.test.js` | Rename restart to refresh throughout; update mocks |
