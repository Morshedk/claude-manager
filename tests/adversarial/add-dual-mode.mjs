#!/usr/bin/env node
/**
 * Transforms single-mode (direct) Playwright E2E tests to run with both 'direct' and 'tmux' modes.
 *
 * Strategy:
 * - Replaces `const PORT = X;` with PORTS/MODES definition + `for (const MODE of MODES) {`
 * - Everything after PORT (module-level helpers, BASE_URL, SCREENSHOTS_DIR, test.describe)
 *   moves inside the for loop, closing over the loop-scoped PORT
 * - Appends `} // end for (const MODE of MODES)` at end of file
 * - Renames SCREENSHOTS_DIR to use template literal with MODE suffix
 * - Updates test.describe title to include [${MODE}]
 * - Replaces mode: 'direct' with mode: MODE
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Tests to skip
const SKIP = new Set([
  'T-03-refresh-artifacts.test.js',          // tmux preserves scrollback across refresh by design; test only valid for direct mode
  'T-08-bad-project-path.test.js',           // top-level test() calls outside describe — dual-mode causes title collisions
  'T-12-tmux-survives-close.test.js',        // inherently tmux-only
  'T-30-tmux-pid-unchanged.test.js',         // inherently tmux-only
  'T-17-server-restart-recovery.test.js',    // already tests both in one describe
  'T-52-session-switch-no-garble.test.js',   // already done
]);

function transform(filePath) {
  const fileName = path.basename(filePath);

  if (SKIP.has(fileName)) {
    console.log(`  SKIP     ${fileName}`);
    return;
  }

  let src = fs.readFileSync(filePath, 'utf8');

  // Already transformed?
  if (src.includes('const MODES =') || src.includes('for (const MODE of MODES)')) {
    console.log(`  ALREADY  ${fileName}`);
    return;
  }

  // Only transform Playwright tests
  if (!src.includes("from 'playwright/test'")) {
    console.log(`  NOT_PW   ${fileName}`);
    return;
  }

  // Find `const PORT = XXXX;`
  const portMatch = src.match(/^const PORT = (\d+);/m);
  if (!portMatch) {
    console.log(`  NO_PORT  ${fileName}`);
    return;
  }

  const directPort = parseInt(portMatch[1], 10);
  const tmuxP = directPort + 600;

  // 1. Replace `const PORT = X;` → PORTS/MODES + for loop opening + new PORT
  src = src.replace(
    /^const PORT = \d+;/m,
    `const PORTS = { direct: ${directPort}, tmux: ${tmuxP} };\nconst MODES = ['direct', 'tmux'];\n\nfor (const MODE of MODES) {\nconst PORT = PORTS[MODE];`
  );

  // 2. Rename SCREENSHOTS_DIR to use template literal with MODE suffix
  //    Pattern: const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', 'some-name');
  src = src.replace(
    /const SCREENSHOTS_DIR = path\.join\(APP_DIR, 'qa-screenshots', '([^']+)'\);/,
    "const SCREENSHOTS_DIR = path.join(APP_DIR, 'qa-screenshots', `$1-${MODE}`);"
  );

  // 3. Update test.describe title to include [${MODE}] — single-quoted
  src = src.replace(
    /^(test\.describe\()('T-[^']+')(\s*,)/m,
    (_, open, title, comma) => `${open}\`${title.slice(1, -1)} [\${MODE}]\`${comma}`
  );
  // Double-quoted variant
  src = src.replace(
    /^(test\.describe\()("T-[^"]+")(\s*,)/m,
    (_, open, title, comma) => `${open}\`${title.slice(1, -1)} [\${MODE}]\`${comma}`
  );

  // 4. Replace mode: 'direct' with mode: MODE
  src = src.replace(/\bmode: 'direct'/g, 'mode: MODE');

  // 5. Close the for loop at end of file
  src = src.trimEnd() + '\n} // end for (const MODE of MODES)\n';

  fs.writeFileSync(filePath, src, 'utf8');
  console.log(`  DONE     ${fileName}  (direct:${directPort} tmux:${tmuxP})`);
}

// Run on all T-series test files
const testDir = __dirname;
const files = fs.readdirSync(testDir)
  .filter(f => /^T-\d{2}-.*\.test\.js$/.test(f))
  .sort();

for (const f of files) {
  transform(path.join(testDir, f));
}

console.log('\nDone.');
