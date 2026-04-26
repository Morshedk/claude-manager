// @ts-check
import { defineConfig, devices } from 'playwright/test';

// Jest-based adversarial tests (C/D/E/G categories and some feat-* files) are excluded —
// they use @jest/globals and must run via `npm test`, not Playwright.
const PLAYWRIGHT_TESTS = [
  // ── feat: split-screen ────────────────────────────────────────────────────
  '**/adversarial/feat-split-screen-ux-T1-path-dropdown.test.js',
  '**/adversarial/feat-split-screen-ux-T2-default-split.test.js',
  '**/adversarial/feat-split-screen-ux-T3-drag-persist.test.js',
  '**/adversarial/feat-split-screen-ux-T4-scrollbar-hover.test.js',
  '**/adversarial/feat-split-screen-ux-T5-resize-handles.test.js',
  '**/adversarial/feat-split-screen-ux-T6-poisoned-localstorage.test.js',
  // ── feat: overlay auto-open (T4 excluded — Jest) ─────────────────────────
  '**/adversarial/feat-overlay-auto-open-T1-auto-open.test.js',
  '**/adversarial/feat-overlay-auto-open-T2-correct-session.test.js',
  '**/adversarial/feat-overlay-auto-open-T3-reload-no-reopen.test.js',
  // ── feat: watchdog panel ──────────────────────────────────────────────────
  '**/adversarial/feat-watchdog-panel-reach.test.js',
  '**/adversarial/feat-watchdog-panel-badge.test.js',
  '**/adversarial/feat-watchdog-panel-reload.test.js',
  '**/adversarial/feat-watchdog-panel-500.test.js',
  '**/adversarial/feat-watchdog-panel-default-tab.test.js',
  // ── feat: delete toggle (T2-T9 are Jest, excluded) ───────────────────────
  '**/adversarial/feat-delete-toggle-T1-mode-toggle.test.js',
  '**/adversarial/feat-delete-toggle-T7-armed-outline-toast.test.js',
  // ── feat: move session (T1-T4,T6 are Jest; T5 is Playwright) ─────────────
  '**/adversarial/feat-move-session-T5-browser-ui.test.js',
  // ── feat: session cards (T2-T4 are Jest; T1,T5-T7 are Playwright) ────────
  '**/adversarial/feat-session-cards-T1-dom-structure.test.js',
  '**/adversarial/feat-session-cards-T5-ansi-stripping.test.js',
  '**/adversarial/feat-session-cards-T6-wrench-opens-modal.test.js',
  '**/adversarial/feat-session-cards-T7-btn-icon-css-regression.test.js',
  // ── feat: terminal copy + scrollbar ──────────────────────────────────────
  '**/adversarial/feat-terminal-copy-scrollbar-T1-ctrl-c-copies-no-sigint.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T2-ctrl-c-no-selection-sends-sigint.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T3-scrollbar-always-visible.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T4-right-click-copies-no-context-menu.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T5-ctrl-shift-c-copy-alt.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T6-copy-works-readonly-mode.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T7-rapid-ctrl-c-flickering.test.js',
  '**/adversarial/feat-terminal-copy-scrollbar-T8-project-terminal-pane-copy.test.js',
  // ── feat: image paste ────────────────────────────────────────────────────
  '**/adversarial/feat-paste-image.test.js',
  // ── T-series: browser + server ───────────────────────────────────────────
  '**/adversarial/T-01-double-click.test.js',
  '**/adversarial/T-02-browser-reload.test.js',
  '**/adversarial/T-03-refresh-artifacts.test.js',
  '**/adversarial/T-04-stop-kills-process.test.js',
  '**/adversarial/T-05-resume-on-refresh.test.js',
  '**/adversarial/T-06-ws-reconnect.test.js',
  '**/adversarial/T-07-invalid-command-error.test.js',
  '**/adversarial/T-08-bad-project-path.test.js',
  '**/adversarial/T-09-settings-persist.test.js',
  '**/adversarial/T-10-sidebar-badge.test.js',
  '**/adversarial/T-11-first-5-minutes.test.js',
  '**/adversarial/T-12-tmux-survives-close.test.js',
  '**/adversarial/T-13-project-name-validation.test.js',
  '**/adversarial/T-14-delete-cancel.test.js',
  '**/adversarial/T-15-scroll-freeze.test.js',
  '**/adversarial/T-16-refresh-during-starting.test.js',
  '**/adversarial/T-17-server-restart-recovery.test.js',
  '**/adversarial/T-18-project-switch-race.test.js',
  '**/adversarial/T-19-lastline-updates.test.js',
  '**/adversarial/T-20-two-tabs-refresh.test.js',
  '**/adversarial/T-21-low-credit-mode.test.js',
  '**/adversarial/T-22-delete-with-overlay.test.js',
  '**/adversarial/T-23-telegram-unconfigured.test.js',
  '**/adversarial/T-24-watchdog-500.test.js',
  '**/adversarial/T-25-paste-large-input.test.js',
  '**/adversarial/T-26-split-view.test.js',
  '**/adversarial/T-27-resize-pty.test.js',
  '**/adversarial/T-28-no-delete-while-running.test.js',
  '**/adversarial/T-29-telegram-badge-reload.test.js',
  '**/adversarial/T-30-tmux-pid-unchanged.test.js',
  '**/adversarial/T-31-settings-cancel.test.js',
  '**/adversarial/T-32-empty-state.test.js',
  '**/adversarial/T-33-todo-empty-title.test.js',
  '**/adversarial/T-34-todo-filters.test.js',
  '**/adversarial/T-37-ws-drop-replay.test.js',
  '**/adversarial/T-38-sidebar-scale.test.js',
  '**/adversarial/T-39-corrupted-sessions.test.js',
  '**/adversarial/T-40-special-char-names.test.js',
  '**/adversarial/T-41-upload-interrupt.test.js',
  '**/adversarial/T-42-badge-independence.test.js',
  '**/adversarial/T-43-haiku-endurance.test.js',
  '**/adversarial/T-44-watchdog-badge.test.js',
  '**/adversarial/T-45-stop-refresh-race.test.js',
  '**/adversarial/T-46-ws-reconnect-session.test.js',
  '**/adversarial/T-47-session-cards-layout.test.js',
  '**/adversarial/T-48-settings-escape.test.js',
  '**/adversarial/T-49-auth-fail-graceful.test.js',
  '**/adversarial/T-50-concurrent-refresh.test.js',
  '**/adversarial/T-51-refresh-typing.test.js',
  '**/adversarial/T-52-session-switch-no-garble.test.js',
  '**/adversarial/T-53-events-bottom-tab.test.js',
  '**/adversarial/T-54-pulse-metrics.test.js',
  '**/adversarial/T-55-command-buffer.test.js',
  '**/adversarial/T-56-logging-p1.test.js',
  // ── B / F series ─────────────────────────────────────────────────────────
  '**/adversarial/B-rendering.test.js',
  '**/adversarial/F-bug-reproductions.test.js',
  '**/adversarial/F-lifecycle.test.js',
];

export default defineConfig({
  testDir: './tests',
  testMatch: PLAYWRIGHT_TESTS,
  timeout: 1_200_000, // 20 min — F-lifecycle test uses real Claude binary
  retries: 0,
  workers: 1, // sequential — tests share a single server process
  reporter: [['line'], ['json', { outputFile: 'qa-screenshots/adversarial-B/results.json' }]],
  use: {
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
