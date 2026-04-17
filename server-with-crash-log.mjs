// Crash-trapping wrapper for server.js
// Used by F-lifecycle.test.js to capture unhandledRejections
import { createWriteStream, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logPath = process.env.CRASH_LOG || join(__dirname, 'crash.log');
const log = createWriteStream(logPath, { flags: 'a' });

function writeLog(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  log.write(line);
  process.stderr.write(line);
}

function writeLogSync(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { appendFileSync(logPath, line); } catch {}
  try { process.stderr.write(line); } catch {}
}

let _sessionLog = null;
let _sessions = null;

process.on('unhandledRejection', (reason) => {
  writeLog('UnhandledRejection: ' + (reason?.stack || String(reason)));
});

process.on('uncaughtException', (err) => {
  writeLog('UncaughtException: ' + err.stack);
  process.exit(1);
});

function _injectCrash(signal) {
  if (!_sessionLog || !_sessions) return;
  const details = `pid=${process.pid}, signal=${signal}`;
  try {
    for (const [id] of _sessions.sessions) {
      _sessionLog.injectEvent(id, 'SERVER:CRASH', details);
    }
  } catch { /* ignore errors during crash handling */ }
}

process.on('SIGTERM', () => {
  writeLogSync('SIGTERM received — server exiting (pid=' + process.pid + ')');
  _injectCrash('SIGTERM');
  process.exit(0);
});

process.on('SIGHUP', () => {
  writeLogSync('SIGHUP received — server exiting (pid=' + process.pid + ')');
  _injectCrash('SIGHUP');
  process.exit(0);
});

process.on('SIGINT', () => {
  writeLogSync('SIGINT received — server exiting (pid=' + process.pid + ')');
  process.exit(0);
});

process.on('exit', (code) => {
  writeLogSync(`Server process exiting with code ${code} (pid=${process.pid})`);
});

const serverModule = await import('./server.js');
_sessionLog = serverModule.sessionLog;
_sessions = serverModule.sessions;
