# Credit History & Session Breakdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add session-attributed cost breakdown and rolling burn-rate history to the watchdog, surfaced via a new API endpoint and a sparkline + breakdown UI in WatchdogPanel.

**Architecture:** `checkCcusage()` gets a third parallel call (`ccusage session`) to build a `breakdown` object (factory/watchdog/devV2/devV1/other). Each snapshot is appended to `data/credit-history.json` (200-entry rolling file). A new route `/api/watchdog/credit-history` serves this history. WatchdogPanel fetches it and renders breakdown tiles + an SVG burn-rate sparkline.

**Tech Stack:** Node.js ESM, Jest, Preact/htm, inline SVG — no new dependencies.

---

## File Map

| File | Change |
|------|--------|
| `lib/watchdog/WatchdogManager.js` | Add `buildBreakdown()`, `_creditHistoryFile()`, `_appendCreditHistory()`, `getCreditHistory()`; update `checkCcusage()` |
| `tests/unit/WatchdogManager.test.js` | Add tests for breakdown building, history append/cap/read |
| `lib/api/routes.js` | Add `GET /api/watchdog/credit-history` |
| `public/js/components/WatchdogPanel.js` | Add history fetch, breakdown tiles, SVG sparkline |

---

## Task 1: WatchdogManager — breakdown + credit history

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js`
- Test: `tests/unit/WatchdogManager.test.js`

- [ ] **Step 1: Write failing tests**

Add this describe block at the end of `tests/unit/WatchdogManager.test.js`:

```js
// ─── buildBreakdown ───────────────────────────────────────────────────────────

describe('WatchdogManager — buildBreakdown', () => {
  test('attributes sessions by sessionId prefix', () => {
    const sessions = [
      { sessionId: '-projects-niyyah', totalCost: 10 },
      { sessionId: '-tmp', totalCost: 5 },
      { sessionId: '-home-claude-runner-apps-claude-web-app-v2', totalCost: 8 },
      { sessionId: '-home-claude-runner-apps-claude-web-app', totalCost: 3 },
      { sessionId: '-home-claude-runner-scripts', totalCost: 1 },
    ];
    const result = WatchdogManager.buildBreakdown(sessions);
    expect(result.factory).toBeCloseTo(10);
    expect(result.watchdog).toBeCloseTo(5);
    expect(result.devV2).toBeCloseTo(8);
    expect(result.devV1).toBeCloseTo(3);
    expect(result.other).toBeCloseTo(1);
    expect(result.total).toBeCloseTo(27);
  });

  test('attributes subagent sessions by projectPath prefix', () => {
    const sessions = [
      { sessionId: 'subagents', projectPath: '-home-claude-runner-apps-claude-web-app-v2/abc', totalCost: 4 },
      { sessionId: 'subagents', projectPath: '-home-claude-runner-apps-claude-web-app/xyz', totalCost: 2 },
      { sessionId: 'subagents', projectPath: '-projects-niyyah/foo', totalCost: 6 },
    ];
    const result = WatchdogManager.buildBreakdown(sessions);
    expect(result.devV2).toBeCloseTo(4);
    expect(result.devV1).toBeCloseTo(2);
    expect(result.factory).toBeCloseTo(6);
    expect(result.total).toBeCloseTo(12);
  });

  test('returns all-zero breakdown for empty sessions', () => {
    const result = WatchdogManager.buildBreakdown([]);
    expect(result.total).toBe(0);
    expect(result.factory).toBe(0);
  });
});

// ─── credit history ───────────────────────────────────────────────────────────

describe('WatchdogManager — credit history', () => {
  test('getCreditHistory returns [] when file missing', () => {
    const wd = createWatchdog();
    expect(wd.getCreditHistory()).toEqual([]);
    wd.stop();
  });

  test('getCreditHistory filters out entries without timestamp', () => {
    const wd = createWatchdog();
    const file = path.join(tmpDir, 'credit-history.json');
    fs.writeFileSync(file, JSON.stringify([
      { timestamp: '2026-01-01T00:00:00.000Z', burnRateCostPerHour: 1 },
      { burnRateCostPerHour: 2 },  // missing timestamp — should be filtered
      null,
    ]));
    const result = wd.getCreditHistory();
    expect(result).toHaveLength(1);
    expect(result[0].burnRateCostPerHour).toBe(1);
    wd.stop();
  });

  test('_appendCreditHistory writes entry and caps at 200', () => {
    const wd = createWatchdog();
    // Write 201 entries
    for (let i = 0; i < 201; i++) {
      wd._appendCreditHistory({
        timestamp: new Date(Date.now() + i * 1000).toISOString(),
        block: { burnRate: { costPerHour: i }, costUSD: i },
        todayCostUSD: i,
        breakdown: { factory: 0, watchdog: 0, devV2: 0, devV1: 0, other: 0, total: 0 },
      });
    }
    const history = wd.getCreditHistory();
    expect(history.length).toBe(200);
    // Most recent entry should be #200 (0-indexed), i.e. burnRateCostPerHour: 200
    expect(history[history.length - 1].burnRateCostPerHour).toBe(200);
    wd.stop();
  });

  test('checkCcusage includes breakdown and appends to history', async () => {
    const wd = createWatchdog();
    const fakeSessionData = {
      sessions: [
        { sessionId: '-projects-niyyah', totalCost: 10, projectPath: '' },
        { sessionId: '-tmp', totalCost: 2, projectPath: '' },
      ],
    };
    wd._runCcusage = jest.fn().mockImplementation((args) => {
      if (args[0] === 'blocks') return Promise.resolve({
        blocks: [{ costUSD: 5, totalTokens: 1000, isActive: true, burnRate: { costPerHour: 1.5 }, projection: { totalCost: 6, remainingMinutes: 30 } }],
      });
      if (args[0] === 'daily') return Promise.resolve({ totals: { totalCost: 20 } });
      if (args[0] === 'session') return Promise.resolve(fakeSessionData);
      return Promise.resolve(null);
    });

    const result = await wd.checkCcusage();
    expect(result.breakdown).toBeDefined();
    expect(result.breakdown.factory).toBeCloseTo(10);
    expect(result.breakdown.watchdog).toBeCloseTo(2);
    expect(result.breakdown.total).toBeCloseTo(12);

    // History should have 1 entry
    const history = wd.getCreditHistory();
    expect(history).toHaveLength(1);
    expect(history[0].burnRateCostPerHour).toBe(1.5);
    expect(history[0].breakdown.factory).toBeCloseTo(10);
    wd.stop();
  });
});
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
npm test -- --testPathPattern=WatchdogManager 2>&1 | grep -E "FAIL|PASS|buildBreakdown|credit history|✓|✗|×" | head -20
```

Expected: new tests fail, 82 existing tests pass.

- [ ] **Step 3: Add `buildBreakdown` static method to WatchdogManager**

Add this as a **static method** on the class, immediately before `getSummary()` (around line 1289):

```js
// ── Session cost breakdown ─────────────────────────────────────────────────

static buildBreakdown(sessions) {
  const result = { factory: 0, watchdog: 0, devV2: 0, devV1: 0, other: 0, total: 0 };
  for (const s of sessions || []) {
    const id = s.sessionId || '';
    const projectPath = s.projectPath || '';
    const cost = s.totalCost || 0;

    let category;
    if (id === 'subagents') {
      if (projectPath.startsWith('-home-claude-runner-apps-claude-web-app-v2')) category = 'devV2';
      else if (projectPath.startsWith('-home-claude-runner-apps-claude-web-app')) category = 'devV1';
      else if (projectPath.startsWith('-projects-niyyah')) category = 'factory';
      else category = 'other';
    } else if (id.startsWith('-projects-niyyah')) {
      category = 'factory';
    } else if (id.startsWith('-tmp')) {
      category = 'watchdog';
    } else if (id.startsWith('-home-claude-runner-apps-claude-web-app-v2')) {
      category = 'devV2';
    } else if (id.startsWith('-home-claude-runner-apps-claude-web-app')) {
      category = 'devV1';
    } else {
      category = 'other';
    }

    result[category] += cost;
    result.total += cost;
  }
  return result;
}
```

- [ ] **Step 4: Add credit history methods to WatchdogManager**

Add immediately after `buildBreakdown()`, before `getSummary()`:

```js
// ── Credit history ─────────────────────────────────────────────────────────

_creditHistoryFile() {
  return path.join(this.dataDir, 'credit-history.json');
}

_appendCreditHistory(snapshot) {
  const MAX_HISTORY = 200;
  const entry = {
    timestamp: snapshot.timestamp,
    burnRateCostPerHour: snapshot.block?.burnRate?.costPerHour ?? null,
    blockCostUSD: snapshot.block?.costUSD ?? null,
    todayCostUSD: snapshot.todayCostUSD ?? null,
    breakdown: snapshot.breakdown ?? null,
  };

  let history = [];
  try {
    const raw = JSON.parse(fs.readFileSync(this._creditHistoryFile(), 'utf8'));
    if (Array.isArray(raw)) history = raw;
  } catch {}

  history.push(entry);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);

  const target = this._creditHistoryFile();
  const tmp = target + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
    fs.renameSync(tmp, target);
  } catch {
    try { fs.writeFileSync(target, JSON.stringify(history, null, 2)); } catch {}
  }
}

getCreditHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(this._creditHistoryFile(), 'utf8'));
    if (!Array.isArray(data)) return [];
    return data.filter(e => e && e.timestamp);
  } catch {
    return [];
  }
}
```

- [ ] **Step 5: Update `checkCcusage()` to add session call, breakdown, and history append**

Replace the entire `checkCcusage()` method body with:

```js
async checkCcusage() {
  const CCUSAGE_MIN_INTERVAL_S = 300;
  const now = Date.now() / 1000;
  if (now - this._lastCcusageCheck < CCUSAGE_MIN_INTERVAL_S) return null;

  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const [blocksData, dailyData, sessionData] = await Promise.all([
      this._runCcusage(['blocks']),
      this._runCcusage(['daily', '--since', today]),
      this._runCcusage(['session']),
    ]);

    if (!blocksData) return null;

    const activeBlock = (blocksData.blocks || []).find(b => b.isActive) ||
      (blocksData.blocks || []).slice(-1)[0] || null;

    const todayCostUSD = dailyData?.totals?.totalCost ?? null;
    const breakdown = WatchdogManager.buildBreakdown(sessionData?.sessions || []);

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
      breakdown,
    };

    this._lastCcusageCheck = now;
    this._lastCreditSnapshot = snapshot;
    this._appendCreditHistory(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Export `buildBreakdown` from the module for tests**

`buildBreakdown` is a static method on `WatchdogManager` so it's already accessible as `WatchdogManager.buildBreakdown`. Update the import in the test file to confirm it's available — no change needed to the module exports.

- [ ] **Step 7: Run all watchdog tests — should be 87 passing**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
npm test -- --testPathPattern=WatchdogManager 2>&1 | tail -10
```

Expected: `Tests: 87 passed, 87 total` (82 existing + 5 new).

- [ ] **Step 8: Commit**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
git add lib/watchdog/WatchdogManager.js tests/unit/WatchdogManager.test.js
git commit -m "feat: session cost breakdown + rolling credit history in WatchdogManager"
```

---

## Task 2: API route for credit history

**Files:**
- Modify: `lib/api/routes.js`

- [ ] **Step 1: Add the route**

In `lib/api/routes.js`, add immediately after the existing `/api/watchdog/logs` route handler (after its closing `});`):

```js
/** GET /api/watchdog/credit-history — rolling burn-rate and breakdown history */
router.get('/api/watchdog/credit-history', (req, res) => {
  if (!watchdog) return res.json([]);
  try {
    res.json(watchdog.getCreditHistory ? watchdog.getCreditHistory() : []);
  } catch {
    res.json([]);
  }
});
```

- [ ] **Step 2: Verify syntax**

```bash
cd /home/claude-runner/apps/claude-web-app-v2 && node --check lib/api/routes.js
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
git add lib/api/routes.js
git commit -m "feat: add GET /api/watchdog/credit-history route"
```

---

## Task 3: WatchdogPanel — breakdown tiles + sparkline

**Files:**
- Modify: `public/js/components/WatchdogPanel.js`

- [ ] **Step 1: Read the current file before editing**

Read `public/js/components/WatchdogPanel.js` to understand the current state before making any changes.

- [ ] **Step 2: Add `creditHistory` state and `loadHistory` function**

Add `creditHistory` state alongside the existing states:

```js
const [creditHistory, setCreditHistory] = useState([]);
```

Add `loadHistory` function alongside `loadSummary` and `loadLogs`:

```js
async function loadHistory() {
  try {
    const data = await fetch('/api/watchdog/credit-history').then(r => r.ok ? r.json() : []);
    if (Array.isArray(data)) setCreditHistory(data.slice(-48));
  } catch {}
}
```

Update `useEffect` to call all three:

```js
useEffect(() => {
  loadLogs();
  loadSummary();
  loadHistory();
}, []);
```

Update the Refresh button onClick:

```js
onClick=${() => { loadLogs(); loadSummary(); loadHistory(); }}
```

- [ ] **Step 3: Add the breakdown tiles block**

Inside the existing `${creditSnapshot ? html\`...\` : null}` block, add breakdown tiles **after** the closing `</div>` of the existing flex row (after the Today tile's `</div>`), still inside the outer credit container `<div>`. The breakdown section replaces the final `</div>` of the credit row then adds a new row:

Find the line inside the creditSnapshot block that reads:
```js
            </div>
          </div>
        ` : null}
```

Replace the `</div></div>` (the closing of the flex row and the credit container) with:

```js
            </div>
            ${creditSnapshot.breakdown && creditSnapshot.breakdown.total > 0 ? html`
              <div style="margin-top:8px;">
                <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:4px;">By Source (lifetime)</div>
                <div style="display:flex;gap:4px;flex-wrap:wrap;">
                  ${[
                    ['Factory', creditSnapshot.breakdown.factory],
                    ['Watchdog', creditSnapshot.breakdown.watchdog],
                    ['Dev v2', creditSnapshot.breakdown.devV2],
                    ['Dev v1', creditSnapshot.breakdown.devV1],
                    ['Other', creditSnapshot.breakdown.other],
                  ].filter(([, cost]) => cost > 0).map(([label, cost]) => html`
                    <div style="background:var(--bg-base);border:1px solid var(--border);border-radius:var(--radius-sm);padding:4px 8px;font-size:11px;">
                      <span style="color:var(--text-muted);">${label} </span>
                      <span style="color:var(--text-primary);font-weight:600;">$${cost.toFixed(2)}</span>
                    </div>
                  `)}
                </div>
              </div>
            ` : null}
          </div>
        ` : null}
```

- [ ] **Step 4: Add the SVG sparkline below the credit block**

Immediately after the `${creditSnapshot ? html\`...\` : null}` expression (before the closing `</div>` of the status summary section), add:

```js
${creditHistory.length >= 2 ? html`
  <div style="padding:8px 0 2px;">
    <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:4px;">Burn Rate $/hr</div>
    ${(function() {
      const vals = creditHistory.map(d => d.burnRateCostPerHour ?? 0);
      const max = Math.max(...vals, 0.01);
      const W = 300, H = 50, pad = 3;
      const pts = vals.map((v, i) => {
        const x = pad + (i / (vals.length - 1)) * (W - 2 * pad);
        const y = H - pad - (v / max) * (H - 2 * pad);
        return x.toFixed(1) + ',' + y.toFixed(1);
      }).join(' ');
      return html`
        <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:50px;display:block;" preserveAspectRatio="none">
          <polyline points="${pts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
        </svg>
      `;
    })()}
    <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-muted);margin-top:2px;">
      <span>${creditHistory.length > 0 ? timeAgo(creditHistory[0].timestamp) : ''}</span>
      <span>now</span>
    </div>
  </div>
` : null}
```

- [ ] **Step 5: Verify syntax**

```bash
cd /home/claude-runner/apps/claude-web-app-v2 && node --check public/js/components/WatchdogPanel.js
```

Expected: no output.

- [ ] **Step 6: Commit**

```bash
cd /home/claude-runner/apps/claude-web-app-v2
git add public/js/components/WatchdogPanel.js
git commit -m "feat: WatchdogPanel — session breakdown tiles and burn-rate sparkline"
```

---

## Self-Review

**Spec coverage:**
- ✅ Attribution by sessionId prefix (factory/watchdog/devV2/devV1/other) — `buildBreakdown()` static method, Task 1
- ✅ Subagent attribution via `projectPath` — `buildBreakdown()`, Task 1
- ✅ `data/credit-history.json` rolling 200-entry file — `_appendCreditHistory()`, Task 1
- ✅ `getCreditHistory()` filters malformed entries — Task 1
- ✅ `checkCcusage()` calls `ccusage session`, builds breakdown, appends history — Task 1
- ✅ `GET /api/watchdog/credit-history` — Task 2
- ✅ Breakdown tiles (lifetime, filtered to cost > 0) — Task 3
- ✅ SVG sparkline, burn rate over last 48 entries — Task 3
- ✅ Error handling: session call failure → breakdown still built from empty array — `buildBreakdown([])` returns all zeros, `sessionData?.sessions || []` handles null

**Placeholder scan:** None found.

**Type consistency:**
- `breakdown.factory`, `.watchdog`, `.devV2`, `.devV1`, `.other`, `.total` — used consistently in `buildBreakdown()`, `_appendCreditHistory()`, snapshot object, and WatchdogPanel template
- `creditHistory` array entries have `burnRateCostPerHour` — used consistently in sparkline and tests
- `getCreditHistory()` returns array — used consistently in route and WatchdogPanel

**Note on test count:** Existing suite has 82 tests. Adding 5 new tests = 87 expected. The test for `checkCcusage includes breakdown` updates the existing mock to return 3 values from `_runCcusage` — the existing happy-path test uses `args.includes('blocks')` which still works since `session` args won't include `'blocks'`. Confirm this doesn't break existing tests by running the full suite in Step 7 of Task 1.
