#!/usr/bin/env bash
# Fires after a git push. Reminds Claude to update CHANGELOG.md if
# the push touched source files but not the changelog.

set -euo pipefail

# Only act on git push commands
COMMAND=$(jq -r '.tool_input.command // ""' 2>/dev/null)
if ! echo "$COMMAND" | grep -qE '^git push'; then
  exit 0
fi

CHANGELOG="CHANGELOG.md"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0

# Check if the last commit touched source files but not the changelog
CHANGED=$(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)

if [ -z "$CHANGED" ]; then
  exit 0
fi

TOUCHED_CHANGELOG=$(echo "$CHANGED" | grep -c "^CHANGELOG" || true)
TOUCHED_SOURCE=$(echo "$CHANGED" | grep -cvE '^(CHANGELOG|docs/|tests/|\.claude/|data/)' || true)

if [ "$TOUCHED_SOURCE" -gt 0 ] && [ "$TOUCHED_CHANGELOG" -eq 0 ]; then
  cat <<'JSON'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "CHANGELOG REMINDER: This push included source changes but CHANGELOG.md was not updated. Please add an entry under [Unreleased] in CHANGELOG.md describing what changed, then commit it."
  }
}
JSON
fi
