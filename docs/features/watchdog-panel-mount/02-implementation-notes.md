# Implementation Notes: WatchdogPanel Mount

## Summary

Single-file change: `public/js/components/ProjectDetail.js`

## Changes Made

### Imports added (lines 2, 10)
- `import { useState } from 'preact/hooks';` — for local tab state
- `import { WatchdogPanel } from './WatchdogPanel.js';` — the panel component

### State added (line 18)
- `const [activeTab, setActiveTab] = useState('sessions');` — local tab state, defaults to 'sessions'

### Sessions area refactored
1. **Header**: "New Claude Session" button is conditionally rendered — only shown when `activeTab === 'sessions'`. Project name remains visible always.
2. **Tab bar** (new `div.sessions-tab-bar`): Two buttons — `Sessions` and `Watchdog`. The active tab gets accent background + black text; inactive tab is transparent with border.
   - Watchdog button has `id="watchdog-tab-btn"` for Playwright targeting.
3. **Body**: Conditional render:
   - `activeTab === 'sessions'`: renders `#project-sessions-list` with `SessionCard` components (unchanged behavior)
   - `activeTab === 'watchdog'`: renders `#watchdog-panel-container` containing `<WatchdogPanel />`

## Smoke Test Results

Verified by code inspection:
- All required imports present and correct
- `activeTab` state properly declared with `useState`
- `WatchdogPanel` component rendered inside `#watchdog-panel-container`
- `#watchdog-tab-btn` id present for test targeting
- `WatchdogPanel` accepts no props — correctly mounted without props
- `WatchdogPanel` itself imports `settings` from store and fetches `/api/watchdog/logs` with graceful error handling

## Pre-existing test suite state
- Unit tests in `tests/unit/ProjectStore.test.js` have 13 pre-existing failures (unrelated to this change — they involve `ProjectStore.create` logic)
- Our change is purely in the frontend component layer (no server code, no store, no lib changes)

## Files Modified
- `public/js/components/ProjectDetail.js` — added tab navigation and WatchdogPanel mount

## Files NOT Modified
- `public/js/components/WatchdogPanel.js` — unchanged (design decision: mount only, don't alter)
- `public/js/components/App.js` — unchanged
- `public/js/state/store.js` — unchanged (no new signals needed)
- All server files — unchanged
