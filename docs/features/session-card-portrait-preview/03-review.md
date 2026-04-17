# Session Card Portrait Preview -- Implementation Review

Date: 2026-04-09

## Design Fidelity Assessment

### 1. Card Layout (Section 2: Card layout)

| Design Decision | Implemented? | Notes |
|----------------|-------------|-------|
| Title bar (28px) with name + summary | YES | `.session-card-titlebar` has `min-height: 28px`, name left, summary right with em-dash separator |
| Tag row (22px) with status/mode/TG badges | YES | `.session-card-tags` has `min-height: 22px`, dedicated row below title bar |
| Terminal preview pane (~160-200px) as `<pre>` | YES | `.session-card-preview` has `height: 160px`, uses `<pre>` not xterm.js |
| Action bar (28px) with icon Edit, Stop/Refresh, Delete | YES | `.session-card-actionbar` has `min-height: 28px`, wrench SVG icon for Edit |
| Grid changed to `minmax(300px, 1fr)` | YES | Line 260 of styles.css |
| Preview pane dark bg, 1px inset border, `--radius-sm` | YES | Uses `--bg-deep`, `1px solid var(--border)`, `var(--radius-sm)` |
| Preview pane 9px monospace, `overflow-x/y: auto` | YES | `font-size: 9px`, both overflow axes set to auto |
| No "Open" button -- card body click attaches | YES | `onClick` on `.session-card` calls `attachSession`, no Open button in action bar |
| Wrench/spanner icon for Edit (14px) | YES | WrenchIcon SVG component at 14x14 |
| Timestamp in action bar right side | YES | `.session-card-meta` with `margin-left: auto` |

### 2. Summary Generation (Section 2: Session name + summary)

| Design Decision | Implemented? | Notes |
|----------------|-------------|-------|
| `cardSummary` on `session.meta` | YES | WatchdogManager line 635 sets `liveSession.meta.cardSummary = cardLabel` |
| 5-7 word `cardLabel` from extended SUMMARIZE_PROMPT | YES | Prompt extended at line 56-58 |
| Uses existing watchdog tick cadence (no new API calls) | YES | Only existing `summarizeSession()` code path modified |
| Placeholder "No summary yet" when absent | YES | SessionCard line 131 |

### 3. Terminal Preview (Section 2: Terminal preview)

| Design Decision | Implemented? | Notes |
|----------------|-------------|-------|
| 8KB ring buffer on DirectSession | YES | `_previewBuffer` capped at 8192 bytes (line 212-214) |
| `getPreviewLines(n)` on DirectSession | YES | Line 310, strips ANSI, returns last N non-blank lines |
| `tmux capture-pane` for TmuxSession | YES | Line 306-308, uses `-p -e -S -N` |
| 20-second server-side interval | YES | `startPreviewInterval` uses `setInterval` with 20000ms |
| Lines stored on `session.meta.previewLines` | YES | SessionManager line 447 |
| Piggybacked on `sessions:list` broadcast | YES | No new WS message type; broadcastFn calls `_broadcastSessionsList` |
| ANSI stripped server-side | YES | Both `getPreviewLines` implementations call `stripAnsi` |
| Auto-scroll to bottom | YES | `useEffect` + `useRef` sets `scrollTop = scrollHeight` |

### 4. Configurability (Section 2: Configurability)

| Design Decision | Implemented? | Notes |
|----------------|-------------|-------|
| `previewLines` setting with default 20 | YES | SettingsStore DEFAULTS includes `previewLines: 20` |
| Min 5, max 50 | PARTIAL | Client enforces via `Math.max(5, Math.min(50, ...))` in save handler and `min="5" max="50"` on input. Server does NOT validate -- see security section |
| Exposed in Settings modal | YES | Numeric input in Features section |

### 5. Not-to-Build Items

| Design Decision | Implemented? | Notes |
|----------------|-------------|-------|
| No live xterm.js in cards | CORRECT | Uses `<pre>` |
| No syntax highlighting | CORRECT | Plain text only |
| No per-session preview config | CORRECT | Global only |
| No inline name editing | CORRECT | Not added |
| No drag-and-drop | CORRECT | Not added |

---

## What Was Missed or Skipped

### Acknowledged by implementer (documented in 02-implementation-notes.md)

1. **Resize minimum not raised from 60px to 200px** (Risk 4 mitigation). Design explicitly recommended this.
2. **Summary timestamp / "(idle)" indicator** (Risk 6 mitigation). Not in acceptance criteria but was a design mitigation.
3. **"Refresh summary" card action** (Section 2, trigger c). Design mentioned it but card layout spec omitted a button for it.
4. **`/api/sessions/:id/scrollback/raw` fix**. Dead code acknowledged, not fixed.

### NOT acknowledged by implementer

5. **No server shutdown cleanup for `_previewInterval`**: `stopPreviewInterval()` exists but is never called. `server.js` has no SIGTERM/SIGINT handler and no graceful shutdown logic. The interval will keep firing until the process is killed, which is not a problem for normal operation but violates cleanup completeness.

6. **No removal of watchdog `summary` event listener**: In `sessionHandlers.js`, `watchdogManager.on('summary', ...)` is registered in the constructor. There is no corresponding `removeListener` call. If SessionHandlers is ever re-instantiated (unlikely but possible), listeners accumulate.

---

## Security Issues

### 1. XSS in previewLines -- SAFE

The preview pane uses Preact's `html` tagged template (htm/preact), which auto-escapes text content. The `previewText` string is interpolated as a text child of `<pre>`, not via `innerHTML` or `dangerouslySetInnerHTML`. ANSI is also stripped server-side. **No XSS vector here.**

### 2. cardSummary sanitization -- SAFE (with caveat)

`cardSummary` is rendered via Preact text interpolation (`${cardSummary}`), which escapes HTML. However, `cardSummary` comes from Claude API output parsed as JSON. If the Claude API returns a string containing script-like content, Preact's escaping handles it. **No direct XSS.** The `title` attribute also uses Preact's attribute binding which escapes properly.

**Caveat:** The cardLabel is not length-limited or content-validated. A malformed/adversarial Claude API response could return a very long string. The CSS `text-overflow: ellipsis` + `white-space: nowrap` on `.session-card-summary` mitigates visual overflow, but the full string is in the DOM and in the `title` attribute.

### 3. previewLines numeric input -- NOT validated server-side

The `PUT /api/settings` endpoint passes `req.body` directly to `settings.update()`. The `deepMerge` function in SettingsStore only merges keys that exist in DEFAULTS, so arbitrary keys are rejected. However, the `previewLines` value is not validated to be a number in range [5, 50] server-side. A malicious client could send `{ "previewLines": 999999 }` or `{ "previewLines": "not a number" }`.

**Impact:** The `startPreviewInterval` code in SessionManager does validate at read time (`typeof v === 'number' && v >= 5 && v <= 50`), falling back to 20 if invalid. So the operational impact is limited -- an out-of-range value is stored but ignored at runtime. Still, storing unvalidated input is poor practice.

### 4. tmux capture-pane command injection -- SAFE

The tmux name is constructed as `cm-${meta.id.slice(0, 8)}` where `id` is a UUID. The name is wrapped with `JSON.stringify()` before interpolation into shell commands. No injection vector.

---

## Error Handling Gaps

### 1. tmux capture-pane failure

`TmuxSession.getPreviewLines()` wraps the `execSync` call in try/catch and returns `[]` on failure. The `startPreviewInterval` in SessionManager also wraps `getPreviewLines()` in try/catch. **Handled adequately.**

### 2. stripAnsi throws

If `stripAnsi` throws inside `DirectSession.getPreviewLines()`, the exception propagates to `startPreviewInterval` which catches it per-session (line 448: `catch { /* non-fatal */ }`). **Handled.**

### 3. WatchdogManager summary doesn't include cardLabel

If Claude API returns JSON without a `cardLabel` field, line 618 evaluates to `(undefined || '').trim()` which is `''`. An empty string is stored as `cardSummary`. The card renders the "No summary yet" placeholder only when `cardSummary` is falsy. An empty string is falsy, so this falls through correctly. **Handled.**

### 4. Sessions deleted during preview sweep

If a session is deleted while the preview interval is iterating `this.sessions.values()`, the Map iterator may behave unpredictably. In practice, JavaScript Map iterators are snapshot-safe for deletions of entries not yet visited, so this is unlikely to cause issues. But adding/deleting sessions concurrently with the async interval could produce stale references. **Low risk but not guarded.**

---

## Memory Leak Analysis

### 1. Preview interval on server shutdown

`stopPreviewInterval()` is defined but **never called**. There is no `process.on('SIGTERM')` or `process.on('SIGINT')` handler in `server.js`. The `setInterval` handle leaks if the server shuts down gracefully (the Node process would need to be killed). **Gap confirmed.**

### 2. Ring buffer bounded

`_previewBuffer` is capped at 8192 bytes (line 212-214 of DirectSession.js). **Bounded correctly.**

### 3. Watchdog summary listener

The `watchdogManager.on('summary', ...)` listener in SessionHandlers is never removed. Since SessionHandlers is instantiated once per server lifetime, this is not a practical leak. But it violates the principle of cleanup completeness. **Low risk.**

---

## Structural Debt Checks

### 1. Dead code / orphaned CSS

**Found:** Three legacy CSS classes are preserved in styles.css:
- `.session-card-actions` (line 401)
- `.session-lastline` (line 404)
- `.session-description` (line 416)

None of these are referenced in any JS file in the `public/js/` directory. They are pure dead code kept "for any code that still references it" per the CSS comments. No such code exists.

**Found:** Duplicate `.btn-icon` definitions. Lines 379-398 define the portrait card version. Lines 587-588 define a different version (from generic utilities section). The later definition partially overrides the earlier one. This causes `padding: 6px` to override `padding: 0` and `width/height: 24px` to be ignored. **Bug: the wrench icon button gets unexpected padding from the later rule.**

### 2. Scattered ownership of previewLines

`previewLines` is updated in exactly one place: `SessionManager.startPreviewInterval()` (line 447). **Clean -- single writer.**

### 3. useEffect dependency correctness

The auto-scroll `useEffect` in SessionCard has `[session.previewLines]` as its dependency array. With Preact signals, `session.previewLines` is an array reference that changes on every broadcast (because `SessionManager.list()` does `{ ...s.meta }` which copies the reference). The effect fires when the reference changes, which is correct for detecting new preview data. **Correct deps.**

However, if the session object itself is the same reference between renders (possible with signal-based stores), the `session.previewLines` reference in the dependency array may not trigger re-render. This depends on how `sessionState.js` manages session object identity. If it creates new objects on each broadcast (likely, given `sessions.list()` spreads meta), deps are correct. **Likely correct but depends on store implementation.**

### 4. Cleanup completeness

- `stopPreviewInterval()`: Defined but **never called** from server.js or anywhere else. No shutdown handler exists.
- Watchdog `summary` listener: **Never removed.** No cleanup method on SessionHandlers.
- `_lastLineTimers` cleanup: Timers are cleared per-session on delete (line 406-410). **Clean.**
- Preview interval `setInterval` return value: Stored in `_previewInterval`. Can be cleared if `stopPreviewInterval()` were called. **Structurally clean, operationally uncalled.**

### 5. Orphaned references

- No JS code references `.session-lastline`, `.session-card-actions`, or `.session-description`.
- The `session-card-name-link` class is applied in SessionCard.js line 124 and defined in CSS line 316. **Used.**
- `getBadgeClass` and `getBadgeLabel` are defined and used within SessionCard.js. **Used.**
- `openEditSessionModal` is imported and used. **Used.**

---

## Verdict: FAITHFUL

The implementation matches the design document in all material aspects. The card layout, preview mechanism, summary integration, configurability, and data flow are all implemented as specified. The deviations are minor (stopPropagation on preview clicks, useEffect for auto-scroll) and are documented with justification. The acknowledged omissions (resize minimum, summary staleness indicator, refresh summary button) are either out of scope or non-acceptance-criteria mitigations.

The issues found are:
1. **Duplicate `.btn-icon` CSS rules** causing unintended style override (bug).
2. **No server shutdown cleanup** for the preview interval (structural debt).
3. **No server-side validation** of `previewLines` numeric input (minor security).
4. **Legacy CSS dead code** (cleanup debt, explicitly preserved by implementer).
5. **Watchdog listener not removable** (theoretical, not practical with current architecture).

None of these issues represent a divergence from the design -- they are implementation-quality issues the design did not address.
