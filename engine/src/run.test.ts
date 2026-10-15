// startRun, the scheduler and the step loop over in-memory fakes of the store, blobs, sessions, browser and model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { mock, test } from 'node:test';
import { createGateway, InvalidOutputError } from './llm/gateway.ts';
import { createScriptedGateway } from './llm/scripted.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { getPersonaSchema } from './profile/schema.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import { DEFAULT_SETTINGS } from './settings.ts';
import type { BlobStore, BrowserPool, LlmAttempt, LlmGateway, LlmRequest, PageOptions, ProjectStore, Recorder, SessionStore, StorageState } from './seams.ts';
import type {
  Action,
  ActionOutcome,
  ActionType,
  Audience,
  EventOf,
  EventType,
  GnomiEvent,
  PageFlags,
  Persona,
  ProjectConfig,
  RunConfig,
  RunSettings,
  Segment,
  SessionInfo,
} from './types.ts';

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
  audience: null,
  settings: DEFAULT_SETTINGS,
};

test('new runs freeze independent schema, profile values, project settings and sessions', () => {
  const current = structuredClone({ ...project, persona_schema: getPersonaSchema() });
  const person = structuredClone({ ...BUILTIN_PERSONA, attributes: { tools_today: ['Sheets'] } });
  const session = { role: 'recruiter', start_url: 'http://gym.test/', hosts: ['gym.test'], recorded_at: 1, verified_at: 1, expires_at: null };
  const snapshot = newRunConfig(current, { personas: [person], sessions: [session], reset: false });
  const expected = structuredClone(snapshot);
  current.persona_schema.attributes.find((a) => a.id === 'employer')!.enabled = false;
  current.settings.concurrency = 99;
  person.attributes.tools_today.push('Another tool');
  session.hosts.push('changed.test');
  assert.deepEqual(snapshot, expected);
  assert.deepEqual(newRunConfig(project, { personas: [BUILTIN_PERSONA], sessions: [], reset: false }).project.persona_schema, getPersonaSchema());
  assert.equal(project.persona_schema, undefined, 'freezing defaults does not migrate the current project');
});

const step = (type: ActionType, ref: string | null = null, text: string | null = null, friction: object | null = null) => ({
  thought: `A ${type}, then.`,
  feeling: 0,
  action: { type, ref, text },
  friction,
});
const forever = () => step('scroll', null, 'down');

const persona = (id: string, over: Partial<Persona> = {}): Persona => ({ ...BUILTIN_PERSONA, id, name: `Persona ${id}`, ...over });
const segment = (id: string, over: Partial<Segment> = {}): Segment => ({
  id,
  name: id,
  description: '',
  share: 50,
  role: null,
  usage_frequency: 'weekly',
  typical_goals: [],
  mobile_share: 0,
  patience: [3, 3],
  tech_skill: [3, 3],
  account_state: 'populated',
  entry: 'direct',
  goal_override: null,
  ...over,
});
const audience = (segments: Segment[]): Audience => ({
  seed: 7,
  persona_count: 20,
  segments,
  company_size: [50, 2000],
  languages: { en: 1 },
  accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
});

const of = <K extends EventType>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);

const recruiter: SessionInfo = { role: 'recruiter', start_url: 'http://gym.test/dashboard', hosts: ['gym.test'], recorded_at: 1, verified_at: 1, expires_at: null };

/** One recorded role whose storage state the test can swap, as a re-recording would. */
function fakeSessions(state: StorageState) {
  const saved = { state };
  const sessions: SessionStore = {
    list: () => [recruiter],
    save: async (_info, next) => void (saved.state = next),
    load: async (role) => (role === recruiter.role ? { info: recruiter, state: saved.state } : null),
    markVerified: () => {},
  };
  return { sessions, saved };
}

/** Answers per persona: the n-th call of each persona gets respond(req, n). Validates like a gateway, one retry included. */
type Respond = (req: LlmRequest<unknown>, n: number) => unknown;

interface Options {
  personas?: Persona[];
  project?: Partial<ProjectConfig>;
  settings?: Partial<RunSettings>;
  config?: Partial<RunConfig>;
  sessions?: SessionInfo[];
  sessionStore?: SessionStore | null;
  cost?: number; // per model call
  delayMs?: number; // per model call
  onCall?: (req: LlmRequest<unknown>, run: RunHandle) => void;
  /** Overrides an action's outcome; may call the page's onBlockedRequest as a browser would. */
  act?: (a: Action, page: PageOptions) => Partial<ActionOutcome> | Promise<Partial<ActionOutcome>>;
  /** Flags for the n-th inspection of the run (0 is the first page's first load), given the page's current URL. */
  inspect?: (n: number, url: string) => Partial<PageFlags>;
  onEvent?: (e: GnomiEvent, run: RunHandle) => void;
  llm?: (record: Recorder) => LlmGateway;
}

function begin(respond: Respond | unknown[], opts: Options = {}) {
  const events: GnomiEvent[] = [];
  const transcripts: { seq: number; persona_id: string | null; request_json: string }[] = [];
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
    events: (run_id, o = {}) => events.filter((e) => e.run_id === run_id && e.seq > (o.afterSeq ?? 0) && (!o.types || o.types.includes(e.type))),
    saveTranscript: (_run_id, seq, request) => void transcripts.push({ seq, persona_id: events[seq - 1]?.persona_id ?? null, request_json: JSON.stringify(request) }),
    transcripts: () => transcripts.map(({ seq, request_json }) => ({ seq, request_json, response_json: '{}' })),
    listSessions: () => [],
    putSession: () => {},
    listPersonas: () => [],
    replacePersonas: () => {},
    putPersona: () => {},
    deletePersona: () => {},
    close: () => {},
  };
  const files = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    put: async (path, data) => void files.set(path, data),
    get: async (path) => files.get(path) ?? Promise.reject(new Error(`no blob ${path}`)),
  };
  const pages: { url: string; gotos: string[]; closed: boolean; options: PageOptions; openWhenOpened: number }[] = [];
  let open = 0;
  let inspections = 0;
  const browsers: BrowserPool = {
    async newPage(options) {
      open++;
      const page = { url: '', gotos: [] as string[], closed: false, options, openWhenOpened: open };
      pages.push(page);
      return {
        goto: async (url) => void page.gotos.push((page.url = url)),
        snapshot: async () => ({ url: page.url, title: 'Dashboard · Gym ATS', text: '- link "Jobs" [ref=e1]', hash: 'h1' }),
        screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        async act(action) {
          const outcome = { ok: true, url_before: page.url, url_after: page.url, dom_changed: true, error: null, target: { role: 'link', name: 'Jobs', box: null }, text: null, ...await opts.act?.(action, options) };
          page.url = outcome.url_after;
          return outcome;
        },
        inspect: async () => ({ login: false, challenge: null, live_key: null, ...opts.inspect?.(inspections++, page.url) }),
        async close() {
          if (!page.closed) open--;
          page.closed = true;
        },
      };
    },
    record: () => Promise.reject(new Error('not used')),
    checkSession: () => Promise.reject(new Error('not used')),
    close: async () => {},
  };

  let handle: RunHandle | undefined;
  const record = createRecorder(store, (e) => handle && opts.onEvent?.(e, handle));
  const answer: Respond = Array.isArray(respond)
    ? (req, n) => {
        if (n >= respond.length) throw new Error('the script ran out');
        const entry = respond[n];
        return typeof entry === 'function' ? entry(req) : entry;
      }
    : respond;
  const calls = new Map<string | null, number>();
  const llm: LlmGateway = opts.llm?.(record) ?? {
    async call<T>(req: LlmRequest<T>) {
      for (let attempt = 1; ; attempt++) {
        req.signal?.throwIfAborted();
        const n = calls.get(req.persona_id) ?? 0;
        calls.set(req.persona_id, n + 1);
        if (handle) opts.onCall?.(req, handle);
        if (opts.delayMs) await sleep(opts.delayMs);
        const output = answer(req, n);
        const parsed = req.schema.safeParse(output);
        const payload = { role: req.role, provider: 'fake', model: req.model.model, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
        const request = { system: req.system, user: req.user.map((part) => (part.type === 'text' ? part : { type: 'image', bytes: part.data.byteLength })) };
        const attemptResult: LlmAttempt = { payload: { ...payload, cost_usd: opts.cost ?? 0, latency_ms: 0, usage_reported: true, status: parsed.success ? 'ok' : 'invalid_output', error: parsed.success ? null : 'invalid' }, transcript: { request, response: output } };
        record({ run_id: req.run_id ?? '', round: 1, persona_id: req.persona_id, poi_id: null, type: 'llm.call', payload: attemptResult.payload }, attemptResult.transcript);
        req.onAttempt?.(attemptResult);
        if (parsed.success) return { object: parsed.data, cost_usd: opts.cost ?? 0 };
        req.signal?.throwIfAborted();
        if (attempt === 2) throw new InvalidOutputError('invalid twice');
      }
    },
  };
  const target = { ...project, ...opts.project, settings: { ...project.settings, ...opts.project?.settings, ...opts.settings } };
  const config = { ...store.createRun(newRunConfig(target, { personas: opts.personas ?? [BUILTIN_PERSONA], sessions: opts.sessions ?? [], reset: false })), ...opts.config };
  handle = startRun(config, { store, blobs, browsers, llm, record, sessions: opts.sessionStore ?? null });
  const run = handle;
  return { run, events, transcripts, finished, files, pages, types: () => events.map((e) => e.type) };
}

// —— One persona, as in M0 and M1 ——

test('opinion changes cite each persona’s own recorded step, retain prior values and add no model calls', async () => {
  const initial = { sentiment: -1, confidence: 0.5, likes: [], frictions: ['Missing confirmation'] };
  const updated = { sentiment: 1, confidence: 0.8, likes: ['Confirmation appeared'], frictions: [] };
  const r = begin((_request, n) => ({ ...step(n === 3 ? 'done' : 'read'), opinion: n < 2 ? initial : n === 2 ? null : updated }), { personas: [persona('a'), persona('b')], settings: { concurrency: 2 } });
  await r.run.done;
  const changes = of(r.events, 'persona.opinion_changed');
  assert.equal(changes.length, 4, 'identical and null opinions do not create changes');
  assert.equal(of(r.events, 'llm.call').length, 8, 'one call per ordinary step, no survey call');
  for (const id of ['a', 'b']) {
    const own = changes.filter((event) => event.persona_id === id);
    assert.deepEqual(own.map((event) => [event.payload.before, event.payload.after]), [[null, initial], [initial, updated]]);
    for (const event of own) {
      const cause = r.events.find((candidate) => candidate.seq === event.payload.cause.step_ids[0]);
      assert.equal(cause?.type, 'persona.step');
      assert.equal(cause?.persona_id, id);
      assert.equal(cause?.run_id, event.run_id);
      assert.equal(cause?.poi_id, event.payload.poi_id);
      assert.equal(cause?.round, event.round);
      assert.ok(cause!.seq < event.seq);
      assert.deepEqual(event.payload.cause.post_ids, []);
    }
    const requests = r.transcripts.filter((transcript) => transcript.persona_id === id);
    assert.match(requests[1].request_json, /Current opinion/);
    assert.match(requests[1].request_json, /Missing confirmation/);
  }
});

test('invalid opinion output cannot create a ledger entry or fabricate confidence', async () => {
  const invalid = { ...step('read'), opinion: { sentiment: 1, confidence: 4, likes: [], frictions: [] } };
  const r = begin([invalid, invalid, step('done')]);
  await r.run.done;
  assert.equal(of(r.events, 'persona.opinion_changed').length, 0);
  assert.equal(of(r.events, 'persona.step')[0].payload.result.error, 'invalid_output');
});

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
  assert.deepEqual(of(r.events, 'persona.friction_reported')[0].payload, { step_no: 1, ...friction, where: { url: 'http://gym.test/', ref: 'e1' } });

  assert.equal(report.status, 'finished');
  assert.deepEqual([report.personas[0].outcome, report.personas[0].outcome_text], ['done', 'Posted the job']);
  assert.equal(report.frictions[0].screenshot, 'runs/r-0001/shots/p-001-0001.jpg');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.files.get('runs/r-0001/report.json'))), report);
  assert.deepEqual(r.finished, [{ status: 'finished', stop_reason: null, cost_usd: 0 }]);
  assert.ok(r.pages.every((p) => p.closed));
});

test('step budgets follow patience: 12, 20, 30, 45 and 60 steps', async () => {
  const personas = [1, 2, 3, 4, 5].map((patience) => persona(`p-${patience}`, { patience }));
  const r = begin(forever, { personas, settings: { concurrency: 5 } });
  await r.run.done;
  assert.deepEqual(
    of(r.events, 'signal.budget_exceeded').map((e) => [e.persona_id, e.payload.budget, e.payload.step_no]).sort(),
    [
      ['p-1', 12, 12],
      ['p-2', 20, 20],
      ['p-3', 30, 30],
      ['p-4', 45, 45],
      ['p-5', 60, 60],
    ],
  );
  assert.equal(of(r.events, 'persona.step').length, 12 + 20 + 30 + 45 + 60);
  assert.match(r.transcripts.find((t) => t.persona_id === 'p-1')?.request_json ?? '', /gives up after about 12 actions/);
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
  assert.equal(report.personas[0].outcome, 'repeated_failure');
});

test("abandon ends the episode with the persona's own reason", async () => {
  const r = begin([step('abandon', null, 'Too many dead ends for a Tuesday')]);
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'persona.abandoned').map((e) => e.payload),
    [{ step_no: 1, reason: 'Too many dead ends for a Tuesday' }],
  );
  assert.equal(report.personas[0].outcome, 'abandoned');
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
  assert.equal(report.personas[0].outcome, 'done');
});

test('stop() discards an answer returned after cancellation before it can become a browser action', async () => {
  const r = begin(forever, { onCall: (req, run) => req.persona_id && run.stop() });
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 0);
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload),
    [{ reason: 'user', detail: null }],
  );
  assert.deepEqual(r.finished, [{ status: 'stopped', stop_reason: 'user', cost_usd: 0 }]);
  assert.deepEqual([report.status, report.personas[0].outcome], ['stopped', 'incomplete']);
  assert.ok(r.pages.every((p) => p.closed));
});

test('stop() cancels a model call in flight', async () => {
  const r = begin([], {
    llm: () => ({ call: (req) => new Promise<never>((_, reject) => req.signal?.addEventListener('abort', () => reject(new Error('aborted')))) }),
  });
  setTimeout(() => r.run.stop(), 10);
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 0);
  assert.deepEqual([report.status, report.stop_reason], ['stopped', 'user']);
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
  const r = begin([], {
    llm: () => ({
      call: async () => {
        throw new Error('401 invalid x-api-key');
      },
    }),
  });
  const report = await r.run.done;
  assert.deepEqual([report.status, report.stop_reason], ['stopped', 'error: 401 invalid x-api-key']);
});

test('screenshots are always kept, and sent to the model only when enabled', async () => {
  const r = begin([step('done', null, 'Done')], { settings: { screenshots: false } });
  await r.run.done;
  assert.ok(r.files.has('runs/r-0001/shots/p-001-0001.jpg'));
  assert.doesNotMatch(r.transcripts[0].request_json, /"type":"image"/);
  const s = begin([step('done', null, 'Done')]);
  await s.run.done;
  assert.match(s.transcripts[0].request_json, /"type":"image","bytes":3/);
});

// —— A population ——

test('no more personas are in flight than the concurrency allows, and all of them run', async () => {
  const personas = Array.from({ length: 7 }, (_, i) => persona(`p-${i}`));
  const r = begin([step('scroll', null, 'down'), step('done', null, 'Done')], { personas, settings: { concurrency: 3 }, delayMs: 5 });
  const report = await r.run.done;
  assert.equal(r.pages.length, 7);
  assert.ok(Math.max(...r.pages.map((p) => p.openWhenOpened)) <= 3, 'never more than three pages open at once');
  assert.equal(Math.max(...r.pages.map((p) => p.openWhenOpened)), 3, 'and the slots are used');
  assert.deepEqual(
    of(r.events, 'persona.created').map((e) => e.persona_id),
    personas.map((p) => p.id),
    'every persona is created up front, in order',
  );
  assert.ok(r.types().indexOf('persona.episode_started') > r.types().lastIndexOf('persona.created'));
  assert.equal(of(r.events, 'persona.goal_done').length, 7);
  assert.equal(report.personas.length, 7);
});

test('a rate limit halves the concurrency once per burst and records it', async () => {
  const personas = Array.from({ length: 8 }, (_, i) => persona(`p-${i}`));
  let throttledAt = -1;
  const r = begin([step('scroll', null, 'down'), step('done', null, 'Done')], {
    personas,
    settings: { concurrency: 4 },
    delayMs: 5,
    onCall: (_req, run) => {
      if (throttledAt >= 0) return;
      run.throttle('anthropic');
      run.throttle('anthropic'); // the rest of the same burst
      throttledAt = r.pages.length;
    },
  });
  await r.run.done;
  assert.deepEqual(
    of(r.events, 'run.concurrency_changed').map((e) => e.payload),
    [{ concurrency: 2, reason: 'anthropic is rate-limiting requests' }],
  );
  const later = r.pages.slice(throttledAt);
  assert.ok(later.length > 0 && later.every((p) => p.openWhenOpened <= 2), 'personas started after the change wait for a slot under the new limit');
  assert.equal(of(r.events, 'persona.goal_done').length, 8);
});

test('projected cost can stop admission early while already admitted calls and actions settle', async () => {
  const personas = Array.from({ length: 6 }, (_, i) => persona(`p-${i}`, { patience: 5 }));
  const r = begin(forever, { personas, settings: { concurrency: 3, cost_budget_usd: 1 }, cost: 0.1, delayMs: 2 });
  const report = await r.run.done;
  const spent = r.finished[0].cost_usd;
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload),
    [{ reason: 'cost_budget', detail: 'the next steps were projected to reach the $1 budget' }],
  );
  assert.ok(spent <= 1 + 1e-9, `spent ${spent}`);
  assert.ok(spent >= 1 - (3 + 1) * 0.1 - 1e-9, `stopped too early: ${spent}`);
  assert.equal(of(r.events, 'llm.call').length, of(r.events, 'persona.step').length, 'every call that started finished as a step');
  assert.ok(r.files.has('runs/r-0001/report.json'));
  assert.equal(report.status, 'stopped');
  assert.ok(r.pages.every((p) => p.closed));
});

test('a final done response at the recorded cap stops the run and still writes its report', async () => {
  const r = begin([], { settings: { cost_budget_usd: 0.25 }, llm: (record) => createScriptedGateway([step('done', null, 'Done')], record, { costPerCall: 0.25 }) });
  const report = await r.run.done;
  assert.deepEqual([report.status, report.stop_reason], ['stopped', 'cost_budget: the $0.25 recorded-cost budget was reached']);
  assert.equal(of(r.events, 'persona.step').length, 0);
  assert.equal(of(r.events, 'persona.goal_done').length, 0);
  assert.equal(r.finished[0].cost_usd, 0.25);
  assert.ok(r.files.has('runs/r-0001/report.json'));
  assert.ok(r.pages.every((page) => page.closed));
});

test('a paid invalid response at the cap stops the actual gateway before its retry and produces a stopped report', async () => {
  let attempts = 0;
  const fetch = mock.method(globalThis, 'fetch', async () => {
    attempts++;
    return Response.json({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 3_000, cache_creation_input_tokens: 0 } });
  });
  try {
    const r = begin([], {
      settings: { cost_budget_usd: 0.00023 },
      llm: (record) => createGateway({ secrets: { get: () => 'sk-test-no-network-12345678' }, localBaseUrl: null, record }),
    });
    const report = await r.run.done;
    assert.equal(attempts, 1);
    const calls = of(r.events, 'llm.call');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.status, 'invalid_output');
    assert.equal(calls[0].payload.usage_reported, true);
    assert.equal(r.finished[0].cost_usd, calls[0].payload.cost_usd);
    assert.equal(report.status, 'stopped');
    assert.match(report.stop_reason ?? '', /^cost_budget:/);
    assert.equal(of(r.events, 'persona.step').length, 0);
    assert.ok(r.files.has('runs/r-0001/report.json'));
  } finally { fetch.mock.restore(); }
});

test('concurrent late responses retain all reported usage but dispatch no actions or later personas after the cap', async () => {
  const ready = Promise.withResolvers<void>();
  const recorded = Promise.withResolvers<void>();
  const releases = Array.from({ length: 3 }, () => Promise.withResolvers<void>());
  const requests: LlmRequest<unknown>[] = [];
  let actions = 0;
  const r = begin([], {
    personas: Array.from({ length: 4 }, (_, i) => persona(`p-${i}`)), settings: { concurrency: 3, cost_budget_usd: 0.5 },
    act: () => { actions++; return {}; },
    onEvent: (event) => { if (event.type === 'llm.call') recorded.resolve(); },
    llm: (record) => ({ async call<T>(req: LlmRequest<T>) {
      const index = requests.length;
      requests.push(req as LlmRequest<unknown>);
      if (requests.length === 3) ready.resolve();
      await releases[index].promise; // Deliberately ignores abort, as a late provider response can.
      const object = req.schema.parse(step('click', 'e1'));
      const attempt: LlmAttempt = {
        payload: { role: req.role, provider: 'late-test', model: req.model.model, input_tokens: 100, output_tokens: 10, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: index === 0 ? 0.6 : 0.4, latency_ms: 0, usage_reported: true, status: 'ok', error: null },
        transcript: { request: req.user, response: object },
      };
      record({ run_id: req.run_id!, round: 1, persona_id: req.persona_id, poi_id: null, type: 'llm.call', payload: attempt.payload }, attempt.transcript);
      req.onAttempt?.(attempt);
      return { object, cost_usd: attempt.payload.cost_usd };
    } }),
  });
  await ready.promise;
  releases[0].resolve();
  await recorded.promise;
  const cancelledAtCap = requests.every((req) => req.signal?.aborted);
  releases.slice(1).forEach((release) => release.resolve());
  const report = await r.run.done;
  assert.equal(cancelledAtCap, true);
  assert.deepEqual([requests.length, actions, of(r.events, 'persona.step').length, r.pages.length], [3, 0, 0, 3]);
  assert.ok(Math.abs(r.finished[0].cost_usd - 1.4) < 1e-12, 'late provider usage stays in the total even though no action runs');
  assert.equal(of(r.events, 'llm.call').length, 3);
  assert.equal(report.status, 'stopped');
  assert.ok(r.pages.every((page) => page.closed));
});

test('a browser action dispatched before the cap settles and is recorded while later actions are refused', async () => {
  const acting = Promise.withResolvers<void>();
  const crossed = Promise.withResolvers<void>();
  const releaseAction = Promise.withResolvers<void>();
  let actions = 0;
  let calls = 0;
  const r = begin([], {
    personas: [persona('first'), persona('crossing'), persona('not-started')], settings: { concurrency: 2, cost_budget_usd: 0.5 },
    act: async () => { actions++; acting.resolve(); await releaseAction.promise; return {}; },
    onEvent: (event) => { if (event.type === 'llm.call' && event.payload.cost_usd === 0.6) crossed.resolve(); },
    llm: (record) => ({ async call<T>(req: LlmRequest<T>) {
      calls++;
      const first = req.persona_id === 'first';
      if (!first) await acting.promise;
      return createScriptedGateway([step('click', 'e1')], record, { costPerCall: first ? 0.1 : 0.6 }).call(req);
    } }),
  });
  await crossed.promise;
  releaseAction.resolve();
  const report = await r.run.done;
  const steps = of(r.events, 'persona.step');
  assert.deepEqual([actions, calls, steps.length], [1, 2, 1]);
  assert.equal(steps[0].persona_id, 'first');
  assert.ok(steps[0].seq > of(r.events, 'llm.call')[1].seq, 'the already-dispatched action remains truthful evidence after cutoff');
  assert.ok(Math.abs(r.finished[0].cost_usd - 0.7) < 1e-12);
  assert.equal(report.status, 'stopped');
  assert.ok(r.pages.every((page) => page.closed));
});

test('the wall-clock budget ends the run the same way', async () => {
  const personas = [persona('p-1', { patience: 5 }), persona('p-2', { patience: 5 })];
  const r = begin(forever, { personas, settings: { wall_clock_budget_min: 0.002 }, delayMs: 15 });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload.reason),
    ['wall_clock'],
  );
  assert.ok(of(r.events, 'persona.step').length < 120);
  assert.equal(report.status, 'stopped');
  assert.ok(r.files.has('runs/r-0001/report.json'));
});

test('personas carry their effective locale into isolated browsers and episode events, with legacy fallbacks', async () => {
  const personas = [
    persona('german', { country: 'DE', city: 'Berlin', timezone: 'Europe/Berlin', languages: ['de-DE', 'en-GB'], language: 'de' }),
    persona('legacy', { language: 'el' }),
  ];
  const r = begin([step('done', null, 'Done')], { personas });
  await r.run.done;
  const expected = [
    { locale: 'de-DE', timezone: 'Europe/Berlin', languages: ['de-DE', 'en-GB'] },
    { locale: 'el', timezone: 'UTC', languages: ['el'] },
  ];
  assert.deepEqual(r.pages.map(({ options: { locale, timezone, languages } }) => ({ locale, timezone, languages })), expected);
  assert.deepEqual(of(r.events, 'persona.episode_started').map(({ payload: { locale, timezone, languages } }) => ({ locale, timezone, languages })), expected);
});

test('each persona gets her segment goal, context and device', async () => {
  const project_ = {
    audience: audience([
      segment('seg-a', { goal_override: 'Review the candidates for the backend role', typical_goals: ['screen applicants'], entry: 'email_link' }),
      segment('seg-b'),
    ]),
  };
  const personas = [persona('p-a', { segment_id: 'seg-a', device: 'mobile', pronouns: 'they' }), persona('p-b', { segment_id: 'seg-b', device: 'desktop', pronouns: 'he' })];
  const r = begin([step('done', null, 'Done')], { personas, project: project_ });
  await r.run.done;
  const system = (id: string) => JSON.parse(r.transcripts.find((t) => t.persona_id === id)?.request_json ?? '{}').system as string;
  assert.match(system('p-a'), /task: "Review the candidates for the backend role"/);
  assert.match(system('p-a'), /usually here to: screen applicants/);
  assert.match(system('p-a'), /arrived: from a link in an email/);
  assert.match(system('p-a'), /pronouns: they\/them/);
  assert.match(system('p-b'), /task: "Post a job for a backend engineer"/);
  assert.match(system('p-b'), /pronouns: he\/him/);
  assert.deepEqual(
    of(r.events, 'persona.episode_started').map((e) => [e.persona_id, e.payload.device]).sort(),
    [
      ['p-a', 'mobile'],
      ['p-b', 'desktop'],
    ],
  );
  assert.deepEqual(r.pages.map((p) => p.options.device).sort(), ['desktop', 'mobile']);
});

test('a blocked persona pauses alone while the others carry on', async () => {
  const personas = [persona('p-blocked'), persona('p-free')];
  const r = begin((req, n) => (req.persona_id === 'p-blocked' ? step('click', 'candidates') : n < 3 ? step('scroll', null, 'down') : step('done', null, 'Done')), {
    personas,
    settings: { concurrency: 2 },
    config: { pause_timeout_ms: 300 },
    delayMs: 5,
    act: (a) => (a.ref === 'candidates' ? { url_after: 'http://gym.test/candidates' } : {}),
    inspect: (_n, url) => (url.endsWith('/candidates') ? { challenge: 'recaptcha' } : {}),
  });
  const report = await r.run.done;
  const blocked = of(r.events, 'persona.blocked')[0];
  const done = of(r.events, 'persona.goal_done')[0];
  assert.equal(blocked.persona_id, 'p-blocked');
  assert.equal(done.persona_id, 'p-free');
  assert.ok(done.seq > blocked.seq, 'p-free finished while p-blocked was paused');
  assert.deepEqual(
    report.personas.map((p) => [p.id, p.outcome]),
    [
      ['p-blocked', 'blocked'],
      ['p-free', 'done'],
    ],
  );
});

// —— Logins, containment, tripwires and the reset hook (M1) ——

test('a recorded session opens a contained page logged in, at the session start page', async () => {
  const { sessions, saved } = fakeSessions({ cookies: [{ name: 'gym_session', value: 'v1' }] });
  const r = begin([step('done', null, 'Posted')], { sessionStore: sessions, sessions: [recruiter], project: { role: 'recruiter' } });
  await r.run.done;
  const { options, gotos } = r.pages[0];
  assert.deepEqual(options.allowedHosts, ['gym.test', 'cdn.gym.test']);
  assert.deepEqual(options.blockedDomains, ['gym.com']);
  assert.deepEqual(options.storageState, saved.state);
  assert.deepEqual(gotos, ['http://gym.test/dashboard']);
  assert.equal(of(r.events, 'persona.episode_started')[0].payload.start_url, 'http://gym.test/dashboard');
});

test('a segment role with no verified login stops the run with an error that says why', async () => {
  const r = begin([step('done', null, 'Posted')], { personas: [persona('p-1', { segment_id: 'seg-a' })], project: { audience: audience([segment('seg-a', { role: 'admin' })]) } });
  const report = await r.run.done;
  assert.equal(report.stop_reason, 'error: No login for the "admin" role was verified before the run.');
});

test('blocked requests are logged, and a blocked page load on a production domain trips the wire for everyone', async () => {
  let clicks = 0;
  const personas = [persona('p-1'), persona('p-2', { patience: 5 })];
  const r = begin((req) => (req.persona_id === 'p-1' ? step('click', 'e1') : forever()), {
    personas,
    settings: { concurrency: 2 },
    delayMs: 5,
    act: (a, page) => {
      if (a.ref !== 'e1') return {};
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
    detail: 'Persona p-1 tried to open https://app.gym.com/jobs, on the production domain gym.com.',
  });
  assert.equal(of(r.events, 'run.stopped')[0].payload.reason, 'tripwire');
  assert.ok(of(r.events, 'persona.step').filter((e) => e.persona_id === 'p-2').length < 60, 'the other persona was halted too');
  assert.match(report.stop_reason ?? '', /^tripwire: Persona p-1 tried to open/);
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
  assert.deepEqual([report.status, of(r.events, 'run.stopped')[0].payload.reason], ['stopped', 'tripwire']);
});

test('a captcha pauses the persona, and an unanswered pause ends her episode blocked', async () => {
  const r = begin([step('click', 'e1'), step('done', null, 'Done')], { inspect: (n) => (n === 1 ? { challenge: 'recaptcha' } : {}), config: { pause_timeout_ms: 20 } });
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'persona.blocked').map((e) => [e.payload.step_no, e.payload.reason]),
    [[1, 'captcha']],
  );
  assert.equal(of(r.events, 'persona.resumed').length, 0);
  assert.deepEqual([report.status, report.personas[0].outcome], ['finished', 'blocked']);
});

test('an expired session pauses the persona; resumed, she goes on with the new login and her memory', async () => {
  const { sessions, saved } = fakeSessions({ cookies: [{ name: 'gym_session', value: 'old' }] });
  const relogged = { cookies: [{ name: 'gym_session', value: 'new' }] };
  const r = begin([step('click', 'e1'), step('done', null, 'Posted')], {
    sessionStore: sessions,
    sessions: [recruiter],
    project: { role: 'recruiter' },
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
  assert.equal(r.pages.length, 2);
  assert.ok(r.pages[0].closed);
  assert.deepEqual(r.pages[1].options.storageState, relogged);
  assert.deepEqual(r.pages[1].gotos, ['http://gym.test/dashboard'], 'back to the last page before the block');
  assert.match(r.transcripts[1].request_json, /1\. click link \\"Jobs\\" → went to \/login\?next=%2Fjobs/, 'her memory survives the pause');
  assert.deepEqual([report.personas[0].outcome, report.methods.blocked[0].resumed], ['done', true]);
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

test('the reset hook is POSTed before the personas are created', async (t) => {
  const server = await hook(204);
  t.after(server.close);
  const r = begin([step('done', null, 'Done')], { config: { reset: true }, project: { poi: { ...project.poi, reset_hook_url: server.url } } });
  const report = await r.run.done;
  assert.deepEqual(server.calls, ['POST']);
  assert.deepEqual(r.types().slice(0, 3), ['run.started', 'run.reset_called', 'persona.created']);
  assert.deepEqual(report.methods.reset, { url: server.url, status: 204, error: null });
});

test('a reset hook that fails stops the run before any persona starts', async (t) => {
  const server = await hook(500);
  t.after(server.close);
  const poi = { ...project.poi, reset_hook_url: server.url };
  const r = begin([step('done', null, 'Done')], { config: { reset: true }, project: { poi } });
  assert.equal((await r.run.done).stop_reason, 'error: The reset hook answered 500');
  assert.equal(of(r.events, 'persona.created').length, 0);
  await server.close();
  const offline = begin([step('done', null, 'Done')], { config: { reset: true }, project: { poi } });
  assert.match((await offline.run.done).stop_reason ?? '', /^error: The reset hook failed: fetch failed/);
});
