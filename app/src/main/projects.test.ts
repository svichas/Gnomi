import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { ProjectConfig } from '@gnomi/simulation/types.ts';
import { ProjectLibrary } from './projects.ts';

const config: ProjectConfig = {
  name: 'Gym', description: 'Hiring software', goal: 'Post a job', role: 'recruiter', audience: null, settings: DEFAULT_SETTINGS,
  pois: [{ id: 'web', type: 'web', mode: 'full', segments: null, name: 'Gym', start_url: 'http://localhost:3001', allowed_hosts: [], production_domains: [], reset_hook_url: null }],
};

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-projects-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const library = new ProjectLibrary(join(dir, 'projects'));
  return { dir, library };
}

function populated(library: ProjectLibrary) {
  const entry = library.create('Gym');
  const dir = library.directory(entry.id);
  const store = openProject(dir);
  store.saveProject(config);
  store.replacePersonas([BUILTIN_PERSONA]);
  store.putSession({ role: 'recruiter', start_url: 'http://localhost:3001', hosts: [], recorded_at: 1, verified_at: 1, expires_at: null });
  store.putPersonaDraft('pending-persona-inputs', { background: 'A completed draft from the source project.' });
  store.recordSetupCall({ task_id: 'source-generation', persona_id: BUILTIN_PERSONA.id, purpose: 'expand_persona' }, {
    payload: { role: 'persona_writer', provider: 'scripted', model: 'demo', input_tokens: 100, output_tokens: 30, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.02, latency_ms: 400, status: 'ok', error: null },
    transcript: { request: { prompt: 'Source generation request' }, response: { text: 'Source biography' } },
  });
  const run = store.createRun({ seed: 42, project: config, personas: [BUILTIN_PERSONA], sessions: [], reset: false, pause_timeout_ms: 0, app_version: 'test' });
  store.append({ run_id: run.run_id, round: 0, persona_id: null, poi_id: null, type: 'run.started', payload: { config: run } });
  store.finishRun(run.run_id, 'finished', null, 0);
  store.close();
  mkdirSync(join(dir, 'sessions'));
  writeFileSync(join(dir, 'sessions', 'recruiter.enc'), 'encrypted-login');
  writeFileSync(join(dir, 'anthropic.key'), 'must-not-travel');
  mkdirSync(join(dir, 'runs', run.run_id), { recursive: true });
  writeFileSync(join(dir, 'runs', run.run_id, 'step.jpg'), 'screenshot');
  return { entry, dir };
}

test('projects have isolated folders, names survive restart, and rename preserves configuration', (t) => {
  const { dir, library } = setup(t);
  const first = library.create('  First project  ');
  const second = library.create('First project');
  assert.notEqual(first.id, second.id);
  assert.equal(first.name, 'First project');
  assert.equal(first.configured, false);
  assert.equal(new ProjectLibrary(join(dir, 'projects')).list().length, 2);
  const store = openProject(library.directory(first.id));
  store.saveProject(config);
  store.close();
  library.rename(first.id, 'Renamed');
  const saved = openProject(library.directory(first.id));
  assert.deepEqual(saved.getProject(), { ...config, name: 'Renamed' });
  saved.close();
  assert.equal(library.list().find((item) => item.id === second.id)?.name, 'First project');
  assert.throws(() => library.create('  '), /name/i);
});

test('managed IDs cannot traverse folders, and symlinked projects or databases cannot be opened', (t) => {
  const { dir, library } = setup(t);
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  for (const id of ['../outside', outside, 'a/../b.gnomi', '.', '']) assert.throws(() => library.directory(id), /project/i);
  symlinkSync(outside, join(dir, 'projects', 'link.gnomi'));
  assert.throws(() => library.directory('link.gnomi'), /project/i);
  assert.deepEqual(library.list(), []);
  const entry = library.create('Safe');
  const database = join(library.directory(entry.id), 'project.sqlite');
  rmSync(database);
  writeFileSync(join(outside, 'private.db'), 'secret');
  symlinkSync(join(outside, 'private.db'), database);
  assert.throws(() => library.directory(entry.id), /project/i);
});

test('name and SQLite sidecar symlinks cannot redirect project writes', (t) => {
  const { dir, library } = setup(t);
  const privateFile = join(dir, 'private.txt');
  writeFileSync(privateFile, 'secret');
  for (const filename of ['project-name.json', 'project.sqlite-wal', 'project.sqlite-shm']) {
    const project = library.create('Safe');
    const folder = library.directory(project.id);
    rmSync(join(folder, filename), { force: true });
    symlinkSync(privateFile, join(folder, filename));
    assert.throws(() => library.rename(project.id, 'Must fail'), /symbolic/i);
    assert.equal(readFileSync(privateFile, 'utf8'), 'secret');
  }
});

test('duplication copies configuration and personas without generation history, drafts, runs or logins', (t) => {
  const { library } = setup(t);
  const source = populated(library);
  const copied = library.duplicate(source.entry.id, 'Gym copy');
  const copiedDir = library.directory(copied.id);
  const store = openProject(copiedDir);
  assert.deepEqual(store.getProject(), { ...config, name: 'Gym copy' });
  assert.deepEqual(store.listPersonas(), [BUILTIN_PERSONA]);
  assert.deepEqual(store.listRuns(), []);
  assert.deepEqual(store.listSessions(), []);
  assert.deepEqual(store.listSetupCalls(), [], 'a new project must not inherit the source generation costs or errors');
  assert.equal(store.getPersonaDraft('pending-persona-inputs'), undefined, 'unpublished source drafts do not belong to the duplicate');
  store.close();
  assert.equal(existsSync(join(copiedDir, 'runs')), false);
  assert.equal(existsSync(join(copiedDir, 'sessions')), false);
  assert.equal(existsSync(join(copiedDir, 'anthropic.key')), false);
  assert.equal(readFileSync(join(source.dir, 'sessions', 'recruiter.enc'), 'utf8'), 'encrypted-login');
});

test('export retains report history and screenshots but removes login rows, session files and stray secrets', (t) => {
  const { dir, library } = setup(t);
  const source = populated(library);
  const exported = library.exportFolder(source.entry.id, dir);
  const store = openProject(exported);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.events('r-0001').length, 1);
  assert.deepEqual(store.listSessions(), []);
  assert.deepEqual(store.listPersonas(), [BUILTIN_PERSONA]);
  assert.equal(store.listSetupCalls()[0].task_id, 'source-generation', 'full exports retain setup diagnostics with the project history');
  assert.deepEqual(store.getPersonaDraft('pending-persona-inputs'), { background: 'A completed draft from the source project.' }, 'full exports can resume interrupted generation');
  store.close();
  assert.equal(readFileSync(join(exported, 'runs', 'r-0001', 'step.jpg'), 'utf8'), 'screenshot');
  assert.equal(existsSync(join(exported, 'sessions')), false);
  assert.equal(existsSync(join(exported, 'anthropic.key')), false);
  assert.throws(() => library.exportFolder(source.entry.id, source.dir), /outside/i);
});

test('export refuses evidence symlinks instead of following them outside the project', (t) => {
  const { dir, library } = setup(t);
  const source = populated(library);
  writeFileSync(join(dir, 'private.txt'), 'secret');
  symlinkSync(join(dir, 'private.txt'), join(source.dir, 'runs', 'private.txt'));
  assert.throws(() => library.exportFolder(source.entry.id, dir), /symbolic/i);
});

test('removal delegates exactly the managed folder to trash and protects the development override', async (t) => {
  const { dir, library } = setup(t);
  const entry = library.create('Disposable');
  const removed: string[] = [];
  await library.trash(entry.id, async (path) => { removed.push(path); rmSync(path, { recursive: true }); });
  assert.deepEqual(removed, [join(realpathSync(dir), 'projects', entry.id)]);
  assert.deepEqual(library.list(), []);
  const override = join(dir, 'smoke.gnomi');
  openProject(override).close();
  const development = new ProjectLibrary(join(dir, 'projects'), override);
  assert.equal(development.directory('development'), override);
  assert.equal(development.list()[0]?.canDelete, false);
  await assert.rejects(development.trash('development', async () => assert.fail('must not trash')), /development/i);
});
