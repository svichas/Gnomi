// startRun and the step loop over in-memory fakes of the store, blobs and browser, with scripted models.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createScriptedGateway, DEMO_SCRIPT, findRef, type Script } from './llm/scripted.ts';
import { createRecorder, newRunConfig, startRun, type RunHandle } from './run.ts';
import type { BlobStore, BrowserPool, LlmGateway, LlmRequest, PageDriver, ProjectStore, Recorder } from './seams.ts';
import type { Action, ActionOutcome, ActionType, EventOf, EventType, GnomiEvent, ProjectConfig, RunConfig } from './types.ts';

const project: ProjectConfig = {
  name: 'Gym ATS',
  description: '',
  poi: { id: 'poi-1', type: 'web', name: 'Gym ATS', start_url: 'http://gym.test/' },
  goal: 'Post a job for a backend engineer',
};

const step = (type: ActionType, ref: string | null = null, text: string | null = null, friction: object | null = null) => ({
  thought: `Priya does a ${type}.`,
  feeling: 0,
  action: { type, ref, text },
  friction,
});

const of = <K extends EventType>(events: GnomiEvent[], type: K) => events.filter((e): e is EventOf<K> => e.type === type);

function begin(model: Script | ((record: Recorder) => LlmGateway), opts: { config?: Partial<RunConfig>; act?: (a: Action) => Partial<ActionOutcome> } = {}) {
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
    close: () => {},
  };
  const files = new Map<string, Uint8Array>();
  const blobs: BlobStore = {
    put: async (path, data) => void files.set(path, data),
    get: async (path) => files.get(path) ?? Promise.reject(new Error(`no blob ${path}`)),
  };
  const page = { url: '', closed: false };
  const driver: PageDriver = {
    goto: async (url) => void (page.url = url),
    snapshot: async () => ({ url: page.url, title: 'Dashboard · Gym ATS', text: '- link "Jobs" [ref=e1]', hash: 'h1' }),
    screenshot: async () => new Uint8Array([0xff, 0xd8, 0xff]),
    act: async (action) => ({
      ok: true,
      url_before: page.url,
      url_after: page.url,
      dom_changed: true,
      error: null,
      target: { role: 'link', name: 'Jobs', box: null },
      text: null,
      ...opts.act?.(action),
    }),
    close: async () => void (page.closed = true),
  };
  const browsers: BrowserPool = { newPage: async () => driver, close: async () => {} };
  const record = createRecorder(store, () => {});
  const llm = Array.isArray(model) ? createScriptedGateway(model, record) : model(record);
  const config = { ...store.createRun(newRunConfig(project)), ...opts.config };
  const run = startRun(config, { store, blobs, browsers, llm, record });
  return { run, events, transcripts, finished, files, page, types: () => events.map((e) => e.type) };
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
  assert.equal(r.page.closed, true);
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
  assert.equal(r.page.closed, true);
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
  assert.equal(r.page.closed, true);
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
