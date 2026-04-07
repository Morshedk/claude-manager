# Snapshot System Removal Plan

## Overview

Remove the snapshot system (headless xterm mirror, tmux capture-pane, `session:snapshot` message) from the v2 app. The simpler approach is sufficient:
- **tmux sessions**: natural PTY replay on re-attach handles scrollback
- **direct sessions**: `--resume` restores conversation context; terminal visual history is not needed
- **Client**: clears xterm on `session:subscribed` to prevent buffer accumulation

---

## Change Order

Execute changes in this order to avoid breaking intermediate state:

1. **Server-side session classes** (DirectSession, TmuxSession) -- remove snapshot internals
2. **SessionManager** -- remove snapshot orchestration from subscribe()
3. **SessionStore** -- remove snapshot file I/O methods (saveSnapshot, loadSnapshot, deleteSnapshot)
4. **WebSocket handler** -- remove `session:snapshot` sending from sessionHandlers.js
5. **Client protocol constant** -- remove SESSION_SNAPSHOT from protocol.js
6. **Client component** -- remove snapshot handler from TerminalPane.js, add `session:subscribed` handler
7. **Client state** -- update comment in sessionState.js
8. **package.json** -- remove @xterm/headless and @xterm/addon-serialize dependencies
9. **Tests** -- update unit, integration, and e2e tests
10. **npm install** -- run to clean node_modules

---

## File-by-File Changes

### 1. `lib/sessions/DirectSession.js`

**REMOVE:**
- Line 3: `import { SerializeAddon } from '@xterm/addon-serialize';`
- Lines 6-20: The entire `createRequire`, `@xterm/headless` lazy loader (`const require = createRequire(...)`, `let _Terminal = null`, `async function getTerminalClass()`)
- Line 22: `const SNAPSHOT_INTERVAL_MS = 30_000;`
- Lines 43-45 in constructor: `this._headless = null;`, `this._serialize = null;`, `this._snapshotTimer = null;`
- Lines 62-66 in `start()`: The headless xterm initialization block:
  ```js
  const TerminalClass = await getTerminalClass();
  this._headless = new TerminalClass({ cols: this._cols, rows: this._rows, scrollback: 10000, allowProposedApi: true });
  this._serialize = new SerializeAddon();
  this._headless.loadAddon(this._serialize);
  ```
- Line 98 in `start()`: `this._snapshotTimer = setInterval(() => this._saveSnapshot(), SNAPSHOT_INTERVAL_MS);`
- Lines 107-109 in `stop()`: The snapshot timer clearing block:
  ```js
  if (this._snapshotTimer) {
    clearInterval(this._snapshotTimer);
    this._snapshotTimer = null;
  }
  ```
- Lines 116-117 in `stop()`: `this._saveSnapshot();` call (fire-and-forget snapshot save)
- Lines 148-149 in `resize()`: `if (this._headless) { this._headless.resize(cols, rows); }`
- Lines 158-166: The entire `getSnapshot()` method
- Lines 205-208 in `_wirePty()`: The headless xterm write block:
  ```js
  if (this._headless) {
    this._headless.write(data);
  }
  ```
- Lines 225-228 in `_wirePty()` onExit handler: The snapshot timer clearing:
  ```js
  if (this._snapshotTimer) {
    clearInterval(this._snapshotTimer);
    this._snapshotTimer = null;
  }
  ```
- Line 235 in `_wirePty()` onExit handler: `this._saveSnapshot();`
- Lines 318-326: The entire `_saveSnapshot()` method

**ALSO REMOVE** the `import { createRequire } from 'module';` on line 2 (only used for node-pty require). Wait -- check if `createRequire` is still needed for `require('node-pty')` in `start()` and `_claudeSessionFileExists()`. Yes, it IS still needed for those. **KEEP** the `createRequire` import and `const require = createRequire(import.meta.url);` line.

**KEEP:**
- `createRequire` import and `const require = createRequire(import.meta.url);` (used by `require('node-pty')` in `start()` and `require('fs')` / `require('path')` in `_claudeSessionFileExists()`)
- Constructor fields: `this.pty`, `this.viewers`, `this._cols`, `this._rows`
- `start()` method (minus headless xterm init and snapshot timer)
- `stop()` method (minus snapshot timer and snapshot save)
- `write()`, `resize()` (minus headless resize), `addViewer()`, `removeViewer()`, `toJSON()`
- `_wirePty()` (minus headless write and snapshot timer/save in onExit)
- `_buildArgs()`, `_claudeSessionFileExists()`, `_setState()`

**UPDATE** the class JSDoc comment (lines 24-30) to remove references to "headless xterm" and "snapshot". Replace with a simpler description like:
```
/**
 * DirectSession -- manages a Claude Code process spawned directly via node-pty.
 *
 * On subscribe, the client receives a session:subscribed signal and then
 * live PTY output. The client calls xterm.reset() on subscribe to start
 * with a clean buffer.
 */
```

**UPDATE** the `addViewer` comment in TmuxSession.js references snapshot protocol -- update in both files if needed.

### 2. `lib/sessions/TmuxSession.js`

**REMOVE:**
- Lines 158-174: The entire `getSnapshot()` method

**UPDATE:**
- Class JSDoc comment (lines 8-18): Remove references to "capture-pane snapshot" and "replaying raw PTY bytes". Update to:
  ```
  /**
   * TmuxSession -- runs Claude inside a named tmux session.
   *
   * On subscribe, the client receives a session:subscribed signal. tmux
   * natural PTY replay on re-attach handles scrollback restoration.
   * The client calls xterm.reset() to start with a clean buffer.
   *
   * State transitions:
   *   CREATED -> STARTING -> RUNNING -> SHELL -> STOPPED
   *                                  -> STOPPED
   *                         -> STOPPED
   */
  ```
- Lines 192-197 in `addViewer()`: Remove the NOTE comment block about snapshot protocol:
  ```js
  // NOTE: snapshot is NOT sent here. The subscribe protocol in SessionManager
  // calls getSnapshot() separately and sends it as a 'session:snapshot' message.
  // Sending it here via the viewer callback would cause a duplicate (once as
  // 'session:output', once as 'session:snapshot').
  ```

**KEEP:**
- Everything else: constructor, `start()`, `stop()`, `write()`, `resize()`, `addViewer()` (minus comment), `removeViewer()`, `restart()`, `_tmuxSessionAlive()`, `_tmuxRunningClaude()`, `_attachPty()`, `_wirePty()`, `_setState()`, `toJSON()`

### 3. `lib/sessions/SessionManager.js`

**REMOVE:**
- Lines 233-244: In `subscribe()`, remove the snapshot retrieval. The method currently gets the snapshot BEFORE adding the viewer and returns it. Change to:
  ```js
  async subscribe(sessionId, clientId, callback) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.addViewer(clientId, callback);
  }
  ```
  Make it return `void` (or `Promise<void>`) instead of `Promise<string>`. Remove the `@returns {Promise<string>} snapshot` JSDoc line.
- Lines 319: In `restart()` for direct mode, remove `await this.store.deleteSnapshot(sessionId);`
- Lines 355-376: The entire `getSnapshot()` method and the `getScrollback()` alias method (lines 357-376)
- Line 352 in `delete()`: `await this.store.deleteSnapshot(sessionId);`

**UPDATE:**
- `subscribe()` JSDoc: change return type from `Promise<string>` to `Promise<void>`, remove "snapshot" language from comment
- `subscribe()` comment block (lines 238-240): Remove the comment about snapshot ordering protocol

**KEEP:**
- Everything else: constructor, `init()`, `create()`, `_createDirect()`, `_createTmux()`, `get()`, `list()`, `exists()`, `unsubscribe()`, `write()`, `resize()`, `stop()`, `restart()` (minus deleteSnapshot call), `delete()` (minus deleteSnapshot call), `forceResume()`, `_wireSessionEvents()`, `_buildAuthEnv()`, `_buildClaudeCommand()`, `_buildResumeCommand()`, `_discoverClaudeSessionId()`, `_claudeSessionFileExists()`

### 4. `lib/ws/handlers/sessionHandlers.js`

**REMOVE:**
- Lines 44-46 in `subscribe()`: The snapshot retrieval from `this.sessions.subscribe()`. Currently:
  ```js
  const snapshot = await this.sessions.subscribe(id, clientId, (data) => {
    this.registry.send(clientId, { type: 'session:output', id, data });
  });
  ```
  Change to:
  ```js
  await this.sessions.subscribe(id, clientId, (data) => {
    this.registry.send(clientId, { type: 'session:output', id, data });
  });
  ```
- Lines 52-54: The snapshot sending block:
  ```js
  if (snapshot) {
    this.registry.send(clientId, { type: 'session:snapshot', id, data: snapshot });
  }
  ```

**UPDATE:**
- `subscribe()` JSDoc comment (lines 27-30): Remove "Protocol order: snapshot -> subscribed -> live output". Replace with: "Protocol order: subscribed -> live output (via viewer callback)."
- Line 56 comment: Change "Signal client that subscription is ready; live output follows" -- this is still correct, keep it.

**KEEP:**
- The `session:subscribed` message send (line 57): `this.registry.send(clientId, { type: 'session:subscribed', id });` -- THIS IS CRITICAL TO KEEP
- The `this.registry.subscribe(clientId, id);` call (line 49)
- Everything else: `unsubscribe()`, `create()`, `input()`, `resize()`, `stop()`, `restart()`, `delete()`, `_broadcastSessionsList()`

### 5. `public/js/ws/protocol.js`

**REMOVE:**
- Line 23: `SESSION_SNAPSHOT:  'session:snapshot',`

**ADD:**
- Line (in SERVER object, where SESSION_SNAPSHOT was): `SESSION_SUBSCRIBED: 'session:subscribed',`

The SERVER object should look like:
```js
export const SERVER = {
  INIT:              'init',
  SESSION_CREATED:   'session:created',
  SESSION_STATE:     'session:state',
  SESSION_SUBSCRIBED:'session:subscribed',
  SESSION_OUTPUT:    'session:output',
  SESSION_ERROR:     'session:error',
  SESSIONS_LIST:     'sessions:list',
  // ... rest unchanged
};
```

### 6. `public/js/components/TerminalPane.js`

**REMOVE:**
- Lines 130-134: The entire `handleSnapshot` handler:
  ```js
  const handleSnapshot = (msg) => {
    if (msg.id !== sessionId) return;
    xterm.reset();
    if (msg.data) xterm.write(msg.data);
  };
  ```
- Line 142: `on(SERVER.SESSION_SNAPSHOT, handleSnapshot);`
- Line 176: `off(SERVER.SESSION_SNAPSHOT, handleSnapshot);`

**ADD** a `session:subscribed` handler that calls `xterm.reset()`:
```js
// session:subscribed -> client clears xterm buffer before live output begins.
// This prevents buffer accumulation across reconnects/restarts.
const handleSubscribed = (msg) => {
  if (msg.id !== sessionId) return;
  xterm.reset();
};
```

Register it:
```js
on(SERVER.SESSION_SUBSCRIBED, handleSubscribed);
```

And in the cleanup:
```js
off(SERVER.SESSION_SUBSCRIBED, handleSubscribed);
```

**UPDATE:**
- Lines 27-29 in the component JSDoc: Remove "On session:snapshot -> xterm.reset() then write clean rendered state (no dot artifacts)". Replace with "On session:subscribed -> xterm.reset() clears buffer before live output".
- Line 126 comment: Update "6. WebSocket message handlers" section to reflect the new flow.

**KEEP:**
- The `handleOutput` handler (lines 137-140) -- unchanged
- The `handleReconnect` handler (lines 152-160) -- unchanged (it already calls `xterm.reset()` and re-subscribes)
- Everything else: xterm creation, addon loading, scroll control, input handler, ResizeObserver, cleanup

### 7. `public/js/state/sessionState.js`

**UPDATE:**
- Line 111 comment: Change `// session:snapshot and session:output are handled per-terminal in TerminalPane` to `// session:subscribed and session:output are handled per-terminal in TerminalPane`

**KEEP:** Everything else unchanged. No snapshot handler was registered here.

### 8. `public/js/state/actions.js`

**NO CHANGES NEEDED.** There is no snapshot-related logic in this file.

### 9. `package.json`

**REMOVE** from `dependencies`:
- `"@xterm/addon-serialize": "^0.13.0"`
- `"@xterm/headless": "^5.5.0"`

After editing, run `npm install` to update the lockfile.

### 10. `lib/sessions/SessionStore.js`

**REMOVE:**
- Lines 23: `this.snapshotsDir = join(dataDir, 'snapshots');`
- Lines 94-126: The entire `saveSnapshot()`, `loadSnapshot()`, and `deleteSnapshot()` methods
- The JSDoc comment referencing snapshots (line 14): `* snapshots/<id>.snap -- serialized xterm state (output of SerializeAddon.serialize())`

**KEEP:**
- Constructor (minus snapshotsDir)
- `load()`, `save()`, `upsert()`, `remove()`
- sessions.json management

---

## Test Changes

### 10. `tests/unit/DirectSession.test.js`

**REMOVE these entire test blocks:**
- `'getSnapshot() returns serialized state when headless is live'` (lines 285-295)
- `'getSnapshot() falls back to disk when headless is not initialized'` (lines 297-304)
- `'stop() clears the snapshot interval timer'` (lines 423-434)
- `'_saveSnapshot() saves serialized state to store'` (lines 438-449)
- `'_saveSnapshot() is a no-op when headless not initialized'` (lines 451-455)
- `'_saveSnapshot is called periodically (timer fires)'` (lines 487-498)

**REMOVE from mock setup:**
- Lines 13-21: The `mockTerminalInstance` and `@xterm/headless` mock
- Lines 23-29: The `mockSerializeInstance` and `@xterm/addon-serialize` mock

**UPDATE these tests:**
- `'PTY data flows to headless xterm AND to viewers'` (lines 247-263): Remove the assertion `expect(mockTerminalInstance.write).toHaveBeenCalledWith('hello world');`. Rename test to `'PTY data flows to viewers'`.
- `'resize() updates cols/rows and resizes PTY + headless xterm'` (lines 308-321): Remove `expect(mockTerminalInstance.resize).toHaveBeenCalledWith(200, 50);`. Rename to `'resize() updates cols/rows and resizes PTY'`.
- `'PTY exit with code 0 transitions to STOPPED'` (lines 369-381): Remove `expect(store.saveSnapshot).toHaveBeenCalled();`
- `'stop() kills PTY, saves snapshot, and transitions to STOPPED'` (lines 409-421): Remove `expect(store.saveSnapshot).toHaveBeenCalled();`. Rename to `'stop() kills PTY and transitions to STOPPED'`.

**UPDATE the `startSession()` helper** (lines 141-183): Remove all headless xterm initialization from the patched start function:
- Remove `const { Terminal } = await import('@xterm/headless');`
- Remove `const { SerializeAddon } = await import('@xterm/addon-serialize');`
- Remove `session._headless = new Terminal(...)`, `session._serialize = new SerializeAddon()`, `session._headless.loadAddon(session._serialize)`
- Remove the snapshot timer setup: `session._snapshotTimer = setInterval(...)`

**UPDATE the `makeMockStore()` helper** (lines 67-72): Remove `saveSnapshot` and `loadSnapshot` mock methods.

**UPDATE `beforeEach()`** (lines 190-196): Remove `mockTerminalInstance.write.mockClear()`, `mockTerminalInstance.resize.mockClear()`, `mockSerializeInstance.serialize.mockClear()`, `mockSerializeInstance.serialize.mockReturnValue(...)`.

### 11. `tests/unit/TmuxSession.test.js`

**REMOVE the entire describe block:**
- `'TmuxSession -- getSnapshot()'` (lines 209-277): Contains 4 tests, all snapshot-specific

**UPDATE:**
- `'addViewer does NOT send snapshot via callback...'` test (lines 297-313): The test name and comment reference snapshot. Simplify: rename to `'addViewer does not call callback on registration'` and remove the comment about snapshot protocol. The assertion `expect(cb).not.toHaveBeenCalled()` is still valid -- addViewer should not immediately call the callback.
- Remove `jest.spyOn(s, 'getSnapshot').mockReturnValue('')` from `'multiple viewers all receive PTY data'` test (line 335) -- getSnapshot no longer exists.

### 12. `tests/unit/SessionManager.test.js`

**REMOVE:**
- The entire `'getSnapshot() and getScrollback()'` describe block (lines 369-392): 3 tests

**UPDATE:**
- `'subscribe() calls session.addViewer and returns snapshot'` test (lines 244-254): Change to not expect a snapshot return value. Rename to `'subscribe() calls session.addViewer'`. Remove `expect(snapshot).toBe('direct-snapshot');`. Change `const snapshot = await mgr.subscribe(...)` to just `await mgr.subscribe(...)`.
- `'delete() calls store.remove and store.deleteSnapshot'` test (lines 342-351): Remove `expect(mockStoreDeleteSnapshot).toHaveBeenCalledWith(id);`. Rename to `'delete() calls store.remove'`.
- The mock DirectSession factory `makeDirectSessionInstance()` (line 33): Remove `getSnapshot: jest.fn().mockResolvedValue('direct-snapshot'),`
- The mock TmuxSession factory `makeTmuxSessionInstance()` (line 52): Remove `getSnapshot: jest.fn().mockResolvedValue('tmux-snapshot'),`
- `beforeEach()` (line 127): Remove `mockStoreDeleteSnapshot.mockResolvedValue(undefined);`
- Remove the `mockStoreDeleteSnapshot` variable declaration (line 77) and its mock setup.

### 13. `tests/integration/wsProtocol.test.js`

**REMOVE:**
- The `'returns session:snapshot then session:subscribed in order'` test (lines 404-436): This tests the exact message ordering with snapshot first. Replace with a test that verifies `session:subscribed` is sent (without snapshot).
- The `'snapshot message contains session data field'` test (lines 438-451): Entirely snapshot-specific.

**ADD replacement test:**
```js
test('returns session:subscribed after subscribe', async () => {
  const sessionMeta = await sessions.create({ projectId, mode: 'direct', name: 'sub-test' });
  const { ws } = await openClient(serverPort());

  const subscribedPromise = waitForMessage(ws, 'session:subscribed', 4000);

  ws.send(JSON.stringify({ type: 'session:subscribe', id: sessionMeta.id }));

  const msg = await subscribedPromise;
  expect(msg.type).toBe('session:subscribed');
  expect(msg.id).toBe(sessionMeta.id);

  ws.close();
});
```

**UPDATE:**
- The mock DirectSession in the test file (lines 49): Remove `getSnapshot: jest.fn().mockResolvedValue('snapshot-data'),`
- The mock TmuxSession (line 80): Remove `getSnapshot: jest.fn().mockResolvedValue(''),`

### 14. `tests/e2e/scrollback.test.js`

**UPDATE:**
- Line 165 in `subscribeAndSendCommand()`: The function currently waits for `session:snapshot` as one of the accepted first messages. Remove `session:snapshot` from the predicate:
  ```js
  // Before:
  await waitForMessage(ws, m =>
    (m.type === 'session:subscribed' && m.id === sessionId) ||
    (m.type === 'session:snapshot'   && m.id === sessionId) ||
    (m.type === 'session:output'     && m.id === sessionId)
  , 10000);
  
  // After:
  await waitForMessage(ws, m =>
    (m.type === 'session:subscribed' && m.id === sessionId) ||
    (m.type === 'session:output'     && m.id === sessionId)
  , 10000);
  ```

- The test comments and descriptions reference snapshot. Update:
  - Line 7: Change "v2 fix: xterm.reset() called before writing snapshot" to "v2 fix: xterm.reset() called on session:subscribed"
  - Lines 14-15: Remove "snapshot" language

**KEEP:** The overall test structure is still valid -- it tests that bullet characters don't persist after restart.

### 15. `tests/unit/SessionStore.test.js`

**REMOVE** any tests for `saveSnapshot()`, `loadSnapshot()`, `deleteSnapshot()`. Check the file for these test blocks and remove them.

---

## Verification Steps

After all changes are made, run these in order:

### Step 1: Syntax check
```bash
node -c lib/sessions/DirectSession.js && \
node -c lib/sessions/TmuxSession.js && \
node -c lib/sessions/SessionManager.js && \
node -c lib/sessions/SessionStore.js && \
node -c lib/ws/handlers/sessionHandlers.js
```

### Step 2: Verify removed deps are not imported
```bash
grep -r "@xterm/headless" lib/ public/ --include="*.js"
grep -r "@xterm/addon-serialize" lib/ public/ --include="*.js"
grep -r "getSnapshot" lib/ --include="*.js"
grep -r "saveSnapshot\|loadSnapshot\|deleteSnapshot" lib/ --include="*.js"
grep -r "session:snapshot" lib/ public/ --include="*.js"
grep -r "SESSION_SNAPSHOT" public/ --include="*.js"
```
All should return no matches.

### Step 3: Verify SESSION_SUBSCRIBED is properly wired
```bash
grep -r "SESSION_SUBSCRIBED\|session:subscribed" lib/ public/ --include="*.js"
```
Should show:
- `lib/ws/handlers/sessionHandlers.js` sending it
- `public/js/ws/protocol.js` defining the constant
- `public/js/components/TerminalPane.js` listening for it

### Step 4: Run unit tests
```bash
npm test
```
All tests must pass.

### Step 5: npm install (clean deps)
```bash
npm install
```
Verify `@xterm/headless` and `@xterm/addon-serialize` are no longer in `node_modules/`.

### Step 6: Start server and verify basic flow
```bash
node server.js
```
- Create a session via the UI or API
- Verify `session:subscribed` is sent after subscribe
- Verify `session:snapshot` is NOT sent
- Verify terminal shows live output after subscribing

---

## Summary of Removed Concepts

| Concept | Files | Replacement |
|---------|-------|-------------|
| Headless xterm mirror | DirectSession.js | Removed entirely -- not needed |
| SerializeAddon | DirectSession.js, package.json | Removed entirely |
| @xterm/headless | DirectSession.js, package.json | Removed entirely |
| `getSnapshot()` | DirectSession, TmuxSession, SessionManager | Removed entirely |
| tmux capture-pane | TmuxSession.js | tmux natural PTY replay on re-attach |
| `session:snapshot` message | sessionHandlers.js, protocol.js, TerminalPane.js | `session:subscribed` triggers `xterm.reset()` |
| Snapshot file I/O (.snap) | SessionStore.js | Removed entirely |
| `_saveSnapshot()` / timer | DirectSession.js | Removed entirely |
| `deleteSnapshot()` calls | SessionManager.js | Removed from restart() and delete() |
| `getScrollback()` alias | SessionManager.js | Removed entirely |

## What Is Preserved

- `session:subscribed` message -- server sends it after subscribe; client uses it to call `xterm.reset()`
- Natural PTY re-attach for tmux (already works via `_attachPty()`)
- `--resume` for direct sessions (already works via `_buildArgs()`)
- All viewer management (addViewer/removeViewer)
- All session lifecycle (create/stop/restart/delete)
- All PTY I/O (write/resize)
- Session persistence (sessions.json via SessionStore)
- All WebSocket protocol except `session:snapshot`
