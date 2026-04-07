import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_DATA_DIR = process.env.DATA_DIR || join(__dirname, '../../data');

/**
 * SessionStore — persists session metadata to disk.
 *
 * sessions.json  — array of session meta objects
 */
export class SessionStore {
  /**
   * @param {string} [dataDir]
   */
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir;
    this.sessionsFile = join(dataDir, 'sessions.json');
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

}
