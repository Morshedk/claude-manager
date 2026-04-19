import { html } from 'htm/preact';
import { useState, useEffect } from 'preact/hooks';
import { settings, newSessionModalOpen, selectedProject } from '../state/store.js';
import { createSession, closeNewSessionModal, showToast } from '../state/actions.js';

const MODEL_IDS = {
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

const QUICK_MODELS = [
  { name: 'Sonnet', command: 'claude --model claude-sonnet-4-6' },
  { name: 'Sonnet + thinking', command: 'claude --model claude-sonnet-4-6 --effort max' },
  { name: 'Opus + thinking', command: 'claude --model claude-opus-4-6 --effort max' },
  { name: 'Haiku', command: 'claude --model claude-haiku-4-5-20251001' },
];

function buildDefaultCommand(s) {
  if (!s) return 'claude';
  const lc = s.lowCredit;
  const useLowCredit = lc && lc.enabled && lc.active;
  const src = useLowCredit ? lc : (s.session || {});
  const model = src.defaultModel || 'sonnet';
  const thinking = src.extendedThinking || false;
  const flags = src.defaultFlags || '';
  let cmd = 'claude';
  const modelId = MODEL_IDS[model] || model;
  if (modelId) cmd += ` --model ${modelId}`;
  if (thinking) cmd += ' --effort max';
  if (flags.trim()) cmd += ` ${flags.trim()}`;
  return cmd;
}

/**
 * NewSessionModal — create session modal.
 * Session name, command with model/effort flags builder, mode toggle, Telegram toggle.
 * Shows/hides based on newSessionModalOpen signal.
 */
export function NewSessionModal() {
  const project = selectedProject.value;
  const s = settings.value;

  const defaultCmd = buildDefaultCommand(s);
  const isLowCredit = s && s.lowCredit && s.lowCredit.enabled && s.lowCredit.active;
  const settingsMode = (s && s.session && s.session.defaultMode) || 'tmux';

  const [sessionName, setSessionName] = useState('');
  const [command, setCommand] = useState(defaultCmd);
  const [mode, setMode] = useState(settingsMode);
  const [telegramEnabled, setTelegramEnabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [telegramConfigured, setTelegramConfigured] = useState(true);
  const [checkingTelegram, setCheckingTelegram] = useState(false);

  // Reset form when modal opens
  useEffect(() => {
    if (!newSessionModalOpen.value) return;
    const s2 = settings.value;
    setSessionName('');
    setCommand(buildDefaultCommand(s2));
    setMode((s2 && s2.session && s2.session.defaultMode) || 'direct');
    setTelegramEnabled(false);

    // Check telegram status
    setCheckingTelegram(true);
    fetch('/api/telegram/status')
      .then(r => r.json())
      .then(status => setTelegramConfigured(!!status.configured))
      .catch(() => setTelegramConfigured(false))
      .finally(() => setCheckingTelegram(false));
  }, [newSessionModalOpen.value]);

  function handleCreate() {
    if (submitting) return;
    if (!project) {
      showToast('No project selected', 'error');
      return;
    }
    setSubmitting(true);
    const cmd = command.trim() || 'claude';
    const name = sessionName.trim() || null;
    createSession(project.id, { command: cmd, name, mode, telegram: telegramEnabled });
    closeNewSessionModal();
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') closeNewSessionModal();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleCreate();
  }

  if (!newSessionModalOpen.value) return null;

  return html`
    <div
      class="modal-overlay"
      onClick=${closeNewSessionModal}
      onKeyDown=${handleKeyDown}
      style="position:fixed;inset:0;background:rgba(0,0,0,0.65);display:flex;align-items:center;justify-content:center;z-index:200;"
    >
      <div
        class="modal"
        onClick=${e => e.stopPropagation()}
        style="background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);width:min(500px,95vw);display:flex;flex-direction:column;max-height:90vh;"
      >
        <!-- Header -->
        <div class="modal-header" style="display:flex;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border);flex-shrink:0;">
          <h2 style="font-size:15px;font-weight:600;color:var(--text-bright);flex:1;margin:0;">
            New Session${project ? ` — ${project.name}` : ''}
          </h2>
          <button
            onClick=${closeNewSessionModal}
            style="font-size:20px;color:var(--text-muted);background:none;border:none;cursor:pointer;line-height:1;padding:0;"
          >×</button>
        </div>

        <!-- Body -->
        <div class="modal-body" style="flex:1;overflow-y:auto;padding:16px 20px;display:flex;flex-direction:column;gap:14px;">

          <!-- Session name -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Session Name (optional)</label>
            <input
              class="form-input"
              value=${sessionName}
              onInput=${e => setSessionName(e.target.value)}
              placeholder="e.g. refactor, auth, bugfix"
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;box-sizing:border-box;"
            />
          </div>

          <!-- Model / command -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Model</label>
            ${isLowCredit ? html`
              <div style="font-size:11px;font-weight:700;color:var(--warning);padding:4px 8px;background:rgba(232,160,32,0.1);border-radius:var(--radius-sm);margin-bottom:8px;display:inline-block;">
                LOW CREDIT MODE ACTIVE
              </div>
            ` : null}
            <!-- Quick model buttons -->
            <div class="quick-commands" style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
              ${QUICK_MODELS.map(m => html`
                <button
                  key=${m.name}
                  class="quick-cmd"
                  onClick=${() => setCommand(m.command)}
                  style=${`font-size:11px;padding:4px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${command === m.command ? 'var(--accent)' : 'transparent'};color:${command === m.command ? '#000' : 'var(--text-secondary)'};cursor:pointer;`}
                >${m.name}</button>
              `)}
            </div>
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Command</label>
            <input
              class="form-input"
              value=${command}
              onInput=${e => setCommand(e.target.value)}
              placeholder="claude"
              style="width:100%;padding:8px 10px;background:var(--bg-surface);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text-primary);font-size:13px;font-family:var(--font-mono);box-sizing:border-box;"
            />
            <div class="form-help" style="font-size:11px;color:var(--text-muted);margin-top:3px;">Built from Settings. Override per-session using quick buttons above.</div>
          </div>

          <!-- Session mode -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Session Mode</label>
            <div class="quick-commands" style="display:flex;gap:6px;margin-bottom:4px;">
              <button
                class=${'quick-cmd' + (mode === 'direct' ? ' active' : '')}
                onClick=${() => setMode('direct')}
                style=${`font-size:12px;padding:6px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${mode === 'direct' ? 'var(--accent)' : 'transparent'};color:${mode === 'direct' ? '#000' : 'var(--text-secondary)'};cursor:pointer;font-weight:${mode === 'direct' ? '600' : '400'};`}
              >Direct</button>
              <button
                class=${'quick-cmd' + (mode === 'tmux' ? ' active' : '')}
                onClick=${() => setMode('tmux')}
                style=${`font-size:12px;padding:6px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${mode === 'tmux' ? 'var(--accent)' : 'transparent'};color:${mode === 'tmux' ? '#000' : 'var(--text-secondary)'};cursor:pointer;font-weight:${mode === 'tmux' ? '600' : '400'};`}
              >Tmux</button>
            </div>
            <div class="form-help" style="font-size:11px;color:var(--text-muted);">Direct: session auto-resumes after restart. Tmux: process stays alive during restart.</div>
          </div>

          <!-- Telegram -->
          <div class="form-group">
            <label class="form-label" style="font-size:12px;color:var(--text-secondary);display:block;margin-bottom:5px;">Telegram</label>
            <div class="quick-commands" style="margin-bottom:4px;">
              <button
                class=${'quick-cmd telegram-toggle' + (telegramEnabled ? ' active' : '')}
                onClick=${() => telegramConfigured && setTelegramEnabled(v => !v)}
                disabled=${!telegramConfigured || checkingTelegram}
                style=${`font-size:12px;padding:6px 14px;border-radius:var(--radius-sm);border:1px solid var(--border);background:${telegramEnabled ? 'var(--accent)' : 'transparent'};color:${telegramEnabled ? '#000' : 'var(--text-secondary)'};cursor:${telegramConfigured ? 'pointer' : 'not-allowed'};opacity:${telegramConfigured ? 1 : 0.4};font-weight:${telegramEnabled ? '600' : '400'};`}
              >${telegramEnabled ? 'Telegram On' : 'Enable Telegram'}</button>
            </div>
            <div class="form-help" style="font-size:11px;color:${telegramConfigured ? 'var(--text-muted)' : 'var(--warning)'};">
              ${telegramConfigured
                ? 'Connect this session to Telegram for remote messaging'
                : 'Telegram not configured — run /telegram:configure first'}
            </div>
          </div>

        </div>

        <!-- Footer -->
        <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:14px 20px;border-top:1px solid var(--border);flex-shrink:0;">
          <button
            class="btn btn-ghost"
            onClick=${closeNewSessionModal}
            style="padding:8px 16px;border-radius:var(--radius-sm);background:transparent;border:1px solid var(--border);color:var(--text-primary);cursor:pointer;font-size:13px;"
          >Cancel</button>
          <button
            class="btn btn-primary"
            onClick=${handleCreate}
            disabled=${submitting}
            style=${`padding:8px 18px;border-radius:var(--radius-sm);background:var(--accent);color:#000;font-weight:600;font-size:13px;border:none;cursor:${submitting ? 'not-allowed' : 'pointer'};opacity:${submitting ? 0.6 : 1};`}
          >Start Session</button>
        </div>
      </div>
    </div>
  `;
}
