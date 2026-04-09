import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

// import.meta.dirname is Node 21+; use fileURLToPath fallback for Node 20
const _dirname = import.meta.dirname ?? fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PATH = path.join(_dirname, '../../data/projects.json');

/**
 * ProjectStore — CRUD persistence for projects and scratchpad snippets.
 * Sync I/O for simplicity and atomic reads; auto-saves on every mutation.
 */
export class ProjectStore {
  /**
   * @param {string} [filepath] - Path to the JSON data file
   */
  constructor(filepath = DEFAULT_PATH) {
    this.filepath = filepath;
    this.data = { projects: [], scratchpad: [] };
    this._load();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.filepath)) {
        this.data = JSON.parse(fs.readFileSync(this.filepath, 'utf8'));
      }
    } catch {
      this.data = { projects: [], scratchpad: [] };
    }
    // Ensure structure
    if (!this.data.projects) this.data.projects = [];
    if (!this.data.scratchpad) this.data.scratchpad = [];
    // Normalize paths and deduplicate
    this._dedup();
  }

  _dedup() {
    const seen = new Map();
    const clean = [];
    for (const p of this.data.projects) {
      p.path = this._normalizePath(p.path);
      if (!seen.has(p.path)) {
        seen.set(p.path, true);
        clean.push(p);
      }
    }
    if (clean.length !== this.data.projects.length) {
      this.data.projects = clean;
      this._save();
    }
  }

  _save() {
    const dir = path.dirname(this.filepath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.filepath, JSON.stringify(this.data, null, 2));
  }

  _normalizePath(p) {
    // Strip trailing slashes for consistent comparison (keep root '/')
    return p && p.length > 1 ? p.replace(/\/+$/, '') : p;
  }

  // ── Projects ─────────────────────────────────────────────────────────────

  list() {
    return this.data.projects;
  }

  get(id) {
    return this.data.projects.find(p => p.id === id);
  }

  create({ name, path: projectPath, quickCommands } = {}) {
    if (!name || !projectPath) throw new Error('Name and path are required');
    const normalized = this._normalizePath(projectPath);
    if (!fs.existsSync(normalized)) throw new Error(`Path does not exist: ${normalized}`);
    const existing = this.data.projects.find(
      p => this._normalizePath(p.path) === normalized
    );
    if (existing) throw new Error(`Project already exists at this path: ${existing.name}`);
    const project = {
      id: uuidv4(),
      name,
      path: normalized,
      quickCommands: quickCommands || [],
      createdAt: new Date().toISOString(),
    };
    this.data.projects.push(project);
    this._save();
    return project;
  }

  update(id, updates) {
    const idx = this.data.projects.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Project not found');
    const allowed = ['name', 'path', 'quickCommands'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        this.data.projects[idx][key] = key === 'path'
          ? this._normalizePath(updates[key])
          : updates[key];
      }
    }
    this.data.projects[idx].updatedAt = new Date().toISOString();
    this._save();
    return this.data.projects[idx];
  }

  remove(id) {
    const idx = this.data.projects.findIndex(p => p.id === id);
    if (idx === -1) throw new Error('Project not found');
    this.data.projects.splice(idx, 1);
    this._save();
  }

  // ── Scratchpad ────────────────────────────────────────────────────────────

  getScratchpad() {
    return this.data.scratchpad;
  }

  addSnippet({ title, content, category } = {}) {
    const snippet = {
      id: uuidv4(),
      title: title || 'Untitled',
      content: content || '',
      category: category || 'general',
      createdAt: new Date().toISOString(),
    };
    this.data.scratchpad.push(snippet);
    this._save();
    return snippet;
  }

  updateSnippet(id, updates) {
    const idx = this.data.scratchpad.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('Snippet not found');
    const allowed = ['title', 'content', 'category'];
    for (const key of allowed) {
      if (updates[key] !== undefined) {
        this.data.scratchpad[idx][key] = updates[key];
      }
    }
    this.data.scratchpad[idx].updatedAt = new Date().toISOString();
    this._save();
    return this.data.scratchpad[idx];
  }

  removeSnippet(id) {
    const idx = this.data.scratchpad.findIndex(s => s.id === id);
    if (idx === -1) throw new Error('Snippet not found');
    this.data.scratchpad.splice(idx, 1);
    this._save();
  }
}
