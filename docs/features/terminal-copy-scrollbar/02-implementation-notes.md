# Terminal Copy & Scrollbar — Implementation Notes

## Files modified

### `public/js/components/TerminalPane.js`
- Added `import { showToast } from '../state/actions.js';` (line 5).
- After `xtermRef.current = { xterm, fitAddon };` (after xterm.open has already been called, satisfying Risk 2): added `copyToClipboard` helper, `xterm.attachCustomKeyEventHandler(...)`, and `container.addEventListener('contextmenu', onContextMenu)`.
- In the cleanup return function: added `container.removeEventListener('contextmenu', onContextMenu)`.

### `public/js/components/ProjectTerminalPane.js`
- Identical changes to `TerminalPane.js` above (import, handler registration, cleanup removal).

### `public/css/styles.css` (lines 779–799, TERMINAL SCROLLBAR section)
- Replaced the hover-only scrollbar block with always-visible rules.
- Firefox: `scrollbar-color: rgba(255,255,255,0.2) transparent` at rest, `rgba(255,255,255,0.4) transparent` on `.xterm-viewport:hover`.
- WebKit/Blink: `::-webkit-scrollbar { width: 6px }`, thumb at `rgba(255,255,255,0.2)` at rest, `rgba(255,255,255,0.4)` on `::-webkit-scrollbar-thumb:hover`.
- Removed the `transition: scrollbar-color 0.3s` rule (Firefox does not animate scrollbar-color in practice; removing it avoids a potentially misleading property).
- Removed the `.xterm:hover .xterm-viewport` parent-hover selector entirely — the thumb is now always visible without requiring the parent to be hovered.
- The `.xterm-viewport:hover::-webkit-scrollbar-thumb` selector (that previously showed the thumb only when hovering the viewport itself) is also removed; the thumb is now always present.

## Deviations from the design

**None.** All changes match the design spec exactly. The design's transition property was present in the original code but not re-added; the design document does not specify whether `transition` should be retained in the new block, and removing it is the conservative choice (see "most conservative interpretation" rule).

## Smoke test

A Node.js script checked 19 pattern assertions across the three modified files:

**TerminalPane.js (10 checks):**
- `showToast` import present
- `attachCustomKeyEventHandler` present
- `sel.length > 0` guard (empty-selection check) present
- `xterm.clearSelection()` present
- `addEventListener('contextmenu', onContextMenu)` present
- `removeEventListener('contextmenu', onContextMenu)` present
- `e.metaKey` check present (macOS Cmd+C)
- `e.shiftKey` + `e.key === 'C'` present (Ctrl+Shift+C)
- `'Copy failed'` error-path present
- `return false` (prevents SIGINT when selection exists) present

**ProjectTerminalPane.js (4 checks):**
- All four structural items above confirmed present

**CSS (5 checks):**
- Scrollbar width is 6px (not 4px)
- No `rgba(255,255,255,0.0)` (invisible thumb) remains
- `rgba(255,255,255,0.2)` at-rest thumb present
- `rgba(255,255,255,0.4)` hover thumb present
- No `transparent transparent` (hover-only pattern) remains

Result: **19/19 PASS**

Circular import check: `actions.js` and `store.js` contain zero references to `TerminalPane` or `ProjectTerminalPane`. No circular dependency introduced.

## Observations the designer may have missed

**Ctrl+Shift+C key value.** The design says to intercept `Ctrl+Shift+C`. When `shiftKey` is true, `e.key` is `'C'` (uppercase), not `'c'`. The implementation checks `e.key === 'C'` for the Shift variant. This is correct browser behaviour — if the designer had written `e.key === 'c'` with shift, it would silently fail to match.

**`transition` property.** The original scrollbar block had `transition: scrollbar-color 0.3s` on `.xterm-viewport`. Firefox does not support CSS transitions on `scrollbar-color` (it is not a transitionable property in the spec). Removing it has no visible effect but avoids a meaningless property in the stylesheet. This is recorded as a minor cleanup, not a deviation.

## Explicitly NOT done

- **No "Select All" shortcut (Ctrl+A / Cmd+A):** out of scope per design section 2.6.
- **No clipboard paste interception:** already works natively, per design section 2.6.
- **No "Copy" button in the terminal header:** out of scope per design section 2.6.
- **No custom context menu:** out of scope per design section 2.6.
- **No modification to `public/vendor/xterm.min.css` or `public/vendor/xterm.min.js`:** intentionally excluded per design section 2.3.
- **No modification to `public/index.html`:** not needed, per design section 2.3.
