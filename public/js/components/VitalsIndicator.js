import { html } from 'htm/preact';
import { vitals } from '../state/store.js';

/**
 * Color for a percentage metric: green < 60%, yellow 60-85%, red > 85%.
 * @param {number} pct
 * @returns {string} CSS color value
 */
function metricColor(pct) {
  if (pct > 85) return 'var(--danger, #f04848)';
  if (pct >= 60) return 'var(--warning, #e8a020)';
  return 'var(--accent, #00c864)';
}

/**
 * Micro progress bar — a thin inline bar showing a percentage.
 * @param {{ pct: number, color: string }} props
 */
function MicroBar({ pct, color }) {
  const clamped = Math.min(100, Math.max(0, pct));
  return html`
    <div style="
      width:48px;height:6px;border-radius:3px;
      background:rgba(255,255,255,0.08);
      display:inline-block;vertical-align:middle;
      overflow:hidden;
    ">
      <div style="
        width:${clamped}%;height:100%;border-radius:3px;
        background:${color};
        transition:width 0.6s ease, background 0.6s ease;
      "></div>
    </div>
  `;
}

/**
 * Format memory in MB as a human-readable string (GB if >= 1024 MB).
 * @param {number} mb
 * @returns {string}
 */
function formatMem(mb) {
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return mb + ' MB';
}

/**
 * VitalsIndicator — compact system health metrics for the TopBar.
 * Shows CPU %, RAM used/total, and disk % with colored micro-bars.
 */
export function VitalsIndicator() {
  const v = vitals.value;

  if (!v) {
    return html`
      <div class="vitals-indicator" style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-muted);">
        <span style="font-weight:600;text-transform:uppercase;font-size:9px;letter-spacing:0.04em;">Pulse</span>
        <span>waiting...</span>
      </div>
    `;
  }

  // Check for stale data (> 2 minutes old)
  const ageMs = Date.now() - new Date(v.timestamp).getTime();
  const isStale = ageMs > 120_000;

  const cpuColor = metricColor(v.cpuPct);
  const memColor = metricColor(v.memPct);
  const diskColor = metricColor(v.diskPct);

  const labelStyle = 'font-size:9px;color:var(--text-muted);text-transform:uppercase;font-weight:600;letter-spacing:0.03em;';
  const valueStyle = 'font-size:11px;font-family:var(--font-mono);';
  const sepStyle = 'color:var(--border);margin:0 2px;font-size:10px;';

  return html`
    <div
      class="vitals-indicator"
      style="display:flex;align-items:center;gap:8px;font-size:11px;opacity:${isStale ? '0.5' : '1'};transition:opacity 0.3s;"
      title=${isStale ? 'Pulse data is stale (watchdog may be paused)' : `Updated ${Math.floor(ageMs / 1000)}s ago`}
    >
      <span style="font-weight:700;text-transform:uppercase;font-size:9px;letter-spacing:0.04em;color:var(--text-secondary);">
        Pulse${isStale ? ' (stale)' : ''}
      </span>

      <span style="display:inline-flex;align-items:center;gap:4px;">
        <span style=${labelStyle}>CPU</span>
        <${MicroBar} pct=${v.cpuPct} color=${cpuColor} />
        <span style="${valueStyle}color:${cpuColor};">${Math.min(100, v.cpuPct)}%</span>
      </span>

      <span style=${sepStyle}>|</span>

      <span style="display:inline-flex;align-items:center;gap:4px;">
        <span style=${labelStyle}>RAM</span>
        <${MicroBar} pct=${v.memPct} color=${memColor} />
        <span style="${valueStyle}color:${memColor};">${formatMem(v.memUsedMb)}/${formatMem(v.memTotalMb)}</span>
      </span>

      <span style=${sepStyle}>|</span>

      <span style="display:inline-flex;align-items:center;gap:4px;">
        <span style=${labelStyle}>Disk</span>
        <${MicroBar} pct=${v.diskPct} color=${diskColor} />
        <span style="${valueStyle}color:${diskColor};">${v.diskPct}%</span>
      </span>
    </div>
  `;
}
