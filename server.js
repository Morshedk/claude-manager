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

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = process.env.PORT || 3001;
const DATA_DIR = process.env.DATA_DIR || join(__dirname, 'data');

// ── Initialize stores and managers ───────────────────────────────────────────
const sessionLog = new SessionLogManager({ dataDir: DATA_DIR });
const projects = new ProjectStore(join(DATA_DIR, 'projects.json'));
const settings = new SettingsStore({ filePath: join(DATA_DIR, 'settings.json') });
const sessions = new SessionManager(projects, settings, { dataDir: DATA_DIR, sessionLogManager: sessionLog });
const terminals = new TerminalManager();
const detector = new ProcessDetector(projects);
const todos = new TodoManager(projects, sessions, { dataDir: DATA_DIR });
const watchdog = new WatchdogManager({ clientRegistry, sessionManager: sessions, detector, settingsStore: settings, todoManager: todos, dataDir: DATA_DIR });

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

wss.on('connection', (ws) => {
  const clientId = clientRegistry.add(ws);
  console.log(`[ws] client connected: ${clientId}`);

  // Send init message with clientId and server version
  clientRegistry.send(clientId, {
    type: 'init',
    clientId,
    serverVersion: '2.01',
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
    router.route(clientId, message, clientRegistry);
  });

  ws.on('close', (code, reason) => {
    console.log(`[ws] client disconnected: ${clientId} (code=${code} reason=${reason||'none'})`);
    // Clean up viewers on disconnect (both terminal and session subscriptions)
    const client = clientRegistry.get(clientId);
    if (client) {
      for (const subId of client.subscriptions) {
        terminals.removeViewer(subId, clientId);
        sessions.unsubscribe(subId, clientId);
      }
    }
    clientRegistry.remove(clientId);
  });

  ws.on('error', (err) => {
    console.error(`[ws] error for client ${clientId}:`, err.message);
    clientRegistry.remove(clientId);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
await sessions.init();
setInterval(() => sessionLog.tick(), 20_000);
watchdog.on('error', (err) => console.error('[watchdog] error:', err.message));
watchdog.start();

httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`[server] claude-web-app-v2 listening on http://127.0.0.1:${PORT}`);
});

export { sessionLog, sessions };
