import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { NewEvent, ProjectConfig, RunConfig, SessionInfo } from '../types.ts';
import { openProject } from './sqlite.ts';

const project: ProjectConfig = {
  name: 'Gym',
  description: 'A demo ATS.',
  poi: {
    id: 'poi-gym',
    type: 'web',
    name: 'Gym',
    start_url: 'http://localhost:3001/',
    allowed_hosts: ['cdn.example.com'],
    production_domains: ['ats.example.com'],
    not_production: false,
    reset_hook_url: null,
  },
  goal: 'Post a job for a backend engineer',
  role: 'recruiter',
};

function snapshot(): Omit<RunConfig, 'run_id'> {
  return {
    seed: 42,
    project,
    persona: BUILTIN_PERSONA,
    model: { provider: 'anthropic', navigator: 'claude-haiku-5-5' },
    step_budget: 40,
    cost_budget_usd: 1,
    screenshots: true,
    session: null,
    reset: false,
    pause_timeout_ms: 300000,
    app_version: '0.0.0',
  };
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-sqlite-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function step(run_id: string, step_no: number, persona_id = 'p-001'): NewEvent {
  return {
    run_id,
    round: 1,
    persona_id,
    poi_id: 'poi-gym',
    type: 'persona.step',
    payload: {
      step_no,
      action: { type: 'click', ref: 'e1', text: null },
      target: null,
      result: { ok: true, url_before: 'http://x/', url_after: 'http://x/', dom_changed: true, error: null },
      thought: `thinking ${step_no}`,
      feeling: 0,
      snapshot_hash: 'h',
      screenshot: null,
      duration_ms: 10,
    },
  };
}

const sessionInfo = (role: string, verified_at: number | null = null): SessionInfo => ({
  role,
  start_url: 'http://localhost:3001/app',
  hosts: ['localhost', 'cdn.example.com'],
  recorded_at: 1000,
  verified_at,
  expires_at: null,
});

test('reopening keeps the project, runs and events', (t) => {
  const dir = tempDir(t);
  const store = openProject(dir);
  assert.equal(store.getProject(), null);
  store.saveProject(project);
  const run = store.createRun(snapshot());
  const appended = [
    store.append({ run_id: run.run_id, round: 1, persona_id: null, poi_id: null, type: 'run.started', payload: { config: run } }),
    store.append(step(run.run_id, 1)),
  ];
  store.finishRun(run.run_id, 'finished', null, 0.25);
  store.close();

  const reopened = openProject(dir);
  assert.deepEqual(reopened.getProject(), project);
  const edited = { ...project, description: 'Edited.' };
  reopened.saveProject(edited);
  assert.deepEqual(reopened.getProject(), edited);
  const [row] = reopened.listRuns();
  assert.equal(row.run_id, 'r-0001');
  assert.equal(row.status, 'finished');
  assert.deepEqual(row.config, run);
  assert.deepEqual(reopened.events(run.run_id), appended);
  reopened.close();

  const raw = new DatabaseSync(join(dir, 'project.sqlite'));
  assert.equal(raw.prepare('PRAGMA user_version').get()?.user_version, 2);
  assert.equal(raw.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  raw.close();
});

test('a v1 project upgrades on open and keeps its runs and events', (t) => {
  const dir = tempDir(t);
  const store = openProject(dir);
  const run = store.createRun(snapshot()).run_id;
  const appended = store.append(step(run, 1));
  store.close();

  // The v2 change is additive: without the session table the file is exactly a v1 file.
  const v1 = new DatabaseSync(join(dir, 'project.sqlite'));
  v1.exec('DROP TABLE session; PRAGMA user_version = 1;');
  v1.close();

  const upgraded = openProject(dir);
  assert.deepEqual(upgraded.listSessions(), []);
  assert.deepEqual(upgraded.events(run), [appended]);
  upgraded.close();
  const check = new DatabaseSync(join(dir, 'project.sqlite'));
  assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 2);
  check.close();
});

test('a project saved before M1 reads back with the M1 defaults', (t) => {
  const store = openProject(tempDir(t));
  const before = {
    name: 'Gym',
    description: 'A demo ATS.',
    poi: { id: 'poi-gym', type: 'web', name: 'Gym', start_url: 'http://localhost:3001/' },
    goal: 'Post a job for a backend engineer',
  };
  store.saveProject(before as unknown as ProjectConfig);
  assert.deepEqual(store.getProject(), {
    ...before,
    role: null,
    poi: { ...before.poi, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null },
  });
  store.close();
});

test('sessions upsert by role and list in role order', (t) => {
  const store = openProject(tempDir(t));
  store.putSession(sessionInfo('recruiter'));
  store.putSession(sessionInfo('admin'));
  store.putSession(sessionInfo('recruiter', 5000));
  assert.deepEqual(store.listSessions(), [sessionInfo('admin'), sessionInfo('recruiter', 5000)]);
  store.close();
});

test('run ids count up per project and newest runs list first', (t) => {
  const store = openProject(tempDir(t));
  assert.equal(store.createRun(snapshot()).run_id, 'r-0001');
  assert.equal(store.createRun(snapshot()).run_id, 'r-0002');
  assert.deepEqual(
    store.listRuns().map((r) => r.run_id),
    ['r-0002', 'r-0001'],
  );
  store.close();
});

test('seq counts from 1 within each run and is independent across runs', (t) => {
  const store = openProject(tempDir(t));
  const a = store.createRun(snapshot()).run_id;
  const b = store.createRun(snapshot()).run_id;
  const seqs = [store.append(step(a, 1)).seq, store.append(step(b, 1)).seq, store.append(step(a, 2)).seq];
  assert.deepEqual(seqs, [1, 1, 2]);
  assert.deepEqual(
    store.events(b).map((e) => e.seq),
    [1],
  );
  store.close();
});

test('events filter by afterSeq, persona, type and limit', (t) => {
  const store = openProject(tempDir(t));
  const run = store.createRun(snapshot()).run_id;
  store.append(step(run, 1));
  store.append(step(run, 2, 'p-002'));
  store.append({
    run_id: run,
    round: 1,
    persona_id: 'p-001',
    poi_id: 'poi-gym',
    type: 'persona.goal_done',
    payload: { step_no: 3, summary: 'done' },
  });
  store.append(step(run, 4));
  const seqs = (opts: Parameters<typeof store.events>[1]) => store.events(run, opts).map((e) => e.seq);
  assert.deepEqual(seqs({ afterSeq: 2 }), [3, 4]);
  assert.deepEqual(seqs({ personaId: 'p-002' }), [2]);
  assert.deepEqual(seqs({ types: ['persona.goal_done'] }), [3]);
  assert.deepEqual(seqs({ afterSeq: 1, limit: 2 }), [2, 3]);
  assert.deepEqual(seqs({ types: [] }), []);
  store.close();
});

test('a run left running is marked interrupted on reopen; finished runs keep their status', (t) => {
  const dir = tempDir(t);
  const store = openProject(dir);
  store.createRun(snapshot()); // r-0001: the app dies before it finishes
  const done = store.createRun(snapshot()).run_id;
  store.finishRun(done, 'finished', null, 0);
  store.close();

  const reopened = openProject(dir);
  const status = Object.fromEntries(reopened.listRuns().map((r) => [r.run_id, r.status]));
  assert.deepEqual(status, { 'r-0001': 'interrupted', 'r-0002': 'finished' });
  reopened.close();
});

test('finishRun records status, stop reason, cost and end time', (t) => {
  const store = openProject(tempDir(t));
  const run = store.createRun(snapshot()).run_id;
  const before = Date.now();
  store.finishRun(run, 'stopped', 'cost_budget: $1 reached', 0.42);
  const [row] = store.listRuns();
  assert.equal(row.status, 'stopped');
  assert.equal(row.stop_reason, 'cost_budget: $1 reached');
  assert.equal(row.cost_usd, 0.42);
  assert.ok(row.ended_at !== null && row.ended_at >= before);
  assert.throws(() => store.finishRun('r-9999', 'finished', null, 0), /r-9999/);
  store.close();
});

test('transcripts round-trip, attached to their event, in seq order', (t) => {
  const store = openProject(tempDir(t));
  const run = store.createRun(snapshot()).run_id;
  store.append(step(run, 1));
  const second = store.append(step(run, 2));
  store.saveTranscript(run, second.seq, { prompt: 'look' }, { action: 'click' });
  store.saveTranscript(run, 1, { prompt: 'first' }, { action: 'read' });
  assert.deepEqual(store.transcripts(run), [
    { seq: 1, request_json: '{"prompt":"first"}', response_json: '{"action":"read"}' },
    { seq: 2, request_json: '{"prompt":"look"}', response_json: '{"action":"click"}' },
  ]);
  assert.throws(() => store.saveTranscript(run, 99, {}, {}), /#99/);
  store.close();
});

test('a project store with an unknown newer schema is refused', (t) => {
  const dir = tempDir(t);
  openProject(dir).close();
  const raw = new DatabaseSync(join(dir, 'project.sqlite'));
  raw.exec('PRAGMA user_version = 99');
  raw.close();
  assert.throws(() => openProject(dir), /schema v99/);
});
