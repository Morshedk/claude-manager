#!/bin/bash
# PreToolUse hook on Edit/Write: blocks source file edits unless a QA branch is active.
# Forces the qa skill pipeline to be started before any bug fix attempt.
# Does NOT block feature branches (feat/*) — only blocks main without QA context.

MAIN_DIR="/home/claude-runner/apps/claude-web-app-v2"

input=$(cat)
file=$(echo "$input" | jq -r '.tool_input.file_path // ""')

# Only care about files inside the main worktree
if [[ "$file" != "$MAIN_DIR/"* ]]; then
  exit 0
fi

# Only check when on main branch
branch=$(git -C "$MAIN_DIR" branch --show-current 2>/dev/null)
if [[ "$branch" != "main" ]]; then
  exit 0
fi

rel="${file#$MAIN_DIR/}"

# Only block source directories (same as block-main-source-edits)
if ! echo "$rel" | grep -qE '^(public/js/|lib/|server\.js|routes/)'; then
  exit 0
fi

# Check if qa-pipeline/branch.txt exists (QA pipeline was started)
if [[ -f "$MAIN_DIR/qa-pipeline/branch.txt" ]]; then
  exit 0
fi

# Check if we're in a feature worktree (not main dir)
# This hook only applies to the main directory — worktrees are fine
exit 0
