#!/bin/bash
# promote.sh — promote beta → prod for v2
#
# What this does:
#   1. Runs unit tests (npm test) against beta
#   2. Runs E2E adversarial tests (npm run test:e2e) against the beta server (port 3002)
#   3. Merges beta → main
#   4. Restarts claude-v2-prod (port 3001)
#
# Usage: ./promote.sh [--skip-e2e]

set -e

SKIP_E2E=false
if [[ "$1" == "--skip-e2e" ]]; then
  SKIP_E2E=true
  echo "⚠️  Skipping E2E tests (--skip-e2e)"
fi

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "beta" ]]; then
  echo "❌ Must run from beta branch (currently on $CURRENT_BRANCH)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ Uncommitted changes on beta. Commit or stash first."
  exit 1
fi

echo "=== Step 1: Unit tests ==="
npm test
echo "✅ Unit tests passed"

if [[ "$SKIP_E2E" == "false" ]]; then
  echo ""
  echo "=== Step 2: E2E adversarial tests (against beta on port 3002) ==="
  # E2E tests use the ports defined in each test file.
  # Pass TEST_BASE_URL so tests know to hit the beta server.
  TEST_BASE_URL=http://localhost:3002 npm run test:e2e
  echo "✅ E2E tests passed"
fi

echo ""
echo "=== Step 3: Merge beta → main ==="
git checkout main
git merge --no-ff beta -m "chore: promote beta → main ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
echo "✅ Merged"

echo ""
echo "=== Step 4: Restart prod ==="
pm2 restart claude-v2-prod
echo "✅ claude-v2-prod restarted"

echo ""
echo "🚀 Promotion complete. v2 prod (port 3001) is now running the latest main."
git log --oneline -3
