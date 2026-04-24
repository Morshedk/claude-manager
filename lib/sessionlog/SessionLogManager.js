// lib/sessionlog/SessionLogManager.js
import { execSync } from 'child_process';
import {
  existsSync, mkdirSync, statSync, appendFileSync,
  openSync, readSync, closeSync, readFileSync,
} from 'fs';
import { join } from 'path';
import { stripAnsi } from '../utils/stripAnsi.js';

// Claude Code spinner/status lines that add no signal to the events pane.
// Matches: single spinner chars, "* Thinking…" status, token counts like "   8".
const SPINNER_RE = /^[\s✻✽✢·✶●○◆▶❯➜*]+([A-Z][a-z]+(ing|ed)(…|\.\.\.)?)?[\s\d]*$/;
function isSpinnerLine(t) {
  if (SPINNER_RE.test(t)) return true;
  if (/^\s*\d+\s*$/.test(t)) return true; // bare token count
  const nonWs = t.replace(/\s/g, '');
  // Cursor-movement artifact: leading whitespace + ≤3 non-whitespace chars.
  // Claude Code's in-place spinner animation uses cursor-up/cursor-right to update
  // characters at specific columns. pipe-pane captures every frame; after ANSI stripping
  // these become fragment lines like "       g" (7 spaces + partial letter from "Vibing…").
  // Exception: lines containing ⎿ are tool-result prefixes — always keep them.
  if (/^\s/.test(t) && nonWs.length <= 4 && !t.includes('⎿')) return true;
  // Spinner-prefixed fragment: starts with a spinner symbol but has ≤4 total non-whitespace
  // chars (e.g. "*     n", "✢  i  n" — partial words captured mid-animation frame).
  // Excludes ● (tool call prefix) and ❯ (input prompt) which have legitimate non-spinner uses.
  if (nonWs.length <= 4 && /^[✻✽✢·✶○◆▶➜*]/.test(t)) return true;
  return false;
}

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
      const allLines = content.split('\n');
      // Scan backward: markers (--- ts --- and === EVENT ===) are always included
      // regardless of how many spinner/noise lines follow them.
      // Non-marker content fills remaining slots up to `lines` total.
      const scanStart = Math.max(0, allLines.length - lines * 20);
      const window = allLines.slice(scanStart);
      const included = new Set();
      let contentSlots = lines;

      for (let i = window.length - 1; i >= 0; i--) {
        const t = window[i].trim();
        if (!t) continue;
        if (/^(---|===)/.test(t)) {
          included.add(i); // markers always included, never consume a content slot
        } else if (contentSlots > 0 && !isSpinnerLine(t)) {
          included.add(i);
          contentSlots--;
        }
      }

      return window.filter((_, i) => included.has(i));
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
