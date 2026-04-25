# ADR: Both prod and beta servers share the same CWD

**Date:** 2026-04-25
**Status:** Accepted

## Context

The PM2 processes `claude-v2-prod` (port 3001) and `claude-v2-beta` (port 3002) both have their `exec cwd` set to `/home/claude-runner/apps/claude-web-app-v2`. They run the same script (`server-with-crash-log.mjs`) and serve the same static files from `/public/`.

The only difference between them is:
- Port: 3001 vs 3002
- DATA_DIR: `data/` vs `data-beta/`

The `claude-web-app-v2-beta` git worktree at `/home/claude-runner/apps/claude-web-app-v2-beta` is a **git staging area** — it exists so feature branches can be merged there for review on the `beta` git branch, but the PM2 beta server does NOT read files from it.

## Decision

Code changes must land in the `main` branch (in `/home/claude-runner/apps/claude-web-app-v2`) to take effect on either server. The workflow is:

1. Create feature branch/worktree
2. Make changes, commit
3. Merge feature branch into `main`
4. `pm2 restart claude-v2-beta` (and/or `claude-v2-prod`)

Merging to the beta worktree alone does NOT deploy anything.

## Consequences

- CLAUDE.md's "merge into beta to deploy" instruction is misleading and should be corrected
- Both servers share code — a restart of either picks up whatever is on `main`
- The beta worktree is useful for git branch management but not for server isolation
- A `verify-pm2-restart.sh` hook was added to print CWD/port info before any restart, preventing wrong-target deploys

## How this was discovered

On 2026-04-23, a feature branch was merged to the beta worktree and `claude-v2-beta` restarted three times. The changes never appeared. After running `pm2 info claude-v2-beta`, the `exec cwd` revealed both servers share the same directory. Merging to `main` and restarting fixed the issue immediately.
