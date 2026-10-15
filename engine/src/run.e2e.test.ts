// tech.md §14 item 4 and the M1 acceptance criteria (roadmap M1), as scripted-model end-to-end tests: the real Gym,
// browser, event log, blob and session stores; only the model is scripted, walking the Gym by accessible names.
// Needs an installed Chrome (or Edge).
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
import { launchBrowserPool } from './browser/pool.ts';
import { createScriptedGateway, findRef, type Script } from './llm/scripted.ts';
import { createFsBlobStore } from './log/blobs.ts';
import { openProject } from './log/sqlite.ts';
import { buildReport } from './report/build.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import { allowedHosts, checkTarget } from './safety.ts';
import { createSessionStore } from './sessions.ts';
import type { BrowserPool, LlmGateway, LlmRequest, SessionStore } from './seams.ts';
import type { EventOf, GnomiEvent, ProjectConfig, SessionInfo } from './types.ts';

// The M0 no-credentials harness: strings a login would use must never reach a model transcript (roadmap M0).
const CANARIES = ['gnomi-canary-password-7Q2x', 'canary.recruiter@gym.test', 'sk-ant-canary-00000000'];

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
const toJobs: Script = [
  (req) => say('All the jobs are one click away.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
  say('That is the list.', { type: 'done', text: 'Reached the jobs list' }),
];

let browsers: BrowserPool;
before(async () => {
  browsers = await launchBrowserPool();
});
after(() => browsers?.close());

/** A Gym, a project folder and its stores, released when the test ends, and a way to run a scripted persona in them. */
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
  };
  store.saveProject(project);

  const go = async (
    script: Script,
    opts: {
      project?: ProjectConfig;
      session?: SessionInfo | null;
      reset?: boolean;
      pauseMs?: number;
      /** Runs before the n-th model call, so a step can change the world first. */
      beforeCall?: (n: number) => Promise<void>;
      onEvent?: (e: GnomiEvent, run: RunHandle) => void;
    } = {},
  ) => {
    let handle: RunHandle | undefined;
    const record = createRecorder(store, (e) => handle && opts.onEvent?.(e, handle));
    const scripted = createScriptedGateway(script, record);
    let calls = 0;
    const llm: LlmGateway = {
      async call<T>(req: LlmRequest<T>) {
        await opts.beforeCall?.(calls++);
        return scripted.call(req);
      },
    };
    const target = opts.project ?? project;
    assert.equal(checkTarget(target.poi), null);
    const defaults = newRunConfig(target, { session: opts.session ?? null, reset: opts.reset ?? false });
    const config = store.createRun({ ...defaults, pause_timeout_ms: opts.pauseMs ?? defaults.pause_timeout_ms });
    handle = startRun(config, { store, blobs, browsers, llm, record, sessions });
    const report = await handle.done;
    return { config, report, events: store.events(config.run_id) };
  };
  return { gym, dir, store, sessions, project, go };
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

test('a scripted persona walks the Gym: frictions with screenshots, a report from the log alone, no canaries', async (t) => {
  const w = await world(t, { defects: 'all' });
  const { report, events, config } = await w.go([
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
  ]);

  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
  assert.equal(report.stop_reason, null);
  assert.deepEqual([report.status, report.outcome, report.steps], ['finished', 'done', 12]);
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

  const { report, events, config } = await w.go(toJobs, { project, session: info });
  assert.deepEqual([report.status, report.outcome, report.methods.role], ['finished', 'done', 'recruiter']);
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
  const contained = await w.go(toJobs, { project, session: info });
  assert.equal(contained.report.outcome, 'done');
  assert.deepEqual(hits, [], 'nothing reached the unlisted host');
  const blocked = of(contained.events, 'containment.blocked_request');
  assert.ok(blocked.length > 0 && blocked.every((e) => e.payload.host === '127.0.0.1'));
  assert.equal(contained.report.methods.blocked_requests[0].host, '127.0.0.1');

  const allowed = { ...project, poi: { ...project.poi, allowed_hosts: ['127.0.0.1'] } };
  const open = await w.go(toJobs, { project: allowed, session: info });
  assert.ok(hits.length > 0, 'an allowed host is reached');
  assert.equal(of(open.events, 'containment.blocked_request').length, 0);
});

test('M1 (c): an expired session pauses the persona until the login is re-recorded, then she carries on', async (t) => {
  const w = await world(t, { login: true });
  const { info } = await recordLogin(w.gym.url, w.sessions);
  let rerecorded: Promise<void> | undefined;
  const { report, events } = await w.go(
    [
      (req) => say('All the jobs, please.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
      (req) => say('Where was I? The jobs.', { type: 'click', ref: ref(req, 'link', 'View all jobs') }),
      say('There they are.', { type: 'done', text: 'Reached the jobs list' }),
    ],
    {
      project: { ...w.project, role: 'recruiter' },
      session: info,
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
  assert.deepEqual([report.status, report.outcome, report.methods.blocked[0].resumed], ['finished', 'done', true]);
});

test('M1 (d): a live payment key on Settings → Billing halts the run with a tripwire', async (t) => {
  const w = await world(t, { liveKey: true });
  const { report, events } = await w.go([
    (req) => say('Settings, then billing.', { type: 'click', ref: ref(req, 'link', 'Settings') }),
    (req) => say('Billing.', { type: 'click', ref: ref(req, 'link', 'Billing') }),
    say('Never reached.', { type: 'done', text: 'Saw the plan' }),
  ]);
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
  const { report, events } = await w.go(
    [(req) => say('Candidates next.', { type: 'click', ref: ref(req, 'link', 'Candidates') }), say('Never reached.', { type: 'done', text: 'Saw candidates' })],
    { pauseMs: 300 },
  );
  assert.deepEqual(
    of(events, 'persona.blocked').map((e) => [e.payload.step_no, e.payload.reason]),
    [[1, 'captcha']],
  );
  assert.deepEqual([report.status, report.outcome], ['finished', 'blocked']);
  assert.equal(report.methods.blocked[0].resumed, false);
});

test('M1 (f): the reset hook resets staging before the persona is created', async (t) => {
  const w = await world(t);
  const created = await fetch(`${w.gym.url}/jobs`, { method: 'POST', body: new URLSearchParams({ title: 'Leftover from yesterday', department: 'Engineering' }), redirect: 'manual' });
  assert.equal(created.status, 303);
  assert.match(await (await fetch(`${w.gym.url}/jobs`)).text(), /Leftover from yesterday/);

  const hook = `${w.gym.url}/__reset`;
  const project = { ...w.project, poi: { ...w.project.poi, reset_hook_url: hook } };
  const { report, events } = await w.go([say('Looks fine.', { type: 'done', text: 'Looked around' })], { project, reset: true });
  const types = events.map((e) => e.type);
  assert.ok(types.indexOf('run.reset_called') < types.indexOf('persona.created'));
  assert.deepEqual(of(events, 'run.reset_called')[0].payload, { url: hook, status: 204, error: null });
  assert.deepEqual(report.methods.reset, { url: hook, status: 204, error: null });
  assert.doesNotMatch(await (await fetch(`${w.gym.url}/jobs`)).text(), /Leftover from yesterday/);
});
