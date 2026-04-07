import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../data');

/**
 * SessionStore — persists session metadata and terminal snapshots to disk.
 *
 * sessions.json  — array of session meta objects
 * snapshots/<id>.snap — serialized xterm state (output of SerializeAddon.serialize())
 */
export class SessionStore {
  /**
   * @param {string} [dataDir]
   */
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.sessionsFile = join(dataDir, 'sessions.json');
    this.snapshotsDir = join(dataDir, 'snapshots');
  }

  /**
   * Load all session records from disk.
   * Returns [] on missing or corrupted file.
   * @returns {Promise<object[]>}
   */
  async load() {
    try {
      const raw = await readFile(this.sessionsFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      // Parse error or other IO error — return empty rather than crashing
      return [];
    }
  }

  /**
   * Save session records to disk.
   * Accepts either a Map<id, {meta, ...}> or a plain array of meta objects.
   * @param {Map|object[]} sessions
   * @returns {Promise<void>}
   */
  async save(sessions) {
    let metas;
    if (sessions instanceof Map) {
      metas = Array.from(sessions.values()).map((s) => s.meta ?? s);
    } else {
      metas = Array.isArray(sessions) ? sessions : [];
    }
    await mkdir(dirname(this.sessionsFile), { recursive: true });
    await writeFile(this.sessionsFile, JSON.stringify(metas, null, 2), 'utf8');
  }

  /**
   * Upsert a single session record by id.
   * @param {object} session — must have an .id field
   * @returns {Promise<void>}
   */
  async upsert(session) {
    const all = await this.load();
    const idx = all.findIndex((s) => s.id === session.id);
    if (idx === -1) {
      all.push(session);
    } else {
      all[idx] = session;
    }
    await this.save(all);
  }

  /**
   * Remove a session record by ID.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async remove(sessionId) {
    const all = await this.load();
    const filtered = all.filter((s) => s.id !== sessionId);
    await this.save(filtered);
  }

  /**
   * Save a terminal snapshot for a direct-mode session.
   * The data is the opaque string returned by xterm SerializeAddon.serialize().
   * @param {string} sessionId
   * @param {string} data
   * @returns {Promise<void>}
   */
  async saveSnapshot(sessionId, data) {
    await mkdir(this.snapshotsDir, { recursive: true });
    await writeFile(join(this.snapshotsDir, `${sessionId}.snap`), data, 'utf8');
  }

  /**
   * Load a terminal snapshot for a session.
   * Returns '' if the snapshot does not exist.
   * @param {string} sessionId
   * @returns {Promise<string>}
   */
  async loadSnapshot(sessionId) {
    try {
      return await readFile(join(this.snapshotsDir, `${sessionId}.snap`), 'utf8');
    } catch {
      return '';
    }
  }

  /**
   * Delete the snapshot file for a session (call on session delete).
   * No-ops if the file does not exist.
   * @param {string} sessionId
   * @returns {Promise<void>}
   */
  async deleteSnapshot(sessionId) {
    try {
      await unlink(join(this.snapshotsDir, `${sessionId}.snap`));
    } catch {
      // ignore ENOENT
    }
  }
}
