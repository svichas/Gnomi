// host.ts is the Electron utility-process entry, driven here through a fake parent port in protocol.ts messages, with
// the scripted navigator and persona writer (GNOMI_FAKE_LLM). The shutdown message lets the test process exit.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import { startGym } from '../../gym/server.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { createSessionStore } from './sessions.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import type { Api, EngineToClient, Method } from './protocol.ts';
import type { Audience, GnomiEvent, ProjectConfig, Segment, WebPoi } from '@gnomi/simulation/types.ts';

type Listener = (e: { data: unknown; ports: [] }) => void;
const listeners: Listener[] = [];
const replies = new Map<number, (msg: EngineToClient) => void>();
const progress: { done: number; total: number }[] = [];
const events: GnomiEvent[] = [];
(process as unknown as { parentPort: unknown }).parentPort = {
  on: (event: string, listener: Listener) => event === 'message' && listeners.push(listener),
  postMessage(msg: EngineToClient) {
    if (msg.kind === 'response') replies.get(msg.id)?.(msg);
    else if (msg.kind === 'event') events.push(msg.event);
    else if (msg.kind === 'progress') progress.push(msg);
  },
};
process.env.GNOMI_FAKE_LLM = '1';
await import('./host.ts');
const send = (data: unknown) => listeners.forEach((listener) => listener({ data, ports: [] }));
after(() => send({ kind: 'shutdown' }));

let nextId = 1;
function call<M extends Method>(method: M, params: Api[M]['params']): Promise<Api[M]['result']> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    replies.set(id, (msg) => (msg.kind === 'response' && msg.ok ? resolve(msg.result as Api[M]['result']) : reject(new Error(msg.kind === 'response' && !msg.ok ? msg.error : ''))));
    send({ kind: 'request', id, method, params });
  });
}

const dir = mkdtempSync(join(tmpdir(), 'gnomi-host-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const key = randomBytes(32).toString('hex');
const project = (poi: Partial<WebPoi> = {}, more: Partial<ProjectConfig> = {}): ProjectConfig => ({
  name: 'Acme',
  description: 'An applicant tracking system.',
  pois: [{ id: 'poi-1', type: 'web', name: 'Acme', start_url: 'https://staging.acme.io/', allowed_hosts: [], production_domains: ['acme.com'], not_production: false, reset_hook_url: null, ...poi, mode: 'full', segments: null }],
  goal: 'Post a job',
  role: null,
  audience: null,
  settings: DEFAULT_SETTINGS,
  ...more,
});
const segment = (id: string, over: Partial<Segment> = {}): Segment => ({
  id,
  name: `Segment ${id}`,
  description: 'People who hire',
  share: 50,
  role: null,
  usage_frequency: 'weekly',
  typical_goals: ['post a job'],
  mobile_share: 0.2,
  patience: [2, 4],
  tech_skill: [2, 4],
  account_state: 'populated',
  entry: 'direct',
  goal_override: null,
  ...over,
});
const audience = (segments: Segment[], persona_count: number): Audience => ({
  seed: 11,
  persona_count,
  segments,
  company_size: [50, 500],
  languages: { en: 1 },
  accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
});

test('start_run refuses production, an unconfirmed host, a reset with no hook and an audience with no personas', async () => {
  await call('open_project', { dir });
  await call('save_project', { project: project({ start_url: 'https://app.acme.com/' }) });
  await assert.rejects(call('start_run', { reset: false }), /app\.acme\.com is on acme\.com, which this project lists as production/);
  await call('save_project', { project: project({ start_url: 'https://acme.io/' }) });
  await assert.rejects(call('start_run', { reset: false }), /does not look like a staging or test address/);
  await call('save_project', { project: project() });
  await assert.rejects(call('start_run', { reset: true }), /This project has no reset hook/);
  await call('save_project', { project: project({}, { audience: audience([segment('seg-1', { share: 100 })], 3) }) });
  await assert.rejects(call('start_run', { reset: false }), /This audience has no personas yet/);
});

test('every role in use needs the session key and a recorded login before the run', async () => {
  await call('save_project', { project: project({}, { role: 'recruiter' }) });
  await assert.rejects(call('start_run', { reset: false }), /Recorded logins are locked/);
  await assert.rejects(call('check_session', { role: 'recruiter' }), /Recorded logins are locked/);
  await call('set_secret', { name: 'session_key', value: key });
  await assert.rejects(call('start_run', { reset: false }), /No login is recorded for "recruiter" yet\. Record it first\./);
  assert.deepEqual((await call('get_project', {})).sessions, []);

  const store = openProject(dir); // the same project folder, as the recorder would have left it
  const info = { role: 'recruiter', start_url: 'https://staging.acme.io/home', hosts: ['staging.acme.io'], recorded_at: 1, verified_at: 1, expires_at: null };
  await createSessionStore(store, createFsBlobStore(dir), key).save(info, { cookies: [] });
  store.close();
  assert.deepEqual((await call('get_project', {})).sessions, [info]);
});

test('a run that only reads a text skips the login, which only a web app would load', async () => {
  const { id } = await call('import_asset', { text: '# Pricing\n\nStarter is $10 a month.', name: 'pricing.md' });
  await call('save_project', { project: project({}, { role: 'recruiter', pois: [{ id: 'poi-text', type: 'text', name: 'Pricing', asset: id, segments: null }] }) });
  const { run_id } = await call('start_run', { reset: false });
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => events.some((e) => e.run_id === run_id && e.type === 'report.generated') && (clearInterval(poll), resolve()), 50);
  });
  assert.equal((await call('get_report', { run_id })).status, 'finished');
});

test('record_session refuses a role the session store cannot name, and a production target, before any browser opens', async () => {
  await assert.rejects(call('record_session', { role: 'Recruiters team' }), /1–40 lowercase letters/);
  await call('save_project', { project: project({ start_url: 'https://www.acme.com/' }) });
  await assert.rejects(call('record_session', { role: 'recruiter' }), /lists as production/);
  await assert.rejects(call('save_session', {}), /No login recording is open/);
  assert.equal(await call('cancel_recording', {}), null);
});

test('comparison setup rejects stale sources and binds login recording to the selected tool', async () => {
  const first = project().pois[0];
  const config = project({}, { pois: [first, { ...first, id: 'poi-2', name: 'Second tool' }] });
  config.comparison = draftComparison(config);
  config.comparison.targets[1].access_scope = 'authenticated_workflow';
  config.comparison.targets[1].session_role = 'second-tool';
  await call('save_project', { project: config });
  await assert.rejects(call('record_session', { role: 'second-tool' }), /each comparison login/);
  await assert.rejects(call('record_session', { role: 'second-tool', target_id: config.comparison.targets[0].id }), /not configured for an authenticated workflow/);
  await assert.rejects(call('record_session', { role: 'wrong-login', target_id: config.comparison.targets[1].id }), /must match/);
  const invalid = structuredClone(config);
  invalid.comparison!.tasks[0].entries[0].poi_id = 'deleted-source';
  await assert.rejects(call('save_project', { project: invalid }), /Comparison:/);
  assert.deepEqual((await call('get_project', {})).project, config);
});

test('comparison missing logins limit affected tasks instead of refusing the report', async () => {
  const first = project().pois[0];
  const config = project({}, { pois: [first, { ...first, id: 'poi-2', name: 'Second tool' }] });
  config.comparison = draftComparison(config);
  for (const [index, target] of config.comparison.targets.entries()) {
    target.access_scope = 'authenticated_workflow';
    target.session_role = `missing-login-${index}`;
  }
  await call('save_project', { project: config });
  const { run_id } = await call('start_run', { reset: false });
  for (let attempt = 0; attempt < 200 && !events.some((event) => event.run_id === run_id && event.type === 'report.generated'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const report = await call('get_report', { run_id });
  assert.equal(report.status, 'finished');
  assert.equal(report.comparison?.decision.status, 'insufficient_evidence');
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.blocked_environment === 1 && row.valid_attempts === 0));
});

test('resume_personas and stop_run ignore a run that is not in progress', async () => {
  assert.equal(await call('resume_personas', { run_id: 'r-9999', persona_ids: ['p-001'] }), null);
  assert.equal(await call('stop_run', { run_id: 'r-9999' }), null);
});

test('a full round trip: personas from the audience, edits, an estimate, a run on the Gym and its report', async (t) => {
  const gym = await startGym({ port: 0, defects: 'D01,D02,D03' });
  t.after(() => gym.close());
  const settings = { ...DEFAULT_SETTINGS, concurrency: 3 };
  await call('save_project', { project: project({ start_url: `${gym.url}/` }, { audience: audience([segment('seg-1'), segment('seg-2')], 6), settings }) });

  const generated = await call('generate_personas', {});
  assert.equal(generated.personas.length, 6);
  assert.ok(progress.length > 0 && progress.at(-1)?.done === progress.at(-1)?.total, 'progress streamed to the clients');
  const info = await call('get_project', {});
  assert.deepEqual(info.personas, generated.personas);
  assert.ok(info.diversity);

  const [first, second] = generated.personas;
  await call('edit_persona', { persona: { ...first, name: 'Renamed Person', patience: first.patience === 5 ? 1 : 5 } });
  await call('remove_persona', { id: second.id });
  const people = (await call('get_project', {})).personas;
  const edited = people.find((p) => p.id === first.id);
  assert.deepEqual([edited?.name, edited?.patience], ['Renamed Person', first.patience], 'written fields change, sampled traits stay');
  assert.equal(people.length, 5);
  assert.ok((await call('estimate_run', {})).calls > 0);

  const { run_id } = await call('start_run', { reset: false });
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => events.some((e) => e.run_id === run_id && e.type === 'report.generated') && (clearInterval(poll), resolve()), 50);
  });
  const report = await call('get_report', { run_id });
  assert.equal(report.status, 'finished');
  assert.deepEqual(
    report.personas.map((p) => p.id),
    people.map((p) => p.id),
  );
  const steps = (await call('get_events', { run_id, after_seq: null, persona_id: first.id })).filter((e) => e.type === 'persona.step');
  assert.ok(steps.length > 0 && steps.every((e) => e.persona_id === first.id));
});

test('start_run rechecks for generation that begins during its awaited browser preflight', async (t) => {
  const gym = await startGym({ port: 0 });
  t.after(() => gym.close());
  await call('save_project', { project: project({ start_url: `${gym.url}/` }, { audience: audience([segment('seg-race', { share: 100 })], 3) }) });
  await call('generate_personas', {});
  const before = (await call('get_project', {})).runs.length;
  let started: string | undefined;

  // The preceding round-trip test has initialized the browser pool. Even a resolved pool()
  // yields once, so this second message acquires the setup lock before preflight resumes.
  const starting = call('start_run', { reset: false }).then((result) => {
    started = result.run_id;
    return result;
  });
  const writing = call('generate_personas', {});
  try {
    await assert.rejects(starting, /generation.*finish|generation.*progress/i);
    await writing;
    assert.equal((await call('get_project', {})).runs.length, before, 'a refused start must not create a run snapshot');
  } finally {
    await writing.catch(() => {});
    if (started) {
      await call('stop_run', { run_id: started });
      // Keep the rest of this shared-host suite independent when the regression is present.
      for (let i = 0; i < 100; i++) {
        const run = (await call('get_project', {})).runs.find((run) => run.run_id === started);
        if (run?.status !== 'running') break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  }
});

test('project closing and switching refuse an in-flight persona write, then close cleanly', async () => {
  await call('open_project', { dir });
  await call('save_project', { project: project({}, { audience: audience([segment('seg-lock', { share: 100 })], 3) }) });
  const writing = call('generate_personas', {});
  await assert.rejects(call('close_project', {}), /Wait for the current project task/);
  await assert.rejects(call('open_project', { dir: join(dir, 'other') }), /Wait for the current project task/);
  await writing;
  assert.equal((await call('get_project', {})).dir, dir);
  assert.equal(await call('close_project', {}), null);
  await assert.rejects(call('get_project', {}), /No project/);
  assert.equal((await call('open_project', { dir })).personas.length, 3);
});

test('runs keep their own project across switches, overlapping IDs and targeted stops', async (t) => {
  const gym = await startGym({ port: 0, captcha: true });
  t.after(() => gym.close());
  const first = join(dir, 'background-a');
  const second = join(dir, 'background-b');
  const waitFor = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('Background simulation did not reach the expected state');
  };
  await call('open_project', { dir: first });
  await call('save_project', { project: project({ start_url: `${gym.url}/candidates` }, { name: 'First project' }) });
  const a = await call('start_run', { reset: false });
  try {
    await call('open_project', { dir: second });
    await call('save_project', { project: project({ start_url: `${gym.url}/candidates` }, { name: 'Second project', audience: audience([segment('seg-bg', { share: 100 })], 1) }) });
    await call('generate_personas', {}); // a run elsewhere must not lock this project's setup
    const b = await call('start_run', { reset: false });
    assert.equal(a.run_id, b.run_id, 'run IDs are local to each project');
    await waitFor(async () => (await call('get_session_runs', {})).filter((run) => run.waiting > 0).length === 2);
    await assert.rejects(call('close_project', { dir: first }), /Stop.*run/i);
    assert.equal((await call('get_project', {})).dir, second, 'a refused folder operation preserves selection');
    await call('open_project', { dir: first });
    assert.equal((await call('get_project', {})).runs[0].status, 'running', 'reopening must not mark a live run interrupted');
    await call('open_project', { dir: second });
    await call('stop_run', { run_id: a.run_id, project_dir: first });
    await waitFor(async () => (await call('get_session_runs', {})).some((run) => run.project_dir === first && run.status === 'stopped'));
    assert.equal((await call('get_project', {})).runs[0].status, 'running', 'stopping the background project does not stop the foreground run');
    await call('stop_run', { run_id: b.run_id });
    await waitFor(async () => (await call('get_session_runs', {})).some((run) => run.project_dir === second && run.status === 'stopped'));
    const session = await call('get_session_runs', {});
    assert.deepEqual(session.filter((run) => [first, second].includes(run.project_dir)).map((run) => run.project_name).sort(), ['First project', 'Second project']);
    await call('open_project', { dir: first });
    assert.equal((await call('get_report', { run_id: a.run_id })).status, 'stopped');
  } finally {
    await call('stop_run', { run_id: a.run_id, project_dir: first });
    await call('stop_run', { run_id: a.run_id, project_dir: second });
    await waitFor(async () => (await call('get_session_runs', {})).filter((run) => [first, second].includes(run.project_dir)).every((run) => run.status !== 'running'));
    await call('open_project', { dir });
  }
});

test('opening an invalid project path leaves the previous project available', async () => {
  await call('open_project', { dir });
  await assert.rejects(call('open_project', { dir: join(dir, 'project.sqlite', 'invalid') }));
  assert.equal((await call('get_project', {})).dir, dir);
});

test('opening a project with corrupt stored data preserves the previous project', async () => {
  await call('open_project', { dir });
  const damaged = join(dir, 'damaged');
  openProject(damaged).close();
  const db = new DatabaseSync(join(damaged, 'project.sqlite'));
  db.prepare('INSERT INTO project (id, config_json, created_at, updated_at) VALUES (1, ?, 0, 0)').run('{');
  db.close();
  await assert.rejects(call('open_project', { dir: damaged }));
  assert.equal((await call('get_project', {})).dir, dir);
});

test('save_project refuses invalid country mixes before they can enter storage', async () => {
  await call('open_project', { dir });
  const config = project({}, { audience: audience([segment('seg-1', { share: 100 })], 3) });
  await call('save_project', { project: config });
  const invalid: Record<string, number>[] = [{ ZZ: 1 }, { DE: 0 }, { DE: -1 }, { DE: Infinity }];
  for (const countries of invalid) {
    await assert.rejects(call('save_project', { project: { ...config, audience: { ...config.audience!, countries } } }), /country/i);
  }
  assert.deepEqual((await call('get_project', {})).project, config);
});

test('save_project rejects invalid schemas without replacing the saved project', async () => {
  await call('open_project', { dir });
  const config = project({}, { audience: audience([segment('seg-profile', { share: 100 })], 3), persona_schema: getPersonaSchema() });
  await call('save_project', { project: config });
  const invalid = structuredClone(config);
  invalid.persona_schema!.attributes.find((a) => a.id === 'device')!.enabled = false;
  await assert.rejects(call('save_project', { project: invalid }), /core|profile|attribute/i);
  assert.deepEqual((await call('get_project', {})).project, config);
  const brokenDir = join(dir, 'bad-schema');
  const broken = openProject(brokenDir);
  broken.saveProject(invalid);
  broken.close();
  await assert.rejects(call('open_project', { dir: brokenDir }), /core|profile|attribute/i);
  assert.deepEqual((await call('get_project', {})).project, config);
});

test('changed model profile inputs require refreshed biographies before starting any browser work', async () => {
  const config = project({}, { audience: audience([segment('seg-profile', { share: 100 })], 3), persona_schema: getPersonaSchema(), role: null });
  await call('save_project', { project: config });
  const { personas } = await call('generate_personas', {});
  assert.ok(personas.every((p) => p.profile_signature));
  const changed = structuredClone(config);
  changed.persona_schema!.attributes.find((a) => a.id === 'employer')!.enabled = false;
  await call('save_project', { project: changed });
  await assert.rejects(call('start_run', { reset: false }), /profile.*changed|refresh|generate.*again/i);
  assert.deepEqual((await call('get_project', {})).personas, personas, 'a refused run does not alter the population');
  const refreshed = await call('generate_personas', {});
  assert.ok(refreshed.personas.every((p, i) => p.profile_signature !== personas[i].profile_signature));
  const metadata = structuredClone(changed);
  metadata.persona_schema!.attributes.find((a) => a.id === 'device')!.show_on_card = false;
  metadata.persona_schema!.attributes.find((a) => a.id === 'employer')!.report_dimension = false;
  metadata.role = 'missing-login-for-freshness-check';
  metadata.audience!.segments[0].role = metadata.role;
  await call('save_project', { project: metadata });
  // Role is not writer context. Reaching login preflight proves metadata edits pass freshness checks.
  await assert.rejects(call('start_run', { reset: false }), /No login is recorded/);
});

test('a custom schema needs a generated audience, and legacy profiles migrate when a schema is saved', async () => {
  await call('save_project', { project: project({}, { persona_schema: getPersonaSchema() }) });
  await assert.rejects(call('start_run', { reset: false }), /audience/i);
  const config = project({}, { audience: audience([segment('seg-profile', { share: 100 })], 3) });
  await call('save_project', { project: config });
  const generated = await call('generate_personas', {});
  const store = openProject(dir);
  store.replacePersonas(generated.personas.map(({ profile_signature: _signature, ...person }) => person));
  store.close();
  await call('save_project', { project: { ...config, persona_schema: getPersonaSchema() } });
  await assert.rejects(call('start_run', { reset: false }), /profile.*changed|refresh|generate.*again/i);
});
