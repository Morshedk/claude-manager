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

## Servers

Managed by PM2. Never start with `node` directly.

| Name | Port | Branch |
|------|------|--------|
| `claude-v2-prod` | 3001 | `main` |
| `claude-v2-beta` | 3002 | `beta` |

```bash
pm2 restart claude-v2-beta   # deploy to beta
pm2 restart claude-v2-prod   # deploy to prod
pm2 logs claude-v2-beta --lines 20 --nostream
```
