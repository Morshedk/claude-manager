# Terminal Copy & Scrollbar -- Review

## Design-to-implementation fidelity

### (A) Copy-to-clipboard via Ctrl+C / Cmd+C

| Design decision | Implemented? | Notes |
|---|---|---|
| `customKeyEventHandler` intercepts Ctrl+C / Cmd+C | YES | TerminalPane.js L104-125, ProjectTerminalPane.js L93-114. Both check `e.ctrlKey || e.metaKey` and `e.key === 'c'`. |
| Check `hasSelection()` before copying | YES (strengthened) | Design says check `hasSelection()` AND `getSelection().length > 0`. Implementation uses only `getSelection().length > 0`, which is strictly stronger (covers both empty-selection and no-selection cases). Faithful. |
| `navigator.clipboard.writeText(xterm.getSelection())` | YES | Via the `copyToClipboard` helper at L96-102 / L85-91. |
| `xterm.clearSelection()` after copy | YES | L112, L120 / L101, L109. |
| `showToast('Copied to clipboard', 'success')` on success | YES | L98 / L87. |
| Return `false` to prevent SIGINT when selection exists | YES | L121 / L110 returns `false` inside the `sel.length > 0` guard. |
| Return `true` (pass-through to PTY) when no selection | YES | Falls through to L124 / L113 returning `true`. |
| Import `showToast` from actions.js | YES | L5 in both files. |
| Handler registered AFTER `xterm.open(container)` (Risk 2) | YES | `xterm.open()` at L78/L74; handler at L104/L93. Correct ordering. |
| Handler works regardless of `readOnly` mode | YES | The handler is registered at L104, outside and before the `if (!readOnly)` guard at L167. Always active. |

### (B) Ctrl+Shift+C alternative

| Design decision | Implemented? | Notes |
|---|---|---|
| Intercept Ctrl+Shift+C for copy | YES | L106/L95: `e.ctrlKey && e.shiftKey && e.key === 'C'` (uppercase C, correct). |
| If selection exists, copy; if not, do nothing (no SIGINT) | YES | L108-114/L97-103: copies if `sel.length > 0`, always returns `false` regardless. |
| `isCopyAlt` checked before `isCopy` to avoid ambiguity | YES | The `if (isCopyAlt)` block (L108) precedes `if (isCopy)` (L116). Since Shift changes `e.key` from `'c'` to `'C'`, `isCopy` would be false for Ctrl+Shift+C anyway, but the ordering provides defense-in-depth. |

### (C) Right-click context copy

| Design decision | Implemented? | Notes |
|---|---|---|
| `contextmenu` event listener on container | YES | L135 / L124. |
| If selection: copy, clear selection, preventDefault | YES | L127-134 / L116-123. Checks `sel.length > 0`, calls `preventDefault()`, `copyToClipboard()`, `clearSelection()`. |
| If no selection: allow default context menu | YES | The `if` block only fires when `sel.length > 0`; otherwise the event passes through. |
| Cleanup: `removeEventListener('contextmenu')` on unmount | YES | L261 / L202. |

### (D) Copy toast feedback

| Design decision | Implemented? | Notes |
|---|---|---|
| Success toast: "Copied to clipboard" with type 'success' | YES | L98 / L87. |
| Error toast: "Copy failed -- check clipboard permissions" with type 'error' | YES | L100 / L89. Uses `.catch()` on the clipboard Promise. |
| Uses existing `showToast()` from actions.js | YES | No new toast infrastructure introduced. |

### (E) Always-visible terminal scrollbar

| Design decision | Implemented? | Notes |
|---|---|---|
| Scrollbar visible at rest (not hover-only) | YES | Firefox: `scrollbar-color: rgba(255,255,255,0.2) transparent` on `.xterm-viewport` (L782). WebKit: thumb `rgba(255,255,255,0.2)` (L790). No more transparent-at-rest. |
| Width increased from 4px to 6px | YES | L787: `width: 6px`. |
| Brighter on hover | YES | Firefox: `0.4` on `.xterm-viewport:hover` (L785). WebKit: `0.4` on `::-webkit-scrollbar-thumb:hover` (L794). |
| `.xterm:hover .xterm-viewport` parent-hover selector removed | YES | Diff confirms removal. Now only `.xterm-viewport:hover` is used. |
| Old `transition: scrollbar-color 0.3s` removed | YES | Not present in new CSS. Implementation notes justify this (Firefox does not support it). |
| Old `.xterm-viewport:hover::-webkit-scrollbar-thumb` selector removed | YES | Replaced by always-visible thumb + `:hover` on thumb directly. |
| `border-radius` changed from 2px to 3px | YES | L792. Matches global scrollbar thumb radius. |

### (F) Files NOT modified (per design section 2.3)

| File | Modified? | Correct |
|---|---|---|
| `public/vendor/xterm.min.css` | NO | Correct |
| `public/vendor/xterm.min.js` | NO | Correct |
| `public/index.html` | NO | Correct |

---

## What was missed, skipped, or done differently

### Nothing significant was missed.

The implementation covers all design decisions faithfully. The only micro-deviation is:

1. **Design section 2.5 says to check both `hasSelection()` AND `getSelection().length > 0`.** The implementation skips `hasSelection()` and goes directly to `getSelection().length > 0`. This is functionally equivalent since a non-empty `getSelection()` implies `hasSelection()` is true, and checking length is the stronger guard. This is a simplification, not a gap.

2. **The `transition` property removal** is documented in the implementation notes and justified. Not a deviation.

---

## Security issues

**None found.**

- The copy path is output-only: it reads from xterm's internal buffer (`getSelection()`) and writes to the system clipboard via the standard Clipboard API. No user-supplied input is written to the DOM, evaluated as code, or concatenated into HTML.
- No `innerHTML`, `eval`, or template literal injection.
- The `showToast` call passes hardcoded string literals, not user-controlled data.
- The `contextmenu` handler calls `preventDefault()` only when selection exists; it does not inject any custom DOM elements.
- The Clipboard API is sandboxed by the browser; clipboard writes require user gesture (the keypress/right-click satisfies this).

---

## Error handling gaps

**None found.**

- Clipboard write failure is caught with `.catch()` and shows an error toast. The rejection does not propagate or cause an unhandled promise rejection.
- The handler correctly does NOT send SIGINT when a copy attempt fails (because it returned `false` before the async clipboard operation). This matches the design's intent for Story 5.
- All addon loads are wrapped in try/catch (pre-existing pattern).

---

## Race conditions or state machine violations

**None found.**

- The `customKeyEventHandler` is synchronous. `xterm.hasSelection()` / `getSelection()` are synchronous reads of xterm's internal state. The clipboard write is async (fire-and-forget), but the handler's return value (`false` to block SIGINT) is determined synchronously before the async write. There is no race between "copy" and "send SIGINT."
- The `clearSelection()` call happens synchronously after `getSelection()`. There is no window where the selection could change between reading it and clearing it.
- The `contextmenu` handler accesses the same xterm instance captured in the closure. Since each terminal pane creates its own xterm instance, there is no cross-terminal state leakage.

---

## Structural debt checks

### 1. Dead code

**None introduced.** The diff is purely additive (new handler registrations, new CSS rules). The removed CSS rules (transparent-at-rest, hover-only selectors, transition) are cleanly replaced -- no orphaned rules remain.

The CSS diff also adds unrelated `.file-split-pane` and `.fb-path-input` blocks. These are from a different feature (file browser split pane) that is already in the working tree. They are not dead code -- they are part of a separate feature. They do not interact with the terminal scrollbar or copy feature.

### 2. Scattered ownership

**Minor observation (pre-existing, not introduced by this feature).** The `copyToClipboard` helper function is defined identically in both `TerminalPane.js` and `ProjectTerminalPane.js`. The entire key handler and context menu handler blocks are duplicated. This is the same pattern used by both components for all their shared logic (theme, addon loading, scroll tracking). The design explicitly calls for this ("Same changes as TerminalPane.js" in section 2.2). No new architectural concern -- just continuation of the existing pattern. If both components are ever consolidated into a shared hook, the copy logic would naturally deduplicate.

### 3. Effect scope correctness

**Correct.** Both `useLayoutEffect` hooks depend on `[sessionId]` (TerminalPane) and `[terminalId]` (ProjectTerminalPane) respectively. The new code added inside these effects does not reference any additional reactive state from props or signals -- it only uses the xterm instance and the container DOM element, both of which are created inside the effect. No missing dependencies.

### 4. Cleanup completeness

**Correct.** Every new setup has a corresponding teardown:

| Setup | Teardown |
|---|---|
| `container.addEventListener('contextmenu', onContextMenu)` | `container.removeEventListener('contextmenu', onContextMenu)` (L261 / L202) |
| `xterm.attachCustomKeyEventHandler(fn)` | Disposed when `xterm.dispose()` is called (L265 / L205) -- xterm.js cleans up all handlers on dispose. |

No new timers, intervals, observers, or subscriptions introduced without cleanup.

### 5. Orphaned references

**None.** No IDs, CSS selectors, or function names were removed or renamed. All new CSS selectors (`.xterm-viewport`, `.xterm-viewport:hover`, etc.) target elements created by xterm.js, which is still loaded. No references to removed code.

---

## Verdict: FAITHFUL

The implementation matches every design decision. Both TerminalPane.js and ProjectTerminalPane.js received identical treatment. The CSS replacement is clean and complete. Error handling, cleanup, and edge cases are all addressed. No security issues, no race conditions, no dead code.
