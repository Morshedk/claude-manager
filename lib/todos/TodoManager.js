import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

// import.meta.dirname is Node 21+; use fileURLToPath fallback for Node 20
const _dirname = import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DATA_DIR = path.join(_dirname, '../../data');

// Strip ANSI escape sequences (same logic as client-side app.js)
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][AB012]/g, '')
    .replace(/\x1b[\[>?=]/g, '')
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '');
}

const SUMMARIZE_PROMPT = `You are summarizing a Claude CLI session's recent terminal activity. Extract:
1. A 1-2 sentence summary of what happened
2. A list of key actions taken (files modified, features added, bugs fixed, errors encountered)

Respond ONLY with JSON, no markdown fences: {"summary": "...", "keyActions": ["..."]}

Terminal output:
`;

const DERIVE_TODOS_PROMPT = `You are generating a TODO list for a developer who procrastinates on simple-but-annoying tasks.

Rules for TODO items:
- Break big tasks into the SMALLEST possible first step (e.g. "Open the AWS console and click IAM" not "Set up IAM roles")
- Give honest but encouraging time estimates (prefer "5m" or "15m" over "2h" — find the tiny first step)
- Identify the "just do this ONE thing" entry point for each task
- For blockers, be specific about what exactly is blocking
- Prioritize: high = blocking other work or urgent, medium = should do soon, low = nice to have

For each TODO, also generate a fun reward the user gets when they complete it:
- Type "fact": an interesting/surprising science or history fact
- Type "video_query": a specific YouTube search query for something satisfying or fun to watch (30-60 seconds, like "satisfying factory machines", "incredible engineering", "cute animals compilation")

Respond ONLY with JSON, no markdown fences:
{"items": [{"title": "...", "priority": "high|medium|low", "estimate": "5m|15m|30m|1h|2h", "blockedBy": null, "reward": {"type": "fact|video_query", "content": "..."}}]}

Recent session summaries for this project:
`;

export class TodoManager extends EventEmitter {
  /**
   * @param {object} projectStore - ProjectStore instance
   * @param {object} sessionManager - object with list() and getScrollback(sessionId)
   * @param {{ dataDir?: string, anthropicApiKey?: string }} [opts]
   */
  constructor(projectStore, sessionManager, { dataDir, anthropicApiKey } = {}) {
    super();
    this.projectStore = projectStore;
    this.sessionManager = sessionManager;
    this.anthropicApiKey = anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    this.todosDir = path.join(dataDir || DEFAULT_DATA_DIR, 'todos');
    this._ensureDir(this.todosDir);
  }

  _ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
  }

  _projectDir(projectId) {
    const dir = path.join(this.todosDir, projectId);
    this._ensureDir(dir);
    return dir;
  }

  _buildAuthEnv() {
    const env = { ...process.env, TERM: 'xterm-256color' };
    const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
      delete env.ANTHROPIC_API_KEY;
    }
    return env;
  }

  // --- Storage ---

  _loadSummaries(projectId) {
    try {
      const file = path.join(this._projectDir(projectId), 'summaries.json');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { sessions: {} };
    }
  }

  _saveSummaries(projectId, data) {
    const file = path.join(this._projectDir(projectId), 'summaries.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  _loadTodos(projectId) {
    try {
      const file = path.join(this._projectDir(projectId), 'todos.json');
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { updatedAt: null, items: [] };
    }
  }

  _saveTodos(projectId, data) {
    const file = path.join(this._projectDir(projectId), 'todos.json');
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  // --- Claude CLI spawning ---

  _callClaude(prompt) {
    return new Promise((resolve, reject) => {
      const child = execFile('claude', ['-p', '-', '--model', 'claude-opus-4-6', '--output-format', 'json'], {
        env: this._buildAuthEnv(),
        timeout: 90000,
        maxBuffer: 1024 * 1024,
      }, (err, stdout, stderr) => {
        if (err) return reject(err);
        try {
          const parsed = JSON.parse(stdout);
          // claude --output-format json wraps in {type, result}
          const text = parsed.result || parsed.content || stdout;
          // Try to parse the inner JSON from Claude's response
          if (typeof text === 'string') {
            // Extract JSON from response (Claude may wrap in markdown fences)
            const jsonMatch = text.match(/\{[\s\S]*\}/);
            if (jsonMatch) return resolve(JSON.parse(jsonMatch[0]));
          }
          resolve(parsed);
        } catch {
          // Try raw stdout as JSON
          try {
            const jsonMatch = stdout.match(/\{[\s\S]*\}/);
            if (jsonMatch) return resolve(JSON.parse(jsonMatch[0]));
          } catch {}
          reject(new Error('Failed to parse Claude response'));
        }
      });
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // --- Summarization ---

  async summarizeSession(sessionId) {
    const sessions = this.sessionManager.list();
    const sessionMeta = sessions.find(s => s.id === sessionId);
    if (!sessionMeta || !sessionMeta.projectId) return null;

    const scrollback = this.sessionManager.getScrollback(sessionId);
    if (!scrollback) return null;

    const stripped = stripAnsi(scrollback);
    const summaries = this._loadSummaries(sessionMeta.projectId);

    if (!summaries.sessions[sessionId]) {
      summaries.sessions[sessionId] = { lastSummarizedOffset: 0, entries: [] };
    }

    const sessionData = summaries.sessions[sessionId];
    const delta = stripped.slice(sessionData.lastSummarizedOffset);

    // Skip if too little new content
    if (delta.length < 500) return null;

    // Cap at 8000 chars (use the most recent portion)
    const text = delta.length > 8000 ? delta.slice(-8000) : delta;

    try {
      const result = await this._callClaude(SUMMARIZE_PROMPT + text);
      const entry = {
        id: uuidv4(),
        timestamp: new Date().toISOString(),
        sessionName: sessionMeta.name || sessionMeta.id,
        summary: result.summary || '',
        keyActions: result.keyActions || [],
      };

      sessionData.entries.push(entry);
      // Keep max 20 entries per session
      if (sessionData.entries.length > 20) {
        sessionData.entries = sessionData.entries.slice(-20);
      }
      sessionData.lastSummarizedOffset = stripped.length;

      this._saveSummaries(sessionMeta.projectId, summaries);
      return sessionMeta.projectId;
    } catch (err) {
      console.error(`[TodoManager] summarize failed for session ${sessionId}:`, err.message);
      return null;
    }
  }

  // --- TODO derivation ---

  async deriveTodos(projectId) {
    const summaries = this._loadSummaries(projectId);
    const allEntries = [];
    for (const sid of Object.keys(summaries.sessions)) {
      allEntries.push(...summaries.sessions[sid].entries);
    }

    if (allEntries.length === 0) return;

    // Use last 10 summaries for context
    const recent = allEntries
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, 10);

    try {
      const result = await this._callClaude(DERIVE_TODOS_PROMPT + JSON.stringify(recent, null, 2));
      const newItems = result.items || [];

      const existing = this._loadTodos(projectId);
      // Preserve manual items and completed auto items
      const manual = existing.items.filter(i => i.source === 'manual');
      const completedAuto = existing.items.filter(i => i.source === 'auto' && i.status === 'completed');

      const autoItems = newItems.map(item => ({
        id: uuidv4(),
        title: item.title,
        priority: item.priority || 'medium',
        estimate: item.estimate || '15m',
        blockedBy: item.blockedBy || null,
        status: 'pending',
        source: 'auto',
        reward: item.reward || { type: 'fact', content: 'You did it! That task is behind you now.' },
        createdAt: new Date().toISOString(),
        completedAt: null,
      }));

      const updated = {
        updatedAt: new Date().toISOString(),
        items: [...manual, ...completedAuto, ...autoItems],
      };

      this._saveTodos(projectId, updated);
      this.emit('todosUpdated', projectId);
    } catch (err) {
      console.error(`[TodoManager] deriveTodos failed for project ${projectId}:`, err.message);
    }
  }

  // --- Cron tick ---

  async tick() {
    const allSessions = this.sessionManager.list();
    const running = allSessions.filter(s => s.status === 'running' && s.projectId);

    // Group by project, summarize one session per project per tick
    const byProject = {};
    for (const s of running) {
      if (!byProject[s.projectId]) byProject[s.projectId] = [];
      byProject[s.projectId].push(s);
    }

    const updatedProjects = new Set();
    for (const [projectId, sessions] of Object.entries(byProject)) {
      // Pick the session with most scrollback activity (heuristic: first one)
      const session = sessions[0];
      const result = await this.summarizeSession(session.id);
      if (result) updatedProjects.add(projectId);
    }

    // Derive TODOs for projects that got new summaries
    for (const projectId of updatedProjects) {
      await this.deriveTodos(projectId);
    }
  }

  // --- CRUD ---

  getTodos(projectId) {
    return this._loadTodos(projectId);
  }

  getSummaries(projectId) {
    return this._loadSummaries(projectId);
  }

  addTodo(projectId, { title, priority, estimate, blockedBy }) {
    const data = this._loadTodos(projectId);
    const item = {
      id: uuidv4(),
      title,
      priority: priority || 'medium',
      estimate: estimate || '15m',
      blockedBy: blockedBy || null,
      status: 'pending',
      source: 'manual',
      reward: { type: 'fact', content: 'Nice work getting that done! Here\'s a fun fact: Honey never spoils. Archaeologists found 3000-year-old honey in Egyptian tombs that was still edible.' },
      createdAt: new Date().toISOString(),
      completedAt: null,
    };
    data.items.push(item);
    data.updatedAt = new Date().toISOString();
    this._saveTodos(projectId, data);
    this.emit('todosUpdated', projectId);
    return item;
  }

  updateTodo(projectId, todoId, updates) {
    const data = this._loadTodos(projectId);
    const item = data.items.find(i => i.id === todoId);
    if (!item) return null;

    if (updates.title !== undefined) item.title = updates.title;
    if (updates.priority !== undefined) item.priority = updates.priority;
    if (updates.estimate !== undefined) item.estimate = updates.estimate;
    if (updates.blockedBy !== undefined) item.blockedBy = updates.blockedBy;
    if (updates.status !== undefined) {
      item.status = updates.status;
      if (updates.status === 'completed') item.completedAt = new Date().toISOString();
    }

    data.updatedAt = new Date().toISOString();
    this._saveTodos(projectId, data);
    this.emit('todosUpdated', projectId);
    return item;
  }

  deleteTodo(projectId, todoId) {
    const data = this._loadTodos(projectId);
    data.items = data.items.filter(i => i.id !== todoId);
    data.updatedAt = new Date().toISOString();
    this._saveTodos(projectId, data);
    this.emit('todosUpdated', projectId);
  }

  getReward(projectId, todoId) {
    const data = this._loadTodos(projectId);
    const item = data.items.find(i => i.id === todoId);
    if (!item || !item.reward) return null;

    // If YouTube API key is configured and reward is a video query, resolve it
    if (item.reward.type === 'video_query' && process.env.YOUTUBE_API_KEY) {
      // Future: call YouTube Data API to get a real video URL
      // For now, construct a search URL that embeds the first result
      return {
        type: 'video_query',
        content: item.reward.content,
        searchUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(item.reward.content + ' shorts')}`,
      };
    }

    return item.reward;
  }
}
