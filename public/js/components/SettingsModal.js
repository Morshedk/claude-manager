import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { settings, settingsModalOpen } from '../state/store.js';
import { closeSettingsModal, showToast } from '../state/actions.js';

const MODEL_IDS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function buildCommandPreview({ model, thinking, flags, lcEnabled, lcActive, lcModel, lcThinking, lcFlags }) {
  const useLowCredit = lcEnabled && lcActive;
  const effModel = useLowCredit ? lcModel : model;
  const effThinking = useLowCredit ? lcThinking : thinking;
  const effFlags = useLowCredit ? lcFlags : flags;
  let cmd = 'claude';
  const mid = MODEL_IDS[effModel] || effModel;
  if (mid) cmd += ` --model ${mid}`;
  if (effThinking) cmd += ' --effort max';
  if (effFlags && effFlags.trim()) cmd += ` ${effFlags.trim()}`;
  return cmd;
}

/** Toggle switch sub-component */
function Toggle({ checked, onChange, id }) {
  return html`
    <label class="toggle" style="display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;">
      <input
        id=${id}
        type="checkbox"
        checked=${checked}
        onChange=${e => onChange(e.target.checked)}
        style="display:none;"
      />
      <span
        class="toggle-slider"
        onClick=${() => onChange(!checked)}
        style=${`display:inline-block;width:36px;height:20px;border-radius:10px;background:${checked ? 'var(--accent)' : 'var(--border)'};position:relative;transition:background 0.2s;flex-shrink:0;cursor:pointer;`}
      >
        <span style=${`position:absolute;top:3px;left:${checked ? '19px' : '3px'};width:14px;height:14px;border-radius:50%;background:#fff;transition:left 0.2s;`}></span>
      </span>
    </label>
  `;
}

/** Settings row sub-component */
function SettingsRow({ label, help, children }) {
  return html`
    <div class="settings-row" style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:8px 0;">
      <div style="flex:1;min-width:0;">
        <div class="settings-row-label" style="font-size:13px;color:var(--text-primary);">${label}</div>
        ${help ? html`<div class="settings-row-help" style="font-size:11px;color:var(--text-muted);margin-top:2px;">${help}</div>` : null}
      </div>
      <div style="flex-shrink:0;">${children}</div>
    </div>
  `;
}

/** Model select sub-component */
function ModelSelect({ value, onChange }) {
  return html`
    <select
      class="form-select"
      value=${value}
      onChange=${e => onChange(e.target.value)}
      style="padding:5px 8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:12px;width:110px;"
    >
      <option value="sonnet">Sonnet</option>
      <option value="opus">Opus</option>
      <option value="haiku">Haiku</option>
    </select>
  `;
}

/** Section header sub-component */
function SectionHeader({ children }) {
  return html`
    <div class="settings-section-header" style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);padding:12px 0 6px;border-top:1px solid var(--border);margin-top:8px;">
      ${children}
    </div>
  `;
}

/**
 * SettingsModal — full settings form in a modal.
 * Session Defaults, Watchdog, Low Credit Mode, Features, command preview.
 * Shows/hides based on settingsModalOpen signal.
 */
export function SettingsModal() {
  const s = settings.value || {};
  const sess = s.session || { defaultModel: 'sonnet', extendedThinking: false, defaultFlags: '', defaultMode: 'direct' };
  const wd = s.watchdog || { enabled: true, defaultModel: 'sonnet', extendedThinking: false, defaultFlags: '', intervalMinutes: 5 };
  const lc = s.lowCredit || { enabled: false, active: false, defaultModel: 'haiku', extendedThinking: false, defaultFlags: '' };
  const feat = s.features || { todoRewards: true };

  // Local form state
  const [sessModel, setSessModel] = useState(sess.defaultModel || 'sonnet');
  const [sessThinking, setSessThinking] = useState(!!sess.extendedThinking);
  const [sessFlags, setSessFlags] = useState(sess.defaultFlags || '');
  const [sessMode, setSessMode] = useState(sess.defaultMode || 'direct');

  const [wdEnabled, setWdEnabled] = useState(wd.enabled !== false);
  const [wdModel, setWdModel] = useState(wd.defaultModel || 'sonnet');
  const [wdThinking, setWdThinking] = useState(!!wd.extendedThinking);
  const [wdFlags, setWdFlags] = useState(wd.defaultFlags || '');
  const [wdInterval, setWdInterval] = useState(String(wd.intervalMinutes || 5));

  const [lcEnabled, setLcEnabled] = useState(!!lc.enabled);
  const [lcActive, setLcActive] = useState(!!lc.active);
  const [lcModel, setLcModel] = useState(lc.defaultModel || 'haiku');
  const [lcThinking, setLcThinking] = useState(!!lc.extendedThinking);
  const [lcFlags, setLcFlags] = useState(lc.defaultFlags || '');

  const [featRewards, setFeatRewards] = useState(feat.todoRewards !== false);

  const [saving, setSaving] = useState(false);

  // Re-sync from settings signal when modal opens
  useEffect(() => {
    if (!settingsModalOpen.value) return;
    const s2 = settings.value || {};
    const sess2 = s2.session || {};
    const wd2 = s2.watchdog || {};
    const lc2 = s2.lowCredit || {};
    const feat2 = s2.features || {};
    setSessModel(sess2.defaultModel || 'sonnet');
    setSessThinking(!!sess2.extendedThinking);
    setSessFlags(sess2.defaultFlags || '');
    setSessMode(sess2.defaultMode || 'direct');
    setWdEnabled(wd2.enabled !== false);
    setWdModel(wd2.defaultModel || 'sonnet');
    setWdThinking(!!wd2.extendedThinking);
    setWdFlags(wd2.defaultFlags || '');
    setWdInterval(String(wd2.intervalMinutes || 5));
    setLcEnabled(!!lc2.enabled);
    setLcActive(!!lc2.active);
    setLcModel(lc2.defaultModel || 'haiku');
    setLcThinking(!!lc2.extendedThinking);
    setLcFlags(lc2.defaultFlags || '');
    setFeatRewards(feat2.todoRewards !== false);
  }, [settingsModalOpen.value]);

  const preview = buildCommandPreview({
    model: sessModel, thinking: sessThinking, flags: sessFlags,
    lcEnabled, lcActive, lcModel, lcThinking, lcFlags,
  });

  async function handleSave() {
    setSaving(true);
    const updates = {
      session: {
        defaultModel: sessModel,
        extendedThinking: sessThinking,
        defaultFlags: sessFlags.trim(),
        defaultMode: sessMode,
      },
      watchdog: {
        enabled: wdEnabled,
        defaultModel: wdModel,
        extendedThinking: wdThinking,
        defaultFlags: wdFlags.trim(),
        intervalMinutes: parseInt(wdInterval, 10) || 5,
      },
      lowCredit: {
        enabled: lcEnabled,
        active: lcActive,
        defaultModel: lcModel,
        extendedThinking: lcThinking,
        defaultFlags: lcFlags.trim(),
      },
      features: {
        todoRewards: featRewards,
      },
    };
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error || 'Save failed');
      }
      const data = await res.json();
      // Update the signal directly so the rest of the app sees the change
      settings.value = data || {};
      showToast('Settings saved', 'success');
      closeSettingsModal();
    } catch (e) {
      showToast('Failed to save: ' + e.message, 'error');
    }
    setSaving(false);
  }

  if (!settingsModalOpen.value) return null;

  return html`
    <div
      class="modal-overlay"
      onClick=${closeSettingsModal}
      style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:200;"
    >
      <div
        class="modal modal-wide"
        onClick=${e => e.stopPropagation()}
        style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);width:min(600px,95vw);max-height:90vh;display:flex;flex-direction:column;"
      >
        <!-- Header -->
        <div class="modal-header" style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <h2 style="font-size:15px;font-weight:600;color:var(--text-bright);flex:1;margin:0;">Settings</h2>
          <button
            onClick=${closeSettingsModal}
            style="font-size:20px;color:var(--text-muted);background:none;border:none;cursor:pointer;line-height:1;padding:0;"
          >×</button>
        </div>

        <!-- Body (scrollable) -->
        <div class="modal-body" style="flex:1;overflow-y:auto;padding:16px 20px;">

          <!-- Session Defaults -->
          <${SectionHeader}>Session Defaults</${SectionHeader}>
          <div class="settings-section">
            <${SettingsRow} label="Default Model" help="Model used for new sessions">
              <${ModelSelect} value=${sessModel} onChange=${setSessModel} />
            </${SettingsRow}>
            <${SettingsRow} label="Extended Thinking" help="Use --effort max">
              <${Toggle} checked=${sessThinking} onChange=${setSessThinking} />
            </${SettingsRow}>
            <${SettingsRow} label="Default Mode" help="Direct auto-resumes; Tmux survives restarts">
              <select
                class="form-select"
                value=${sessMode}
                onChange=${e => setSessMode(e.target.value)}
                style="padding:5px 8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:12px;width:110px;"
              >
                <option value="direct">Direct</option>
                <option value="tmux">Tmux</option>
              </select>
            </${SettingsRow}>
            <div class="form-group" style="margin-top:8px;">
              <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px;">Default Flags</label>
              <input
                class="form-input"
                value=${sessFlags}
                onInput=${e => setSessFlags(e.target.value)}
                placeholder="e.g. --dangerously-skip-permissions"
                style="width:100%;padding:7px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
              />
              <div class="form-help" style="font-size:11px;color:var(--text-muted);margin-top:3px;">Extra CLI flags appended to every new session command</div>
            </div>
          </div>

          <!-- Watchdog -->
          <${SectionHeader}>Watchdog v2</${SectionHeader}>
          <div class="settings-section">
            <${SettingsRow} label="Enabled" help="Periodic session monitoring">
              <${Toggle} checked=${wdEnabled} onChange=${setWdEnabled} />
            </${SettingsRow}>
            <${SettingsRow} label="Model" help="Model for watchdog tasks">
              <${ModelSelect} value=${wdModel} onChange=${setWdModel} />
            </${SettingsRow}>
            <${SettingsRow} label="Extended Thinking" help="Use --effort max">
              <${Toggle} checked=${wdThinking} onChange=${setWdThinking} />
            </${SettingsRow}>
            <${SettingsRow} label="Interval (min)" help="Minutes between watchdog runs">
              <input
                type="number"
                class="form-input"
                value=${wdInterval}
                onInput=${e => setWdInterval(e.target.value)}
                min="1"
                max="60"
                style="width:70px;padding:5px 8px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:12px;text-align:center;"
              />
            </${SettingsRow}>
            <div class="form-group" style="margin-top:8px;">
              <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px;">Watchdog Flags</label>
              <input
                class="form-input"
                value=${wdFlags}
                onInput=${e => setWdFlags(e.target.value)}
                placeholder="Extra flags for watchdog"
                style="width:100%;padding:7px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
              />
            </div>
          </div>

          <!-- Low Credit Mode -->
          <${SectionHeader}>Low Credit Mode</${SectionHeader}>
          <div class="settings-section">
            <${SettingsRow} label="Enable Low Credit Mode" help="Show override options when credits are low">
              <${Toggle} checked=${lcEnabled} onChange=${setLcEnabled} />
            </${SettingsRow}>
            <${SettingsRow} label="Activate Now" help="Override session & watchdog settings with low-credit values">
              <${Toggle} checked=${lcActive} onChange=${setLcActive} />
            </${SettingsRow}>
            <${SettingsRow} label="Low Credit Model" help="Cheaper model when credits are low">
              <${ModelSelect} value=${lcModel} onChange=${setLcModel} />
            </${SettingsRow}>
            <${SettingsRow} label="Extended Thinking" help="Use --effort max">
              <${Toggle} checked=${lcThinking} onChange=${setLcThinking} />
            </${SettingsRow}>
            <div class="form-group" style="margin-top:8px;">
              <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:4px;">Low Credit Flags</label>
              <input
                class="form-input"
                value=${lcFlags}
                onInput=${e => setLcFlags(e.target.value)}
                placeholder="Override flags for low credit"
                style="width:100%;padding:7px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
              />
            </div>
          </div>

          <!-- Features -->
          <${SectionHeader}>Features</${SectionHeader}>
          <div class="settings-section">
            <${SettingsRow} label="TODO Rewards" help="Show fun facts / videos when completing tasks">
              <${Toggle} checked=${featRewards} onChange=${setFeatRewards} />
            </${SettingsRow}>
          </div>

          <!-- Command Preview -->
          <${SectionHeader}>Effective Command Preview</${SectionHeader}>
          <div
            class="form-input"
            style="font-family:var(--font-mono);font-size:12px;color:var(--accent);background:var(--bg-deep);padding:10px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);word-break:break-all;margin-bottom:4px;"
          >${preview}</div>

        </div>

        <!-- Footer -->
        <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;">
          <button
            class="btn btn-ghost"
            onClick=${closeSettingsModal}
            style="padding:8px 16px;border-radius:var(--radius-sm);background:transparent;border:1px solid var(--border);color:var(--text-primary);cursor:pointer;font-size:13px;"
          >Cancel</button>
          <button
            class="btn btn-primary"
            onClick=${handleSave}
            disabled=${saving}
            style="padding:8px 18px;border-radius:var(--radius-sm);background:var(--accent);color:#000;font-weight:600;font-size:13px;cursor:pointer;border:none;opacity:${saving ? 0.6 : 1};"
          >${saving ? 'Saving…' : 'Save Settings'}</button>
        </div>
      </div>
    </div>
  `;
}
