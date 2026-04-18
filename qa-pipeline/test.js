/**
 * QA Pipeline — bug: session-log-no-timestamps
 *
 * Tests that SessionLogManager.tailLog() returns timestamp/event markers
 * even when the log is dominated by blank spinner lines.
 *
 * Tests 2 and 3 FAIL on current broken code (500-line hard tail swamps
 * markers), PASS after the correct fix.
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

const SESSION_ID = '00000000-0000-0000-0000-000000000001';

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

// Build a synthetic .log file that mirrors an active Claude Code session:
//
//   Line 1:   (empty — injectEvent leading newline)
//   Line 2:   === PTY:ATTACH | ts1 | session attached ===
//   Line 3:   (empty)
//   Line 4:   --- ts2 ---          ← tick 1 timestamp marker
//   Lines 5-604: 600 blank lines  ← simulated spinner output from tick 1
//   Line 605: --- ts3 ---          ← tick 2 timestamp marker
//   Lines 606-1205: 600 blank lines ← simulated spinner output from tick 2
//
// Total: ~1205 lines. Last marker (ts3) is at line 605 — 600 lines before EOF.
// tailLog(id, 500) on CURRENT code slices the last 500 lines (all blank) → markers invisible.
// The fix must ensure markers survive into the returned window.

const ts1 = '2026-04-18T10:00:00.000Z';
const ts2 = '2026-04-18T10:00:20.000Z';
const ts3 = '2026-04-18T10:00:40.000Z';

const blankBatch = '\n'.repeat(600);

const logContent =
  `\n=== PTY:ATTACH | ${ts1} | session attached ===\n` +
  `\n--- ${ts2} ---\n` +
  blankBatch +
  `\n--- ${ts3} ---\n` +
  blankBatch;

writeFileSync(join(tmpDir, 'sessionlog', `${SESSION_ID}.log`), logContent);

const manager = new SessionLogManager({ dataDir: tmpDir });
const tail = manager.tailLog(SESSION_ID, 500);

// Test 1: tailLog returns an array (infrastructure check)
test('tailLog returns an array', () => {
  assert.ok(Array.isArray(tail), `expected array, got ${typeof tail}: ${JSON.stringify(tail)}`);
});

// Test 2: timestamp marker visible in tail — THIS FAILS ON CURRENT CODE
//
// Current behavior: last 600 blank lines fill the 500-line window; markers are
// >600 lines before EOF and invisible. Fix must surface them.
test('at least one --- timestamp --- line visible in 500-line tail (spec Then clause)', () => {
  const found = (tail || []).some(l => /^--- 2026-04-18T/.test(l.trim()));
  const nonBlank = (tail || []).filter(l => l.trim()).length;
  assert.ok(
    found,
    `No "--- 2026-04-18T..." timestamp found in tail.\n` +
    `  Tail length: ${(tail || []).length}, non-blank lines: ${nonBlank}.\n` +
    `  First non-blank line: ${(tail || []).find(l => l.trim()) || '(none)'}\n` +
    `  This test FAILS on current code because the 500-line tail is entirely blank.`
  );
});

// Test 3: PTY:ATTACH event marker visible in tail — THIS FAILS ON CURRENT CODE
//
// Same root cause: PTY:ATTACH is injected near the top of the log, >600 lines
// before EOF after two ticks of spinner output. Invisible in a 500-line tail.
test('at least one === PTY:ATTACH === event line visible in 500-line tail (spec Then clause)', () => {
  const found = (tail || []).some(l => /^=== PTY:ATTACH \|/.test(l.trim()));
  const nonBlank = (tail || []).filter(l => l.trim()).length;
  assert.ok(
    found,
    `No "=== PTY:ATTACH |..." event found in tail.\n` +
    `  Tail length: ${(tail || []).length}, non-blank lines: ${nonBlank}.\n` +
    `  This test FAILS on current code because the 500-line tail is entirely blank.`
  );
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
