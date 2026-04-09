# Implementation Notes: Split Screen UX + Path Dropdown

## Files Modified

### `/home/claude-runner/apps/claude-web-app-v2/public/js/components/NewProjectModal.js`
- Added `projects` import from `store.js`.
- Before the render, computed `uniqueSuggestions`: deduplicated union of all project `.path` values and their parent directories (path up to last `/`).
- Added `list="project-paths-datalist"` attribute to the path `<input>`.
- Added `<datalist id="project-paths-datalist">` with `<option>` for each unique suggestion.

### `/home/claude-runner/apps/claude-web-app-v2/public/js/state/store.js`
- Changed `splitView` initialization: reads `localStorage.getItem('splitView')`. Defaults to `true` when the key is absent or `'true'`; only `false` when explicitly `'false'`. Wrapped in try/catch for incognito.
- Added `splitPosition` signal: reads `localStorage.getItem('splitPosition')`, parses as float, defaults to `50`. Wrapped in try/catch.

### `/home/claude-runner/apps/claude-web-app-v2/public/js/components/SessionOverlay.js`
- Changed import from `preact/hooks`: removed `useEffect` (not needed), kept `useRef`.
- Added `splitPosition` to store imports.
- `toggleSplit`: after toggling signal, writes `localStorage.setItem('splitView', ...)`.
- Added `isDragging` ref and `handleResizeMouseDown` function implementing drag-resize on the split boundary. During drag: directly sets `--split-pos` CSS variable on `document.documentElement` for smooth visual feedback (no signal update on every frame). On mouseup: updates `splitPosition` signal and writes to `localStorage`.
- Changed overlay `left` inline style from `'left: 50%'` to `'left: var(--split-pos, 50%)'` when in split mode.
- Added `<div class="split-resize-handle">` as first child of overlay div when `isSplit` is true.

### `/home/claude-runner/apps/claude-web-app-v2/public/js/components/App.js`
- Added `useEffect` import from `preact/hooks`.
- Added `initResize` import from `../utils/dom.js`.
- Added `splitView`, `splitPosition` to store imports.
- Added three `useEffect` hooks:
  1. Sets `--split-pos` CSS variable on `document.documentElement` whenever `splitPosition.value` changes (also runs on mount, applying the persisted value immediately).
  2. Toggles `body.session-split` class based on `splitView.value && !!attachedSessionId.value`.
  3. Wires `initResize` to `#sidebar-resize` / `#project-sidebar` (horizontal, min 140px, max 500px) and to `#resize-sessions` / `#sessions-area` (vertical, min 60px, max 800px). Returns cleanup functions.

### `/home/claude-runner/apps/claude-web-app-v2/public/js/utils/dom.js`
- Added `initResize(handle, axis, target, opts)` function. Attaches `mousedown` to handle; on drag, updates `target.style.width` or `target.style.height` clamped between `opts.min` and `opts.max`. Adds/removes `.dragging` class on handle. Returns cleanup function. No `fitAddon.fit()` call — the existing `ResizeObserver` in `TerminalPane` handles terminal refitting automatically.

### `/home/claude-runner/apps/claude-web-app-v2/public/css/styles.css`
Added at end of file:
- **Split view layout**: `body.session-split #workspace { margin-right: calc(100% - var(--split-pos, 50%)); }` — mirrors v1 behavior so workspace content is clipped to the left of the split boundary.
- **Split resize handle**: `.split-resize-handle` — fixed positioned at `left: var(--split-pos)`, spans topbar to bottom, 7px wide, `cursor: col-resize`. Has `::after` pseudo-element (3px wide accent indicator) that appears on hover/dragging, matching the existing `.resize-handle::after` pattern.
- **Global scrollbar**: thin 5px webkit scrollbar with `var(--bg-active)` thumb, matching v1.
- **Terminal scrollbar**: `.xterm-viewport` with `scrollbar-width: thin`, transparent by default, `rgba(255,255,255,0.15)` thumb visible on `.xterm:hover`. WebKit pseudo-elements for 4px scrollbar, same logic. Copied from v1 `styles.css` lines 1404–1430.

---

## Deviations from Design

1. **`useEffect` not used in SessionOverlay** — Design implied a `useEffect` for the resize handle in SessionOverlay, but the drag logic is entirely event-driven (mousedown/mousemove/mouseup on document). No `useEffect` is needed; only `useRef` for the `isDragging` flag.

2. **ResizeObserver debounce during drag (plan-review note 3)** — The design flags this as a risk but does not prescribe a fix. This implementation does NOT add a debounce or `isDragging` guard inside `TerminalPane`. Rationale: `fitAddon.fit()` is cheap (just reads container dimensions and sends a resize message), and the design says "accept the cost" is acceptable. The split resize handle updates the CSS variable directly (no container reflow per frame), so `ResizeObserver` only fires when the split position change causes the terminal container to resize — which happens at the speed the browser reflows, not per mousemove event.

3. **`#resize-sessions` exists in DOM** — Plan review note 4 flagged uncertainty about whether this element ID existed. It does exist: `ProjectDetail.js` line 103 renders `<div class="resize-handle resize-handle-v" id="resize-sessions"></div>`. No additional element needed.

4. **`useEffect` dep arrays in App.js use `.value`** — Preact signals with `useEffect` and `.value` in the dep array: this is the standard pattern in the codebase (seen in other components). The effects will re-run when the signal values change.

---

## Smoke Test

Server was already running on port 3001. Ran the following checks:

```
curl -s http://localhost:3001/ | grep -c 'id="app"'
# → 1  (page loads with #app root)

curl -s http://localhost:3001/css/styles.css | grep -c 'split-resize-handle|xterm-viewport|session-split'
# → 13  (CSS rules present)

curl -s http://localhost:3001/js/components/NewProjectModal.js | grep -c 'project-paths-datalist'
# → 2  (datalist id referenced on input and rendered)

curl -s http://localhost:3001/js/state/store.js | grep -c 'readSplitView|readSplitPosition|splitPosition'
# → 5  (new signals present)

curl -s http://localhost:3001/js/components/App.js | grep -c 'initResize|session-split|split-pos'
# → 7  (resize wiring and split class management present)

curl -s http://localhost:3001/js/utils/dom.js | grep -c 'initResize'
# → 1  (function exported)

curl -s http://localhost:3001/js/components/SessionOverlay.js | grep -c 'split-resize-handle|split-pos|splitPosition|localStorage'
# → 7  (all split features present)
```

All checks passed.

---

## Designer Gaps Noticed

1. **The overlay's `z-index: 100` is lower than `.split-resize-handle`'s `z-index: 105`.** This is correct (handle must be above overlay to receive mouse events). The design specified this correctly.

2. **`body.session-split` body class depends on both `splitView` AND `attachedSessionId`.** The design said to add/remove the class "when not in split mode" but the class should also be removed when no session is attached (overlay is closed). The App.js effect uses `splitView.value && !!attachedSessionId.value` to handle this correctly.

3. **`#project-sidebar` has `width: var(--sidebar-w)` from CSS.** When `initResize` sets `sidebar.style.width`, the inline style overrides the CSS variable. This is the correct behavior for a resize handle.

---

## Explicitly NOT Done

- No server-side changes (design confirmed none needed).
- No `fitAddon.fit()` call in `initResize` — design mentioned it for the sidebar/sessions handles but the existing ResizeObserver in TerminalPane handles this automatically.
- No touch/mobile drag support — design explicitly excluded this.
- No keyboard-accessible resize — design explicitly excluded this.
- No vertical split — design explicitly excluded this.
- No per-project split preference — design explicitly excluded this.
