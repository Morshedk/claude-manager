# B-rendering.test.js — Fix Documentation

> Fixed: 2026-04-24

## The 5 Bugs Fixed

---

### Bug 1 — `APP_DIR` was hardcoded

**Old code:**
```js
const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
```

**New code:**
```js
const APP_DIR = path.resolve(__dirname, '../../');
```

**Why it failed:** The hardcoded absolute path worked on the machine where the test was written but would silently point to a stale location when run from a git worktree (e.g., `claude-web-app-v2-beta`) or after a directory rename. Any file access via `APP_DIR` (writing B-FINDINGS.md, finding `server.js`) would silently read from or write to the wrong directory. Using `__dirname` makes the path relative to the test file's location, which is always correct regardless of worktree or working directory.

---

### Bug 2 — Server was spawned with `server.js` and no crash log

**Old code:**
```js
serverProc = spawn('node', ['server.js'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

Also, `stopServer()` had no crash log printing:
```js
async function stopServer() {
  if (serverProc) {
    try { serverProc.kill('SIGKILL'); } catch {}
    serverProc = null;
  }
  if (tmpDir) {
    try { execSync(`rm -rf ${tmpDir}`); } catch {}
    tmpDir = '';
  }
}
```

**New code:**
```js
const crashLogPath = path.join(tmpDir, 'server-crash.log');
serverProc = spawn('node', ['server-with-crash-log.mjs'], {
  cwd: APP_DIR,
  env: { ...process.env, DATA_DIR: tmpDir, PORT: String(PORT), CRASH_LOG: crashLogPath },
  stdio: ['ignore', 'pipe', 'pipe'],
});
```

With crash log printing in `stopServer()`:
```js
async function stopServer() {
  if (serverProc) {
    try { serverProc.kill('SIGKILL'); } catch {}
    serverProc = null;
  }
  try {
    const crashLog = fs.readFileSync(path.join(tmpDir, 'server-crash.log'), 'utf8');
    if (crashLog.trim()) console.log('\n  [CRASH LOG]\n' + crashLog);
  } catch {}
  if (tmpDir) {
    try { execSync(`rm -rf ${tmpDir}`); } catch {}
    tmpDir = '';
  }
}
```

**Why it failed:** `server.js` was the old entrypoint that no longer exists in this codebase. The current entrypoint is `server-with-crash-log.mjs`, which also captures unhandled rejections and uncaught exceptions to a `CRASH_LOG` file. Without the crash log, server crashes during tests appeared as silent timeouts — the test would hang waiting for the server to respond (`fetch(${BASE_URL}/)`) for the full 25-second deadline, then all 25 tests would fail with unhelpful "server not ready" errors. With the crash log printed at teardown, the actual error is immediately visible.

---

### Bug 3 — `openSessionInBrowser` used `networkidle` which hangs with WebSocket

**Old code:**
```js
await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30000 });
```

**New code:**
```js
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
```

**Why it failed:** `networkidle` waits until there are no more than 0 in-flight network requests for 500ms. The app establishes a persistent WebSocket connection immediately on page load. A WebSocket upgrade counts as an open connection for the purposes of Playwright's network idle detection. Since the WebSocket stays connected indefinitely (it's the real-time session channel), `networkidle` would never fire — the navigation would time out after 30 seconds on every test that called `openSessionInBrowser`. `domcontentloaded` fires as soon as the HTML is parsed, which is the correct signal for this SPA.

This bug existed in two places: the main `openSessionInBrowser` function and the `page.goto` call in B.25 (navigate-away-and-back). Both were fixed.

---

### Bug 4 — No sleep after project click; session cards appeared before state settled

**Old code:**
```js
const projectItem = page.locator('#project-sidebar .project-item').first();
if (await projectItem.count()) await projectItem.click();

// Wait for session cards
try {
  await page.waitForSelector('.session-card', { timeout: 10000 });
} catch {}
await sleep(500);
```

**New code:**
```js
const projectItem = page.locator('#project-sidebar .project-item').first();
if (await projectItem.count()) {
  await projectItem.click();
  await sleep(500);  // let project detail render
}

// Wait for session cards
try {
  await page.waitForSelector('.session-card', { timeout: 10000 });
} catch {}
await sleep(500);
```

**Why it failed:** Clicking the project item triggers a React state update that re-renders the project detail panel. Without a brief pause, `waitForSelector('.session-card')` would start polling immediately — before the project detail component had mounted. In some timing scenarios this caused the selector to match stale DOM from a previously selected project, or it would miss the loading state entirely and see 0 cards when the project had sessions. The 500ms sleep gives the React render cycle time to complete before the card polling begins.

---

### Bug 5 — B.24 rapid switching used old "Open button" pattern

**Old code (inside the B.24 rapid-switching loop):**
```js
const targetName = i % 2 === 0 ? 'B24-session-B' : 'B24-session-A';
try {
  const card = page.locator('.session-card').filter({ hasText: targetName });
  if (await card.count()) {
    const openBtn = card.locator('button').filter({ hasText: /^Open$/ });
    if (await openBtn.count()) await openBtn.first().click();
  }
} catch {}
```

**New code:**
```js
const targetName = i % 2 === 0 ? 'B24-session-B' : 'B24-session-A';
try {
  const card = page.locator('.session-card').filter({ hasText: targetName });
  if (await card.count()) {
    await card.first().click();
  }
} catch {}
```

**Why it failed:** The current SessionCard component no longer has a standalone "Open" button as a distinct child button element with exact text `Open`. Clicking the card itself (the `.session-card` element) opens the session overlay. The old code looked for `button:has-text("Open")` inside the card, found nothing, and silently skipped the click — so B.24 was running 10 loop iterations where nothing actually happened. The "rapid switching" test was not testing rapid switching at all. The fix mirrors the fallback already present in the main `openSessionInBrowser` function (`await card.first().click()`).

---

## All 25 Flows and What They Verify

| Test | Flow |
|------|------|
| **B.01** | Terminal mounts after session create — `.terminal-container` is visible and xterm buffer has rows |
| **B.02** | fitAddon sets PTY cols from viewport width — cols must not be the hardcoded default 120 at 1440px |
| **B.03** | xterm.reset() fires on session:subscribed — stale buffer is cleared when Refresh is clicked |
| **B.04** | No bullet/dot accumulation after 5 consecutive Refreshes — xterm.reset() clears correctly each time |
| **B.05** | Auto-scroll to bottom after 1000 lines of output — userScrolledUp must be false |
| **B.06** | Scroll up pauses auto-scroll — new output does not yank the viewport back to bottom |
| **B.07** | Scrolling back to bottom re-enables auto-scroll — userScrolledUp flips back to false |
| **B.08** | Browser viewport resize triggers PTY resize — cols decrease when window narrows from 1440→800px |
| **B.09** | Resize to 300px wide does not crash the terminal — still visible, no JS errors |
| **B.10** | Resize to 3000px wide handles large col count without crash — terminal still renders |
| **B.11** | CJK characters (Chinese, Japanese, Korean) render correctly in xterm with Unicode11 addon |
| **B.12** | Emoji (🎉🔥💻🚀) render without JS crash or corruption |
| **B.13** | ANSI color codes (\033[31m etc.) render without crash; WebGL renderer produces no DOM color spans |
| **B.14** | 10,000 lines of output handled without crash or empty buffer (scrollback cap at 10,000 lines) |
| **B.15** | 50,000-character single line rendered without crash or out-of-memory error |
| **B.16** | Alt-screen mode (less): enter and exit cleanly — no /etc/passwd bleed onto normal screen |
| **B.17** | DA/DA2 device attribute responses are NOT forwarded back to the PTY as input — no `?1;2c` visible |
| **B.18** | Basic keyboard input works — typing `echo HELLO` in focused terminal produces visible output |
| **B.19** | Ctrl+C terminates a blocking process (`cat`) — bash prompt or `^C` visible afterward |
| **B.20** | Default mode (readOnly=false) forwards input correctly; readOnly=true code path verified by review |
| **B.21** | Terminal renders correctly in headless Playwright where WebGL is unavailable — fallback renderer works |
| **B.22** | Session A output does not bleed into session B terminal — isolation between concurrent sessions |
| **B.23** | Exactly one `.terminal-container` in DOM after session switch — old xterm instance disposed |
| **B.24** | 10 rapid session switches leave exactly one terminal in DOM — no stale handlers or memory leak |
| **B.25** | Terminal is functional after navigating away (about:blank) and back — no blank screen, no crash |
