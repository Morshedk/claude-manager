import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { settings } from '../state/store.js';
import { timeAgo } from '../utils/format.js';

/**
 * WatchdogPanel — watchdog status display.
 * Shows enabled/disabled from settings, last tick time, recent log entries.
 */
export function WatchdogPanel() {
  const [logs, setLogs] = useState([]);
  const [lastTick, setLastTick] = useState(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState(null);
  const [creditSnapshot, setCreditSnapshot] = useState(null);
  const [creditHistory, setCreditHistory] = useState([]);
  const [hiddenSeries, setHiddenSeries] = useState(new Set());

  const s = settings.value || {};
  const wdSettings = s.watchdog || {};
  const enabled = wdSettings.enabled !== false;

  useEffect(() => {
    loadLogs();
    loadSummary();
    loadHistory();
  }, []);

  async function loadSummary() {
    try {
      const data = await fetch('/api/watchdog/state').then(r => r.ok ? r.json() : null);
      if (data?.lastCreditSnapshot) setCreditSnapshot(data.lastCreditSnapshot);
      if (data?.lastTick) setLastTick(data.lastTick);
    } catch {}
  }

  async function loadHistory() {
    try {
      const data = await fetch('/api/watchdog/credit-history').then(r => r.ok ? r.json() : []);
      if (Array.isArray(data)) setCreditHistory(data.slice(-48));
    } catch {
      setCreditHistory([]);
    }
  }

  async function loadLogs() {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const data = await fetch('/api/watchdog/logs').then(r => {
        if (!r.ok) throw new Error('Not available');
        return r.json();
      });
      setLogs(Array.isArray(data) ? data : (data.logs || []));
      if (data.lastTick) setLastTick(data.lastTick);
    } catch (e) {
      // Endpoint may not exist yet — show placeholder gracefully
      setLogsError(null);
      setLogs([]);
    }
    setLogsLoading(false);
  }

  const statusColor = enabled ? 'var(--accent)' : 'var(--text-muted)';

  return html`
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;background:var(--bg-surface);">

      <!-- Header -->
      <div style="padding:10px 14px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <span style="font-size:14px;font-weight:600;color:var(--text-bright);">Watchdog</span>
        <span style=${`font-size:11px;font-weight:700;text-transform:uppercase;padding:2px 8px;border-radius:var(--radius-sm);background:${enabled ? 'rgba(0,200,100,0.12)' : 'var(--bg-raised)'};color:${statusColor};`}>
          ${enabled ? 'Enabled' : 'Disabled'}
        </span>
        <div style="flex:1;"></div>
        <button
          onClick=${() => { loadLogs(); loadSummary(); loadHistory(); }}
          style="font-size:11px;padding:3px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:transparent;color:var(--text-secondary);cursor:pointer;"
        >Refresh</button>
      </div>

      <!-- Status summary -->
      <div style="padding:12px 14px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;flex:1;min-width:120px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:3px;">Model</div>
            <div style="font-size:13px;color:var(--text-primary);">${wdSettings.defaultModel || 'sonnet'}</div>
          </div>
          <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;flex:1;min-width:120px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:3px;">Interval</div>
            <div style="font-size:13px;color:var(--text-primary);">${wdSettings.intervalMinutes || 5} min</div>
          </div>
          <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;flex:1;min-width:120px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:3px;">Last Tick</div>
            <div style="font-size:13px;color:var(--text-primary);">${lastTick ? timeAgo(lastTick) : '—'}</div>
          </div>
          ${wdSettings.extendedThinking ? html`
            <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:8px 12px;flex:1;min-width:120px;">
              <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:3px;">Thinking</div>
              <div style="font-size:13px;color:var(--accent);">Extended</div>
            </div>
          ` : null}
        </div>
        ${wdSettings.defaultFlags ? html`
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">Flags: ${wdSettings.defaultFlags}</div>
        ` : null}
        ${creditSnapshot ? html`
          <div style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:10px 12px;margin-top:2px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:6px;">Credits · ${timeAgo(creditSnapshot.timestamp)}</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
              ${creditSnapshot.block ? html`
                ${creditSnapshot.block.isActive && creditSnapshot.block.burnRate ? html`
                  <div style="flex:1;min-width:100px;">
                    <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Burn rate</div>
                    <div style="font-size:13px;color:var(--text-primary);">$${(creditSnapshot.block.burnRate.costPerHour ?? 0).toFixed(2)}/hr</div>
                  </div>
                ` : null}
                <div style="flex:1;min-width:100px;">
                  <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Block cost</div>
                  <div style="font-size:13px;color:var(--text-primary);">$${(creditSnapshot.block.costUSD || 0).toFixed(2)}</div>
                </div>
                ${creditSnapshot.block.isActive && creditSnapshot.block.projection ? html`
                  <div style="flex:1;min-width:100px;">
                    <div style="font-size:10px;color:var(--text-muted);margin-bottom:2px;">Projected</div>
                    <div style="font-size:13px;color:var(--warning);">$${(creditSnapshot.block.projection.totalCost ?? 0).toFixed(2)} (${creditSnapshot.block.projection.remainingMinutes ?? '?'}min left)</div>
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
        ${creditHistory.length >= 2 ? html`
          <div style="padding:8px 0 2px;">
            <div style="font-size:10px;color:var(--text-muted);text-transform:uppercase;font-weight:600;margin-bottom:6px;">Burn Rate $/hr · By Session</div>
            ${(function() {
              const PALETTE = ['#4488ff', '#00ccdd', '#44dd88', '#cc66ff', '#ddcc00'];

              // Define series from the most recent history entry that has session data
              const latestWithSessions = [...creditHistory].reverse().find(h => h.sessionSnapshot?.sessions?.length > 0);
              const sessionSeries = (latestWithSessions?.sessionSnapshot?.sessions || []).map((s, i) => ({
                id: s.id, label: s.label, color: PALETTE[i] || '#888888',
              }));

              // Compute burn-rate points (Δcost/Δtime) between consecutive history entries
              const pts = [];
              for (let i = 1; i < creditHistory.length; i++) {
                const prev = creditHistory[i - 1], cur = creditHistory[i];
                const dtH = (new Date(cur.timestamp) - new Date(prev.timestamp)) / 3600000;
                if (dtH < 0.001) continue;
                const pt = { t: new Date(cur.timestamp).getTime() };
                pt.watchdog = Math.max(0, ((cur.sessionSnapshot?.watchdog || 0) - (prev.sessionSnapshot?.watchdog || 0)) / dtH);
                pt.other = Math.max(0, ((cur.sessionSnapshot?.other || 0) - (prev.sessionSnapshot?.other || 0)) / dtH);
                for (const s of sessionSeries) {
                  const c = (cur.sessionSnapshot?.sessions || []).find(x => x.id === s.id)?.cost || 0;
                  const p = (prev.sessionSnapshot?.sessions || []).find(x => x.id === s.id)?.cost || 0;
                  pt[s.id] = Math.max(0, (c - p) / dtH);
                }
                pts.push(pt);
              }

              // Fall back to total sparkline while session data accumulates
              if (pts.length < 2 || !latestWithSessions) {
                const vals = creditHistory.map(d => d.burnRateCostPerHour || 0);
                const maxV = Math.max(...vals, 0.01);
                const W2 = 300, H2 = 50, pad = 3;
                const sparkPts = vals.map((v, i) => {
                  const x = pad + (i / (vals.length - 1)) * (W2 - 2 * pad);
                  const y = H2 - pad - (v / maxV) * (H2 - 2 * pad);
                  return x.toFixed(1) + ',' + y.toFixed(1);
                }).join(' ');
                return html`
                  <svg viewBox="0 0 ${W2} ${H2}" style="width:100%;height:50px;display:block;" preserveAspectRatio="none">
                    <polyline points="${sparkPts}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
                  </svg>
                  <div style="font-size:9px;color:var(--text-muted);margin-top:2px;">Session data accumulating…</div>
                `;
              }

              // Chart geometry
              const W = 600, H = 190, pL = 44, pR = 8, pT = 10, pB = 22;
              const cW = W - pL - pR, cH = H - pT - pB;
              const tMin = pts[0].t, tMax = pts[pts.length - 1].t;
              const xOf = t => pL + ((t - tMin) / (tMax - tMin || 1)) * cW;
              const allVals = pts.flatMap(p => [p.watchdog, p.other, ...sessionSeries.map(s => p[s.id] || 0)]);
              const maxY = Math.max(...allVals, 0.1);
              const yOf = v => pT + (1 - Math.min(v, maxY) / maxY) * cH;
              const poly = key => pts.map(p => `${xOf(p.t).toFixed(1)},${yOf(p[key] || 0).toFixed(1)}`).join(' ');
              const yLabels = [1, 0.75, 0.5, 0.25, 0].map(f => ({ y: pT + (1 - f) * cH, val: (maxY * f).toFixed(2) }));

              const allSeries = [
                ...sessionSeries.map(s => ({ key: s.id, label: s.label, color: s.color, always: false })),
                { key: 'watchdog', label: 'watchdog', color: '#ff8800', always: true, dash: '6,2' },
                { key: 'other', label: 'other', color: '#555577', always: false, dash: '3,3' },
              ];

              const toggleSeries = key => setHiddenSeries(prev => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key); else next.add(key);
                return next;
              });

              return html`
                <svg viewBox="0 0 ${W} ${H}" style="width:100%;display:block;" preserveAspectRatio="none">
                  ${yLabels.map(g => html`
                    <line x1="${pL}" y1="${g.y.toFixed(1)}" x2="${W - pR}" y2="${g.y.toFixed(1)}" stroke="#2a2a45" stroke-width="1"/>
                    <text x="${pL - 3}" y="${(g.y + 3).toFixed(0)}" font-size="8" fill="#666688" text-anchor="end">${g.val}</text>
                  `)}
                  <line x1="${pL}" y1="${pT}" x2="${pL}" y2="${pT + cH}" stroke="#444466" stroke-width="1"/>
                  <line x1="${pL}" y1="${pT + cH}" x2="${W - pR}" y2="${pT + cH}" stroke="#444466" stroke-width="1"/>
                  <text x="${pL}" y="${H - 4}" font-size="8" fill="#666688" text-anchor="middle">${timeAgo(new Date(pts[0].t).toISOString())}</text>
                  <text x="${W - pR}" y="${H - 4}" font-size="8" fill="#666688" text-anchor="end">now</text>
                  ${allSeries.filter(s => !hiddenSeries.has(s.key) || s.always).map(s => html`
                    <polyline
                      points="${poly(s.key)}"
                      fill="none"
                      stroke="${s.color}"
                      stroke-width="${s.always ? '2.5' : '1.5'}"
                      stroke-linejoin="round"
                      stroke-dasharray="${s.dash || ''}"
                    />
                  `)}
                </svg>
                <div style="display:flex;flex-wrap:wrap;gap:4px 10px;margin-top:4px;">
                  ${allSeries.map(s => html`
                    <div
                      onClick=${() => { if (!s.always) toggleSeries(s.key); }}
                      style="display:flex;align-items:center;gap:5px;cursor:${s.always ? 'default' : 'pointer'};font-size:10px;color:var(--text-primary);opacity:${hiddenSeries.has(s.key) ? '0.35' : '1'};"
                    >
                      <span style="width:14px;height:3px;background:${s.color};display:inline-block;border-radius:1px;flex-shrink:0;"></span>
                      ${s.label}
                      ${s.always ? html`<span style="font-size:8px;color:#ff8800;">locked</span>` : null}
                    </div>
                  `)}
                </div>
              `;
            })()}
          </div>
        ` : null}
      </div>

      <!-- Log entries -->
      <div style="flex:1;overflow-y:auto;padding:8px 14px;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);margin-bottom:8px;">Recent Activity</div>
        ${logsLoading
          ? html`<div style="color:var(--text-muted);font-size:12px;">Loading logs…</div>`
          : logs.length === 0
            ? html`
                <div style="display:flex;flex-direction:column;align-items:center;gap:8px;padding:32px 0;color:var(--text-muted);">
                  <span style="font-size:28px;">🐕</span>
                  <span style="font-size:13px;">${enabled ? 'No watchdog activity yet' : 'Watchdog is disabled'}</span>
                  <span style="font-size:11px;text-align:center;max-width:260px;">
                    ${enabled
                      ? 'Watchdog will monitor sessions and log activity here.'
                      : 'Enable watchdog in Settings to start monitoring sessions.'}
                  </span>
                </div>
              `
            : logs.map((entry, i) => html`
                <div
                  key=${i}
                  style="padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-raised);margin-bottom:6px;font-size:12px;"
                >
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px;">
                    ${entry.level ? html`
                      <span style=${`font-size:10px;font-weight:700;text-transform:uppercase;color:${entry.level === 'error' ? 'var(--danger)' : entry.level === 'warn' ? 'var(--warning)' : 'var(--text-muted)'};`}>
                        ${entry.level}
                      </span>
                    ` : null}
                    ${entry.timestamp ? html`<span style="font-size:10px;color:var(--text-muted);">${timeAgo(entry.timestamp)}</span>` : null}
                  </div>
                  <div style="color:var(--text-primary);font-family:var(--font-mono);">${entry.message || JSON.stringify(entry)}</div>
                </div>
              `)
        }
      </div>
    </div>
  `;
}
