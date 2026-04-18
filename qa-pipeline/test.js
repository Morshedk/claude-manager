/**
 * QA Pipeline — bug: session-log-formatting
 *
 * Unit test for lib/utils/stripAnsi.js
 *
 * Tests 3 and 4 FAIL on current broken code (bare \r deleted instead of
 * treated as a line boundary), PASS after the correct fix.
 *
 * Run with:  node qa-pipeline/test.js
 * Exit 0 → all PASS, Exit 1 → at least one FAIL
 */

import { stripAnsi } from '../lib/utils/stripAnsi.js';
import assert from 'assert';

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

// Test 1: cursor-forward \x1b[1C between tokens produces a space
// (cursor-forward fix already in place — this is a regression guard)
test('\\x1b[1C between tokens produces a space', () => {
  const input = '\x1b[38;5;114m\u25cf\x1b[1C\x1b[39m\x1b[1mBash\x1b[22m\x1b[1C(git\x1b[1Ccheckout\x1b[1Cbeta)\r\r\n';
  const output = stripAnsi(input);
  assert.doesNotMatch(output, /\x1b/, 'raw \\x1b still present in output');
  assert.match(output, /Bash \(git/,    'space missing between "Bash" and "(git"');
  assert.match(output, /git checkout/,  'space missing between "git" and "checkout"');
  assert.match(output, /checkout beta/, 'space missing between "checkout" and "beta"');
});

// Test 2: cursor-forward \x1b[5C produces 5 leading spaces
// (regression guard)
test('\\x1b[5C produces 5 leading spaces', () => {
  const input = '\x1b[5CnStore.save()\x1b[1Cprevents\r\r\n';
  const output = stripAnsi(input);
  assert.doesNotMatch(output, /\x1b/, 'raw \\x1b still present in output');
  assert.ok(
    output.startsWith('     '),
    `expected 5 leading spaces, got: "${output.slice(0, 15).replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
  );
  assert.match(output, /nStore\.save\(\) prevents/, 'spacing wrong in "nStore.save() prevents"');
});

// Test 3: bare \r must not merge adjacent lines — THE CORE BUG
//
// From spec Preliminary Investigation:
//   stripAnsi("line1\r\rline2\r\r\n") currently returns "line1line2\n"
//   Expected: lines appear separately (not merged into one string)
//
// THIS TEST FAILS ON CURRENT CODE.
test('bare \\r does not merge adjacent lines (core spec regression)', () => {
  const input = 'line1\r\rline2\r\r\n';
  const output = stripAnsi(input);
  assert.ok(
    !output.includes('line1line2'),
    `lines were concatenated: got "${output.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}" — must not be merged`
  );
  const lines = output.split('\n').filter(l => l.length > 0);
  assert.ok(lines.some(l => l.includes('line1')), `"line1" not found as its own line in: ${JSON.stringify(lines)}`);
  assert.ok(lines.some(l => l.includes('line2')), `"line2" not found as its own line in: ${JSON.stringify(lines)}`);
});

// Test 4: spinner-pattern \r overwrite must not concatenate output
//
// Claude Code uses bare \r to overwrite the current line (spinners, progress).
// Deleting \r merges the original and the overwrite into one string.
//
// THIS TEST FAILS ON CURRENT CODE.
test('spinner-pattern \\r overwrite does not concatenate lines', () => {
  const input = 'Running...\rDone      \r\n';
  const output = stripAnsi(input);
  assert.doesNotMatch(output, /\x1b/, 'raw \\x1b still present in output');
  assert.ok(
    !output.includes('Running...Done'),
    `overwrites were concatenated: got "${output.replace(/\n/g, '\\n').replace(/\r/g, '\\r')}" — must not merge`
  );
});

// Test 5: no raw escape codes remain in output (regression guard)
test('no raw escape codes remain in output', () => {
  const input = [
    '\x1b[38;5;114mcolored text\x1b[0m',
    '\x1b]0;window title\x07',
    '\x1b(Bcharset',
    '\x1b=alt keypad',
    '\x1b[2J clear screen',
    '\x1b[3Acursor up 3',
  ].join('\n');
  const output = stripAnsi(input);
  assert.doesNotMatch(output, /\x1b/, `raw \\x1b found in output: ${JSON.stringify(output.slice(0, 120))}`);
  assert.match(output, /colored text/, '"colored text" was stripped along with escape codes');
  assert.match(output, /charset/,      '"charset" was stripped along with G-set escape');
  assert.match(output, /clear screen/, '"clear screen" was stripped along with CSI');
});

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
