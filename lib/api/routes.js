import express, { Router } from 'express';
import path from 'path';
import fs from 'fs';
import os from 'os';

// ── Security helpers ──────────────────────────────────────────────────────────

const SENSITIVE_PATTERNS = ['/.env', '/credentials', '/.ssh', '/secrets'];

function isPathSafe(requestedPath, allowedBases) {
  const resolved = path.resolve(requestedPath);
  for (const p of SENSITIVE_PATTERNS) {
    if (resolved.includes(p)) return false;
  }
  for (const base of allowedBases) {
    if (resolved.startsWith(path.resolve(base))) return true;
  }
  return false;
}

// ── Image helpers ─────────────────────────────────────────────────────────────

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']);
const MIME_MAP = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
};

// ── Telegram dir ──────────────────────────────────────────────────────────────

const TELEGRAM_DIR = path.join(process.env.HOME || '/home/claude-runner', '.claude', 'channels', 'telegram');

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * createRouter — factory for the REST API router.
 *
 * @param {{ sessions?, projects?, settings?, terminals?, detector?, todos?, watchdog? }} deps
 * @returns {Router}
 */
export function createRouter(deps = {}) {
  const router = Router();
  const { sessions, projects, settings, terminals, detector, todos, watchdog, sessionLog, dataDir } = deps;
  const DATA_DIR = dataDir || process.env.DATA_DIR || path.join(process.cwd(), 'data');

  // ── Projects ───────────────────────────────────────────────────────────────

  /** GET /api/projects — list all projects */
  router.get('/api/projects', (req, res) => {
    if (!projects) return res.json([]);
    res.json(projects.list());
  });

  /** POST /api/projects — create a project */
  router.post('/api/projects', (req, res) => {
    if (!projects) return res.status(503).json({ error: 'Projects not available' });
    try {
      const project = projects.create(req.body);
      res.status(201).json(project);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /** PUT /api/projects/:id — update a project */
  router.put('/api/projects/:id', (req, res) => {
    if (!projects) return res.status(503).json({ error: 'Projects not available' });
    try {
      const project = projects.update(req.params.id, req.body);
      res.json(project);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  /** DELETE /api/projects/:id — delete a project */
  router.delete('/api/projects/:id', (req, res) => {
    if (!projects) return res.status(503).json({ error: 'Projects not available' });
    try {
      projects.remove(req.params.id);
      res.json({ ok: true });
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  // ── Sessions ───────────────────────────────────────────────────────────────

  /** GET /api/sessions — list all sessions (managed + detected tmux) */
  router.get('/api/sessions', (req, res) => {
    const managed = sessions ? sessions.list() : [];
    // Merge live viewerCount from registry so clients can see connected-browser state
    if (sessions && sessions.getSessionRegistry) {
      const registry = sessions.getSessionRegistry();
      const byId = new Map(registry.map(r => [r.id, r.viewerCount]));
      for (const s of managed) s.viewerCount = byId.get(s.id) ?? 0;
    }
    const detected = detector ? detector.getDetected() : [];
    res.json({ managed, detected });
  });

  /** GET /api/sessions/:id/scrollback/raw — download raw scrollback */
  router.get('/api/sessions/:id/scrollback/raw', async (req, res) => {
    if (!sessions) return res.status(503).json({ error: 'Sessions not available' });
    try {
      const scrollback = await sessions.getScrollback(req.params.id);
      if (!scrollback) return res.status(404).send('');
      const buf = Buffer.isBuffer(scrollback)
        ? scrollback
        : Buffer.from(scrollback, 'binary');
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="pty-${req.params.id.slice(0, 8)}.bin"`);
      res.send(buf);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

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

  // ── Clipboard image paste ──────────────────────────────────────────────────

  /** POST /api/paste-image — save clipboard image to /tmp, return absolute path */
  router.post('/api/paste-image', express.raw({ type: 'image/*', limit: '20mb' }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'No image body' });
    }
    const mimeToExt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
    const mime = (req.headers['content-type'] || 'image/png').split(';')[0].trim();
    const ext = mimeToExt[mime] || 'png';
    const filename = `claude-paste-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const filePath = path.join(os.tmpdir(), filename);
    try {
      fs.writeFileSync(filePath, req.body);
      res.json({ path: filePath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Settings ───────────────────────────────────────────────────────────────

  /** GET /api/settings — get current settings */
  router.get('/api/settings', async (req, res) => {
    if (!settings) return res.json({});
    try {
      res.json(await settings.getAll());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** PUT /api/settings — update settings */
  router.put('/api/settings', async (req, res) => {
    if (!settings) return res.status(503).json({ error: 'Settings not available' });
    try {
      const updated = await settings.update(req.body);
      res.json(updated);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── File system ────────────────────────────────────────────────────────────

  /** GET /api/fs/dirs — autocomplete directories (?path=...) */
  router.get('/api/fs/dirs', (req, res) => {
    const { path: inputPath } = req.query;
    if (!inputPath) return res.json([]);
    try {
      const isTrailingSlash = inputPath.endsWith('/');
      const dir = isTrailingSlash ? inputPath : path.dirname(inputPath);
      const partial = isTrailingSlash ? '' : path.basename(inputPath).toLowerCase();
      if (!fs.existsSync(dir)) return res.json([]);
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name.toLowerCase().startsWith(partial))
        .map(e => path.join(dir, e.name))
        .slice(0, 12);
      res.json(dirs);
    } catch {
      res.json([]);
    }
  });

  /** GET /api/fs/ls — list directory (?path=...&projectPath=...) */
  router.get('/api/fs/ls', (req, res) => {
    const { path: inputPath, projectPath } = req.query;
    if (!inputPath || !projectPath) return res.status(400).json({ error: 'path and projectPath required' });
    const resolved = path.resolve(inputPath);
    const resolvedProject = path.resolve(projectPath);
    if (!resolved.startsWith(resolvedProject)) return res.status(403).json({ error: 'Access denied' });
    try {
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        return res.status(404).json({ error: 'Directory not found' });
      }
      const SKIP = new Set(['node_modules', '.git', '.next', '__pycache__', '.venv', 'dist', '.cache']);
      const entries = fs.readdirSync(resolved, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.') && !SKIP.has(e.name))
        .map(e => {
          const fullPath = path.join(resolved, e.name);
          try {
            const stat = fs.statSync(fullPath);
            return {
              name: e.name,
              type: e.isDirectory() ? 'dir' : 'file',
              size: stat.size,
              mtime: stat.mtime.toISOString(),
            };
          } catch { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json(items);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /api/fs/read — read file content (?path=...&projectPath=...) */
  router.get('/api/fs/read', (req, res) => {
    const { path: inputPath, projectPath } = req.query;
    if (!inputPath || !projectPath) return res.status(400).json({ error: 'path and projectPath required' });
    const resolved = path.resolve(inputPath);
    const resolvedProject = path.resolve(projectPath);
    if (!resolved.startsWith(resolvedProject)) return res.status(403).json({ error: 'Access denied' });
    try {
      if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      if (stat.size > 1024 * 1024) return res.status(413).json({ error: 'File too large (>1MB)' });
      const buf = fs.readFileSync(resolved);
      if (buf.slice(0, 512).includes(0)) return res.status(415).json({ error: 'Binary file' });
      res.type('text/plain').send(buf.toString('utf8'));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** GET /api/fs/image — serve image file (?path=...&projectPath=...) */
  router.get('/api/fs/image', (req, res) => {
    const { path: inputPath, projectPath } = req.query;
    if (!inputPath || !projectPath) return res.status(400).json({ error: 'path and projectPath required' });
    const resolved = path.resolve(inputPath);
    const resolvedProject = path.resolve(projectPath);
    if (!resolved.startsWith(resolvedProject)) return res.status(403).json({ error: 'Access denied' });
    try {
      if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'File not found' });
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      if (stat.size > 10 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (>10MB)' });
      const ext = path.extname(resolved).slice(1).toLowerCase();
      if (!IMAGE_EXTS.has(ext)) return res.status(415).json({ error: 'Not an image file' });
      res.type(MIME_MAP[ext] || 'application/octet-stream').sendFile(resolved);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Image upload ───────────────────────────────────────────────────────────

  /** POST /api/upload/image — upload image (base64 JSON body), save to /tmp, return path */
  router.post('/api/upload/image', express.json({ limit: '20mb' }), (req, res) => {
    const { data, ext } = req.body;
    if (!data || !ext) return res.status(400).json({ error: 'Missing data or ext' });
    const uploadDir = path.join(os.tmpdir(), 'claude-uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const filename = `img-${Date.now()}.${ext}`;
    const filepath = path.join(uploadDir, filename);
    fs.writeFileSync(filepath, Buffer.from(data, 'base64'));
    res.json({ path: filepath });
  });

  // ── TODOs ──────────────────────────────────────────────────────────────────

  /** GET /api/todos/:projectId — get todos for project */
  router.get('/api/todos/:projectId', (req, res) => {
    if (!todos) return res.json([]);
    res.json(todos.getTodos(req.params.projectId));
  });

  /** POST /api/todos/:projectId — add todo */
  router.post('/api/todos/:projectId', (req, res) => {
    if (!todos) return res.status(503).json({ error: 'Todos not available' });
    const { title, priority, estimate, blockedBy } = req.body;
    if (!title) return res.status(400).json({ error: 'Title is required' });
    const item = todos.addTodo(req.params.projectId, { title, priority, estimate, blockedBy });
    res.json(item);
  });

  /** PUT /api/todos/:projectId/:todoId — update todo */
  router.put('/api/todos/:projectId/:todoId', (req, res) => {
    if (!todos) return res.status(503).json({ error: 'Todos not available' });
    const item = todos.updateTodo(req.params.projectId, req.params.todoId, req.body);
    if (!item) return res.status(404).json({ error: 'Todo not found' });
    res.json(item);
  });

  /** DELETE /api/todos/:projectId/:todoId — delete todo */
  router.delete('/api/todos/:projectId/:todoId', (req, res) => {
    if (!todos) return res.status(503).json({ error: 'Todos not available' });
    todos.deleteTodo(req.params.projectId, req.params.todoId);
    res.json({ ok: true });
  });

  /** GET /api/todos/:projectId/:todoId/reward — get reward for completed todo */
  router.get('/api/todos/:projectId/:todoId/reward', (req, res) => {
    if (!todos) return res.status(503).json({ error: 'Todos not available' });
    if (settings && !settings.isFeatureEnabled?.('todoRewards')) {
      return res.status(404).json({ error: 'Rewards are disabled in settings' });
    }
    const reward = todos.getReward(req.params.projectId, req.params.todoId);
    if (!reward) return res.status(404).json({ error: 'No reward found' });
    res.json(reward);
  });

  /** GET /api/todos/:projectId/summaries — get session summaries */
  router.get('/api/todos/:projectId/summaries', (req, res) => {
    if (!todos) return res.json([]);
    const summaries = todos.getSummaries
      ? todos.getSummaries(req.params.projectId)
      : [];
    res.json(summaries);
  });

  // ── Watchdog ───────────────────────────────────────────────────────────────

  /** GET /api/watchdog/state — get watchdog state */
  router.get('/api/watchdog/state', (req, res) => {
    if (!watchdog) return res.json({});
    try {
      const state = watchdog.getSummary ? watchdog.getSummary() : watchdog._state || {};
      res.json(state);
    } catch {
      res.json({});
    }
  });

  /** GET /api/watchdog/logs — get recent activity logs */
  router.get('/api/watchdog/logs', (req, res) => {
    if (!watchdog) return res.json([]);
    try {
      const files = watchdog.getLogFiles ? watchdog.getLogFiles() : [];
      if (req.query.groupBy === 'project') {
        const grouped = {};
        for (const f of files) {
          const key = f.projectName || 'Unlinked';
          if (!grouped[key]) grouped[key] = [];
          grouped[key].push(f);
        }
        return res.json(grouped);
      }
      res.json(files);
    } catch {
      res.json([]);
    }
  });

  /** GET /api/watchdog/credit-history — rolling burn-rate and breakdown history */
  router.get('/api/watchdog/credit-history', (req, res) => {
    if (!watchdog) return res.json([]);
    try {
      res.json(watchdog.getCreditHistory());
    } catch {
      res.json([]);
    }
  });

  // ── System ─────────────────────────────────────────────────────────────────

  /** GET /api/system/info — system stats from ProcessDetector */
  router.get('/api/system/info', async (req, res) => {
    if (!detector) return res.json({});
    try {
      const info = await detector.getSystemInfo();
      res.json(info);
    } catch (e) {
      res.json({ error: e.message });
    }
  });

  // ── Telegram ───────────────────────────────────────────────────────────────

  /** GET /api/telegram/status — token configured + pending pairings */
  router.get('/api/telegram/status', (req, res) => {
    const hasToken = fs.existsSync(path.join(TELEGRAM_DIR, '.env'));
    const hasAccess = fs.existsSync(path.join(TELEGRAM_DIR, 'access.json'));
    let pending = {};
    let allowFrom = [];
    if (hasAccess) {
      try {
        const access = JSON.parse(fs.readFileSync(path.join(TELEGRAM_DIR, 'access.json'), 'utf8'));
        pending = access.pending || {};
        allowFrom = access.allowFrom || [];
        // Prune expired codes
        const now = Date.now();
        for (const [code, info] of Object.entries(pending)) {
          if (info.expiresAt && info.expiresAt < now) delete pending[code];
        }
      } catch { /* ignore corrupt file */ }
    }
    res.json({ configured: hasToken, hasToken, hasAccessPolicy: hasAccess, pending, allowFrom });
  });

  /** POST /api/telegram/configure — save bot token to settings */
  router.post('/api/telegram/configure', (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || !token.includes(':')) {
      return res.status(400).json({ error: 'Invalid bot token format. Expected format: 123456789:AABcd...' });
    }
    try {
      fs.mkdirSync(TELEGRAM_DIR, { recursive: true });
      fs.writeFileSync(path.join(TELEGRAM_DIR, '.env'), `TELEGRAM_BOT_TOKEN=${token}\n`, { mode: 0o600 });
      const accessPath = path.join(TELEGRAM_DIR, 'access.json');
      if (!fs.existsSync(accessPath)) {
        fs.writeFileSync(
          accessPath,
          JSON.stringify({ dmPolicy: 'pairing', allowFrom: [], pending: {} }, null, 2),
          { mode: 0o600 }
        );
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Logs / Health ──────────────────────────────────────────────────────────

  /** GET /api/logs/tail — return last N log entries with optional level/tag filtering */
  router.get('/api/logs/tail', (req, res) => {
    try {
      const lines = Math.min(parseInt(req.query.lines, 10) || 200, 1000);
      const levelFilter = req.query.level || null;
      const tagFilter = req.query.tag || null;
      const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
      const logFile = path.join(DATA_DIR, 'app.log.jsonl');
      if (!fs.existsSync(logFile)) return res.json([]);
      const raw = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
      const parsed = raw.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const filtered = parsed.filter(e => {
        if (levelFilter && LEVELS[e.level] > LEVELS[levelFilter]) return false;
        if (tagFilter && tagFilter !== 'all' && e.tag !== tagFilter) return false;
        return true;
      });
      res.json(filtered.slice(-lines));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** GET /api/health — return the current health.json contents */
  router.get('/api/health', (req, res) => {
    try {
      const healthFile = path.join(DATA_DIR, 'health.json');
      if (!fs.existsSync(healthFile)) return res.json({});
      res.json(JSON.parse(fs.readFileSync(healthFile, 'utf8')));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /** POST /api/logs/client — accept client log entries via sendBeacon */
  router.post('/api/logs/client', express.text({ type: '*/*', limit: '1mb' }), (req, res) => {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const entries = Array.isArray(body?.entries) ? body.entries : [];
      const logFile = path.join(DATA_DIR, 'app.log.jsonl');
      for (const entry of entries) {
        try {
          const line = JSON.stringify({ ...entry, source: 'client-beacon' }) + '\n';
          fs.appendFileSync(logFile, line);
        } catch { /* non-fatal */ }
      }
      res.status(204).end();
    } catch {
      res.status(204).end(); // always 204 — sendBeacon ignores the response
    }
  });

  return router;
}
