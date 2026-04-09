# Plan Review: Split Screen UX + Path Dropdown

## Verdict: APPROVED

The design document is thorough, well-grounded in the codebase, and ready for implementation. All five required sections are present and substantive. File:line citations were verified against the actual codebase and are accurate. The acceptance criteria are observable from the running app. The lifecycle stories are genuine user journeys. The risk section identifies real failure modes including false-PASS scenarios.

---

## Verification of cited code

All spot-checked citations are accurate:

- **store.js line 57**: `splitView` is indeed `signal(false)` -- confirmed.
- **store.js line 12**: `projects` is indeed `signal([])` with the described shape -- confirmed.
- **actions.js lines 196-199**: `handleSessionCreated` calls `upsertSession` then `attachSession` exactly as described -- confirmed.
- **SessionOverlay.js line 53**: Inline style `${isSplit ? 'left: 50%;' : 'left: 0;'}` matches the "hardcoded left: 50%" claim -- confirmed.
- **SessionOverlay.js line 21**: `toggleSplit` is `() => { splitView.value = !splitView.value; }` with no localStorage persistence -- confirmed.
- **NewProjectModal.js lines 99-106**: Plain text input for path with no datalist -- confirmed.
- **App.js line 61**: `#sidebar-resize` div rendered between ProjectSidebar and ProjectDetail with no JS wiring -- confirmed.
- **TerminalPane.js line 169**: ResizeObserver with `fitAddon.fit()` exists exactly as described -- confirmed.
- **styles.css lines 345-369**: Resize handle CSS classes exist with no JS initialization -- confirmed.
- **styles.css line 377**: `min-height: 100px` on `#terminals-area` -- confirmed (line 377, not 378 as stated, but close enough to not cause implementation confusion).

---

## Minor observations (non-blocking)

1. **Line number off-by-one on styles.css.** The design cites `min-height: 100px` at line 378; the actual line is 377. This is trivial and will not mislead an implementer.

2. **dom.js vs. new resize.js.** The design says "Add an `initResize` function to `dom.js` (or create a new `resize.js` util)." This flexibility is fine, but the implementer should be guided to prefer `dom.js` since it already exists and contains DOM utility functions -- creating a separate file adds a module for a single function.

3. **ResizeObserver debounce during drag.** Risk 3 correctly identifies that `fitAddon.fit()` will fire on every frame during drag. The design says to debounce or skip fit calls during active drag. However, Section 2 (Feature 3) says to update the CSS variable directly during mousemove and only update the signal on mouseup. Since the CSS variable change triggers a container resize (which fires the ResizeObserver), the implementer needs explicit guidance: either (a) set a global `isDragging` flag and have TerminalPane skip fit during drag, or (b) accept the cost since `fitAddon.fit()` is relatively cheap. The design identifies the risk but does not prescribe which mitigation to use. This is acceptable for a design doc but the implementer should be aware.

4. **No mention of `#resize-sessions` in the DOM.** The design references `#resize-sessions` in the App.js initialization for Feature 4b, but does not confirm whether this element ID currently exists in the rendered HTML. If it does not exist, the implementer will need to add it to the appropriate component (likely ProjectDetail.js between the sessions area and terminals area). This is implied but not explicitly stated.

5. **Acceptance criterion 2 depends on browser datalist filtering behavior.** The criterion says typing `/home/user/apps/` should show both matching paths as "filtered suggestions." HTML5 datalist filtering is browser-controlled and varies -- some browsers filter by substring, others by prefix. The criterion is still observable (the user can see suggestions appear) but the exact filtering behavior is not under the implementation's control.
