import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ProjectStore } from '../seams.ts';
import type { EventType, GnomiEvent, ProjectConfig, RunConfig, RunStatus } from '../types.ts';

const SCHEMA_VERSION = 1;

// IF NOT EXISTS makes the schema idempotent, so a crash part-way through is finished by the next open.
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

function toEvent({ payload_json, ...event }: EventRow): GnomiEvent {
  return { ...event, payload: JSON.parse(payload_json) } as GnomiEvent;
}

export function openProject(dir: string): ProjectStore {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'project.sqlite'));
  // WAL with NORMAL: commits survive an app crash; a power cut can drop the last few.
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (user_version > SCHEMA_VERSION) {
    db.close();
    throw new Error(`project.sqlite is schema v${user_version}; this build reads up to v${SCHEMA_VERSION}`);
  }
  db.exec(`${SCHEMA}PRAGMA user_version = ${SCHEMA_VERSION};`);
  // A run still 'running' at open was cut off by a crash; nothing else will ever finish it.
  db.exec("UPDATE run SET status = 'interrupted' WHERE status = 'running';");

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

  return {
    dir,
    getProject() {
      const row = selectProject.get() as { config_json: string } | undefined;
      return row ? (JSON.parse(row.config_json) as ProjectConfig) : null;
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
        config: JSON.parse(row.snapshot_json) as RunConfig,
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
      return (db.prepare(sql).all(...params) as EventRow[]).map(toEvent);
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
    close() {
      db.close();
    },
  };
}
