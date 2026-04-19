# Session Events While Disconnected Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture tmux terminal output that occurred while the server was down, so session events are not lost across PM2 restarts.

**Architecture:** On server restart, `SessionManager` calls `_attachPty()` → `startCapture(sessionId, tmuxName)` for each running tmux session. Currently, `startCapture` only starts a `pipe-pane` stream going forward — content generated during the downtime is in tmux's scrollback buffer but never reaches the `.raw` file. The fix: in `startCapture`, detect a reconnect (`.raw` file already exists from a prior run) and snapshot the current pane via `tmux capture-pane -p -S -2000` before starting pipe-pane. The snapshot is appended to the `.raw` file and processed normally by `tick()`. No new imports are needed — `existsSync` and `appendFileSync` are already imported.

**Tech Stack:** Node.js ES modules, Jest (`--experimental-vm-modules`), `child_process.execSync`, `fs` module

---

## Files to Change

| File | Change |
|------|--------|
| `lib/sessionlog/SessionLogManager.js` | Add catch-up snapshot in `startCapture()` when raw file already exists |
| `tests/unit/SessionLogManager.test.js` | **Create** — unit tests for `startCapture` reconnect behavior |

---

### Task 1: Write failing tests for the scrollback catch-up behavior

**Files:**
- Create: `tests/unit/SessionLogManager.test.js`

The test file mocks `child_process` and `fs` — same pattern used in `tests/unit/TmuxSession.test.js`. Tests verify:
- First-time start (no `.raw` file): only `pipe-pane` is called, no `capture-pane`
- Reconnect (`.raw` file exists): `capture-pane` is called BEFORE `pipe-pane`, its output is appended
- Reconnect with `capture-pane` failure: error is swallowed, `pipe-pane` still starts

- [ ] **Step 1: Create `tests/unit/SessionLogManager.test.js`**

```js
/**
 * Unit tests for SessionLogManager.startCapture reconnect behavior.
 *
 * Mocks child_process and fs so no real tmux or files are touched.
 */

import { jest } from '@jest/globals';
import { join } from 'path';

// ── Mock fs ──────────────────────────────────────────────────────────────────
const mockExistsSync  = jest.fn();
const mockMkdirSync   = jest.fn();
const mockStatSync    = jest.fn();
const mockAppendFileSync = jest.fn();
const mockOpenSync    = jest.fn();
const mockReadSync    = jest.fn();
const mockCloseSync   = jest.fn();
const mockReadFileSync = jest.fn();

jest.unstable_mockModule('fs', () => ({
  existsSync:    mockExistsSync,
  mkdirSync:     mockMkdirSync,
  statSync:      mockStatSync,
  appendFileSync: mockAppendFileSync,
  openSync:      mockOpenSync,
  readSync:      mockReadSync,
  closeSync:     mockCloseSync,
  readFileSync:  mockReadFileSync,
}));

// ── Mock child_process ───────────────────────────────────────────────────────
const mockExecSync = jest.fn().mockReturnValue(Buffer.from(''));

jest.unstable_mockModule('child_process', () => ({
  execSync: mockExecSync,
}));

// ── Import module under test (after mocks) ───────────────────────────────────
const { SessionLogManager } = await import('../../lib/sessionlog/SessionLogManager.js');

// ── Helpers ───────────────────────────────────────────────────────────────────
const VALID_SESSION_ID = 'aaaabbbb-cccc-dddd-eeee-ffffaaaabbbb';
const TMUX_NAME = 'cm-aaaabbbb';
const DATA_DIR = '/tmp/test-data';

function makeManager() {
  mockMkdirSync.mockReturnValue(undefined);
  return new SessionLogManager({ dataDir: DATA_DIR });
}

const expectedRawPath = join(DATA_DIR, 'sessionlog', `${VALID_SESSION_ID}.raw`);

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionLogManager.startCapture — first start (no raw file)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
  });

  test('calls pipe-pane when raw file does not exist', () => {
    mockExistsSync.mockReturnValue(false); // raw file does NOT exist
    mockExecSync.mockReturnValue(Buffer.from(''));
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    // pipe-pane must be called
    const pipePaneCall = mockExecSync.mock.calls.find(c =>
      c[0].includes('pipe-pane')
    );
    expect(pipePaneCall).toBeDefined();
    expect(pipePaneCall[0]).toContain(TMUX_NAME);
    expect(pipePaneCall[0]).toContain(expectedRawPath);
  });

  test('does NOT call capture-pane when raw file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(''));
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    const capturePaneCall = mockExecSync.mock.calls.find(c =>
      c[0].includes('capture-pane')
    );
    expect(capturePaneCall).toBeUndefined();
  });

  test('does NOT call appendFileSync when raw file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockReturnValue(Buffer.from(''));
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});

describe('SessionLogManager.startCapture — reconnect (raw file exists)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
  });

  test('calls capture-pane BEFORE pipe-pane on reconnect', () => {
    mockExistsSync.mockReturnValue(true); // raw file exists
    const scrollback = Buffer.from('line1\nline2\n');
    mockExecSync.mockReturnValue(scrollback);
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    const calls = mockExecSync.mock.calls.map(c => c[0]);
    const captureIdx = calls.findIndex(c => c.includes('capture-pane'));
    const pipeIdx    = calls.findIndex(c => c.includes('pipe-pane'));

    expect(captureIdx).toBeGreaterThanOrEqual(0);
    expect(pipeIdx).toBeGreaterThanOrEqual(0);
    expect(captureIdx).toBeLessThan(pipeIdx); // capture-pane runs first
  });

  test('capture-pane targets correct tmux session and uses -S -2000', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue(Buffer.from('output'));
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    const captureCall = mockExecSync.mock.calls.find(c => c[0].includes('capture-pane'))?.[0];
    expect(captureCall).toContain(TMUX_NAME);
    expect(captureCall).toContain('-S -2000');
    expect(captureCall).toContain('-p');
  });

  test('appends capture-pane output to raw file', () => {
    mockExistsSync.mockReturnValue(true);
    const scrollback = Buffer.from('captured output\n');
    mockExecSync.mockReturnValue(scrollback);
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    expect(mockAppendFileSync).toHaveBeenCalledWith(expectedRawPath, scrollback);
  });

  test('pipe-pane still starts even if capture-pane throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync
      .mockImplementationOnce(() => { throw new Error('tmux: no session'); }) // capture-pane fails
      .mockReturnValue(Buffer.from('')); // pipe-pane succeeds
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    const pipePaneCall = mockExecSync.mock.calls.find(c => c[0].includes('pipe-pane'));
    expect(pipePaneCall).toBeDefined();
  });

  test('adds sessionId to _capturing set after reconnect', () => {
    mockExistsSync.mockReturnValue(true);
    mockExecSync.mockReturnValue(Buffer.from(''));
    const mgr = makeManager();

    mgr.startCapture(VALID_SESSION_ID, TMUX_NAME);

    expect(mgr.capturing.has(VALID_SESSION_ID)).toBe(true);
  });
});

describe('SessionLogManager.startCapture — input validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockMkdirSync.mockReturnValue(undefined);
  });

  test('silently ignores invalid sessionId', () => {
    const mgr = makeManager();
    mgr.startCapture('not-a-uuid', TMUX_NAME);
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/SessionLogManager.test.js --forceExit 2>&1 | tail -30
```

Expected: Tests fail with errors about `capture-pane` calls not matching (because the current `startCapture` doesn't call `capture-pane`). Specifically:
- "does NOT call capture-pane when raw file does not exist" → PASS (already correct)
- "calls capture-pane BEFORE pipe-pane on reconnect" → FAIL
- "appends capture-pane output to raw file" → FAIL

- [ ] **Step 3: Commit the failing tests**

```bash
git add tests/unit/SessionLogManager.test.js
git commit -m "test: add failing tests for startCapture scrollback catch-up on reconnect"
```

---

### Task 2: Implement the scrollback catch-up in startCapture

**Files:**
- Modify: `lib/sessionlog/SessionLogManager.js:30-43`

The current `startCapture` method (lines 30–43):

```js
startCapture(sessionId, tmuxName) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return;
  const rawPath = join(this._logDir, `${sessionId}.raw`);
  try {
    execSync(
      `tmux pipe-pane -t ${JSON.stringify(tmuxName)} -o ${JSON.stringify(`cat >> ${rawPath}`)}`,
      { timeout: 3000 }
    );
    this._capturing.add(sessionId);
    if (!this._offsets.has(sessionId)) {
      this._offsets.set(sessionId, 0);
    }
  } catch { /* tmux may not be running in tests */ }
}
```

Replace with:

```js
startCapture(sessionId, tmuxName) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return;
  const rawPath = join(this._logDir, `${sessionId}.raw`);

  // Reconnect path: raw file exists from a prior server run.
  // Snapshot the current pane scrollback so events generated while the
  // server was down are not lost. Runs before pipe-pane so the snapshot
  // lands at the current file offset and is processed by the next tick().
  if (existsSync(rawPath)) {
    try {
      const snapshot = execSync(
        `tmux capture-pane -t ${JSON.stringify(tmuxName)} -p -S -2000`,
        { timeout: 3000 }
      );
      appendFileSync(rawPath, snapshot);
    } catch { /* pane may not exist yet — ignore */ }
  }

  try {
    execSync(
      `tmux pipe-pane -t ${JSON.stringify(tmuxName)} -o ${JSON.stringify(`cat >> ${rawPath}`)}`,
      { timeout: 3000 }
    );
    this._capturing.add(sessionId);
    if (!this._offsets.has(sessionId)) {
      this._offsets.set(sessionId, 0);
    }
  } catch { /* tmux may not be running in tests */ }
}
```

- [ ] **Step 1: Apply the change to `lib/sessionlog/SessionLogManager.js`**

Replace `startCapture` exactly as shown above. `existsSync` and `appendFileSync` are already imported at line 5 — no import changes needed.

- [ ] **Step 2: Run the tests and verify they pass**

```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/SessionLogManager.test.js --forceExit 2>&1 | tail -20
```

Expected output:
```
PASS tests/unit/SessionLogManager.test.js
  SessionLogManager.startCapture — first start (no raw file)
    ✓ calls pipe-pane when raw file does not exist
    ✓ does NOT call capture-pane when raw file does not exist
    ✓ does NOT call appendFileSync when raw file does not exist
  SessionLogManager.startCapture — reconnect (raw file exists)
    ✓ calls capture-pane BEFORE pipe-pane on reconnect
    ✓ capture-pane targets correct tmux session and uses -S -2000
    ✓ appends capture-pane output to raw file
    ✓ pipe-pane still starts even if capture-pane throws
    ✓ adds sessionId to _capturing set after reconnect
  SessionLogManager.startCapture — input validation
    ✓ silently ignores invalid sessionId

Tests: 9 passed, 9 total
```

- [ ] **Step 3: Run the full unit test suite to check for regressions**

```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/ --forceExit 2>&1 | tail -15
```

Expected: All unit tests pass. If any fail, read the error and fix before committing.

- [ ] **Step 4: Commit**

```bash
git add lib/sessionlog/SessionLogManager.js
git commit -m "feat: capture tmux scrollback on server restart to preserve session events"
```

---

### Task 3: Smoke test

- [ ] **Step 1: Restart PM2 beta**

```bash
pm2 restart claude-v2-beta
sleep 2
pm2 logs claude-v2-beta --lines 5 --nostream 2>&1 | grep -E "listening|Error"
```

Expected: `[server] claude-web-app-v2 listening on http://127.0.0.1:3002`

- [ ] **Step 2: Check the raw file grows on reconnect**

```bash
# Find the data-beta sessionlog directory
ls /home/claude-runner/apps/claude-web-app-v2/data-beta/sessionlog/*.raw 2>/dev/null | head -3
```

If `.raw` files exist (sessions are running), their size should have increased after the restart (because `capture-pane` appended content).

- [ ] **Step 3: Verify events pane shows pre-restart content**

1. Open the app in browser at `http://127.0.0.1:3002/`
2. Open a session's Events tab
3. Scroll to the top — you should see terminal output from before the restart
4. Look for the timestamp markers (HH:MM:SS prefix on `===` event lines) — the events should show activity from before the restart

- [ ] **Step 4: Commit smoke test confirmation**

No code changes needed if all tests pass.
