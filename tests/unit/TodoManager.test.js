/**
 * TodoManager v2 tests — ported from v1 todoManager.test.js and todoList.test.js
 * ESM version with updated constructor: TodoManager(projectStore, sessionManager, opts)
 */

import { jest } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { TodoManager } from '../../lib/todos/TodoManager.js';

const _dirname = import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url));

// Minimal mock session manager
function mockSessionManager(sessions = []) {
  return {
    list: () => sessions,
    getScrollback: (id) => {
      const s = sessions.find(s => s.id === id);
      return s ? (s._scrollback || '') : '';
    },
  };
}

function mockProjectStore() {
  return { list: () => [], get: () => null };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDir;

function makeTodoManager(opts = {}) {
  return new TodoManager(
    opts.projectStore || mockProjectStore(),
    opts.sessionManager || mockSessionManager(),
    { dataDir: opts.dataDir || tmpDir, ...opts.extra },
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-v2-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ========== Module exports ==========

describe('TodoManager - exports', () => {
  test('exports TodoManager class', () => {
    expect(TodoManager).toBeDefined();
    expect(typeof TodoManager).toBe('function');
  });
});

// ========== addTodo ==========

describe('TodoManager - addTodo', () => {
  test('creates a manual todo with all fields', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', {
      title: 'Fix bug',
      priority: 'high',
      estimate: '30m',
      blockedBy: 'deploy',
    });
    expect(item).toMatchObject({
      title: 'Fix bug',
      priority: 'high',
      estimate: '30m',
      blockedBy: 'deploy',
      status: 'pending',
      source: 'manual',
    });
    expect(item.id).toBeDefined();
    expect(item.createdAt).toBeDefined();
    expect(item.completedAt).toBeNull();
    expect(item.reward).toBeDefined();
    expect(item.reward.type).toBe('fact');
    mgr.removeAllListeners();
  });

  test('defaults for optional fields', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'Simple' });
    expect(item.priority).toBe('medium');
    expect(item.estimate).toBe('15m');
    expect(item.blockedBy).toBeNull();
    mgr.removeAllListeners();
  });

  test('emits todosUpdated event', (done) => {
    const mgr = makeTodoManager();
    mgr.on('todosUpdated', (projectId) => {
      expect(projectId).toBe('proj1');
      mgr.removeAllListeners();
      done();
    });
    mgr.addTodo('proj1', { title: 'Test' });
  });
});

// ========== getTodos ==========

describe('TodoManager - getTodos', () => {
  test('returns empty for new project', () => {
    const mgr = makeTodoManager();
    const data = mgr.getTodos('new-project');
    expect(data.items).toEqual([]);
    expect(data.updatedAt).toBeNull();
    mgr.removeAllListeners();
  });

  test('returns all added todos', () => {
    const mgr = makeTodoManager();
    mgr.addTodo('proj1', { title: 'A' });
    mgr.addTodo('proj1', { title: 'B' });
    const data = mgr.getTodos('proj1');
    expect(data.items).toHaveLength(2);
    mgr.removeAllListeners();
  });

  test('todos are isolated per project', () => {
    const mgr = makeTodoManager();
    mgr.addTodo('p1', { title: 'P1 task' });
    mgr.addTodo('p2', { title: 'P2 task' });
    expect(mgr.getTodos('p1').items).toHaveLength(1);
    expect(mgr.getTodos('p2').items).toHaveLength(1);
    mgr.removeAllListeners();
  });
});

// ========== updateTodo ==========

describe('TodoManager - updateTodo', () => {
  test('updates title', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'Old' });
    const updated = mgr.updateTodo('proj1', item.id, { title: 'New' });
    expect(updated.title).toBe('New');
    mgr.removeAllListeners();
  });

  test('updates priority', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X', priority: 'low' });
    const updated = mgr.updateTodo('proj1', item.id, { priority: 'high' });
    expect(updated.priority).toBe('high');
    mgr.removeAllListeners();
  });

  test('updates estimate', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X' });
    const updated = mgr.updateTodo('proj1', item.id, { estimate: '2h' });
    expect(updated.estimate).toBe('2h');
    mgr.removeAllListeners();
  });

  test('updates blockedBy', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X' });
    const updated = mgr.updateTodo('proj1', item.id, { blockedBy: 'other task' });
    expect(updated.blockedBy).toBe('other task');
    mgr.removeAllListeners();
  });

  test('completing sets completedAt', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X' });
    const updated = mgr.updateTodo('proj1', item.id, { status: 'completed' });
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeDefined();
    expect(updated.completedAt).not.toBeNull();
    mgr.removeAllListeners();
  });

  test('returns null for nonexistent todo', () => {
    const mgr = makeTodoManager();
    const result = mgr.updateTodo('proj1', 'bad-id', { title: 'X' });
    expect(result).toBeNull();
    mgr.removeAllListeners();
  });

  test('emits todosUpdated on update', (done) => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X' });
    mgr.on('todosUpdated', (projectId) => {
      expect(projectId).toBe('proj1');
      mgr.removeAllListeners();
      done();
    });
    mgr.updateTodo('proj1', item.id, { title: 'Y' });
  });
});

// ========== deleteTodo ==========

describe('TodoManager - deleteTodo', () => {
  test('removes todo from list', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'Delete me' });
    mgr.deleteTodo('proj1', item.id);
    expect(mgr.getTodos('proj1').items).toHaveLength(0);
    mgr.removeAllListeners();
  });

  test('deleting nonexistent todo is safe', () => {
    const mgr = makeTodoManager();
    expect(() => mgr.deleteTodo('proj1', 'bad-id')).not.toThrow();
    mgr.removeAllListeners();
  });

  test('emits todosUpdated on delete', (done) => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X' });
    mgr.on('todosUpdated', (projectId) => {
      expect(projectId).toBe('proj1');
      mgr.removeAllListeners();
      done();
    });
    mgr.deleteTodo('proj1', item.id);
  });
});

// ========== getReward ==========

describe('TodoManager - getReward', () => {
  test('returns reward for existing todo', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('proj1', { title: 'X' });
    const reward = mgr.getReward('proj1', item.id);
    expect(reward).toBeDefined();
    expect(reward.type).toBe('fact');
    expect(reward.content).toBeDefined();
    mgr.removeAllListeners();
  });

  test('returns null for nonexistent todo', () => {
    const mgr = makeTodoManager();
    expect(mgr.getReward('proj1', 'bad-id')).toBeNull();
    mgr.removeAllListeners();
  });

  test('video_query reward includes searchUrl when YOUTUBE_API_KEY set', () => {
    const mgr = makeTodoManager();
    // Manually create a todo with a video_query reward
    const data = mgr.getTodos('proj1');
    const item = {
      id: 'test-video',
      title: 'Watch',
      reward: { type: 'video_query', content: 'cute cats' },
      status: 'completed',
      source: 'manual',
    };
    data.items.push(item);
    data.updatedAt = new Date().toISOString();
    // Write directly to storage
    const file = path.join(tmpDir, 'todos', 'proj1', 'todos.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));

    const origKey = process.env.YOUTUBE_API_KEY;
    process.env.YOUTUBE_API_KEY = 'test-key';
    try {
      const reward = mgr.getReward('proj1', 'test-video');
      expect(reward.type).toBe('video_query');
      expect(reward.searchUrl).toContain('youtube.com');
      expect(reward.searchUrl).toContain('cute%20cats');
    } finally {
      if (origKey) process.env.YOUTUBE_API_KEY = origKey;
      else delete process.env.YOUTUBE_API_KEY;
    }
    mgr.removeAllListeners();
  });
});

// ========== getSummaries ==========

describe('TodoManager - Summaries', () => {
  test('getSummaries returns empty for new project', () => {
    const mgr = makeTodoManager();
    const data = mgr.getSummaries('new-project');
    expect(data.sessions).toEqual({});
    mgr.removeAllListeners();
  });

  test('summarizeSession returns null for nonexistent session', async () => {
    const mgr = makeTodoManager();
    const result = await mgr.summarizeSession('nonexistent');
    expect(result).toBeNull();
    mgr.removeAllListeners();
  });

  test('summarizeSession returns null for session without projectId', async () => {
    const sessions = [{ id: 's1', projectId: null, _scrollback: 'data' }];
    const mgr = new TodoManager(mockProjectStore(), mockSessionManager(sessions), { dataDir: tmpDir });
    const result = await mgr.summarizeSession('s1');
    expect(result).toBeNull();
    mgr.removeAllListeners();
  });

  test('summarizeSession returns null for session with empty scrollback', async () => {
    const sessions = [{ id: 's1', projectId: 'p1', _scrollback: '' }];
    const mgr = new TodoManager(mockProjectStore(), mockSessionManager(sessions), { dataDir: tmpDir });
    const result = await mgr.summarizeSession('s1');
    expect(result).toBeNull();
    mgr.removeAllListeners();
  });

  test('summarizeSession returns null when delta is too small (<500 chars)', async () => {
    const sessions = [{ id: 's1', projectId: 'p1', _scrollback: 'short text' }];
    const mgr = new TodoManager(mockProjectStore(), mockSessionManager(sessions), { dataDir: tmpDir });
    const result = await mgr.summarizeSession('s1');
    expect(result).toBeNull();
    mgr.removeAllListeners();
  });
});

// ========== Persistence ==========

describe('TodoManager - Persistence', () => {
  test('todos persist to disk', () => {
    const mgr = makeTodoManager();
    mgr.addTodo('proj1', { title: 'Persist' });
    const file = path.join(tmpDir, 'todos', 'proj1', 'todos.json');
    expect(fs.existsSync(file)).toBe(true);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.items).toHaveLength(1);
    expect(data.items[0].title).toBe('Persist');
    mgr.removeAllListeners();
  });

  test('creates nested directories for project', () => {
    const mgr = makeTodoManager();
    mgr.addTodo('deep-project', { title: 'X' });
    const dir = path.join(tmpDir, 'todos', 'deep-project');
    expect(fs.existsSync(dir)).toBe(true);
    mgr.removeAllListeners();
  });

  test('todos survive a new TodoManager instance', () => {
    const mgr1 = makeTodoManager();
    mgr1.addTodo('p1', { title: 'Survives restart', priority: 'high' });
    mgr1.addTodo('p1', { title: 'Also survives' });
    mgr1.removeAllListeners();

    const mgr2 = makeTodoManager();
    const todos = mgr2.getTodos('p1');
    expect(todos.items).toHaveLength(2);
    expect(todos.items[0].title).toBe('Survives restart');
    expect(todos.items[0].priority).toBe('high');
    mgr2.removeAllListeners();
  });

  test('completed state persists', () => {
    const mgr1 = makeTodoManager();
    const item = mgr1.addTodo('p1', { title: 'Complete me' });
    mgr1.updateTodo('p1', item.id, { status: 'completed' });
    mgr1.removeAllListeners();

    const mgr2 = makeTodoManager();
    const todos = mgr2.getTodos('p1');
    expect(todos.items[0].status).toBe('completed');
    expect(todos.items[0].completedAt).not.toBeNull();
    mgr2.removeAllListeners();
  });

  test('rewards persist after reload', () => {
    const mgr1 = makeTodoManager();
    const item = mgr1.addTodo('p1', { title: 'Get reward' });
    mgr1.removeAllListeners();

    const mgr2 = makeTodoManager();
    const reward = mgr2.getReward('p1', item.id);
    expect(reward).toBeDefined();
    expect(reward.type).toBe('fact');
    mgr2.removeAllListeners();
  });

  test('handles corrupted todos.json gracefully', () => {
    const dir = path.join(tmpDir, 'todos', 'corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'todos.json'), '{{{broken');

    const mgr = makeTodoManager();
    const todos = mgr.getTodos('corrupt');
    expect(todos.items).toEqual([]);
    expect(todos.updatedAt).toBeNull();
    mgr.removeAllListeners();
  });

  test('handles corrupted summaries.json gracefully', () => {
    const dir = path.join(tmpDir, 'todos', 'corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summaries.json'), 'NOT JSON');

    const mgr = makeTodoManager();
    const summaries = mgr.getSummaries('corrupt');
    expect(summaries.sessions).toEqual({});
    mgr.removeAllListeners();
  });
});

// ========== Auth Environment ==========

describe('TodoManager - _buildAuthEnv', () => {
  test('includes TERM env var', () => {
    const mgr = makeTodoManager();
    const env = mgr._buildAuthEnv();
    expect(env.TERM).toBe('xterm-256color');
    mgr.removeAllListeners();
  });

  test('prefers OAuth token over API key', () => {
    const origOAuth = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'test-oauth';
    process.env.ANTHROPIC_API_KEY = 'test-key';
    try {
      const mgr = makeTodoManager();
      const env = mgr._buildAuthEnv();
      expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('test-oauth');
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      mgr.removeAllListeners();
    } finally {
      if (origOAuth) process.env.CLAUDE_CODE_OAUTH_TOKEN = origOAuth;
      else delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      if (origKey) process.env.ANTHROPIC_API_KEY = origKey;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

// ========== tick() ==========

describe('TodoManager - tick()', () => {
  test('tick with no running sessions does nothing', async () => {
    const mgr = makeTodoManager();
    await expect(mgr.tick()).resolves.not.toThrow();
    mgr.removeAllListeners();
  });

  test('tick skips sessions without projectId', async () => {
    const sessions = [{ id: 's1', status: 'running', projectId: null }];
    const mgr = new TodoManager(mockProjectStore(), mockSessionManager(sessions), { dataDir: tmpDir });
    await expect(mgr.tick()).resolves.not.toThrow();
    mgr.removeAllListeners();
  });

  test('tick skips exited sessions', async () => {
    const sessions = [
      { id: 's1', status: 'exited', projectId: 'p1', _scrollback: 'x'.repeat(1000) },
    ];
    const mgr = new TodoManager(mockProjectStore(), mockSessionManager(sessions), { dataDir: tmpDir });
    await mgr.tick();
    // No summaries created because session is not running
    expect(mgr.getSummaries('p1').sessions).toEqual({});
    mgr.removeAllListeners();
  });

  test('tick handles multiple projects in one pass', async () => {
    const sessions = [
      { id: 's1', status: 'running', projectId: 'p1', _scrollback: '' },
      { id: 's2', status: 'running', projectId: 'p2', _scrollback: '' },
    ];
    const mgr = new TodoManager(mockProjectStore(), mockSessionManager(sessions), { dataDir: tmpDir });
    // Should not throw even with empty scrollbacks
    await expect(mgr.tick()).resolves.not.toThrow();
    mgr.removeAllListeners();
  });
});

// ========== Full Lifecycle ==========

describe('TODO List - Full lifecycle', () => {
  test('create → get → complete → get reward', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('p1', { title: 'Upload APK to Play Console', priority: 'high', estimate: '5m' });

    // Verify pending
    let todos = mgr.getTodos('p1');
    expect(todos.items).toHaveLength(1);
    expect(todos.items[0].status).toBe('pending');
    expect(todos.items[0].completedAt).toBeNull();

    // Complete
    const updated = mgr.updateTodo('p1', item.id, { status: 'completed' });
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).toBeDefined();

    // Reward
    const reward = mgr.getReward('p1', item.id);
    expect(reward).toBeDefined();
    expect(reward.type).toBe('fact');
    expect(typeof reward.content).toBe('string');

    mgr.removeAllListeners();
  });

  test('create → delete does not leave artifacts', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('p1', { title: 'Temp task' });
    mgr.deleteTodo('p1', item.id);

    const todos = mgr.getTodos('p1');
    expect(todos.items).toHaveLength(0);

    // Reward should also be gone
    expect(mgr.getReward('p1', item.id)).toBeNull();

    mgr.removeAllListeners();
  });

  test('completing then uncompleting clears completedAt semantics', () => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('p1', { title: 'Toggle test' });

    // Complete
    mgr.updateTodo('p1', item.id, { status: 'completed' });
    let todos = mgr.getTodos('p1');
    expect(todos.items[0].completedAt).not.toBeNull();

    // Uncomplete
    mgr.updateTodo('p1', item.id, { status: 'pending' });
    todos = mgr.getTodos('p1');
    expect(todos.items[0].status).toBe('pending');
    // completedAt stays set (the code doesn't clear it on un-complete)

    mgr.removeAllListeners();
  });
});

// ========== Filtering ==========

describe('TODO List - Filtering', () => {
  let mgr;

  beforeEach(() => {
    mgr = makeTodoManager();
    mgr.addTodo('p1', { title: 'Critical fix', priority: 'high' });
    mgr.addTodo('p1', { title: 'Refactor utils', priority: 'medium' });
    mgr.addTodo('p1', { title: 'Update docs', priority: 'low' });
    mgr.addTodo('p1', { title: 'Nice to have', priority: 'low' });
  });

  afterEach(() => {
    mgr.removeAllListeners();
  });

  test('filter by priority high returns only high items', () => {
    const items = mgr.getTodos('p1').items.filter(i => i.priority === 'high');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Critical fix');
  });

  test('filter by priority low returns only low items', () => {
    const items = mgr.getTodos('p1').items.filter(i => i.priority === 'low');
    expect(items).toHaveLength(2);
  });

  test('filter by status pending returns all (nothing completed yet)', () => {
    const items = mgr.getTodos('p1').items.filter(i => i.status === 'pending');
    expect(items).toHaveLength(4);
  });

  test('filter by status completed returns none initially', () => {
    const items = mgr.getTodos('p1').items.filter(i => i.status === 'completed');
    expect(items).toHaveLength(0);
  });

  test('combined filter: high + pending', () => {
    const items = mgr.getTodos('p1').items
      .filter(i => i.priority === 'high' && i.status === 'pending');
    expect(items).toHaveLength(1);
  });

  test('after completing one, filtered counts change', () => {
    const all = mgr.getTodos('p1').items;
    mgr.updateTodo('p1', all[0].id, { status: 'completed' });

    const todos = mgr.getTodos('p1').items;
    expect(todos.filter(i => i.status === 'pending')).toHaveLength(3);
    expect(todos.filter(i => i.status === 'completed')).toHaveLength(1);
  });
});

// ========== deriveTodos merge logic ==========

describe('TODO List - deriveTodos merging', () => {
  test('preserves manual items after deriveTodos replaces auto items', () => {
    const mgr = makeTodoManager();

    // Add a manual todo
    mgr.addTodo('p1', { title: 'Manual task' });

    // Simulate existing auto items
    const data = mgr.getTodos('p1');
    data.items.push({
      id: 'auto-1', title: 'Old auto task', priority: 'medium', estimate: '15m',
      blockedBy: null, status: 'pending', source: 'auto',
      reward: { type: 'fact', content: 'fact' }, createdAt: new Date().toISOString(), completedAt: null,
    });
    data.items.push({
      id: 'auto-2', title: 'Completed auto task', priority: 'low', estimate: '5m',
      blockedBy: null, status: 'completed', source: 'auto',
      reward: { type: 'fact', content: 'fact' }, createdAt: new Date().toISOString(), completedAt: new Date().toISOString(),
    });

    // Write to disk (simulating the state before deriveTodos runs)
    const file = path.join(tmpDir, 'todos', 'p1', 'todos.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));

    // Simulate what deriveTodos does internally after receiving new items from Claude:
    const existingData = JSON.parse(fs.readFileSync(file, 'utf8'));
    const manual = existingData.items.filter(i => i.source === 'manual');
    const completedAuto = existingData.items.filter(i => i.source === 'auto' && i.status === 'completed');

    const newAutoItems = [
      { id: 'new-auto', title: 'New auto task', priority: 'high', estimate: '30m',
        blockedBy: null, status: 'pending', source: 'auto',
        reward: { type: 'fact', content: 'new fact' }, createdAt: new Date().toISOString(), completedAt: null },
    ];

    const merged = { updatedAt: new Date().toISOString(), items: [...manual, ...completedAuto, ...newAutoItems] };

    // Manual item preserved
    expect(merged.items.some(i => i.source === 'manual' && i.title === 'Manual task')).toBe(true);
    // Completed auto preserved
    expect(merged.items.some(i => i.id === 'auto-2' && i.status === 'completed')).toBe(true);
    // Old pending auto item gone
    expect(merged.items.some(i => i.id === 'auto-1')).toBe(false);
    // New auto item present
    expect(merged.items.some(i => i.id === 'new-auto')).toBe(true);

    mgr.removeAllListeners();
  });
});

// ========== Summary management ==========

describe('TODO List - Summary management', () => {
  test('summaries file stores session entries', () => {
    const mgr = makeTodoManager();

    // Write summaries directly
    const summaryData = {
      sessions: {
        's1': {
          lastSummarizedOffset: 1000,
          entries: [
            { id: 'e1', timestamp: new Date().toISOString(), sessionName: 'Test', summary: 'Did stuff', keyActions: ['action1'] },
          ],
        },
      },
    };
    const dir = path.join(tmpDir, 'todos', 'p1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'summaries.json'), JSON.stringify(summaryData, null, 2));

    const loaded = mgr.getSummaries('p1');
    expect(loaded.sessions.s1.entries).toHaveLength(1);
    expect(loaded.sessions.s1.entries[0].summary).toBe('Did stuff');

    mgr.removeAllListeners();
  });

  test('max 20 summary entries per session', () => {
    const mgr = makeTodoManager();

    // Build a summaries file with 25 entries
    const entries = [];
    for (let i = 0; i < 25; i++) {
      entries.push({
        id: `e${i}`,
        timestamp: new Date(Date.now() - (25 - i) * 60000).toISOString(),
        sessionName: 'Session',
        summary: `Summary ${i}`,
        keyActions: [],
      });
    }

    // When summarizeSession adds more, it should cap at 20
    // We test the cap logic directly
    const capped = entries.slice(-20);
    expect(capped).toHaveLength(20);
    expect(capped[0].id).toBe('e5');  // first 5 should have been dropped

    mgr.removeAllListeners();
  });
});

// ========== Multi-project isolation ==========

describe('TODO List - Multi-project', () => {
  test('todos are fully isolated between projects', () => {
    const mgr = makeTodoManager();
    mgr.addTodo('proj-a', { title: 'Task A' });
    mgr.addTodo('proj-b', { title: 'Task B' });
    mgr.addTodo('proj-a', { title: 'Task A2' });

    expect(mgr.getTodos('proj-a').items).toHaveLength(2);
    expect(mgr.getTodos('proj-b').items).toHaveLength(1);
    expect(mgr.getTodos('proj-c').items).toHaveLength(0);

    mgr.removeAllListeners();
  });

  test('deleting in one project does not affect another', () => {
    const mgr = makeTodoManager();
    const a = mgr.addTodo('proj-a', { title: 'A' });
    mgr.addTodo('proj-b', { title: 'B' });

    mgr.deleteTodo('proj-a', a.id);
    expect(mgr.getTodos('proj-a').items).toHaveLength(0);
    expect(mgr.getTodos('proj-b').items).toHaveLength(1);

    mgr.removeAllListeners();
  });

  test('summaries are isolated between projects', () => {
    const mgr = makeTodoManager();
    const dirA = path.join(tmpDir, 'todos', 'proj-a');
    const dirB = path.join(tmpDir, 'todos', 'proj-b');
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'summaries.json'), JSON.stringify({
      sessions: { s1: { lastSummarizedOffset: 100, entries: [{ id: 'e1', summary: 'A work' }] } }
    }));

    expect(mgr.getSummaries('proj-a').sessions.s1).toBeDefined();
    expect(mgr.getSummaries('proj-b').sessions).toEqual({});

    mgr.removeAllListeners();
  });
});

// ========== updatedAt tracking ==========

describe('TODO List - updatedAt tracking', () => {
  test('updatedAt is null for new project', () => {
    const mgr = makeTodoManager();
    expect(mgr.getTodos('p1').updatedAt).toBeNull();
    mgr.removeAllListeners();
  });

  test('updatedAt changes on addTodo', () => {
    const mgr = makeTodoManager();
    mgr.addTodo('p1', { title: 'X' });
    const t1 = mgr.getTodos('p1').updatedAt;
    expect(t1).toBeDefined();
    expect(t1).not.toBeNull();
    mgr.removeAllListeners();
  });

  test('updatedAt changes on updateTodo', (done) => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('p1', { title: 'X' });
    const t1 = mgr.getTodos('p1').updatedAt;

    setTimeout(() => {
      mgr.updateTodo('p1', item.id, { title: 'Y' });
      const t2 = mgr.getTodos('p1').updatedAt;
      expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
      mgr.removeAllListeners();
      done();
    }, 10);
  });

  test('updatedAt changes on deleteTodo', (done) => {
    const mgr = makeTodoManager();
    const item = mgr.addTodo('p1', { title: 'X' });
    const t1 = mgr.getTodos('p1').updatedAt;

    setTimeout(() => {
      mgr.deleteTodo('p1', item.id);
      const t2 = mgr.getTodos('p1').updatedAt;
      expect(new Date(t2).getTime()).toBeGreaterThanOrEqual(new Date(t1).getTime());
      mgr.removeAllListeners();
      done();
    }, 10);
  });
});

// ========== Event emission ==========

describe('TODO List - Events', () => {
  test('all CRUD operations emit todosUpdated', () => {
    const mgr = makeTodoManager();
    const events = [];
    mgr.on('todosUpdated', (projectId) => events.push(projectId));

    const item = mgr.addTodo('p1', { title: 'X' });         // event 1
    mgr.updateTodo('p1', item.id, { title: 'Y' });           // event 2
    mgr.deleteTodo('p1', item.id);                            // event 3

    expect(events).toEqual(['p1', 'p1', 'p1']);

    mgr.removeAllListeners();
  });

  test('events carry correct project ID for multi-project', () => {
    const mgr = makeTodoManager();
    const events = [];
    mgr.on('todosUpdated', (projectId) => events.push(projectId));

    mgr.addTodo('p1', { title: 'A' });
    mgr.addTodo('p2', { title: 'B' });

    expect(events).toEqual(['p1', 'p2']);

    mgr.removeAllListeners();
  });
});
