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
import { launchBrowserPool } from './browser/pool.ts';
import { createScriptedGateway, DEMO_NAVIGATOR, findRef } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { buildReport } from './report/build.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import { allowedHosts, checkTarget } from './safety.ts';
import { createSessionStore } from './sessions.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { BrowserPool, LlmGateway, LlmRequest, Responder, SessionStore } from './seams.ts';
import type { Audience, EventOf, GnomiEvent, Persona, ProjectConfig, RunSettings, Segment, SessionInfo } from './types.ts';

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
    poi: { id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: `${gym.url}/`, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null },
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
      onEvent?: (e: GnomiEvent, run: RunHandle) => void;
    } = {},
  ) => {
    let handle: RunHandle | undefined;
    const record = createRecorder(store, (e) => handle && opts.onEvent?.(e, handle));
    const scripted = createScriptedGateway({ navigator }, record, { costPerCall: opts.costPerCall ?? 0 });
    let calls = 0;
    const llm: LlmGateway = {
      async call<T>(req: LlmRequest<T>) {
        await opts.beforeCall?.(calls++);
        return scripted.call(req);
      },
    };
    const base = opts.project ?? project;
    const target = { ...base, settings: { ...base.settings, ...opts.settings } };
    assert.equal(checkTarget(target.poi), null);
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
  assert.deepEqual(await browsers.checkSession({ storageState: saved.state, startUrl: info.start_url, allowedHosts: allowedHosts(project.poi), blockedDomains: [] }), {
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
  const check = await browsers.checkSession({ storageState: saved.state, startUrl: info.start_url, allowedHosts: allowedHosts(project.poi), blockedDomains: [] });
  assert.equal(check.ok, true);
  const contained = await w.go(walk(toJobs), { project, sessions: [info] });
  assert.equal(contained.report.personas[0].outcome, 'done');
  assert.deepEqual(hits, [], 'nothing reached the unlisted host');
  const blocked = of(contained.events, 'containment.blocked_request');
  assert.ok(blocked.length > 0 && blocked.every((e) => e.payload.host === '127.0.0.1'));
  assert.equal(contained.report.methods.blocked_requests[0].host, '127.0.0.1');

  const allowed = { ...project, poi: { ...project.poi, allowed_hosts: ['127.0.0.1'] } };
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
  const project = { ...w.project, poi: { ...w.project.poi, reset_hook_url: hook } };
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
    seen.set(call?.persona_id ?? '', request_json);
  }
  for (const p of personas) {
    const expected = p.segment_id === 'seg-r' ? /Signed in as Priya Natarajan · Recruiter/ : /Signed in as Dana Okafor · Hiring manager/;
    assert.match(seen.get(p.id) ?? '', expected, `${p.id} (${p.segment_id}) saw the wrong login`);
  }
});
