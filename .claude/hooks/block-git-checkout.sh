#!/bin/bash
# Blocks git checkout branch-switching — use worktrees instead.
# Allows: git checkout <file>, git checkout -- <file> (file restores)
# Blocks: git checkout <branch>, git checkout -b <branch>

input=$(cat)
cmd=$(echo "$input" | jq -r '.tool_input.command // ""')

if echo "$cmd" | grep -qE '^\s*git\s+checkout\s+'; then
  # Allow file restores: git checkout -- file or git checkout file.ext
  if echo "$cmd" | grep -qE 'git\s+checkout\s+--?\s+\S'; then
    exit 0
  fi
  # Allow git checkout within quoted subcommands (e.g. git worktree add)
  if echo "$cmd" | grep -qE 'worktree'; then
    exit 0
  fi

  echo "BLOCKED: use worktrees instead of git checkout to switch branches." >&2
  echo "" >&2
  echo "  main → /home/claude-runner/apps/claude-web-app-v2" >&2
  echo "  beta → /home/claude-runner/apps/claude-web-app-v2-beta" >&2
  echo "" >&2
  echo "  To merge: cd into the target worktree and run git merge <branch>" >&2
  exit 2
fi

exit 0
