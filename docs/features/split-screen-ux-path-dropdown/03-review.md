# Review: Split Screen UX + Path Dropdown Implementation

## Design Decision Fidelity

### Feature 1: Project path dropdown

| Design Decision | Implemented? | Notes |
|---|---|---|
| Add `<datalist>` to path input in NewProjectModal | YES | `list="project-paths-datalist"` on input, `<datalist>` rendered below |
| Import `projects` from store.js | YES | Line 3 of NewProjectModal.js |
| Deduplicate project paths | YES | `[...new Set([...allPaths, ...parentDirs])]` at line 60 |
| Include parent directories as suggestions | YES | `p.lastIndexOf('/')` extraction at lines 56-59 |
| No server-side changes | YES | Purely client-side |

**Verdict: Faithful.**

### Feature 2: Default split screen on new session

| Design Decision | Implemented? | Notes |
|---|---|---|
| `splitView` reads from localStorage, defaults to `true` when absent | YES | `readSplitView()` at store.js lines 57-62: `v === null \|\| v === 'true'` returns true |
| try/catch for incognito | YES | Both `readSplitView` and `readSplitPosition` wrapped |
| `toggleSplit` persists to localStorage | YES | SessionOverlay.js line 24 |

**Verdict: Faithful.**

### Feature 3: Split screen terminal resize with draggable split handle

| Design Decision | Implemented? | Notes |
|---|---|---|
| `splitPosition` signal in store.js, default 50, from localStorage | YES | `readSplitPosition()` at lines 66-75 |
| App.js sets `--split-pos` CSS variable via useEffect | YES | Lines 59-61 |
| App.js toggles `body.session-split` class | YES | Lines 64-67; correctly depends on BOTH splitView AND attachedSessionId |
| SessionOverlay uses `var(--split-pos, 50%)` for `left` | YES | Line 86 inline style |
| Split resize handle as first child of overlay | YES | Lines 97-103, rendered when isSplit is true |
| `onMouseDown` drag handler that updates CSS variable directly during drag | YES | Lines 30-53: `document.documentElement.style.setProperty` on mousemove |
| Signal updated only on mouseup | YES | Line 48: `splitPosition.value = pct` |
| localStorage persisted on mouseup | YES | Line 49 |
| Clamp between 20% and 85% | YES | Line 38 and line 47 both use `Math.min(85, Math.max(20, ...))` |
| CSS: `body.session-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)); }` | YES | styles.css lines 623-625 |
| CSS: `.split-resize-handle` with correct positioning, z-index 105, cursor col-resize | YES | Lines 628-655 |
| Design note: use requestAnimationFrame or direct style for smooth drag | PARTIAL | Uses direct style (not RAF). Acceptable -- direct style is sufficient for smooth feedback |

**Verdict: Faithful.**

### Feature 4: Scroll handles and resize handles

| Design Decision | Implemented? | Notes |
|---|---|---|
| Terminal scrollbar styling (Firefox scrollbar-width/color) | YES | Lines 664-671 |
| Terminal scrollbar styling (WebKit pseudo-elements) | YES | Lines 672-683; matches v1 pattern |
| `.xterm:hover .xterm-viewport` for Firefox scrollbar visibility | YES | Line 669 |
| Global scrollbar thin/5px with bg-active thumb | YES | Lines 658-661 |
| `initResize` utility function in dom.js | YES | Lines 54-90 |
| App.js wires initResize to `#sidebar-resize` / `#project-sidebar` | YES | Lines 71-77 |
| App.js wires initResize to `#resize-sessions` / `#sessions-area` | YES | Lines 73-80 |
| Cleanup functions returned and called in useEffect cleanup | YES | Lines 83-86 |
| Null guards for handle/target elements | YES | Ternary checks at lines 76-80 |

**Verdict: Faithful.**

---

## Issues Found

### 1. WebKit scrollbar thumb shows only on `.xterm-viewport:hover`, not `.xterm:hover`

**Severity: Minor (cosmetic)**

The Firefox path correctly uses `.xterm:hover .xterm-viewport` (line 669) so the scrollbar appears when hovering anywhere on the terminal. But the WebKit path uses `.xterm-viewport:hover` (line 678), which means the scrollbar thumb only appears when the mouse is directly over the narrow viewport element (the scrollbar area itself). This is a v1 behavior copy (v1 had the same pattern), so it is not a regression, but it means the WebKit scrollbar is harder to discover than the Firefox one.

### 2. No `user-select: none` during split drag

**Severity: Minor (UX)**

During `handleResizeMouseDown` in SessionOverlay.js, text selection is not suppressed. When the user drags the split handle across terminal content or overlay text, the browser may select text, causing visual jank. The `initResize` function in dom.js has the same issue. V1's resize handler (referenced in the design) added `body.style.userSelect = 'none'` on mousedown and restored it on mouseup. Neither handler does this.

### 3. `--split-pos` CSS variable set on documentElement, but `split-resize-handle` reads it in CSS

**Severity: None (correct)**

The CSS variable flow is: App.js useEffect sets `--split-pos` on `document.documentElement` on mount (from stored signal). During drag, SessionOverlay sets it directly on `document.documentElement`. The `.split-resize-handle` CSS reads `var(--split-pos)`. This is consistent. No issue.

### 4. Race between App.js useEffect and SessionOverlay drag handler for `--split-pos`

**Severity: None (correct)**

On mouseup, the drag handler sets `splitPosition.value = pct`. This triggers App.js's useEffect which sets `--split-pos` to the same value. During drag, the handler sets `--split-pos` directly without going through the signal, and the App.js effect does not run (signal unchanged). On mouseup, both converge. No conflict.

### 5. XSS in datalist options

**Severity: None (safe)**

The `<option value=${p} />` in NewProjectModal.js uses Preact's htm template literal, which escapes attribute values. Project paths come from the `projects` signal which is populated from the server API. Even if a path contained special characters, htm/Preact would escape them. No XSS risk.

### 6. No validation of `splitPosition` range from localStorage

**Severity: Low**

`readSplitPosition()` parses the localStorage value as a float but does not clamp it to the 20-85 range. A manually edited localStorage value of `5` or `99` would be accepted and applied. The drag handler clamps on every interaction, so it would self-correct on first drag, but the initial render could show a nearly invisible pane.

### 7. `body.session-split` class not removed on unmount

**Severity: None (correct)**

The useEffect in App.js at lines 64-67 toggles the class based on `splitView.value && !!attachedSessionId.value`. When `attachedSessionId` becomes null (overlay closes), the effect runs and removes the class. Correct.

---

## Security Assessment

- **XSS**: No raw HTML injection. All user inputs go through Preact's escaping. Project paths in datalist are attribute-escaped by htm.
- **Input validation**: Project name and path are trimmed before submission. No path traversal risk since this is a client-side suggestion list only.
- **localStorage**: try/catch wrapped. No sensitive data stored (just boolean and percentage).

No security issues found.

---

## Error Handling Assessment

- localStorage access: wrapped in try/catch (both read and write).
- DOM element queries: guarded with null checks in App.js initResize wiring.
- Project creation: has try/catch with user-facing error toast.
- Missing edge: `readSplitPosition` does not clamp to valid range (noted above).

---

## Race Conditions / State Machine Violations

- **Signal vs DOM**: The split drag correctly bypasses the signal during mousemove and syncs on mouseup. No re-render storm.
- **Multiple overlays**: Only one overlay can be attached at a time (single `attachedSessionId` signal). No multi-overlay race.
- **Resize handle attachment timing**: The `useEffect([], ...)` for `initResize` runs after first render, which is when the DOM elements exist. If Preact replaces the elements on re-render, the listeners would be orphaned. However, the `#sidebar-resize` and `#project-sidebar` elements are rendered by App.js itself and are stable across re-renders (they are not conditionally rendered). Low risk.

---

## Verdict: FAITHFUL

All four features were implemented as designed. The deviations noted in the implementation notes are justified and minor (no useEffect needed for drag logic, no fitAddon call due to ResizeObserver). The two minor issues found (no user-select suppression during drag, no range clamping on localStorage read) are low-severity UX polish items, not design divergences.
