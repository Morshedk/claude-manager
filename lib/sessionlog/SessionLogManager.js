// lib/sessionlog/SessionLogManager.js
import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, statSync, appendFileSync,
  openSync, readSync, closeSync, readFileSync,
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

  startCapture(sessionId, tmuxName) {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return; // silently skip invalid IDs (never reached in normal use)
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

  stopCapture(sessionId, tmuxName) {
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) return; // silently skip invalid IDs (never reached in normal use)
    try {
      execSync(
        `tmux pipe-pane -t ${JSON.stringify(tmuxName)}`,
        { timeout: 3000 }
      );
    } catch { /* ignore */ }
    this._capturing.delete(sessionId);
  }

  injectEvent(sessionId, event, details = '') {
    const logPath = join(this._logDir, `${sessionId}.log`);
    const ts = new Date().toISOString();
    const line = `\n=== ${event} | ${ts} | ${details.replace(/\n/g, ' ')} ===\n`;
    try {
      appendFileSync(logPath, line);
    } catch { /* ignore if dir missing */ }
  }

  tick() {
    for (const sessionId of this._capturing) {
      this._processSession(sessionId);
    }
  }

  get capturing() { return this._capturing; }

  _processSession(sessionId) {
    const rawPath = join(this._logDir, `${sessionId}.raw`);
    if (!existsSync(rawPath)) return;

    let fileSize;
    try { fileSize = statSync(rawPath).size; } catch { return; }

    const lastOffset = this._offsets.get(sessionId) || 0;
    if (fileSize <= lastOffset) return;

    let content;
    try {
      const bytesToRead = fileSize - lastOffset;
      const buf = Buffer.alloc(bytesToRead);
      const fd = openSync(rawPath, 'r');
      let bytesRead;
      try {
        bytesRead = readSync(fd, buf, 0, bytesToRead, lastOffset);
      } finally {
        closeSync(fd);
      }
      content = buf.slice(0, bytesRead).toString('utf8');
    } catch { return; }

    const stripped = stripAnsi(content);
    const ts = new Date().toISOString();
    const logPath = join(this._logDir, `${sessionId}.log`);
    try {
      appendFileSync(logPath, `\n--- ${ts} ---\n${stripped}`);
    } catch { return; }

    this._offsets.set(sessionId, fileSize);
  }

  tailLog(sessionId, lines = 500) {
    const logPath = join(this._logDir, `${sessionId}.log`);
    if (!existsSync(logPath)) return null;
    try {
      const content = readFileSync(logPath, 'utf8');
      return content.split('\n').slice(-lines);
    } catch { return null; }
  }

  logPath(sessionId) {
    const p = join(this._logDir, `${sessionId}.log`);
    return existsSync(p) ? p : null;
  }

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
