# SessionLog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent, human-readable logging of tmux terminal session output with session event annotations and a browser split-panel viewer.

**Architecture:** A new `SessionLogManager` module owns pipe-pane capture and log processing. tmux writes raw output to `{id}.raw` continuously; a 20s tick strips ANSI and appends to `{id}.log`. Session events (PTY attach/detach, stop, crash) are injected directly into `.log` as `=== EVENT ===` markers. The browser polls `/api/sessionlog/:id/tail` every 3s and renders a read-only log pane alongside the terminal.

**Tech Stack:** Node.js fs (sync), execSync for tmux pipe-pane, Preact/htm for the frontend pane, Jest for unit tests.

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| **Create** | `lib/sessionlog/SessionLogManager.js` | Core module: capture + session events, ANSI strip, tick, event injection |
| **Create** | `tests/unit/SessionLogManager.test.js` | Unit tests for the core module |
| **Create** | `public/js/components/SessionLogPane.js` | Browser split panel — polls tail, renders log |
| **Modify** | `lib/sessions/TmuxSession.js` | Add sessionLogManager opt; call startCapture/injectEvent/stopCapture at session event points |
| **Modify** | `lib/sessions/SessionManager.js` | Accept+store sessionLogManager; pass to TmuxSession; inject SERVER:START |
| **Modify** | `lib/api/routes.js` | Add /api/sessionlog/:id/tail, /full, /status endpoints |
| **Modify** | `server.js` | Create SessionLogManager; pass to SessionManager; start 20s tick; export refs |
| **Modify** | `server-with-crash-log.mjs` | Capture server exports; inject SERVER:CRASH into all logs on SIGTERM/SIGHUP |
| **Modify** | `public/js/components/SessionOverlay.js` | Add "Log" toggle button; conditionally render SessionLogPane |

---

## Task 1: Create `lib/sessionlog/SessionLogManager.js`

**Files:**
- Create: `lib/sessionlog/SessionLogManager.js`

- [ ] **Step 1: Write the module**

```javascript
// lib/sessionlog/SessionLogManager.js
import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, statSync, appendFileSync, writeFileSync,
  openSync, readSync, closeSync,
} from 'fs';
import { join } from 'path';
import { stripAnsi } from '../utils/stripAnsi.js';

export class SessionLogManager {
  /** @param {{ dataDir: string }} opts */
  constructor({ dataDir }) {
    this._logDir = join(dataDir, 'sessionlog');
    /** @type {Map<string, number>} sessionId → last processed byte offset in .raw */
    this._offsets = new Map();
    /** @type {Set<string>} sessionIds currently being captured */
    this._capturing = new Set();
    mkdirSync(this._logDir, { recursive: true });
  }

  /**
   * Start tmux pipe-pane capture. Idempotent — safe to call after PTY re-attach.
   * @param {string} sessionId
   * @param {string} tmuxName  e.g. "cm-abc12345"
   */
  startCapture(sessionId, tmuxName) {
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

  /**
   * Stop tmux pipe-pane capture.
   * @param {string} sessionId
   * @param {string} tmuxName
   */
  stopCapture(sessionId, tmuxName) {
    try {
      execSync(
        `tmux pipe-pane -t ${JSON.stringify(tmuxName)}`,
        { timeout: 3000 }
      );
    } catch { /* ignore */ }
    this._capturing.delete(sessionId);
  }

  /**
   * Inject a session event directly into the .log file (bypasses .raw staging).
   * Format: \n=== EVENT | ISO8601 | details ===\n
   * Uses appendFileSync so it's safe to call from process exit handlers.
   * @param {string} sessionId
   * @param {string} event   e.g. 'PTY:ATTACH'
   * @param {string} [details]
   */
  injectEvent(sessionId, event, details = '') {
    const logPath = join(this._logDir, `${sessionId}.log`);
    const ts = new Date().toISOString();
    const line = `\n=== ${event} | ${ts} | ${details} ===\n`;
    try {
      appendFileSync(logPath, line);
    } catch { /* ignore if dir missing */ }
  }

  /**
   * Process all capturing sessions: read new .raw bytes, strip ANSI,
   * append timestamped block to .log, truncate .raw.
   * Called every 20 seconds from server.js.
   */
  tick() {
    for (const sessionId of this._capturing) {
      this._processSession(sessionId);
    }
  }

  /** @returns {Set<string>} */
  get capturing() { return this._capturing; }

  // ── Internal ──────────────────────────────────────────────────────────────

  _processSession(sessionId) {
    const rawPath = join(this._logDir, `${sessionId}.raw`);
    if (!existsSync(rawPath)) return;

    let fileSize;
    try { fileSize = statSync(rawPath).size; } catch { return; }

    const lastOffset = this._offsets.get(sessionId) || 0;
    if (fileSize <= lastOffset) return; // no new content

    let content;
    try {
      const bytesToRead = fileSize - lastOffset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(rawPath, 'r');
      readSync(fd, buf, 0, bytesToRead, lastOffset);
      closeSync(fd);
      content = buf.toString('utf8');
    } catch { return; }

    const stripped = stripAnsi(content);
    const ts = new Date().toISOString();
    const logPath = join(this._logDir, `${sessionId}.log`);
    try {
      appendFileSync(logPath, `\n--- ${ts} ---\n${stripped}`);
    } catch { return; }

    // Reset offset and truncate .raw (safe: pipe uses O_APPEND, next write goes to new EOF=0)
    this._offsets.set(sessionId, 0);
    try { writeFileSync(rawPath, ''); } catch { /* ignore */ }
  }

  /**
   * Return the last N lines of the .log file.
   * @param {string} sessionId
   * @param {number} [lines=500]
   * @returns {string[]|null}  null if log doesn't exist yet
   */
  tailLog(sessionId, lines = 500) {
    const logPath = join(this._logDir, `${sessionId}.log`);
    if (!existsSync(logPath)) return null;
    try {
      const content = require('fs').readFileSync(logPath, 'utf8');
      const allLines = content.split('\n');
      return allLines.slice(-lines);
    } catch { return null; }
  }

  /**
   * Return the full .log path (for streaming).
   * @param {string} sessionId
   * @returns {string|null}  null if log doesn't exist
   */
  logPath(sessionId) {
    const p = join(this._logDir, `${sessionId}.log`);
    return existsSync(p) ? p : null;
  }

  /**
   * Return status info for a session.
   * @param {string} sessionId
   * @returns {{ capturing: boolean, logSizeBytes: number, lastActivity: string|null }}
   */
  status(sessionId) {
    const logPath = join(this._logDir, `${sessionId}.log`);
    let logSizeBytes = 0;
    let lastActivity = null;
    if (existsSync(logPath)) {
      try {
        const s = statSync(logPath);
        logSizeBytes = s.size;
        lastActivity = s.mtime.toISOString();
      } catch { /* ignore */ }
    }
    return {
      capturing: this._capturing.has(sessionId),
      logSizeBytes,
      lastActivity,
    };
  }
}
```

> **Note on `tailLog`:** Uses `require('fs')` instead of the top-level ESM import because `readFileSync` is already in scope from the named imports. Replace `require('fs').readFileSync` with the named import `readFileSync` from the import at the top. The plan shows it this way for clarity but the implementation should use the named import.

Fix — `tailLog` should use the named import:

```javascript
tailLog(sessionId, lines = 500) {
  const logPath = join(this._logDir, `${sessionId}.log`);
  if (!existsSync(logPath)) return null;
  try {
    // readFileSync is imported at the top of the file
    const { readFileSync } = await import('fs'); // NO — use named import
  } catch { return null; }
}
```

Correction: add `readFileSync` to the named imports at the top of the file, then use it directly in `tailLog`. The final import line should be:

```javascript
import {
  existsSync, mkdirSync, statSync, appendFileSync, writeFileSync,
  openSync, readSync, closeSync, readFileSync,
} from 'fs';
```

And `tailLog` becomes:
```javascript
tailLog(sessionId, lines = 500) {
  const logPath = join(this._logDir, `${sessionId}.log`);
  if (!existsSync(logPath)) return null;
  try {
    const content = readFileSync(logPath, 'utf8');
    return content.split('\n').slice(-lines);
  } catch { return null; }
}
```

- [ ] **Step 2: Commit**

```bash
git add lib/sessionlog/SessionLogManager.js
git commit -m "feat: add SessionLogManager — pipe-pane capture, tick, event injection"
```

---

## Task 2: Unit tests for SessionLogManager

**Files:**
- Create: `tests/unit/SessionLogManager.test.js`

- [ ] **Step 1: Write tests**

```javascript
// tests/unit/SessionLogManager.test.js
import { jest } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const mockExecSync = jest.fn();
jest.unstable_mockModule('child_process', () => ({ execSync: mockExecSync }));

const { SessionLogManager } = await import('../../lib/sessionlog/SessionLogManager.js');

function makeManager() {
  const dataDir = mkdtempSync(join(tmpdir(), 'slm-test-'));
  return { mgr: new SessionLogManager({ dataDir }), dataDir };
}

describe('SessionLogManager', () => {
  beforeEach(() => mockExecSync.mockClear());

  test('startCapture runs pipe-pane command and tracks session', () => {
    const { mgr } = makeManager();
    mgr.startCapture('sess-1', 'cm-abcdef12');
    expect(mockExecSync).toHaveBeenCalledTimes(1);
    const cmd = mockExecSync.mock.calls[0][0];
    expect(cmd).toMatch(/tmux pipe-pane/);
    expect(cmd).toMatch(/cm-abcdef12/);
    expect(cmd).toMatch(/sess-1\.raw/);
    expect(mgr.capturing.has('sess-1')).toBe(true);
  });

  test('stopCapture removes session from capturing set', () => {
    const { mgr } = makeManager();
    mgr.startCapture('sess-2', 'cm-aaaabbbb');
    expect(mgr.capturing.has('sess-2')).toBe(true);
    mgr.stopCapture('sess-2', 'cm-aaaabbbb');
    expect(mgr.capturing.has('sess-2')).toBe(false);
    // pipe-pane without -o flag to stop capture
    const lastCall = mockExecSync.mock.calls[1][0];
    expect(lastCall).toMatch(/tmux pipe-pane/);
    expect(lastCall).not.toMatch(/-o/);
  });

  test('injectEvent appends === marker to .log file', () => {
    const { mgr, dataDir } = makeManager();
    mgr.injectEvent('sess-3', 'PTY:ATTACH', 'tmuxName=cm-11223344');
    const logPath = join(dataDir, 'sessionlog', 'sess-3.log');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toMatch(/=== PTY:ATTACH \|/);
    expect(content).toMatch(/tmuxName=cm-11223344/);
  });

  test('tick: no-op when .raw is empty or unchanged', () => {
    const { mgr, dataDir } = makeManager();
    const rawPath = join(dataDir, 'sessionlog', 'sess-4.raw');
    writeFileSync(rawPath, '');
    mgr.startCapture('sess-4', 'cm-00000001');
    mgr._offsets.set('sess-4', 0);
    mgr.tick();
    const logPath = join(dataDir, 'sessionlog', 'sess-4.log');
    expect(existsSync(logPath)).toBe(false);
  });

  test('tick: strips ANSI and appends timestamped block to .log, then truncates .raw', () => {
    const { mgr, dataDir } = makeManager();
    const rawPath = join(dataDir, 'sessionlog', 'sess-5.raw');
    writeFileSync(rawPath, '\x1b[32mhello world\x1b[0m\n');
    mgr.startCapture('sess-5', 'cm-00000002');
    mgr._offsets.set('sess-5', 0);
    mgr.tick();
    const logPath = join(dataDir, 'sessionlog', 'sess-5.log');
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, 'utf8');
    expect(logContent).toMatch(/--- \d{4}-\d{2}-\d{2}/); // timestamp marker
    expect(logContent).toContain('hello world');
    expect(logContent).not.toMatch(/\x1b\[/); // ANSI stripped
    // .raw should be truncated
    const rawContent = readFileSync(rawPath, 'utf8');
    expect(rawContent).toBe('');
  });

  test('tailLog returns null when log does not exist', () => {
    const { mgr } = makeManager();
    expect(mgr.tailLog('nonexistent')).toBeNull();
  });

  test('tailLog returns last N lines', () => {
    const { mgr, dataDir } = makeManager();
    const logPath = join(dataDir, 'sessionlog', 'sess-6.log');
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i}`).join('\n');
    writeFileSync(logPath, lines);
    const tail = mgr.tailLog('sess-6', 10);
    expect(tail).toHaveLength(10);
    expect(tail[tail.length - 1]).toBe('line 599');
  });

  test('status returns capturing flag and log size', () => {
    const { mgr, dataDir } = makeManager();
    mgr.startCapture('sess-7', 'cm-99887766');
    const logPath = join(dataDir, 'sessionlog', 'sess-7.log');
    writeFileSync(logPath, 'some content\n');
    const s = mgr.status('sess-7');
    expect(s.capturing).toBe(true);
    expect(s.logSizeBytes).toBeGreaterThan(0);
    expect(s.lastActivity).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
node --experimental-vm-modules node_modules/.bin/jest tests/unit/SessionLogManager.test.js --runInBand
```

Expected: All 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add tests/unit/SessionLogManager.test.js
git commit -m "test: add unit tests for SessionLogManager"
```

---

## Task 3: Hook SessionLogManager into TmuxSession

**Files:**
- Modify: `lib/sessions/TmuxSession.js`

The `sessionLogManager` is passed in the constructor opts and stored as `this._sessionLog`. Each session event hook calls the appropriate sessionLog methods. All calls are guarded with `?.` so no existing behavior changes when sessionLogManager is absent.

- [ ] **Step 1: Update TmuxSession constructor**

In `lib/sessions/TmuxSession.js`, change the constructor signature from:
```javascript
constructor(meta, store, { cols = 120, rows = 30 } = {}) {
```
to:
```javascript
constructor(meta, store, { cols = 120, rows = 30, sessionLogManager = null } = {}) {
```

And add inside the constructor body (after `this._previewBuffer = ...`):
```javascript
/** @type {import('../sessionlog/SessionLogManager.js').SessionLogManager|null} */
this._sessionLog = sessionLogManager;
```

- [ ] **Step 2: Hook `_attachPty` — startCapture + PTY:ATTACH**

In `_attachPty()`, after `this.pty = ptyProcess;` and before `this._wirePty();`, add:

```javascript
this._sessionLog?.startCapture(this.meta.id, this.meta.tmuxName);
this._sessionLog?.injectEvent(this.meta.id, 'PTY:ATTACH', `tmuxName=${this.meta.tmuxName}`);
```

Full `_attachPty` end section:
```javascript
    this.pty = ptyProcess;
    this._sessionLog?.startCapture(this.meta.id, this.meta.tmuxName);
    this._sessionLog?.injectEvent(this.meta.id, 'PTY:ATTACH', `tmuxName=${this.meta.tmuxName}`);
    this._wirePty();
  }
```

- [ ] **Step 3: Hook `_wirePty` onExit — PTY:DETACH + SESSION:KILLED**

In `_wirePty()`, inside the `this.pty.onExit(...)` callback, add event injection. Change:

```javascript
    this.pty.onExit(() => {
      if (this.pty === ptyRef) this.pty = null;
      if (this.meta.status === STATES.RUNNING) {
        if (!this._tmuxSessionAlive()) {
          this._setState(STATES.STOPPED);
          this.store.upsert(this.meta).catch(() => {});
        }
        // If tmux alive, PTY just detached — stay RUNNING
      }
    });
```

to:

```javascript
    this.pty.onExit(() => {
      if (this.pty === ptyRef) this.pty = null;
      if (this.meta.status === STATES.RUNNING) {
        const tmuxAlive = this._tmuxSessionAlive();
        this._sessionLog?.injectEvent(
          this.meta.id, 'PTY:DETACH',
          `tmuxName=${this.meta.tmuxName}, wasRunning=true`
        );
        if (!tmuxAlive) {
          this._sessionLog?.injectEvent(
            this.meta.id, 'SESSION:KILLED',
            `tmuxName=${this.meta.tmuxName}`
          );
          this._setState(STATES.STOPPED);
          this.store.upsert(this.meta).catch(() => {});
        }
        // If tmux alive, PTY just detached — stay RUNNING
      }
    });
```

- [ ] **Step 4: Hook `stop()` — SESSION:STOP + stopCapture**

In `stop()`, before the `tmux kill-session` execSync block, add:

```javascript
    this._sessionLog?.injectEvent(this.meta.id, 'SESSION:STOP', 'reason=explicit');
    if (this.meta.tmuxName) {
      this._sessionLog?.stopCapture(this.meta.id, this.meta.tmuxName);
    }
```

Full `stop()` beginning:
```javascript
  stop() {
    // Allow stop from any live state
    if (this.pty) {
      try { this.pty.kill(); } catch { /* ignore */ }
      this.pty = null;
    }

    this._sessionLog?.injectEvent(this.meta.id, 'SESSION:STOP', 'reason=explicit');
    if (this.meta.tmuxName) {
      this._sessionLog?.stopCapture(this.meta.id, this.meta.tmuxName);
    }

    if (this.meta.tmuxName) {
      try {
        execSync(
          `tmux kill-session -t ${JSON.stringify(this.meta.tmuxName)} 2>/dev/null`,
```

- [ ] **Step 5: Hook `refresh()` — SESSION:REFRESH and SESSION:RESUME**

In `refresh()`, in the tmux-alive path (after `if (this._tmuxSessionAlive()) {`), before the `if (this.pty) {` block, add:

```javascript
      this._sessionLog?.injectEvent(this.meta.id, 'SESSION:REFRESH', `tmuxAlive=true`);
```

In the tmux-dead path, before `await this.start(claudeCmd, authEnv);`, add:

```javascript
    this._sessionLog?.injectEvent(this.meta.id, 'SESSION:RESUME', `claudeCmd=${claudeCmd}`);
```

Full `refresh()` method after changes:
```javascript
  async refresh(claudeCmd, authEnv = {}, { cols, rows } = {}) {
    if (cols) this._cols = cols;
    if (rows) this._rows = rows;

    if (this._tmuxSessionAlive()) {
      this._sessionLog?.injectEvent(this.meta.id, 'SESSION:REFRESH', 'tmuxAlive=true');
      // ── Tmux alive path: detach + re-attach ──
      if (this.pty) {
        try { this.pty.kill(); } catch { /* ignore */ }
        this.pty = null;
      }
      this._attachPty();
      if (this.meta.status !== STATES.RUNNING) {
        this.meta.status = STATES.RUNNING;
      }
      this.emit('stateChange', { id: this.meta.id, state: STATES.RUNNING });
      await this.store.upsert(this.meta);
      return;
    }

    // ── Tmux dead path: recreate tmux session with --resume ──
    if (this.meta.status !== STATES.STOPPED && this.meta.status !== STATES.ERROR) {
      this.meta.status = STATES.STOPPED;
    }
    this._sessionLog?.injectEvent(this.meta.id, 'SESSION:RESUME', `claudeCmd=${claudeCmd}`);
    await this.start(claudeCmd, authEnv);
  }
```

- [ ] **Step 6: Run existing TmuxSession unit tests to verify no regressions**

```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/TmuxSession.test.js --runInBand
```

Expected: All existing tests pass (sessionLogManager defaults to null so all `?.` guards are no-ops).

- [ ] **Step 7: Commit**

```bash
git add lib/sessions/TmuxSession.js
git commit -m "feat: hook SessionLogManager into TmuxSession session event points"
```

---

## Task 4: Update SessionManager to wire SessionLogManager

**Files:**
- Modify: `lib/sessions/SessionManager.js`

- [ ] **Step 1: Add sessionLogManager to constructor opts**

In the constructor, change:
```javascript
constructor(projectStore, settingsStore, { dataDir } = {}) {
```
to:
```javascript
constructor(projectStore, settingsStore, { dataDir, sessionLogManager = null } = {}) {
```

Add after `this.settingsStore = settingsStore || null;`:
```javascript
/** @type {import('../sessionlog/SessionLogManager.js').SessionLogManager|null} */
this.sessionLogManager = sessionLogManager || null;
```

- [ ] **Step 2: Pass sessionLogManager to TmuxSession in `init()`**

In `init()`, change:
```javascript
const session = new SessionClass(meta, this.store);
```
to:
```javascript
const opts = mode === 'tmux' ? { sessionLogManager: this.sessionLogManager } : {};
const session = new SessionClass(meta, this.store, opts);
```

- [ ] **Step 3: Inject SERVER:START after re-attaching running tmux sessions in `init()`**

In `init()`, inside the `else if (mode === 'tmux' && wasLive)` block, after `session._attachPty()` and the `if (!session.pty)` check (so only when PTY successfully attached), add the SERVER:START injection. Change:

```javascript
      } else if (mode === 'tmux' && wasLive) {
        // TmuxSession: try to re-attach PTY — _attachPty is idempotent
        try {
          session._attachPty();
          // _attachPty() returns silently (no throw) when tmux is dead.
          // Check that a PTY was actually created — if not, tmux is gone.
          if (!session.pty) {
            session.meta.status = STATES.STOPPED;
            await this.store.save(this.sessions);
          }
        } catch {
          session.meta.status = STATES.ERROR;
        }
      }
```

to:

```javascript
      } else if (mode === 'tmux' && wasLive) {
        // TmuxSession: try to re-attach PTY — _attachPty is idempotent
        try {
          session._attachPty();
          if (!session.pty) {
            session.meta.status = STATES.STOPPED;
            await this.store.save(this.sessions);
          } else {
            // PTY re-attached successfully — log server restart
            this.sessionLogManager?.injectEvent(
              meta.id, 'SERVER:START',
              `pid=${process.pid}, sessionCount=${records.length}`
            );
          }
        } catch {
          session.meta.status = STATES.ERROR;
        }
      }
```

> **Note:** `records` is in scope at this point in `init()` (it's the loaded records array). `records.length` gives the total session count.

- [ ] **Step 4: Pass sessionLogManager to TmuxSession in `_createTmux()`**

In `_createTmux()`, change:
```javascript
const session = new TmuxSession(meta, this.store, { cols, rows });
```
to:
```javascript
const session = new TmuxSession(meta, this.store, { cols, rows, sessionLogManager: this.sessionLogManager });
```

- [ ] **Step 5: Run SessionManager unit tests**

```bash
node --experimental-vm-modules node_modules/.bin/jest tests/unit/SessionManager.test.js --runInBand
```

Expected: All existing tests pass.

- [ ] **Step 6: Commit**

```bash
git add lib/sessions/SessionManager.js
git commit -m "feat: wire SessionLogManager into SessionManager — inject, pass to TmuxSession"
```

---

## Task 5: Add API endpoints in `lib/api/routes.js`

**Files:**
- Modify: `lib/api/routes.js`

The `createRouter` factory already accepts `deps`. Add `sessionLog` to the deps destructure and add 3 new route handlers.

- [ ] **Step 1: Add sessionLog to deps destructure**

Change:
```javascript
export function createRouter(deps = {}) {
  const router = Router();
  const { sessions, projects, settings, terminals, detector, todos, watchdog } = deps;
```
to:
```javascript
export function createRouter(deps = {}) {
  const router = Router();
  const { sessions, projects, settings, terminals, detector, todos, watchdog, sessionLog } = deps;
```

- [ ] **Step 2: Add sessionlog routes**

Add this block after the existing sessions routes (after the `GET /api/sessions/:id/scrollback/raw` handler, before the Settings section):

```javascript
  // ── Session Log ────────────────────────────────────────────────────────────

  /** GET /api/sessionlog/:id/tail?lines=N — last N lines of the .log file */
  router.get('/api/sessionlog/:id/tail', (req, res) => {
    if (!sessionLog) return res.status(503).json({ error: 'SessionLog not available' });
    const lines = parseInt(req.query.lines, 10) || 500;
    const result = sessionLog.tailLog(req.params.id, lines);
    if (result === null) return res.status(404).json({ error: 'No log yet' });
    res.json({ lines: result });
  });

  /** GET /api/sessionlog/:id/full — stream full .log file */
  router.get('/api/sessionlog/:id/full', (req, res) => {
    if (!sessionLog) return res.status(503).json({ error: 'SessionLog not available' });
    const logPath = sessionLog.logPath(req.params.id);
    if (!logPath) return res.status(404).json({ error: 'No log yet' });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="session-${req.params.id.slice(0, 8)}.log"`
    );
    res.sendFile(logPath);
  });

  /** GET /api/sessionlog/:id/status — capture status and log size */
  router.get('/api/sessionlog/:id/status', (req, res) => {
    if (!sessionLog) return res.status(503).json({ error: 'SessionLog not available' });
    res.json(sessionLog.status(req.params.id));
  });
```

- [ ] **Step 3: Commit**

```bash
git add lib/api/routes.js
git commit -m "feat: add /api/sessionlog/:id/tail, /full, /status endpoints"
```

---

## Task 6: Wire SessionLogManager in `server.js`

**Files:**
- Modify: `server.js`

- [ ] **Step 1: Import SessionLogManager and create instance**

After the existing imports (before the `// ── Initialize stores and managers` comment), add:

```javascript
import { SessionLogManager } from './lib/sessionlog/SessionLogManager.js';
```

After the `const DATA_DIR = ...` line, add:

```javascript
const sessionLog = new SessionLogManager({ dataDir: DATA_DIR });
```

- [ ] **Step 2: Pass sessionLog to SessionManager and createRouter**

Change:
```javascript
const sessions = new SessionManager(projects, settings, { dataDir: DATA_DIR });
```
to:
```javascript
const sessions = new SessionManager(projects, settings, { dataDir: DATA_DIR, sessionLogManager: sessionLog });
```

Change:
```javascript
app.use('/', createRouter({ sessions, projects, settings, terminals, detector, todos, watchdog }));
```
to:
```javascript
app.use('/', createRouter({ sessions, projects, settings, terminals, detector, todos, watchdog, sessionLog }));
```

- [ ] **Step 3: Register 20-second tick after sessions.init()**

After `await sessions.init();`, add:

```javascript
setInterval(() => sessionLog.tick(), 20_000);
```

- [ ] **Step 4: Export sessionLog and sessions for crash-log wrapper**

At the end of `server.js`, after the `httpServer.listen(...)` call, add:

```javascript
export { sessionLog, sessions };
```

- [ ] **Step 5: Verify server starts without error (beta port)**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
PORT=3002 node server.js &
sleep 2
curl -s http://127.0.0.1:3002/api/sessions | head -c 100
kill %1
```

Expected: JSON response from the sessions endpoint.

- [ ] **Step 6: Commit**

```bash
git add server.js
git commit -m "feat: create SessionLogManager in server.js, wire 20s tick and exports"
```

---

## Task 7: Wire SERVER:CRASH in `server-with-crash-log.mjs`

**Files:**
- Modify: `server-with-crash-log.mjs`

The existing signal handlers (SIGTERM, SIGHUP) are registered before `await import('./server.js')`. We can't access `sessionLog`/`sessions` at registration time, so we use lazy module references populated after the import.

- [ ] **Step 1: Add lazy refs and update SIGTERM/SIGHUP handlers**

At the top of the file (after the existing variable declarations), add:

```javascript
let _sessionLog = null;
let _sessions = null;
```

Change the existing `SIGTERM` handler from:
```javascript
process.on('SIGTERM', () => {
  writeLogSync('SIGTERM received — server exiting (pid=' + process.pid + ')');
  process.exit(0);
});
```
to:
```javascript
process.on('SIGTERM', () => {
  writeLogSync('SIGTERM received — server exiting (pid=' + process.pid + ')');
  _injectCrash('SIGTERM');
  process.exit(0);
});
```

Change the existing `SIGHUP` handler similarly:
```javascript
process.on('SIGHUP', () => {
  writeLogSync('SIGHUP received — server exiting (pid=' + process.pid + ')');
  _injectCrash('SIGHUP');
  process.exit(0);
});
```

Add the helper function before the signal handlers:
```javascript
function _injectCrash(signal) {
  if (!_sessionLog || !_sessions) return;
  const details = `pid=${process.pid}, signal=${signal}`;
  try {
    for (const [id] of _sessions.sessions) {
      _sessionLog.injectEvent(id, 'SERVER:CRASH', details);
    }
  } catch { /* ignore errors during crash handling */ }
}
```

After `await import('./server.js')`, populate the lazy refs:
```javascript
const serverModule = await import('./server.js');
_sessionLog = serverModule.sessionLog;
_sessions = serverModule.sessions;
```

- [ ] **Step 2: Verify the file is syntactically correct**

```bash
node --check server-with-crash-log.mjs
```

Expected: No output (syntax OK).

- [ ] **Step 3: Commit**

```bash
git add server-with-crash-log.mjs
git commit -m "feat: inject SERVER:CRASH into all session logs on SIGTERM/SIGHUP"
```

---

## Task 8: Create `public/js/components/SessionLogPane.js`

**Files:**
- Create: `public/js/components/SessionLogPane.js`

This component polls `/api/sessionlog/:sessionId/tail?lines=500` every 3 seconds, appends only new lines, and auto-scrolls to the bottom when the user is already there.

- [ ] **Step 1: Write the component**

```javascript
// public/js/components/SessionLogPane.js
import { html } from 'htm/preact';
import { useState, useEffect, useRef, useCallback } from 'preact/hooks';

/**
 * SessionLogPane — polling log viewer for a session's .log file.
 * Renders in a resizable right panel inside SessionOverlay.
 *
 * @param {{ sessionId: string }} props
 */
export function SessionLogPane({ sessionId }) {
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef(null);
  const containerRef = useRef(null);
  const prevLineCount = useRef(0);

  const isAtBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, []);

  const fetchTail = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessionlog/${sessionId}/tail?lines=500`);
      if (res.status === 404) {
        setLines([]);
        setError(null);
        setLoading(false);
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const newLines = data.lines || [];
      const wasAtBottom = isAtBottom();
      setLines(newLines);
      prevLineCount.current = newLines.length;
      setError(null);
      if (wasAtBottom) {
        // Defer scroll until after render
        requestAnimationFrame(() => scrollToBottom());
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, [sessionId, isAtBottom, scrollToBottom]);

  useEffect(() => {
    fetchTail();
    const interval = setInterval(fetchTail, 3000);
    return () => clearInterval(interval);
  }, [fetchTail]);

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && lines.length > 0) scrollToBottom();
  }, [loading]);

  const containerStyle = `
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-base);
    border-left: 1px solid var(--border);
    overflow: hidden;
  `;

  const headerStyle = `
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    height: 32px;
    background: var(--bg-surface);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  `;

  const logBodyStyle = `
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 12px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-all;
  `;

  const downloadUrl = `/api/sessionlog/${sessionId}/full`;

  return html`
    <div style=${containerStyle}>
      <div style=${headerStyle}>
        <span style="font-size:12px;font-weight:600;color:var(--text-bright);">Session Log</span>
        <div style="flex:1;"></div>
        ${loading ? html`
          <span style="font-size:10px;color:var(--text-muted);">Loading…</span>
        ` : null}
        <a
          href=${downloadUrl}
          download
          style="font-size:11px;color:var(--text-muted);text-decoration:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
        >↓ Download</a>
      </div>

      <div ref=${containerRef} style=${logBodyStyle}>
        ${lines.length === 0 && !loading ? html`
          <span style="color:var(--text-muted);font-style:italic;">
            No log yet — waiting for session output…
          </span>
        ` : null}
        ${error ? html`
          <span style="color:var(--danger);">Error: ${error}</span>
        ` : null}
        ${lines.map((line, i) => {
          const isEvent = line.startsWith('===') && line.endsWith('===');
          const isTimestamp = line.startsWith('---') && line.includes('T') && line.endsWith('---');
          const color = isEvent
            ? 'var(--warning)'
            : isTimestamp
              ? 'var(--text-muted)'
              : 'var(--text-secondary)';
          return html`<div key=${i} style=${'color:' + color + ';'}>${line}</div>`;
        })}
        <div ref=${bottomRef}></div>
      </div>
    </div>
  `;
}
```

- [ ] **Step 2: Commit**

```bash
git add public/js/components/SessionLogPane.js
git commit -m "feat: add SessionLogPane — polling log viewer for session overlay"
```

---

## Task 9: Update `SessionOverlay.js` to add Log toggle

**Files:**
- Modify: `public/js/components/SessionOverlay.js`

Add a "Log" toggle button to the header. When active, the terminal body becomes a horizontal flex row with terminal left and `SessionLogPane` right (50/50 split).

- [ ] **Step 1: Add import for SessionLogPane**

At the top of `public/js/components/SessionOverlay.js`, add after the existing imports:

```javascript
import { SessionLogPane } from './SessionLogPane.js';
```

- [ ] **Step 2: Add showLog state**

Inside `SessionOverlay()`, after the `const isSplit = splitView.value;` line, add:

```javascript
const [showLog, setShowLog] = useState(false);
const toggleLog = () => setShowLog(v => !v);
```

Add `useState` to the existing preact/hooks import. The current import is:
```javascript
import { useRef } from 'preact/hooks';
```
Change to:
```javascript
import { useRef, useState } from 'preact/hooks';
```

- [ ] **Step 3: Add "Log" button to header actions**

In the `overlay-actions` div, before the existing "Split"/"Full" button, add:

```javascript
          <button
            onClick=${toggleLog}
            style=${btnStyle(showLog ? 'var(--bg-raised)' : 'transparent', showLog ? 'var(--accent)' : 'var(--text-secondary)')}
            title=${showLog ? 'Hide session log' : 'Show session log'}
          >
            Log
          </button>
```

- [ ] **Step 4: Wrap terminal body in conditional flex layout**

Change the `<!-- Terminal body -->` section from:

```javascript
      <!-- Terminal body -->
      <div
        id="session-overlay-terminal"
        style="flex: 1; min-height: 0; overflow: hidden; position: relative;"
      >
        <${TerminalPane} sessionId=${session.id} />
      </div>
```

to:

```javascript
      <!-- Terminal body (+ optional log split) -->
      <div style="flex: 1; min-height: 0; overflow: hidden; display: flex;">
        <div
          id="session-overlay-terminal"
          style=${'flex: 1; min-height: 0; overflow: hidden; position: relative;' + (showLog ? ' max-width: 50%;' : '')}
        >
          <${TerminalPane} sessionId=${session.id} />
        </div>
        ${showLog ? html`
          <div style="flex: 1; min-height: 0; min-width: 0;">
            <${SessionLogPane} sessionId=${session.id} />
          </div>
        ` : null}
      </div>
```

- [ ] **Step 5: Commit**

```bash
git add public/js/components/SessionOverlay.js
git commit -m "feat: add Log toggle to SessionOverlay — shows SessionLogPane split panel"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Task |
|---|---|
| `lib/sessionlog/SessionLogManager.js` — startCapture, stopCapture, injectEvent, tick | Task 1 |
| `_attachPty` → startCapture + PTY:ATTACH | Task 3, Step 2 |
| `_wirePty` onExit → PTY:DETACH + SESSION:KILLED | Task 3, Step 3 |
| `stop()` → SESSION:STOP + stopCapture | Task 3, Step 4 |
| `refresh()` tmux-alive → SESSION:REFRESH | Task 3, Step 5 |
| `refresh()` tmux-dead → SESSION:RESUME | Task 3, Step 5 |
| `SessionManager.init()` → SERVER:START on re-attach | Task 4, Step 3 |
| `server-with-crash-log.mjs` → SERVER:CRASH on SIGTERM/SIGHUP | Task 7 |
| `GET /api/sessionlog/:id/tail` | Task 5, Step 2 |
| `GET /api/sessionlog/:id/full` | Task 5, Step 2 |
| `GET /api/sessionlog/:id/status` | Task 5, Step 2 |
| `public/js/components/SessionLogPane.js` — polls tail every 3s | Task 8 |
| Wire 20s tick in server.js | Task 6, Step 3 |
| Wire SERVER:CRASH in server-with-crash-log.mjs | Task 7 |
| Log toggle in SessionOverlay | Task 9 |
| `.raw` two-file pattern, ANSI strip, timestamp blocks | Task 1 |
| No-new-content guard in tick | Task 1 (size <= lastOffset check) |
| Tail-anchored auto-scroll, appends only new lines | Task 8 |

**Placeholder scan:** None found. All steps contain exact code.

**Type consistency check:**
- `startCapture(sessionId, tmuxName)` — consistent across Task 1, 3, 4, 7
- `injectEvent(sessionId, event, details)` — consistent throughout
- `stopCapture(sessionId, tmuxName)` — consistent
- `tailLog(sessionId, lines)` → `{ lines: string[] }` — matches Task 5 route handler
- `logPath(sessionId)` → `string|null` — used in `/full` route with `res.sendFile`
- `status(sessionId)` → `{ capturing, logSizeBytes, lastActivity }` — matches `/status` route

**One gap found:** The design specifies `data/sessionlog/` should be gitignored. Add to `.gitignore`.

**Additional step:**

- [ ] **Gitignore the log directory**

```bash
echo 'data/sessionlog/' >> .gitignore
git add .gitignore
git commit -m "chore: gitignore data/sessionlog/ directory"
```
