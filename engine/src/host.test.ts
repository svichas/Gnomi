// host.ts is the Electron utility-process entry, driven here through a fake parent port in protocol.ts messages, with
// the scripted navigator and persona writer (GNOMI_FAKE_LLM). The shutdown message lets the test process exit.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { startGym } from '../../gym/server.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { createSessionStore } from './sessions.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { Api, EngineToClient, Method } from './protocol.ts';
import type { Audience, GnomiEvent, ProjectConfig, Segment } from './types.ts';

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
    else progress.push(msg);
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
const project = (poi: Partial<ProjectConfig['poi']> = {}, more: Partial<ProjectConfig> = {}): ProjectConfig => ({
  name: 'Acme',
  description: 'An applicant tracking system.',
  poi: { id: 'poi-1', type: 'web', name: 'Acme', start_url: 'https://staging.acme.io/', allowed_hosts: [], production_domains: ['acme.com'], not_production: false, reset_hook_url: null, ...poi },
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

test('record_session refuses a role the session store cannot name, and a production target, before any browser opens', async () => {
  await assert.rejects(call('record_session', { role: 'Recruiters team' }), /1–40 lowercase letters/);
  await call('save_project', { project: project({ start_url: 'https://www.acme.com/' }) });
  await assert.rejects(call('record_session', { role: 'recruiter' }), /lists as production/);
  await assert.rejects(call('save_session', {}), /No login recording is open/);
  assert.equal(await call('cancel_recording', {}), null);
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
