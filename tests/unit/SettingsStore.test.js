import { jest } from '@jest/globals';
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Dynamic import so we can use a fresh instance per test
let SettingsStore, DEFAULTS, MODEL_IDS;
beforeAll(async () => {
  ({ SettingsStore, DEFAULTS, MODEL_IDS } = await import('../../lib/settings/SettingsStore.js'));
});

let tmpDir;
let storePath;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'settings-test-'));
  storePath = join(tmpDir, 'settings.json');
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ─── helpers ───────────────────────────────────────────────────────────────

function makeStore() {
  return new SettingsStore({ filePath: storePath });
}

// ─── load() ────────────────────────────────────────────────────────────────

describe('load()', () => {
  test('returns defaults when file does not exist', async () => {
    const store = makeStore();
    const result = await store.load();
    expect(result).toMatchObject(DEFAULTS);
  });

  test('merges persisted values over defaults', async () => {
    await writeFile(storePath, JSON.stringify({ theme: 'light', fontSize: 18 }));
    const store = makeStore();
    const result = await store.load();
    expect(result.theme).toBe('light');
    expect(result.fontSize).toBe(18);
    // defaults preserved for untouched keys
    expect(result.bellEnabled).toBe(DEFAULTS.bellEnabled);
    expect(result.session).toMatchObject(DEFAULTS.session);
  });

  test('merges nested section overrides', async () => {
    await writeFile(storePath, JSON.stringify({
      session: { defaultModel: 'opus' },
    }));
    const store = makeStore();
    const result = await store.load();
    expect(result.session.defaultModel).toBe('opus');
    // other nested keys unchanged
    expect(result.session.extendedThinking).toBe(DEFAULTS.session.extendedThinking);
  });

  test('falls back to defaults on corrupt JSON', async () => {
    await writeFile(storePath, 'not-json{{{');
    const store = makeStore();
    const result = await store.load();
    expect(result).toMatchObject(DEFAULTS);
  });

  test('does not bleed unknown keys from disk into settings', async () => {
    await writeFile(storePath, JSON.stringify({ unknownKey: 'sneaky' }));
    const store = makeStore();
    const result = await store.load();
    expect(result).not.toHaveProperty('unknownKey');
  });
});

// ─── getAll() ──────────────────────────────────────────────────────────────

describe('getAll()', () => {
  test('lazy-loads on first call', async () => {
    const store = makeStore();
    const result = await store.getAll();
    expect(result).toMatchObject(DEFAULTS);
  });

  test('returns a deep copy (mutation does not affect store)', async () => {
    const store = makeStore();
    const a = await store.getAll();
    a.theme = 'hacked';
    a.session.defaultModel = 'hacked';
    const b = await store.getAll();
    expect(b.theme).toBe(DEFAULTS.theme);
    expect(b.session.defaultModel).toBe(DEFAULTS.session.defaultModel);
  });
});

// ─── get(key) ──────────────────────────────────────────────────────────────

describe('get(key)', () => {
  test('returns value for a top-level scalar key', async () => {
    const store = makeStore();
    expect(await store.get('theme')).toBe(DEFAULTS.theme);
  });

  test('returns deep copy of a nested section', async () => {
    const store = makeStore();
    const session = await store.get('session');
    session.defaultModel = 'hacked';
    expect((await store.get('session')).defaultModel).toBe(DEFAULTS.session.defaultModel);
  });

  test('returns undefined for missing key', async () => {
    const store = makeStore();
    expect(await store.get('nonExistentKey')).toBeUndefined();
  });
});

// ─── set() / update() ──────────────────────────────────────────────────────

describe('set() and update()', () => {
  test('set() merges partial flat update', async () => {
    const store = makeStore();
    const result = await store.set({ theme: 'light' });
    expect(result.theme).toBe('light');
    expect(result.fontSize).toBe(DEFAULTS.fontSize);
  });

  test('set() merges partial nested update', async () => {
    const store = makeStore();
    await store.set({ session: { defaultModel: 'haiku' } });
    const s = await store.get('session');
    expect(s.defaultModel).toBe('haiku');
    expect(s.extendedThinking).toBe(DEFAULTS.session.extendedThinking);
  });

  test('set() persists to disk', async () => {
    const store = makeStore();
    await store.set({ theme: 'light' });
    const raw = JSON.parse(await readFile(storePath, 'utf8'));
    expect(raw.theme).toBe('light');
  });

  test('update() is an alias for set()', async () => {
    const store = makeStore();
    const result = await store.update({ fontSize: 20 });
    expect(result.fontSize).toBe(20);
  });

  test('second store reads changes saved by first', async () => {
    const store1 = makeStore();
    await store1.set({ theme: 'light' });

    const store2 = makeStore();
    expect((await store2.getAll()).theme).toBe('light');
  });
});

// ─── save() ────────────────────────────────────────────────────────────────

describe('save()', () => {
  test('creates the directory if missing', async () => {
    const deepPath = join(tmpDir, 'nested', 'deep', 'settings.json');
    const store = new SettingsStore({ filePath: deepPath });
    await store.save();
    const raw = JSON.parse(await readFile(deepPath, 'utf8'));
    expect(raw).toMatchObject(DEFAULTS);
  });
});

// ─── reset() ───────────────────────────────────────────────────────────────

describe('reset()', () => {
  test('restores defaults after changes', async () => {
    const store = makeStore();
    await store.set({ theme: 'light', fontSize: 99 });
    const result = await store.reset();
    expect(result.theme).toBe(DEFAULTS.theme);
    expect(result.fontSize).toBe(DEFAULTS.fontSize);
  });

  test('persists defaults to disk', async () => {
    const store = makeStore();
    await store.set({ theme: 'light' });
    await store.reset();
    const raw = JSON.parse(await readFile(storePath, 'utf8'));
    expect(raw.theme).toBe(DEFAULTS.theme);
  });
});

// ─── getEffectiveSessionSettings() ─────────────────────────────────────────

describe('getEffectiveSessionSettings()', () => {
  test('returns session defaults normally', async () => {
    const store = makeStore();
    const eff = await store.getEffectiveSessionSettings();
    expect(eff.defaultModel).toBe(DEFAULTS.session.defaultModel);
    expect(eff.defaultMode).toBe(DEFAULTS.session.defaultMode);
  });

  test('returns lowCredit settings when enabled+active', async () => {
    const store = makeStore();
    await store.set({
      lowCredit: { enabled: true, active: true, defaultModel: 'haiku' },
    });
    const eff = await store.getEffectiveSessionSettings();
    expect(eff.defaultModel).toBe('haiku');
  });

  test('does NOT use lowCredit when enabled=false', async () => {
    const store = makeStore();
    await store.set({
      lowCredit: { enabled: false, active: true, defaultModel: 'haiku' },
    });
    const eff = await store.getEffectiveSessionSettings();
    expect(eff.defaultModel).toBe(DEFAULTS.session.defaultModel);
  });

  test('does NOT use lowCredit when active=false', async () => {
    const store = makeStore();
    await store.set({
      lowCredit: { enabled: true, active: false, defaultModel: 'haiku' },
    });
    const eff = await store.getEffectiveSessionSettings();
    expect(eff.defaultModel).toBe(DEFAULTS.session.defaultModel);
  });
});

// ─── buildCommand() ────────────────────────────────────────────────────────

describe('buildCommand()', () => {
  test('builds basic command with default model', async () => {
    const store = makeStore();
    const cmd = await store.buildCommand();
    expect(cmd).toContain('claude');
    expect(cmd).toContain(`--model ${MODEL_IDS[DEFAULTS.session.defaultModel]}`);
  });

  test('respects model override', async () => {
    const store = makeStore();
    const cmd = await store.buildCommand({ model: 'haiku' });
    expect(cmd).toContain(`--model ${MODEL_IDS.haiku}`);
  });

  test('adds --effort max for extendedThinking', async () => {
    const store = makeStore();
    const cmd = await store.buildCommand({ extendedThinking: true });
    expect(cmd).toContain('--effort max');
  });

  test('does not add --effort max by default', async () => {
    const store = makeStore();
    const cmd = await store.buildCommand();
    expect(cmd).not.toContain('--effort');
  });

  test('appends extra flags', async () => {
    const store = makeStore();
    const cmd = await store.buildCommand({ flags: '--dangerously-skip-permissions' });
    expect(cmd).toContain('--dangerously-skip-permissions');
  });
});

// ─── buildWatchdogCommand() ────────────────────────────────────────────────

describe('buildWatchdogCommand()', () => {
  test('builds command with watchdog default model', async () => {
    const store = makeStore();
    const cmd = await store.buildWatchdogCommand();
    expect(cmd).toContain(`--model ${MODEL_IDS[DEFAULTS.watchdog.defaultModel]}`);
  });

  test('uses lowCredit model when lowCredit enabled+active', async () => {
    const store = makeStore();
    await store.set({ lowCredit: { enabled: true, active: true, defaultModel: 'haiku' } });
    const cmd = await store.buildWatchdogCommand();
    expect(cmd).toContain(`--model ${MODEL_IDS.haiku}`);
  });
});

// ─── auditor & pm defaults ────────────────────────────────────────────────

describe('auditor and pm defaults', () => {
  test('auditor defaults exist with correct shape', async () => {
    const settings = new SettingsStore({ filePath: join(tmpDir, 'settings.json') });
    const auditor = await settings.get('auditor');
    expect(auditor).toEqual({
      enabled: true,
      dailyHourUTC: 2,
      weeklyDay: 'friday',
      lookbackDays: 14,
      projects: [],
    });
  });

  test('pm defaults exist with correct shape', async () => {
    const settings = new SettingsStore({ filePath: join(tmpDir, 'settings.json') });
    const pm = await settings.get('pm');
    expect(pm).toEqual({
      enabled: true,
      dailyHourUTC: 4,
      sprintSize: 5,
      projects: [],
    });
  });

  test('auditor settings can be updated via set()', async () => {
    const settings = new SettingsStore({ filePath: join(tmpDir, 'settings.json') });
    await settings.set({ auditor: { dailyHourUTC: 3 } });
    const auditor = await settings.get('auditor');
    expect(auditor.dailyHourUTC).toBe(3);
    expect(auditor.enabled).toBe(true);
  });
});

// ─── isFeatureEnabled() ────────────────────────────────────────────────────

describe('isFeatureEnabled()', () => {
  test('returns true for enabled features', async () => {
    const store = makeStore();
    expect(await store.isFeatureEnabled('todoRewards')).toBe(true);
  });

  test('returns true for unknown features (fail-open)', async () => {
    const store = makeStore();
    expect(await store.isFeatureEnabled('unknownFeature')).toBe(true);
  });

  test('returns false when feature is explicitly disabled', async () => {
    const store = makeStore();
    await store.set({ features: { todoRewards: false } });
    expect(await store.isFeatureEnabled('todoRewards')).toBe(false);
  });
});
