/**
 * T-6: 500-entry cap enforced (Risk 7)
 * Port: 3365 (reserved, no server binds it)
 * Type: Direct Node import of WatchdogManager (isolated, no HTTP/WS stack)
 *
 * Pass condition:
 *   - After 520 sequential logSessionLifecycle calls, array length === 500
 *   - Oldest 20 events evicted (first entry is event #21)
 *   - Last entry is event #520
 *   - JSON parses without error
 */

import { test, expect } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('T-6: 500-entry cap enforced after 520 lifecycle calls', async () => {
  const dataDir = `/tmp/qa-T6-cap-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  try {
    // Dynamically import WatchdogManager from the v2 app
    const wmUrl = pathToFileURL(join(APP_DIR, 'lib/watchdog/WatchdogManager.js')).href;
    const { WatchdogManager } = await import(wmUrl);

    const watchdog = new WatchdogManager({ dataDir });
    // Attach error listener to prevent any stray emit('error') from crashing the test
    watchdog.on('error', (err) => {
      console.error(`  [T-6] WatchdogManager error event: ${err.message}`);
    });

    const TOTAL_EVENTS = 520;
    console.log(`  [T-6] Writing ${TOTAL_EVENTS} lifecycle entries...`);

    // Write 520 entries sequentially — all queue behind _lifecycleWriteChain
    for (let i = 1; i <= TOTAL_EVENTS; i++) {
      const event = i % 2 === 1 ? 'created' : 'deleted';
      watchdog.logSessionLifecycle({
        event,
        session: {
          id: `session-${i}`,
          name: `session-${i}`,
          cardSummary: null,
          tmuxName: null,
          claudeSessionId: `claude-${i}`,
          projectId: 'proj-t6',
          projectName: 'T6-Project',
          telegramEnabled: false,
        },
        channelId: null,
      });
    }

    // Wait for the write chain to drain
    await watchdog._lifecycleWriteChain;
    // Extra margin for any async flush
    await sleep(500);

    console.log(`  [T-6] Write chain drained`);

    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    expect(existsSync(lifecycleFile)).toBe(true); // 'session-lifecycle.json must exist after 520 writes'

    // Assert JSON parses without error
    let log;
    try {
      const raw = readFileSync(lifecycleFile, 'utf8');
      log = JSON.parse(raw);
    } catch (e) {
      throw new Error(`session-lifecycle.json failed to parse: ${e.message}`);
    }

    console.log(`  [T-6] Log length: ${log.length}`);

    // Length exactly 500
    expect(log.length).toBe(500); // 'Log must be capped at exactly 500 entries'

    // First entry should be event #21 (events 1-20 evicted)
    expect(log[0].sessionId).toBe('session-21'); // 'First entry should be session-21 (events 1-20 evicted)'

    // Last entry should be event #520
    expect(log[499].sessionId).toBe('session-520'); // 'Last entry should be session-520'

    // Spot check IDs
    const firstId = parseInt(log[0].sessionId.replace('session-', ''));
    const lastId = parseInt(log[499].sessionId.replace('session-', ''));
    console.log(`  [T-6] First session id: ${firstId}, last: ${lastId}`);
    expect(firstId).toBe(21); // 'First evicted range must start at 21'
    expect(lastId).toBe(520); // 'Last entry must be event 520'

    console.log('\n  [T-6] PASSED — 500-entry cap enforced, oldest 20 evicted, JSON valid');

  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 30000);
