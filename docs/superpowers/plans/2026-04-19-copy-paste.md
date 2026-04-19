# Copy/Paste Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make copy/paste reliable in both terminal panes (even on non-HTTPS connections) and add a Copy button to the session events log.

**Architecture:** The root cause of "lost copy/paste" is that `navigator.clipboard` requires a secure context (HTTPS or localhost). When accessed over plain HTTP, all clipboard API calls silently fail. Fix: create a shared `copyText(text)` utility that falls back to `document.execCommand('copy')` via a hidden textarea when the Clipboard API is unavailable. Add a one-click "Copy" button to SessionLogPane's header that copies all visible log lines.

**Tech Stack:** Preact + htm/preact (no JSX/build step), xterm.js v5, browser Clipboard API + execCommand fallback

---

## Files to Change

| File | Change |
|------|--------|
| `public/js/utils/clipboard.js` | **Create** — `copyText(text)` with async Clipboard API + execCommand fallback |
| `public/js/components/TerminalPane.js` | Replace all `navigator.clipboard.writeText(...)` calls with `copyText(...)` |
| `public/js/components/ProjectTerminalPane.js` | Same replacements as TerminalPane |
| `public/js/components/SessionLogPane.js` | Add "Copy" button in header that calls `copyText(lines.join('\n'))` |

---

### Task 1: Shared clipboard utility with execCommand fallback

**Files:**
- Create: `public/js/utils/clipboard.js`

The `navigator.clipboard` API requires a secure context (HTTPS or `localhost`). On plain HTTP (e.g. remote droplet accessed over HTTP), all calls throw. The fallback is `document.execCommand('copy')` — available everywhere but requires text to be in a focused, selected DOM element.

- [ ] **Step 1: Create `public/js/utils/clipboard.js`**

```js
// public/js/utils/clipboard.js

/**
 * Copy text to clipboard. Tries navigator.clipboard first; falls back to
 * execCommand('copy') via a temporary textarea for non-HTTPS contexts.
 * @param {string} text
 * @returns {Promise<void>} resolves on success, rejects on failure
 */
export async function copyText(text) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to execCommand fallback
    }
  }
  // execCommand fallback — works in non-secure contexts
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(ta);
  if (!ok) throw new Error('execCommand copy failed');
}
```

- [ ] **Step 2: Verify the file was created correctly**

```bash
node -e "import('./public/js/utils/clipboard.js').then(m => console.log('ok', Object.keys(m)))"
```
Expected: `ok [ 'copyText' ]`

- [ ] **Step 3: Commit**

```bash
git add public/js/utils/clipboard.js
git commit -m "feat: add copyText clipboard utility with execCommand fallback"
```

---

### Task 2: Use copyText in TerminalPane

**Files:**
- Modify: `public/js/components/TerminalPane.js`

There are **3 call sites** of `navigator.clipboard.writeText(...)` in TerminalPane. Replace all 3. The import is an ES module path — add it at the top of the file.

- [ ] **Step 1: Add import at top of `public/js/components/TerminalPane.js`**

Find line 5 (current last import line):
```js
import { showToast, openFileInThirdSpace } from '../state/actions.js';
```

Replace with:
```js
import { showToast, openFileInThirdSpace } from '../state/actions.js';
import { copyText } from '../utils/clipboard.js';
```

- [ ] **Step 2: Replace the 3 `navigator.clipboard.writeText` calls**

**Call site 1** — in `attachCustomKeyEventHandler`, inside `if (isCtrlC || isCmdC || isCtrlShiftC)`:

Old:
```js
          navigator.clipboard.writeText(sel).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Copy failed — check clipboard permissions', 'error'),
          );
```

New:
```js
          copyText(sel).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Copy failed', 'error'),
          );
```

**Call site 2** — in `handleContextMenu`:

Old:
```js
        navigator.clipboard.writeText(sel).then(
          () => showToast('Copied to clipboard', 'success'),
          () => showToast('Copy failed — check clipboard permissions', 'error'),
        );
```

New:
```js
        copyText(sel).then(
          () => showToast('Copied to clipboard', 'success'),
          () => showToast('Copy failed', 'error'),
        );
```

*(Note: There is no third call site in TerminalPane — verify with grep.)*

- [ ] **Step 3: Verify no `navigator.clipboard.writeText` calls remain in TerminalPane**

```bash
grep -n "navigator.clipboard.writeText" public/js/components/TerminalPane.js
```
Expected: no output (0 matches)

- [ ] **Step 4: Commit**

```bash
git add public/js/components/TerminalPane.js
git commit -m "fix: use copyText utility in TerminalPane for non-HTTPS clipboard support"
```

---

### Task 3: Use copyText in ProjectTerminalPane

**Files:**
- Modify: `public/js/components/ProjectTerminalPane.js`

Same pattern as Task 2 — 2 call sites.

- [ ] **Step 1: Add import at top of `public/js/components/ProjectTerminalPane.js`**

Find line 5 (current last import line):
```js
import { showToast } from '../state/actions.js';
```

Replace with:
```js
import { showToast } from '../state/actions.js';
import { copyText } from '../utils/clipboard.js';
```

- [ ] **Step 2: Replace the 2 `navigator.clipboard.writeText` calls**

**Call site 1** — in `attachCustomKeyEventHandler`:

Old:
```js
          navigator.clipboard.writeText(sel).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Copy failed — check clipboard permissions', 'error'),
          );
```

New:
```js
          copyText(sel).then(
            () => showToast('Copied to clipboard', 'success'),
            () => showToast('Copy failed', 'error'),
          );
```

**Call site 2** — in `handleContextMenu`:

Old:
```js
        navigator.clipboard.writeText(sel).then(
          () => showToast('Copied to clipboard', 'success'),
          () => showToast('Copy failed — check clipboard permissions', 'error'),
        );
```

New:
```js
        copyText(sel).then(
          () => showToast('Copied to clipboard', 'success'),
          () => showToast('Copy failed', 'error'),
        );
```

- [ ] **Step 3: Verify no `navigator.clipboard.writeText` calls remain**

```bash
grep -n "navigator.clipboard.writeText" public/js/components/ProjectTerminalPane.js
```
Expected: no output

- [ ] **Step 4: Commit**

```bash
git add public/js/components/ProjectTerminalPane.js
git commit -m "fix: use copyText utility in ProjectTerminalPane for non-HTTPS clipboard support"
```

---

### Task 4: Add Copy button to SessionLogPane

**Files:**
- Modify: `public/js/components/SessionLogPane.js`

The session events log renders lines in a `lines` state array. Add a "Copy" button in the header that copies all visible lines as plain text. Use `copyText` from the shared utility.

- [ ] **Step 1: Update imports at top of `public/js/components/SessionLogPane.js`**

Find lines 3-4 (currently):
```js
import { openFileInThirdSpace } from '../state/actions.js';
```

Replace with:
```js
import { openFileInThirdSpace, showToast } from '../state/actions.js';
import { copyText } from '../utils/clipboard.js';
```

- [ ] **Step 2: Add Copy button in the header**

Find the header section in the `return html` block. It currently looks like:
```js
      <div style="display:flex;align-items:center;gap:8px;padding:0 12px;height:32px;background:var(--bg-surface);border-bottom:1px solid var(--border);flex-shrink:0;">
        <span style="font-size:12px;font-weight:600;color:var(--text-bright);">Session Events</span>
        <div style="flex:1;"></div>
        ${loading ? html`<span style="font-size:10px;color:var(--text-muted);">Loading…</span>` : null}
        <a
          href=${`/api/sessionlog/${sessionId}/full`}
          download
          style="font-size:11px;color:var(--text-muted);text-decoration:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
        >↓ Download</a>
      </div>
```

Replace with:
```js
      <div style="display:flex;align-items:center;gap:8px;padding:0 12px;height:32px;background:var(--bg-surface);border-bottom:1px solid var(--border);flex-shrink:0;">
        <span style="font-size:12px;font-weight:600;color:var(--text-bright);">Session Events</span>
        <div style="flex:1;"></div>
        ${loading ? html`<span style="font-size:10px;color:var(--text-muted);">Loading…</span>` : null}
        <button
          onClick=${() => {
            if (lines.length === 0) return;
            copyText(lines.join('\n')).then(
              () => showToast('Copied to clipboard', 'success'),
              () => showToast('Copy failed', 'error'),
            );
          }}
          style="font-size:11px;color:var(--text-muted);background:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
          title="Copy all log lines"
        >⎘ Copy</button>
        <a
          href=${`/api/sessionlog/${sessionId}/full`}
          download
          style="font-size:11px;color:var(--text-muted);text-decoration:none;border:1px solid var(--border);border-radius:var(--radius-sm);padding:2px 7px;cursor:pointer;"
        >↓ Download</a>
      </div>
```

- [ ] **Step 3: Verify the file parses cleanly**

```bash
node --input-type=module < public/js/components/SessionLogPane.js 2>&1 | head -5
```
Expected: no output or only import-related errors (which are fine — this is a browser module)

- [ ] **Step 5: Commit**

```bash
git add public/js/components/SessionLogPane.js
git commit -m "feat: add Copy button to SessionLogPane using shared clipboard utility"
```

---

### Task 5: Smoke test

- [ ] **Step 1: Restart PM2 beta**

```bash
pm2 restart claude-v2-beta
sleep 2
pm2 logs claude-v2-beta --lines 10 --nostream
```
Expected: server starts on port 3002 with no JS errors

- [ ] **Step 2: Verify clipboard utility loads in browser**

Open browser console at `http://127.0.0.1:3002/` and run:
```js
// In browser console
import('/js/utils/clipboard.js').then(m => console.log('copyText:', typeof m.copyText))
```
Expected: `copyText: function`

- [ ] **Step 3: Test copy in session events log**

1. Open any project with a running session
2. Click the session card to expand events
3. Click "⎘ Copy" button in session events header
4. Expected: toast "Copied to clipboard" appears
5. Paste into a text editor — should contain the event log lines

- [ ] **Step 4: Test copy in terminal**

1. Open a project, click + to open a terminal tab (or open a session)
2. Select some text in the terminal
3. Press Ctrl+C (or Ctrl+Shift+C)
4. Expected: toast "Copied to clipboard" appears
5. Paste elsewhere — should contain the selected text

- [ ] **Step 5: Commit smoke test confirmation**

No code changes needed if all tests pass. If any issues found, fix and commit separately.
