#!/usr/bin/env bash
# check-logger-import.sh — blocks commits that add new lib/*.js files without importing the logger

set -euo pipefail

STAGED=$(git diff --cached --name-only --diff-filter=A | grep '^lib/.*\.js$' || true)
FAILED=0

for file in $STAGED; do
  if ! grep -qE 'import.*logger|require.*logger' "$file" 2>/dev/null; then
    echo "BLOCKED: $file does not import the logger."
    echo "  New server modules must use lib/logger/Logger.js instead of console.*"
    echo "  Add: import { log } from '../logger/Logger.js';"
    FAILED=1
  fi
done

exit $FAILED
