// tech.md §14 item 4 and the M1 and M2 acceptance criteria (roadmap), as scripted-model end-to-end tests: the real Gym,
// browser, event log, blob and session stores; only the models are scripted. Needs an installed Chrome (or Edge).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test, type TestContext } from 'node:test';
import type { Page } from 'playwright-core';
import { GYM_ACCOUNTS, startGym } from '../../gym/server.ts';
import { DEMO_PERSONA_WRITER, syncPersonas } from './audience/index.ts';
import { launchBrowserPool } from '@gnomi/simulation/browser/pool.ts';
import { createScriptedGateway, DEMO_NAVIGATOR, DEMO_SURVEY, findRef } from '@gnomi/simulation/llm/scripted.ts';
import { createFsBlobStore } from '@gnomi/simulation/log/blobs.ts';
import { openProject } from '@gnomi/simulation/log/sqlite.ts';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { buildReport } from '@gnomi/simulation/report/build.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from '@gnomi/simulation/run.ts';
import { allowedHosts, checkTarget } from '@gnomi/simulation/safety.ts';
import { createSessionStore } from './sessions.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { BrowserPool, LlmGateway, LlmRequest, Responder, SessionStore } from '@gnomi/simulation/seams.ts';
import type { Audience, EventOf, GnomiEvent, Persona, ProjectConfig, RunSettings, Segment, SessionInfo, WebPoi } from '@gnomi/simulation/types.ts';

const web = (project: ProjectConfig) => project.pois[0] as WebPoi;

// The M0 no-credentials harness: strings a login would use must never reach a model transcript (roadmap M0).
const CANARIES = ['gnomi-canary-password-7Q2x', 'canary.recruiter@gym.test', 'sk-ant-canary-00000000'];
const M0_DEFECTS = 'D01,D02,D03';

const ref = (req: LlmRequest<unknown>, role: string, name: string) => {
  const found = findRef(req, role, name);
  if (!found) throw new Error(`No ${role} "${name}" in the snapshot`);
  return found;
};
const say = (thought: string, action: { type: string; ref?: string; text?: string }, friction: object | null = null) => ({
  thought,
  feeling: friction ? -1 : 0,
  action: { ref: null, text: null, ...action },
  friction,
});
const of = <K extends GnomiEvent['type']>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);
type Entry = object | ((req: LlmRequest<unknown>) => unknown);
/** A walk for one persona: its n-th model call gets the n-th entry. */
const walk = (entries: Entry[]): Responder => {
  let next = 0;
  return (req) => {
    const entry = entries[next++];
    if (!entry) throw new Error('the walk ran out');
    return typeof entry === 'function' ? entry(req) : entry;
  };
};
const toJobs: Entry[] = [
  (req) => say('All the jobs are one click away.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
  say('That is the list.', { type: 'done', text: 'Reached the jobs list' }),
];
const segment = (id: string, share: number, over: Partial<Segment> = {}): Segment => ({
  id,
  name: `Segment ${id}`,
  description: 'People who hire at mid-size companies',
  share,
  role: null,
  usage_frequency: 'weekly',
  typical_goals: ['post a job'],
  mobile_share: 0.25,
  patience: [1, 5],
  tech_skill: [1, 5],
  account_state: 'populated',
  entry: 'direct',
  goal_override: null,
  ...over,
});
const audienceOf = (segments: Segment[], persona_count: number): Audience => ({
  seed: 2026,
  persona_count,
  segments,
  company_size: [50, 2000],
  languages: { en: 0.8, de: 0.2 },
  accessibility: { none: 0.85, low_vision: 0.05, colour_blind: 0.05, screen_reader: 0.03, motor: 0.02 },
});

let browsers: BrowserPool;
before(async () => {
  browsers = await launchBrowserPool();
});
after(() => browsers?.close());

/** A Gym, a project folder and its stores, released when the test ends, and ways to sample and run personas in them. */
async function world(t: TestContext, gymOptions: Parameters<typeof startGym>[0] = {}) {
  // Each resource is released even when a later one fails to start, or an open server keeps the process alive.
  const gym = await startGym({ port: 0, defects: 'none', ...gymOptions });
  t.after(() => gym.close());
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-e2e-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openProject(dir);
  t.after(() => store.close());
  const blobs = createFsBlobStore(dir);
  const sessions = createSessionStore(store, blobs, randomBytes(32).toString('hex'));
  const project: ProjectConfig = {
    name: 'Gym ATS',
    description: 'A demo applicant tracking system.',
    pois: [{ id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: `${gym.url}/`, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null, mode: 'full', segments: null }],
    goal: 'Post a job for a backend engineer',
    role: null,
    audience: null,
    settings: DEFAULT_SETTINGS,
  };
  store.saveProject(project);

  /** Samples and writes the audience's personas with the scripted writer, counting its calls. */
  const sample = async (audience: Audience, existing: Persona[] = []) => {
    let calls = 0;
    const scripted = createScriptedGateway({ persona_writer: DEMO_PERSONA_WRITER }, createRecorder(store, () => {}));
    const llm: LlmGateway = {
      async call<T>(req: LlmRequest<T>) {
        calls++;
        return scripted.call(req);
      },
    };
    const { personas } = await syncPersonas(audience, existing, { llm, model: project.settings.routing.persona_writer, project: { ...project, audience } });
    return { personas, calls };
  };

  const go = async (
    navigator: Responder,
    opts: {
      project?: ProjectConfig;
      personas?: Persona[];
      sessions?: SessionInfo[];
      settings?: Partial<RunSettings>;
      reset?: boolean;
      pauseMs?: number;
      costPerCall?: number;
      /** Runs before the n-th model call of the run, so a step can change the world first. */
      beforeCall?: (n: number) => Promise<void>;
      /** Answers the surveys; the demo survey by default. */
      survey?: Responder;
      onEvent?: (e: GnomiEvent, run: RunHandle) => void;
    } = {},
  ) => {
    let handle: RunHandle | undefined;
    const record = createRecorder(store, (e) => handle && opts.onEvent?.(e, handle));
    // Walks script the steps only; every persona answers the demo survey at the end unless the test answers it.
    const scripted = createScriptedGateway({ navigator: (req) => (req.purpose === 'survey' ? (opts.survey ?? (() => DEMO_SURVEY))(req) : navigator(req)) }, record, { costPerCall: opts.costPerCall ?? 0 });
    let calls = 0;
    const llm: LlmGateway = {
      async call<T>(req: LlmRequest<T>) {
        await opts.beforeCall?.(calls++);
        return scripted.call(req);
      },
    };
    const base = opts.project ?? project;
    const target = { ...base, settings: { ...base.settings, ...opts.settings } };
    assert.equal(checkTarget(web(target)), null);
    const defaults = newRunConfig(target, { personas: opts.personas ?? [BUILTIN_PERSONA], sessions: opts.sessions ?? [], reset: opts.reset ?? false });
    const config = store.createRun({ ...defaults, pause_timeout_ms: opts.pauseMs ?? defaults.pause_timeout_ms });
    const started = Date.now();
    handle = startRun(config, { store, blobs, browsers, llm, record, sessions });
    const report = await handle.done;
    return { config, report, events: store.events(config.run_id), ms: Date.now() - started };
  };
  return { gym, dir, store, sessions, project, sample, go };
}

/** Logs in through the recorder as a person would, and saves the session the way host.ts's save_session does. */
async function recordLogin(gymUrl: string, sessions: SessionStore, account: (typeof GYM_ACCOUNTS)[number] = GYM_ACCOUNTS[0]) {
  const recording = await browsers.record(`${gymUrl}/`, { headless: true });
  const page = recording.page as Page;
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Password').fill(account.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Dashboard' }).waitFor();
  const login = await recording.finish();
  const now = Date.now();
  const info: SessionInfo = { role: account.role, start_url: login.start_url, hosts: login.hosts, recorded_at: now, verified_at: now, expires_at: login.expires_at };
  await sessions.save(info, login.storageState);
  const cookies = (login.storageState as { cookies: { name: string; value: string }[] }).cookies;
  return { info, cookie: cookies.find((c) => c.name === 'gym_session')?.value ?? '' };
}

// —— M0 ——

test('a mobile persona completes signup with matching passwords instead of abandoning a masked field', async (t) => {
  const w = await world(t);
  const password = 'Synthetic-Signup-42!';
  let accepted = false;
  const site = createServer(async (req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data = new URLSearchParams(body);
      accepted = data.get('password') === password && data.get('confirmation') === password;
      res.statusCode = accepted ? 200 : 422;
      res.end(`<h1>${accepted ? 'Account created' : 'Password required'}</h1>`);
    } else {
      res.end('<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><h1>Join</h1><form method="post"><label>Password<input name="password" type="password" autocomplete="new-password" required></label><label>Confirm password<input name="confirmation" type="password" autocomplete="new-password" required></label><button>Create account</button></form>');
    }
  });
  await new Promise<void>((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => site.close(() => resolve())));
  const start_url = `http://127.0.0.1:${(site.address() as AddressInfo).port}/register`;
  const project = { ...w.project, goal: 'Create an account', pois: [{ ...web(w.project), start_url }] };
  const { report, events } = await w.go(walk([
    (req) => say('Choose a password.', { type: 'type', ref: ref(req, 'textbox', 'Password'), text: password }),
    (req) => {
      const prompt = req.user.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      assert.match(prompt, /textbox "Password"[^\n]*\[password: filled\]/);
      assert.match(prompt, /text entered/);
      return say('Repeat it in confirmation.', { type: 'type', ref: ref(req, 'textbox', 'Confirm password'), text: password });
    },
    (req) => say('Both fields are filled.', { type: 'click', ref: ref(req, 'button', 'Create account') }),
    (req) => {
      ref(req, 'heading', 'Account created');
      return say('My account is ready.', { type: 'done', text: 'Account created' });
    },
  ]), { project, personas: [{ ...BUILTIN_PERSONA, device: 'mobile' }] });
  assert.equal(accepted, true, 'the local signup server received matching non-empty passwords');
  assert.equal(report.status, 'finished');
  assert.equal(of(events, 'persona.goal_done').length, 1);
  assert.equal(of(events, 'persona.abandoned').length, 0);
  assert.equal(of(events, 'persona.blocked').length, 0, 'a public signup is not an expired recorded session');
  assert.ok(of(events, 'persona.step').every((e) => e.payload.result.ok));
});

test('a scripted persona walks the Gym: frictions with screenshots, a report from the log alone, no canaries', async (t) => {
  const w = await world(t, { defects: M0_DEFECTS });
  const { report, events, config } = await w.go(
    walk([
      (req) => say('Jobs is right there in the menu.', { type: 'click', ref: ref(req, 'link', 'Jobs') }),
      say('Page not found, from the main menu? Back I go.', { type: 'back' }, { severity: 3, what: 'The Jobs link in the main menu opens "Page not found"', expected: 'The list of jobs' }),
      (req) => say('This one should get me there.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
      (req) => say('Create job.', { type: 'click', ref: ref(req, 'link', 'Create job') }),
      (req) => say('Title first.', { type: 'type', ref: ref(req, 'textbox', 'Job title *'), text: 'Backend Engineer' }),
      (req) => say('Remote, like the others.', { type: 'type', ref: ref(req, 'textbox', 'Location'), text: 'Remote (EU)' }),
      (req) => say('Full-time.', { type: 'select', ref: ref(req, 'combobox', 'Employment type'), text: 'Full-time' }),
      (req) => say('One line will do.', { type: 'type', ref: ref(req, 'textbox', 'Description'), text: 'Build the APIs behind our hiring pipeline.' }),
      (req) =>
        say('Save draft? I want it live, but it is the only button.', { type: 'click', ref: ref(req, 'button', 'Save draft') }, {
          severity: 2,
          what: 'The only button on the job form says "Save draft"',
          expected: 'A button that publishes the job',
        }),
      (req) =>
        say('Nothing happened and no error. Department, maybe?', { type: 'select', ref: ref(req, 'combobox', 'Department'), text: 'Engineering' }, {
          severity: 4,
          what: 'Saving the job did nothing and showed no error',
          expected: 'The job saved, or a message saying what is missing',
        }),
      (req) => say('Again.', { type: 'click', ref: ref(req, 'button', 'Save draft') }),
      say('It says published, though I clicked Save draft.', { type: 'done', text: 'Published the Backend Engineer job' }),
    ]),
  );

  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  assert.equal(report.stop_reason, null);
  assert.deepEqual([report.status, report.personas[0].outcome, report.steps], ['finished', 'done', 12]);
  const steps = of(events, 'persona.step');
  assert.equal(steps[0].payload.result.url_after, `${w.gym.url}/job`, 'D03: the nav Jobs link is dead');
  assert.match(steps.at(-2)?.payload.result.url_after ?? '', /\/jobs\/\d+\?published=1$/);

  assert.equal(report.frictions.length, 3);
  assert.equal(report.frictions[0].url, `${w.gym.url}/job`);
  for (const friction of report.frictions) assert.ok(friction.screenshot && existsSync(join(w.dir, friction.screenshot)), `${friction.screenshot}`);
  assert.deepEqual(JSON.parse(readFileSync(join(w.dir, 'runs', config.run_id, 'report.json'), 'utf8')), report);
  assert.equal(w.store.transcripts(config.run_id).length, of(events, 'llm.call').length);

  const reopened = openProject(w.dir);
  t.after(() => reopened.close());
  assert.deepEqual(buildReport(reopened.events(config.run_id)), report);
  const transcripts = JSON.stringify(reopened.transcripts(config.run_id));
  for (const canary of CANARIES) assert.ok(!transcripts.includes(canary), `canary ${canary} reached a transcript`);
});

// —— M1 ——

test('M1 (a): with a recorded login the persona works inside the app, and no credential or cookie value leaks', async (t) => {
  const w = await world(t, { login: true });
  const account = GYM_ACCOUNTS[0];
  const { info, cookie } = await recordLogin(w.gym.url, w.sessions, account);
  assert.equal(info.start_url, `${w.gym.url}/`);
  assert.ok(cookie.length >= 32, 'the recording holds the session cookie');
  const project = { ...w.project, role: account.role };
  const saved = await w.sessions.load(account.role);
  assert.ok(saved);
  assert.deepEqual(await browsers.checkSession({ storageState: saved.state, startUrl: info.start_url, allowedHosts: allowedHosts(web(project)), blockedDomains: [] }), {
    ok: true,
    url: `${w.gym.url}/`,
    reason: null,
  });

  const { report, events, config } = await w.go(walk(toJobs), { project, sessions: [info] });
  assert.deepEqual([report.status, report.personas[0].outcome, report.methods.roles], ['finished', 'done', ['recruiter']]);
  assert.equal(of(events, 'persona.step')[0].payload.result.url_after, `${w.gym.url}/jobs`);
  const transcripts = JSON.stringify(w.store.transcripts(config.run_id));
  assert.match(transcripts, /Signed in as Priya Natarajan/, 'the persona saw the logged-in app');
  const logged = JSON.stringify(events) + transcripts;
  for (const secret of [account.email, account.password, cookie]) assert.ok(!logged.includes(secret), `${secret} reached the log`);
  const sealed = readFileSync(join(w.dir, 'sessions', `${account.role}.session`));
  assert.ok(!sealed.includes(cookie) && !sealed.includes('gym_session'), 'the session blob is encrypted');
  for (const file of ['project.sqlite', 'project.sqlite-wal'].filter((f) => existsSync(join(w.dir, f)))) {
    const bytes = readFileSync(join(w.dir, file));
    for (const secret of [account.email, account.password, cookie]) assert.ok(!bytes.includes(secret), `${secret} is in ${file}`);
  }
});

test('M1 (b): containment keeps an unlisted host unreached through the check and the run, until it is allowed', async (t) => {
  const hits: string[] = [];
  const tracker = createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(204).end();
  });
  await new Promise<void>((resolve) => tracker.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    tracker.closeAllConnections();
    return new Promise<void>((resolve) => tracker.close(() => resolve()));
  });
  const w = await world(t, { login: true, thirdParty: `http://127.0.0.1:${(tracker.address() as AddressInfo).port}` });
  const { info } = await recordLogin(w.gym.url, w.sessions);
  assert.ok(info.hosts.includes('127.0.0.1'), 'the recorder lists the hosts it saw, for the allowlist');
  hits.length = 0; // the recorder is deliberately not contained: SSO passes through hosts nobody has listed yet

  const project = { ...w.project, role: 'recruiter' };
  const saved = await w.sessions.load('recruiter');
  assert.ok(saved);
  const check = await browsers.checkSession({ storageState: saved.state, startUrl: info.start_url, allowedHosts: allowedHosts(web(project)), blockedDomains: [] });
  assert.equal(check.ok, true);
  const contained = await w.go(walk(toJobs), { project, sessions: [info] });
  assert.equal(contained.report.personas[0].outcome, 'done');
  assert.deepEqual(hits, [], 'nothing reached the unlisted host');
  const blocked = of(contained.events, 'containment.blocked_request');
  assert.ok(blocked.length > 0 && blocked.every((e) => e.payload.host === '127.0.0.1'));
  assert.equal(contained.report.methods.blocked_requests[0].host, '127.0.0.1');

  const allowed = { ...project, pois: [{ ...web(project), allowed_hosts: ['127.0.0.1'] }] };
  const open = await w.go(walk(toJobs), { project: allowed, sessions: [info] });
  assert.ok(hits.length > 0, 'an allowed host is reached');
  assert.equal(of(open.events, 'containment.blocked_request').length, 0);
});

test('M1 (c): an expired session pauses the persona until the login is re-recorded, then she carries on', async (t) => {
  const w = await world(t, { login: true });
  const { info } = await recordLogin(w.gym.url, w.sessions);
  let rerecorded: Promise<void> | undefined;
  const { report, events } = await w.go(
    walk([
      (req) => say('All the jobs, please.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
      (req) => say('Where was I? The jobs.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
      say('There they are.', { type: 'done', text: 'Reached the jobs list' }),
    ]),
    {
      project: { ...w.project, role: 'recruiter' },
      sessions: [info],
      beforeCall: async (n) => {
        if (n === 0) await fetch(`${w.gym.url}/__sessions/expire`, { method: 'POST' }); // the staging app drops every session
      },
      onEvent: (e, run) => {
        if (e.type === 'persona.blocked') rerecorded = recordLogin(w.gym.url, w.sessions).then(() => run.resume('p-001'));
      },
    },
  );
  await rerecorded;
  assert.deepEqual(
    of(events, 'persona.blocked').map((e) => [e.payload.step_no, e.payload.reason]),
    [[1, 'session_expired']],
  );
  assert.equal(of(events, 'persona.resumed').length, 1);
  const steps = of(events, 'persona.step');
  assert.equal(steps[0].payload.result.url_after, `${w.gym.url}/login?next=%2Fjobs`);
  assert.equal(steps[1].payload.result.url_after, `${w.gym.url}/jobs`, 'logged in again after the resume');
  assert.deepEqual([report.status, report.personas[0].outcome, report.methods.blocked[0].resumed], ['finished', 'done', true]);
});

test('M1 (d): a live payment key on Settings → Billing halts the run with a tripwire', async (t) => {
  const w = await world(t, { liveKey: true });
  const { report, events } = await w.go(
    walk([
      (req) => say('Settings, then billing.', { type: 'click', ref: ref(req, 'link', 'Settings') }),
      (req) => say('Billing.', { type: 'click', ref: ref(req, 'link', 'Billing') }),
      say('Never reached.', { type: 'done', text: 'Saw the plan' }),
    ]),
  );
  assert.equal(of(events, 'persona.step').length, 2);
  assert.deepEqual(
    of(events, 'containment.tripwire').map((e) => e.payload.kind),
    ['live_payment_key'],
  );
  assert.deepEqual([report.status, of(events, 'run.stopped')[0].payload.reason], ['stopped', 'tripwire']);
  assert.match(report.stop_reason ?? '', /^tripwire: A live payment key \(pk_live_…\) is on http:\/\/localhost:\d+\/billing/);
  assert.equal(report.methods.tripwires.length, 1);
});

test('M1 (e): a captcha pauses the persona, and with nobody to resume her the episode ends blocked', async (t) => {
  const w = await world(t, { captcha: true });
  const { report, events } = await w.go(walk([(req) => say('Candidates next.', { type: 'click', ref: ref(req, 'link', 'Candidates') }), say('Never reached.', { type: 'done', text: 'Saw candidates' })]), {
    pauseMs: 300,
  });
  assert.deepEqual(
    of(events, 'persona.blocked').map((e) => [e.payload.step_no, e.payload.reason]),
    [[1, 'captcha']],
  );
  assert.deepEqual([report.status, report.personas[0].outcome], ['finished', 'blocked']);
  assert.equal(report.methods.blocked[0].resumed, false);
});

test('M1 (f): the reset hook resets staging before the persona is created', async (t) => {
  const w = await world(t);
  const created = await fetch(`${w.gym.url}/jobs`, { method: 'POST', body: new URLSearchParams({ title: 'Leftover from yesterday', department: 'Engineering' }), redirect: 'manual' });
  assert.equal(created.status, 303);
  assert.match(await (await fetch(`${w.gym.url}/jobs`)).text(), /Leftover from yesterday/);

  const hook = `${w.gym.url}/__reset`;
  const project = { ...w.project, pois: [{ ...web(w.project), reset_hook_url: hook }] };
  const { report, events } = await w.go(walk([say('Looks fine.', { type: 'done', text: 'Looked around' })]), { project, reset: true });
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('run.reset_called') < types.indexOf('persona.created'));
  assert.deepEqual(of(events, 'run.reset_called')[0].payload, { url: hook, status: 204, error: null });
  assert.deepEqual(report.methods.reset, { url: hook, status: 204, error: null });
  assert.doesNotMatch(await (await fetch(`${w.gym.url}/jobs`)).text(), /Leftover from yesterday/);
});

// —— M2 ——

/** The most episodes running at once, from the log: a persona is in flight from episode_started to her last event. */
function peakInFlight(events: GnomiEvent[]): number {
  const spans = new Map<string, [number, number]>();
  for (const e of events) {
    if (!e.persona_id || e.type === 'persona.created' || e.type === 'llm.call') continue;
    const span = spans.get(e.persona_id);
    spans.set(e.persona_id, span ? [span[0], e.seq] : [e.seq, e.seq]);
  }
  return Math.max(...[...spans.values()].map(([start]) => [...spans.values()].filter(([s, end]) => s <= start && end >= start).length));
}

test('a five-segment audience can generate and finish a run with just one persona', async (t) => {
  const w = await world(t);
  const audience = audienceOf([10, 50, 20, 15, 5].map((share, i) => segment(`seg-${i + 1}`, share)), 1);
  const { personas, calls } = await w.sample(audience);
  assert.equal(personas.length, 1);
  assert.equal(personas[0].segment_id, 'seg-2');
  assert.equal(calls, 2);
  const { config, report, events } = await w.go(walk(toJobs), { project: { ...w.project, audience }, personas });
  assert.equal(config.personas.length, 1);
  assert.equal(report.status, 'finished');
  assert.equal(report.personas.length, 1);
  assert.equal(report.personas[0].outcome, 'done');
  assert.equal(of(events, 'persona.created').length, 1);
  assert.equal(of(events, 'persona.goal_done').length, 1);
  assert.deepEqual(report.segments.map((s) => [s.id, s.personas]), [['seg-2', 1]]);
  assert.equal(report.weighted.completion, 1, 'unrepresented segments do not count as failed personas');
});

test('M2: 50 personas from a four-segment audience run at concurrency 12 on the Gym with all twelve defects', async (t) => {
  const w = await world(t, { defects: 'v1', candidatesDelayMs: 200 });
  const audience = audienceOf([segment('seg-1', 40), segment('seg-2', 30), segment('seg-3', 20), segment('seg-4', 10)], 50);
  const { personas } = await w.sample(audience);
  assert.equal(personas.length, 50);
  const project = { ...w.project, audience };
  const { report, events, ms } = await w.go(DEMO_NAVIGATOR, { project, personas, settings: { concurrency: 12 } });
  t.diagnostic(`50 personas, ${report.steps} steps, 12 at once: ${(ms / 1000).toFixed(1)} s`);
  assert.ok(ms < 30 * 60_000, `took ${ms} ms`);
  assert.ok(ms < 5 * 60_000, `well under 30 minutes: took ${ms} ms`);
  assert.equal(report.status, 'finished');
  assert.equal(of(events, 'persona.created').length, 50);
  assert.equal(report.personas.length, 50);
  assert.ok(report.personas.every((p) => p.outcome !== 'incomplete'), 'every persona finished her episode');
  assert.deepEqual(
    report.segments.map((s) => s.id),
    ['seg-1', 'seg-2', 'seg-3', 'seg-4'],
  );
  const peak = peakInFlight(events);
  assert.ok(peak <= 12 && peak >= 6, `peak in flight ${peak}`);
});

test('M2: the same audience and seed regenerate identical personas with no writer call, and a share change moves counts and the weighted report', async (t) => {
  const w = await world(t, { defects: M0_DEFECTS });
  const before = audienceOf([segment('seg-1', 40), segment('seg-2', 30), segment('seg-3', 20), segment('seg-4', 10)], 20);
  const first = await w.sample(before);
  assert.ok(first.calls > 0);
  const again = await w.sample(before, first.personas);
  assert.equal(again.calls, 0, 'no writer call for unchanged slots');
  assert.deepEqual(again.personas, first.personas);

  // A segment-dependent outcome, so the weighted completion shows the shares: seg-1 finishes, everyone else gives up.
  const bySegment = (people: Persona[]): Responder => {
    const segmentOf = new Map(people.map((p) => [p.id, p.segment_id]));
    return (req) => (segmentOf.get(req.persona_id ?? '') === 'seg-1' ? say('Done.', { type: 'done', text: 'Posted' }) : say('Not for me.', { type: 'abandon', text: 'Too fiddly' }));
  };
  const counts = (people: Persona[]) => Object.fromEntries(['seg-1', 'seg-2', 'seg-3', 'seg-4'].map((id) => [id, people.filter((p) => p.segment_id === id).length]));
  const run1 = await w.go(bySegment(first.personas), { project: { ...w.project, audience: before }, personas: first.personas });

  const after = { ...before, segments: before.segments.map((s) => ({ ...s, share: s.id === 'seg-1' ? 70 : 10 })) };
  const changed = await w.sample(after, first.personas);
  assert.notDeepEqual(counts(changed.personas), counts(first.personas));
  assert.ok(counts(changed.personas)['seg-1'] > counts(first.personas)['seg-1']);
  const run2 = await w.go(bySegment(changed.personas), { project: { ...w.project, audience: after }, personas: changed.personas });

  assert.ok(Math.abs(run1.report.weighted.completion - 0.4) < 1e-9, `weighted completion ${run1.report.weighted.completion}`);
  assert.ok(Math.abs(run2.report.weighted.completion - 0.7) < 1e-9, `weighted completion ${run2.report.weighted.completion}`);
  assert.deepEqual(
    run2.report.segments.map((s) => [s.id, s.personas]),
    Object.entries(counts(changed.personas)),
  );
});

test('M2: a cost budget stops a concurrent run within one step per persona in flight, and still reports', async (t) => {
  const w = await world(t, { defects: M0_DEFECTS });
  const audience = audienceOf([segment('seg-1', 50), segment('seg-2', 50)], 30);
  const { personas } = await w.sample(audience);
  const costPerCall = 0.01;
  const budget = 0.25;
  const concurrency = 8;
  const { report, events, config } = await w.go(DEMO_NAVIGATOR, { project: { ...w.project, audience }, personas, costPerCall, settings: { concurrency, cost_budget_usd: budget } });
  assert.deepEqual(
    of(events, 'run.stopped').map((e) => e.payload.reason),
    ['cost_budget'],
  );
  assert.ok(report.cost_usd <= budget + concurrency * costPerCall + 1e-9, `spent ${report.cost_usd}`);
  assert.ok(report.cost_usd >= budget - (concurrency + 1) * costPerCall - 1e-9, `stopped early: ${report.cost_usd}`);
  assert.ok(report.personas.some((p) => p.outcome === 'incomplete'), 'later personas never started');
  assert.ok(existsSync(join(w.dir, 'runs', config.run_id, 'report.json')));
});

test('M2: two segments on different roles each log in with their own recorded session', async (t) => {
  const w = await world(t, { login: true });
  const recruiter = await recordLogin(w.gym.url, w.sessions, GYM_ACCOUNTS[0]);
  const manager = await recordLogin(w.gym.url, w.sessions, GYM_ACCOUNTS[1]);
  const audience = audienceOf([segment('seg-r', 50, { role: 'recruiter' }), segment('seg-m', 50, { role: 'hiring_manager' })], 6);
  const { personas } = await w.sample(audience);
  const { report, config } = await w.go(
    () => say('Seen enough.', { type: 'done', text: 'Looked around' }),
    { project: { ...w.project, audience }, personas, sessions: [recruiter.info, manager.info], settings: { concurrency: 6 } },
  );
  assert.equal(report.status, 'finished');
  assert.deepEqual(report.methods.roles.sort(), ['hiring_manager', 'recruiter']);
  const seen = new Map<string, string>();
  for (const { seq, request_json } of w.store.transcripts(config.run_id)) {
    const call = w.store.events(config.run_id).find((e) => e.seq === seq);
    if (!seen.has(call?.persona_id ?? '')) seen.set(call?.persona_id ?? '', request_json); // the step, not the survey after it
  }
  for (const p of personas) {
    const expected = p.segment_id === 'seg-r' ? /Signed in as Priya Natarajan · Recruiter/ : /Signed in as Dana Okafor · Hiring manager/;
    assert.match(seen.get(p.id) ?? '', expected, `${p.id} (${p.segment_id}) saw the wrong login`);
  }
});

// —— M3 ——

test('M3: a broken link and a rejected form raise signal.error and signal.validation_error right after their steps', async (t) => {
  const w = await world(t, { defects: 'D03' });
  const { events } = await w.go(
    walk([
      (req) => say('Jobs is in the menu.', { type: 'click', ref: ref(req, 'link', 'Jobs') }),
      say('Page not found. Back.', { type: 'back' }),
      (req) => say('This one, then.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
      (req) => say('Create job.', { type: 'click', ref: ref(req, 'link', 'Create job') }),
      (req) => say('Publish and see what it asks for.', { type: 'click', ref: ref(req, 'button', 'Publish job') }),
      say('It wants a title. Enough for today.', { type: 'abandon', text: 'Ran out of time' }),
    ]),
  );
  const steps = of(events, 'persona.step');
  const [broken] = of(events, 'signal.error');
  assert.deepEqual(broken.payload, { step_no: 1, url: `${w.gym.url}/`, ref: steps[0].payload.action.ref, kind: 'http', status: 404, message: `GET ${w.gym.url}/job` });
  assert.equal(broken.seq, steps[0].seq + 1, 'written right after its step');
  assert.equal(of(events, 'signal.error').length, 1, "Chromium's console line for the 404 is not a second error");
  const [rejected] = of(events, 'signal.validation_error');
  assert.deepEqual(rejected.payload, { step_no: 5, url: `${w.gym.url}/jobs/new`, ref: steps[4].payload.action.ref, message: 'Enter a job title' });
  assert.equal(rejected.seq, steps[4].seq + 1);
  assert.deepEqual(of(events, 'signal.backtrack').map((e) => [e.payload.step_no, e.payload.kind]), [[2, 'revisit']], 'the back, not where the form posted to');
  assert.deepEqual(of(events, 'signal.failed_action'), [], 'every click did something');
});

// —— M5 ——

test('a persona runs Gym / and then Gym /locale, with a survey and themes for each POI', async (t) => {
  const w = await world(t);
  const project: ProjectConfig = {
    ...w.project,
    pois: [{ ...web(w.project), id: 'poi-home', name: 'Gym home' }, { ...web(w.project), id: 'poi-locale', name: 'Gym locale echo', start_url: `${w.gym.url}/locale` }],
  };
  const friction = (what: string) => ({ severity: 2, what, expected: 'A clearer page' });
  const { report, events } = await w.go(walk([
    (req) => say('All the jobs are one click away.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }, friction('The jobs link is easy to miss')),
    say('That is the list.', { type: 'done', text: 'Reached the jobs list' }),
    (req) => {
      assert.match(req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n'), /^Step 1 of \d+\./m, 'the second POI counts its own steps in the prompt');
      return say('Which language is this?', { type: 'done', text: 'Read the locale' }, friction('The page does not say what it is for'));
    },
  ]), { project });

  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  assert.deepEqual(of(events, 'persona.episode_started').map((e) => [e.poi_id, e.payload.start_url]), [['poi-home', `${w.gym.url}/`], ['poi-locale', `${w.gym.url}/locale`]]);
  assert.deepEqual(of(events, 'persona.step').map((e) => [e.poi_id, e.payload.step_no]), [['poi-home', 1], ['poi-home', 2], ['poi-locale', 3]]);
  for (const shot of of(events, 'persona.step').map((e) => e.payload.screenshot!)) assert.ok(existsSync(join(w.dir, shot)), shot);
  assert.deepEqual(of(events, 'persona.survey').map((e) => [e.poi_id, e.payload.poi_id]), [['poi-home', 'poi-home'], ['poi-locale', 'poi-locale']]);
  assert.deepEqual(report.pois.map((p) => [p.id, p.start_url]), [['poi-home', `${w.gym.url}/`], ['poi-locale', `${w.gym.url}/locale`]]);
  const themes = report.themes ?? [];
  assert.ok(themes.some((th) => th.poi_id === 'poi-home' && th.evidence.some((e) => e.what === 'The jobs link is easy to miss')));
  assert.ok(themes.some((th) => th.poi_id === 'poi-locale' && th.evidence.some((e) => e.what === 'The page does not say what it is for')));
  assert.ok(themes.every((th) => th.evidence.every((e) => e.step_no === null || (th.poi_id === 'poi-home') === (e.step_no <= 2))), 'evidence stays with its POI');
});

test('M5: an observe-only competitor on the Gym refuses a form submit before the network, logs it, and is compared with the product', async (t) => {
  const w = await world(t);
  const project: ProjectConfig = {
    ...w.project,
    pois: [{ ...web(w.project), id: 'poi-ours', name: 'Gym ATS' }, { ...web(w.project), id: 'poi-rival', name: 'Rival ATS', mode: 'observe_only', start_url: `${w.gym.url}/jobs/new` }],
  };
  const text = (req: LlmRequest<unknown>) => req.user.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  const surveys: LlmRequest<unknown>[] = [];
  const { report, events } = await w.go(walk([
    ...toJobs,
    (req) => {
      assert.match(req.system, /looking at Rival ATS, a competitor of Gym ATS/);
      assert.match(req.system, /never submits a form/);
      return say('Their form. A title first.', { type: 'type', ref: ref(req, 'textbox', 'Job title *'), text: 'Observed Engineer' });
    },
    (req) => say('Engineering.', { type: 'select', ref: ref(req, 'combobox', 'Department *'), text: 'Engineering' }),
    (req) => say('Publish it.', { type: 'click', ref: ref(req, 'button', 'Publish job') }),
    (req) => {
      assert.match(text(req), /click button "Publish job" → failed \(submit_blocked\)/);
      ref(req, 'heading', 'Create job');
      return say('Nothing can be sent here, and I have seen enough.', { type: 'done', text: 'Saw how their job form works' });
    },
  ]), {
    project,
    survey: (req) => {
      surveys.push(req);
      return /Also answer comparison/.test(text(req)) ? { ...DEMO_SURVEY, comparison: { prefers: 'product', reason: 'Gym ATS let me publish; I could only look at Rival ATS.' } } : DEMO_SURVEY;
    },
  });

  assert.equal(report.status, 'finished', report.stop_reason ?? '');
  const submit = of(events, 'persona.step').find((e) => e.poi_id === 'poi-rival' && e.payload.action.type === 'click')!;
  assert.deepEqual([submit.payload.result.ok, submit.payload.result.error], [false, 'submit_blocked']);
  assert.deepEqual(of(events, 'containment.blocked_request').map((e) => [e.poi_id, e.payload.method, e.payload.url, e.payload.reason]), [['poi-rival', 'POST', `${w.gym.url}/jobs`, 'observe_only']]);
  const jobs = await (await fetch(`${w.gym.url}/jobs`)).text();
  assert.ok(jobs.includes('<h1>Jobs</h1>') && !jobs.includes('Observed Engineer'), 'the Gym has no new job');

  assert.equal(surveys.length, 2);
  assert.doesNotMatch(text(surveys[0]), /comparison/, "the product's own survey asks no comparison");
  assert.match(text(surveys[1]), /This session was on Rival ATS[^\n]*beside Gym ATS[\s\S]*Earlier [^\n]* used Gym ATS/);
  assert.deepEqual(of(events, 'persona.survey').map((e) => [e.poi_id, e.payload.comparison ?? null]), [
    ['poi-ours', null],
    ['poi-rival', { with_poi_id: 'poi-ours', prefers: 'product', reason: 'Gym ATS let me publish; I could only look at Rival ATS.' }],
  ]);

  assert.deepEqual(report.pois.map((p) => [p.id, p.competitor ?? false]), [['poi-ours', false], ['poi-rival', true]]);
  assert.deepEqual(report.comparisons, [{
    poi_id: 'poi-rival',
    with_poi_id: 'poi-ours',
    segments: [{ segment_id: null, name: 'Built-in persona', compared: 1, product: 1, competitor: 0, no_preference: 0 }],
    answers: [{ seq: of(events, 'persona.survey')[1].seq, persona_id: BUILTIN_PERSONA.id, persona_name: BUILTIN_PERSONA.name, segment_id: null, prefers: 'product', reason: 'Gym ATS let me publish; I could only look at Rival ATS.' }],
  }]);
  assert.deepEqual(report.methods.blocked_requests, [{ host: 'localhost', count: 1, reason: 'observe_only' }]);
  // The persona's outcome, steps and the sentiment describe the team's product; the competitor is reported on its own.
  assert.deepEqual([report.personas[0].outcome, report.personas[0].outcome_text, report.personas[0].steps], ['done', 'Reached the jobs list', 2]);
  assert.equal(report.sentiment?.[0].surveyed, 1);
});
