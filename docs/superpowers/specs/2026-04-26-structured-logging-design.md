# Structured Logging & Observability — Design Spec

**Date:** 2026-04-26  
**Status:** Approved for implementation planning

---

## Objectives

1. **Tell if features are working** — visible health state per subsystem, not just log entries
2. **Diagnose issues** — structured, filterable, correlated log entries that survive disconnection
3. **Safe rollout** — incremental migration, zero new dependencies, never crashes the server
4. **Runtime verbosity control** — adjustable per-tag from the Logs tab without restart

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  SERVER                                                      │
│                                                              │
│  lib/logger/Logger.js  (singleton)                           │
│    ├── levels: per-tag map  (e.g. ws=debug, watchdog=warn)   │
│    ├── safeSerialize() on all data payloads                  │
│    ├── writes → data/app.log.jsonl  (rotated 10MB × 3)       │
│    ├── writes → stdout  (PM2 captures)                       │
│    └── updates → data/health.json  on INFO+ signals          │
│                                                              │
│  lib/logger/health.js                                        │
│    └── tracks last-seen timestamps + 1h error counts         │
│        per subsystem: sessions, ws, watchdog, terminals      │
│                                                              │
│  /api/logs/tail?lines=N&level=X&tag=X                        │
│  /api/health                                                 │
│                                                              │
│  WS: receives  log:client  batch → writes to JSONL           │
│  POST /api/logs/client  (sendBeacon target — HTTP only)      │
│  WS: broadcasts  log:entry  to subscribed clients only       │
│  WS: broadcasts  log:level:changed  on settings change       │
└──────────────────────┬───────────────────────────────────────┘
                       │ WS  (when connected)
┌──────────────────────▼───────────────────────────────────────┐
│  BROWSER                                                     │
│                                                              │
│  public/js/logger/logger.js  (singleton)                     │
│    ├── per-tag levels  (mirrors server)                      │
│    ├── ring buffer: 500 entries  (always in memory)          │
│    ├── flushes buffer → log:client batch on connection:open  │
│    ├── sendBeacon → POST /api/logs/client on page unload     │
│    └── wraps console.*  (devtools still work)                │
│                                                              │
│  Logs tab  (third-space panel)                               │
│    ├── reads ring buffer  (works offline)                    │
│    ├── fetches last 200 lines on open via /api/logs/tail     │
│    ├── live-streams via log:entry  (after logs:subscribe)    │
│    ├── tag filter  |  source filter  |  live/pause           │
│    └── per-tag level controls  (writes to settings API)      │
└──────────────────────────────────────────────────────────────┘
```

---

## Log Entry Shape

Same schema on both sides:

```json
{
  "ts": "2026-04-26T21:00:00.000Z",
  "level": "error",
  "tag": "ws",
  "msg": "reconnect failed",
  "data": { "attempt": 3, "code": 1006, "sessionId": "cm-abc123" },
  "source": "server"
}
```

**Levels:** `error | warn | info | debug`  
**Tags:** `ws`, `sessions`, `watchdog`, `router`, `terminals`, `todos`, `api`, `process`, `app` (client-only)  
**source:** `server | client` — added by server when writing client batches  

---

## Server-side Logger (`lib/logger/Logger.js`)

### API

```js
log.error('ws', 'reconnect failed', { attempt, code, clientId })
log.warn('sessions', 'auto-resume failed', { sessionId })
log.info('watchdog', 'review complete', { sessions, todos, durationMs })
log.debug('router', 'routing message', { type, clientId })
```

### Level resolution

Levels stored in `settings.logging.levels` as a tag map:

```json
{
  "logging": {
    "levels": {
      "default": "warn",
      "ws": "warn",
      "watchdog": "warn"
    }
  }
}
```

On each write: check `levels[tag] ?? levels.default`. Read from SettingsStore in-memory cache — no file I/O per call. If the settings key doesn't exist, default is `warn`.

### safeSerialize()

Wraps all `data` payloads before writing:
- Truncates serialised output at 2KB
- Handles circular references via a seen-set
- Converts `Error` objects to `{ message, stack }`
- Never throws — returns `{ _serializeError: true }` on failure

### File rotation

On each write, if `app.log.jsonl` exceeds 10MB:
- Rename: `app.log.jsonl` → `app.log.1.jsonl` → `app.log.2.jsonl` → delete `app.log.3.jsonl`
- Done synchronously in try/catch — rotation failure never propagates

### Logger self-protection

Every write is wrapped in try/catch. On failure: fall back to `console.error` with the original message. The logger must never throw or crash the server.

### Global process error handlers (registered in `server.js`)

```js
process.on('uncaughtException', (err) => {
  log.error('process', 'uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  log.error('process', 'unhandled promise rejection', { reason: String(reason) });
});
```

### EventEmitter error wiring (`server.js`)

All EventEmitters that emit `'error'` get a handler routed through the logger:

```js
watchdog.on('error', (err) => log.error('watchdog', err.message, { stack: err.stack }));
sessions.on('error',  (err) => log.error('sessions',  err.message, { stack: err.stack }));
terminals.on('error', (err) => log.error('terminals', err.message, { stack: err.stack }));
todos.on('error',     (err) => log.error('todos',     err.message, { stack: err.stack }));
```

### Silent swallow rule

No `catch` block is silent. Every suppressed error gets at minimum:

```js
catch (err) { log.debug(tag, 'suppressed error', { error: err.message }) }
```

### Route handler errors

Every `routes.js` handler gets a try/catch that logs at ERROR and returns 500, rather than relying on Express default error handling.

---

## Feature Health State (`lib/logger/health.js`)

A lightweight module updated by the logger when INFO+ signals are written:

```json
{
  "ws":        { "lastConnect": "...", "lastDisconnect": "...", "errorCount1h": 0 },
  "sessions":  { "lastStart":   "...", "lastStop":       "...", "errorCount1h": 0 },
  "watchdog":  { "lastReview":  "...", "lastSweep":      "...", "errorCount1h": 0 },
  "terminals": { "lastSpawn":   "...", "errorCount1h": 0 },
  "updatedAt": "..."
}
```

- Written to `data/health.json` (in-memory, flushed async, not blocking)
- `errorCount1h` is a sliding window count reset on read if >1h old
- Exposed via `GET /api/health` — returns the current object
- TopBar reads `/api/health` on init and polls every 60s — shows a status dot (green/amber/red) per subsystem based on `errorCount1h` and last-seen age thresholds

**Health thresholds:**

| Subsystem | Amber | Red |
|---|---|---|
| watchdog.lastReview | >2h ago | >6h ago |
| sessions.lastStart | — | errorCount1h > 3 |
| ws.lastConnect | — | errorCount1h > 5 |

---

## Feature Health Signals

Explicit `log.info(...)` calls added at key feature boundaries (net-new lines, not replacements):

| Feature | Signal | Tag |
|---|---|---|
| WS client connected | `'client connected'` `{ clientId, totalClients }` | `ws` |
| WS client disconnected | `'client disconnected'` `{ clientId, code }` | `ws` |
| Reconnect success | `'reconnect success'` `{ attempt, downtimeMs }` | `ws` |
| Reconnect failing | `'reconnect failing'` `{ attempt, lastCode }` | `ws` |
| Session started | `'session started'` `{ id, mode, projectId }` | `sessions` |
| Session stopped | `'session stopped'` `{ id, exitCode }` | `sessions` |
| Watchdog review started | `'review started'` | `watchdog` |
| Watchdog review complete | `'review complete'` `{ sessions, todos, durationMs }` | `watchdog` |
| Sweep ran | `'sweep complete'` `{ archived }` | `watchdog` |
| Terminal spawned | `'terminal spawned'` `{ id }` | `terminals` |

---

## Correlation: sessionId / clientId in data

No `AsyncLocalStorage`. Instead, disciplined inclusion of context IDs in `data`:

- Session handlers always include `{ sessionId }` or `{ clientId }`
- WatchdogManager includes `{ sessName }` in review/sweep calls
- Route handlers include `{ path, method }`

This lets the Logs tab filter by `sessionId=cm-abc123` to trace all activity for a session.

---

## Client-side Logger (`public/js/logger/logger.js`)

### Ring buffer

500-entry circular array. At capacity, oldest entry is overwritten. Stored in module scope — survives WS disconnection. ~100KB max memory.

### Flush strategy

On `connection:open`:
1. Collect all entries not yet flushed (tracked by a `flushedUpTo` index)
2. Send as single `{ type: 'log:client', entries: [...] }` WS message
3. Advance `flushedUpTo` — entries stay in buffer for offline viewing but won't re-send

### sendBeacon fallback

On `window.beforeunload` (page close) and as a fallback for pre-WS boot errors:

```js
navigator.sendBeacon('/api/logs/client', JSON.stringify({ entries: buffer.unflushed() }))
```

`POST /api/logs/client` accepts the same batch format as the WS message. Tagged `source: 'client-beacon'` in the JSONL.

### Level sync

- `init` WS message includes `logging: { levels: {...} }`
- `log:level:changed` broadcast updates all tabs simultaneously
- Client applies same `levels[tag] ?? levels.default` resolution

### console.* wrapping

```js
const _console = { ...console };
log.error = (tag, msg, data) => {
  if (shouldLog('error', tag)) { writeEntry('error', tag, msg, data); }
  _console.error(`[${tag}] ${msg}`, data ?? '');
};
```

Devtools behaviour is unchanged.

### Global browser error handlers

```js
window.onerror = (msg, src, line, col, err) =>
  log.error('app', 'unhandled error', { msg, src, line, col, stack: err?.stack });

window.onunhandledrejection = (e) =>
  log.error('app', 'unhandled rejection', { reason: String(e.reason) });
```

---

## Logs Tab UI

Located in the third-space panel alongside Files and Todos.

### Layout

```
┌──────────────────────────────────────────────────────────┐
│ Logs                                                     │
│ ┌─────────────────────────────┬────────────────────────┐ │
│ │ tag: [all ▾]  src: [all ▾] │  ● live    [Clear]     │ │
│ └─────────────────────────────┴────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ 21:04:12  [ERROR]  ws        reconnect failed        │ │
│ │                              attempt=3 code=1006     │ │
│ │ 21:03:58  [WARN]   sessions  auto-resume failed      │ │
│ │                              id=cm-abc123            │ │
│ │ 21:03:45  [INFO]   watchdog  review complete         │ │
│ │                              sessions=4 dur=1.2s     │ │
│ └──────────────────────────────────────────────────────┘ │
│ ┌──────────────────────────────────────────────────────┐ │
│ │ Log levels:  ws [DEBUG▾]  sessions [WARN▾]           │ │
│ │              watchdog [WARN▾]  default [WARN▾]       │ │
│ └──────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Controls

- **Tag filter** — populated from tags seen in loaded entries + known tags
- **Source filter** — `all | server | client`
- **Live/Pause toggle** — pauses scrolling, keeps collecting. Dot indicator: green=live, grey=paused
- **Clear** — clears in-memory view only, does not delete JSONL
- **Per-tag level dropdowns** — bottom panel, writes to `settings.logging.levels` via settings API, broadcasts `log:level:changed` to all connected clients

### Entry rendering

- Level badge with colour: ERROR=red, WARN=amber, INFO=blue, DEBUG=grey
- `data` fields rendered as inline `key=value` pairs on line 2
- ERROR entries: subtle red left border
- Timestamps: `HH:MM:SS` visible, full ISO on hover
- Long `data` values truncated at 80 chars with expand-on-click

### Load sequence

1. Tab opens → send `logs:subscribe` WS message
2. Fetch `/api/logs/tail?lines=200` → populate history
3. Switch to live WS stream for new entries
4. Tab closes → send `logs:unsubscribe`

### Offline behaviour

When disconnected: show client ring buffer only, banner: `"disconnected — showing local buffer (N entries)"`. Per-tag level controls are disabled (greyed) while offline. On reconnect: flush buffer, refetch tail, resume live.

### WS subscription

Server only broadcasts `log:entry` to clients that have sent `logs:subscribe`. This avoids pushing DEBUG-level entries to all clients when nobody has the tab open.

---

## Settings Schema Addition

```json
{
  "logging": {
    "levels": {
      "default": "warn",
      "ws": "warn",
      "sessions": "warn",
      "watchdog": "warn",
      "router": "warn",
      "terminals": "warn",
      "todos": "warn",
      "api": "warn",
      "process": "warn"
    }
  }
}
```

Written by Logs tab UI via existing `settings:update` WS message. No new API endpoints needed for level changes.

---

## New API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/logs/tail?lines=N&level=X&tag=X` | Last N lines from JSONL, filtered |
| `GET /api/health` | Current health.json object |
| `POST /api/logs/client` | Accepts client log batch (sendBeacon target) |

---

## Migration Strategy

### Phase 1 — Infrastructure (no existing code touched)
- Ship `lib/logger/Logger.js`, `lib/logger/health.js`
- Ship `public/js/logger/logger.js`
- Wire global handlers in `server.js` and client entry point
- Add `/api/logs/tail`, `/api/health`, `POST /api/logs/client` to `routes.js`
- Add Logs tab UI (reads from initially-sparse JSONL)
- Add `logs:subscribe` / `logs:unsubscribe` WS message handling
- Deploy and verify tab loads without errors

### Phase 2 — Server migration (one file per commit)
Replace `console.*` per lib file, lowest-traffic first:
1. `SettingsStore.js`
2. `ProjectStore.js`
3. `SessionStore.js`
4. `MessageRouter.js`
5. `clientRegistry.js`
6. `TerminalManager.js`
7. `TodoManager.js`
8. `sessionHandlers.js`, `systemHandlers.js`, `terminalHandlers.js`
9. `SessionManager.js`, `DirectSession.js`, `TmuxSession.js`
10. `WatchdogManager.js`
11. `routes.js` (add try/catch wrappers)

### Phase 3 — Client migration
Replace `console.*` in all `public/js/` modules. Add `window.onerror` and `window.onunhandledrejection`.

### Phase 4 — Feature health signals
Add explicit `log.info(...)` calls at all feature boundaries listed above. These are net-new lines — no regression risk.

### Phase 5 — TopBar health dots
Wire `/api/health` polling into TopBar component. Add per-subsystem status dots.

---

## Safety Constraints

- Logger write failure never propagates — always falls back to `console.error`
- Default level is `warn` — no log flood on first deploy
- JSONL is append-only with rotation — no corruption risk to other data files
- Client batch flush is fire-and-forget — failures retry on next reconnect
- `safeSerialize()` on all data — no circular reference crashes
- Per-phase rollout — each phase is independently deployable and verifiable
- Phases 2–4 are pure additions or mechanical replacements — no logic changes

---

## Keeping Logs Current as the Product Evolves

Three mechanisms enforce this without relying on memory:

### 1. Pre-commit hook — new lib files must import the logger

A hook added to `.claude/hooks/` checks any new `lib/**/*.js` file being committed. If it doesn't contain `import.*logger` (or `require.*logger`), the commit is blocked with:

```
BLOCKED: lib/foo/Bar.js does not import the logger.
New server modules must use lib/logger/Logger.js instead of console.*.
```

This is the hardest gate — it catches the most common drift (new module added without logging).

### 2. CLAUDE.md convention — three rules for new features

Added to the development conventions section of `CLAUDE.md`:

```
## Logging conventions
- New lib modules: import log from '../logger/Logger.js', no bare console.*
- New user-facing feature: add at least one log.info() health signal at the
  feature boundary (start/complete/fail), and add the subsystem to health.js
  if it's a new domain
- New error path: log.error() or log.warn() with relevant context IDs
  (sessionId, clientId) in the data field
```

These are checked during code review (including by Claude itself during QA).

### 3. The existing changelog hook — prompts logging review on each push

The changelog-remind hook already fires on push. Its prompt is extended to include:

```
- Did any new features/paths get added without log signals?
- Does health.js cover all active subsystems?
```

This catches drift at the PR stage rather than post-deploy.
