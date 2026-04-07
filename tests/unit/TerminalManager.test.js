/**
 * TerminalManager unit tests — ported from v1 tests/terminals.test.js
 *
 * node-pty is mocked so no real PTY is needed in CI.
 * The mock simulates data/exit events, write, resize, kill, and pid.
 */

import { TerminalManager, _setPty } from '../../lib/terminals/TerminalManager.js';

// ── Mock PTY factory ──────────────────────────────────────────────────────────

let _pidCounter = 1000;

function makeMockPty() {
  const pty = {
    pid: ++_pidCounter,
    _dataHandler: null,
    _exitHandler: null,
    _killed: false,
    _written: [],
    _cols: null,
    _rows: null,

    onData(fn) { this._dataHandler = fn; },
    onExit(fn) { this._exitHandler = fn; },
    write(data) { this._written.push(data); },
    resize(cols, rows) { this._cols = cols; this._rows = rows; },
    kill() { this._killed = true; if (this._exitHandler) this._exitHandler({ exitCode: 0 }); },

    /** test helper — emit output as if the shell produced it */
    emit(data) { if (this._dataHandler) this._dataHandler(data); },
    /** test helper — signal process exit */
    exit() { if (this._exitHandler) this._exitHandler({ exitCode: 0 }); },
  };
  return pty;
}

const mockPtyInstances = [];

const mockNodePty = {
  spawn(_shell, _args, _opts) {
    const pty = makeMockPty();
    mockPtyInstances.push(pty);
    return pty;
  },
};

// Install mock before any tests run
beforeAll(() => {
  _setPty(mockNodePty);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the most recently spawned mock PTY */
function lastPty() {
  return mockPtyInstances[mockPtyInstances.length - 1];
}

// ── Test lifecycle ─────────────────────────────────────────────────────────────

let mgr;

beforeEach(() => {
  mockPtyInstances.length = 0;
  mgr = new TerminalManager();
});

afterEach(() => {
  mgr.destroyAll();
});

// ── Creation ──────────────────────────────────────────────────────────────────

describe('TerminalManager - Creation', () => {
  test('creates a terminal and returns metadata', () => {
    const meta = mgr.create('t1', { cwd: '/tmp', cols: 80, rows: 24 });
    expect(meta).toMatchObject({
      id: 't1',
      cwd: '/tmp',
      alive: true,
    });
    expect(meta.pid).toBeGreaterThan(0);
    expect(meta.createdAt).toBeDefined();
  });

  test('throws when creating duplicate terminal id', () => {
    mgr.create('dup', { cwd: '/tmp' });
    expect(() => mgr.create('dup', { cwd: '/tmp' })).toThrow('Terminal dup already exists');
  });

  test('uses default cols/rows when not specified', () => {
    const meta = mgr.create('default', { cwd: '/tmp' });
    expect(meta.alive).toBe(true);
  });

  test('uses HOME when cwd not specified', () => {
    const meta = mgr.create('noCwd', {});
    expect(meta.alive).toBe(true);
  });

  test('stores projectId in metadata', () => {
    const meta = mgr.create('proj', { cwd: '/tmp', projectId: 'p123' });
    expect(meta.projectId).toBe('p123');
  });

  test('defaults projectId to null', () => {
    const meta = mgr.create('noProj', { cwd: '/tmp' });
    expect(meta.projectId).toBeNull();
  });
});

// ── Existence & Listing ───────────────────────────────────────────────────────

describe('TerminalManager - Queries', () => {
  test('exists returns true for existing terminal', () => {
    mgr.create('x', { cwd: '/tmp' });
    expect(mgr.exists('x')).toBe(true);
  });

  test('exists returns false for nonexistent terminal', () => {
    expect(mgr.exists('nope')).toBe(false);
  });

  test('list returns all terminals', () => {
    mgr.create('a', { cwd: '/tmp' });
    mgr.create('b', { cwd: '/tmp' });
    const listed = mgr.list();
    expect(listed).toHaveLength(2);
    expect(listed.map(t => t.id).sort()).toEqual(['a', 'b']);
  });

  test('list returns copies not references', () => {
    mgr.create('ref', { cwd: '/tmp' });
    const listed = mgr.list();
    listed[0].id = 'hacked';
    expect(mgr.list()[0].id).toBe('ref');
  });

  test('listForProject filters by projectId', () => {
    mgr.create('p1t1', { cwd: '/tmp', projectId: 'proj-A' });
    mgr.create('p1t2', { cwd: '/tmp', projectId: 'proj-A' });
    mgr.create('p2t1', { cwd: '/tmp', projectId: 'proj-B' });
    expect(mgr.listForProject('proj-A')).toHaveLength(2);
    expect(mgr.listForProject('proj-B')).toHaveLength(1);
    expect(mgr.listForProject('proj-C')).toHaveLength(0);
  });
});

// ── Scrollback ────────────────────────────────────────────────────────────────

describe('TerminalManager - Scrollback', () => {
  test('accumulates scrollback from PTY output', () => {
    mgr.create('sb', { cwd: '/tmp', cols: 80, rows: 24 });
    const pty = lastPty();
    pty.emit('hello ');
    pty.emit('world\n');
    expect(mgr.getScrollback('sb')).toBe('hello world\n');
  });

  test('getScrollback returns empty for nonexistent terminal', () => {
    expect(mgr.getScrollback('nope')).toBe('');
  });

  test('scrollback truncates at MAX_SCROLLBACK (500 000 chars)', () => {
    mgr.create('trunc', { cwd: '/tmp' });
    const pty = lastPty();
    // Emit 501 000 chars in one shot
    pty.emit('x'.repeat(501000));
    const sb = mgr.getScrollback('trunc');
    expect(sb.length).toBeLessThanOrEqual(500000);
  });
});

// ── Viewers ───────────────────────────────────────────────────────────────────

describe('TerminalManager - Viewers', () => {
  test('addViewer broadcasts output to callback', () => {
    mgr.create('v1', { cwd: '/tmp', cols: 80, rows: 24 });
    const pty = lastPty();
    let received = '';
    mgr.addViewer('v1', 'client1', (data) => { received += data; });
    pty.emit('viewer-test\n');
    expect(received).toBe('viewer-test\n');
  });

  test('removeViewer stops broadcasting', () => {
    mgr.create('v2', { cwd: '/tmp', cols: 80, rows: 24 });
    const pty = lastPty();
    let received = '';
    mgr.addViewer('v2', 'client2', (data) => { received += data; });
    mgr.removeViewer('v2', 'client2');
    pty.emit('should-not-receive\n');
    expect(received).toBe('');
  });

  test('addViewer on nonexistent terminal does nothing', () => {
    expect(() => mgr.addViewer('nope', 'c', () => {})).not.toThrow();
  });

  test('removeViewer on nonexistent terminal does nothing', () => {
    expect(() => mgr.removeViewer('nope', 'c')).not.toThrow();
  });

  test('multiple viewers receive same data', () => {
    mgr.create('mv', { cwd: '/tmp', cols: 80, rows: 24 });
    const pty = lastPty();
    let r1 = '', r2 = '';
    mgr.addViewer('mv', 'c1', (d) => { r1 += d; });
    mgr.addViewer('mv', 'c2', (d) => { r2 += d; });
    pty.emit('multi\n');
    expect(r1).toBe('multi\n');
    expect(r2).toBe('multi\n');
  });
});

// ── Write & Resize ────────────────────────────────────────────────────────────

describe('TerminalManager - Write & Resize', () => {
  test('write to nonexistent terminal does nothing', () => {
    expect(() => mgr.write('nope', 'data')).not.toThrow();
  });

  test('resize on nonexistent terminal does nothing', () => {
    expect(() => mgr.resize('nope', 80, 24)).not.toThrow();
  });

  test('resize on existing terminal succeeds', () => {
    mgr.create('rs', { cwd: '/tmp', cols: 80, rows: 24 });
    expect(() => mgr.resize('rs', 120, 40)).not.toThrow();
    const pty = lastPty();
    expect(pty._cols).toBe(120);
    expect(pty._rows).toBe(40);
  });

  test('write to alive terminal calls pty.write', () => {
    mgr.create('wr', { cwd: '/tmp' });
    const pty = lastPty();
    mgr.write('wr', 'hello\n');
    expect(pty._written).toContain('hello\n');
  });

  test('write to dead terminal does nothing', () => {
    mgr.create('dead', { cwd: '/tmp' });
    const pty = lastPty();
    pty.exit(); // triggers onExit → alive = false
    mgr.write('dead', 'hello');
    // write after exit should not reach pty
    expect(pty._written).toHaveLength(0);
  });
});

// ── Destruction ───────────────────────────────────────────────────────────────

describe('TerminalManager - Destruction', () => {
  test('destroy removes terminal', () => {
    mgr.create('d1', { cwd: '/tmp' });
    mgr.destroy('d1');
    expect(mgr.exists('d1')).toBe(false);
  });

  test('destroy calls pty.kill', () => {
    mgr.create('dk', { cwd: '/tmp' });
    const pty = lastPty();
    mgr.destroy('dk');
    expect(pty._killed).toBe(true);
  });

  test('destroy on nonexistent terminal does nothing', () => {
    expect(() => mgr.destroy('nope')).not.toThrow();
  });

  test('close is an alias for destroy', () => {
    mgr.create('cl', { cwd: '/tmp' });
    mgr.close('cl');
    expect(mgr.exists('cl')).toBe(false);
  });

  test('destroyAll removes all terminals', () => {
    mgr.create('da1', { cwd: '/tmp' });
    mgr.create('da2', { cwd: '/tmp' });
    mgr.destroyAll();
    expect(mgr.list()).toHaveLength(0);
  });
});
