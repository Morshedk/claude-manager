import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';

const IS_MAC = os.platform() === 'darwin';

/**
 * ProcessDetector — scans the system for running Claude Code processes,
 * tmux sessions, and collects system info for the watchdog.
 */
export class ProcessDetector {
  constructor(projectStore) {
    this.projectStore = projectStore;
    this.detected = [];
    this.managedPids = new Set();
  }

  registerManagedPid(pid) {
    this.managedPids.add(pid);
  }

  unregisterManagedPid(pid) {
    this.managedPids.delete(pid);
  }

  async scan() {
    try {
      // Find claude processes — macOS ps doesn't support --no-headers
      const psCmd = IS_MAC
        ? 'ps aux | grep -E "[c]laude" || true'
        : 'ps aux --no-headers 2>/dev/null | grep -E "[c]laude" || true';
      const raw = execSync(psCmd, { encoding: 'utf8', timeout: 5000 }).trim();

      if (!raw) {
        this.detected = [];
        return;
      }

      const processes = [];
      const lines = raw.split('\n').filter(Boolean);

      for (const line of lines) {
        // Skip the header line if present (macOS)
        if (line.startsWith('USER') || line.includes(' PID ')) continue;

        const parts = line.split(/\s+/);
        if (parts.length < 11) continue;

        const user = parts[0];
        const pid = parseInt(parts[1], 10);
        const cpu = parseFloat(parts[2]);
        const mem = parseFloat(parts[3]);
        const command = parts.slice(10).join(' ');

        // Skip our own managed PIDs
        if (this.managedPids.has(pid)) continue;

        // Try to get the working directory
        let cwd = '';
        try {
          if (IS_MAC) {
            // macOS: use lsof to find the cwd of the process
            cwd = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | grep ^n | cut -c2- || true`, {
              encoding: 'utf8',
              timeout: 2000,
            }).trim();
          } else {
            cwd = execSync(`readlink -f /proc/${pid}/cwd 2>/dev/null || true`, {
              encoding: 'utf8',
              timeout: 2000,
            }).trim();
          }
        } catch { /* ignore */ }

        // Try to match to a project
        const projects = this.projectStore.list();
        let matchedProject = null;
        for (const p of projects) {
          if (cwd && cwd.startsWith(p.path)) {
            matchedProject = { id: p.id, name: p.name };
            break;
          }
        }

        processes.push({
          pid,
          user,
          cpu,
          mem,
          command: command.slice(0, 200),
          cwd,
          matchedProject,
          detectedAt: new Date().toISOString(),
        });
      }

      this.detected = processes;
    } catch {
      // Don't crash on detection failure
    }
  }

  getDetected() {
    return this.detected;
  }

  getTmuxSessions() {
    try {
      const raw = execSync(
        'tmux list-sessions -F "#{session_name}\t#{session_created_string}" 2>/dev/null || true',
        { encoding: 'utf8', timeout: 3000 }
      ).trim();
      if (!raw) return [];

      const sessions = [];
      for (const line of raw.split('\n').filter(Boolean)) {
        const [name] = line.split('\t');
        if (!name) continue;
        let cwd = '';
        try {
          cwd = execSync(
            `tmux display-message -t ${JSON.stringify(name)} -p "#{pane_current_path}" 2>/dev/null || true`,
            { encoding: 'utf8', timeout: 2000 }
          ).trim();
        } catch { /* ignore */ }

        // Match to a project
        const projects = this.projectStore.list();
        let matchedProject = null;
        for (const p of projects) {
          if (cwd && cwd.startsWith(p.path)) {
            matchedProject = { id: p.id, name: p.name };
            break;
          }
        }

        sessions.push({ name, cwd, matchedProject });
      }
      return sessions;
    } catch {
      return [];
    }
  }

  /**
   * Auto-discover running Claude sessions and tmux sessions,
   * then create projects for any new working directories found.
   * Returns { created: [...], existing: [...] }
   */
  async autoDiscover() {
    // Collect unique cwds from Claude processes and tmux sessions
    await this.scan();
    const tmuxSessions = this.getTmuxSessions();
    const cwdSet = new Set();

    for (const proc of this.detected) {
      if (proc.cwd) cwdSet.add(proc.cwd);
    }
    for (const sess of tmuxSessions) {
      if (sess.cwd) cwdSet.add(sess.cwd);
    }

    // Normalize paths: strip trailing slashes for consistent comparison
    const normalize = p => (p && p.length > 1) ? p.replace(/\/+$/, '') : p;

    const existingProjects = this.projectStore.list();
    const existingPaths = new Set(existingProjects.map(p => normalize(p.path)));
    const created = [];
    const existing = [];

    for (const rawCwd of cwdSet) {
      const cwd = normalize(rawCwd);
      // Skip home dir itself, tmp dirs, and paths that don't exist
      if (!cwd || cwd === '/' || cwd === (process.env.HOME || '').replace(/\/+$/, '')) continue;
      try { if (!fs.statSync(cwd).isDirectory()) continue; } catch { continue; }

      // Check if already covered by an existing project
      if (existingPaths.has(cwd)) {
        existing.push(cwd);
        continue;
      }

      // Derive project name from directory basename
      const name = path.basename(cwd);
      try {
        const project = this.projectStore.create({ name, path: cwd });
        created.push(project);
        existingPaths.add(cwd);
      } catch { /* skip duplicates */ }
    }

    return { created, existing, scannedPaths: [...cwdSet] };
  }

  async getSystemInfo() {
    const uptime = os.uptime();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus().length;

    let diskUsage = '';
    try {
      diskUsage = execSync("df -h / | tail -1 | awk '{print $3 \"/\" $2 \" (\" $5 \")\"}'", {
        encoding: 'utf8',
        timeout: 3000,
      }).trim();
    } catch { /* ignore */ }

    return {
      uptime,
      loadAvg,
      totalMem,
      freeMem,
      usedMem: totalMem - freeMem,
      cpus,
      diskUsage,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
    };
  }
}
