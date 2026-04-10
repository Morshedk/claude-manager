// @ts-check
import { defineConfig, devices } from 'playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: ['**/adversarial/feat-split-screen-ux-T1-path-dropdown.test.js', '**/adversarial/feat-split-screen-ux-T2-default-split.test.js', '**/adversarial/feat-split-screen-ux-T3-drag-persist.test.js', '**/adversarial/feat-split-screen-ux-T4-scrollbar-hover.test.js', '**/adversarial/feat-split-screen-ux-T5-resize-handles.test.js', '**/adversarial/feat-split-screen-ux-T6-poisoned-localstorage.test.js', '**/adversarial/feat-lastline-T1-basic-appears.test.js', '**/adversarial/feat-lastline-T2-ansi-stripped.test.js', '**/adversarial/feat-lastline-T3-updates.test.js', '**/adversarial/feat-lastline-T4-ws-broadcast.test.js', '**/adversarial/feat-lastline-T5-blank-preserved.test.js', '**/adversarial/feat-lastline-T6-throttle.test.js', '**/adversarial/feat-overlay-auto-open-T1-auto-open.test.js', '**/adversarial/feat-overlay-auto-open-T2-correct-session.test.js', '**/adversarial/feat-overlay-auto-open-T3-reload-no-reopen.test.js', '**/adversarial/feat-overlay-auto-open-T4-rapid-creates.test.js', '**/adversarial/feat-watchdog-panel-reach.test.js', '**/adversarial/feat-watchdog-panel-badge.test.js', '**/adversarial/feat-watchdog-panel-reload.test.js', '**/adversarial/feat-watchdog-panel-500.test.js', '**/adversarial/feat-watchdog-panel-default-tab.test.js', '**/adversarial/T-33-todo-empty-title.test.js', '**/adversarial/T-34-todo-filters.test.js', '**/adversarial/T-43-haiku-endurance.test.js', '**/adversarial/T-37-ws-drop-replay.test.js', '**/adversarial/T-38-sidebar-scale.test.js', '**/adversarial/T-39-corrupted-sessions.test.js', '**/adversarial/T-40-special-char-names.test.js', '**/adversarial/T-46-ws-reconnect-session.test.js', '**/adversarial/T-47-session-cards-layout.test.js', '**/adversarial/T-48-settings-escape.test.js', '**/adversarial/T-49-auth-fail-graceful.test.js', '**/adversarial/T-50-concurrent-refresh.test.js', '**/adversarial/T-29-telegram-badge-reload.test.js', '**/adversarial/T-30-tmux-pid-unchanged.test.js', '**/adversarial/T-31-settings-cancel.test.js', '**/adversarial/T-32-empty-state.test.js', '**/adversarial/T-41-upload-interrupt.test.js', '**/adversarial/T-42-badge-independence.test.js', '**/adversarial/T-44-watchdog-badge.test.js', '**/adversarial/T-45-stop-refresh-race.test.js', '**/adversarial/T-11-first-5-minutes.test.js', '**/adversarial/T-20-two-tabs-refresh.test.js', '**/adversarial/T-24-watchdog-500.test.js', '**/adversarial/T-25-paste-large-input.test.js', '**/adversarial/B-rendering.test.js', '**/adversarial/F-bug-reproductions.test.js', '**/adversarial/F-lifecycle.test.js', '**/adversarial/T-01-double-click.test.js', '**/adversarial/T-02-browser-reload.test.js', '**/adversarial/T-03-refresh-artifacts.test.js', '**/adversarial/T-04-stop-kills-process.test.js', '**/adversarial/T-05-resume-on-refresh.test.js', '**/adversarial/T-06-ws-reconnect.test.js', '**/adversarial/T-07-invalid-command-error.test.js', '**/adversarial/T-08-bad-project-path.test.js', '**/adversarial/T-09-settings-persist.test.js', '**/adversarial/T-10-sidebar-badge.test.js', '**/adversarial/T-12-tmux-survives-close.test.js', '**/adversarial/T-13-project-name-validation.test.js', '**/adversarial/T-14-delete-cancel.test.js', '**/adversarial/T-15-scroll-freeze.test.js', '**/adversarial/T-16-refresh-during-starting.test.js', '**/adversarial/T-17-server-restart-recovery.test.js', '**/adversarial/T-18-project-switch-race.test.js', '**/adversarial/T-19-lastline-updates.test.js', '**/adversarial/T-21-low-credit-mode.test.js', '**/adversarial/T-22-delete-with-overlay.test.js', '**/adversarial/T-23-telegram-unconfigured.test.js', '**/adversarial/T-26-split-view.test.js', '**/adversarial/T-27-resize-pty.test.js', '**/adversarial/T-28-no-delete-while-running.test.js',
    '**/adversarial/T-51-refresh-typing.test.js'],
  timeout: 1_200_000, // 20 min — F lifecycle test uses real Claude binary
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
