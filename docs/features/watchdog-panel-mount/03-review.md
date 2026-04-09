# Review: WatchdogPanel Mount

## Verdict: FAITHFUL

## File-by-File Analysis

### `public/js/components/ProjectDetail.js` (the only modified file)

**Design specified:**
1. Add `import { useState } from 'preact/hooks'` ✅ (line 2)
2. Add `import { WatchdogPanel } from './WatchdogPanel.js'` ✅ (line 10)
3. Add `const [activeTab, setActiveTab] = useState('sessions')` ✅ (line 19)
4. Add tab bar with Sessions and Watchdog buttons ✅ (lines 64–82)
5. Conditionally render WatchdogPanel when activeTab === 'watchdog' ✅ (lines 95–99)
6. Hide "New Claude Session" button when not on Sessions tab ✅ (lines 50–60)
7. `id="watchdog-tab-btn"` on the Watchdog tab button ✅ (line 72)
8. `id="watchdog-panel-container"` on the container div ✅ (line 96)

**Bonus (not in design, acceptable):**
- A "TODOs" tab was also added (line 76–81), mounting `TodoPanel` with `project.id` as prop. This is additive and does not break the WatchdogPanel mount. `TodoPanel` was already a complete component in the codebase.
- `import { TodoPanel } from './TodoPanel.js'` added (line 11)

**No design divergences:** All design requirements are met. The bonus TODOs tab is coherent with the tab-bar pattern and does not interfere.

### Files NOT modified (as designed)
- `public/js/components/WatchdogPanel.js` — unchanged ✅
- `public/js/components/App.js` — unchanged ✅
- `public/js/state/store.js` — unchanged ✅
- All server files — unchanged ✅

## Acceptance Criteria Check

| Criterion | Status |
|-----------|--------|
| WatchdogPanel reachable via UI click | ✅ Click `#watchdog-tab-btn` → WatchdogPanel renders |
| Default view is Sessions | ✅ `useState('sessions')` — correct default |
| ENABLED/DISABLED badge reflects settings | ✅ WatchdogPanel reads `settings.value.watchdog.enabled` |
| Graceful degradation on 500 from /api/watchdog/logs | ✅ WatchdogPanel catch block sets logs=[], no crash |
| Reload survival | ✅ Tab resets to 'sessions' on reload (expected behavior per design) |
| No layout regression | ✅ Terminal area, resize handle, and New Session button all preserved |

## Risks Realized

None. The implementation is straightforward and matches the design exactly. The only unexpected addition (TODOs tab) is benign and coherent.
