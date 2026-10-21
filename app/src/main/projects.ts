import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import type { ProjectEntry, WorkspaceRun } from '../projects.ts';

const NAME_FILE = 'project-name.json';

function checkedName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120) throw new Error('Give the project a name of 1–120 characters.');
  return value.trim();
}

function database<T>(dir: string, use: (db: DatabaseSync) => T, readOnly = false): T {
  const db = new DatabaseSync(join(dir, 'project.sqlite'), { readOnly });
  try { return use(db); } finally { db.close(); }
}

function setName(dir: string, name: string) {
  database(dir, (db) => {
    const row = db.prepare('SELECT config_json FROM project WHERE id = 1').get();
    if (row) db.prepare('UPDATE project SET config_json = ?, updated_at = ? WHERE id = 1').run(JSON.stringify({ ...JSON.parse(String(row.config_json)), name }), Date.now());
  });
  writeFileSync(join(dir, NAME_FILE), JSON.stringify({ name }));
}

/** Only evidence is copied. Unknown files and recorded login state never enter a portable project. */
function copyEvidence(source: string, destination: string) {
  if (lstatSync(source).isSymbolicLink()) throw new Error('Evidence contains a symbolic link; export stopped.');
  mkdirSync(destination);
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Evidence contains a symbolic link; export stopped.');
    if (entry.isDirectory()) copyEvidence(from, to);
    else if (entry.isFile()) copyFileSync(from, to);
    else throw new Error('Evidence contains an unsupported file; export stopped.');
  }
}

/** Main owns paths; renderer requests use only these opaque folder IDs. Call mutations with the engine project closed. */
export class ProjectLibrary {
  private readonly root: string;
  private readonly override: string | undefined;

  constructor(root: string, override?: string) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.override = override ? resolve(override) : undefined;
  }

  directory(id: string): string {
    const isDevelopment = id === 'development' && this.override;
    if (!isDevelopment && (typeof id !== 'string' || !/^[\w-]+\.gnomi$/.test(id))) throw new Error('Unknown project.');
    const dir = isDevelopment || join(this.root, id);
    if (!existsSync(dir) || !lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error('Project folder is missing or is a symbolic link.');
    if (!isDevelopment && realpathSync(dir) !== join(this.root, id)) throw new Error('Project folder is outside the project library.');
    const file = join(dir, 'project.sqlite');
    if (!existsSync(file) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Project database is missing or is a symbolic link.');
    for (const name of [NAME_FILE, 'project.sqlite-wal', 'project.sqlite-shm']) {
      const entry = lstatSync(join(dir, name), { throwIfNoEntry: false });
      if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error('Project contains an unsupported file or symbolic link.');
    }
    return dir;
  }

  private entry(id: string): ProjectEntry {
    const dir = this.directory(id);
    return database(dir, (db) => {
      const row = db.prepare('SELECT config_json, updated_at FROM project WHERE id = 1').get();
      const metadata = join(dir, NAME_FILE);
      const savedName = existsSync(metadata) && !lstatSync(metadata).isSymbolicLink() ? JSON.parse(readFileSync(metadata, 'utf8')).name : null;
      return {
        id, name: row ? JSON.parse(String(row.config_json)).name : savedName || basename(dir, '.gnomi'),
        updatedAt: Math.max(Number(row?.updated_at ?? 0), lstatSync(dir).mtimeMs), configured: !!row, canDelete: id !== 'development',
      };
    }, true);
  }

  list(): ProjectEntry[] {
    const ids = readdirSync(this.root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^[\w-]+\.gnomi$/.test(entry.name)).map((entry) => entry.name);
    if (this.override && existsSync(join(this.override, 'project.sqlite'))) ids.push('development');
    return ids.flatMap((id) => {
      try { return [this.entry(id)]; } catch { return []; } // an unreadable folder does not hide the remaining projects
    }).sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name));
  }

  /** Every project's saved runs, newest first, read without opening a project in the engine. */
  runs(): WorkspaceRun[] {
    return this.list().flatMap((project) => {
      try {
        return database(this.directory(project.id), (db) => db.prepare('SELECT id, status, stop_reason, cost_usd, started_at, ended_at, snapshot_json FROM run').all(), true).map((row) => ({
          run_id: String(row.id), status: row.status as WorkspaceRun['status'], stop_reason: row.stop_reason === null ? null : String(row.stop_reason),
          cost_usd: Number(row.cost_usd), started_at: Number(row.started_at), ended_at: row.ended_at === null ? null : Number(row.ended_at),
          // shortcut: the snapshot as stored, without the engine's older-version upgrade; enough to list a run, which opens through the engine
          config: JSON.parse(String(row.snapshot_json)), project_id: project.id, project_name: project.name,
        }));
      } catch { return []; } // an unreadable project does not hide the others' runs
    }).sort((a, b) => b.started_at - a.started_at);
  }

  create(value: string): ProjectEntry {
    const name = checkedName(value);
    const id = `${randomUUID()}.gnomi`;
    const dir = join(this.root, id);
    openProject(dir).close();
    setName(dir, name);
    return this.entry(id);
  }

  rename(id: string, value: string): ProjectEntry {
    const name = checkedName(value);
    setName(this.directory(id), name);
    return this.entry(id);
  }

  duplicate(id: string, value: string): ProjectEntry {
    const name = checkedName(value);
    const source = this.directory(id);
    const copiedId = `${randomUUID()}.gnomi`;
    this.copy(source, join(this.root, copiedId), false);
    setName(join(this.root, copiedId), name);
    return this.entry(copiedId);
  }

  exportFolder(id: string, parent: string): string {
    const source = this.directory(id);
    const destinationParent = realpathSync(parent);
    const inside = relative(realpathSync(source), destinationParent);
    if (inside === '' || (!inside.startsWith(`..${sep}`) && inside !== '..' && !isAbsolute(inside))) throw new Error('Choose an export folder outside the project.');
    const name = this.entry(id).name.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'Project';
    const destination = join(destinationParent, `${name}-${randomUUID().slice(0, 8)}.gnomi`);
    this.copy(source, destination, true);
    return destination;
  }

  private copy(source: string, destination: string, includeRuns: boolean) {
    mkdirSync(destination);
    try {
      database(source, (db) => {
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
        if (Number(checkpoint?.busy) !== 0) throw new Error('The project is busy. Stop its work before copying it.');
        db.prepare('VACUUM INTO ?').run(join(destination, 'project.sqlite'));
      });
      database(destination, (db) => {
        db.exec('DELETE FROM session;');
        if (!includeRuns) {
          db.exec('DELETE FROM llm_transcript; DELETE FROM event; DELETE FROM run;');
          // A duplicate starts with configuration and personas only. Older projects
          // may not have been opened by a build with setup diagnostics yet.
          for (const table of ['setup_call', 'persona_draft']) {
            if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) db.exec(`DELETE FROM ${table};`);
          }
        }
        db.exec('VACUUM; PRAGMA wal_checkpoint(TRUNCATE);');
      });
      const metadata = join(source, NAME_FILE);
      if (existsSync(metadata) && !lstatSync(metadata).isSymbolicLink()) copyFileSync(metadata, join(destination, NAME_FILE));
      const runs = join(source, 'runs');
      if (includeRuns && existsSync(runs)) copyEvidence(runs, join(destination, 'runs'));
    } catch (err) {
      rmSync(destination, { recursive: true, force: true });
      throw err;
    }
  }

  async trash(id: string, moveToTrash: (path: string) => Promise<void>): Promise<void> {
    if (id === 'development') throw new Error('The development project is managed outside this library and cannot be deleted here.');
    await moveToTrash(this.directory(id));
  }
}
