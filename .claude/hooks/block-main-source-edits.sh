#!/bin/bash
# Blocks editing source files directly on main — use a feature worktree instead.
# Allows: tests/, .claude/, docs/, data/, package.json, CLAUDE.md, *.md, *.json config
# Blocks: public/js/, lib/, server.js, routes/

MAIN_DIR="/home/claude-runner/apps/claude-web-app-v2"

input=$(cat)
file=$(echo "$input" | jq -r '.tool_input.file_path // ""')

# Only care about files inside the main worktree
if [[ "$file" != "$MAIN_DIR/"* ]]; then
  exit 0
fi

# Only block when on main branch
branch=$(git -C "$MAIN_DIR" branch --show-current 2>/dev/null)
if [[ "$branch" != "main" ]]; then
  exit 0
fi

rel="${file#$MAIN_DIR/}"

# Block source directories only
if echo "$rel" | grep -qE '^(public/js/|lib/|server\.js|routes/)'; then
  echo "BLOCKED: editing source files directly on main bypasses beta testing." >&2
  echo "" >&2
  echo "Create a feature worktree first:" >&2
  echo "  git worktree add ../claude-web-app-v2-<name> -b feat/<name>" >&2
  echo "  # work in /home/claude-runner/apps/claude-web-app-v2-<name>" >&2
  echo "  # merge into main, then pm2 restart to deploy" >&2
  exit 2
fi

exit 0
