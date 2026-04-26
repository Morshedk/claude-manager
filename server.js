import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { clientRegistry } from './lib/ws/clientRegistry.js';
import { MessageRouter } from './lib/ws/MessageRouter.js';
import { SessionHandlers } from './lib/ws/handlers/sessionHandlers.js';
import { makeTerminalHandlers } from './lib/ws/handlers/terminalHandlers.js';
import { makeSystemHandlers } from './lib/ws/handlers/systemHandlers.js';
import { createRouter } from './lib/api/routes.js';
import { ProjectStore } from './lib/projects/ProjectStore.js';
import { SettingsStore } from './lib/settings/SettingsStore.js';
import { SessionManager } from './lib/sessions/SessionManager.js';
import { TerminalManager } from './lib/terminals/TerminalManager.js';
import { ProcessDetector } from './lib/detector/ProcessDetector.js';
import { TodoManager } from './lib/todos/TodoManager.js';
import { WatchdogManager } from './lib/watchdog/WatchdogManager.js';
import { SessionLogManager } from './lib/sessionlog/SessionLogManager.js';
import fs from 'fs';
import { log } from './lib/logger/Logger.js';
import { health } from './lib/logger/health.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');

// ── Log subscriber registry (clients with Logs tab open) ────────────────────
const logSubscribers = {
  _clients: new Set(),
  add(clientId) { this._clients.add(clientId); },
  remove(clientId) { this._clients.delete(clientId); },
  broadcast(message) {
    for (const clientId of this._clients) {
      clientRegistry.send(clientId, message);
    }
  },
};

// ── Connection log — append-only JSONL for WS connect/disconnect/reconnect ───
const CONNECTION_LOG = join(DATA_DIR, 'connection-log.jsonl');
function logConnection(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  fs.appendFile(CONNECTION_LOG, line, () => {});
}

// ── Initialize stores and managers ───────────────────────────────────────────
const sessionLog = new SessionLogManager({ dataDir: DATA_DIR });
const projects = new ProjectStore(join(DATA_DIR, 'projects.json'));
const settings = new SettingsStore({ filePath: join(DATA_DIR, 'settings.json') });
const sessions = new SessionManager(projects, settings, { dataDir: DATA_DIR, sessionLogManager: sessionLog });
const terminals = new TerminalManager();
const detector = new ProcessDetector(projects);
const todos = new TodoManager(projects, sessions, { dataDir: DATA_DIR });
const watchdog = new WatchdogManager({ clientRegistry, sessionManager: sessions, detector, settingsStore: settings, todoManager: todos, dataDir: DATA_DIR });

// ── Initialize logger ────────────────────────────────────────────────────────
health.init(join(DATA_DIR, 'health.json'));
log.init({
  settingsStore: settings,
  logFile: join(DATA_DIR, 'app.log.jsonl'),
  health,
  logSubscribers,
});

// ── Initialize WS handlers ────────────────────────────────────────────────────
const sessionHandlers = new SessionHandlers(sessions, clientRegistry, { watchdogManager: watchdog, settingsStore: settings });
const terminalHandlers = makeTerminalHandlers(terminals, clientRegistry);
const systemHandlers = makeSystemHandlers({ settingsStore: settings, registry: clientRegistry });

const router = new MessageRouter({ sessionHandlers, terminalHandlers, systemHandlers });

// ── Express app ───────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(join(__dirname, 'public')));

// Mount API routes (routes include /api/ prefix, so mount at root)
app.use('/', createRouter({ sessions, projects, settings, terminals, detector, todos, watchdog, sessionLog }));

// Fallback: serve index.html for non-API routes
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

// ── HTTP + WebSocket server ───────────────────────────────────────────────────
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientId = clientRegistry.add(ws);
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[ws] client connected: ${clientId} from ${ip}`);
  logConnection({ event: 'connect', clientId, ip, totalClients: clientRegistry._clients.size });

  // Send init message with clientId, server version, and current vitals
  clientRegistry.send(clientId, {
    type: 'init',
    clientId,
    serverVersion: '2.03',
    serverEnv: process.env.NODE_ENV === 'production' ? 'PROD' : 'BETA',
    vitals: watchdog.getVitals(),
    logging: { levels: settings.getSync()?.logging?.levels || { default: 'warn' } },
  });

  // Send current sessions list so client can populate UI immediately
  clientRegistry.send(clientId, {
    type: 'sessions:list',
    sessions: sessions.list(),
  });

  ws.on('message', (data) => {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch (err) {
      console.warn('[ws] invalid JSON from client:', clientId);
      return;
    }

    if (message.type === 'client:reconnect') {
      console.log(`[ws] client reconnect report: ${clientId} attempt=${message.attempt} trigger=${message.trigger} downtime=${message.downtimeMs}ms lastClose=${message.lastCloseCode}`);
      logConnection({ event: 'reconnect', clientId, ip, ...message });
      return;
    }

    if (message.type === 'logs:subscribe') {
      logSubscribers.add(clientId);
      return;
    }
    if (message.type === 'logs:unsubscribe') {
      logSubscribers.remove(clientId);
      return;
    }
    if (message.type === 'log:client') {
      const entries = Array.isArray(message.entries) ? message.entries : [];
      const logFile = join(DATA_DIR, 'app.log.jsonl');
      for (const entry of entries) {
        try {
          const line = JSON.stringify({ ...entry, source: 'client' }) + '\n';
          fs.appendFileSync(logFile, line);
        } catch { /* non-fatal */ }
      }
      return;
    }

    router.route(clientId, message, clientRegistry);
  });

  ws.on('close', (code, reason) => {
    const client = clientRegistry.get(clientId);
    const subs = client ? [...client.subscriptions] : [];
    console.log(`[ws] client disconnected: ${clientId} (code=${code} reason=${reason||'none'} subs=${subs.length})`);
    logConnection({ event: 'disconnect', clientId, code, reason: reason || 'none', subscriptions: subs, totalClients: clientRegistry._clients.size - 1 });
    if (client) {
      for (const subId of client.subscriptions) {
        terminals.removeViewer(subId, clientId);
        sessions.unsubscribe(subId, clientId);
      }
    }
    logSubscribers.remove(clientId);
    clientRegistry.remove(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[ws] error for client ${clientId}:`, err.message);
    logConnection({ event: 'error', clientId, error: err.message });
    clientRegistry.remove(clientId);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
await sessions.init();
setInterval(() => sessionLog.tick(), 20_000);
watchdog.on('sessionsListChanged', () => sessionHandlers._broadcastSessionsList());
watchdog.start();

// ── Global error handlers ────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log.error('process', 'uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('process', 'unhandled promise rejection', { reason: String(reason) });
});

// ── EventEmitter error wiring ─────────────────────────────────────────────────
watchdog.on('error',  (err) => log.error('watchdog',  err.message, { stack: err.stack }));
sessions.on('error',  (err) => log.error('sessions',  err.message, { stack: err.stack }));
todos.on('error',     (err) => log.error('todos',     err.message, { stack: err.stack }));
// Note: TerminalManager does not extend EventEmitter — no error wiring needed

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] claude-web-app-v2 listening on http://127.0.0.1:${PORT}`);
});

export { sessionLog, sessions };
