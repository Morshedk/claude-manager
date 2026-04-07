import fs from 'fs';
import path from 'path';
import os from 'os';
import { SessionStore } from '../../lib/sessions/SessionStore.js';

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-store-test-'));
  store = new SessionStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========== load() ==========

describe('SessionStore - load()', () => {
  test('returns empty array when sessions.json does not exist', async () => {
    const result = await store.load();
    expect(result).toEqual([]);
  });

  test('parses sessions.json correctly', async () => {
    const sessions = [
      { id: 'abc', name: 'test-session', status: 'running' },
      { id: 'def', name: 'another', status: 'stopped' },
    ];
    fs.writeFileSync(store.sessionsFile, JSON.stringify(sessions, null, 2));
    const result = await store.load();
    expect(result).toEqual(sessions);
  });

  test('returns empty array when sessions.json is corrupted JSON', async () => {
    fs.writeFileSync(store.sessionsFile, '{ not valid json !!!');
    const result = await store.load();
    expect(result).toEqual([]);
  });

  test('returns empty array when sessions.json contains non-array JSON', async () => {
    fs.writeFileSync(store.sessionsFile, JSON.stringify({ id: 'foo' }));
    const result = await store.load();
    expect(result).toEqual([]);
  });

  test('creates directories if they do not exist when saving (and load still works)', async () => {
    const nestedDir = path.join(tmpDir, 'deep', 'nested');
    const nestedStore = new SessionStore(nestedDir);
    // No directory exists yet — save should create it
    await nestedStore.save([{ id: '123', status: 'running' }]);
    const result = await nestedStore.load();
    expect(result).toEqual([{ id: '123', status: 'running' }]);
  });
});

// ========== save() / load() round-trip ==========

describe('SessionStore - save() / load() round-trip', () => {
  test('save() writes to disk and load() reads it back', async () => {
    const sessions = [
      { id: 'sess-1', status: 'running', mode: 'direct' },
      { id: 'sess-2', status: 'stopped', mode: 'tmux' },
    ];
    await store.save(sessions);
    const loaded = await store.load();
    expect(loaded).toEqual(sessions);
  });

  test('save() accepts a Map and extracts .meta from each entry', async () => {
    const map = new Map([
      ['sess-a', { meta: { id: 'sess-a', status: 'running' }, pty: null }],
      ['sess-b', { meta: { id: 'sess-b', status: 'stopped' }, pty: null }],
    ]);
    await store.save(map);
    const loaded = await store.load();
    expect(loaded).toEqual([
      { id: 'sess-a', status: 'running' },
      { id: 'sess-b', status: 'stopped' },
    ]);
  });

  test('save() with empty array clears all sessions', async () => {
    await store.save([{ id: 'x', status: 'running' }]);
    await store.save([]);
    const loaded = await store.load();
    expect(loaded).toEqual([]);
  });
});

// ========== upsert() ==========

describe('SessionStore - upsert()', () => {
  test('adds a new session if id not present', async () => {
    await store.upsert({ id: 'new-1', status: 'running' });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: 'new-1', status: 'running' });
  });

  test('replaces an existing session with matching id', async () => {
    await store.save([{ id: 'sess-1', status: 'running' }]);
    await store.upsert({ id: 'sess-1', status: 'stopped' });
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].status).toBe('stopped');
  });
});

// ========== remove() ==========

describe('SessionStore - remove()', () => {
  test('removes the session with the given id', async () => {
    await store.save([
      { id: 'keep', status: 'running' },
      { id: 'gone', status: 'stopped' },
    ]);
    await store.remove('gone');
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('keep');
  });

  test('is a no-op when id does not exist', async () => {
    await store.save([{ id: 'only', status: 'running' }]);
    await store.remove('nonexistent');
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
  });
});

