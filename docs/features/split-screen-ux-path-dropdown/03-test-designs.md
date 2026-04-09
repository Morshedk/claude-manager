# Test Designs: Split Screen UX + Path Dropdown

## Test Inventory

| ID | Name | Story | Type | Port |
|----|------|-------|------|------|
| T-1 | Path dropdown shows existing project paths | Story 1 | Playwright browser | 3300 |
| T-2 | New session opens in split view by default | Story 2 | Playwright browser | 3301 |
| T-3 | Split position drag and persist | Story 3 | Playwright browser | 3302 |
| T-4 | Terminal scrollbar appears on hover | Story 4 | Playwright browser | 3303 |
| T-5 | Sidebar and sessions resize handles functional | Story 5 | Playwright browser | 3304 |
| T-6 | Adversarial: splitPosition localStorage poisoned with out-of-range value | Review gap | Playwright browser | 3305 |

---

### T-1: Path dropdown shows existing project paths

**Flow:**
1. Start server on port 3300.
2. Create two projects via REST API: `POST /api/projects` with `{ name: "Alpha", path: "/home/dev/services/alpha" }` and `{ name: "Beta", path: "/home/dev/services/beta" }`.
3. Open browser to `http://localhost:3300`.
4. Wait for page load. Click the "New Project" button (or whatever triggers the NewProjectModal -- look for a button with text "New Project" or a `+` icon in the sidebar header).
5. Wait for the modal to appear. Focus the project path input (`#new-project-path`).
6. Use Playwright to evaluate: `document.querySelectorAll('#project-paths-datalist option')` and collect their `value` attributes.
7. Verify that the datalist contains at least 3 options: `/home/dev/services/alpha`, `/home/dev/services/beta`, and the parent directory `/home/dev/services`.
8. Type `/home/dev/services/` into the path input. Verify the datalist still contains both full paths (browser filtering is handled natively; we just confirm the options exist in the DOM).

**Pass condition:** The `<datalist>` element `#project-paths-datalist` contains `<option>` elements for both project paths AND the shared parent directory `/home/dev/services`. At least 3 unique options are present.

**Fail signal:** The datalist element is missing, has zero options, or does not include parent directory suggestions. A pre-implementation codebase would have no `#project-paths-datalist` element at all.

**Test type:** Playwright browser

**Port:** 3300

---

### T-2: New session opens in split view by default

**Flow:**
1. Start server on port 3301.
2. Create a project via REST API: `POST /api/projects` with `{ name: "TestProj", path: "/tmp/test-split" }`.
3. Open browser to `http://localhost:3301`. Clear localStorage (`page.evaluate(() => localStorage.clear())`).
4. Reload the page. Wait for load.
5. Select the project in the sidebar (click on the project card/name).
6. Create a new session: click the "New Session" button. Fill in any required fields in the modal and submit.
7. Wait for `#session-overlay` to appear in the DOM.
8. Read the computed `left` style of `#session-overlay` using `getComputedStyle`.
9. Verify that `left` is approximately 50% of the viewport width (not 0, which would mean full-screen mode).
10. Verify that `document.body` has class `session-split`.
11. Verify that the workspace element `#workspace` has a non-zero `margin-right` (confirming the workspace is clipped).

**Pass condition:** After clearing localStorage and creating a session, the overlay opens in split mode: `#session-overlay` has `left` near 50% of viewport, `body.session-split` class is present, and `#workspace` has `margin-right > 0`.

**Fail signal:** The overlay has `left: 0` (full-screen mode), `body.session-split` class is absent, or workspace has no margin-right. A pre-implementation codebase would default to `splitView = false` and render full-screen.

**Test type:** Playwright browser

**Port:** 3301

---

### T-3: Split position drag and persist across reload

**Flow:**
1. Start server on port 3302.
2. Create a project and session via REST API.
3. Open browser. Select the project, attach the session (click to open overlay).
4. Confirm overlay is in split mode (check `body.session-split` class).
5. Locate the `.split-resize-handle` element. Get its bounding box.
6. Perform a Playwright mouse drag: mousedown at the handle center, mousemove to x = 30% of viewport width, mouseup.
7. After mouseup, read the CSS variable `--split-pos` from `document.documentElement.style`.
8. Verify `--split-pos` is approximately `30%` (within 2% tolerance).
9. Read `localStorage.getItem('splitPosition')` via page.evaluate. Verify it is approximately `30`.
10. Verify the overlay's computed `left` is approximately 30% of viewport width.
11. Verify `#workspace` computed margin-right is approximately 70% of viewport width.
12. Reload the page. Wait for load. Re-select project, re-attach session.
13. After reload, read `--split-pos` from documentElement. Verify it is still approximately 30%.
14. Verify the overlay opens at approximately 30% left position.

**Pass condition:** After dragging the split handle to 30%, the CSS variable, localStorage, overlay position, and workspace margin all reflect ~30%. After reload, the position is preserved.

**Fail signal:** Split handle is not draggable (no mousemove response), localStorage not updated, position resets to 50% after reload. A pre-implementation codebase has no `.split-resize-handle` element and no `--split-pos` variable.

**Test type:** Playwright browser

**Port:** 3302

---

### T-4: Terminal scrollbar appears on hover

**Flow:**
1. Start server on port 3303.
2. Create a project and a session via REST API.
3. Open browser. Attach the session so the terminal overlay is visible.
4. Wait for the `.xterm` element to be present inside `#session-overlay-terminal`.
5. Use `page.evaluate` to check the computed style of `.xterm-viewport` for `scrollbar-color` or `scrollbar-width`. Verify `scrollbar-width` is `thin`.
6. Hover over the `.xterm` element using Playwright `page.hover('.xterm')`.
7. After hover, use `page.evaluate` to read the computed style of the `.xterm-viewport` element. For Firefox-style check: verify `scrollbar-color` contains a non-transparent color. For WebKit check (Chromium Playwright): use `getComputedStyle` on the pseudo-element or verify the CSS rule exists in the stylesheet.
8. As a stylesheet rule existence check: evaluate `[...document.styleSheets].some(ss => { try { return [...ss.cssRules].some(r => r.selectorText && r.selectorText.includes('xterm-viewport') && r.cssText.includes('scrollbar')); } catch { return false; } })`. This must return true.

**Pass condition:** The `.xterm-viewport` element has `scrollbar-width: thin` set. CSS rules for `.xterm-viewport` scrollbar styling exist in the document's stylesheets. The `.xterm:hover .xterm-viewport` rule is present.

**Fail signal:** No scrollbar rules for `.xterm-viewport` in any stylesheet. `scrollbar-width` is not `thin`. A pre-implementation codebase has zero xterm-viewport scrollbar rules.

**Test type:** Playwright browser

**Port:** 3303

---

### T-5: Sidebar and sessions area resize handles are functional

**Flow:**
1. Start server on port 3304.
2. Create a project via REST API.
3. Open browser. Select the project so ProjectDetail renders with `#sessions-area` and sidebar is visible.
4. Locate `#sidebar-resize` element. Verify it exists and has `cursor: col-resize` (computed style).
5. Read the initial width of `#project-sidebar` via `offsetWidth`.
6. Perform a Playwright mouse drag on `#sidebar-resize`: mousedown at center, mousemove rightward by 80px, mouseup.
7. Read the new width of `#project-sidebar` via `offsetWidth`. Verify it increased by approximately 80px (within 10px tolerance).
8. Locate `#resize-sessions` element. Verify it exists.
9. Read the initial height of `#sessions-area` via `offsetHeight`.
10. Perform a Playwright mouse drag on `#resize-sessions`: mousedown at center, mousemove downward by 60px, mouseup.
11. Read the new height of `#sessions-area` via `offsetHeight`. Verify it increased by approximately 60px (within 10px tolerance).
12. Verify that `#terminals-area` is still visible and has height >= 100px (the CSS min-height floor).

**Pass condition:** Both resize handles respond to drag. Sidebar width increases when dragged right. Sessions area height increases when dragged down. Terminals area remains visible.

**Fail signal:** Sidebar width unchanged after drag (handle is dead -- the pre-implementation state). Sessions area height unchanged after drag. The pre-implementation codebase renders these handles but has no JavaScript attached.

**Test type:** Playwright browser

**Port:** 3304

---

### T-6: Adversarial -- splitPosition localStorage poisoned with out-of-range value

**Flow:**
1. Start server on port 3305.
2. Create a project and session via REST API.
3. Open browser. Before loading the app, set poisoned localStorage values: `page.evaluate(() => { localStorage.setItem('splitView', 'true'); localStorage.setItem('splitPosition', '5'); })`.
4. Reload the page. Wait for load.
5. Select the project, attach the session.
6. Wait for `#session-overlay` to appear.
7. Read the computed `left` of `#session-overlay`. Calculate what percentage of viewport width this represents.
8. Verify that the overlay left position is at 5% of viewport (the unclamped poisoned value).
9. This means the workspace has 95% margin-right and is nearly invisible.
10. Now drag the split handle: mousedown on `.split-resize-handle`, mousemove to 50% of viewport, mouseup.
11. Verify that after drag, `left` is now ~50% (self-corrected by the clamp in the drag handler).
12. Reload again. Verify position is now 50% (the corrected value was persisted).

**Pass condition:** The poisoned value of 5% IS applied on load (confirming the review finding that `readSplitPosition` does not clamp). After one drag interaction, the value self-corrects to a valid range. This test documents the gap and verifies the self-healing behavior.

**Fail signal:** If the implementation silently clamps on read (contradicting the review finding), the initial position would not be 5% -- the test still passes but the gap was already fixed. If the drag does NOT clamp (the 20-85% guard is missing), the test fails because the self-correction mechanism is broken.

**Test type:** Playwright browser

**Port:** 3305
