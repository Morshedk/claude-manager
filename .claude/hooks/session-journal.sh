#!/bin/bash
# Stop hook: reminds Claude to write a journal entry before ending the session.
# Checks if a journal entry was written for today — if not, prints a reminder.

MAIN_DIR="/home/claude-runner/apps/claude-web-app-v2"
TODAY=$(date +%Y-%m-%d)
JOURNAL_DIR="$MAIN_DIR/docs/journal"

# Check if any journal entry exists for today
if ls "$JOURNAL_DIR"/${TODAY}-*.md 1>/dev/null 2>&1; then
  exit 0
fi

# Check if any source files were modified this session (staged or unstaged)
changed=$(git -C "$MAIN_DIR" diff --name-only HEAD 2>/dev/null | grep -E '^(public/js/|lib/|server)' | head -3)

if [ -n "$changed" ]; then
  echo "SESSION JOURNAL REMINDER: Source files were changed but no journal entry exists for today." >&2
  echo "" >&2
  echo "Before finishing, write a journal entry to docs/journal/${TODAY}-<slug>.md covering:" >&2
  echo "  - What was worked on and why" >&2
  echo "  - Key decisions made and the reasoning behind them" >&2
  echo "  - What was discovered (especially surprises)" >&2
  echo "  - What's still open/unresolved" >&2
  echo "" >&2
  echo "Changed files: $changed" >&2
fi

exit 0
