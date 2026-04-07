import { describe, test, expect } from '@jest/globals';
import { ProcessDetector } from '../../lib/detector/ProcessDetector.js';
import os from 'os';

// Mock project store
function mockProjectStore(projects = []) {
  return { list: () => projects };
}

describe('ProcessDetector - Initialization', () => {
  test('starts with empty detected list', () => {
    const det = new ProcessDetector(mockProjectStore());
    expect(det.getDetected()).toEqual([]);
  });
});

describe('ProcessDetector - Managed PIDs', () => {
  test('register and unregister managed PIDs', () => {
    const det = new ProcessDetector(mockProjectStore());
    det.registerManagedPid(1234);
    det.registerManagedPid(5678);
    det.unregisterManagedPid(1234);
    // Internal check — managed PIDs are filtered during scan
    expect(det.managedPids.has(5678)).toBe(true);
    expect(det.managedPids.has(1234)).toBe(false);
  });

  test('unregistering nonexistent PID is safe', () => {
    const det = new ProcessDetector(mockProjectStore());
    expect(() => det.unregisterManagedPid(9999)).not.toThrow();
  });
});

describe('ProcessDetector - scan()', () => {
  test('scan runs without crashing', async () => {
    const det = new ProcessDetector(mockProjectStore());
    await expect(det.scan()).resolves.not.toThrow();
  });

  test('scan populates detected array', async () => {
    const det = new ProcessDetector(mockProjectStore());
    await det.scan();
    // May or may not find claude processes, but array should exist
    expect(Array.isArray(det.detected)).toBe(true);
  });

  test('scan filters managed PIDs', async () => {
    const det = new ProcessDetector(mockProjectStore());
    // Register current process PID as managed
    det.registerManagedPid(process.pid);
    await det.scan();
    const pids = det.getDetected().map(p => p.pid);
    expect(pids).not.toContain(process.pid);
  });

  test('detected processes have required fields', async () => {
    const det = new ProcessDetector(mockProjectStore());
    await det.scan();
    for (const proc of det.getDetected()) {
      expect(proc).toHaveProperty('pid');
      expect(proc).toHaveProperty('user');
      expect(proc).toHaveProperty('cpu');
      expect(proc).toHaveProperty('mem');
      expect(proc).toHaveProperty('command');
      expect(proc).toHaveProperty('cwd');
      expect(proc).toHaveProperty('detectedAt');
    }
  });

  test('scan matches processes to projects by cwd', async () => {
    const projects = [
      { id: 'p1', name: 'Test', path: '/home/claude-runner/apps/claude-web-app' },
    ];
    const det = new ProcessDetector(mockProjectStore(projects));
    await det.scan();
    // If any detected process has a matching cwd, it should have matchedProject
    for (const proc of det.getDetected()) {
      if (proc.cwd && proc.cwd.startsWith('/home/claude-runner/apps/claude-web-app')) {
        expect(proc.matchedProject).toMatchObject({ id: 'p1', name: 'Test' });
      }
    }
  });

  test('command is truncated to 200 chars', async () => {
    const det = new ProcessDetector(mockProjectStore());
    await det.scan();
    for (const proc of det.getDetected()) {
      expect(proc.command.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('ProcessDetector - getTmuxSessions()', () => {
  test('returns array (may be empty if no tmux)', () => {
    const det = new ProcessDetector(mockProjectStore());
    const sessions = det.getTmuxSessions();
    expect(Array.isArray(sessions)).toBe(true);
  });

  test('tmux sessions have name and cwd', () => {
    const det = new ProcessDetector(mockProjectStore());
    const sessions = det.getTmuxSessions();
    for (const s of sessions) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('cwd');
      expect(s).toHaveProperty('matchedProject');
    }
  });

  test('matches tmux sessions to projects', () => {
    const projects = [
      { id: 'p1', name: 'App', path: '/home/claude-runner/apps' },
    ];
    const det = new ProcessDetector(mockProjectStore(projects));
    const sessions = det.getTmuxSessions();
    for (const s of sessions) {
      if (s.cwd && s.cwd.startsWith('/home/claude-runner/apps')) {
        expect(s.matchedProject).toMatchObject({ id: 'p1' });
      }
    }
  });
});

describe('ProcessDetector - getSystemInfo()', () => {
  test('returns system info object', async () => {
    const det = new ProcessDetector(mockProjectStore());
    const info = await det.getSystemInfo();
    expect(info).toHaveProperty('uptime');
    expect(info).toHaveProperty('loadAvg');
    expect(info).toHaveProperty('totalMem');
    expect(info).toHaveProperty('freeMem');
    expect(info).toHaveProperty('usedMem');
    expect(info).toHaveProperty('cpus');
    expect(info).toHaveProperty('hostname');
    expect(info).toHaveProperty('platform');
  });

  test('uptime is positive', async () => {
    const det = new ProcessDetector(mockProjectStore());
    const info = await det.getSystemInfo();
    expect(info.uptime).toBeGreaterThan(0);
  });

  test('memory values are reasonable', async () => {
    const det = new ProcessDetector(mockProjectStore());
    const info = await det.getSystemInfo();
    expect(info.totalMem).toBeGreaterThan(0);
    expect(info.freeMem).toBeGreaterThanOrEqual(0);
    expect(info.usedMem).toBe(info.totalMem - info.freeMem);
  });

  test('loadAvg is array of 3', async () => {
    const det = new ProcessDetector(mockProjectStore());
    const info = await det.getSystemInfo();
    expect(info.loadAvg).toHaveLength(3);
  });

  test('cpus count is positive', async () => {
    const det = new ProcessDetector(mockProjectStore());
    const info = await det.getSystemInfo();
    expect(info.cpus).toBeGreaterThan(0);
    expect(info.cpus).toBe(os.cpus().length);
  });

  test('diskUsage is a non-empty string', async () => {
    const det = new ProcessDetector(mockProjectStore());
    const info = await det.getSystemInfo();
    expect(typeof info.diskUsage).toBe('string');
    // On Linux, df should work
    if (os.platform() === 'linux') {
      expect(info.diskUsage.length).toBeGreaterThan(0);
    }
  });
});
