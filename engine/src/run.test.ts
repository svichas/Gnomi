// startRun and the step loop over in-memory fakes of the store, blobs, sessions and browser, with scripted models.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createScriptedGateway, DEMO_SCRIPT, findRef, type Script } from './llm/scripted.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import type { BlobStore, BrowserPool, LlmGateway, LlmRequest, PageOptions, ProjectStore, Recorder, SessionStore, StorageState } from './seams.ts';
import type { Action, ActionOutcome, ActionType, EventOf, EventType, GnomiEvent, PageFlags, ProjectConfig, RunConfig, SessionInfo } from './types.ts';

const project: ProjectConfig = {
  name: 'Gym ATS',
  description: '',
  poi: {
    id: 'poi-1',
    type: 'web',
    name: 'Gym ATS',
    start_url: 'http://gym.test/',
    allowed_hosts: ['cdn.gym.test'],
    production_domains: ['gym.com'],
    not_production: false,
    reset_hook_url: null,
  },
  goal: 'Post a job for a backend engineer',
  role: null,
};

const step = (type: ActionType, ref: string | null = null, text: string | null = null, friction: object | null = null) => ({
  thought: `Priya does a ${type}.`,
  feeling: 0,
  action: { type, ref, text },
  friction,
});

const of = <K extends EventType>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);

const recruiter: SessionInfo = { role: 'recruiter', start_url: 'http://gym.test/dashboard', hosts: ['gym.test'], recorded_at: 1, verified_at: 1, expires_at: null };

/** One recorded role whose storage state the test can swap, as a re-recording would. */
function fakeSessions(state: StorageState) {
  const saved = { state, loads: 0 };
  const sessions: SessionStore = {
    list: () => [recruiter],
    save: async (_info, next) => void (saved.state = next),
    load: async (role) => (role === recruiter.role ? (saved.loads++, { info: recruiter, state: saved.state }) : null),
    markVerified: () => {},
  };
  return { sessions, saved };
}

interface Options {
  config?: Partial<RunConfig>;
  /** Overrides an action's outcome; may call the page's onBlockedRequest as a browser would. */
  act?: (a: Action, page: PageOptions) => Partial<ActionOutcome>;
  /** Flags for the n-th inspection of the run (0 is the first load), across pages. */
  inspect?: (n: number) => Partial<PageFlags>;
  sessions?: SessionStore | null;
  onEvent?: (e: GnomiEvent, run: RunHandle) => void;
}

function begin(model: Script | ((record: Recorder) => LlmGateway), opts: Options = {}) {
  const events: GnomiEvent[] = [];
  const transcripts: { seq: number; request_json: string; response_json: string }[] = [];
  const finished: { status: string; stop_reason: string | null; cost_usd: number }[] = [];
  const store: ProjectStore = {
    dir: 'memory',
    getProject: () => project,
    saveProject: () => {},
    createRun: (snapshot) => ({ ...snapshot, run_id: 'r-0001' }),
    finishRun: (_run_id, status, stop_reason, cost_usd) => void finished.push({ status, stop_reason, cost_usd }),
    listRuns: () => [],
    append(event) {
      const stored = { ...event, seq: events.length + 1, ts: Date.now() } as GnomiEvent;
      events.push(stored);
      return stored;
    },
    events: (run_id, o = {}) => events.filter((e) => e.run_id === run_id && (!o.types || o.types.includes(e.type))),
    saveTranscript: (_run_id, seq, request, response) =>
      void transcripts.push({ seq, request_json: JSON.stringify(request), response_json: JSON.stringify(response) }),
    transcripts: () => transcripts,
    listSessions: () => [],
    putSession: () => {},
    close: () => {},
  };
  const files = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    put: async (path, data) => void files.set(path, data),
    get: async (path) => files.get(path) ?? Promise.reject(new Error(`no blob ${path}`)),
  };
  const pages: { url: string; gotos: string[]; closed: boolean; options: PageOptions }[] = [];
  let inspections = 0;
  const browsers: BrowserPool = {
    async newPage(options) {
      const page = { url: '', gotos: [] as string[], closed: false, options };
      pages.push(page);
      return {
        goto: async (url) => void page.gotos.push((page.url = url)),
        snapshot: async () => ({ url: page.url, title: 'Dashboard · Gym ATS', text: '- link "Jobs" [ref=e1]', hash: 'h1' }),
        screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        async act(action) {
          const outcome = { ok: true, url_before: page.url, url_after: page.url, dom_changed: true, error: null, target: { role: 'link', name: 'Jobs', box: null }, text: null, ...opts.act?.(action, options) };
          page.url = outcome.url_after;
          return outcome;
        },
        inspect: async () => ({ login: false, challenge: null, live_key: null, ...opts.inspect?.(inspections++) }),
        close: async () => void (page.closed = true),
      };
    },
    record: () => Promise.reject(new Error('not used')),
    checkSession: () => Promise.reject(new Error('not used')),
    close: async () => {},
  };
  let handle: RunHandle | undefined;
  const record = createRecorder(store, (e) => handle && opts.onEvent?.(e, handle));
  const llm = Array.isArray(model) ? createScriptedGateway(model, record) : model(record);
  const config = { ...store.createRun(newRunConfig(project, { session: null, reset: false })), ...opts.config };
  handle = startRun(config, { store, blobs, browsers, llm, record, sessions: opts.sessions ?? null });
  const run = handle;
  return { run, events, transcripts, finished, files, pages, types: () => events.map((e) => e.type) };
}

test('a run logs its lifecycle in seq order, keeps the evidence and writes report.json', async () => {
  const friction = { severity: 3, what: 'Jobs leads to a page not found', expected: 'The list of jobs' };
  const r = begin([step('click', 'e1', null, friction), step('done', null, 'Posted the job')]);
  const report = await r.run.done;

  assert.deepEqual(r.types(), [
    'run.started',
    'persona.created',
    'persona.episode_started',
    'llm.call',
    'persona.step',
    'persona.friction_reported',
    'llm.call',
    'persona.step',
    'persona.goal_done',
    'run.finished',
    'report.generated',
  ]);
  assert.deepEqual(
    r.events.map((e) => e.seq),
    r.events.map((_, i) => i + 1),
  );
  assert.ok(r.events.every((e) => e.run_id === 'r-0001' && e.round === 1));
  const [first] = of(r.events, 'persona.step');
  assert.deepEqual([first.persona_id, first.poi_id], ['p-001', 'poi-1']);
  assert.equal(first.payload.screenshot, 'runs/r-0001/shots/p-001-0001.jpg');
  assert.ok(r.files.has('runs/r-0001/shots/p-001-0001.jpg'));
  assert.deepEqual(first.payload.target, { role: 'link', name: 'Jobs', box: null });
  assert.deepEqual(of(r.events, 'persona.friction_reported')[0].payload, { step_no: 1, ...friction, where: { url: 'http://gym.test/', ref: 'e1' } });

  assert.equal(report.status, 'finished');
  assert.equal(report.outcome, 'done');
  assert.equal(report.outcome_text, 'Posted the job');
  assert.equal(report.frictions[0].screenshot, 'runs/r-0001/shots/p-001-0001.jpg');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.files.get('runs/r-0001/report.json'))), report);
  assert.deepEqual(of(r.events, 'report.generated')[0].payload, { path: 'runs/r-0001/report.json', friction_count: 1 });
  assert.deepEqual(r.finished, [{ status: 'finished', stop_reason: null, cost_usd: 0 }]);
  assert.ok(r.pages.every((p) => p.closed));
});

test('the step budget ends the episode exactly on the budget', async () => {
  const r = begin(Array(5).fill(step('scroll', null, 'down')), { config: { step_budget: 3 } });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'persona.step').map((e) => e.payload.step_no),
    [1, 2, 3],
  );
  assert.equal(of(r.events, 'llm.call').length, 3);
  assert.deepEqual(of(r.events, 'signal.budget_exceeded')[0].payload, { step_no: 3, budget: 3 });
  assert.equal(report.outcome, 'budget_exceeded');
  assert.equal(report.status, 'finished');
});

test('three identical failed actions in a row end the episode', async () => {
  const dead = step('click', 'e9');
  const r = begin([dead, dead, step('scroll', null, 'down'), dead, dead, dead, dead], {
    act: (a) => (a.ref === 'e9' ? { ok: false, error: 'ref_not_found', dom_changed: false, target: null } : {}),
  });
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 6, 'the scroll in between resets the count');
  assert.deepEqual(of(r.events, 'signal.repeated_failure')[0].payload, { step_no: 6, action: 'click', error: 'ref_not_found' });
  assert.equal(of(r.events, 'persona.abandoned').length, 0, 'an engine stop is not the persona giving up');
  assert.equal(report.outcome, 'repeated_failure');
  assert.match(report.outcome_text ?? '', /same click failed three times in a row \(ref_not_found\)/);
  assert.equal(report.status, 'finished');
});

test("abandon ends the episode with the persona's own reason", async () => {
  const r = begin([step('abandon', null, 'Too many dead ends for a Tuesday')]);
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'persona.abandoned').map((e) => e.payload),
    [{ step_no: 1, reason: 'Too many dead ends for a Tuesday' }],
  );
  assert.equal(report.outcome, 'abandoned');
});

test('two invalid outputs make a failed step, not a crash', async () => {
  const r = begin([{ thought: 'no action' }, { thought: 'still none', feeling: 9 }, step('done', null, 'Posted')]);
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'llm.call').map((e) => e.payload.status),
    ['invalid_output', 'invalid_output', 'ok'],
  );
  const [failed, done] = of(r.events, 'persona.step');
  assert.deepEqual(failed.payload.action, { type: 'wait', ref: null, text: null });
  assert.deepEqual([failed.payload.result.ok, failed.payload.result.error], [false, 'invalid_output']);
  assert.equal(done.payload.step_no, 2);
  assert.match(r.transcripts[1].request_json, /did not match the required format/);
  assert.equal(report.outcome, 'done');
});

test('stop() ends the run as stopped by the user once the step in flight is done', async () => {
  let handle: RunHandle | undefined;
  const scroll = step('scroll', null, 'down');
  const r = begin([
    scroll,
    () => {
      handle?.stop();
      return scroll;
    },
    scroll,
  ]);
  handle = r.run;
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 2);
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload),
    [{ reason: 'user', detail: null }],
  );
  assert.deepEqual(r.finished, [{ status: 'stopped', stop_reason: 'user', cost_usd: 0 }]);
  assert.deepEqual([report.status, report.outcome], ['stopped', 'incomplete']);
  assert.ok(r.pages.every((p) => p.closed));
});

test('stop() cancels a model call in flight', async () => {
  const r = begin(() => ({
    call: (req: LlmRequest<unknown>) => new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted')))),
  }));
  setTimeout(() => r.run.stop(), 10);
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 0);
  assert.deepEqual([report.status, report.stop_reason], ['stopped', 'user']);
});

test('the cost budget stops the run before the call that would pass it', async () => {
  const r = begin(
    (record) => ({
      async call<T>(req: LlmRequest<T>) {
        record({
          run_id: req.run_id,
          round: req.round,
          persona_id: req.persona_id,
          poi_id: null,
          type: 'llm.call',
          payload: { role: req.role, provider: 'fake', model: req.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.4, latency_ms: 0, status: 'ok', error: null },
        });
        return { object: req.schema.parse(step('scroll', null, 'down')), cost_usd: 0.4 };
      },
    }),
    { config: { cost_budget_usd: 1 } },
  );
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 2, '$0.80 spent; a third $0.40 step would pass $1');
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload.reason),
    ['cost_budget'],
  );
  assert.ok(Math.abs(r.finished[0].cost_usd - 0.8) < 1e-9);
  assert.equal(report.status, 'stopped');
});

test('a browser failure ends the run as stopped(error), closes the page and still reports', async () => {
  const r = begin([step('click', 'e1')], {
    act: () => {
      throw new Error('Target page crashed');
    },
  });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload),
    [{ reason: 'error', detail: 'Target page crashed' }],
  );
  assert.equal(report.stop_reason, 'error: Target page crashed');
  assert.ok(r.pages.every((p) => p.closed));
  assert.equal(r.types().at(-1), 'report.generated');
});

test('a model API error ends the run as stopped(error)', async () => {
  const r = begin(() => ({
    call: async () => {
      throw new Error('401 invalid x-api-key');
    },
  }));
  const report = await r.run.done;
  assert.deepEqual([report.status, report.stop_reason], ['stopped', 'error: 401 invalid x-api-key']);
});

test('screenshots are always kept, and sent to the model only when enabled', async () => {
  const r = begin([step('done', null, 'Done')], { config: { screenshots: false } });
  await r.run.done;
  assert.ok(r.files.has('runs/r-0001/shots/p-001-0001.jpg'));
  assert.doesNotMatch(r.transcripts[0].request_json, /"type":"image"/);
  const s = begin([step('done', null, 'Done')]);
  await s.run.done;
  assert.match(s.transcripts[0].request_json, /"type":"image","mediaType":"image\/jpeg","bytes":3/);
});

test('the demo script runs on any page: a scroll, a sample friction, then abandon', async () => {
  const r = begin(DEMO_SCRIPT);
  const report = await r.run.done;
  assert.equal(report.steps, 3);
  assert.equal(report.frictions.length, 1);
  assert.match(report.frictions[0].what, /scripted demo/);
  assert.deepEqual([report.status, report.outcome], ['finished', 'abandoned']);
});

test('scripts find refs by role and accessible name in the page text', () => {
  const req = { user: [{ type: 'text', text: '<page>\n- link "Jobs" [ref=e7] [cursor=pointer]:\n- textbox "Job title *" [ref=e12]\n</page>' }] } as LlmRequest<unknown>;
  assert.equal(findRef(req, 'link', 'Jobs'), 'e7');
  assert.equal(findRef(req, 'textbox', 'Job title *'), 'e12');
  assert.equal(findRef(req, 'button', 'Jobs'), null);
});

test('a recorded session opens a contained page logged in, at the session start page', async () => {
  const { sessions, saved } = fakeSessions({ cookies: [{ name: 'gym_session', value: 'v1' }] });
  const r = begin([step('done', null, 'Posted')], { sessions, config: { session: recruiter } });
  await r.run.done;
  const { options, gotos } = r.pages[0];
  assert.deepEqual(options.allowedHosts, ['gym.test', 'cdn.gym.test']);
  assert.deepEqual(options.blockedDomains, ['gym.com']);
  assert.deepEqual(options.storageState, saved.state);
  assert.deepEqual(gotos, ['http://gym.test/dashboard']);
  assert.equal(of(r.events, 'persona.episode_started')[0].payload.start_url, 'http://gym.test/dashboard');
});

test('a run whose recorded login has gone missing stops with an error that says what to do', async () => {
  const { sessions } = fakeSessions({});
  const r = begin([step('done', null, 'Posted')], { sessions, config: { session: { ...recruiter, role: 'admin' } } });
  const report = await r.run.done;
  assert.match(report.stop_reason ?? '', /^error: The recorded "admin" login is missing\. Record it again/);
});

test('blocked requests are logged, and a blocked page load on a production domain trips the wire', async () => {
  let clicks = 0;
  const r = begin([step('click', 'e1'), step('click', 'e1'), step('click', 'e1'), step('done', null, 'Done')], {
    act: (_a, page) => {
      clicks++;
      if (clicks === 1) page.onBlockedRequest({ host: 'tracker.example', url: 'https://tracker.example/t.js', method: 'GET', navigation: false });
      if (clicks === 2) page.onBlockedRequest({ host: 'app.gym.com', url: 'https://app.gym.com/jobs', method: 'GET', navigation: true });
      return {};
    },
  });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'containment.blocked_request').map((e) => e.payload.host),
    ['tracker.example', 'app.gym.com'],
  );
  assert.deepEqual(of(r.events, 'containment.tripwire')[0].payload, {
    kind: 'production_host',
    detail: 'The persona tried to open https://app.gym.com/jobs, on the production domain gym.com.',
  });
  assert.equal(of(r.events, 'persona.step').length, 2);
  assert.equal(of(r.events, 'run.stopped')[0].payload.reason, 'tripwire');
  assert.match(report.stop_reason ?? '', /^tripwire: The persona tried to open/);
  assert.ok(r.pages.every((p) => p.closed));
});

test('a live payment key on the page halts the run', async () => {
  const r = begin([step('click', 'e1'), step('done', null, 'Done')], { inspect: (n) => (n === 1 ? { live_key: 'pk_live_' } : {}) });
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 1);
  assert.deepEqual(
    of(r.events, 'containment.tripwire').map((e) => e.payload.kind),
    ['live_payment_key'],
  );
  assert.match(of(r.events, 'containment.tripwire')[0].payload.detail, /live payment key \(pk_live_…\) is on http:\/\/gym\.test\//);
  assert.deepEqual([report.status, of(r.events, 'run.stopped')[0].payload.reason], ['stopped', 'tripwire']);
});

test('a captcha pauses the persona, and an unanswered pause ends her episode blocked', async () => {
  const r = begin([step('click', 'e1'), step('done', null, 'Done')], { inspect: (n) => (n === 1 ? { challenge: 'recaptcha' } : {}), config: { pause_timeout_ms: 20 } });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'persona.blocked').map((e) => [e.payload.step_no, e.payload.reason]),
    [[1, 'captcha']],
  );
  assert.match(of(r.events, 'persona.blocked')[0].payload.detail, /recaptcha challenge is showing\. Gnomi never solves challenges/);
  assert.equal(of(r.events, 'persona.resumed').length, 0);
  assert.deepEqual([report.status, report.outcome], ['finished', 'blocked']);
  assert.deepEqual(report.methods.blocked, [{ step_no: 1, reason: 'captcha', detail: of(r.events, 'persona.blocked')[0].payload.detail, resumed: false }]);
});

test('an expired session pauses the persona; resumed, she goes on with the new login and her memory', async () => {
  const { sessions, saved } = fakeSessions({ cookies: [{ name: 'gym_session', value: 'old' }] });
  const relogged = { cookies: [{ name: 'gym_session', value: 'new' }] };
  const r = begin([step('click', 'e1'), step('done', null, 'Posted')], {
    sessions,
    config: { session: recruiter },
    act: () => ({ url_after: 'http://gym.test/login?next=%2Fjobs' }),
    inspect: (n) => (n === 1 ? { login: true } : {}),
    onEvent: (e, run) => {
      if (e.type !== 'persona.blocked') return;
      saved.state = relogged; // the user re-records the login
      run.resume('p-001');
    },
  });
  const report = await r.run.done;
  assert.deepEqual(
    r.types().filter((t) => t.startsWith('persona.')),
    ['persona.created', 'persona.episode_started', 'persona.step', 'persona.blocked', 'persona.resumed', 'persona.step', 'persona.goal_done'],
  );
  assert.deepEqual(of(r.events, 'persona.blocked')[0].payload.reason, 'session_expired');
  assert.equal(r.pages.length, 2);
  assert.ok(r.pages[0].closed);
  assert.deepEqual(r.pages[1].options.storageState, relogged);
  assert.deepEqual(r.pages[1].gotos, ['http://gym.test/dashboard'], 'back to the last page before the block');
  assert.match(r.transcripts[1].request_json, /1\. click link \\"Jobs\\" → went to \/login\?next=%2Fjobs/, 'her memory survives the pause');
  assert.deepEqual([report.outcome, report.methods.blocked[0].resumed], ['done', true]);
});

test('a login page without a recorded session is just a page', async () => {
  const r = begin([step('click', 'e1'), step('done', null, 'Done')], { inspect: () => ({ login: true }) });
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.blocked').length, 0);
  assert.equal(report.outcome, 'done');
});

test('stop() while a persona is paused ends the run as a user stop', async () => {
  const r = begin([step('click', 'e1'), step('done', null, 'Done')], {
    inspect: (n) => (n === 1 ? { challenge: 'recaptcha' } : {}),
    onEvent: (e, run) => e.type === 'persona.blocked' && run.stop(),
  });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload),
    [{ reason: 'user', detail: null }],
  );
  assert.equal(report.status, 'stopped');
  assert.ok(r.pages.every((p) => p.closed));
});

async function hook(status: number) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.method ?? '');
    res.writeHead(status).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/__reset`;
  return { url, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the reset hook is POSTed before the persona is created', async (t) => {
  const server = await hook(204);
  t.after(server.close);
  const r = begin([step('done', null, 'Done')], { config: { reset: true, project: { ...project, poi: { ...project.poi, reset_hook_url: server.url } } } });
  const report = await r.run.done;
  assert.deepEqual(server.calls, ['POST']);
  assert.deepEqual(r.types().slice(0, 3), ['run.started', 'run.reset_called', 'persona.created']);
  assert.deepEqual(of(r.events, 'run.reset_called')[0].payload, { url: server.url, status: 204, error: null });
  assert.deepEqual(report.methods.reset, { url: server.url, status: 204, error: null });
});

test('a reset hook that fails stops the run before the persona starts', async (t) => {
  const server = await hook(500);
  t.after(server.close);
  const poi = { ...project.poi, reset_hook_url: server.url };
  const r = begin([step('done', null, 'Done')], { config: { reset: true, project: { ...project, poi } } });
  assert.deepEqual(
    (await r.run.done).stop_reason,
    'error: The reset hook answered 500',
  );
  assert.equal(of(r.events, 'persona.created').length, 0);

  await server.close();
  const offline = begin([step('done', null, 'Done')], { config: { reset: true, project: { ...project, poi } } });
  assert.match((await offline.run.done).stop_reason ?? '', /^error: The reset hook failed: fetch failed/);
  assert.deepEqual(of(offline.events, 'run.reset_called')[0].payload.status, null);
});
