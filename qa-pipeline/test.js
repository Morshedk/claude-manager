/**
 * QA Pipeline — bug: session-log-no-timestamps
 *
 * Tests that SessionLogManager.tailLog() returns timestamp/event markers
 * even when the log is dominated by spinner noise lines (blank OR non-blank).
 *
 * Tests 2, 3, and 4 FAIL on original broken code.
 * All tests PASS after the fix.
 *
 * Run with:  node qa-pipeline/test.js
 * Exit 0 → all PASS, Exit 1 → at least one FAIL
 */

import { SessionLogManager } from '../lib/sessionlog/SessionLogManager.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import assert from 'assert';

const tmpDir = join(tmpdir(), `qa-sessionlog-${Date.now()}`);
mkdirSync(join(tmpDir, 'sessionlog'), { recursive: true });

const SESSION_BLANK  = '00000000-0000-0000-0000-000000000001';
const SESSION_SPINNER = '00000000-0000-0000-0000-000000000002';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
    passed++;
  } catch (err) {
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message}`);
    failed++;
  }
}

// ── Scenario A: markers buried under BLANK lines ──────────────────────────────
// (original bug: 500-line tail was all blank)

const ts1 = '2026-04-18T10:00:00.000Z';
const ts2 = '2026-04-18T10:00:20.000Z';
const ts3 = '2026-04-18T10:00:40.000Z';

const blankLog =
  `\n=== PTY:ATTACH | ${ts1} | session attached ===\n` +
  `\n--- ${ts2} ---\n` +
  '\n'.repeat(600) +
  `\n--- ${ts3} ---\n` +
  '\n'.repeat(600);

writeFileSync(join(tmpDir, 'sessionlog', `${SESSION_BLANK}.log`), blankLog);

// ── Scenario B: markers buried under NON-BLANK spinner lines ─────────────────
// (second bug: spinner chars like ✢ ✶ ✻ are non-blank, still swamp the window)

const spinnerNoise = Array.from({ length: 600 }, (_, i) =>
  ['✢', '✶', '✻', '✽', '·', '●', '* Sketching…', '  Thinking…'][i % 8]
).join('\n');

const spinnerLog =
  `\n=== PTY:ATTACH | ${ts1} | session attached ===\n` +
  `\n--- ${ts2} ---\n` +
  spinnerNoise + '\n' +
  `\n--- ${ts3} ---\n` +
  spinnerNoise + '\n';

writeFileSync(join(tmpDir, 'sessionlog', `${SESSION_SPINNER}.log`), spinnerLog);

const mgr = new SessionLogManager({ dataDir: tmpDir });

// Test 1: tailLog returns an array
test('tailLog returns an array', () => {
  const tail = mgr.tailLog(SESSION_BLANK, 500);
  assert.ok(Array.isArray(tail), `expected array, got ${typeof tail}`);
});

// Test 2: timestamp visible when buried under BLANK lines
test('--- timestamp --- visible in tail when buried under blank lines', () => {
  const tail = mgr.tailLog(SESSION_BLANK, 500);
  const found = (tail || []).some(l => /^--- 2026-04-18T/.test(l.trim()));
  assert.ok(found,
    `No timestamp found. Tail (${(tail||[]).length} lines): ` +
    JSON.stringify((tail||[]).slice(0, 5)));
});

// Test 3: event marker visible when buried under BLANK lines
test('=== PTY:ATTACH === visible in tail when buried under blank lines', () => {
  const tail = mgr.tailLog(SESSION_BLANK, 500);
  const found = (tail || []).some(l => /^=== PTY:ATTACH \|/.test(l.trim()));
  assert.ok(found,
    `No PTY:ATTACH event found. Tail (${(tail||[]).length} lines): ` +
    JSON.stringify((tail||[]).slice(0, 5)));
});

// Test 4: timestamp visible when buried under NON-BLANK spinner lines
// This is the second failure mode: spinner chars like ✢ ✶ ✻ are non-blank
// and swamp the window even after blank-line filtering.
test('--- timestamp --- visible in tail when buried under spinner noise lines', () => {
  const tail = mgr.tailLog(SESSION_SPINNER, 500);
  const found = (tail || []).some(l => /^--- 2026-04-18T/.test(l.trim()));
  assert.ok(found,
    `No timestamp found in spinner-noise session. Tail (${(tail||[]).length} lines): ` +
    JSON.stringify((tail||[]).slice(0, 5)));
});

// Test 5: event marker visible when buried under NON-BLANK spinner lines
test('=== PTY:ATTACH === visible in tail when buried under spinner noise lines', () => {
  const tail = mgr.tailLog(SESSION_SPINNER, 500);
  const found = (tail || []).some(l => /^=== PTY:ATTACH \|/.test(l.trim()));
  assert.ok(found,
    `No PTY:ATTACH event found in spinner-noise session. Tail (${(tail||[]).length} lines): ` +
    JSON.stringify((tail||[]).slice(0, 5)));
});

// Cleanup
try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

// Summary
console.log('');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\n=== RESULT: FAIL ===');
  process.exit(1);
} else {
  console.log('\n=== RESULT: PASS ===');
  process.exit(0);
}
