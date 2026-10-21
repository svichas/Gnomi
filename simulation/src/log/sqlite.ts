import { mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { withPois, type SavedProject } from '../poi/pois.ts';
import type { ProjectStore } from '../seams.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { EventType, GnomiEvent, Persona, RunConfig, RunStatus, SetupCall } from '../types.ts';

const SCHEMA_VERSION = 6;
const draftKey = (key: string) => createHash('sha256').update(key).digest('hex');

// IF NOT EXISTS makes the schema idempotent: a crash mid-way is finished by the next open; a v1 file gains new tables.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS project (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  config_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  seed INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  cost_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  stop_reason TEXT
);
CREATE TABLE IF NOT EXISTS event (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run (id),
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  round INTEGER NOT NULL,
  persona_id TEXT,
  poi_id TEXT,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, seq)
);
CREATE INDEX IF NOT EXISTS event_run_persona_seq ON event (run_id, persona_id, seq);
CREATE INDEX IF NOT EXISTS event_run_type_seq ON event (run_id, type, seq);
CREATE TABLE IF NOT EXISTS llm_transcript (
  event_id INTEGER PRIMARY KEY REFERENCES event (id),
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
  role TEXT PRIMARY KEY,
  start_url TEXT NOT NULL,
  hosts_json TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  verified_at INTEGER,
  expires_at INTEGER,
  target_id TEXT
);
CREATE TABLE IF NOT EXISTS persona (
  id TEXT PRIMARY KEY,
  segment_id TEXT,
  position INTEGER NOT NULL,
  profile_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_generation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  persona_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS persona_draft (
  cache_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS setup_call (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  persona_id TEXT,
  purpose TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  request_json TEXT NOT NULL,
  response_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS setup_call_task ON setup_call (task_id, id);
`;

const EVENT_COLUMNS = 'run_id, seq, ts, round, persona_id, poi_id, type, payload_json';

type EventRow = {
  run_id: string;
  seq: number;
  ts: number;
  round: number;
  persona_id: string | null;
  poi_id: string | null;
  type: EventType;
  payload_json: string;
};

type RunDbRow = {
  id: string;
  status: RunStatus;
  stop_reason: string | null;
  cost_usd: number;
  started_at: number;
  ended_at: number | null;
  snapshot_json: string;
};

type TranscriptRow = { seq: number; request_json: string; response_json: string };

type SessionDbRow = {
  role: string;
  start_url: string;
  hosts_json: string;
  recorded_at: number;
  verified_at: number | null;
  expires_at: number | null;
  target_id: string | null;
};

type PersonaDbRow = { profile_json: string };

/** A run snapshot of any version, read with the current project shape (one `poi` before M5). */
function withRunPois<T extends { project?: SavedProject }>(config: T): T {
  return config.project ? { ...config, project: withPois(config.project) } : config;
}

function toEvent({ payload_json, ...event }: EventRow): GnomiEvent {
  const payload = JSON.parse(payload_json);
  if (event.type === 'run.started') payload.config = withRunPois(payload.config);
  return { ...event, payload } as GnomiEvent;
}

/**
 * readOnly never writes, for reading a project another process may be running in: no migration, no runs marked interrupted.
 * recover: false writes but leaves 'running' runs alone, for a writer beside the app such as the CLI's rejudge.
 */
export function openProject(dir: string, { readOnly = false, recover = true } = {}): ProjectStore {
  if (!readOnly) mkdirSync(dir, { recursive: true });
  // The app and a CLI may share the file: wait up to 5 s for the other's write lock rather than failing at once.
  const db = new DatabaseSync(join(dir, 'project.sqlite'), { readOnly, timeout: 5000 });
  // WAL with NORMAL: commits survive an app crash; a power cut can drop the last few.
  if (!readOnly) db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`project.sqlite is schema v${user_version}; this build reads up to v${SCHEMA_VERSION}`);
  }
  if (readOnly) {
    if (user_version < SCHEMA_VERSION) {
      db.close();
      throw new Error(`project.sqlite is schema v${user_version}; open it in Gnomi once to upgrade it to v${SCHEMA_VERSION}`);
    }
  } else {
    // IMMEDIATE: a deferred transaction that has read cannot wait for the write lock, it fails at once.
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(SCHEMA);
      // Existing sessions retain no target binding; only a new recording can establish ownership.
      if (!db.prepare('PRAGMA table_info(session)').all().some((column) => column.name === 'target_id')) db.exec('ALTER TABLE session ADD COLUMN target_id TEXT');
      if (user_version < 6) db.exec(`
        INSERT OR IGNORE INTO persona_generation (id, persona_count)
        SELECT 1, json_extract(config_json, '$.audience.persona_count') FROM project
        WHERE json_extract(config_json, '$.audience.persona_count') IS NOT NULL AND EXISTS (SELECT 1 FROM persona);
      `);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT;`);
    } catch (error) {
      db.exec('ROLLBACK');
      db.close();
      throw error;
    }
    // A run still 'running' at open was cut off by a crash; nothing else will ever finish it.
    if (recover) db.exec("UPDATE run SET status = 'interrupted' WHERE status = 'running';");
  }

  const selectProject = db.prepare('SELECT config_json FROM project WHERE id = 1');
  const upsertProject = db.prepare(
    `INSERT INTO project (id, config_json, created_at, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET config_json = excluded.config_json, updated_at = excluded.updated_at`,
  );
  const countRuns = db.prepare('SELECT COUNT(*) AS n FROM run');
  const insertRun = db.prepare(
    `INSERT INTO run (id, created_at, status, seed, snapshot_json, cost_usd, started_at)
     VALUES (?, ?, 'running', ?, ?, 0, ?)`,
  );
  const updateRunEnd = db.prepare('UPDATE run SET status = ?, stop_reason = ?, cost_usd = ?, ended_at = ? WHERE id = ?');
  const selectRuns = db.prepare(
    'SELECT id, status, stop_reason, cost_usd, started_at, ended_at, snapshot_json FROM run ORDER BY rowid DESC',
  );
  // Computing seq in the same statement as the insert keeps it atomic: no read-then-write race.
  const insertEvent = db.prepare(
    `INSERT INTO event (${EVENT_COLUMNS})
     SELECT ?, COALESCE(MAX(seq), 0) + 1, ?, ?, ?, ?, ?, ? FROM event WHERE run_id = ? RETURNING seq`,
  );
  const insertTranscript = db.prepare(
    `INSERT INTO llm_transcript (event_id, request_json, response_json)
     SELECT id, ?, ? FROM event WHERE run_id = ? AND seq = ?`,
  );
  const selectTranscripts = db.prepare(
    `SELECT e.seq, t.request_json, t.response_json FROM llm_transcript t
     JOIN event e ON e.id = t.event_id WHERE e.run_id = ? ORDER BY e.seq`,
  );
  const selectSessions = db.prepare(
    'SELECT role, start_url, hosts_json, recorded_at, verified_at, expires_at, target_id FROM session ORDER BY role',
  );
  const upsertSession = db.prepare(
    `INSERT INTO session (role, start_url, hosts_json, recorded_at, verified_at, expires_at, target_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (role) DO UPDATE SET start_url = excluded.start_url, hosts_json = excluded.hosts_json,
       recorded_at = excluded.recorded_at, verified_at = excluded.verified_at, expires_at = excluded.expires_at, target_id = excluded.target_id`,
  );
  const selectPersonas = db.prepare('SELECT profile_json FROM persona ORDER BY position');
  const clearPersonas = db.prepare('DELETE FROM persona');
  const insertPersona = db.prepare('INSERT INTO persona (id, segment_id, position, profile_json) VALUES (?, ?, ?, ?)');
  // A new id goes after the last position; an existing id keeps its position because ON CONFLICT never sets it.
  const upsertPersona = db.prepare(
    `INSERT INTO persona (id, segment_id, position, profile_json)
     VALUES (?, ?, COALESCE((SELECT MAX(position) FROM persona), -1) + 1, ?)
     ON CONFLICT (id) DO UPDATE SET segment_id = excluded.segment_id, profile_json = excluded.profile_json`,
  );
  const removePersona = db.prepare('DELETE FROM persona WHERE id = ?');
  const selectGenerated = db.prepare('SELECT persona_count FROM persona_generation WHERE id = 1');
  const upsertGenerated = db.prepare('INSERT INTO persona_generation (id, persona_count) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET persona_count = excluded.persona_count');
  const selectDraft = db.prepare('SELECT value_json FROM persona_draft WHERE cache_key = ?');
  const upsertDraft = db.prepare('INSERT INTO persona_draft VALUES (?, ?) ON CONFLICT(cache_key) DO UPDATE SET value_json = excluded.value_json');
  const insertSetupCall = db.prepare('INSERT INTO setup_call (ts, task_id, persona_id, purpose, payload_json, request_json, response_json) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const selectSetupCalls = db.prepare('SELECT id, ts, task_id, persona_id, purpose, payload_json FROM setup_call WHERE task_id = (SELECT task_id FROM setup_call ORDER BY id DESC LIMIT 1) ORDER BY id');
  // One statement per shape of events() query: a run step reads the log several times, and there are only a few shapes.
  const eventQueries = new Map<string, StatementSync>();

  return {
    dir,
    getProject() {
      const row = selectProject.get() as { config_json: string } | undefined;
      if (!row) return null;
      const saved = JSON.parse(row.config_json) as SavedProject;
      // Configs saved before M5 have one `poi`; before M2, no audience or settings; before M1, no role or POI containment fields.
      return {
        ...withPois(saved),
        audience: saved.audience ?? null,
        settings: saved.settings ?? structuredClone(DEFAULT_SETTINGS),
        role: saved.role ?? null,
      };
    },
    saveProject(project) {
      const now = Date.now();
      upsertProject.run(JSON.stringify(project), now, now);
    },
    createRun(snapshot) {
      const { n } = countRuns.get() as { n: number };
      const config: RunConfig = { ...snapshot, run_id: `r-${String(n + 1).padStart(4, '0')}` };
      const now = Date.now();
      insertRun.run(config.run_id, now, config.seed, JSON.stringify(config), now);
      return config;
    },
    finishRun(run_id, status, stop_reason, cost_usd) {
      const { changes } = updateRunEnd.run(status, stop_reason, cost_usd, Date.now(), run_id);
      if (changes === 0) throw new Error(`No run ${run_id}`);
    },
    listRuns() {
      return (selectRuns.all() as RunDbRow[]).map((row) => ({
        run_id: row.id,
        status: row.status,
        stop_reason: row.stop_reason,
        cost_usd: row.cost_usd,
        started_at: row.started_at,
        ended_at: row.ended_at,
        config: withRunPois(JSON.parse(row.snapshot_json)) as RunConfig,
      }));
    },
    append(event) {
      // shortcut: one commit per event, not the 200-event batches of tech.md §5.1; batch once appends show in a profile
      const ts = Date.now();
      const { seq } = insertEvent.get(
        event.run_id,
        ts,
        event.round,
        event.persona_id,
        event.poi_id,
        event.type,
        JSON.stringify(event.payload),
        event.run_id,
      ) as { seq: number };
      return { ...event, seq, ts };
    },
    events(run_id, opts = {}) {
      const where = ['run_id = ?'];
      const params: SQLInputValue[] = [run_id];
      if (opts.afterSeq !== undefined) {
        where.push('seq > ?');
        params.push(opts.afterSeq);
      }
      if (opts.personaId !== undefined) {
        where.push('persona_id = ?');
        params.push(opts.personaId);
      }
      if (opts.types) {
        where.push(`type IN (${opts.types.map(() => '?').join(', ')})`);
        params.push(...opts.types);
      }
      params.push(opts.limit ?? -1); // SQLite: LIMIT -1 means no limit
      const sql = `SELECT ${EVENT_COLUMNS} FROM event WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`;
      const query = eventQueries.get(sql) ?? eventQueries.set(sql, db.prepare(sql)).get(sql)!;
      return (query.all(...params) as EventRow[]).map(toEvent);
    },
    saveTranscript(run_id, seq, request, response) {
      const { changes } = insertTranscript.run(JSON.stringify(request), JSON.stringify(response), run_id, seq);
      if (changes === 0) throw new Error(`No event ${run_id} #${seq} to attach a transcript to`);
    },
    transcripts(run_id) {
      return (selectTranscripts.all(run_id) as TranscriptRow[]).map(({ seq, request_json, response_json }) => ({
        seq,
        request_json,
        response_json,
      }));
    },
    listSessions() {
      return (selectSessions.all() as SessionDbRow[]).map((row) => ({
        role: row.role,
        start_url: row.start_url,
        hosts: JSON.parse(row.hosts_json) as string[],
        recorded_at: row.recorded_at,
        verified_at: row.verified_at,
        expires_at: row.expires_at,
        ...(row.target_id !== null ? { target_id: row.target_id } : {}),
      }));
    },
    putSession(info) {
      const { role, start_url, hosts, recorded_at, verified_at, expires_at } = info;
      upsertSession.run(role, start_url, JSON.stringify(hosts), recorded_at, verified_at, expires_at, info.target_id ?? null);
    },
    listPersonas() {
      return (selectPersonas.all() as PersonaDbRow[]).map((row) => JSON.parse(row.profile_json) as Persona);
    },
    getGeneratedPersonaCount() {
      const row = selectGenerated.get();
      return row ? Number(row.persona_count) : null;
    },
    replacePersonas(personas, personaCount) {
      db.exec('BEGIN');
      try {
        clearPersonas.run();
        personas.forEach((p, position) => insertPersona.run(p.id, p.segment_id, position, JSON.stringify(p)));
        if (personaCount !== undefined) upsertGenerated.run(personaCount);
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    putPersona(persona) {
      upsertPersona.run(persona.id, persona.segment_id, JSON.stringify(persona));
    },
    deletePersona(id) {
      removePersona.run(id);
    },
    getPersonaDraft(key) {
      const row = selectDraft.get(draftKey(key));
      return row ? JSON.parse(String(row.value_json)) : undefined;
    },
    putPersonaDraft(key, value) {
      upsertDraft.run(draftKey(key), JSON.stringify(value));
    },
    clearPersonaDrafts() { db.exec('DELETE FROM persona_draft'); },
    recordSetupCall({ task_id, persona_id, purpose }, { payload, transcript }) {
      insertSetupCall.run(Date.now(), task_id, persona_id, purpose, JSON.stringify(payload), JSON.stringify(transcript.request), JSON.stringify(transcript.response));
    },
    listSetupCalls() {
      return selectSetupCalls.all()
        .map(({ payload_json, ...row }) => ({ ...row, payload: JSON.parse(String(payload_json)) }) as SetupCall);
    },
    close() {
      db.close();
    },
  };
}
