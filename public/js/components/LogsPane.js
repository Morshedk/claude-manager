// public/js/components/LogsPane.js
import { html } from 'htm/preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { logEntries, settings } from '../state/store.js';
import { saveSettings } from '../state/actions.js';
import { log } from '../logger/logger.js';
import { send } from '../ws/connection.js';

const LEVEL_ORDER = { error: 0, warn: 1, info: 2, debug: 3 };
const LEVEL_COLORS = { error: '#f04848', warn: '#e8a020', info: '#4a9eff', debug: '#888' };
const TAGS = ['all', 'ws', 'sessions', 'watchdog', 'router', 'terminals', 'todos', 'api', 'process', 'app'];
const LEVEL_OPTIONS = ['error', 'warn', 'info', 'debug'];

export function LogsPane({ connected }) {
  const [tagFilter, setTagFilter] = useState('all');
  const [srcFilter, setSrcFilter] = useState('all');
  const [paused, setPaused] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const listRef = useRef(null);
  const pausedRef = useRef(false);
  pausedRef.current = paused;

  const allSettings = settings.value;
  const levels = allSettings?.logging?.levels || { default: 'warn' };

  useEffect(() => {
    if (connected) {
      send({ type: 'logs:subscribe' });
      fetch('/api/logs/tail?lines=200')
        .then(r => r.json())
        .then(data => { setHistory(Array.isArray(data) ? data : []); setHistoryLoaded(true); })
        .catch(() => setHistoryLoaded(true));
    } else {
      setHistoryLoaded(true);
    }
    return () => { if (connected) send({ type: 'logs:unsubscribe' }); };
  }, [connected]);

  useEffect(() => {
    if (!pausedRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  });

  const liveEntries = logEntries.value;
  const bufferEntries = connected ? [] : log.getBuffer();
  const combined = connected
    ? [...history, ...liveEntries]
    : bufferEntries;

  const filtered = combined.filter(e => {
    if (tagFilter !== 'all' && e.tag !== tagFilter) return false;
    if (srcFilter !== 'all' && e.source !== srcFilter) return false;
    return true;
  });

  const handleLevelChange = async (tag, value) => {
    const newLevels = { ...levels, [tag]: value };
    await saveSettings({ logging: { levels: newLevels } });
    send({ type: 'settings:update', settings: { logging: { levels: newLevels } } });
  };

  const handleClear = () => {
    logEntries.value = [];
    setHistory([]);
  };

  const rowStyle = (e) => `
    display:flex;flex-direction:column;padding:4px 8px;
    border-left:3px solid ${e.level === 'error' ? '#f04848' : 'transparent'};
    border-bottom:1px solid rgba(255,255,255,0.04);
    font-family:var(--font-mono);font-size:11px;
  `;

  const badgeStyle = (level) => `
    display:inline-block;padding:1px 5px;border-radius:3px;font-size:9px;
    font-weight:700;text-transform:uppercase;margin-right:6px;
    background:${LEVEL_COLORS[level]}22;color:${LEVEL_COLORS[level]};
  `;

  const formatData = (data) => {
    if (!data) return null;
    try {
      return Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ');
    } catch { return String(data); }
  };

  return html`
    <div style="display:flex;flex-direction:column;height:100%;overflow:hidden;">

      <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid var(--border);flex-shrink:0;flex-wrap:wrap;">
        <select value=${tagFilter} onChange=${e => setTagFilter(e.target.value)} style="font-size:11px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:2px 4px;">
          ${TAGS.map(t => html`<option value=${t}>${t}</option>`)}
        </select>
        <select value=${srcFilter} onChange=${e => setSrcFilter(e.target.value)} style="font-size:11px;background:var(--bg-secondary);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:2px 4px;">
          <option value="all">all</option>
          <option value="server">server</option>
          <option value="client">client</option>
        </select>
        <span style="flex:1;"></span>
        <span style="font-size:10px;display:flex;align-items:center;gap:4px;cursor:pointer;color:${paused ? 'var(--text-muted)' : 'var(--accent)'};" onClick=${() => setPaused(p => !p)}>
          <span style="width:7px;height:7px;border-radius:50%;background:${paused ? 'var(--text-muted)' : 'var(--accent)'};display:inline-block;"></span>
          ${paused ? 'paused' : 'live'}
        </span>
        <button onClick=${handleClear} style="font-size:10px;padding:2px 6px;background:var(--bg-secondary);color:var(--text-muted);border:1px solid var(--border);border-radius:3px;cursor:pointer;">Clear</button>
      </div>

      ${!connected ? html`
        <div style="padding:4px 8px;font-size:10px;color:var(--warning);background:rgba(232,160,32,0.08);border-bottom:1px solid var(--border);flex-shrink:0;">
          disconnected — showing local buffer (${bufferEntries.length} entries)
        </div>
      ` : null}

      <div ref=${listRef} style="flex:1;overflow-y:auto;overflow-x:hidden;">
        ${!historyLoaded ? html`<div style="padding:8px;color:var(--text-muted);font-size:11px;">Loading...</div>` : null}
        ${filtered.length === 0 && historyLoaded ? html`<div style="padding:8px;color:var(--text-muted);font-size:11px;">No entries</div>` : null}
        ${filtered.map((e, i) => html`
          <div key=${i} style=${rowStyle(e)}>
            <div style="display:flex;align-items:center;gap:4px;">
              <span style="color:var(--text-muted);font-size:10px;" title=${e.ts}>
                ${e.ts.slice(11, 19)}
              </span>
              <span style=${badgeStyle(e.level)}>${e.level}</span>
              <span style="color:var(--text-secondary);min-width:80px;">${e.tag}</span>
              <span style="color:var(--text);">${e.msg}</span>
            </div>
            ${e.data ? html`
              <div style="padding-left:8px;color:var(--text-muted);font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${formatData(e.data)}
              </div>
            ` : null}
          </div>
        `)}
      </div>

      <div style="border-top:1px solid var(--border);padding:6px 8px;flex-shrink:0;background:var(--bg-secondary);">
        <div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;font-weight:600;letter-spacing:0.04em;margin-bottom:4px;">Log Levels</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;">
          ${['default', ...TAGS.filter(t => t !== 'all')].map(tag => html`
            <label style="display:flex;align-items:center;gap:3px;font-size:10px;color:var(--text-muted);">
              ${tag}
              <select
                value=${levels[tag] || levels.default || 'warn'}
                onChange=${e => handleLevelChange(tag, e.target.value)}
                disabled=${!connected}
                style="font-size:10px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:3px;padding:1px 2px;"
              >
                ${LEVEL_OPTIONS.map(l => html`<option value=${l}>${l}</option>`)}
              </select>
            </label>
          `)}
        </div>
      </div>
    </div>
  `;
}
