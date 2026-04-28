// tests/unit/scheduling.test.js
import { DailyScheduler } from '../../lib/watchdog/scheduling.js';

describe('DailyScheduler', () => {
  test('shouldRun returns true when hour matches and not yet run today', () => {
    const sched = new DailyScheduler();
    const now = new Date('2026-04-28T02:15:00Z');
    expect(sched.shouldRun('audit', 2, now)).toBe(true);
  });

  test('shouldRun returns false when already run today', () => {
    const sched = new DailyScheduler();
    const now = new Date('2026-04-28T02:15:00Z');
    sched.markRun('audit', now);
    expect(sched.shouldRun('audit', 2, now)).toBe(false);
  });

  test('shouldRun returns false when hour has not arrived', () => {
    const sched = new DailyScheduler();
    const now = new Date('2026-04-28T01:30:00Z');
    expect(sched.shouldRun('audit', 2, now)).toBe(false);
  });

  test('shouldRun returns true on a new day', () => {
    const sched = new DailyScheduler();
    const yesterday = new Date('2026-04-27T02:15:00Z');
    sched.markRun('audit', yesterday);
    const today = new Date('2026-04-28T02:15:00Z');
    expect(sched.shouldRun('audit', 2, today)).toBe(true);
  });

  test('isWeeklyDay returns true on matching day', () => {
    const sched = new DailyScheduler();
    const friday = new Date('2026-05-01T02:00:00Z'); // Friday
    expect(sched.isWeeklyDay('friday', friday)).toBe(true);
    expect(sched.isWeeklyDay('monday', friday)).toBe(false);
  });

  test('getState/loadState round-trips', () => {
    const sched = new DailyScheduler();
    sched.markRun('audit', new Date('2026-04-28T02:00:00Z'));
    sched.markRun('pm', new Date('2026-04-28T04:00:00Z'));
    const state = sched.getState();
    const sched2 = new DailyScheduler();
    sched2.loadState(state);
    expect(sched2.shouldRun('audit', 2, new Date('2026-04-28T02:30:00Z'))).toBe(false);
    expect(sched2.shouldRun('pm', 4, new Date('2026-04-28T04:30:00Z'))).toBe(false);
  });
});
