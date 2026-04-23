/**
 * T-8: cardSummary || name || '' precedence — cardSummary wins over name (H1)
 * Port: 3368 (reserved, no server binds it)
 * Type: Direct Node import of WatchdogManager (isolated, no HTTP/WS stack)
 *
 * Pass condition:
 *   - logSessionLifecycle called with session.cardSummary='my-card-summary' and
 *     session.name='my-name'
 *   - lifecycle entry has summary === 'my-card-summary' (not 'my-name')
 *
 * Defect this catches:
 *   A reversed implementation (name || cardSummary || '') would produce
 *   summary='my-name' and fail this assertion.
 */

import { test, expect } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';

const APP_DIR = '/home/claude-runner/apps/claude-web-app-v2';
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('T-8: cardSummary takes precedence over name in lifecycle log summary', async () => {
  const dataDir = `/tmp/qa-T8-cardsummary-${Date.now()}`;
  mkdirSync(dataDir, { recursive: true });

  try {
    const wmUrl = pathToFileURL(join(APP_DIR, 'lib/watchdog/WatchdogManager.js')).href;
    const { WatchdogManager } = await import(wmUrl);

    const watchdog = new WatchdogManager({ dataDir });
    watchdog.on('error', (err) => {
      console.error(`  [T-8] WatchdogManager error event: ${err.message}`);
    });

    // Call with both cardSummary and name populated — cardSummary must win
    watchdog.logSessionLifecycle({
      event: 'created',
      session: {
        id: 'session-t8',
        name: 'my-name',
        cardSummary: 'my-card-summary',
        tmuxName: null,
        claudeSessionId: 'claude-t8-uuid',
        projectId: 'proj-t8',
        projectName: 'T8-Project',
        telegramEnabled: false,
      },
      channelId: null,
    });

    // Drain write chain
    await watchdog._lifecycleWriteChain;
    await sleep(200);

    const lifecycleFile = join(dataDir, 'session-lifecycle.json');
    expect(existsSync(lifecycleFile)).toBe(true);

    let log;
    try {
      const raw = readFileSync(lifecycleFile, 'utf8');
      log = JSON.parse(raw);
    } catch (e) {
      throw new Error(`session-lifecycle.json failed to parse: ${e.message}`);
    }

    expect(log.length).toBe(1);

    const entry = log[0];
    console.log(`  [T-8] Entry: ${JSON.stringify(entry)}`);

    // Primary assertion: cardSummary wins over name
    expect(entry.summary).toBe('my-card-summary'); // 'cardSummary must take precedence over name'

    // Confirm name was NOT used (falsifies the reversed implementation)
    expect(entry.summary).not.toBe('my-name');

    // Other fields correct
    expect(entry.event).toBe('created');
    expect(entry.sessionId).toBe('session-t8');
    expect(entry.channelId).toBeNull();

    console.log('\n  [T-8] PASSED — cardSummary takes precedence over name in lifecycle log');

  } finally {
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}, 15000);
