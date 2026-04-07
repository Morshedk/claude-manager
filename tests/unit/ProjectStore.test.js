import fs from 'fs';
import path from 'path';
import os from 'os';
import { ProjectStore } from '../../lib/projects/ProjectStore.js';

let tmpDir;
let store;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proj-test-'));
  store = new ProjectStore(path.join(tmpDir, 'projects.json'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========== Project CRUD ==========

describe('ProjectStore - Projects', () => {
  test('starts with empty project list', () => {
    expect(store.list()).toEqual([]);
  });

  test('creates a project with required fields', () => {
    const p = store.create({ name: 'MyApp', path: '/home/user/app' });
    expect(p).toMatchObject({ name: 'MyApp', path: '/home/user/app' });
    expect(p.id).toBeDefined();
    expect(p.createdAt).toBeDefined();
    expect(p.quickCommands).toEqual([]);
  });

  test('creates a project with quickCommands', () => {
    const p = store.create({ name: 'App', path: '/tmp', quickCommands: ['npm test'] });
    expect(p.quickCommands).toEqual(['npm test']);
  });

  test('throws when name is missing', () => {
    expect(() => store.create({ path: '/tmp' })).toThrow('Name and path are required');
  });

  test('throws when path is missing', () => {
    expect(() => store.create({ name: 'App' })).toThrow('Name and path are required');
  });

  test('throws when both name and path are missing', () => {
    expect(() => store.create({})).toThrow('Name and path are required');
  });

  test('get returns project by id', () => {
    const p = store.create({ name: 'App', path: '/tmp' });
    expect(store.get(p.id)).toMatchObject({ name: 'App' });
  });

  test('get returns undefined for nonexistent id', () => {
    expect(store.get('nonexistent')).toBeUndefined();
  });

  test('list returns all projects', () => {
    store.create({ name: 'A', path: '/a' });
    store.create({ name: 'B', path: '/b' });
    expect(store.list()).toHaveLength(2);
  });

  test('update changes allowed fields', () => {
    const p = store.create({ name: 'Old', path: '/old' });
    const updated = store.update(p.id, { name: 'New', path: '/new' });
    expect(updated.name).toBe('New');
    expect(updated.path).toBe('/new');
    expect(updated.updatedAt).toBeDefined();
  });

  test('update ignores non-allowed fields', () => {
    const p = store.create({ name: 'App', path: '/tmp' });
    const updated = store.update(p.id, { name: 'App2', hackedField: 'evil' });
    expect(updated.hackedField).toBeUndefined();
  });

  test('update throws for nonexistent id', () => {
    expect(() => store.update('bad-id', { name: 'X' })).toThrow('Project not found');
  });

  test('remove deletes a project', () => {
    const p = store.create({ name: 'App', path: '/tmp' });
    store.remove(p.id);
    expect(store.list()).toHaveLength(0);
  });

  test('remove throws for nonexistent id', () => {
    expect(() => store.remove('bad-id')).toThrow('Project not found');
  });

  test('unique IDs for multiple projects', () => {
    const a = store.create({ name: 'A', path: '/a' });
    const b = store.create({ name: 'B', path: '/b' });
    expect(a.id).not.toBe(b.id);
  });
});

// ========== Scratchpad CRUD ==========

describe('ProjectStore - Scratchpad', () => {
  test('starts with empty scratchpad', () => {
    expect(store.getScratchpad()).toEqual([]);
  });

  test('addSnippet with all fields', () => {
    const s = store.addSnippet({ title: 'Notes', content: 'hello', category: 'dev' });
    expect(s).toMatchObject({ title: 'Notes', content: 'hello', category: 'dev' });
    expect(s.id).toBeDefined();
    expect(s.createdAt).toBeDefined();
  });

  test('addSnippet defaults', () => {
    const s = store.addSnippet({});
    expect(s.title).toBe('Untitled');
    expect(s.content).toBe('');
    expect(s.category).toBe('general');
  });

  test('updateSnippet changes allowed fields', () => {
    const s = store.addSnippet({ title: 'Old' });
    const updated = store.updateSnippet(s.id, { title: 'New', content: 'updated' });
    expect(updated.title).toBe('New');
    expect(updated.content).toBe('updated');
    expect(updated.updatedAt).toBeDefined();
  });

  test('updateSnippet ignores non-allowed fields', () => {
    const s = store.addSnippet({ title: 'Test' });
    const updated = store.updateSnippet(s.id, { title: 'Test2', secret: 'bad' });
    expect(updated.secret).toBeUndefined();
  });

  test('updateSnippet throws for nonexistent id', () => {
    expect(() => store.updateSnippet('bad', { title: 'X' })).toThrow('Snippet not found');
  });

  test('removeSnippet deletes snippet', () => {
    const s = store.addSnippet({ title: 'Delete me' });
    store.removeSnippet(s.id);
    expect(store.getScratchpad()).toHaveLength(0);
  });

  test('removeSnippet throws for nonexistent id', () => {
    expect(() => store.removeSnippet('bad')).toThrow('Snippet not found');
  });
});

// ========== Persistence ==========

describe('ProjectStore - Persistence', () => {
  test('data persists across instances', () => {
    const filePath = path.join(tmpDir, 'persist-test.json');
    const store1 = new ProjectStore(filePath);
    store1.create({ name: 'Persist', path: '/persist' });
    store1.addSnippet({ title: 'Note' });

    const store2 = new ProjectStore(filePath);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].name).toBe('Persist');
    expect(store2.getScratchpad()).toHaveLength(1);
  });

  test('handles corrupted JSON file gracefully', () => {
    const filePath = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(filePath, '{{{not valid json');
    const s = new ProjectStore(filePath);
    expect(s.list()).toEqual([]);
    expect(s.getScratchpad()).toEqual([]);
  });

  test('handles missing file gracefully', () => {
    const s = new ProjectStore(path.join(tmpDir, 'nonexistent', 'data.json'));
    expect(s.list()).toEqual([]);
  });

  test('creates directory structure on save', () => {
    const nestedPath = path.join(tmpDir, 'a', 'b', 'c', 'data.json');
    const s = new ProjectStore(nestedPath);
    s.create({ name: 'Deep', path: '/deep' });
    expect(fs.existsSync(nestedPath)).toBe(true);
  });

  test('handles file with missing fields gracefully', () => {
    const filePath = path.join(tmpDir, 'partial.json');
    fs.writeFileSync(filePath, JSON.stringify({ projects: [] }));
    const s = new ProjectStore(filePath);
    expect(s.getScratchpad()).toEqual([]);
  });
});

// ========== Duplicate Prevention ==========

describe('ProjectStore - Duplicate Prevention', () => {
  test('rejects duplicate project with same path', () => {
    store.create({ name: 'App', path: '/home/user/app' });
    expect(() => store.create({ name: 'App2', path: '/home/user/app' }))
      .toThrow('Project already exists');
  });

  test('rejects duplicate with trailing slash difference', () => {
    store.create({ name: 'App', path: '/home/user/app' });
    expect(() => store.create({ name: 'App2', path: '/home/user/app/' }))
      .toThrow('Project already exists');
  });

  test('rejects duplicate with multiple trailing slashes', () => {
    store.create({ name: 'App', path: '/home/user/app///' });
    expect(() => store.create({ name: 'App2', path: '/home/user/app' }))
      .toThrow('Project already exists');
  });

  test('normalizes path on creation (strips trailing slash)', () => {
    const p = store.create({ name: 'App', path: '/home/user/app/' });
    expect(p.path).toBe('/home/user/app');
  });

  test('does not strip slash from root path', () => {
    const p = store.create({ name: 'Root', path: '/' });
    expect(p.path).toBe('/');
  });

  test('allows different paths that are not duplicates', () => {
    store.create({ name: 'App', path: '/home/user/app' });
    const p2 = store.create({ name: 'Other', path: '/home/user/other' });
    expect(p2.name).toBe('Other');
    expect(store.list()).toHaveLength(2);
  });
});

describe('ProjectStore - Update Path Normalization', () => {
  test('normalizes path on update (strips trailing slash)', () => {
    const p = store.create({ name: 'App', path: '/home/user/app' });
    const updated = store.update(p.id, { path: '/home/user/app/' });
    expect(updated.path).toBe('/home/user/app');
  });

  test('normalizes path with multiple trailing slashes on update', () => {
    const p = store.create({ name: 'App', path: '/home/user/app' });
    const updated = store.update(p.id, { path: '/home/user/app///' });
    expect(updated.path).toBe('/home/user/app');
  });

  test('does not strip root slash on update', () => {
    const p = store.create({ name: 'Root', path: '/' });
    const updated = store.update(p.id, { path: '/' });
    expect(updated.path).toBe('/');
  });
});

describe('ProjectStore - Dedup on Load', () => {
  test('removes duplicate paths on load', () => {
    const filepath = path.join(tmpDir, 'dup.json');
    fs.writeFileSync(filepath, JSON.stringify({
      projects: [
        { id: 'a', name: 'App', path: '/home/user/app', quickCommands: [], createdAt: '2026-01-01' },
        { id: 'b', name: 'App Copy', path: '/home/user/app/', quickCommands: [], createdAt: '2026-01-02' },
      ],
      scratchpad: [],
    }));
    const loaded = new ProjectStore(filepath);
    expect(loaded.list()).toHaveLength(1);
    expect(loaded.list()[0].id).toBe('a'); // keeps first
    expect(loaded.list()[0].path).toBe('/home/user/app'); // normalized
  });

  test('normalizes paths on load without duplicates', () => {
    const filepath = path.join(tmpDir, 'slash.json');
    fs.writeFileSync(filepath, JSON.stringify({
      projects: [
        { id: 'a', name: 'App', path: '/home/user/app/', quickCommands: [], createdAt: '2026-01-01' },
      ],
      scratchpad: [],
    }));
    const loaded = new ProjectStore(filepath);
    expect(loaded.list()[0].path).toBe('/home/user/app');
  });
});
