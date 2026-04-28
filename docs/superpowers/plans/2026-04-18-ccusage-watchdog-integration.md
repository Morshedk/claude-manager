# ccusage Watchdog Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `npx ccusage` on each watchdog tick to capture Claude API burn rate and billing block data, store snapshots in activity logs, surface them in the WatchdogPanel UI.

**Architecture:** `checkCcusage()` runs two parallel `execFile` calls (`blocks --json` and `daily --json`) each tick, rate-limited to 5 min minimum. Result stored on `_lastCreditSnapshot`, appended to each monitored session's activity log, added to `getSummary()`. WatchdogPanel polls `/api/watchdog/state` (already exists) and renders a Credit row.

**Tech Stack:** Node.js `child_process.execFile`, `npx ccusage`, existing WatchdogManager patterns, Preact/htm for UI.

---

## File Map

| File | Change |
|------|--------|
| `lib/watchdog/WatchdogManager.js` | Add `checkCcusage()`, wire into `tick()`, update constructor + `getSummary()` |
| `tests/unit/WatchdogManager.test.js` | Add tests for `checkCcusage()` and `getSummary()` credit snapshot field |
| `public/js/components/WatchdogPanel.js` | Fetch `/api/watchdog/state`, render Credit row |

No new files. No new API routes — `/api/watchdog/state` already returns `getSummary()`.

---

## Task 1: `checkCcusage()` — method + unit tests

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js` (constructor, new method)
- Test: `tests/unit/WatchdogManager.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `tests/unit/WatchdogManager.test.js` after the existing `getSummary` describe block:

```js
// ─── checkCcusage ─────────────────────────────────────────────────────────────

describe('WatchdogManager — checkCcusage', () => {
  test('returns null and records nothing when execFile errors', async () => {
    const wd = createWatchdog();
    // Stub execFile to error
    const origExecFile = (await import('child_process')).execFile;
    jest.spyOn(await import('child_process'), 'execFile')
      .mockImplementation((_cmd, _args, _opts, cb) => cb(new Error('not found'), '', ''));

    const result = await wd.checkCcusage();
    expect(result).toBeNull();
    expect(wd._lastCreditSnapshot).toBeNull();

    jest.restoreAllMocks();
    wd.stop();
  });

  test('parses blocks JSON and stores snapshot on _lastCreditSnapshot', async () => {
    const wd = createWatchdog();

    const fakeBlocksOutput = JSON.stringify({
      blocks: [{
        costUSD: 12.5,
        totalTokens: 5000000,
        isActive: true,
        burnRate: { costPerHour: 3.2 },
        projection: { totalCost: 15.0, remainingMinutes: 55 },
      }],
    });

    jest.spyOn(await import('child_process'), 'execFile')
      .mockImplementation((_cmd, args, _opts, cb) => {
        if (args.includes('blocks')) return cb(null, fakeBlocksOutput, '');
        return cb(null, JSON.stringify({ totals: { costUSD: 20.1 } }), '');
      });

    const result = await wd.checkCcusage();
    expect(result).not.toBeNull();
    expect(result.type).toBe('creditSnapshot');
    expect(result.block.costUSD).toBe(12.5);
    expect(result.block.burnRate.costPerHour).toBe(3.2);
    expect(result.block.projection.totalCost).toBe(15.0);
    expect(wd._lastCreditSnapshot).toBe(result);

    jest.restoreAllMocks();
    wd.stop();
  });

  test('respects 5-minute rate limit — skips if called too soon', async () => {
    const wd = createWatchdog();
    wd._lastCcusageCheck = Date.now() / 1000 - 60; // 1 min ago (< 5 min)

    const spy = jest.spyOn(await import('child_process'), 'execFile');
    const result = await wd.checkCcusage();
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();

    jest.restoreAllMocks();
    wd.stop();
  });

  test('getSummary includes lastCreditSnapshot field', () => {
    const wd = createWatchdog();
    const snap = { type: 'creditSnapshot', block: { costUSD: 5 }, timestamp: new Date().toISOString() };
    wd._lastCreditSnapshot = snap;
    const summary = wd.getSummary();
    expect(summary.lastCreditSnapshot).toBe(snap);
    wd.stop();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
npm test -- --testPathPattern=WatchdogManager 2>&1 | grep -E "FAIL|PASS|checkCcusage|✓|✗|×"
```

Expected: 4 new tests fail (method doesn't exist yet), 77 existing pass.

- [ ] **Step 3: Add `_lastCcusageCheck` and `_lastCreditSnapshot` to constructor**

In `lib/watchdog/WatchdogManager.js`, inside the constructor after `this._lastSuggestion = {}`:

```js
// ccusage credit snapshots
this._lastCcusageCheck = 0;
this._lastCreditSnapshot = null;
```

- [ ] **Step 4: Add `checkCcusage()` method**

Add after the `checkResources()` method (around line 528), before `killOrphanBuns()`:

```js
// ── ccusage credit snapshot ────────────────────────────────────────────────

async checkCcusage() {
  const CCUSAGE_MIN_INTERVAL_S = 300;
  const now = Date.now() / 1000;
  if (now - this._lastCcusageCheck < CCUSAGE_MIN_INTERVAL_S) return null;

  const runCcusage = (args) => new Promise((resolve) => {
    execFile('npx', ['--yes', 'ccusage', ...args, '--json', '--offline'], {
      env: { ...process.env },
      timeout: 30000,
      cwd: '/tmp',
    }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });

  try {
    const [blocksData, dailyData] = await Promise.all([
      runCcusage(['blocks']),
      runCcusage(['daily', '--since', new Date().toISOString().slice(0, 10).replace(/-/g, '')]),
    ]);

    if (!blocksData) return null;

    const activeBlock = (blocksData.blocks || []).find(b => b.isActive) ||
      (blocksData.blocks || []).slice(-1)[0] || null;

    const todayCostUSD = dailyData?.totals?.totalCost ?? null;

    const snapshot = {
      timestamp: new Date().toISOString(),
      type: 'creditSnapshot',
      block: activeBlock ? {
        costUSD: activeBlock.costUSD,
        totalTokens: activeBlock.totalTokens,
        isActive: activeBlock.isActive,
        burnRate: activeBlock.burnRate || null,
        projection: activeBlock.projection || null,
      } : null,
      todayCostUSD,
    };

    this._lastCcusageCheck = now;
    this._lastCreditSnapshot = snapshot;
    return snapshot;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Update `getSummary()` to include `lastCreditSnapshot`**

In `getSummary()`, add the field:

```js
getSummary() {
  return {
    lastTick: this._tickCount > 0 ? new Date().toISOString() : null,
    sessionCount: SESSIONS.length,
    creditState: this._creditState,
    lowPower: this._lowPower,
    tickCount: this._tickCount,
    lastCreditSnapshot: this._lastCreditSnapshot,
    sessions: Object.fromEntries(
      Object.entries(this._state).map(([name, st]) => [name, { ...st }])
    ),
  };
}
```

- [ ] **Step 6: Run tests — all 81 should pass**

```bash
npm test -- --testPathPattern=WatchdogManager 2>&1 | tail -10
```

Expected: `Tests: 81 passed, 81 total`

- [ ] **Step 7: Commit**

```bash
git add lib/watchdog/WatchdogManager.js tests/unit/WatchdogManager.test.js
git commit -m "feat: add checkCcusage() — billing block snapshot with rate limit"
```

---

## Task 2: Wire `checkCcusage()` into `tick()`

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js` (tick method)
- Test: `tests/unit/WatchdogManager.test.js`

- [ ] **Step 1: Write the failing test**

Add to `tests/unit/WatchdogManager.test.js` inside the existing `WatchdogManager — tick` describe block:

```js
test('tick calls checkCcusage and appends creditSnapshot to session logs', async () => {
  const fakeSnapshot = {
    timestamp: new Date().toISOString(),
    type: 'creditSnapshot',
    block: { costUSD: 9.5, totalTokens: 3000000, isActive: true, burnRate: { costPerHour: 2.1 }, projection: { totalCost: 11.0, remainingMinutes: 45 } },
    todayCostUSD: 22.3,
  };

  const wd = createWatchdog();
  wd.checkCcusage = jest.fn().mockResolvedValue(fakeSnapshot);
  wd.tmuxSessionExists = jest.fn().mockReturnValue(false);
  wd.killOrphanBuns = jest.fn();

  const notified = [];
  wd.sendTelegram = jest.fn().mockResolvedValue(true);

  await wd.tick();

  expect(wd.checkCcusage).toHaveBeenCalled();

  // Snapshot appended to each SESSIONS log
  for (const sess of SESSIONS) {
    const log = wd.getLog(sess.name);
    const snap = log.find(e => e.type === 'creditSnapshot');
    expect(snap).toBeDefined();
    expect(snap.block.costUSD).toBe(9.5);
  }

  wd.stop();
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
npm test -- --testPathPattern=WatchdogManager --testNamePattern="tick calls checkCcusage" 2>&1 | tail -10
```

Expected: FAIL — `checkCcusage` is not called from tick yet.

- [ ] **Step 3: Add ccusage call to `tick()` after the resource check block**

In `tick()`, after the resource check block (after `this.emit('resourceAlert', res)`), add:

```js
// ccusage credit snapshot (rate-limited internally to 5 min)
const creditSnap = await this.checkCcusage();
if (creditSnap) {
  for (const sess of SESSIONS) {
    this._appendLog(sess.name, { ...creditSnap, session: sess.name });
  }
  this.emit('creditSnapshot', creditSnap);
}
```

- [ ] **Step 4: Run all watchdog tests — should pass**

```bash
npm test -- --testPathPattern=WatchdogManager 2>&1 | tail -10
```

Expected: `Tests: 82 passed, 82 total`

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/WatchdogManager.js tests/unit/WatchdogManager.test.js
git commit -m "feat: wire checkCcusage into watchdog tick — appends creditSnapshot to activity logs"
```

---

## Task 3: WatchdogPanel credit display

**Files:**
- Modify: `public/js/components/WatchdogPanel.js`

- [ ] **Step 1: Add state and fetch for watchdog summary**

In `WatchdogPanel.js`, add `creditSnapshot` state and fetch from `/api/watchdog/state`:

Replace the existing state declarations and `useEffect` at the top of `WatchdogPanel()`:

```js
export function WatchdogPanel() {
  const [logs, setLogs] = useState([]);
  const [lastTick, setLastTick] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);
  const [creditSnapshot, setCreditSnapshot] = useState(null);

  const s = settings.value || {};
  const wdSettings = s.watchdog || {};
  const enabled = wdSettings.enabled !== false;

  useEffect(() => {
    loadLogs();
    loadSummary();
  }, []);

  async function loadSummary() {
    try {
      const data = await fetch('/api/watchdog/state').then(r => r.ok ? r.json() : null);
      if (data?.lastCreditSnapshot) setCreditSnapshot(data.lastCreditSnapshot);
      if (data?.lastTick) setLastTick(data.lastTick);
    } catch {}
  }

  async function loadLogs() {
    // ... existing loadLogs body unchanged ...
  }
```

- [ ] **Step 2: Add the Credit row to the status summary section**

In the status summary `<div>` (after the existing Model/Interval/LastTick/Thinking tiles), add a credit block. Insert after the `${wdSettings.defaultFlags ? ...}` line, before closing `</div>`:

```js
${creditSnapshot ? html`
  <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-top:2px;">
    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:6px;">Credits · ${timeAgo(creditSnapshot.timestamp)}</div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;">
      ${creditSnapshot.block ? html`
        <div style="flex:1;min-width:100px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Burn rate</div>
          <div style="font-size:13px;color:var(--text-primary);">$${(creditSnapshot.block.burnRate?.costPerHour || 0).toFixed(2)}/hr</div>
        </div>
        <div style="flex:1;min-width:100px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Block so far</div>
          <div style="font-size:13px;color:var(--text-primary);">$${(creditSnapshot.block.costUSD || 0).toFixed(2)}</div>
        </div>
        ${creditSnapshot.block.projection ? html`
          <div style="flex:1;min-width:100px;">
            <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Projected</div>
            <div style="font-size:13px;color:var(--warning);">$${creditSnapshot.block.projection.totalCost.toFixed(2)} (${creditSnapshot.block.projection.remainingMinutes}min left)</div>
          </div>
        ` : null}
      ` : html`<div style="font-size:12px;color:var(--text-muted);">No active block</div>`}
      ${creditSnapshot.todayCostUSD != null ? html`
        <div style="flex:1;min-width:100px;">
          <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Today</div>
          <div style="font-size:13px;color:var(--text-primary);">$${creditSnapshot.todayCostUSD.toFixed(2)}</div>
        </div>
      ` : null}
    </div>
  </div>
` : null}
```

- [ ] **Step 3: Update Refresh button to also call `loadSummary`**

Change the Refresh button onClick:

```js
<button
  onClick=${() => { loadLogs(); loadSummary(); }}
  style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);cursor:pointer;"
>Refresh</button>
```

- [ ] **Step 4: Commit**

```bash
git add public/js/components/WatchdogPanel.js
git commit -m "feat: show credit snapshot in WatchdogPanel — burn rate, block cost, projection, today"
```

---

## Task 4: Deploy to beta and verify

- [ ] **Step 1: Run full test suite**

```bash
npm test 2>&1 | tail -15
```

Expected: all suites pass.

- [ ] **Step 2: Reload beta**

```bash
pm2 reload claude-v2-beta
```

- [ ] **Step 3: Verify in browser**

Open the beta app → open a session → open WatchdogPanel. Confirm:
- Credit row appears (may show `—` if tick hasn't fired yet)
- Click Refresh — credit data loads if a tick has run

To force a tick immediately for testing, temporarily lower `intervalMinutes` to `1` in Settings, wait 1 min, check the panel.

- [ ] **Step 4: Check activity logs**

```bash
ls data/activity-logs/ && node -e "
const fs = require('fs');
const log = JSON.parse(fs.readFileSync('data/activity-logs/factory.json','utf8'));
const snap = log.filter(e => e.type === 'creditSnapshot');
console.log(JSON.stringify(snap.slice(-1), null, 2));
"
```

Expected: `creditSnapshot` entry with `block.costUSD`, `burnRate`, `projection`.

---

## Task 5: Release to prod

- [ ] **Step 1: Confirm beta is stable** — no errors in `pm2 logs claude-v2-beta --lines 50`

- [ ] **Step 2: Reload prod**

```bash
pm2 reload claude-v2-prod
```

- [ ] **Step 3: Verify prod WatchdogPanel shows credit data after next tick**

---

## Self-Review Checklist

- [x] **Spec coverage:** `checkCcusage()` ✓, hourly tick wiring ✓, `creditSnapshot` in activity logs ✓, WatchdogPanel display ✓, burn rate + projection + today ✓
- [x] **No placeholders** — all code blocks complete
- [x] **Type consistency** — `creditSnapshot.block.costUSD`, `burnRate.costPerHour`, `projection.totalCost/remainingMinutes` consistent across Task 1 → Task 2 → Task 3
- [x] **Rate limit** — `CCUSAGE_MIN_INTERVAL_S = 300` guards against sub-5min tick intervals
- [x] **`--offline` flag** — uses cached pricing data, avoids external fetch on every tick
