# LIFECYCLE_TESTS.md

## Living Specification — Claude Manager v2

This document is the user story specification that *should have been written before the first line of code*. It is retroactively written from the finished implementation to capture, in human terms, exactly what "done" looks like from a user's point of view.

Each story is written at a level of specificity that allows a test agent to translate it directly into a Playwright test: observable actions, observable outcomes, and explicit failure conditions. This is the contract between the product and its tests.

These stories are "living" in the sense that they should be updated whenever the product changes — not as an afterthought, but as the primary artifact that defines the product's behavior.

---

## Story 1: First-Time Setup — Create a Project

**As a user, I want to:** register an existing directory on disk as a project so I can start managing Claude sessions inside it.

**Journey:**
1. User opens the app. The sidebar shows "No projects yet — add one below."
2. User clicks "New Project" in the sidebar footer.
3. A modal appears titled "New Project" with two fields: "Project Name" and "Project Path."
4. User types "My App" in the name field and "/home/user/my-app" in the path field.
5. User clicks "Create Project."
6. The modal closes. A success toast appears: `Project "My App" created`.
7. "My App" appears in the sidebar project list with its path visible beneath the name.
8. The project is now selected and the main pane shows "Sessions — My App" with an empty session list.

**Success criteria:**
- The project appears in the sidebar immediately after creation without a page reload.
- The project badge shows "idle" (no sessions running).
- The main content area switches to the new project automatically.
- No error toast appears.
- Submitting with an empty name shows an error toast "Project name is required" and does not close the modal.
- Submitting with an empty path shows an error toast "Project path is required" and does not close the modal.

**Why this matters:** If project creation silently fails or doesn't update the sidebar, users have no starting point for the rest of the app.

---

## Story 2: Project Selection and Sidebar Navigation

**As a user, I want to:** switch between projects and see each project's sessions without losing context on the other.

**Journey:**
1. User has two projects in the sidebar: "Frontend" and "Backend."
2. User clicks "Frontend." The main pane shows "Sessions — Frontend." The "Frontend" item is highlighted in the sidebar.
3. User creates two sessions in Frontend; the sidebar badge updates to "2 sessions running."
4. User clicks "Backend." The main pane shows "Sessions — Backend" (empty). The "Backend" item is now highlighted.
5. "Frontend" now shows "2 sessions running" badge but is not selected.
6. User clicks "Frontend" again. The sessions list reappears showing the two previously created sessions.

**Success criteria:**
- Only one project is highlighted in the sidebar at a time.
- Switching projects does not stop or modify any sessions.
- The session count badge in the sidebar reflects live running session count for each project independently.
- Selecting a project with no sessions shows "No sessions — start one with the button above."

**Why this matters:** If project state is lost when switching, users must constantly recreate context, defeating the purpose of multi-project management.

---

## Story 3: Create a Direct-Mode Session

**As a user, I want to:** start a new Claude Code process in direct mode from the browser, have it open in the terminal overlay, and be ready to receive input within a few seconds.

**Journey:**
1. User selects a project. Clicks "New Claude Session."
2. The "New Session" modal appears showing: session name input, model quick-buttons (Sonnet, Sonnet+thinking, Opus+thinking, Haiku), command field, mode toggle (Direct/Tmux), and Telegram toggle.
3. User types "refactor" in the session name field.
4. User clicks "Sonnet" quick button. The command field updates to `claude --model claude-sonnet-4-6`.
5. The mode is already set to "Direct" (default). User leaves it.
6. User clicks "Start Session."
7. The modal closes. A session card appears in the project sessions list showing name "refactor", state badge "starting," and mode badge "direct."
8. The terminal overlay opens automatically (full-screen), showing the xterm.js terminal.
9. Within 3 seconds, Claude's startup output appears in the terminal. The session card badge transitions to "running."
10. User types "Hello" into the terminal and presses Enter. Claude responds in the terminal.

**Success criteria:**
- Session card appears before the Claude process fully starts.
- Terminal receives live output without requiring a page action.
- Session state transitions: created → starting → running, reflected in the badge.
- The session name "refactor" appears in the overlay header.
- Typing in the terminal sends keystrokes to the Claude process.
- The session card's `lastLine` field updates to show recent output.

**Why this matters:** This is the core user action. If session creation or terminal attachment breaks, the entire product is unusable.

---

## Story 4: Create a Tmux-Mode Session

**As a user, I want to:** start a Claude session inside tmux so that the Claude process continues running even if I close my browser tab.

**Journey:**
1. User opens "New Claude Session" modal.
2. User clicks the "Tmux" mode button. It becomes highlighted. The mode hint below reads: "Direct: session auto-resumes after restart. Tmux: process stays alive during restart."
3. User clicks "Start Session."
4. A session card appears with a "tmux" mode badge.
5. User opens the terminal overlay, interacts with Claude.
6. User closes the browser tab entirely.
7. User opens the app in a new tab.
8. The same session card is visible, still showing "running." The tmux badge is present.
9. User clicks "Open" on the session card. The terminal overlay opens and shows Claude's existing terminal output (the conversation is still live in tmux).

**Success criteria:**
- Session card shows `badge-mode-tmux` CSS class.
- After closing and reopening the browser, the session state is still "running."
- Re-attaching to the tmux session shows the existing terminal content, not a blank screen.
- Claude is still responsive to new input after re-attach.

**Why this matters:** Tmux mode is the main feature for users who want Claude to keep working unattended. If the session dies on browser close, tmux mode provides no value over direct mode.

---

## Story 5: Interact With the Terminal — Typing and Scrollback

**As a user, I want to:** type messages to Claude and scroll up through the conversation history without losing the live output stream.

**Journey:**
1. User has a running session open in the terminal overlay.
2. User types a long prompt: "Write a detailed explanation of the difference between synchronous and asynchronous programming." Presses Enter.
3. Claude generates a multi-screen response. The terminal auto-scrolls to keep the latest output visible.
4. User scrolls up using the mouse wheel. The terminal stops auto-scrolling. Previous output is visible.
5. User scrolls back down to the bottom. Auto-scrolling resumes. New Claude output appears as it streams.
6. User types another message. The terminal accepts the input and sends it.

**Success criteria:**
- Scrollback holds at least 10,000 lines (configured in xterm.js).
- Scrolling up freezes auto-scroll; scrolling back to the bottom re-enables it.
- The terminal does not snap to the bottom while the user is scrolled up.
- Typing is not blocked by the scroll position — input always goes to the PTY.
- No dot artifacts or rendering corruption appear in the scrollback.

**Why this matters:** Scroll-hijacking (auto-scroll overriding the user's scroll position) was the primary UX bug that motivated the v2 rewrite. If it regresses, the app is unusable for long conversations.

---

## Story 6: Terminal Overlay — Split View vs Full View

**As a user, I want to:** view the terminal alongside my session list without losing sight of other running sessions.

**Journey:**
1. User has an open session in the terminal overlay (full-screen mode by default).
2. User clicks the "Split" button in the overlay header.
3. The terminal overlay shrinks to occupy the right half of the screen. The session list remains visible on the left.
4. The user can see session cards in the left panel while the terminal is active on the right.
5. User clicks "Full" in the overlay header.
6. The terminal overlay expands back to full-screen.

**Success criteria:**
- In split mode, the left half shows the project sidebar and session list.
- In split mode, a vertical border separates the two panes.
- The terminal is fully functional (input, output, resize) in both modes.
- The toggle button label changes between "Split" and "Full" depending on current mode.
- The terminal re-fits to the new dimensions after toggling (no horizontal overflow or wasted whitespace).

**Why this matters:** Split view is the primary monitoring pattern. Users who run multiple sessions need to watch one while managing others.

---

## Story 7: Stop a Running Session

**As a user, I want to:** stop a running Claude session cleanly so that the process is terminated and the session card reflects the stopped state.

**Journey:**
1. User has a running session "refactor" open in the terminal overlay.
2. User clicks the "Stop" button in the overlay header.
3. A toast appears: "Stopping session…"
4. The Claude process terminates. The terminal shows the process exit.
5. The session card badge transitions to "stopped." The "Stop" button in the overlay disappears. The "Stop" button on the session card is replaced by "Refresh" and "Delete."
6. The status dot in the overlay header changes from green (accent) to gray (muted).

**Journey (alternate — stop from card):**
1. User sees the session card without opening the overlay.
2. User clicks "Stop" on the card.
3. A toast appears: "Stopping session…"
4. The card badge transitions to "stopped."

**Success criteria:**
- The Claude process is actually terminated (not just the UI state updated).
- The session card badge changes from "running" to "stopped" within 3 seconds of clicking Stop.
- A stopped session can be refreshed (restarted) but not stopped again (no duplicate Stop buttons shown).
- The session record persists — the card remains visible in the list after stopping.

**Why this matters:** If stop doesn't actually kill the process, users have runaway Claude processes consuming credits and compute uncontrolled.

---

## Story 8: Refresh (Restart) a Direct Session with Conversation Continuity

**As a user, I want to:** restart a stopped direct session and have Claude resume the existing conversation, not start a fresh one.

**Journey:**
1. User has a stopped direct session (previously ran and was stopped).
2. User clicks "Refresh" on the session card.
3. A toast appears: "Refreshing session…"
4. The session card badge transitions to "starting" then "running."
5. The terminal overlay opens (or if already open, the terminal resets and shows fresh output).
6. Claude's startup shows it is resuming an existing conversation (e.g., `--resume` flag output visible).
7. User types a follow-up message. Claude responds with context from the previous conversation.

**Journey (refresh a running session):**
1. User has a running direct session. Mid-conversation, Claude appears stuck.
2. User clicks "Refresh" in the overlay header.
3. The current PTY process is killed. A new one starts immediately.
4. The terminal clears (xterm.reset()) and shows Claude restarting with `--resume`.
5. The conversation context is preserved — Claude can answer follow-up questions.

**Success criteria:**
- Direct session refresh always uses `--resume` if a conversation file exists.
- The terminal buffer is cleared (xterm.reset) on refresh — no dot artifacts from replaying old bytes.
- Session state goes through starting → running, not directly to error.
- The `claudeSessionId` field on the session card is stable across refreshes.
- Refreshing during STARTING state is blocked with a clear error.

**Why this matters:** Refresh-with-resume is the core recovery mechanic. If refresh starts a fresh conversation, users lose all their work with Claude.

---

## Story 9: Refresh a Tmux Session

**As a user, I want to:** refresh a tmux session (re-attach the PTY viewer) without killing the Claude process running inside tmux.

**Journey:**
1. User has a running tmux session with an active Claude conversation.
2. User clicks "Refresh" in the overlay header.
3. A toast appears: "Refreshing session…"
4. The terminal clears and reattaches to the existing tmux pane.
5. Claude's conversation output is visible immediately — the process was never killed.
6. User types a new message. Claude responds.

**Success criteria:**
- The Claude process PID inside tmux is unchanged after refresh (process was not killed).
- The tmux session name (e.g., `cm-<id>`) is unchanged.
- The terminal shows the tmux pane content after reattach.
- If the underlying tmux session is dead (e.g., server was rebooted), the refresh falls back to a clean start.

**Why this matters:** For long-running tmux sessions, refresh should re-attach — not kill — the process. If it kills tmux, the user loses a running Claude job.

---

## Story 10: Browser Reload — Reconnect Without Data Loss

**As a user, I want to:** reload the browser tab and find all my projects and sessions exactly as I left them.

**Journey:**
1. User has two projects. Project "Frontend" has one running session, one stopped session.
2. User presses Ctrl+R (hard reload).
3. The page reloads. The WebSocket reconnects.
4. Both projects appear in the sidebar.
5. "Frontend" is not pre-selected (the app starts with no selection, or restores the last selected project).
6. User clicks "Frontend." Both sessions appear — one still "running," one "stopped."
7. User opens the running session. The terminal shows live output from the still-running Claude process.

**Success criteria:**
- All projects and sessions survive a hard browser reload.
- Session states are accurate (running sessions still running, stopped sessions still stopped).
- The WebSocket reconnects within 5 seconds of page load.
- The connection status dot in the TopBar shows "Connected" after reconnect.
- No duplicate sessions appear in the list.

**Why this matters:** If reload loses session state, every accidental refresh or network hiccup destroys the user's work context.

---

## Story 11: Server Restart Recovery — Sessions Come Back

**As a user, I want to:** have my sessions reappear after the Node.js server is restarted, with running sessions correctly detected and stopped sessions preserved.

**Journey:**
1. User has a running tmux session and a stopped direct session.
2. The server is restarted (e.g., `kill -9` + restart).
3. User reloads the browser.
4. Both sessions reappear in the session list.
5. The tmux session shows "running" (the tmux process survived the server restart).
6. The direct session shows "stopped" (the direct PTY was killed with the server, but the session record and conversation file are preserved).
7. User clicks "Refresh" on the direct session. Claude resumes with `--resume` from the conversation file.

**Success criteria:**
- Session records are persisted to disk and reloaded on server start.
- Tmux sessions are detected as running if their tmux session still exists.
- Direct sessions default to "stopped" after server restart (PTY was killed with the server).
- The `claudeSessionId` (conversation ID) survives server restart so `--resume` works.
- No session records are lost or corrupted by an unclean shutdown.

**Why this matters:** Server restarts happen. If users lose all their session state, they can't pick up where they left off, which defeats the persistent session model.

---

## Story 12: WebSocket Disconnect and Automatic Reconnect

**As a user, I want to:** have the app automatically reconnect to the server after a network interruption, without me having to take any action.

**Journey:**
1. User is watching a running session in the terminal overlay.
2. The network drops momentarily (simulated by killing the WS connection).
3. The TopBar status dot turns red: "Disconnected."
4. The terminal freezes — no new output.
5. After 3–10 seconds, the WebSocket reconnects automatically.
6. The status dot turns green: "Connected."
7. The session is re-subscribed. The terminal resumes showing live output.
8. No user action was required.

**Success criteria:**
- Reconnect happens without a page reload.
- The session list is refreshed after reconnect (sessions added during disconnect appear).
- The terminal re-subscribes to the active session automatically.
- If the session was refreshed during the disconnect, the terminal reflects the current state.
- The status dot accurately reflects connection state in real time.

**Why this matters:** WebSocket drops are common on flaky networks. Manual reconnect breaks the "always-on monitoring" use case.

---

## Story 13: Multi-Session Management — Multiple Sessions Visible

**As a user, I want to:** run multiple Claude sessions simultaneously on a project and see their live status on the session cards without opening each one.

**Journey:**
1. User creates three sessions on a project: "auth", "frontend", "tests."
2. All three session cards appear in the list showing their states.
3. "auth" is running (badge: "running"), "frontend" is running, "tests" is stopped.
4. The session card for "auth" shows the `lastLine` — the most recent output line from Claude.
5. User opens "auth" in the overlay. Types a message. The `lastLine` on the card updates while the overlay is open.
6. User closes the overlay. All three cards are still visible with updated states.
7. The project sidebar badge shows "2 sessions running" (matching the two running sessions).

**Success criteria:**
- Up to at least 5 session cards render without layout issues.
- `lastLine` on each card reflects the most recent terminal output.
- `watchdogSummary` (if populated) appears below the lastLine in smaller text.
- The sidebar badge running count matches the actual number of running sessions.
- Opening one session does not stop or affect the others.

**Why this matters:** The core value of the app is parallel session management. If users can only see one session at a time, they might as well use a terminal directly.

---

## Story 14: Delete a Session

**As a user, I want to:** permanently delete a stopped session and have it removed from the list and cleaned up on disk.

**Journey:**
1. User has a stopped session "old-refactor."
2. User clicks "Delete" on the session card.
3. A browser confirmation dialog appears: `Delete session "old-refactor"?`
4. User clicks OK.
5. The session card is removed from the list immediately.
6. No "Delete" button appears for running sessions — only "Stop."

**Success criteria:**
- The confirmation dialog appears before deletion.
- Canceling the dialog leaves the session intact.
- The session record is removed from the server's persistent store.
- The session's conversation file on disk is cleaned up (or at minimum the session record is gone).
- Running sessions do not show a Delete button.
- After deletion, the session ID is never reused in the same session list.

**Why this matters:** If deleted sessions reappear after reload, or if sessions pile up indefinitely, the session list becomes unmanageable.

---

## Story 15: Watchdog Monitoring — Status Panel and Log Entries

**As a user, I want to:** see the watchdog's current status, configuration, and recent activity without leaving the app.

**Journey:**
1. User selects a project. The lower portion of the project detail shows a "Watchdog" panel (or the user navigates to it).
2. The panel shows: "Watchdog — ENABLED" (green badge), model name, interval in minutes, and "Last Tick" timestamp.
3. The "Recent Activity" section shows a list of log entries from the watchdog's last run.
4. Each entry shows a log level badge (info/warn/error), a relative timestamp, and a message.
5. User clicks "Refresh" in the watchdog panel. The log entries reload.
6. User opens Settings, changes the watchdog interval to 10 minutes, saves.
7. The watchdog panel now shows "10 min" in the Interval card.

**Success criteria:**
- If watchdog is enabled, the badge shows "ENABLED" in green.
- If watchdog is disabled, the badge shows "DISABLED" in muted color, and log activity shows the disabled message.
- The "Last Tick" card shows a human-readable relative time (e.g., "3m ago") or "—" if never run.
- Log entries with `level: 'error'` show the error color.
- The panel gracefully handles a missing `/api/watchdog/logs` endpoint (shows empty state, not an error crash).

**Why this matters:** Watchdog is a background process. Without a visible status panel, users have no way to know if it's working or why it failed.

---

## Story 16: Settings — Default Model and Command Preview

**As a user, I want to:** configure the default model for all new sessions so that I don't have to pick it every time.

**Journey:**
1. User clicks "Settings" in the top bar.
2. The Settings modal opens with sections: Session Defaults, Watchdog v2, Low Credit Mode, Features, and Effective Command Preview.
3. User changes "Default Model" to "Haiku."
4. The "Effective Command Preview" at the bottom updates in real time to show `claude --model claude-haiku-4-5-20251001`.
5. User toggles "Extended Thinking" on. The preview updates to `claude --model claude-haiku-4-5-20251001 --effort max`.
6. User clicks "Save Settings." A success toast appears: "Settings saved." The modal closes.
7. User opens "New Session" modal. The command field now pre-fills with the Haiku command.

**Success criteria:**
- The command preview updates live as settings change (before saving).
- Saving settings persists them across browser reloads.
- The New Session modal's default command reflects the saved settings on next open.
- "Cancel" discards changes without saving.
- Clicking outside the modal dismisses it without saving.
- Pressing Escape closes the modal without saving.

**Why this matters:** If settings don't propagate to new sessions, users must manually fix the command every time, eliminating the value of global defaults.

---

## Story 17: Low Credit Mode — Override Session Command

**As a user, I want to:** activate low-credit mode to switch all new sessions to a cheaper model automatically when my API credits are running low.

**Journey:**
1. User opens Settings.
2. User enables "Enable Low Credit Mode" toggle. Additional fields appear: model, thinking toggle, flags.
3. User sets Low Credit Model to "Haiku." Leaves thinking off.
4. User toggles "Activate Now" on.
5. The Session Defaults section's command preview changes to reflect the low-credit model, not the standard session default.
6. A "LOW CREDIT MODE ACTIVE" warning badge appears in the New Session modal when the user opens it next.
7. The command field in New Session modal pre-fills with the haiku command.
8. User deactivates "Activate Now." The command preview reverts to the standard model.

**Success criteria:**
- When Low Credit is active, the effective command uses `lcModel`, `lcThinking`, and `lcFlags` instead of standard values.
- The "LOW CREDIT MODE ACTIVE" warning is visually distinct (orange/warning color).
- Disabling Low Credit Mode restores normal defaults immediately.
- Settings persist across browser reloads.

**Why this matters:** Users running Claude on tight credit budgets need a one-click way to prevent expensive models from running without reviewing every session individually.

---

## Story 18: TODO Panel — Add, Complete, and Delete Tasks

**As a user, I want to:** manage a task list for my project that integrates with watchdog-generated TODOs and my own manually added items.

**Journey:**
1. User selects a project. The TODO panel is visible in the project detail area (or in a tab).
2. The panel shows "No TODOs yet" with the note that items auto-generate from session activity.
3. User clicks "+ Add." An inline form appears with fields: title, priority select (low/medium/high), time estimate, and "Blocked by."
4. User types "Refactor authentication module," sets priority to "High," estimate to "2h." Clicks "Add."
5. The form closes. A new TODO card appears with the title, a red "HIGH" priority label, and "2h" estimate.
6. User clicks the checkbox on the TODO card. The title gets a strikethrough. A "Claim Reward" button appears.
7. User clicks "Claim Reward." A reward (fun fact or embedded video) appears in the card.
8. User clicks "×" on a TODO card. It is deleted.

**Success criteria:**
- Priority filter buttons (all/high/medium/low) correctly filter the visible items.
- Status filter buttons (pending/completed/all) correctly filter the visible items.
- Completing a TODO changes its appearance (strikethrough, reduced opacity).
- The "Claim Reward" button only appears on completed items that have a reward.
- Pressing Enter in the title field submits the add form.
- The "Refresh" button in the TODO panel header triggers a server-side refresh of watchdog-generated TODOs.
- The "updated X ago" meta text shows when the list was last refreshed.

**Why this matters:** The TODO panel is the primary human-readable output of the watchdog. If it doesn't work, users can't see what Claude has been doing or what remains.

---

## Story 19: Telegram Integration — Enable Per-Session Notifications

**As a user, I want to:** enable Telegram on a session so I can receive Claude's messages via Telegram while away from the browser.

**Journey:**
1. Telegram is already configured on the server (bot token set).
2. User opens "New Session" modal.
3. The Telegram section shows "Enable Telegram" button (enabled, not grayed out).
4. User clicks "Enable Telegram." The button label changes to "Telegram On" and highlights.
5. User clicks "Start Session."
6. The session card shows a "TG" badge.
7. Claude sends output in the terminal. The user receives a Telegram message.

**Journey (Telegram not configured):**
1. Telegram is not configured on the server.
2. User opens "New Session" modal.
3. The "Enable Telegram" button is grayed out and shows `opacity: 0.4`. Clicking it has no effect.
4. The help text reads: "Telegram not configured — run /telegram:configure first."

**Success criteria:**
- When Telegram is configured, the toggle is clickable and reflects on/off state visually.
- Sessions created with `telegram: true` show the "TG" badge on their session card.
- When Telegram is not configured, the toggle is disabled and the help text explains why.
- The modal checks Telegram status via `/api/telegram/status` on open (not cached from last open).
- The "TG" badge persists on the card after browser reload.

**Why this matters:** Telegram integration is useless if the enable toggle is hidden behind a broken state check. The UI must communicate clearly whether Telegram is available.

---

## Story 20: Error States — Invalid Project Path and Session Crash

**As a user, I want to:** receive clear error feedback when something goes wrong, so I know what to fix rather than staring at a broken state.

**Journey (invalid project path):**
1. User opens "New Project" modal.
2. User enters a path that doesn't exist on disk: "/nonexistent/path."
3. User clicks "Create Project."
4. An error toast appears: "Failed to create project" (or a more specific message from the server).
5. The modal remains open so the user can correct the path.

**Journey (session in error state):**
1. User starts a session with an invalid command (e.g., `claude-nonexistent`).
2. The PTY spawn fails. The session card badge shows "error" with a warning icon.
3. The terminal overlay (if open) shows the error output.
4. The session card offers "Delete" but not "Stop" (since it's not running).

**Journey (API key / auth failure):**
1. The API key configured in the environment is invalid.
2. User starts a session. Claude starts but immediately exits with an auth error.
3. The session transitions to "stopped" (or "error").
4. The terminal shows Claude's auth error message.
5. The user can delete the session and fix the API key.

**Success criteria:**
- Error states on session cards use the "error" badge with the warning color.
- Sessions in error state do not show a "Stop" button (process is not running).
- Toast messages appear for user-initiated actions that fail (create, delete, stop).
- The app never shows a blank white screen or unhandled JavaScript error on bad input.
- The connection status dot in the TopBar is the canary for global connectivity — it does not show "Connected" if the WebSocket is actually down.

**Why this matters:** Error states are what users see at the worst moments. Clear errors let users self-recover. Invisible errors make users blame the product.

---

## What These Stories Told Us Was Missing

Writing user stories at this level of specificity surfaces gaps that code review alone misses. Here is what became obvious:

1. **No project editing flow.** Story 1 creates a project; Story 2 selects one. But there is no story for renaming a project or changing its path. The sidebar has an edit button (`✎`) that is a stub. This is a real product gap — users who mistype a project name have no recourse.

2. **No "last selected project" persistence.** Stories 2 and 10 reveal that after browser reload, no project is pre-selected. Users with many projects must re-navigate every time. The spec calls for restoring last-selected project on reload.

3. **The TODO panel has no watchdog-triggered auto-refresh.** Story 18 requires clicking "Refresh" manually. But if the watchdog runs every 5 minutes and generates new TODOs, users must remember to refresh the panel. A push-based update (WS event → panel reloads) was never designed.

4. **Session cards don't show mode badge visibly enough.** Stories 4 and 13 reveal that distinguishing direct vs tmux sessions at a glance is important. The mode badge exists but there is no color differentiation — "direct" and "tmux" render identically except for label text.

5. **No "copy session ID" confirmation flow.** Story 3 mentions that `claudeSessionId` can be clicked to copy. But there is no visual indicator that the copy succeeded beyond a toast. The story reveals that the UX needs a momentary "Copied!" state on the element itself, not just a toast.

6. **Terminal resize is not explicitly covered.** None of the 20 stories test what happens when the browser window is resized while a terminal is open. The `ResizeObserver` is implemented in `TerminalPane`, but there is no story validating that the PTY receives the correct new dimensions.

7. **Keyboard shortcut to close the overlay is unspecified.** Story 6 uses the "×" button to close. But there is no story covering Escape key behavior in the overlay. `TerminalPane` passes keypresses to the PTY, which means Escape goes to Claude, not the overlay. This is intentional but never documented.

8. **Multi-viewer behavior (two browser tabs watching the same session) is unspecified.** If a user opens the same session in two tabs simultaneously, both receive PTY output. But what happens when one tab refreshes the session? There is no story defining the expected behavior and no guard against the conflict.

9. **The watchdog model affects cost significantly, but there is no cost preview.** Story 16 has a command preview for session settings. But there is no equivalent for watchdog — users can accidentally leave watchdog on Opus with extended thinking, running every 5 minutes on all sessions, burning through credits invisibly.

10. **Telegram per-session toggle state is not editable after session creation.** Story 19 covers enabling Telegram when creating a session. But there is no story for enabling or disabling Telegram on an already-running session. The session card shows the TG badge but offers no toggle to change it post-creation.

---

## Part 2: Ranked Test Suite (Top 50)

### Adversarial Brainstorm Summary

Before selecting tests, 130+ variations were generated across all 20 stories by asking for each: wrong order, double-submit, network drop mid-action, dirty prior state, boundary inputs, concurrent users/tabs, and post-server-restart behavior. Scoring uses: **L** = Likelihood (1–5, how often a real user hits this), **S** = Severity (1–5, how bad if it fails silently), **D** = Detectability (1–5, how hard to catch manually). Total = L + S + D (max 15). Tests scoring ≥ 10 were strong candidates.

---

## Tier 1 — Run on Every Commit (Top 15)

*Fast, critical path. Each catches a class of failure that makes the product unusable.*

---

### T-01: Double-click "Start Session" creates duplicate sessions
**Source story:** Story 3
**Score:** L=4 S=5 D=4 (Total: 13)
**Flow:** Open "New Claude Session" modal. Fill in session name "test-double." Click "Start Session" twice as fast as possible (within 200ms). Wait 5 seconds. Count the session cards in the project.
**Pass condition:** Exactly one session card with name "test-double" exists. No duplicate.
**Fail signal:** Two session cards appear with the same name, or one appears with a ghost "starting" spinner that never resolves. The server may have created two PTY processes.
**Test type:** Playwright browser

---

### T-02: Browser hard-reload reconnects and shows live session
**Source story:** Story 10
**Score:** L=5 S=5 D=3 (Total: 13)
**Flow:** Create a direct session. Confirm it reaches "running." Press Ctrl+Shift+R (hard reload, bypassing cache). Wait up to 10 seconds. Select the project in the sidebar. Open the session in the terminal overlay.
**Pass condition:** The session is still shown as "running." The terminal overlay opens and shows live output from the still-running Claude process. The TopBar status dot shows "Connected" within 5 seconds.
**Fail signal:** The session shows as "stopped" after reload, or the terminal is blank/frozen, or the status dot stays red.
**Test type:** Playwright browser

---

### T-03: Session refresh clears terminal buffer — no dot artifacts
**Source story:** Story 8
**Score:** L=4 S=4 D=5 (Total: 13)
**Flow:** Create a direct session. Wait for Claude to output at least 3 lines. Open the terminal overlay. Click "Refresh." Observe the terminal: take a screenshot at t=0, t=2s, t=4s. Inspect the pixel area outside active text for isolated single-pixel dots.
**Pass condition:** The terminal is visually clean after refresh. No stray dot characters or artifacts appear in the blank areas of the terminal. `xterm.reset()` was called (verify via DOM: terminal scrollback count resets to 0).
**Fail signal:** Isolated dots, garbled characters, or strikethrough artifacts visible in terminal after refresh — the regression from commit b2c1945.
**Test type:** Playwright browser (screenshot pixel inspection)

---

### T-04: Stop button actually kills the process
**Source story:** Story 7
**Score:** L=5 S=5 D=3 (Total: 13)
**Flow:** Create a direct session. Wait for "running." Note the session ID. Click "Stop." Wait 5 seconds. Call `GET /api/sessions` and inspect the session record. Also call `GET /api/sessions/:id/status` to confirm server-side state.
**Pass condition:** The session record's `status` field is `"stopped"`. The `pid` field (if present) refers to a process that no longer exists (`kill -0 <pid>` returns non-zero). The UI card shows "stopped" badge.
**Fail signal:** UI shows "stopped" but server-side process is still alive, or the session record is still "running." This is silent data corruption — the user thinks they stopped Claude but credits are still burning.
**Test type:** WS protocol + server-level (REST verification)

---

### T-05: Refresh direct session preserves conversation — uses --resume
**Source story:** Story 8
**Score:** L=4 S=5 D=4 (Total: 13)
**Flow:** Create a direct session. Use the sentinel protocol: send "reply only ACK_<N>" and verify ACK_1. Stop the session. Click "Refresh." Wait for "running." Send "NEXT." Observe whether ACK_2 appears (resume) or if Claude responds with no context (fresh start).
**Pass condition:** After refresh, Claude responds with ACK_2 (or equivalent), demonstrating it loaded the previous conversation. The `--resume` flag is present in the startup command (visible in terminal output or server log).
**Fail signal:** Claude responds without context — "I don't have any previous conversation." The conversation file was not found, not passed to `--resume`, or the session was restarted fresh.
**Test type:** Playwright browser (sentinel protocol)

---

### T-06: WebSocket auto-reconnect — terminal re-subscribes without user action
**Source story:** Story 12
**Score:** L=4 S=5 D=4 (Total: 13)
**Flow:** Open a running session in the terminal overlay. Simulate WS drop by closing the WS connection from the server side (call an internal endpoint or use `page.evaluate` to close the WebSocket). Wait 10 seconds. Observe whether the status dot recovers to green and whether new terminal output arrives automatically.
**Pass condition:** Status dot recovers to "Connected" within 10 seconds. Terminal begins receiving output again without the user clicking anything. No duplicate subscriptions are created.
**Fail signal:** Status dot stays red indefinitely, requiring a page reload. Or: terminal does not resume output after reconnect. Or: output appears in the wrong terminal (cross-session bleed after reconnect).
**Test type:** Playwright browser + WS protocol

---

### T-07: Session created with invalid command shows error badge — not spinner forever
**Source story:** Story 20
**Score:** L=3 S=5 D=5 (Total: 13)
**Flow:** Create a new session with command `claude-nonexistent-binary-xyz`. Start the session. Wait 10 seconds.
**Pass condition:** The session card badge shows "error" (not "starting" or "running"). The terminal overlay (if opened) shows the PTY spawn error. No infinite spinner is shown.
**Fail signal:** The session stays in "starting" state forever — the user has no signal that something went wrong. Or the app shows a blank white page / unhandled JS exception in console.
**Test type:** Playwright browser

---

### T-08: Creating project with non-existent path shows error — modal stays open
**Source story:** Story 20
**Score:** L=3 S=3 D=4 (Total: 10)
**Flow:** Open "New Project" modal. Enter name "Bad Path Project." Enter path "/absolutely/nonexistent/path/xyz123." Click "Create Project."
**Pass condition:** An error toast appears with a message explaining the failure. The modal remains open (not closed). The project does NOT appear in the sidebar. User can correct the path and try again.
**Fail signal:** The modal closes and a blank/broken project entry appears in the sidebar. Or: the modal closes with no feedback and no project is created — silent failure.
**Test type:** Playwright browser

---

### T-09: Settings persist across browser reload
**Source story:** Story 16
**Score:** L=5 S=4 D=3 (Total: 12)
**Flow:** Open Settings. Change default model to "Haiku." Toggle "Extended Thinking" on. Click Save. Hard-reload the browser. Open Settings again.
**Pass condition:** The default model is still "Haiku." Extended Thinking is still toggled on. The command preview shows the Haiku + extended thinking command.
**Fail signal:** Settings revert to defaults after reload. Or only some settings persist (e.g., model saves but thinking toggle resets). Indicates settings are written to in-memory state only.
**Test type:** Playwright browser

---

### T-10: Session count badge in sidebar matches live running sessions
**Source story:** Story 13
**Score:** L=5 S=3 D=4 (Total: 12)
**Flow:** Create 3 sessions in one project. Start 2 of them. Stop 1. Check the sidebar badge for the project.
**Pass condition:** The sidebar badge shows "1 session running" (matching exactly the single running session). When the second session is started, the badge updates to "2 sessions running" within 3 seconds — without a page reload.
**Fail signal:** Badge shows stale count (e.g., still shows 2 after stopping one). Or badge doesn't update in real time — only reflects the count from the initial page load.
**Test type:** Playwright browser

---

### T-11: New user first 5 minutes — create project and first session
**Source story:** Story 1, Story 3
**Score:** L=5 S=5 D=2 (Total: 12)
**Flow:** Start with a completely fresh server (no projects, no sessions). Open the app. Verify "No projects yet" empty state. Click "New Project," fill in a valid name and path. Verify project appears in sidebar. Click "New Claude Session," fill in a name, select Haiku. Click Start. Verify session card appears with "starting" badge.
**Pass condition:** Every step completes without a JS error in the browser console. Project appears in sidebar without reload. Session card appears immediately after clicking Start. The overlay opens automatically.
**Fail signal:** Any button click that produces no visible response (dead stub). Console error during project create or session create. Empty state message fails to appear on fresh start.
**Test type:** Playwright browser

---

### T-12: Tmux session survives browser tab close and re-open
**Source story:** Story 4
**Score:** L=4 S=5 D=3 (Total: 12)
**Flow:** Create a tmux session. Confirm "running." Note the tmux session name from the server (`cm-<id>`). Close the browser tab completely. Wait 5 seconds. Open a new tab to the app URL. Select the project. Observe the session card.
**Pass condition:** Session card shows "running." The tmux session `cm-<id>` still exists (verify with `tmux ls` on the server). Opening the terminal overlay shows existing Claude output — not a blank terminal.
**Fail signal:** Session card shows "stopped" after tab reopen. Or the terminal is blank (re-attached but content was lost). Or the tmux session no longer exists (it was killed when the WS connection closed).
**Test type:** Playwright browser + server-level (tmux verification)

---

### T-13: Submitting new project with empty name shows validation error
**Source story:** Story 1
**Score:** L=4 S=2 D=3 (Total: 9)
**Flow:** Open "New Project" modal. Leave the name field blank. Fill in a valid path. Click "Create Project."
**Pass condition:** An error toast appears: "Project name is required." The modal stays open. No project is created.
**Fail signal:** The modal closes without creating a project (silent failure). Or the API is called with an empty name and either accepts it or returns an error that isn't surfaced in the UI.
**Test type:** Playwright browser

---

### T-14: Delete confirmation dialog — cancel leaves session intact
**Source story:** Story 14
**Score:** L=4 S=4 D=3 (Total: 11)
**Flow:** Create and stop a session. Click "Delete" on the session card. When the browser confirmation dialog appears, click "Cancel." Observe the session list.
**Pass condition:** The session card remains in the list. No delete API call was made (verify via network requests). The session record is intact on the server.
**Fail signal:** The session is deleted even when cancel is clicked. Or the dialog doesn't appear at all (delete happens immediately without confirmation). Or: clicking cancel causes the card to show a broken state.
**Test type:** Playwright browser

---

### T-15: Scroll up while streaming — auto-scroll is frozen, input still works
**Source story:** Story 5
**Score:** L=5 S=4 D=4 (Total: 13)
**Flow:** Open a running session in the terminal overlay. Send a prompt that generates a long response (100+ lines). While Claude is responding, scroll up to line 1 using the mouse wheel. Wait 5 seconds without scrolling. Observe whether the terminal jumps back to the bottom. Then type "Hello" and press Enter.
**Pass condition:** The terminal does NOT auto-scroll while the user is scrolled up. Claude's response keeps arriving (visible by scrolling down), but the viewport stays at the user's scroll position. Typing "Hello" successfully sends input to the PTY (even while scrolled up).
**Fail signal:** Terminal snaps to the bottom mid-response, overriding the user's scroll position. Or: typing while scrolled up has no effect — input is blocked or lost.
**Test type:** Playwright browser

---

## Tier 2 — Run Pre-Release (Next 20)

*Edge cases, multi-step flows, and state interactions that catch subtler bugs.*

---

### T-16: Refresh while session is in "starting" state is blocked
**Source story:** Story 8
**Score:** L=3 S=4 D=4 (Total: 11)
**Flow:** Click "Start Session." Immediately (within 1 second) click "Refresh" on the session card. The session should still be in "starting" state.
**Pass condition:** Refresh during "starting" is blocked. Either: the Refresh button is not present during "starting" state, or clicking it shows a clear error ("Cannot refresh a session that is still starting"). The session continues its normal startup sequence uninterrupted.
**Fail signal:** The Refresh action fires while the session is still starting, killing the startup PTY and leaving the session in an unrecoverable state. The badge may oscillate between "starting" and "stopping" and never reach "running."
**Test type:** Playwright browser

---

### T-17: Server restart — direct session is stopped, tmux session is running
**Source story:** Story 11
**Score:** L=3 S=5 D=4 (Total: 12)
**Flow:** Create one direct session (confirm "running") and one tmux session (confirm "running"). Stop the Node.js server with SIGKILL. Restart the server. Reload the browser. Select the project.
**Pass condition:** The direct session card shows "stopped" (PTY was killed with the server). The tmux session card shows "running" (tmux process survived). The tmux session's `claudeSessionId` is intact. Clicking "Refresh" on the direct session uses `--resume`.
**Fail signal:** Both sessions show "stopped" (tmux detection is broken). Or: both sessions show "running" (direct session falsely marked running). Or: session records are lost from disk (sessions.json was not flushed before SIGKILL).
**Test type:** Server-level + Playwright browser

---

### T-18: Switching projects while a session is starting
**Source story:** Story 2, Story 3
**Score:** L=3 S=3 D=4 (Total: 10)
**Flow:** Select Project A. Click "Start Session." Immediately click Project B in the sidebar before the session card finishes rendering in Project A. Wait 3 seconds. Click Project A again.
**Pass condition:** Project A shows the session card (now "running" or "starting"). Project B shows its own sessions unchanged. No cross-project bleed — the session created in A does not appear in B.
**Fail signal:** The session disappears from Project A (lost during the navigation race). Or the session appears in Project B. Or the sidebar highlights both projects simultaneously.
**Test type:** Playwright browser

---

### T-19: Session card `lastLine` updates while overlay is open
**Source story:** Story 13
**Score:** L=4 S=2 D=4 (Total: 10)
**Flow:** Open session A in the terminal overlay. Switch to split view so the session card is visible alongside the terminal. Send a prompt to Claude. Watch the `lastLine` text on the card.
**Pass condition:** The `lastLine` field on the session card updates to show Claude's most recent output line within 3 seconds of it appearing in the terminal. ANSI escape codes are stripped — no raw `\x1b[32m` visible in the card text.
**Fail signal:** `lastLine` doesn't update while the overlay is open. Or `lastLine` shows raw ANSI sequences. Or `lastLine` shows the entire output buffer truncated mid-escape-sequence.
**Test type:** Playwright browser

---

### T-20: Two browser tabs watching same session — one refreshes, other updates
**Source story:** Story 9 (gap #8 from "What Was Missing")
**Score:** L=2 S=4 D=5 (Total: 11)
**Flow:** Open the app in two browser tabs, both watching the same running session's terminal overlay. In Tab 1, click Refresh on the session. Observe Tab 2.
**Pass condition:** Tab 2's terminal either: (a) auto-reconnects to the refreshed session and shows new output, or (b) shows a clear "session was restarted" state. The session card in Tab 2 updates its badge from "running" → "starting" → "running." No terminal output from the old PTY bleeds into Tab 2 after the refresh.
**Fail signal:** Tab 2 shows the old PTY's output mixed with the new PTY's output (cross-PTY bleed). Or Tab 2 freezes permanently after the session is refreshed.
**Test type:** Playwright browser (two-tab)

---

### T-21: Low Credit Mode — new sessions use lcModel command
**Source story:** Story 17
**Score:** L=3 S=4 D=4 (Total: 11)
**Flow:** Open Settings. Enable Low Credit Mode. Set lcModel to "Haiku." Toggle "Activate Now" on. Save. Open "New Session" modal.
**Pass condition:** The command field in the New Session modal pre-fills with the Haiku command. A "LOW CREDIT MODE ACTIVE" warning badge is visible in the modal in a distinct orange/warning color.
**Fail signal:** The command field still shows the standard model command (lcModel setting was not applied). Or the warning badge is absent. Or Low Credit settings were not saved (revert to empty after reopening modal).
**Test type:** Playwright browser

---

### T-22: Delete session while overlay is open — overlay handles gracefully
**Source story:** Story 14
**Score:** L=2 S=4 D=5 (Total: 11)
**Flow:** Open a stopped session in the terminal overlay. Without closing the overlay, go to the session card (in split view or by navigating back) and click Delete. Confirm the delete.
**Pass condition:** The overlay closes gracefully or shows a "session deleted" state. No JS errors in the console. The session card is removed from the list. The overlay does not continue trying to subscribe to the deleted session.
**Fail signal:** Overlay stays open showing stale content while the session no longer exists. The client repeatedly sends `session:subscribe` messages for the deleted session ID, causing server errors. Or an unhandled JS exception crashes the app.
**Test type:** Playwright browser

---

### T-23: Telegram toggle — unconfigured state is disabled and explains why
**Source story:** Story 19
**Score:** L=3 S=2 D=3 (Total: 8)
**Flow:** Ensure Telegram is NOT configured on the server (bot token not set). Open "New Session" modal. Observe the Telegram section.
**Pass condition:** The "Enable Telegram" button is visually disabled (opacity ~0.4 or `disabled` attribute). The help text reads something like "Telegram not configured." Clicking the button has no effect. No JS error is thrown.
**Fail signal:** The button appears enabled even though Telegram is unconfigured. Clicking it silently enables a flag that will cause session creation to fail when it tries to connect to a non-existent bot.
**Test type:** Playwright browser

---

### T-24: Watchdog panel shows empty state cleanly when endpoint returns 500
**Source story:** Story 15
**Score:** L=2 S=3 D=5 (Total: 10)
**Flow:** Make the `/api/watchdog/logs` endpoint return HTTP 500 (by temporarily breaking the route or using a mock). Navigate to the watchdog panel.
**Pass condition:** The panel shows a graceful empty/error state ("No logs available" or similar). No JS console error occurs. No white screen or unhandled exception. The rest of the app remains functional.
**Fail signal:** The app crashes with an unhandled promise rejection when the watchdog endpoint fails. Or the panel renders into a broken state that requires a page reload to fix.
**Test type:** Server-level + Playwright browser

---

### T-25: Paste large input into terminal — no hang or truncation
**Source story:** Story 5
**Score:** L=3 S=3 D=4 (Total: 10)
**Flow:** Open a running session in the terminal overlay. Paste 5,000 characters of text into the terminal input. Observe: does the terminal accept the full input? Does the PTY receive it? Does the UI hang?
**Pass condition:** The full 5,000 characters are sent to the PTY within 5 seconds. The terminal UI remains responsive (no frozen state). Claude begins processing the input.
**Fail signal:** The terminal hangs after the paste. Or only the first N characters are sent (truncation at some buffer limit). Or the browser tab becomes unresponsive.
**Test type:** Playwright browser

---

### T-26: Split view — terminal fully functional after toggle
**Source story:** Story 6
**Score:** L=4 S=3 D=3 (Total: 10)
**Flow:** Open session in full-screen overlay. Click "Split." Wait for layout to settle. Type a message in the terminal. Verify the input reaches Claude. Click "Full." Type another message. Verify input still works.
**Pass condition:** In split mode, the terminal fits its new dimensions correctly (no horizontal overflow, no wasted whitespace). Input and output work in both modes. The PTY receives a resize signal when toggling (cols/rows update). Terminal text is legible in both modes.
**Fail signal:** After switching to split mode, the terminal text overflows into the left panel or is misaligned. Typing produces no output (input stopped working after resize). Or `xterm.fit()` was not called on toggle, leaving the terminal at wrong dimensions.
**Test type:** Playwright browser

---

### T-27: Browser resize while terminal is open — PTY gets new dimensions
**Source story:** Story 5 (gap #6 from "What Was Missing")
**Score:** L=4 S=3 D=5 (Total: 12)
**Flow:** Open a running session in the terminal overlay. Resize the browser window from 1280×800 to 800×600. Wait 2 seconds. Check what the PTY thinks the terminal dimensions are (send a long string that should line-wrap at the new terminal width).
**Pass condition:** The PTY dimensions update to match the new terminal size. Text wraps at the new column count. `ResizeObserver` fired and sent a resize message to the server. No terminal display corruption.
**Fail signal:** The PTY is still using the old column count (text wraps incorrectly or doesn't wrap). The terminal overlay shows horizontal scrollbar where none should be needed. Resizing back to original still shows wrong layout.
**Test type:** Playwright browser

---

### T-28: Delete running session — Delete button is absent (only Stop shown)
**Source story:** Story 14
**Score:** L=4 S=3 D=2 (Total: 9)
**Flow:** Create a session and confirm it reaches "running." Inspect the session card's action buttons.
**Pass condition:** The session card shows a "Stop" button. No "Delete" button is present. This is verified by checking the DOM for any element matching the delete button selector.
**Fail signal:** A "Delete" button appears on a running session card. Clicking it would bypass the Stop→Delete flow and potentially leave a zombie process running while the record is removed.
**Test type:** Playwright browser

---

### T-29: Telegram session shows TG badge after browser reload
**Source story:** Story 19
**Score:** L=3 S=2 D=3 (Total: 8)
**Flow:** Create a session with Telegram enabled. Confirm the "TG" badge appears on the session card. Hard-reload the browser. Navigate back to the project.
**Pass condition:** The "TG" badge is still visible on the session card after reload. The badge is rendered from persisted session data, not ephemeral in-memory state.
**Fail signal:** The "TG" badge disappears after reload, even though Telegram is still active for that session. Users have no way to know which sessions have Telegram enabled.
**Test type:** Playwright browser

---

### T-30: Tmux session refresh — Claude PID is unchanged (process not killed)
**Source story:** Story 9
**Score:** L=3 S=5 D=5 (Total: 13)
**Flow:** Create a tmux session. Wait for "running." Record the Claude process PID inside the tmux pane (e.g., `tmux send-keys -t cm-<id> "echo \$\$" Enter`). Click "Refresh" in the overlay. Wait for re-attach. Check the PID again.
**Pass condition:** The Claude process PID inside the tmux session is identical before and after the refresh. The tmux session name `cm-<id>` is unchanged. The terminal shows the existing conversation output on re-attach.
**Fail signal:** The PID changed — the refresh killed and restarted the Claude process inside tmux. This destroys a running Claude job the user expected to continue.
**Test type:** Server-level + Playwright browser

---

### T-31: Settings Cancel discards changes
**Source story:** Story 16
**Score:** L=4 S=3 D=3 (Total: 10)
**Flow:** Open Settings. Change default model to "Opus+thinking." Click "Cancel." Reopen Settings.
**Pass condition:** The default model has not changed — it shows the value from before editing. No save API call was made (check network requests).
**Fail signal:** The change is persisted even after Cancel. This would mean the Cancel button is wired to a save action, or state mutation happens on field change rather than on save.
**Test type:** Playwright browser

---

### T-32: Session list empty state message appears correctly
**Source story:** Story 2
**Score:** L=5 S=2 D=3 (Total: 10)
**Flow:** Create a new project. Select it. Observe the main content pane.
**Pass condition:** The main content pane shows "No sessions — start one with the button above" (or equivalent). No error state, no spinner, no blank white area.
**Fail signal:** The empty state is blank (no message), or an error is shown ("Failed to load sessions"), or the loading spinner stays up indefinitely.
**Test type:** Playwright browser

---

### T-33: TODO — add item with empty title is blocked
**Source story:** Story 18
**Score:** L=3 S=2 D=3 (Total: 8)
**Flow:** Navigate to the TODO panel. Click "+ Add." Leave the title field empty. Click "Add."
**Pass condition:** The form is not submitted. An inline validation error appears near the title field. No empty-titled TODO card is added to the list.
**Fail signal:** An empty-titled TODO card is created and added to the list. Or the API is called with an empty title and accepts it, creating a record with no text.
**Test type:** Playwright browser

---

### T-34: TODO filters work — high priority filter hides medium items
**Source story:** Story 18
**Score:** L=3 S=2 D=3 (Total: 8)
**Flow:** Create 3 TODOs: one High, one Medium, one Low priority. Click the "High" filter button. Observe the list.
**Pass condition:** Only the High priority TODO is visible. Medium and Low TODOs are hidden (not rendered in the DOM, or have `display: none`). Clicking "All" shows all 3 again.
**Fail signal:** The filter button click changes state visually but all items remain visible. Or the filter state resets when switching to the TODO panel and back.
**Test type:** Playwright browser

---

### T-35: Concurrent session creates — 5 sessions start without cross-bleed
**Source story:** Story 13
**Score:** L=2 S=5 D=5 (Total: 12)
**Flow:** Using the API directly (bypass UI), send 5 simultaneous POST requests to `/api/sessions` on the same project. Wait 10 seconds. Fetch the session list.
**Pass condition:** Exactly 5 session records are created, each with a unique ID. No session record is partially written or missing fields. All 5 sessions eventually reach "running" or "error" state (not stuck in "starting").
**Fail signal:** Fewer than 5 sessions created (race condition drops some). Or two sessions share a UUID (ID generation is not safe for concurrent calls). Or one session's state is written over another's (file system race in sessions.json).
**Test type:** Server-level (REST)

---

---

## Tier 3 — Run Before Major Deploy (Final 15)

*Stress, concurrency, recovery, and obscure flows that only appear under load or edge conditions.*

---

### T-36: Server restart while session is in "starting" state
**Source story:** Story 11
**Score:** L=2 S=5 D=5 (Total: 12)
**Flow:** Trigger a session start. Immediately (within 500ms) kill and restart the server. Reload the browser.
**Pass condition:** The session does not appear stuck in "starting" after server restart. It either shows "stopped" (spawn was interrupted) or "running" (if the spawn completed before kill). The server does not crash on startup while processing an inconsistent session record.
**Fail signal:** The session remains in "starting" state permanently after server restart with no way to recover it. Or the server crashes on restart because it tries to resume a session that has no PTY and no tmux session.
**Test type:** Server-level

---

### T-37: WS drop during streaming — buffer replays correctly on reconnect
**Source story:** Story 12
**Score:** L=3 S=4 D=5 (Total: 12)
**Flow:** Open a session in the terminal overlay. Trigger a large streamed response (100+ lines). Mid-stream, kill the WebSocket connection. Wait for it to reconnect. Inspect the terminal buffer.
**Pass condition:** After reconnect, the terminal contains a coherent buffer — no duplicate lines, no missing lines (or missing lines are acceptable if clearly from before the reconnect). No ANSI escape sequence fragments that corrupt later output.
**Fail signal:** After reconnect, terminal shows the same lines twice (double-replay of the scrollback). Or a partial ANSI sequence before the disconnect corrupts all rendering after reconnect (escape sequence bleeds into next chunk).
**Test type:** Playwright browser + WS protocol

---

### T-38: 10-project sidebar — layout and navigation work at scale
**Source story:** Story 2
**Score:** L=2 S=3 D=3 (Total: 8)
**Flow:** Create 10 projects with long names (50 chars each). Observe the sidebar. Click each project in turn. Verify the correct session list appears for each.
**Pass condition:** The sidebar scrolls correctly with 10 projects. No project names overflow the sidebar width in a way that breaks the layout. Clicking each project shows the correct (independent) session list. Sidebar highlighting moves to the clicked project.
**Fail signal:** The 10th project is unreachable (sidebar doesn't scroll). Or clicking project 8 shows project 3's sessions (stale state from closure). Or long project names break the sidebar layout.
**Test type:** Playwright browser

---

### T-39: Corrupted sessions.json — server recovers without crash
**Source story:** Story 11
**Score:** L=2 S=5 D=4 (Total: 11)
**Flow:** Write invalid JSON to `sessions.json` on disk. Restart the server. Reload the browser.
**Pass condition:** The server starts without crashing. The app loads in a clean state (empty session list — data was unrecoverable, so it was discarded). A server-side error is logged indicating the corruption was detected and handled.
**Fail signal:** The server crashes on startup with an uncaught exception. Or the server silently serves corrupted data, causing the UI to render in a broken state. Or the server silently discards the corruption without logging (no way to diagnose the data loss).
**Test type:** Server-level

---

### T-40: Session name with special characters — no injection or display break
**Source story:** Story 3
**Score:** L=2 S=4 D=4 (Total: 10)
**Flow:** Create a session with name `<img src=x onerror=alert(1)>`. Create another with name `../../etc/passwd`. Create another with a 256-character name.
**Pass condition:** All three sessions are created. Names are displayed as plain text (HTML-escaped, no script execution). The 256-char name is either truncated gracefully in the UI or accepted in full. No path traversal occurs.
**Fail signal:** The `<img>` tag is rendered as raw HTML and the script fires. Or the `../../` name causes a server error revealing path information. Or the 256-char name crashes the server's session record parser.
**Test type:** Playwright browser + server-level

---

### T-41: Reload browser during active file operation (upload in progress)
**Source story:** Story 10
**Score:** L=2 S=3 D=4 (Total: 9)
**Flow:** If the app has a file upload feature, initiate a file upload to a session. Mid-upload, hard-reload the browser. Reload again. Observe server state.
**Pass condition:** The server does not have a partially-written file in an inconsistent state. The session record is intact. The app loads cleanly after the reload.
**Fail signal:** The server is left with a partial file that causes subsequent requests to fail. Or the server crashes because the upload stream was terminated abruptly mid-write.
**Test type:** Playwright browser + server-level

---

### T-42: Multi-project badge counts are fully independent
**Source story:** Story 2
**Score:** L=4 S=3 D=4 (Total: 11)
**Flow:** Create Project A with 3 running sessions. Create Project B with 0 sessions. Stop one session in Project A. Check both badges in the sidebar.
**Pass condition:** Project A's badge shows "2 sessions running." Project B's badge shows "0 sessions running" or is absent. These values are independent — stopping a session in A does not affect B's badge.
**Fail signal:** Project B's badge shows a non-zero count (cross-project contamination). Or Project A's badge fails to decrement after a stop. Indicates the running count is computed from global session state, not per-project.
**Test type:** Playwright browser

---

### T-43: Haiku endurance — 20 messages, 5x refresh, 3x reload, full lifecycle
**Source story:** Story 3, Story 8, Story 10
**Score:** L=2 S=5 D=4 (Total: 11)
**Flow:** Create a direct session using haiku model with sentinel protocol. Send 20 messages (ACK_1 through ACK_20). After message 7, click Refresh (verify ACK_8 arrives). After message 12, hard-reload browser (verify ACK_13 arrives). After message 16, close and reopen the overlay (verify ACK_17 arrives). After message 20, stop, delete, verify clean state.
**Pass condition:** All 20 ACK responses arrive in correct order. Refresh always uses `--resume`. Browser reload re-attaches and continues the conversation. The session card `lastLine` shows the most recent ACK at all times. Final cleanup removes the session record and conversation file.
**Fail signal:** Any ACK out of order or missing. A non-ACK response (conversation context lost). A broken state after any of the 3 interruption types. Terminal artifacts during or after refresh. Session record not removed after delete.
**Test type:** Playwright browser (full lifecycle, sentinel protocol)

---

### T-44: Watchdog status badge reflects actual enabled/disabled state
**Source story:** Story 15
**Score:** L=3 S=4 D=4 (Total: 11)
**Flow:** With watchdog disabled in settings, navigate to the watchdog panel. Record the badge state. Enable watchdog in settings. Navigate away and back to the panel. Record the badge state again.
**Pass condition:** Disabled state shows "DISABLED" badge in muted color. After enabling, the badge shows "ENABLED" in green. The change is reflected without a page reload (or clearly requires a reload — not just silently wrong).
**Fail signal:** Badge always shows "ENABLED" regardless of the actual setting. Or badge shows "ENABLED" when watchdog is configured but its process is not actually running. This is a monitoring failure — the user thinks the watchdog is working when it's not.
**Test type:** Playwright browser

---

### T-45: Stop then immediately Refresh — no race condition
**Source story:** Story 7, Story 8
**Score:** L=3 S=4 D=5 (Total: 12)
**Flow:** Start a session. Click Stop. Within 200ms of clicking Stop (before the "stopped" badge appears), click Refresh.
**Pass condition:** Either: (a) The Refresh is ignored/blocked until Stop completes, then Refresh proceeds normally. Or (b) The Refresh waits for the Stop to settle and then restarts the session. In both cases the session ends in a stable "running" or "stopped" state, not an ambiguous in-between.
**Fail signal:** The session gets into an unrecoverable state — badge oscillates between "stopping" and "starting" indefinitely. Or the server tries to spawn a new PTY while the old one is still being killed, creating two running PTYs for one session.
**Test type:** Playwright browser + server-level

---

### T-46: WS reconnect restores terminal subscription for the active session
**Source story:** Story 12
**Score:** L=3 S=5 D=5 (Total: 13)
**Flow:** Open Session A in the terminal overlay. Drop the WS connection. While disconnected, Claude generates output in the PTY (simulate by writing directly to the PTY or waiting for Claude's ongoing response). Reconnect. Observe whether new output arrives.
**Pass condition:** After WS reconnect, the client automatically re-sends `session:subscribe` for Session A. New PTY output is routed to the terminal. Scrollback from during the disconnect is accessible (replayed or accessible via scroll).
**Fail signal:** After reconnect, the terminal is subscribed to no session. New output from Claude's ongoing response does not appear. The user must manually close and reopen the overlay to see output — the "always on" monitoring use case is broken.
**Test type:** WS protocol + Playwright browser

---

### T-47: Session cards render without layout break for 10+ cards
**Source story:** Story 13
**Score:** L=2 S=2 D=3 (Total: 7)
**Flow:** Create 10 sessions in one project (can be via API for speed). Navigate to the project. Take a screenshot.
**Pass condition:** All 10 session cards are visible (list scrolls). No card overflows its container. Card action buttons are accessible and not clipped. The layout does not collapse or break.
**Fail signal:** Cards overlap each other. Buttons are hidden behind other elements. The last N cards are invisible because the list container has no scrolling. Indicates a CSS height/overflow bug that only manifests at scale.
**Test type:** Playwright browser

---

### T-48: Settings Escape key discards changes
**Source story:** Story 16
**Score:** L=3 S=2 D=3 (Total: 8)
**Flow:** Open Settings. Change default model. Press Escape.
**Pass condition:** The modal closes. The setting is NOT saved. Reopening Settings shows the original value.
**Fail signal:** Escape closes the modal and saves the changes. Or Escape does not close the modal (the keypress goes to the page instead). Indicates Escape is being intercepted by the terminal pane logic even when the settings modal is active.
**Test type:** Playwright browser

---

### T-49: Auth failure mid-session — graceful degradation
**Source story:** Story 20
**Score:** L=2 S=5 D=5 (Total: 12)
**Flow:** Start a session. After Claude's first response, revoke or invalidate the API key server-side (or start a session with a deliberately invalid key). Wait for Claude to exit. Observe the session card state.
**Pass condition:** The session card transitions to "stopped" or "error" state. The terminal shows Claude's error output (not a blank screen). The session card offers Delete but not Stop. No unhandled JS exception occurs. The user can read the error and take action.
**Fail signal:** The session card stays "running" indefinitely even though Claude has exited. Or the terminal shows raw PTY exit bytes without any user-readable error. Or the app crashes (unhandled EventEmitter 'error' from the dead PTY stream).
**Test type:** Playwright browser + server-level

---

### T-50: Concurrent refresh on two tabs — no orphaned PTY processes
**Source story:** Story 9 (gap #8 from "What Was Missing")
**Score:** L=1 S=5 D=5 (Total: 11)
**Flow:** Open the same direct session in two browser tabs simultaneously. In Tab 1, click Refresh. Within 100ms, click Refresh in Tab 2 as well (two concurrent refresh requests for the same session).
**Pass condition:** Exactly one new PTY process is spawned for the session. The server handles the concurrent refresh requests idempotently — the second refresh either waits for the first or is rejected cleanly. No orphaned PTY process is left running without a session record pointing to it.
**Fail signal:** Two PTY processes are spawned for one session. Both start writing to the same session's WebSocket channel, causing garbled terminal output. Or one of the PTY processes runs indefinitely without any client attached (zombie PTY burning compute).
**Test type:** Server-level + WS protocol
