# Session Journal — 2026-04-25 — Behavior Enforcement Hooks

## What was worked on

User reported recurring problems with Claude sessions:
1. Deploying to wrong target (beta worktree instead of main)
2. Restarting wrong server without verifying CWD
3. Ignoring failing tests
4. Claiming to find bugs without running tests to confirm
5. Decisions and reasoning getting lost between sessions

## Key decisions and reasoning

**ADR: Both servers share CWD** — Discovered that `pm2 info claude-v2-beta` shows `exec cwd: /home/claude-runner/apps/claude-web-app-v2` (same as prod). The beta worktree is a git staging area, not a server root. Previously this was unknown and caused three failed deploys in one session. Recorded as `docs/decisions/2026-04-25-both-servers-share-cwd.md`.

**Hooks over skills/memory** — Research showed that PreToolUse hooks block mechanically (exit code 2 = denied), while skills and memory are advisory and get rationalized past. The existing `block-main-source-edits` hook works perfectly as evidence. New hooks target the specific failure modes.

**Default model changed to opus** — Both `data/settings.json` and `data-beta/settings.json` updated to `defaultModel: "opus"` (claude-opus-4-6).

**HTML/MD preview in file manager** — Added Source/Preview toggle to `FileContentView.js`. HTML renders in sandboxed iframe, MD toggles between raw code and rendered output. Feature branch `feat/html-preview` merged to main.

## What was discovered

- CLAUDE.md had misleading deploy instructions ("merge into beta to deploy") that don't match reality
- The `require-qa-for-source-edits` hook concept needs refinement — currently exits 0 always because the `block-main-source-edits` hook already blocks main edits, and feature worktrees don't have the qa-pipeline dir. May need rethinking.
- Stop hooks can serve as session-end reminders for journal entries

## What's still open

- Events bottom tab plan (`docs/superpowers/plans/2026-04-23-events-bottom-tab.md`) — designed but not implemented
- The `require-qa-for-source-edits` hook needs to be validated — currently it exits 0 in all paths and doesn't actually block anything
- Stop hook for test verification (agent-type) not built yet — the current Stop hook only checks for journal entries
- Need to monitor hook effectiveness over next 5 sessions
- The backlog session on beta was restarted with `claude --resume` but left running — should be checked
