// host.ts is the Electron utility-process entry, driven here through a fake parent port in protocol.ts messages, with
// the scripted navigator and persona writer (GNOMI_FAKE_LLM). The shutdown message lets the test process exit.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test, type TestContext } from 'node:test';
import { startGym } from '../../demo/GymSite/server.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import { createSessionStore } from './sessions.ts';
import { startHost } from './host.fixture.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import type { RepeatSet } from '@gnomi/simulation/report/repeats.ts';
import type { Audience, GnomiEvent, ProjectConfig, Segment, WebPoi } from '@gnomi/simulation/types.ts';

process.env.GNOMI_FAKE_LLM = '1';
const { call, connect, events, progress, toMain, repeatFailures } = await startHost();

const dir = mkdtempSync(join(tmpdir(), 'gnomi-host-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const key = randomBytes(32).toString('hex');
const project = (poi: Partial<WebPoi> = {}, more: Partial<ProjectConfig> = {}): ProjectConfig => ({
  name: 'Acme',
  description: 'An applicant tracking system.',
  pois: [{ id: 'poi-1', type: 'web', name: 'Acme', start_url: 'https://staging.acme.io/', allowed_hosts: [], production_domains: ['acme.com'], reset_hook_url: null, ...poi, mode: 'full', segments: null }],
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

test('start_run refuses a listed production domain, a reset with no hook and an audience with no personas', async () => {
  await call('open_project', { dir });
  await call('save_project', { project: project({ start_url: 'https://app.acme.com/' }) });
  await assert.rejects(call('start_run', { reset: false }), /app\.acme\.com is on acme\.com, which this project lists as production/);
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

test('a study plan and an outcome reach the app through report.generated, and a plan runs only when asked', async () => {
  const { id } = await call('import_asset', { text: '# Pricing\n\nStarter is $10 a month.', name: 'study.md' });
  await call('save_project', { project: project({}, { pois: [{ id: 'poi-text', type: 'text', name: 'Pricing', asset: id, segments: null }] }) });
  const { run_id } = await call('start_run', { reset: false });
  const generated = () => events.filter((e) => e.run_id === run_id && e.type === 'report.generated').length;
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => generated() > 0 && (clearInterval(poll), resolve()), 50);
  });
  const report = await call('get_report', { run_id });
  assert.equal(report.study_plan, undefined, 'nothing is planned unasked');
  const estimate = await call('estimate_study', { run_id });
  assert.deepEqual([estimate.calls, estimate.unpriced], [1, []]);
  assert.ok(estimate.cost_usd[1] > estimate.cost_usd[0]);

  await call('plan_study', { run_id });
  assert.equal(generated(), 2, 'an open report reloads');
  assert.ok((await call('get_report', { run_id })).study_plan?.hypotheses.length);

  const theme_id = report.themes![0].id;
  await assert.rejects(call('record_outcome', { run_id, theme_id, status: 'proven' as never, study_date: '2026-10-12' }), /status must be/);
  await call('record_outcome', { run_id, theme_id, status: 'unresolved', study_date: '2026-10-12', note: 'Too few sessions.' });
  assert.equal(generated(), 3);
  const studied = await call('get_report', { run_id });
  assert.deepEqual(studied.themes![0].validation, { status: 'unresolved', note: 'Too few sessions.', study_date: '2026-10-12', title: report.themes![0].title });
  await assert.rejects(call('plan_study', { run_id: 'r-9999' }), /There is no run r-9999/);
});

test('a second plan for a run is refused while the first is written, so leaving the report and clicking again cannot spend twice', async () => {
  const { id } = await call('import_asset', { text: '# Pricing\n\nStarter is $10 a month.', name: 'twice.md' });
  await call('save_project', { project: project({}, { pois: [{ id: 'poi-text', type: 'text', name: 'Pricing', asset: id, segments: null }] }) });
  const { run_id } = await call('start_run', { reset: false });
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => events.some((e) => e.run_id === run_id && e.type === 'report.generated') && (clearInterval(poll), resolve()), 50);
  });
  const plans = () => events.filter((e) => e.run_id === run_id && e.type === 'report.study').length;
  const first = call('plan_study', { run_id });
  await assert.rejects(call('plan_study', { run_id }), /already being written/);
  await first;
  assert.equal(plans(), 1, 'one call was paid for');
  await call('plan_study', { run_id });
  assert.equal(plans(), 2, 'the refusal ends with the plan');
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

test('changing the persona count requires generation before a run, including after saving and reopening', async () => {
  const countDir = join(dir, 'persona-count');
  const config = project({}, { audience: audience([segment('seg-count', { share: 100, role: 'count-check' })], 3) });
  await call('open_project', { dir: countDir });
  await call('set_secret', { name: 'session_key', value: key });
  await call('save_project', { project: config });
  const original = await call('generate_personas', {});
  await call('add_persona', { segment_id: 'seg-count' });
  await assert.rejects(call('start_run', { reset: false }), /No login is recorded/, 'hand-added personas stay extra');
  await call('remove_persona', { id: original.personas[0].id });
  await assert.rejects(call('start_run', { reset: false }), /No login is recorded/, 'individual removals do not require regeneration');

  for (const persona_count of [2, 4]) {
    const changed = { ...config, audience: { ...config.audience!, persona_count } };
    await call('save_project', { project: changed });
    const before = (await call('get_project', {})).personas;
    await call('open_project', { dir });
    await call('open_project', { dir: countDir });
    await assert.rejects(call('start_run', { reset: false }), /persona count.*changed.*generate personas again/i);
    assert.deepEqual((await call('get_project', {})).personas, before, 'a refused run preserves the saved personas');
    const generated = await call('generate_personas', {});
    assert.equal(generated.personas.length, persona_count + 1, 'the hand-added persona remains extra');
    await assert.rejects(call('start_run', { reset: false }), /No login is recorded/, 'generation clears the count check');
  }
  await call('open_project', { dir });
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

test('get_blob refuses a path that climbs out of runs/ to the database or a recorded login', async () => {
  await call('open_project', { dir });
  for (const path of ['runs/../project.sqlite', 'runs/../sessions/x.session', 'runs\\..\\project.sqlite']) {
    await assert.rejects(call('get_blob', { path }), /Only files from a run or a point of interest/, path);
  }
});

test('a renderer port cannot switch projects or set secrets, which only main may do', async () => {
  const renderer = connect();
  await call('open_project', { dir });
  await assert.rejects(renderer('open_project', { dir: join(dir, 'other') }), /main process only/);
  await assert.rejects(renderer('close_project', {}), /main process only/);
  await assert.rejects(renderer('set_secret', { name: 'anthropic_api_key', value: 'sk-renderer' }), /main process only/);
  assert.equal((await renderer('get_project', {})).dir, dir);
});

test('main gets only its responses over the parent port: events and progress go to the renderer', async () => {
  await call('open_project', { dir: join(dir, 'main-port') });
  await call('save_project', { project: project({}, { audience: audience([segment('seg-1', { share: 100 })], 2) }) });
  const before = progress.length;
  await call('generate_personas', {});
  assert.ok(progress.length > before, 'the renderer got the progress');
  assert.deepEqual(toMain, []);
});

const until = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 1200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('The repeat set did not reach the expected state');
};
const inSet = async (group: string) => (await call('get_project', {})).runs.filter((run) => run.config.repeat?.group === group).reverse();
/** A run's row says finished while its report is still being saved; the session list waits for the report. */
const reported = (run_id: string) => until(async () => (await call('get_session_runs', {})).some((run) => run.project_dir === join(dir, 'repeats') && run.run_id === run_id && run.status === 'finished'));

test('a repeat set runs one at a time on its share of the budget, and reads back as one comparison', async () => {
  await call('open_project', { dir: join(dir, 'repeats') });
  const { id } = await call('import_asset', { text: '# Pricing\n\nStarter is $10 a month.', name: 'pricing.md' });
  await call('save_project', { project: project({}, { pois: [{ id: 'poi-text', type: 'text', name: 'Pricing', asset: id, segments: null }], settings: { ...DEFAULT_SETTINGS, cost_budget_usd: 3 } }) });
  assert.equal((await call('estimate_run', { repeats: 3 })).calls, (await call('estimate_run', {})).calls * 3);
  await assert.rejects(call('start_run', { reset: false, repeats: 0 }), /whole number/);

  const { run_id } = await call('start_run', { reset: false, repeats: 3 });
  await assert.rejects(call('start_run', { reset: false }), /already in progress/);
  const { group, index, of } = (await call('get_project', {})).runs.find((run) => run.run_id === run_id)!.config.repeat!;
  assert.deepEqual([index, of], [1, 3]);
  // Edits while the set runs are for the next start: its later runs keep what it started with.
  await call('save_project', { project: project({}, { goal: 'Changed mid-set', pois: [{ id: 'poi-text', type: 'text', name: 'Pricing', asset: id, segments: null }] }) });
  // A run's row says finished while its report is still being saved; the session list waits for the report.
  await until(async () => (await call('get_session_runs', {})).filter((run) => run.project_dir === join(dir, 'repeats') && run.status === 'finished').length === 3);

  const runs = await inSet(group);
  assert.deepEqual(runs.map((run) => run.config.repeat?.index), [1, 2, 3]);
  assert.deepEqual(runs.map((run) => run.config.project.settings.cost_budget_usd), [1, 1, 1]);
  assert.deepEqual(runs.map((run) => run.config.project.goal), ['Post a job', 'Post a job', 'Post a job']);
  for (const [i, run] of runs.slice(1).entries()) assert.ok(run.started_at >= runs[i].ended_at!, 'each starts when the last has ended');
  assert.equal((await call('get_report', { run_id })).repeat?.group, group);

  const set = await call('get_repeats', { group });
  assert.deepEqual([set.group, set.of, set.compared, set.incomplete], [group, 3, 3, false]);
  assert.ok(set.findings.length > 0 && set.findings.every((f) => f.seen_in === 3 && Object.keys(f.themes).length === 3));
  assert.equal((await call('get_repeats', { group: 'no-such-set' })).findings.length, 0);
});

test('stopping a run ends its repeat set, which reads as incomplete, and the project can start again', async () => {
  const { run_id } = await call('start_run', { reset: false, repeats: 3 });
  await call('stop_run', { run_id });
  const { group } = (await call('get_project', {})).runs.find((run) => run.run_id === run_id)!.config.repeat!;
  await until(async () => (await inSet(group)).every((run) => run.status === 'stopped'));
  await new Promise((resolve) => setTimeout(resolve, 100)); // a next run would have started by now
  assert.equal((await inSet(group)).length, 1);
  const set = await call('get_repeats', { group });
  assert.deepEqual([set.of, set.compared, set.running, set.incomplete], [3, 0, false, true]);
  assert.deepEqual(repeatFailures, [], 'a stop is no failure');

  const next = await call('start_run', { reset: false });
  await reported(next.run_id);
});

/** Runs `then` on the first event of `type`, as it is logged. */
const onFirst = (t: TestContext, type: GnomiEvent['type'], then: (event: GnomiEvent) => void) => {
  const { push } = events;
  t.after(() => { events.push = push; });
  let done = false;
  events.push = (...added) => {
    const event = added.find((e) => e.type === type);
    if (event && !done) {
      done = true;
      then(event);
    }
    return push.apply(events, added);
  };
};

test('a stop that lands after a run has logged its end still ends the set: that run stays finished and the set reads incomplete', async (t) => {
  onFirst(t, 'run.finished', ({ run_id }) => void call('stop_run', { run_id }));
  const { run_id } = await call('start_run', { reset: false, repeats: 3 });
  const { group } = (await call('get_project', {})).runs.find((run) => run.run_id === run_id)!.config.repeat!;
  await until(async () => (await inSet(group)).every((run) => run.status === 'finished'));
  await new Promise((resolve) => setTimeout(resolve, 100)); // a next run would have started by now
  assert.deepEqual((await inSet(group)).map((run) => [run.run_id, run.status]), [[run_id, 'finished']]);
  const set = await call('get_repeats', { group });
  assert.deepEqual([set.of, set.compared, set.running, set.incomplete], [3, 1, false, true]);
  assert.deepEqual(repeatFailures, [], 'a stop is no failure');
  await reported((await call('start_run', { reset: false })).run_id);
});

test('between two runs a set still reads as running: the app reads it as soon as a run ends', async (t) => {
  let between: Promise<RepeatSet> | undefined;
  onFirst(t, 'report.generated', () => {
    const started = events.findLast((event) => event.type === 'run.started');
    if (started?.type === 'run.started') between = call('get_repeats', { group: started.payload.config.repeat!.group }); // answered as this runs: the first run is over and the next has not started
  });
  await call('start_run', { reset: false, repeats: 2 });
  await until(async () => between !== undefined);
  const set = await between!;
  assert.deepEqual([set.of, set.compared, set.running, set.incomplete], [2, 1, true, false]);
  await until(async () => (await inSet(set.group!)).length === 2);
  await reported((await inSet(set.group!))[1].run_id);
});

test('each repeat resets staging and checks its logins again, and a repeat that cannot start ends the set and says why', async (t) => {
  const gym = await startGym({ port: 0, defects: 'none' });
  t.after(() => gym.close());
  const setDir = join(dir, 'repeat-logins');
  await call('open_project', { dir: setDir });
  await call('set_secret', { name: 'session_key', value: key });
  await call('save_project', { project: project({ start_url: `${gym.url}/`, reset_hook_url: `${gym.url}/__reset` }, { role: 'recruiter' }) });
  const login = openProject(setDir);
  await createSessionStore(login, createFsBlobStore(setDir), key).save({ role: 'recruiter', start_url: `${gym.url}/`, hosts: [new URL(gym.url).host], recorded_at: 1, verified_at: 1, expires_at: null }, { cookies: [] });
  login.close();
  // The login goes as the second run ends its browsing, so that run still gets it and only the third finds it gone.
  const { push } = events;
  t.after(() => { events.push = push; });
  events.push = (...added) => {
    if (added.some((event) => event.type === 'report.started' && event.run_id === 'r-0002')) {
      const db = new DatabaseSync(join(setDir, 'project.sqlite'));
      db.exec('DELETE FROM session');
      db.close();
    }
    return push.apply(events, added);
  };

  await call('start_run', { reset: true, repeats: 3 });
  await until(async () => repeatFailures.length > 0);
  assert.match(repeatFailures[0], /No login is recorded for "recruiter"/);
  const runs = (await call('get_project', {})).runs.reverse();
  const failed = await call('get_repeats', { group: runs[0].config.repeat!.group });
  assert.deepEqual([failed.compared, failed.running, failed.incomplete], [2, false, true], 'the set is over as the failure arrives');
  assert.deepEqual(runs.map((run) => [run.run_id, run.status]), [['r-0001', 'finished'], ['r-0002', 'finished']], 'the third never started');
  for (const run of runs) assert.equal((await call('get_events', { run_id: run.run_id, after_seq: null, persona_id: null })).filter((event) => event.type === 'run.reset_called').length, 1, run.run_id);
  const [first, second] = runs.map((run) => run.config.sessions[0].verified_at!);
  assert.ok(first > 1 && second > first, 'the login was checked again');
  await assert.rejects(call('start_run', { reset: false }), /No login is recorded/, 'the set is over, so the project can start again');
  await call('open_project', { dir });
});

test('duplicate_run reruns a finished run on its frozen config and personas, and compare_runs reads the two', async (t) => {
  await call('open_project', { dir: join(dir, 'rerun') });
  const { id } = await call('import_asset', { text: '# Pricing\n\nStarter is $10 a month.', name: 'pricing.md' });
  const text = { id: 'poi-text', type: 'text' as const, name: 'Pricing', asset: id, segments: null };
  await call('save_project', { project: project({}, { pois: [text], settings: { ...DEFAULT_SETTINGS, cost_budget_usd: 3 } }) });
  const ended = async (run_id: string) => until(async () => (await call('get_session_runs', {})).some((run) => run.run_id === run_id && run.project_dir === join(dir, 'rerun') && run.status === 'finished'));

  await assert.rejects(call('duplicate_run', { run_id: 'r-9999', reset: false }), /There is no run r-9999/);
  const { run_id: first } = await call('start_run', { reset: false });
  await assert.rejects(call('duplicate_run', { run_id: first, reset: false }), /is running, and only a finished run/, 'a run in progress is not finished');
  await ended(first);
  const original = (await call('get_project', {})).runs.find((run) => run.run_id === first)!;

  // Edits since then are for the next start: the rerun keeps what the run froze.
  await call('save_project', { project: project({}, { goal: 'Changed since', pois: [text] }) });
  assert.equal((await call('estimate_run', { run_id: first, repeats: 2 })).calls, (await call('estimate_run', { run_id: first })).calls * 2);
  const { run_id: second } = await call('duplicate_run', { run_id: first, reset: false });
  assert.notEqual(second, first);
  await assert.rejects(call('duplicate_run', { run_id: first, reset: false }), /already in progress/);
  await ended(second);
  const again = (await call('get_project', {})).runs.find((run) => run.run_id === second)!;
  assert.deepEqual([again.config.project.goal, again.config.seed, again.config.signals, again.config.personas], [original.config.project.goal, original.config.seed, original.config.signals, original.config.personas]);
  assert.equal(again.config.project.settings.cost_budget_usd, 3);

  const diff = await call('compare_runs', { base: first, run: second });
  assert.deepEqual([diff.before, diff.after], [[first], [second]]);
  assert.ok(diff.themes.length > 0 && diff.themes.every((theme) => theme.status === 'unchanged'), JSON.stringify(diff.themes));
  await assert.rejects(call('compare_runs', { base: first, run: first }), /one run or one repeat set/);
  await assert.rejects(call('compare_runs', { base: first, run: 'r-9999' }), /There is no run r-9999/);

  // A set rerun as a set, and the set against one run: the comparison uses the set's finished runs.
  const { run_id: third } = await call('duplicate_run', { run_id: first, reset: false, repeats: 2 });
  const group = (await call('get_project', {})).runs.find((run) => run.run_id === third)!.config.repeat!.group;
  await until(async () => (await inSet(group)).filter((run) => run.status === 'finished').length === 2);
  await until(async () => (await call('get_session_runs', {})).filter((run) => run.project_dir === join(dir, 'rerun') && run.status === 'finished').length === 4);
  const runs = await inSet(group);
  assert.deepEqual(runs.map((run) => run.config.project.settings.cost_budget_usd), [1.5, 1.5]);
  const set = await call('compare_runs', { base: first, run: third });
  assert.deepEqual(set.after, runs.map((run) => run.run_id));
  assert.ok(set.themes.every((theme) => theme.after.of === 2 && theme.after.seen_in === 2 && theme.status === 'unchanged'));
  await assert.rejects(call('compare_runs', { base: runs[0].run_id, run: runs[1].run_id }), /one run or one repeat set/);
  t.diagnostic(`compared ${set.themes.length} themes`);
});

test('duplicate_run refuses a stopped run, unknown POI and a production address, and moves a web POI to its new address', async (t) => {
  await call('open_project', { dir: join(dir, 'rerun-web') });
  const [old, next] = [await startGym({ port: 0, defects: 'none' }), await startGym({ port: 0, defects: 'none' })];
  t.after(() => Promise.allSettled([old.close(), next.close()]));
  await call('save_project', { project: project({ start_url: `${old.url}/`, production_domains: ['acme.com'], reset_hook_url: `${old.url}/__reset` }) });
  const { run_id } = await call('start_run', { reset: true });
  await until(async () => (await call('get_session_runs', {})).some((run) => run.run_id === run_id && run.project_dir === join(dir, 'rerun-web') && run.status === 'finished'));

  await assert.rejects(call('duplicate_run', { run_id, reset: false, urls: { 'poi-9': next.url } }), /no web point of interest "poi-9"/);
  await assert.rejects(call('duplicate_run', { run_id, reset: false, urls: { 'poi-1': 'https://app.acme.com/' } }), /lists as production/);
  await old.close(); // a restarted Gym: its old address is gone, so a hook left there would fail the run
  const { run_id: moved } = await call('duplicate_run', { run_id, reset: true, urls: { 'poi-1': `${next.url}/` } });
  await until(async () => (await call('get_session_runs', {})).some((run) => run.run_id === moved && run.project_dir === join(dir, 'rerun-web') && run.status !== 'running'));
  const report = await call('get_report', { run_id: moved });
  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.equal(report.pois[0].start_url, `${next.url}/`);
  assert.equal(report.methods.reset?.url, `${next.url}/__reset`);
  assert.ok((await call('get_events', { run_id: moved, after_seq: null, persona_id: null })).some((e) => e.type === 'persona.step' && e.payload.result.url_before.startsWith(next.url)));
  assert.equal(((await call('get_project', {})).project!.pois[0] as WebPoi).start_url, `${old.url}/`, 'the project itself stays as it was');

  const store = openProject(join(dir, 'rerun-web'));
  store.finishRun(moved, 'stopped', 'user', 0);
  store.close();
  await assert.rejects(call('duplicate_run', { run_id: moved, reset: false }), /is stopped, and only a finished run/);
});

test('a rerun at a new address takes a recorded login with it: with the old build still up, logged-in personas would open it', async (t) => {
  const [old, next] = [await startGym({ port: 0, defects: 'none' }), await startGym({ port: 0, defects: 'none' })];
  t.after(() => Promise.allSettled([old.close(), next.close()]));
  const folder = join(dir, 'rerun-login');
  await call('open_project', { dir: folder });
  await call('set_secret', { name: 'session_key', value: key });
  await call('save_project', { project: project({ start_url: `${old.url}/` }, { role: 'recruiter' }) });
  const login = openProject(folder);
  await createSessionStore(login, createFsBlobStore(folder), key).save({ role: 'recruiter', start_url: `${old.url}/jobs`, hosts: [new URL(old.url).host], recorded_at: 1, verified_at: 1, expires_at: null }, { cookies: [] });
  login.close();
  const ended = (run_id: string) => until(async () => (await call('get_session_runs', {})).some((run) => run.run_id === run_id && run.project_dir === folder && run.status !== 'running'));
  const { run_id } = await call('start_run', { reset: false });
  await ended(run_id);
  const { run_id: moved } = await call('duplicate_run', { run_id, reset: false, urls: { 'poi-1': `${next.url}/` } });
  await ended(moved);

  const info = await call('get_project', {});
  assert.equal(info.runs.find((run) => run.run_id === moved)?.config.sessions[0].start_url, `${next.url}/jobs`);
  assert.equal(info.sessions[0].start_url, `${old.url}/jobs`, 'the recorded login itself stays as it was');
  const pages = (await call('get_events', { run_id: moved, after_seq: null, persona_id: null })).flatMap((e) => (e.type === 'persona.step' ? [e.payload.result.url_before] : []));
  assert.ok(pages.length > 0 && pages.every((url) => url.startsWith(next.url)), pages.join(' '));
  await call('open_project', { dir });
});
