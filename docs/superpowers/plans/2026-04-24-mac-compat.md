# Mac Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the claude-web-app-v2 server and all 52 T-series Playwright tests runnable on macOS after a fresh `git clone`.

**Architecture:** Two problem surfaces — server-side hardcoded Linux paths (`/usr/bin/tmux`, `/home/claude-runner/.local/bin/claude`) and test-side hardcoded paths/Linux-only commands (`APP_DIR`, `fuser`). Fix server paths by dynamic resolution at startup. Fix tests by extracting a shared `platform.mjs` helper and running a one-pass migration script over all 52 T-files.

**Tech Stack:** Node.js ESM, Playwright, shell (`which`, `lsof` on Mac / `fuser` on Linux), `node-pty`, tmux.

---

## Affected File Map

| File | Change |
|------|--------|
| `lib/watchdog/WatchdogManager.js` | Replace hardcoded `CLAUDE` path and `TELEGRAM_STATE_DIR` with dynamic resolution |
| `tests/adversarial/helpers/platform.mjs` | **Create** — exports `APP_DIR` and cross-platform `killPort()` |
| `tests/adversarial/migrate-to-cross-platform.mjs` | **Create** — one-shot migration script; run once, then delete |
| `tests/adversarial/T-*.test.js` (all 52) | Updated by migration script — no manual edits |
| `README.md` | **Create** — Mac setup instructions |
| `package.json` | Add `test:compat` script |

---

### Task 1: Fix WatchdogManager hardcoded paths

**Files:**
- Modify: `lib/watchdog/WatchdogManager.js:12-13,39`

- [ ] **Step 1: Read the current file**

```bash
head -50 lib/watchdog/WatchdogManager.js
```

- [ ] **Step 2: Replace hardcoded CLAUDE path**

Change line 13 from:
```js
const CLAUDE = '/home/claude-runner/.local/bin/claude';
```
To (add right after the TMUX line):
```js
const CLAUDE = (() => { try { return execSync('which claude', { encoding: 'utf8' }).trim(); } catch { return '/home/claude-runner/.local/bin/claude'; } })();
```

- [ ] **Step 3: Replace hardcoded TELEGRAM_STATE_DIR**

Find in `WatchdogManager.js` (around line 39):
```js
envExtras: { TELEGRAM_STATE_DIR: '/home/claude-runner/.claude/channels/telegram2' },
```
Replace with:
```js
envExtras: { TELEGRAM_STATE_DIR: path.join(process.env.HOME || os.homedir(), '.claude', 'channels', 'telegram2') },
```

Confirm `path` and `os` are already imported at the top of the file (they are: `import path from 'path'` and `import os from 'os'`).

- [ ] **Step 4: Verify the file looks right**

```bash
grep -n "TMUX\|CLAUDE\|TELEGRAM_STATE_DIR" lib/watchdog/WatchdogManager.js | head -10
```

Expected output:
```
12:const TMUX = (() => { try { return execSync('which tmux' ...
13:const CLAUDE = (() => { try { return execSync('which claude' ...
39:  envExtras: { TELEGRAM_STATE_DIR: path.join(process.env.HOME || os.homedir() ...
```

- [ ] **Step 5: Commit**

```bash
git add lib/watchdog/WatchdogManager.js
git commit -m "fix: resolve CLAUDE binary and TELEGRAM_STATE_DIR paths dynamically for Mac compat"
```

---

### Task 2: Create cross-platform test helpers

**Files:**
- Create: `tests/adversarial/helpers/platform.mjs`

- [ ] **Step 1: Create the helpers directory and module**

```bash
mkdir -p tests/adversarial/helpers
```

Create `tests/adversarial/helpers/platform.mjs`:
```js
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Absolute path to repo root — derived from this file's location (helpers/ → adversarial/ → tests/ → root)
export const APP_DIR = path.resolve(__dirname, '../../..');

// Kill any process listening on the given TCP port, cross-platform
export function killPort(port) {
  try {
    if (process.platform === 'darwin') {
      execSync(`lsof -ti tcp:${port} | xargs kill -9 2>/dev/null || true`, { shell: true });
    } else {
      execSync(`fuser -k ${port}/tcp 2>/dev/null || true`);
    }
  } catch {}
}
```

- [ ] **Step 2: Verify the path resolves correctly**

```bash
node --input-type=module <<'EOF'
import { APP_DIR } from './tests/adversarial/helpers/platform.mjs';
import { existsSync } from 'fs';
console.log('APP_DIR:', APP_DIR);
console.log('server.js exists:', existsSync(APP_DIR + '/server.js'));
EOF
```

Expected:
```
APP_DIR: /home/claude-runner/apps/claude-web-app-v2
server.js exists: true
```

- [ ] **Step 3: Commit**

```bash
git add tests/adversarial/helpers/platform.mjs
git commit -m "test: add cross-platform helpers (APP_DIR, killPort) for Mac compat"
```

---

### Task 3: Write the migration script

**Files:**
- Create: `tests/adversarial/migrate-to-cross-platform.mjs`

- [ ] **Step 1: Create the migration script**

Create `tests/adversarial/migrate-to-cross-platform.mjs`:
```js
#!/usr/bin/env node
/**
 * One-shot migration: replaces hardcoded APP_DIR and Linux-only fuser calls
 * in all T-*.test.js files with cross-platform equivalents from helpers/platform.mjs.
 * Run once, then delete this file.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(__dirname)
  .filter(f => /^T-\d+.*\.test\.js$/.test(f))
  .map(f => path.join(__dirname, f));

let changed = 0;
for (const file of files) {
  let src = fs.readFileSync(file, 'utf8');
  const original = src;

  // 1. Remove the hardcoded APP_DIR constant (any path ending in claude-web-app-v2)
  src = src.replace(/^const APP_DIR = ['"][^'"]*claude-web-app-v2['"];?\n/m, '');

  // 2. Add import for platform helpers after the last existing import block
  //    Only add if not already present
  if (!src.includes("from './helpers/platform.mjs'")) {
    // Find the last import line
    const lastImportIdx = src.lastIndexOf("\nimport ");
    if (lastImportIdx !== -1) {
      const endOfLastImport = src.indexOf('\n', lastImportIdx + 1);
      src = src.slice(0, endOfLastImport + 1)
        + "import { APP_DIR, killPort } from './helpers/platform.mjs';\n"
        + src.slice(endOfLastImport + 1);
    }
  }

  // 3. Replace fuser calls:
  //    try { execSync(`fuser -k ${PORT}/tcp 2>/dev/null || true`); } catch {}
  //    → killPort(PORT);
  src = src.replace(
    /try\s*\{\s*execSync\(`fuser -k \$\{PORT\}\/tcp[^`]*`[^}]*\)\s*;\s*\}\s*catch\s*\{\}/g,
    'killPort(PORT);'
  );

  if (src !== original) {
    fs.writeFileSync(file, src);
    console.log(`  UPDATED  ${path.basename(file)}`);
    changed++;
  } else {
    console.log(`  SKIP     ${path.basename(file)}`);
  }
}
console.log(`\nDone. ${changed} files updated.`);
```

- [ ] **Step 2: Verify the script can be parsed without errors**

```bash
node --check tests/adversarial/migrate-to-cross-platform.mjs
```

Expected: no output (clean parse).

- [ ] **Step 3: Commit the migration script before running it**

```bash
git add tests/adversarial/migrate-to-cross-platform.mjs
git commit -m "chore: add migration script for cross-platform test compat"
```

---

### Task 4: Run the migration and verify

**Files:**
- Modify: `tests/adversarial/T-*.test.js` (all 52, via script)

- [ ] **Step 1: Run the migration script**

```bash
node tests/adversarial/migrate-to-cross-platform.mjs
```

Expected: lines like `  UPDATED  T-01-double-click.test.js` for most files, `  SKIP` for any already correct. Final line: `Done. 52 files updated.` (number may vary slightly).

- [ ] **Step 2: Spot-check three files for correctness**

Check T-01 (first file):
```bash
head -35 tests/adversarial/T-01-double-click.test.js | grep -E "APP_DIR|killPort|platform|fuser"
```

Expected:
```
import { APP_DIR, killPort } from './helpers/platform.mjs';
...
    killPort(PORT);
```
No line containing `'/home/claude-runner'` or `fuser` should appear.

Check T-12 (tmux-only test, should also be migrated):
```bash
grep -n "APP_DIR\|fuser\|killPort\|platform" tests/adversarial/T-12-tmux-survives-close.test.js
```

Check T-52 (last test):
```bash
grep -n "APP_DIR\|fuser\|killPort\|platform" tests/adversarial/T-52-session-switch-no-garble.test.js
```

- [ ] **Step 3: Confirm no remaining hardcoded paths**

```bash
grep -rn "claude-runner" tests/adversarial/T-*.test.js
```

Expected: **no output** (zero matches).

```bash
grep -rn "fuser" tests/adversarial/T-*.test.js
```

Expected: **no output**.

- [ ] **Step 4: Commit all migrated tests**

```bash
git add tests/adversarial/T-*.test.js
git commit -m "test: migrate all T-tests to cross-platform APP_DIR and killPort helpers"
```

- [ ] **Step 5: Delete the migration script (it's a one-shot tool)**

```bash
git rm tests/adversarial/migrate-to-cross-platform.mjs
git commit -m "chore: remove one-shot migration script"
```

---

### Task 5: Smoke-test a representative subset on this server

Run 5 T-tests that collectively cover: server startup, session creation (direct + tmux), settings, UI rendering, and reconnect. These should pass here first before cloning on Mac.

**Files:** None modified — just verify existing tests pass.

- [ ] **Step 1: Run T-32 (empty state — fastest, no real sessions)**

```bash
npx playwright test tests/adversarial/T-32-empty-state.test.js --reporter=line --timeout=60000
```

Expected: `1 passed`.

- [ ] **Step 2: Run T-01 (double-click — tests session creation in direct + tmux)**

```bash
npx playwright test tests/adversarial/T-01-double-click.test.js --reporter=line --timeout=120000
```

Expected: `2 passed` (one per mode).

- [ ] **Step 3: Run T-09 (settings persist)**

```bash
npx playwright test tests/adversarial/T-09-settings-persist.test.js --reporter=line --timeout=60000
```

Expected: `2 passed`.

- [ ] **Step 4: Run T-06 (WebSocket reconnect)**

```bash
npx playwright test tests/adversarial/T-06-ws-reconnect.test.js --reporter=line --timeout=120000
```

Expected: `2 passed`.

- [ ] **Step 5: Run T-12 (tmux survives server close)**

```bash
npx playwright test tests/adversarial/T-12-tmux-survives-close.test.js --reporter=line --timeout=120000
```

Expected: `1 passed`.

- [ ] **Step 6: If any test fails, fix root cause before proceeding**

Check output for `Error:` lines. Common issues:
- `APP_DIR` still resolving wrong → re-check migration output in Task 4 Step 2
- Port collision → previous test server didn't shut down; `killPort()` not called; check teardown block in that test

---

### Task 6: Add README.md with Mac setup instructions

**Files:**
- Create: `README.md`

- [ ] **Step 1: Create README.md at repo root**

```markdown
# Claude Manager

Web-based manager for Claude Code sessions. Runs a Node.js server; connect via browser.

## Mac Setup

### Prerequisites

```bash
# Node.js 18+
node --version   # must be ≥ 18

# Xcode CLI tools (for node-pty native compilation)
xcode-select --install

# tmux (required for Tmux-mode sessions)
brew install tmux

# Claude CLI (authenticated)
claude --version   # must be in PATH
```

### Install & run

```bash
git clone https://github.com/Morshedk/claude-manager
cd claude-manager
npm install
node server.js
# Open http://localhost:3001
```

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server listen port | `3001` |
| `DATA_DIR` | Session/project storage path | `./data` |
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for Claude CLI | (uses CLI auth) |
| `ANTHROPIC_API_KEY` | Fallback API key | (uses CLI auth) |

### Running tests

```bash
# Install Playwright browsers (first time only)
npx playwright install chromium

# Run compatibility smoke tests
npm run test:compat

# Run all T-series tests
npx playwright test tests/adversarial/T-*.test.js --reporter=line --timeout=120000
```
```

- [ ] **Step 2: Add `test:compat` script to package.json**

In `package.json`, add to the `"scripts"` block:
```json
"test:compat": "npx playwright test tests/adversarial/T-32-empty-state.test.js tests/adversarial/T-01-double-click.test.js tests/adversarial/T-09-settings-persist.test.js tests/adversarial/T-06-ws-reconnect.test.js tests/adversarial/T-12-tmux-survives-close.test.js --reporter=line --timeout=120000"
```

- [ ] **Step 3: Verify the script key appears correctly**

```bash
node -e "const p = JSON.parse(require('fs').readFileSync('package.json','utf8')); console.log(p.scripts['test:compat'])"
```

Expected: prints the playwright command without errors.

- [ ] **Step 4: Commit**

```bash
git add README.md package.json
git commit -m "docs: add Mac setup README and test:compat npm script"
```

---

### Task 7: Merge to beta and push

- [ ] **Step 1: Merge feature branch into beta**

```bash
cd /home/claude-runner/apps/claude-web-app-v2-beta
git merge feat/tmux-path-fix   # or whatever the current feature branch is named
pm2 restart claude-v2-beta
```

The post-merge hook will auto-push to GitHub.

- [ ] **Step 2: Verify beta is healthy**

```bash
pm2 logs claude-v2-beta --lines 10 --nostream
```

Expected: no `Error:` or `EADDRINUSE` lines. Server should show `Listening on port 3002`.

- [ ] **Step 3: Run smoke tests against beta port to confirm**

```bash
PORT=3002 npx playwright test tests/adversarial/T-32-empty-state.test.js --reporter=line --timeout=60000
```

Expected: `1 passed`.

---

## Mac Clone Verification Checklist

After cloning on a Mac, the engineer should confirm each item:

- [ ] `npm install` completes without native build errors
- [ ] `node server.js` starts and `http://localhost:3001` loads
- [ ] Creating a **Direct** session shows a terminal
- [ ] Creating a **Tmux** session shows a terminal (requires `tmux` in PATH)
- [ ] `npm run test:compat` passes all 5 tests
- [ ] Server restart (Ctrl-C → `node server.js`) reconnects active sessions
