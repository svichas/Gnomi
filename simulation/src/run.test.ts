import { draftComparison } from './comparison/config.ts';
// startRun, the scheduler and the step loop over in-memory fakes of the store, blobs, sessions, browser and model.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { mock, test } from 'node:test';
import { createGateway, InvalidOutputError } from './llm/gateway.ts';
import { surveySchema } from './agent/prompt.ts';
import { createScriptedGateway, DEMO_AUTHOR, DEMO_JUDGE, requestText } from './llm/scripted.ts';
import { BUILTIN_PERSONA } from './persona.ts';
import { buildReport } from './report/build.ts';
import { getPersonaSchema } from './profile/schema.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import { DEFAULT_SIGNALS } from './signals/index.ts';
import { DEFAULT_SETTINGS, PROVIDER_DEFAULTS } from './settings.ts';
import { influenceEdges } from './social/influence.ts';
import { listen } from './browser/server.fixture.ts';
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
  PageSnapshot,
  Persona,
  ProjectConfig,
  RunConfig,
  RunSettings,
  Segment,
  SessionInfo,
  WebPoi,
} from './types.ts';

const project: ProjectConfig = {
  name: 'Gym ATS',
  description: '',
  pois: [{
    id: 'poi-1',
    type: 'web',
    name: 'Gym ATS',
    start_url: 'http://gym.test/',
    allowed_hosts: ['cdn.gym.test'],
    production_domains: ['gym.com'],
    reset_hook_url: null,
    mode: 'full',
    segments: null,
  }],
  goal: 'Post a job for a backend engineer',
  role: null,
  audience: null,
  settings: DEFAULT_SETTINGS,
};
const web = project.pois[0] as WebPoi;

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
  snapshot?: (url: string) => Partial<PageSnapshot>;
  onEvent?: (e: GnomiEvent, run: RunHandle) => void;
  llm?: (record: Recorder) => LlmGateway;
  /** The answer to every survey request, kept out of the step script; a valid survey by default. */
  survey?: unknown;
}

const SURVEY = {
  frictions: [{ where: 'job form', what: 'The save button was hard to find', severity: 2 }],
  objections: [],
  likes: [{ where: 'job form', what: 'Clear job form' }],
  sentiment: 1, confidence: 0.7, would_continue: true, reason: 'It worked in the end.',
};
/** What the survey above is logged as. */
const SURVEY_PAYLOAD = {
  sentiment: 1, confidence: 0.7, would_continue: true, reason: 'It worked in the end.',
  frictions: ['The save button was hard to find'], likes: ['Clear job form'],
  items: [{ kind: 'friction', where: 'job form', what: 'The save button was hard to find', severity: 2 }, { kind: 'like', where: 'job form', what: 'Clear job form', severity: null }],
};

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
    events: (run_id, o = {}) => events.filter((e) => e.run_id === run_id && e.seq > (o.afterSeq ?? 0) && (!o.types || o.types.includes(e.type)) && (o.personaId === undefined || e.persona_id === o.personaId)),
    saveTranscript: (_run_id, seq, request) => void transcripts.push({ seq, persona_id: events[seq - 1]?.persona_id ?? null, request_json: JSON.stringify(request) }),
    transcripts: () => transcripts.map(({ seq, request_json }) => ({ seq, request_json, response_json: '{}' })),
    listSessions: () => [],
    putSession: () => {},
    listPersonas: () => [],
    getGeneratedPersonaCount: () => null,
    replacePersonas: () => {},
    putPersona: () => {},
    deletePersona: () => {},
    getPersonaDraft: () => undefined,
    putPersonaDraft: () => {},
    clearPersonaDrafts: () => {},
    recordSetupCall: () => {},
    listSetupCalls: () => [],
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
        snapshot: async () => ({ url: page.url, title: 'Dashboard · Gym ATS', text: '- link "Jobs" [ref=e1]', hash: 'h1', ...opts.snapshot?.(page.url) }),
        screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]),
        async act(action) {
          const outcome = { ok: true, url_before: page.url, url_after: page.url, dom_changed: true, error: null, target: { role: 'link', name: 'Jobs', box: null }, text: null, ...await opts.act?.(action, options) };
          page.url = outcome.url_after;
          return outcome;
        },
        inspect: async () => ({ login: false, challenge: null, live_key: null, ...opts.inspect?.(inspections++, page.url) }),
        errors: () => [],
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
        const survey = req.purpose === 'survey';
        const n = calls.get(req.persona_id) ?? 0;
        if (!survey) calls.set(req.persona_id, n + 1);
        if (handle) opts.onCall?.(req, handle);
        if (opts.delayMs) await sleep(opts.delayMs);
        const output = survey ? ('survey' in opts ? opts.survey : SURVEY) : answer(req, n);
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
  assert.equal(of(r.events, 'llm.call').filter((e) => e.persona_id).length, 10, 'one call per ordinary step and one survey per persona');
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
  const steps = [step('click', 'e1', null, friction), step('done', null, 'Posted the job')];
  // Once the episode is over the judge names the one friction group and the author suggests a change; both answers are logged.
  const judged = { themes: [{ title: 'The Jobs link leads nowhere', description: 'Jobs opens a page that is not found.', group_ids: ['g1'] }] };
  const suggested = { suggestions: [{ theme_id: 'g1', change: 'Point the Jobs link at the job list.', solution: 'Fix the route behind the link.' }] };
  const r = begin((req, n) => (req.role === 'judge' ? judged : req.role === 'author' ? suggested : steps[n]));
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
    'llm.call',
    'persona.survey',
    'report.started',
    'llm.call',
    'report.themes',
    'llm.call',
    'report.suggestions',
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
  assert.deepEqual(of(r.events, 'persona.friction_reported')[0].payload, { step_no: 1, ...friction, where: { url: 'http://gym.test/', ref: 'e1' }, heard_post_ids: [] });

  assert.equal(report.status, 'finished');
  assert.deepEqual([report.personas[0].outcome, report.personas[0].outcome_text], ['done', 'Posted the job']);
  assert.equal(report.frictions[0].screenshot, 'runs/r-0001/shots/p-001-0001.jpg');
  assert.deepEqual(JSON.parse(new TextDecoder().decode(r.files.get('runs/r-0001/report.json'))), report);
  assert.deepEqual(
    report.themes?.map((t) => [t.title, t.named_by, t.suggestion?.change]),
    [
      ['The Jobs link leads nowhere', 'judge', 'Point the Jobs link at the job list.'],
      ['The save button was hard to find', 'rules', undefined], // the survey's friction, which the judge left unnamed
    ],
  );
  assert.deepEqual(buildReport(r.events), report); // the log alone, model answers included, gives the same report
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
  assert.doesNotMatch(r.transcripts.find((t) => t.persona_id === 'p-1')?.request_json ?? '', /gives up after about|Step \d+ of/, 'the engine enforces the budget; the prompt does not show it');
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

test('three invalid outputs in a row end the episode as the model failing, with no survey; alone they break no failed-action streak', async () => {
  const bad = { thought: 'no action' }; // a step takes two invalid attempts
  let surveys = 0;
  const silent = begin([bad, bad, bad, bad, bad, bad], { onCall: (req) => void (req.purpose === 'survey' && surveys++) });
  const report = await silent.run.done;
  assert.deepEqual(of(silent.events, 'signal.repeated_failure').map((e) => e.payload), [{ step_no: 3, action: 'wait', error: 'invalid_output' }]);
  assert.deepEqual([report.personas[0].outcome, surveys, of(silent.events, 'persona.survey').length], ['model_failed', 0, 0]);
  const dead = step('click', 'e9');
  const between = begin([dead, dead, bad, bad, dead, dead], { act: (a) => (a.ref === 'e9' ? { ok: false, error: 'ref_not_found', dom_changed: false, target: null } : {}) });
  await between.run.done;
  assert.deepEqual(of(between.events, 'signal.repeated_failure').map((e) => e.payload), [{ step_no: 4, action: 'click', error: 'ref_not_found' }]);
});

test('a friction repeated on the same page is recorded once, about the failed action before it or the element it names', async () => {
  const save = { severity: 2, what: 'Save does nothing!', expected: 'A saved draft' };
  const r = begin([step('click', 'e9'), step('click', 'e1', null, save), step('click', 'e1', null, { ...save, what: 'save does   nothing' }), step('click', 'e1', null, { severity: 1, what: 'Odd label', expected: 'Jobs', about_ref: 'e1' }), step('done', null, 'Done')], {
    act: (a) => (a.ref === 'e9' ? { ok: false, error: 'timeout', dom_changed: false, target: { role: 'button', name: 'Save', box: null } } : {}),
  });
  const report = await r.run.done;
  assert.equal(of(r.events, 'persona.step').length, 5, 'the repeat keeps its step, thought and feeling');
  assert.deepEqual(of(r.events, 'persona.friction_reported').map((e) => [e.payload.step_no, e.payload.where.ref, e.payload.about]), [
    [2, 'e9', { role: 'button', name: 'Save', box: null }],
    [4, 'e1', { role: 'link', name: 'Jobs', box: null }],
  ]);
  assert.ok(report.themes?.some((t) => t.elements.includes('button "Save"')), 'grouped under the element it is about, not the next click');
});

test('signals follow their step under the thresholds frozen in the run, or the defaults on a legacy run', async () => {
  assert.deepEqual(newRunConfig(project, { personas: [BUILTIN_PERSONA], sessions: [], reset: false }).signals, DEFAULT_SIGNALS);
  const script = [step('click', 'e9'), step('click', 'e1'), step('click', 'e1'), step('done', null, 'Done')]; // reads never loop
  const act = (a: { ref: string | null }) => (a.ref === 'e9' ? { dom_changed: false } : {});
  const legacy = begin(script, { act, config: { signals: undefined } });
  await legacy.run.done;
  assert.deepEqual(legacy.types().slice(3, 12), ['llm.call', 'persona.step', 'signal.failed_action', 'llm.call', 'persona.step', 'llm.call', 'persona.step', 'signal.loop', 'llm.call']);
  assert.deepEqual(of(legacy.events, 'signal.failed_action')[0].payload, { step_no: 1, url: 'http://gym.test/', ref: 'e9', action: 'click', error: 'no_effect' });
  const lenient = begin(script, { act, config: { signals: { ...DEFAULT_SIGNALS, loop_visits: 4 } } });
  await lenient.run.done;
  assert.equal(of(lenient.events, 'signal.loop').length, 0);
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

test('every episode that ends on its own gets one survey from the navigator, about that episode', async () => {
  const dead = step('click', 'e9');
  const scripts: Record<string, unknown[]> = {
    done: [step('click', 'e1', null, { severity: 2, what: 'Jobs is hard to find', expected: 'A Jobs tab' }), step('done', null, 'Posted')],
    abandoned: [step('abandon', null, 'Too slow')],
    stuck: [dead, dead, dead],
  };
  const asked = new Map<string | null, LlmRequest<unknown>>();
  const r = begin((req, n) => scripts[req.persona_id!]?.[n] ?? forever(), {
    personas: [persona('done'), persona('abandoned'), persona('stuck'), persona('budget', { patience: 1 })],
    settings: { concurrency: 4 },
    act: (a) => (a.ref === 'e9' ? { ok: false, error: 'ref_not_found', dom_changed: false, target: null } : {}),
    onCall: (req) => void (req.purpose === 'survey' && asked.set(req.persona_id, req)),
  });
  const report = await r.run.done;
  assert.equal(report.status, 'finished');
  assert.deepEqual(report.personas.map((p) => p.outcome).sort(), ['abandoned', 'budget_exceeded', 'done', 'repeated_failure']);
  const surveys = of(r.events, 'persona.survey');
  assert.deepEqual(surveys.map((e) => e.persona_id).sort(), ['abandoned', 'budget', 'done', 'stuck']);
  for (const survey of surveys) {
    assert.deepEqual([survey.poi_id, survey.payload], ['poi-1', { poi_id: 'poi-1', ...SURVEY_PAYLOAD }]);
    assert.ok(r.events.every((e) => e.persona_id !== survey.persona_id || e.seq <= survey.seq), 'the survey is the persona’s last event');
  }
  for (const req of asked.values()) {
    assert.deepEqual([req.role, req.model, req.schema], ['navigator', DEFAULT_SETTINGS.routing.navigator, surveySchema]);
  }
  const text = (id: string) => requestText(asked.get(id)!);
  assert.match(text('done'), /^The session is over after 2 steps: Persona finished the task \("Posted"\)\.\nFrictions Persona reported along the way:\n- "Jobs is hard to find"/);
  assert.match(text('abandoned'), /after 1 step: Persona gave up \("Too slow"\)\.\nPersona reported no frictions/);
  assert.match(text('stuck'), /after 3 steps: Persona stopped after the same action failed three times in a row\./);
  assert.match(text('budget'), /after 12 steps: Persona ran out of patience before finishing\./);
  assert.match(text('done'), /What Persona was thinking at the last 2 steps:\n- "A click, then\."\n- "A done, then\."\nPersona has no settled opinion of Gym ATS yet\./, 'the survey sees what the persona saw');
  assert.match(text('budget'), /What Persona was thinking at the last 5 steps:/);
});

test('no survey after a user stop, the wall clock, an unanswered block or a cost stop', async () => {
  const run = async (respond: unknown[], opts: Options) => {
    let asked = 0;
    const r = begin(respond, { ...opts, onCall: (req) => void (req.purpose === 'survey' && asked++) });
    const report = await r.run.done;
    assert.equal(of(r.events, 'persona.survey').length, 0);
    return { report, asked, done: of(r.events, 'persona.goal_done').length };
  };
  const posted = [step('done', null, 'Posted')];
  const user = await run(posted, { onEvent: (e, handle) => void (e.type === 'persona.goal_done' && handle.stop()) });
  assert.deepEqual([user.done, user.report.stop_reason, user.asked], [1, 'user', 0]);
  // The wall clock runs out while the final step is being answered; that step still completes.
  const clock = await run(posted, { settings: { wall_clock_budget_min: 0.001 }, delayMs: 150 });
  assert.deepEqual([clock.done, clock.report.stop_reason?.split(':')[0], clock.asked], [1, 'wall_clock', 0]);
  const blocked = await run([step('click', 'e1'), ...posted], { inspect: (n) => (n === 1 ? { challenge: 'recaptcha' } : {}), config: { pause_timeout_ms: 20 } });
  assert.deepEqual([blocked.report.personas[0].outcome, blocked.asked], ['blocked', 0]);
  // $0.20 spent and $0.20 a call: the survey's call reaches the $0.40 cap, so its answer is never logged.
  const cost = await run(posted, { cost: 0.2, settings: { cost_budget_usd: 0.4 } });
  assert.deepEqual([cost.done, cost.report.stop_reason?.split(':')[0], cost.asked], [1, 'cost_budget', 1]);
});

test('survey answers follow the step rules: validated, retried once, cut off at the cap, errors end the run', async () => {
  const invalid = begin([step('done', null, 'Posted')], { survey: { ...SURVEY, sentiment: 5 } });
  assert.equal((await invalid.run.done).status, 'finished', 'two invalid answers leave the persona without a survey, not the run broken');
  assert.deepEqual(of(invalid.events, 'llm.call').map((e) => e.payload.status), ['ok', 'invalid_output', 'invalid_output']);
  assert.equal(of(invalid.events, 'persona.survey').length, 0);

  // Steps cost $0.10 and the survey $0.30, so the survey is admitted and its own first attempt crosses the $0.35 cap.
  for (const answer of [SURVEY, { ...SURVEY, likes: Array(6).fill('Fine') }]) {
    const r = begin([], {
      settings: { cost_budget_usd: 0.35 },
      llm: (record) => ({ call: (req) => createScriptedGateway([req.purpose === 'survey' ? answer : step('done', null, 'Posted')], record, { costPerCall: req.purpose === 'survey' ? 0.3 : 0.1 }).call(req) }),
    });
    const report = await r.run.done;
    assert.equal(report.stop_reason, 'cost_budget: the $0.35 recorded-cost budget was reached');
    assert.equal(of(r.events, 'llm.call').length, 2, 'no retry after the cap');
    assert.equal(of(r.events, 'persona.survey').length, 0, 'an answer that arrives at the cap is logged as a call, not used');
  }

  const failing = begin([], {
    llm: (record) => ({ call: (req) => (req.purpose === 'survey' ? Promise.reject(new Error('Anthropic answered 500')) : createScriptedGateway([step('done', null, 'Posted')], record).call(req)) }),
  });
  assert.equal((await failing.run.done).stop_reason, 'error: Anthropic answered 500');
});

test('two invalid outputs make a failed step, not a crash', async () => {
  const r = begin([{ thought: 'no action' }, { thought: 'still none', feeling: 9 }, step('done', null, 'Posted')]);
  const report = await r.run.done;
  assert.deepEqual(
    of(r.events, 'llm.call').filter((e) => e.persona_id).map((e) => e.payload.status),
    ['invalid_output', 'invalid_output', 'ok', 'ok'],
  );
  const [failed, done] = of(r.events, 'persona.step');
  assert.deepEqual(failed.payload.action, { type: 'wait', ref: null, text: null });
  assert.deepEqual([failed.payload.result.ok, failed.payload.result.error], [false, 'invalid_output']);
  assert.equal(done.payload.step_no, 2);
  assert.equal(report.personas[0].outcome, 'done');
});

for (const purpose of ['survey', 'report_themes', 'report_suggestions']) {
  test(`a hung ${purpose} request times out and still saves the abandoned persona's report`, async (t) => {
    let aborted = false;
    t.mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal?.reason); });
    }));
    const deadlines: (number | undefined)[] = [];
    const r = begin([], {
      llm: (record) => {
        const gateway = createGateway({ secrets: { get: () => 'sk-test-no-network-12345678' }, localBaseUrl: null, record });
        const scripted = createScriptedGateway({
          navigator: (req) => req.purpose === 'survey' ? SURVEY : step('abandon', null, 'I cannot join', { severity: 3, what: 'Signup is broken', expected: 'Join the site' }),
          judge: DEMO_JUDGE,
          author: DEMO_AUTHOR,
        }, record);
        return { call: (req) => {
          if (req.purpose !== purpose) return scripted.call(req);
          deadlines.push(req.timeout_ms);
          // Fail promptly if the deadline is missing; exercise the real gateway with a shorter test deadline otherwise.
          if (req.timeout_ms === undefined) return Promise.reject(new Error('No completion deadline configured'));
          return gateway.call({ ...req, timeout_ms: 10 });
        } };
      },
    });
    const report = await r.run.done;
    assert.deepEqual(deadlines, [purpose === 'survey' ? 30_000 : 180_000]);
    assert.equal(aborted, true, 'the deadline cancels the stalled provider request');
    assert.equal(report.status, 'finished');
    assert.equal(report.personas[0].outcome, 'abandoned');
    assert.ok(report.frictions.length > 0, 'observed evidence is retained without the timed-out answer');
    assert.equal(of(r.events, 'run.finished').length, 1);
    assert.equal(r.types().at(-1), 'report.generated');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(r.files.get('runs/r-0001/report.json'))), report);
  });
}

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
  // A text-only model takes no images, so its prompt must not mention one; the report says the navigator saw text only.
  const d = begin([step('done', null, 'Done')], { settings: { routing: { ...DEFAULT_SETTINGS.routing, navigator: { provider: 'deepseek', model: 'deepseek-v4-pro' } } } });
  const textOnly = await d.run.done;
  assert.ok(d.files.has('runs/r-0001/shots/p-001-0001.jpg'));
  assert.doesNotMatch(d.transcripts[0].request_json, /"type":"image"|screenshot is/);
  assert.ok((textOnly.methods.limitations ?? []).some((l) => l.startsWith('The navigator saw each page as text only')));
  assert.ok(!((await s.run.done).methods.limitations ?? []).some((l) => l.includes('text only')));
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

test('without social rounds no step is refused by projection: the recorded cap stops the run and admitted work settles', async () => {
  const personas = Array.from({ length: 6 }, (_, i) => persona(`p-${i}`, { patience: 5 }));
  const r = begin(forever, { personas, settings: { concurrency: 3, cost_budget_usd: 1 }, cost: 0.1, delayMs: 2 });
  const report = await r.run.done;
  const spent = r.finished[0].cost_usd;
  assert.deepEqual(
    of(r.events, 'run.stopped').map((e) => e.payload),
    [{ reason: 'cost_budget', detail: 'the $1 recorded-cost budget was reached' }],
  );
  assert.ok(spent >= 1 - 1e-9 && spent <= 1 + 3 * 0.1 + 1e-9, `spent ${spent}`); // the cap plus at most the three calls in flight
  assert.ok(r.files.has('runs/r-0001/report.json'));
  assert.equal(report.status, 'stopped');
  assert.ok(r.pages.every((p) => p.closed));
});

test('without social rounds the cohort is admitted once, so reversing who answers first changes no step count', async () => {
  const counts = async (slow: string) => {
    const r = begin([], {
      // 24 steps at $0.10 stay under $2.45; a free, slow survey keeps one persona in flight while the other takes its last step.
      personas: [persona('p-0', { patience: 1 }), persona('p-1', { patience: 1 })], settings: { concurrency: 2, cost_budget_usd: 2.45 },
      llm: (record) => {
        const steps = createScriptedGateway({ navigator: forever }, record, { costPerCall: 0.1 });
        const free = createScriptedGateway({ navigator: () => SURVEY, judge: DEMO_JUDGE, author: DEMO_AUTHOR }, record);
        return { async call<T>(req: LlmRequest<T>) {
          if (req.role !== 'navigator') return free.call(req);
          if (req.purpose === 'survey') return sleep(50).then(() => free.call(req));
          await sleep(req.persona_id === slow ? 6 : 5);
          return steps.call(req);
        } };
      },
    });
    await r.run.done;
    return ['p-0', 'p-1'].map((id) => of(r.events, 'persona.step').filter((e) => e.persona_id === id).length);
  };
  const first = await counts('p-1');
  assert.deepEqual(first, [12, 12], 'neither persona is refused a step by the other one being in flight');
  assert.deepEqual(await counts('p-0'), first);
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
    config: { seed: 1 }, // a start order of first, crossing, not-started
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

test('a stop reason that arrives after the first joins its detail instead of being dropped', async () => {
  // The wall clock runs out while the first step is answered; the user stops the run once that step is recorded.
  const r = begin(forever, { settings: { wall_clock_budget_min: 0.001 }, delayMs: 150, onEvent: (e, run) => void (e.type === 'persona.step' && run.stop()) });
  const report = await r.run.done;
  assert.deepEqual(of(r.events, 'run.stopped').map((e) => e.payload), [{ reason: 'wall_clock', detail: 'the 0.001-minute limit was reached; then user' }]);
  assert.equal(report.stop_reason, 'wall_clock: the 0.001-minute limit was reached; then user');
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
  assert.deepEqual(r.pages.map(({ options: { locale, timezone, languages } }) => ({ locale, timezone, languages })).sort((a, b) => a.locale!.localeCompare(b.locale!)), expected); // in start order
  assert.deepEqual(of(r.events, 'persona.episode_started').map(({ payload: { locale, timezone, languages } }) => ({ locale, timezone, languages })).sort((a, b) => a.locale!.localeCompare(b.locale!)), expected);
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
  assert.deepEqual(options.allowedHosts, ['gym.test', 'www.gym.test', 'cdn.gym.test']);
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
      if (clicks === 1) page.onBlockedRequest({ host: 'tracker.example', url: 'https://tracker.example/t.js', method: 'GET', navigation: false, reason: 'host' });
      if (clicks === 2) page.onBlockedRequest({ host: 'app.gym.com', url: 'https://app.gym.com/jobs', method: 'GET', navigation: true, reason: 'host' });
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
    ['persona.created', 'persona.episode_started', 'persona.step', 'persona.blocked', 'persona.resumed', 'persona.step', 'persona.goal_done', 'persona.survey'],
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
  const url = `${await listen(server)}/__reset`;
  return { url, calls, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test('the reset hook is POSTed before the personas are created', async (t) => {
  const server = await hook(204);
  t.after(server.close);
  const r = begin([step('done', null, 'Done')], { config: { reset: true }, project: { pois: [{ ...web, reset_hook_url: server.url }] } });
  const report = await r.run.done;
  assert.deepEqual(server.calls, ['POST']);
  assert.deepEqual(r.types().slice(0, 3), ['run.started', 'run.reset_called', 'persona.created']);
  assert.deepEqual(report.methods.reset, { url: server.url, status: 204, error: null });
});

test('a reset hook that fails stops the run before any persona starts', async (t) => {
  const server = await hook(500);
  t.after(server.close);
  const pois = [{ ...web, reset_hook_url: server.url }];
  const r = begin([step('done', null, 'Done')], { config: { reset: true }, project: { pois } });
  assert.equal((await r.run.done).stop_reason, 'error: The reset hook answered 500');
  assert.equal(of(r.events, 'persona.created').length, 0);
  await server.close();
  const offline = begin([step('done', null, 'Done')], { config: { reset: true }, project: { pois } });
  assert.match((await offline.run.done).stop_reason ?? '', /^error: The reset hook failed: fetch failed/);
});

// —— Social rounds (M4) ——

const QUIET = { thought: 'Nothing to add.', action: 'nothing', post_id: null, text: null, reaction: null, about_poi_id: null, opinion_updates: [] };
const said = requestText;
const stepOf = (req: LlmRequest<unknown>) => Number(/^Step (\d+)\./m.exec(said(req))?.[1]);
const feedOf = (req: LlmRequest<unknown>) => [...said(req).matchAll(/^\[post (\S+)\]/gm)].map((m) => m[1]);
// Patience 1 is a 12-step budget, so three rounds are slices of four steps.
const swarm = (n: number) => Array.from({ length: n }, (_, i) => persona(`p-${i}`, { segment_id: i % 2 ? 'seg-b' : 'seg-a', patience: 1 }));
const SWARM = { audience: audience([segment('seg-a'), segment('seg-b')]) };
const rounds = (n: number): Partial<RunSettings> => ({ social: true, rounds: n });
/** Steps scroll on until `done` says so; socialiser requests get `social`. */
const swarmAnswers = (social: (req: LlmRequest<unknown>) => unknown = () => QUIET, done: (req: LlmRequest<unknown>) => boolean = () => false): Respond =>
  (req) => (req.role === 'socialiser' ? social(req) : done(req) ? step('done', null, 'Done') : forever());

test('social runs finish once every persona has given up and told the feed, including a single persona and queued personas', async () => {
  for (const count of [1, 4]) {
    const r = begin((req) => req.role === 'socialiser' ? QUIET : step('abandon', null, 'I cannot join'), {
      personas: swarm(count), project: SWARM, settings: { ...rounds(5), concurrency: 1 },
    });
    const report = await r.run.done;
    assert.equal(report.status, 'finished');
    assert.equal(of(r.events, 'persona.abandoned').length, count);
    assert.equal(of(r.events, 'persona.survey').length, count);
    assert.deepEqual(of(r.events, 'run.round_started').map((e) => e.round), [1]);
    assert.deepEqual(of(r.events, 'run.round_ended').map((e) => e.round), [1]);
    // Each tells the feed once how it went; nobody posted, so round 2 has nothing new and is never started. Alone, nobody listens.
    assert.deepEqual(of(r.events, 'social.feed_viewed').map((e) => e.round), count === 1 ? [] : [1, 1, 1, 1]);
    assert.ok(r.pages.every((p) => p.closed));
    assert.equal(r.types().at(-1), 'report.generated');
  }
});

test('rounds interleave usage and social phases while any episode remains, and every event carries its round', async () => {
  const calls: [role: string, round: number][] = [];
  const r = begin(swarmAnswers(() => QUIET, (req) => req.persona_id === 'p-1' && stepOf(req) === 6), {
    personas: swarm(3), project: SWARM, settings: rounds(3), onCall: (req) => void (req.purpose !== 'survey' && calls.push([req.role, req.round])),
  });
  assert.equal((await r.run.done).status, 'finished');
  assert.deepEqual(of(r.events, 'run.round_started').map((e) => e.round), [1, 2, 3]);
  assert.deepEqual(of(r.events, 'run.round_ended').map((e) => e.round), [1, 2, 3]);
  let current: number | null = null;
  for (const e of r.events) {
    if (e.type === 'run.round_started') current = e.round;
    else if (e.type === 'run.round_ended') current = null;
    else if (current !== null && e.type !== 'llm.call') assert.equal(e.round, current, `${e.type} #${e.seq}`); // this fake gateway logs round 1
  }
  for (const s of of(r.events, 'persona.step')) assert.equal(s.round, Math.ceil(s.payload.step_no / 4), `step ${s.payload.step_no}`);
  // Within a round the slice comes first, then the feeds; the next slice starts after them.
  for (const round of [1, 2]) {
    const lastStep = Math.max(...of(r.events, 'persona.step').filter((e) => e.round === round).map((e) => e.seq));
    const feeds = of(r.events, 'social.feed_viewed').filter((e) => e.round === round).map((e) => e.seq);
    const nextStep = Math.min(...of(r.events, 'persona.step').filter((e) => e.round === round + 1).map((e) => e.seq));
    assert.ok(lastStep < Math.min(...feeds) && Math.max(...feeds) < nextStep, `round ${round}`);
  }
  // p-1 finished in round 2 and read the feed after; in round 3 it has nothing new to read or tell, so only the two still browsing talk.
  assert.deepEqual(calls.filter(([role]) => role === 'socialiser').map(([, round]) => round), [1, 1, 1, 2, 2, 2]);
  assert.deepEqual(of(r.events, 'social.feed_viewed').filter((e) => e.round === 3).map((e) => e.persona_id), [], 'the last round is for reading: what is written there has no later round to be read in');
  assert.ok(calls.filter(([role]) => role === 'navigator').every(([, round], i, all) => i === 0 || round >= all[i - 1][1]));
});

test('slices continue one episode: one page per persona kept open between rounds, steps and memory running on', async () => {
  const r = begin(swarmAnswers(), { personas: swarm(2), project: SWARM, settings: rounds(3) });
  await r.run.done;
  assert.equal(r.pages.length, 2);
  assert.ok(r.pages.every((p) => p.closed && p.gotos.length === 1), 'one start-page load each, closed once the run is over');
  for (const id of ['p-0', 'p-1']) assert.deepEqual(of(r.events, 'persona.step').filter((e) => e.persona_id === id).map((e) => e.payload.step_no), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const fifth = r.transcripts.find((t) => t.persona_id === 'p-0' && /Step 5\./.test(t.request_json));
  assert.match(fifth?.request_json ?? '', /4\. scroll down/, 'step 5 remembers step 4 across the social phase');
  assert.deepEqual(of(r.events, 'persona.episode_started').length, 2);
  assert.deepEqual(of(r.events, 'signal.budget_exceeded').map((e) => e.round), [3, 3]);
});

test('the survey runs when the episode ends, and the persona reads feeds after that only while there is something new', async () => {
  const r = begin(swarmAnswers(() => QUIET, (req) => req.persona_id === 'p-1' && stepOf(req) === 6), { personas: swarm(3), project: SWARM, settings: rounds(4) });
  await r.run.done;
  assert.deepEqual(of(r.events, 'persona.survey').map((e) => [e.persona_id, e.round]).sort(), [['p-0', 4], ['p-1', 2], ['p-2', 4]]);
  assert.deepEqual(of(r.events, 'social.feed_viewed').filter((e) => e.persona_id === 'p-1').map((e) => e.round), [1, 2], 'a quiet swarm gives it nothing new in round 3');
  const ended = r.transcripts.filter((t) => t.persona_id === 'p-1' && /Round 2 of 4/.test(t.request_json));
  assert.match(ended[0]?.request_json ?? '', /session with Gym ATS is over after 6 steps: Persona finished the task/);
});

test('the follow graph is stored with each persona, and feeds show what the followed posted in earlier rounds', async () => {
  const r = begin(swarmAnswers((req) => (req.persona_id === 'p-0' && req.round === 1 ? { ...QUIET, action: 'post', text: 'Where is the save button?', about_poi_id: 'poi-1' } : QUIET)), {
    personas: swarm(4), project: SWARM, settings: rounds(3),
  });
  await r.run.done;
  const created = of(r.events, 'persona.created');
  for (const e of created) assert.deepEqual([...(e.payload.follows ?? [])].sort(), ['p-0', 'p-1', 'p-2', 'p-3'].filter((id) => id !== e.persona_id), 'four personas all follow each other');
  assert.deepEqual(of(r.events, 'social.post').map((e) => [e.persona_id, e.round, e.poi_id, e.payload]), [
    ['p-0', 1, 'poi-1', { post_id: 'r1-p-0', parent_id: null, text: 'Where is the save button?', about_poi_id: 'poi-1' }],
  ]);
  const feeds = of(r.events, 'social.feed_viewed');
  assert.ok(feeds.filter((e) => e.round === 1).every((e) => e.payload.post_ids.length === 0), 'posts written in a phase show from the next round on');
  assert.deepEqual(feeds.filter((e) => e.round === 2).map((e) => [e.persona_id, e.payload.post_ids]).sort(), [['p-0', []], ['p-1', ['r1-p-0']], ['p-2', ['r1-p-0']], ['p-3', ['r1-p-0']]]);
});

test('social answers are recorded in population order once the phase settles, however fast each call returns', async () => {
  const completed: string[] = [];
  const r = begin([], {
    personas: swarm(4), project: SWARM, settings: { ...rounds(2), concurrency: 4 },
    llm: (record) => {
      const scripted = createScriptedGateway({
        navigator: (req) => (req.purpose === 'survey' ? SURVEY : step('abandon', null, 'Done here')),
        socialiser: (req) => ({ ...QUIET, action: 'post', text: `Notes from ${req.persona_id}`, about_poi_id: 'poi-1' }),
        judge: DEMO_JUDGE,
        author: DEMO_AUTHOR,
      }, record);
      return {
        async call<T>(req: LlmRequest<T>) {
          // The last persona answers first: completion runs in reverse population order.
          if (req.role === 'socialiser') await sleep(40 - 10 * Number(req.persona_id!.slice(2)));
          const result = await scripted.call(req);
          if (req.role === 'socialiser' && req.round === 1) completed.push(req.persona_id!);
          return result;
        },
      };
    },
  });
  await r.run.done;
  assert.deepEqual(completed, ['p-3', 'p-2', 'p-1', 'p-0']);
  const first = (type: 'social.feed_viewed' | 'social.post') => of(r.events, type).filter((e) => e.round === 1).map((e) => e.persona_id);
  assert.deepEqual(first('social.feed_viewed').sort(), ['p-0', 'p-1', 'p-2', 'p-3']); // read in the seeded start order
  assert.deepEqual(first('social.post'), ['p-0', 'p-1', 'p-2', 'p-3'], 'posts land in population order, not completion order');
});

test('an injected post goes in at the start of its round’s social phase, before any feed, and reaches the followers’ feeds once', async () => {
  const text = 'The job form lost my whole draft.';
  const seen: string[] = [];
  const r = begin(swarmAnswers((req) => (feedOf(req).includes('inj-r2-1') && said(req).includes(text) && seen.push(req.persona_id ?? ''), QUIET)), {
    personas: swarm(6), project: SWARM, settings: rounds(4), config: { injected_posts: [{ round: 2, persona_id: 'p-0', poi_id: 'poi-1', text }] },
  });
  await r.run.done;
  const [post, ...others] = of(r.events, 'social.post');
  assert.equal(others.length, 0);
  assert.deepEqual([post.persona_id, post.round, post.payload], ['p-0', 2, { post_id: 'inj-r2-1', parent_id: null, text, about_poi_id: 'poi-1', injected: true }]);
  const lastStep = Math.max(...of(r.events, 'persona.step').filter((e) => e.round === 2).map((e) => e.seq));
  const feeds = of(r.events, 'social.feed_viewed');
  assert.ok(lastStep < post.seq && feeds.filter((e) => e.round === 2).every((e) => post.seq < e.seq), 'after the usage slice, before every feed');
  const followers = of(r.events, 'persona.created').filter((e) => e.payload.follows?.includes('p-0')).map((e) => e.persona_id!);
  assert.equal(followers.length, 5);
  assert.deepEqual(feeds.filter((e) => e.round === 2 && e.payload.post_ids.includes('inj-r2-1')).map((e) => e.persona_id).sort(), followers);
  assert.deepEqual(seen.sort(), followers, 'their socialiser read it');
  assert.ok(feeds.filter((e) => e.round === 3).every((e) => !e.payload.post_ids.includes('inj-r2-1')), 'never shown twice');
});

test('an opinion the feed changes cites its posts, an unchanged one records nothing, and the episode goes on with it', async () => {
  const liked = { sentiment: 1, confidence: 0.6, likes: ['Quick job form'], frictions: [] };
  const soured = { sentiment: -1, confidence: 0.5, likes: ['Quick job form'], frictions: ['Others lose their drafts'] };
  const social = (req: LlmRequest<unknown>) => {
    if (req.persona_id === 'p-0' && req.round === 1) return { ...QUIET, action: 'post', text: 'Lost my draft twice today.', about_poi_id: 'poi-1' };
    if (req.persona_id !== 'p-1' || req.round === 1) return QUIET;
    const cited = feedOf(req).filter((id) => id === 'r1-p-0');
    return { ...QUIET, action: cited.length ? 'react' : 'nothing', post_id: cited[0] ?? null, reaction: cited.length ? 'agree' : null, opinion_updates: [{ poi_id: 'poi-1', ...soured, post_ids: cited }] };
  };
  const r = begin((req) => (req.role === 'socialiser' ? social(req) : req.persona_id === 'p-1' && stepOf(req) === 1 ? { ...forever(), opinion: liked } : forever()), {
    personas: swarm(2), project: SWARM, settings: rounds(4),
  });
  await r.run.done;
  const changes = of(r.events, 'persona.opinion_changed').filter((e) => e.persona_id === 'p-1');
  assert.equal(changes.length, 2, 'the first-hand opinion, then the feed’s change; round 3 repeats it and records nothing');
  assert.deepEqual([changes[1].round, changes[1].poi_id, changes[1].payload], [2, 'poi-1', { poi_id: 'poi-1', before: liked, after: soured, cause: { step_ids: [], post_ids: ['r1-p-0'] } }]);
  assert.deepEqual(of(r.events, 'social.reaction').map((e) => [e.persona_id, e.round, e.payload]), [['p-1', 2, { post_id: 'r1-p-0', kind: 'agree' }]]);
  assert.deepEqual(influenceEdges(r.events).map((e) => [e.from, e.to, e.post_id, e.round, e.delta]), [['p-0', 'p-1', 'r1-p-0', 2, -2]]);
  const ninth = r.transcripts.find((t) => t.persona_id === 'p-1' && /Step 9\./.test(t.request_json));
  assert.match(ninth?.request_json ?? '', /Current opinion.*Others lose their drafts/, 'the next slice starts from the opinion the feed left');
  // Slices of three steps: round 2's feed, where p-1 read the post, comes before step 7.
  const prompt = (n: number) => r.transcripts.find((t) => t.persona_id === 'p-1' && new RegExp(`Step ${n}\\.`).test(t.request_json))?.request_json ?? '';
  assert.match(prompt(7), /Since Persona last looked, Persona read this in a feed where other people talk about it[^\n]*\\n- Persona p-0 about Gym ATS: \\"Lost my draft twice today\.\\"/, 'the next slice starts with what it read there');
  assert.doesNotMatch(prompt(4), /Since Persona last looked/, 'an empty feed adds nothing');
  assert.doesNotMatch(prompt(8), /Since Persona last looked/, 'only the first step after the feed hears it');
  const heardAt = (n: number) => of(r.events, 'persona.step').find((e) => e.persona_id === 'p-1' && e.payload.step_no === n)?.payload.heard_post_ids;
  assert.deepEqual([heardAt(4), heardAt(7), heardAt(8)], [[], ['r1-p-0'], []], 'the step records the posts its prompt was handed');
});

test('two invalid socialiser answers leave the persona silent for that phase, and the run goes on', async () => {
  const social = (req: LlmRequest<unknown>) =>
    req.round === 1
      ? req.persona_id === 'p-0' ? { ...QUIET, action: 'reply', post_id: 'r0-nowhere', text: 'Agreed!' } : { ...QUIET, action: 'post', text: 'Fine so far.', about_poi_id: null }
      : QUIET;
  const r = begin(swarmAnswers(social), { personas: swarm(2), project: SWARM, settings: rounds(3) });
  assert.equal((await r.run.done).status, 'finished');
  assert.deepEqual(of(r.events, 'social.post').map((e) => [e.persona_id, e.poi_id, e.payload.post_id]), [['p-1', null, 'r1-p-1']]);
  const attempts = of(r.events, 'llm.call').filter((e) => e.persona_id === 'p-0' && e.payload.role === 'socialiser').map((e) => e.payload.status);
  assert.deepEqual(attempts, ['invalid_output', 'invalid_output', 'ok']);
  assert.deepEqual(of(r.events, 'social.feed_viewed').filter((e) => e.persona_id === 'p-0').map((e) => e.payload.post_ids), [[], ['r1-p-1']]);
  assert.equal(of(r.events, 'social.feed_viewed').filter((e) => e.round === 3).length, 0, 'nothing new to read in the last round');
});

test('the cost cap reached in a social phase stops the run there: no later round or step, and every page closes', async () => {
  // Sixteen $0.01 steps make the first slice; the whole phase of four socialiser calls would reach the budget, so none starts.
  const budget = 0.18;
  const r = begin(swarmAnswers(), { personas: swarm(4), project: SWARM, settings: { ...rounds(3), cost_budget_usd: budget }, cost: 0.01 });
  const report = await r.run.done;
  assert.deepEqual(of(r.events, 'run.stopped').map((e) => [e.payload.reason, e.payload.detail]), [['cost_budget', 'the social phase of round 1 was projected to reach the $0.18 budget']]);
  assert.equal(of(r.events, 'llm.call').filter((e) => e.payload.role === 'socialiser').length, 0, 'a phase is admitted whole or not at all');
  assert.deepEqual([of(r.events, 'run.round_started').map((e) => e.round), of(r.events, 'run.round_ended').map((e) => e.round)], [[1], [1]]);
  assert.ok(of(r.events, 'persona.step').every((e) => e.round === 1 && e.payload.step_no <= 4));
  assert.ok(r.pages.length === 4 && r.pages.every((p) => p.closed), 'episodes waiting for a slice end and close their pages');
  assert.equal(of(r.events, 'persona.survey').length, 0);
  assert.equal(r.finished[0].status, 'stopped');
  assert.ok(report.cost_usd <= budget + 12 * 0.01 + 1e-9);
});

test('a usage slice is admitted whole: when its steps would reach the budget, none of them starts', async () => {
  // Round 1: sixteen $0.01 steps and four socialiser calls; round 2's sixteen steps would reach $0.30, so the run stops before them.
  const r = begin(swarmAnswers(), { personas: swarm(4), project: SWARM, settings: { ...rounds(3), cost_budget_usd: 0.3 }, cost: 0.01 });
  await r.run.done;
  assert.deepEqual(of(r.events, 'run.stopped').map((e) => e.payload.detail), ['the usage slice of round 2 was projected to reach the $0.3 budget']);
  assert.deepEqual([of(r.events, 'run.round_started').map((e) => e.round), of(r.events, 'persona.step').length], [[1], 16]);
  assert.ok(r.pages.every((p) => p.closed));
});

test('social rounds off, absent from an older project, or with only the built-in persona: the run is exactly as before M4', async () => {
  const runs = [
    begin(swarmAnswers(), { personas: swarm(3), project: SWARM, settings: { social: false } }), // on by default since the audience step shows it
    begin(swarmAnswers(), { personas: swarm(3), project: SWARM, settings: { social: false, rounds: 3 } }),
    begin(swarmAnswers(), { personas: swarm(3), project: SWARM, settings: { social: undefined, rounds: undefined } }),
  ];
  const alone = begin(swarmAnswers(), { settings: rounds(3) });
  await Promise.all([...runs, alone].map((r) => r.run.done));
  for (const r of [...runs, alone]) {
    assert.ok(r.events.every((e) => e.round === 1));
    assert.deepEqual(r.events.filter((e) => e.type.startsWith('social.') || e.type.startsWith('run.round')), []);
    assert.ok(of(r.events, 'persona.created').every((e) => !('follows' in e.payload)));
    assert.ok(of(r.events, 'llm.call').every((e) => e.payload.role !== 'socialiser'));
  }
  const shape = (r: (typeof runs)[number]) => r.events.map((e) => [e.type, e.persona_id]);
  assert.deepEqual(shape(runs[1]), shape(runs[0]));
  assert.deepEqual(shape(runs[2]), shape(runs[0]));
  assert.equal(of(runs[0].events, 'persona.step').length, 36, 'each episode runs its whole budget in one go');
});

// —— Several POIs (M5) ——

const twoPois: Partial<ProjectConfig> = {
  pois: [{ ...web, id: 'poi-home', name: 'Home' }, { ...web, id: 'poi-locale', name: 'Locale', start_url: 'http://gym.test/locale', segments: ['seg-b'] }],
  audience: audience([segment('seg-a'), segment('seg-b')]),
};

test('each persona uses its eligible POIs in order, with step numbers running on and one survey and theme set per POI', async () => {
  const friction = (what: string) => ({ severity: 2, what, expected: 'Something clearer' });
  const r = begin((req, n) => (n % 2 === 0 ? step('click', 'e1', null, friction(`Stuck on ${said(req).includes('/locale') ? 'locale' : 'home'}`)) : step('done', null, 'Done')), {
    personas: [persona('a', { segment_id: 'seg-a' }), persona('b', { segment_id: 'seg-b' })],
    project: twoPois,
    settings: { concurrency: 1 },
  });
  const report = await r.run.done;
  assert.equal(report.status, 'finished');
  const visits = (id: string) => of(r.events, 'persona.episode_started').filter((e) => e.persona_id === id).map((e) => [e.poi_id, e.payload.start_url]);
  assert.deepEqual(visits('a'), [['poi-home', 'http://gym.test/']], 'seg-a is not on the locale POI');
  assert.deepEqual(visits('b'), [['poi-home', 'http://gym.test/'], ['poi-locale', 'http://gym.test/locale']]);
  const steps = of(r.events, 'persona.step').filter((e) => e.persona_id === 'b');
  assert.deepEqual(steps.map((e) => [e.poi_id, e.payload.step_no]), [['poi-home', 1], ['poi-home', 2], ['poi-locale', 3], ['poi-locale', 4]]);
  assert.equal(new Set(steps.map((e) => e.payload.screenshot)).size, 4, 'every step keeps its own screenshot');
  assert.ok(r.pages.every((p) => p.closed) && r.pages.length === 3, 'one page per persona and POI');
  assert.deepEqual(r.pages.map((p) => p.options.allowedHosts), [['gym.test', 'www.gym.test', 'cdn.gym.test'], ['gym.test', 'www.gym.test', 'cdn.gym.test'], ['gym.test', 'www.gym.test', 'cdn.gym.test']]);
  assert.deepEqual(of(r.events, 'persona.survey').map((e) => [e.persona_id, e.payload.poi_id]).sort(), [['a', 'poi-home'], ['b', 'poi-home'], ['b', 'poi-locale']]);
  const surveyed = of(r.events, 'persona.survey').find((e) => e.persona_id === 'b' && e.payload.poi_id === 'poi-locale')!;
  assert.ok(of(r.events, 'persona.step').filter((e) => e.persona_id === 'b' && e.poi_id === 'poi-locale').every((e) => e.seq < surveyed.seq));
  assert.deepEqual(report.pois.map((p) => p.id), ['poi-home', 'poi-locale']);
  const themes = (poi_id: string) => (report.themes ?? []).filter((t) => t.poi_id === poi_id);
  assert.ok(themes('poi-home').some((t) => t.title.includes('Trouble with link "Jobs"') && t.personas === 2));
  assert.ok(themes('poi-locale').some((t) => t.personas === 1 && t.evidence[0].what === 'Stuck on locale'));
  assert.deepEqual(themes('poi-locale').map((t) => t.rank), themes('poi-locale').map((_, i) => i + 1), 'ranked within the POI');
});

test('social slices count a persona’s steps across its POIs', async () => {
  const r = begin(swarmAnswers(), {
    // 12 steps per web POI, 24 in all, two rounds of 12; a second persona gives the first someone to talk to.
    personas: [persona('b', { segment_id: 'seg-b', patience: 1 }), persona('c', { segment_id: 'seg-b', patience: 1 })],
    project: twoPois,
    settings: rounds(2),
  });
  await r.run.done;
  const mine = <T extends { persona_id: string | null }>(events: T[]) => events.filter((e) => e.persona_id === 'b');
  const steps = mine(of(r.events, 'persona.step'));
  assert.deepEqual(steps.map((e) => [e.payload.step_no, e.poi_id, e.round]), steps.map((_, i) => [i + 1, i < 12 ? 'poi-home' : 'poi-locale', i < 12 ? 1 : 2]));
  assert.deepEqual(mine(of(r.events, 'signal.budget_exceeded')).map((e) => [e.poi_id, e.payload.step_no, e.payload.budget]), [['poi-home', 12, 12], ['poi-locale', 24, 12]]);
  assert.deepEqual(mine(of(r.events, 'persona.survey')).map((e) => e.payload.poi_id), ['poi-home', 'poi-locale']);
  const feed = r.transcripts.find((t) => t.persona_id === 'b' && t.request_json.includes('about_poi_id'))!;
  assert.match(feed.request_json, /about_poi_id: \\"poi-home\\" when the post or reply is about Home, \\"poi-locale\\" when the post or reply is about Locale/);
});

test('personas start in a seeded order that mixes segments, the same on every replay; the snapshot keeps the population order', async () => {
  const starts = async () => {
    const r = begin([step('done', null, 'Done')], { personas: swarm(6), project: SWARM, settings: { social: false, concurrency: 1 } });
    await r.run.done;
    return { started: of(r.events, 'persona.episode_started').map((e) => e.persona_id), frozen: of(r.events, 'run.started')[0].payload.config.personas.map((p) => p.id) };
  };
  const [a, b] = [await starts(), await starts()];
  const population = swarm(6).map((p) => p.id);
  assert.deepEqual(a.started, b.started);
  assert.notDeepEqual(a.started, population);
  assert.deepEqual([...a.started].sort(), population);
  assert.deepEqual(a.frozen, population);
});

test('a hard stop in a social phase logs each paid answer it discards, and the report names the round and count', async () => {
  const r = begin(swarmAnswers(() => ({ ...QUIET, action: 'post', text: 'Lost my draft.', about_poi_id: 'poi-1' })), {
    personas: swarm(4), project: SWARM, settings: rounds(3),
    onEvent: (e, run) => void (e.type === 'llm.call' && e.payload.role === 'socialiser' && run.stop()),
  });
  const report = await r.run.done;
  const call = of(r.events, 'llm.call').find((e) => e.payload.role === 'socialiser')!;
  assert.deepEqual(of(r.events, 'social.discarded').map((e) => [e.persona_id, e.round, e.payload.call_seq]), [[call.persona_id, 1, call.seq]]);
  assert.equal(of(r.events, 'social.post').length, 0);
  assert.ok((report.methods.limitations ?? []).includes('The run stopped in round 1 before applying 1 paid social answer, so the feed and opinions miss it.'));
});

test('a feed records the parents of the replies it showed', async () => {
  const social = (req: LlmRequest<unknown>) =>
    req.persona_id === 'p-0' && req.round === 1 ? { ...QUIET, action: 'post', text: 'Where is save?', about_poi_id: 'poi-1' }
    : req.persona_id === 'p-1' && feedOf(req).includes('r1-p-0') ? { ...QUIET, action: 'reply', post_id: 'r1-p-0', text: 'Same here.' } : QUIET;
  const r = begin(swarmAnswers(social), { personas: swarm(3), project: SWARM, settings: rounds(3) });
  await r.run.done;
  const showing = of(r.events, 'social.feed_viewed').filter((e) => e.payload.post_ids.includes('r2-p-1'));
  assert.ok(showing.length > 0 && showing.every((e) => e.payload.parent_ids?.includes('r1-p-0')));
  assert.ok(of(r.events, 'social.feed_viewed').every((e) => e.payload.post_ids.includes('r2-p-1') || !e.payload.parent_ids?.length));
});

test('an episode that starts after a social phase starts from the opinion it gave that POI', async () => {
  // Slices of eight steps over 24; b is done with Home at step 10, mid-slice in round 2, so Locale starts there.
  const heardOf = { sentiment: -1, confidence: 0.4, likes: [], frictions: ['Locale settings are said to be buried'] };
  const own = { sentiment: 1, confidence: 0.7, likes: ['Locale was easy'], frictions: [] };
  const onLocale = (req: LlmRequest<unknown>) => said(req).includes('url: http://gym.test/locale');
  const r = begin((req) =>
    req.role === 'socialiser' ? (req.persona_id === 'b' && req.round === 1 ? { ...QUIET, opinion_updates: [{ poi_id: 'poi-locale', ...heardOf, post_ids: [] }] } : QUIET)
    : req.persona_id !== 'b' ? forever()
    : onLocale(req) ? (stepOf(req) === 1 ? { ...forever(), opinion: own } : forever())
    : stepOf(req) === 10 ? step('done', null, 'Done') : forever(), {
    personas: [persona('b', { segment_id: 'seg-b', patience: 1 }), persona('c', { segment_id: 'seg-b', patience: 1 })], project: twoPois, settings: rounds(3),
  });
  await r.run.done;
  const first = r.transcripts.find((t) => t.persona_id === 'b' && t.request_json.includes('url: http://gym.test/locale'));
  assert.match(first?.request_json ?? '', /Current opinion \(self-reported, from earlier steps\): .*Locale settings are said to be buried/);
  const change = of(r.events, 'persona.opinion_changed').find((e) => e.persona_id === 'b' && e.poi_id === 'poi-locale' && e.payload.cause.step_ids.length > 0);
  assert.deepEqual(change?.payload.before, heardOf, 'not null: the episode began with the feed’s opinion');
});

test('a persona with no point of interest stops the run before anyone starts', async () => {
  const r = begin([], { personas: [persona('buyer', { segment_id: 'seg-a' })], project: { ...twoPois, audience: audience([segment('seg-a', { kind: 'buyer' })]) } });
  const report = await r.run.done;
  assert.equal(report.stop_reason, 'error: Persona buyer has no point of interest to use.');
  assert.equal(of(r.events, 'persona.created').length, 0);
  assert.deepEqual(r.finished.map((f) => f.status), ['stopped']);
});


function publicComparison() {
  const target: ProjectConfig = { ...project, pois: ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name, i) => ({ ...web, id: `public-${i}`, name, start_url: `https://${name.toLowerCase()}.example/`, mode: 'observe_only', production_domains: [] })), audience: audience([segment('buyers', { kind: 'buyer' })]) };
  target.comparison = draftComparison(target);
  target.comparison.tasks[0].prerequisites = [];
  target.comparison.criteria = [{ id: 'entry', name: 'Jobs entry', question: 'Is the jobs entry visible?', evidence_required: 'A captured visible Jobs link.', importance: 'must_have', decision_rule: 'Meets when Jobs is visible in the current target navigation.' }];
  target.comparison.tasks[0].criterion_ids = ['entry'];
  target.comparison.tasks[0].success_rule = 'Find the Jobs entry in visible navigation.';
  target.comparison.tasks[0].max_steps = 2;
  return target;
}

function comparisonAnswer(req: LlmRequest<unknown>) {
  if (req.purpose === 'comparison_assessment') {
    const input = JSON.parse(req.user.find((part) => part.type === 'text')!.text);
    const source = input.sources.find((item: { kind: string }) => item.kind === 'page');
    const citation = { event_seq: source.event_seq, source: source.source, quote: source.text };
    return { outcome: 'completed', reason: 'The visible navigation contains Jobs.', outcome_evidence: [citation], criteria: [{ criterion_id: 'entry', assessment: 'meets', basis: 'vendor_claim', summary: 'A Jobs entry is visible.', evidence: [citation] }] };
  }
  if (req.purpose === 'comparison_verification') return { outcome_supported: true, outcome_reason: 'The Jobs entry is captured.', criteria: [{ criterion_id: 'entry', supported: true, reason: 'The quotation supports this criterion.' }] };
  return step('done', null, 'Found Jobs.');
}

test('comparison initial matched-block admission uses the optional verifier model price', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('User-agent: *\nAllow: /'));
  for (const verifier of ['judge', 'navigator'] as const) {
    const target = publicComparison();
    target.comparison!.execution.verifier = verifier;
    const r = begin(comparisonAnswer, { project: target, personas: [persona('buyer', { segment_id: 'buyers' })], settings: { cost_budget_usd: 0.04, concurrency: 1 }, cost: 0 });
    const report = await r.run.done;
    assert.ok(report.comparison!.coverage.every((row) => verifier === 'judge' ? row.outcomes.not_attempted === 1 : row.outcomes.completed === 1));
  }
});

test('comparison step admission learns verifier costs separately from the more expensive assessment', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('User-agent: *\nAllow: /'));
  const target = publicComparison();
  target.comparison!.execution.verifier = 'navigator';
  const r = begin(comparisonAnswer, { project: target, personas: [persona('buyer', { segment_id: 'buyers' })], settings: { cost_budget_usd: 0.09, concurrency: 1 },
    llm: (record) => ({ call: (req) => createScriptedGateway([comparisonAnswer(req)], record, { costPerCall: req.purpose === 'comparison_assessment' ? 0.02 : 0.001 }).call(req) }),
  });
  const report = await r.run.done;
  assert.ok(report.comparison!.coverage.every((row) => row.outcomes.completed === 1));
  assert.equal(of(r.events, 'llm.call').filter((call) => call.payload.purpose === 'comparison_verification').length, 4);
  assert.ok(Math.abs(report.cost_usd - 0.088) < 1e-9);
});

test('explicit all-public comparison admits buyer web tasks and produces replayable evidence across every target', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const r = begin(comparisonAnswer, { project: publicComparison(), personas: [persona('buyer-a', { segment_id: 'buyers' }), persona('buyer-b', { segment_id: 'buyers' })], settings: rounds(3) });
  const report = await r.run.done;
  assert.equal(report.comparison?.coverage.length, 4);
  assert.ok(report.comparison?.coverage.every((row) => row.scheduled === 2 && row.outcomes.completed === 2 && row.completion_rate === 1));
  assert.ok(report.comparison?.cells.every((cell) => cell.assessment === 'meets' && cell.assessed === 2 && cell.distinct_sources === 1));
  assert.equal(of(r.events, 'comparison.source').length, 8);
  assert.equal(of(r.events, 'persona.survey').length, 0, 'no implicit baseline survey is injected');
  assert.equal(of(r.events, 'social.feed_viewed').length, 0, 'comparison social policy overrides inherited rounds');
  assert.equal(of(r.events, 'llm.call').length, 24, 'one navigation, assessment and verification per episode; no legacy report author');
  assert.deepEqual(buildReport(r.events).comparison, report.comparison, 'replay only folds the accepted recorded judgments');
});

test('comparison cost limits retain captured sources and export unknown cells for incomplete target coverage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const r = begin(comparisonAnswer, { project: publicComparison(), personas: [persona('buyer-a', { segment_id: 'buyers' })], cost: 0.1, settings: { cost_budget_usd: 0.25, concurrency: 1 } });
  const report = await r.run.done;
  assert.match(report.stop_reason ?? '', /budget/);
  assert.ok(of(r.events, 'comparison.source').length > 0);
  assert.equal(report.comparison?.coverage.length, 4);
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 0));
  assert.equal(report.comparison?.decision.status, 'insufficient_evidence');
  assert.ok(report.comparison?.cells.every((cell) => cell.assessment === 'unknown'));
});

test('comparison analysis spending does not consume a separately declared navigation allowance', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const target = publicComparison();
  target.comparison!.execution.analysis_reserve_fraction = 0.5;
  const r = begin(comparisonAnswer, { project: target, personas: [persona('buyer-a', { segment_id: 'buyers' }), persona('buyer-b', { segment_id: 'buyers' })], cost: 0.01, settings: { cost_budget_usd: 0.25, concurrency: 1 } });
  const report = await r.run.done;
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 2));
  assert.equal(report.comparison?.coverage.reduce((sum, row) => sum + row.outcomes.incomplete, 0), 0);
});

test('comparison admission keeps the next matched task block unattempted when its allowance will not fit', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const r = begin(comparisonAnswer, { project: publicComparison(), personas: [persona('buyer-a', { segment_id: 'buyers' }), persona('buyer-b', { segment_id: 'buyers' })], cost: 0.01, settings: { cost_budget_usd: 0.2, concurrency: 1 } });
  const report = await r.run.done;
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 1 && row.outcomes.not_attempted === 1));
  assert.equal(of(r.events, 'comparison.episode_started').filter((event) => event.persona_id === 'buyer-b').length, 0);
  assert.match(report.stop_reason ?? '', /matched task block/);
  assert.ok(report.comparison?.limitations.some((item) => /Not attempted.*matched task block/.test(item)));
});

test('unpriced comparison routes stay usable while disclosing that initial admission has no dollar reservation', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const routing = { ...DEFAULT_SETTINGS.routing, navigator: { provider: 'openai' as const, model: 'custom-unpriced-navigator' }, judge: { provider: 'openai' as const, model: 'custom-unpriced-judge' } };
  const r = begin(comparisonAnswer, { project: publicComparison(), personas: [persona('buyer-a', { segment_id: 'buyers' })], cost: 0.01, settings: { cost_budget_usd: 2, concurrency: 1, routing } });
  const report = await r.run.done;
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 1));
  assert.ok(report.comparison?.limitations.some((item) => /pricing was unavailable.*custom-unpriced-navigator/.test(item)));
});

test('invalid direct comparison input is rejected before any configured reset action', (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 200 }));
  const target = publicComparison();
  for (const [index, item] of target.comparison!.targets.entries()) {
    item.access_scope = 'authenticated_workflow'; item.session_role = `target-${index}`;
  }
  target.pois = target.pois.map((poi) => poi.type === 'web' ? { ...poi, mode: 'full', reset_hook_url: `${poi.start_url}reset` } : poi);
  target.comparison!.tasks[0].scenario_id = 'missing-scenario';
  assert.throws(() => begin(comparisonAnswer, { project: target, config: { reset: true } }), /unknown scenario/);
  assert.equal(fetch.mock.calls.length, 0);
});

test('stopping during comparison verification cancels use of its late answer and preserves evidence', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const r = begin(comparisonAnswer, { project: publicComparison(), personas: [persona('buyer-a', { segment_id: 'buyers' })], onCall: (req, run) => { if (req.purpose === 'comparison_verification') run.stop(); } });
  const report = await r.run.done;
  assert.equal(report.stop_reason, 'user');
  assert.ok(of(r.events, 'comparison.source').length > 0);
  assert.equal(of(r.events, 'comparison.assessment').length, 0, 'cancelled judgments must not enter the projection');
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 0));
});

test('authenticated comparison uses separate target sessions and preserves each frozen task entry URL', async () => {
  const target = publicComparison();
  target.pois = target.pois.slice(0, 2).map((poi) => ({ ...poi, mode: 'full' } as WebPoi));
  target.comparison!.targets = target.comparison!.targets.slice(0, 2).map((item, i) => ({ ...item, access_scope: 'authenticated_workflow', session_role: `target-${i}-recruiter` }));
  target.comparison!.tasks[0].entries = target.comparison!.tasks[0].entries.slice(0, 2).map((entry, i) => ({ ...entry, start_url: `https://${i === 0 ? 'alpha' : 'beta'}.example/assigned-work` }));
  const infos: SessionInfo[] = target.comparison!.targets.map((item, i) => ({ ...recruiter, role: item.session_role!, target_id: item.id, start_url: `https://${i === 0 ? 'alpha' : 'beta'}.example/private-dashboard`, hosts: [i === 0 ? 'alpha.example' : 'beta.example'] }));
  const loaded: string[] = [];
  const sessions: SessionStore = { list: () => infos, save: async () => {}, markVerified: () => {}, load: async (role) => { loaded.push(role); const info = infos.find((candidate) => candidate.role === role); return info ? { info, state: { isolated_target: info.target_id } } : null; } };
  const r = begin(comparisonAnswer, { project: target, personas: [persona('buyer-a', { segment_id: 'buyers' })], sessions: infos, sessionStore: sessions });
  const report = await r.run.done;
  assert.equal(loaded.length, 2);
  assert.equal(new Set(loaded).size, 2);
  assert.ok(r.pages.every((page) => page.gotos[0].endsWith('/assigned-work')));
  assert.equal(new Set(r.pages.map((page) => page.options.storageState?.isolated_target)).size, 2);
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 1));
});


test('comparison verifies success on the final allowed action from its post-action confirmation capture', async () => {
  const target = publicComparison();
  target.pois = target.pois.slice(0, 2).map((poi) => ({ ...poi, mode: 'full' } as WebPoi));
  target.comparison!.targets = target.comparison!.targets.slice(0, 2).map((item, i) => ({ ...item, access_scope: 'authenticated_workflow', session_role: `target-${i}-recruiter` }));
  const task = target.comparison!.tasks[0];
  task.entries = task.entries.slice(0, 2);
  task.max_steps = 1;
  task.instruction = 'Submit the candidate evaluation.';
  task.success_rule = 'The evaluation submission is confirmed on screen.';
  target.comparison!.criteria = [{ id: 'entry', name: 'Submit evaluation', question: 'Can the evaluation be submitted?', evidence_required: 'An actual submission action and its visible confirmation.', importance: 'must_have', decision_rule: 'Meets when the page confirms the evaluation was submitted.' }];
  const infos: SessionInfo[] = target.comparison!.targets.map((item, i) => ({ ...recruiter, role: item.session_role!, target_id: item.id, start_url: `https://${i === 0 ? 'alpha' : 'beta'}.example/`, hosts: [i === 0 ? 'alpha.example' : 'beta.example'] }));
  const sessionStore: SessionStore = { list: () => infos, save: async () => {}, markVerified: () => {}, load: async (role) => { const info = infos.find((item) => item.role === role); return info ? { info, state: {} } : null; } };
  const submitted = new Set<string>();
  const r = begin((req) => {
    if (req.role === 'navigator') return step('click', 'e1', null);
    if (req.purpose === 'comparison_assessment') {
      const input = JSON.parse(req.user.find((part) => part.type === 'text')!.text);
      const action = input.sources.find((item: { kind: string }) => item.kind === 'action');
      const confirmation = input.sources.find((item: { kind: string; text: string }) => item.kind === 'page' && item.text.includes('Evaluation submitted'));
      assert.ok(confirmation, 'the judge sees the actual result despite having no remaining navigator step');
      const evidence = [action, confirmation].map((source) => ({ event_seq: source.event_seq, source: source.source, quote: source.text }));
      return { outcome: 'completed', reason: 'The submit action was confirmed on screen within the one-step allowance.', outcome_evidence: evidence, criteria: [{ criterion_id: 'entry', assessment: 'meets', basis: 'observed_behavior', summary: 'Evaluation submission was confirmed.', evidence }] };
    }
    return comparisonAnswer(req);
  }, {
    project: target, personas: [persona('buyer-a', { segment_id: 'buyers' })], sessions: infos, sessionStore,
    act: (_action, options) => { submitted.add(options.allowedHosts[0]); return {}; },
    snapshot: (url) => submitted.has(new URL(url).hostname) ? { text: 'Evaluation submitted successfully.', hash: 'confirmation' } : { text: '- button "Submit evaluation" [ref=e1]', hash: 'evaluation-form' },
  });
  const report = await r.run.done;
  assert.equal(of(r.events, 'signal.budget_exceeded').length, 2, 'the legacy loop reaches its last permitted action');
  assert.ok(report.comparison?.coverage.every((row) => row.outcomes.completed === 1 && row.outcomes.task_failed === 0));
  assert.ok(report.comparison?.cells.every((cell) => cell.assessment === 'meets' && cell.bases.includes('observed_behavior')));
  const confirmations = of(r.events, 'comparison.source').filter((event) => event.payload.text.includes('Evaluation submitted'));
  assert.equal(confirmations.length, 2);
  assert.ok(confirmations.every((event) => event.payload.screenshot?.endsWith('-after.jpg')));
});
