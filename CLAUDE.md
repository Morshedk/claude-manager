# claude-web-app-v2

## Git workflow

This repo uses **git worktrees**. Never use `git checkout` to switch branches — use the appropriate worktree directory instead. A hook will block `git checkout <branch>` and show the correct path.

| Branch | Directory |
|--------|-----------|
| `main` | `/home/claude-runner/apps/claude-web-app-v2` |
| `beta` | `/home/claude-runner/apps/claude-web-app-v2-beta` |

**To merge a fix into beta:**
```bash
cd /home/claude-runner/apps/claude-web-app-v2-beta
git merge <branch-name>
pm2 restart claude-v2-beta
```

**To create a QA branch:** branch off `main` (or `beta` if the fix targets beta-only code), do the work, merge into `beta` to deploy.

## Local Skills

Custom skills live at `~/.claude/skills/` and are NOT auto-surfaced by any plugin. Always invoke them by name via the `Skill` tool when the task matches.

| Skill | When to use |
|-------|-------------|
| `qa` | Any bug report — full Bug Report Pipeline (spec → test → confirm failure → fix → verify) |
| `dev` | New feature — multi-agent design → implement → test pipeline |
| `test` | Ad-hoc adversarial/UX testing of a specific change |
| `evaluate-app` | Holistic app quality evaluation |

**For bugs: always invoke `qa` before doing anything else.**

## Servers

Managed by PM2. Never start with `node` directly.

**Both servers run from the same directory** (`/home/claude-runner/apps/claude-web-app-v2`). They share the same code — only port and data directory differ. See `docs/decisions/2026-04-25-both-servers-share-cwd.md` for full context.

| Name | Port | Data dir |
|------|------|----------|
| `claude-v2-prod` | 3001 | `data/` |
| `claude-v2-beta` | 3002 | `data-beta/` |

**To deploy code changes:** merge your feature branch into `main`, then restart.

```bash
git merge feat/<name>            # merge into main
pm2 restart claude-v2-beta       # pick up changes on beta
pm2 restart claude-v2-prod       # pick up changes on prod
pm2 logs claude-v2-beta --lines 20 --nostream
```

**Before any restart:** run `pm2 info <name>` to verify CWD and port. A hook will print this info automatically.

## Decision Log

Significant decisions are recorded in `docs/decisions/`. Check these before making assumptions about the codebase — they capture the "why" behind non-obvious choices.

## Logging conventions

- **New lib modules:** import `log` from `../logger/Logger.js`, no bare `console.*`
- **New user-facing feature:** add at least one `log.info()` health signal at the feature boundary (start/complete/fail); if it's a new domain, add it to `lib/logger/health.js` SUBSYSTEMS
- **New error path:** use `log.error()` or `log.warn()` with relevant context IDs (`sessionId`, `clientId`) in the data field
- **Never swallow silently:** every `catch {}` block gets at minimum `log.debug(tag, 'suppressed error', { error: err.message })`
