import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openProject } from '../log/sqlite.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type {
  ActionTarget,
  Audience,
  EventPayloads,
  GnomiEvent,
  NewEvent,
  Persona,
  ProjectConfig,
  RunConfig,
  RunSettings,
  Segment,
  WebPoi,
} from '../types.ts';
import { buildReport, HYPOTHESIS_BANNER } from './build.ts';
import { reportToMarkdown } from './markdown.ts';

const url = 'http://localhost:3001/jobs/new';
const startUrl = 'http://localhost:3001/';

const project: ProjectConfig = {
  name: 'Gym',
  description: 'A demo ATS.',
  pois: [{
    id: 'poi-gym',
    type: 'web',
    name: 'Gym',
    start_url: startUrl,
    allowed_hosts: [],
    production_domains: [],
    reset_hook_url: null,
    mode: 'full',
    segments: null,
  }],
  goal: 'Post a job for a backend engineer',
  role: null,
  audience: null,
  settings: DEFAULT_SETTINGS,
};

const config: RunConfig = {
  run_id: 'r-0001',
  seed: 42,
  project,
  personas: [BUILTIN_PERSONA],
  sessions: [],
  reset: false,
  pause_timeout_ms: 300000,
  app_version: '0.0.0',
};

const env = { run_id: 'r-0001', round: 1, persona_id: 'p-001', poi_id: 'poi-gym' } as const;
const runEnv = { run_id: 'r-0001', round: 1, persona_id: null, poi_id: null } as const;
const who = (persona_id: string) => ({ run_id: 'r-0001', round: 1, persona_id, poi_id: 'poi-gym' }) as const;
const runStarted: NewEvent = { ...runEnv, type: 'run.started', payload: { config } };
const startedAt: [number, NewEvent] = [1000, runStarted];

function stepPayload(step_no: number, thought: string, screenshot: string | null): EventPayloads['persona.step'] {
  return {
    step_no,
    action: { type: 'click', ref: 'e1', text: null },
    target: null,
    result: { ok: true, url_before: url, url_after: url, dom_changed: true, error: null },
    thought,
    feeling: 0,
    snapshot_hash: 'h',
    screenshot,
    duration_ms: 10,
    heard_post_ids: [],
  };
}

function llmCall(cost_usd: number, input_tokens: number, output_tokens: number): EventPayloads['llm.call'] {
  return {
    role: 'navigator',
    provider: 'anthropic',
    model: 'claude-haiku-5-5',
    input_tokens,
    output_tokens,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd,
    latency_ms: 900,
    status: 'ok',
    error: null,
  };
}

function friction(step_no: number, what: string, severity = 2): EventPayloads['persona.friction_reported'] {
  return { step_no, severity, what, expected: 'Something clearer.', where: { url, ref: null }, heard_post_ids: [] };
}

// Each entry is [ts, event], in the order the engine would append them.
type Script = Array<[number, NewEvent]>;

// The events as the store returns them: seq counts from 1, ts is the scripted one.
const stored = (script: Script): GnomiEvent[] => script.map(([ts, event], i) => ({ ...event, seq: i + 1, ts }));

// --- One persona (the built-in one, as M0 and M1 ran) ---

const stepAt = (ts: number, step_no = 1): [number, NewEvent] => [
  ts,
  { ...env, type: 'persona.step', payload: stepPayload(step_no, 'Trying.', null) },
];
const blockedAt = (ts: number, detail = 'reCAPTCHA on the sign-in page'): [number, NewEvent] => [
  ts,
  { ...env, type: 'persona.blocked', payload: { step_no: 1, reason: 'captcha', detail } },
];
const resumedAt = (ts: number): [number, NewEvent] => [ts, { ...env, type: 'persona.resumed', payload: { step_no: 1 } }];
const budgetAt = (ts: number): [number, NewEvent] => [
  ts,
  { ...env, type: 'signal.budget_exceeded', payload: { step_no: 1, budget: 1 } },
];
const abandonAt = (ts: number): [number, NewEvent] => [
  ts,
  { ...env, type: 'persona.abandoned', payload: { step_no: 1, reason: 'Could not find the job form.' } },
];
const failureAt = (ts: number): [number, NewEvent] => [
  ts,
  { ...env, type: 'signal.repeated_failure', payload: { step_no: 1, action: 'click', error: 'ref_not_found' } },
];

function finishedRun(): Script {
  return [
    startedAt,
    [1100, { ...env, type: 'persona.episode_started', payload: { poi_id: 'poi-gym', device: 'desktop', start_url: url } }],
    // A friction logged before its step.
    [1200, { ...env, type: 'persona.friction_reported', payload: friction(1, 'The Save button is ambiguous.') }],
    [1300, { ...env, type: 'persona.step', payload: stepPayload(1, 'Looking for the way to post a job.', 'runs/r-0001/shots/p-001-0001.jpg') }],
    [1350, { ...env, type: 'llm.call', payload: llmCall(0.25, 1200, 300) }],
    [1400, { ...env, type: 'persona.step', payload: stepPayload(2, 'The form gives no error text.', null) }],
    // A friction logged after its step.
    [1500, { ...env, type: 'persona.friction_reported', payload: friction(2, 'The required field gives no error.', 3) }],
    // Cached input is reported apart from input_tokens and still counts as input.
    [1550, { ...env, type: 'llm.call', payload: { ...llmCall(0.5, 800, 100), cache_read_tokens: 3000, cache_write_tokens: 500 } }],
    [1700, { ...env, type: 'persona.goal_done', payload: { step_no: 2, summary: 'Posted the job.' } }],
    [9000, { ...runEnv, type: 'run.finished', payload: {} }],
    [9100, { ...runEnv, type: 'report.generated', payload: { path: 'runs/r-0001/report.json', friction_count: 2 } }],
  ];
}

test('a finished run folds into its outcome, frictions, totals and methods', () => {
  assert.deepEqual(buildReport(stored(finishedRun())), {
    run_id: 'r-0001',
    status: 'finished',
    stop_reason: null,
    goal: 'Post a job for a backend engineer',
    pois: [{ id: 'poi-gym', type: 'web', name: 'Gym', start_url: startUrl }],
    personas: [
      {
        id: 'p-001',
        name: 'Priya Natarajan',
        job_title: 'Recruiter',
        segment_id: null,
        device: 'desktop',
        outcome: 'done',
        outcome_text: 'Posted the job.',
        steps: 2,
        frictions: 2,
      },
    ],
    personas_fingerprint: '5d864bf4b3484168',
    segments: [
      {
        id: null,
        name: 'Built-in persona',
        share: 100,
        personas: 1,
        outcomes: { done: 1, abandoned: 0, budget_exceeded: 0, repeated_failure: 0, model_failed: 0, blocked: 0, incomplete: 0, not_started: 0 },
        completion: 1,
        with_friction: 1,
        frictions: 2,
      },
    ],
    weighted: { completion: 1, with_friction: 1 },
    steps: 2,
    coverage: [{ poi_id: 'poi-gym', curve: [1], last_fifth: { personas: 1, themes: 1 }, thin_pages: [{ page: 'localhost:3001/jobs/new', personas: 1 }], hint: 'With 1 persona the curve is too short to read.' }],
    flows: [{ poi_id: 'poi-gym', personas: 1, pages: [{ page: 'localhost:3001/jobs/new', reached: 1, ended: { done: 1 } }], moves: [], left_out: { pages: 0, ended: 0 } }],
    frictions: [
      {
        seq: 3,
        persona_id: 'p-001',
        persona_name: 'Priya Natarajan',
        segment_id: null,
        step_no: 1,
        severity: 2,
        what: 'The Save button is ambiguous.',
        expected: 'Something clearer.',
        url,
        quote: 'Looking for the way to post a job.',
        screenshot: 'runs/r-0001/shots/p-001-0001.jpg',
      },
      {
        seq: 7,
        persona_id: 'p-001',
        persona_name: 'Priya Natarajan',
        segment_id: null,
        step_no: 2,
        severity: 3,
        what: 'The required field gives no error.',
        expected: 'Something clearer.',
        url,
        quote: 'The form gives no error text.',
        screenshot: null,
      },
    ],
    // Both self-reports are on one page with no named element: one deterministic theme, named by rules.
    themes: [
      {
        id: 'g1',
        keys: [JSON.stringify(['poi-gym', 'localhost:3001/jobs/new', 'kind', 'friction'])],
        poi_id: 'poi-gym',
        rank: 1,
        title: 'Reported friction on /jobs/new',
        description: 'The required field gives no error.',
        named_by: 'rules',
        category: 'friction',
        // One persona of one: the share's 95% range runs from 21% to 100%, and the score uses its low end.
        prevalence: { personas: 1, exposed: 1, share: 1, low: 0.2065, high: 1, level: 'single' },
        heard_first: 0,
        first_hand: ['p-001'],
        trust: 'reported',
        trust_counts: { confirmed: 0, observed: 0, reported: 2 },
        severity: 3, // one persona, at its worst
        score: 0.2065 * 0.5,
        personas: 1,
        frictions: 2,
        pages: ['localhost:3001/jobs/new'],
        elements: [],
        affected: [{ segment_id: null, name: 'Built-in persona', affected: 1, reached: 1, rate: 1 }],
        evidence: [
          { seq: 7, step_seq: 6, persona_id: 'p-001', persona_name: 'Priya Natarajan', segment_id: null, step_no: 2, url, severity: 3, trust: 'reported', what: 'The required field gives no error.', quote: 'The form gives no error text.', screenshot: null, signals: [] },
          { seq: 3, step_seq: 4, persona_id: 'p-001', persona_name: 'Priya Natarajan', segment_id: null, step_no: 1, url, severity: 2, trust: 'reported', what: 'The Save button is ambiguous.', quote: 'Looking for the way to post a job.', screenshot: 'runs/r-0001/shots/p-001-0001.jpg', signals: [] },
        ],
        seqs: [3, 7],
        suggestion: null,
      },
    ],
    reach: [{ poi_id: 'poi-gym', started: ['p-001'], surveyed: [], pages: { 'localhost:3001/jobs/new': ['p-001'] } }],
    sentiment: [],
    went_well: [],
    cost_usd: 0.75,
    unreported_usage_calls: 0,
    llm_calls: 2,
    input_tokens: 5500,
    output_tokens: 400,
    started_at: 1000,
    ended_at: 9000,
    duration_ms: 8000,
    banner: HYPOTHESIS_BANNER,
    methods: {
      seed: 42,
      roles: [],
      models: { navigator: { provider: 'anthropic', model: 'claude-haiku-5-5' } },
      budgets: { cost_usd: 5, wall_clock_min: 60, concurrency: 12 },
      allowed_hosts: ['localhost'],
      blocked_requests: [],
      blocked: [],
      tripwires: [],
      reset: null,
      concurrency_changes: [],
      signal_thresholds: null,
      limitations: [
        'The judge model did not name the themes (no key, a model failure, or the run stopped first), so each theme is one deterministic group with a generated title.',
        'The author model wrote no suggested changes (no key, a model failure, or the run stopped first).',
        'Only 1 persona tried Gym, so every share has a wide range and the order of the problems is rough.',
        'No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".',
      ],
    },
  });
});

test('recorded cost keeps known charges and counts only explicitly missing usage', () => {
  const script: Script = [
    startedAt,
    [1100, { ...env, type: 'llm.call', payload: { ...llmCall(0.25, 100, 20), usage_reported: true } }],
    [1200, { ...env, type: 'llm.call', payload: { ...llmCall(0.05, 50, 0), usage_reported: false, status: 'error', error: 'Canceled' } }],
    [1300, { ...env, type: 'llm.call', payload: { ...llmCall(0, 0, 0), usage_reported: false, status: 'invalid_output', error: 'No usage returned' } }],
    // Old logs do not say whether usage was returned, even for failed calls.
    [1400, { ...env, type: 'llm.call', payload: { ...llmCall(0, 0, 0), status: 'error', error: 'Legacy error' } }],
    [1500, { ...runEnv, type: 'run.stopped', payload: { reason: 'user', detail: null } }],
  ];
  const report = buildReport(stored(script));
  assert.equal(report.cost_usd, 0.3);
  assert.equal(report.unreported_usage_calls, 2);
  assert.equal(report.llm_calls, 4);
  assert.deepEqual([report.input_tokens, report.output_tokens], [150, 20]);
  assert.equal(buildReport(stored(finishedRun())).unreported_usage_calls, 0);
});

test('a stopped run carries the stop reason with its detail, and a budget signal', () => {
  const report = buildReport(
    stored([
      startedAt,
      stepAt(1100),
      budgetAt(2000),
      [2100, { ...runEnv, type: 'run.stopped', payload: { reason: 'cost_budget', detail: '$1.00 spent' } }],
    ]),
  );
  assert.equal(report.status, 'stopped');
  assert.equal(report.stop_reason, 'cost_budget: $1.00 spent');
  assert.equal(report.personas[0].outcome, 'budget_exceeded');
  assert.equal(report.personas[0].outcome_text, null);
  assert.equal(report.ended_at, 2100);
  assert.equal(report.duration_ms, 1100);
});

test('a run without an end event is still running and its persona has no outcome', () => {
  const report = buildReport(stored([startedAt, stepAt(1100)]));
  assert.equal(report.status, 'running');
  assert.equal(report.stop_reason, null);
  assert.equal(report.personas[0].outcome, 'incomplete');
  assert.equal(report.ended_at, null);
  assert.equal(report.duration_ms, null);
  assert.equal(report.steps, 1);
});

test('an abandoned persona reports the reason it gave up', () => {
  const report = buildReport(stored([startedAt, stepAt(1100), abandonAt(1200), [1300, { ...runEnv, type: 'run.finished', payload: {} }]]));
  assert.equal(report.personas[0].outcome, 'abandoned');
  assert.equal(report.personas[0].outcome_text, 'Could not find the job form.');
});

test('a block the persona resumes from keeps the outcome of the episode', () => {
  const report = buildReport(
    stored([
      startedAt,
      stepAt(1100),
      blockedAt(1200),
      resumedAt(1300),
      stepAt(1400, 2),
      [1500, { ...env, type: 'persona.goal_done', payload: { step_no: 2, summary: 'Signed in and posted.' } }],
    ]),
  );
  assert.equal(report.personas[0].outcome, 'done');
  assert.deepEqual(report.methods.blocked, [
    { persona_id: 'p-001', step_no: 1, reason: 'captcha', detail: 'reCAPTCHA on the sign-in page', resumed: true },
  ]);
});

test('a block that is never resumed ends the outcome as blocked, with the detail as its text', () => {
  const report = buildReport(stored([startedAt, stepAt(1100), blockedAt(1200, 'Redirected to /login')]));
  assert.equal(report.personas[0].outcome, 'blocked');
  assert.equal(report.personas[0].outcome_text, 'Redirected to /login');
  assert.deepEqual(report.methods.blocked, [
    { persona_id: 'p-001', step_no: 1, reason: 'captcha', detail: 'Redirected to /login', resumed: false },
  ]);
});

test('outcomes follow done > abandoned > repeated_failure > blocked > budget_exceeded > incomplete', () => {
  const outcomeOf = (...tail: Script) => buildReport(stored([startedAt, stepAt(1100), ...tail])).personas[0].outcome;
  assert.equal(outcomeOf(blockedAt(1200), budgetAt(1300)), 'blocked');
  assert.equal(outcomeOf(budgetAt(1200), blockedAt(1300)), 'blocked');
  assert.equal(outcomeOf(blockedAt(1200), failureAt(1300)), 'repeated_failure');
  assert.equal(outcomeOf(blockedAt(1200), abandonAt(1300)), 'abandoned');
  assert.equal(outcomeOf(blockedAt(1200), resumedAt(1300), budgetAt(1400)), 'budget_exceeded');
  assert.equal(outcomeOf(budgetAt(1200)), 'budget_exceeded');
  assert.equal(outcomeOf(), 'incomplete');
  const silent: [number, NewEvent] = [1200, { ...env, type: 'signal.repeated_failure', payload: { step_no: 3, action: 'wait', error: 'invalid_output' } }];
  assert.deepEqual(buildReport(stored([startedAt, stepAt(1100), silent])).personas[0].outcome_text?.startsWith('The model gave no valid answer'), true);
  assert.equal(outcomeOf(silent), 'model_failed', 'the model failing to answer is not the product');
});

test('the methods appendix counts blocked requests per host, most first, ties A to Z', () => {
  const blockedRequest = (host: string, path: string): [number, NewEvent] => [
    1200,
    { ...env, type: 'containment.blocked_request', payload: { host, url: `https://${host}${path}`, method: 'GET' } },
  ];
  const report = buildReport(
    stored([
      startedAt,
      blockedRequest('ads.example.net', '/pixel'),
      blockedRequest('cdn.example.com', '/app.js'),
      blockedRequest('ads.example.net', '/beacon'),
      blockedRequest('a.example.org', '/chat'),
      blockedRequest('a.example.org', '/widget'),
    ]),
  );
  assert.deepEqual(report.methods.blocked_requests, [
    { host: 'a.example.org', count: 2 },
    { host: 'ads.example.net', count: 2 },
    { host: 'cdn.example.com', count: 1 },
  ]);
});

const tapAt = (persona_id: string, step_no: number, name: string, box: [number, number, number, number]): Script => [
  [1100, { ...who(persona_id), type: 'persona.step', payload: { ...stepPayload(step_no, 'A tap.', null), target: { role: 'link', name, box } } }],
  [1101, { ...who(persona_id), type: 'signal.small_target', payload: { step_no, url: `${url}?token=s3cret`, ref: 'e1', box } }],
];

test('undersized targets are an audit in the methods, not findings: no theme and no friction rate', () => {
  const report = buildReport(stored([
    startedAt,
    ...tapAt('p-001', 1, 'Terms', [0, 0, 18.4, 12.2]),
    ...tapAt('p-001', 2, 'Jobs', [0, 0, 208, 21]),
    ...tapAt('p-001', 3, 'Jobs', [0, 0, 208, 21]),
    ...tapAt('p-002', 1, 'Jobs', [0, 0, 208, 21]),
    ...tapAt('p-002', 2, ' ', [0, 0, 16, 16]),
    [1900, { ...runEnv, type: 'run.finished', payload: {} }],
  ]));
  assert.deepEqual(report.methods.undersized_targets, [
    { page: 'localhost:3001/jobs/new', element: 'link "Jobs"', width: 208, height: 21, personas: 2 },
    { page: 'localhost:3001/jobs/new', element: 'link "Terms"', width: 18, height: 12, personas: 1 },
    { page: 'localhost:3001/jobs/new', element: null, width: 16, height: 16, personas: 1 },
  ]);
  assert.deepEqual(report.themes, []);
  assert.equal(report.weighted.with_friction, 0, 'nobody ran into friction');
  const md = reportToMarkdown(report);
  assert.ok(md.includes('- Undersized tap targets on your product (an audit, not findings; only elements a mobile persona tapped): localhost:3001/jobs/new, link "Jobs", 208×21 px, 2 personas; localhost:3001/jobs/new, link "Terms", 18×12 px, 1 persona; localhost:3001/jobs/new, unnamed element, 16×16 px, 1 persona\n'));
  assert.ok(!md.includes('s3cret') && !md.includes('Small tap targets'));
  assert.ok(md.includes('No themes. Small-target and backtrack signals do not make one alone; any undersized targets on your product are listed under Methods.'));
  assert.ok(!md.includes('No frictions to group into themes'), 'signals did fire');
});

test("the undersized-target audit covers the team's product, not a competitor's site", () => {
  const rival = { ...project.pois[0], id: 'poi-rival', name: 'Rival', start_url: 'http://rival.test/', mode: 'observe_only' } as WebPoi;
  const started = { ...runEnv, type: 'run.started', payload: { config: { ...config, project: { ...project, pois: [...project.pois, rival] } } } } as NewEvent;
  const onRival = tapAt('p-001', 2, 'Pricing', [0, 0, 30, 20]).map(([ts, event]): [number, NewEvent] => [ts, { ...event, poi_id: 'poi-rival' }]);
  const report = buildReport(stored([[1000, started], ...tapAt('p-001', 1, 'Jobs', [0, 0, 208, 21]), ...onRival]));
  assert.deepEqual(report.methods.undersized_targets?.map((t) => t.element), ['link "Jobs"']);
  const onlyRival = buildReport(stored([[1000, started], ...onRival]));
  assert.ok(!('undersized_targets' in onlyRival.methods));
});

test('an older log keeps its frozen threshold, and a log without the signal builds without the audit', () => {
  const frozen = { ...config, signals: { loop_visits: 3, loop_window: 10, back_count: 2, back_window: 5, revisit_window: 4, small_target_px: 40 } };
  const report = buildReport(stored([[1000, { ...runEnv, type: 'run.started', payload: { config: frozen } }], ...tapAt('p-001', 1, 'Jobs', [0, 0, 120, 39])]));
  assert.deepEqual(report.methods.undersized_targets?.map((t) => [t.width, t.height]), [[120, 39]], 'detected under 40, so listed under 40');
  assert.equal(report.methods.signal_thresholds?.small_target_px, 40);
  assert.ok(!('undersized_targets' in buildReport(stored(finishedRun())).methods));
});

const violation = (rule: string, impact: 'serious' | 'moderate' | 'minor' = 'moderate'): Omit<EventPayloads['signal.accessibility'], keyof EventPayloads['signal.loop']> & { rule: string } => ({ rule, impact, category: 'structure', help: `${rule} help`, elements: 4, selectors: ['main > h3', 'main > h4', 'main > h5'] });
const scannedAt = (persona_id: string, step_no: number, page: string, audit: ReturnType<typeof violation>[], error: string | null = null): Script => [
  [1100, { ...who(persona_id), type: 'persona.step', payload: stepPayload(step_no, 'A look.', `shots/${step_no}.jpg`) }],
  [1101, { ...who(persona_id), type: 'accessibility.scanned', payload: { step_no, url: `${page}?token=s3cret`, snapshot_hash: `h${step_no}`, audit, error } }],
];

test('moderate and minor scan results are an audit in the methods, not findings, and a page the scan never got through is counted', () => {
  const signal: [number, NewEvent] = [1102, { ...who('p-001'), type: 'signal.accessibility', payload: { step_no: 1, url, ref: null, ...violation('color-contrast', 'serious') } }];
  const report = buildReport(stored([
    startedAt,
    ...scannedAt('p-001', 1, url, [violation('heading-order'), violation('region', 'minor')]),
    signal,
    ...scannedAt('p-002', 2, 'http://localhost:3001/jobs/new', [violation('region', 'minor')]),
    ...scannedAt('p-002', 3, 'http://localhost:3001/settings', [], 'page.evaluate: no'),
    ...scannedAt('p-002', 4, 'http://localhost:3001/billing', [], 'no result in 10000 ms'),
    ...scannedAt('p-001', 5, 'http://localhost:3001/billing', []),
    [1900, { ...runEnv, type: 'run.finished', payload: {} }],
  ]));
  assert.deepEqual(report.methods.accessibility_audit, [
    { page: 'localhost:3001/jobs/new', rule: 'heading-order', impact: 'moderate', help: 'heading-order help', elements: 4, selectors: ['main > h3', 'main > h4', 'main > h5'] },
    { page: 'localhost:3001/jobs/new', rule: 'region', impact: 'minor', help: 'region help', elements: 4, selectors: ['main > h3', 'main > h4', 'main > h5'] },
  ]);
  assert.ok(report.methods.limitations?.includes('The accessibility scan failed on 1 page, so nothing is known about it from the scan.'), 'settings: billing was scanned on another try');
  const [theme] = report.themes!;
  assert.ok(theme.scan_only);
  assert.equal(report.weighted.with_friction, 0, 'the scan\'s step is not a persona running into friction');
  assert.equal(report.frictions.length, 0);
  const md = reportToMarkdown(report);
  assert.ok(md.includes('- Accessibility audit of your product (an audit, not findings; the moderate and minor rules the page scan flagged, not ranked): localhost:3001/jobs/new, heading-order help (heading-order, moderate, 4 elements: main &gt; h3; main &gt; h4; main &gt; h5 and more); '));
  assert.ok(md.includes('- Evidence: Found by the accessibility scan of the page, not by a persona.'));
  assert.ok(md.includes('- Accessibility scan: color-contrast, serious, 4 elements: main &gt; h3; main &gt; h4; main &gt; h5 and more. Found by the accessibility scan'));
  assert.ok(!md.includes('Affected first-hand by segment') && !md.includes('none, 0 of'), 'no share of personas');
  assert.ok(md.includes('- Severity 2 of 4, 1 friction\n'), 'no count of personas or score');
  assert.ok(!md.includes('s3cret'));
});

test('a run says which personas had what code limits about perception, and its screenshots are read accordingly', () => {
  const started = (persona_id: string, perception?: 'deuteranopia' | 'blurredVision' | 'screen_reader'): [number, NewEvent] => [1050, { ...who(persona_id), type: 'persona.episode_started', payload: { poi_id: 'poi-gym', device: 'desktop', start_url: startUrl, ...(perception && { perception }) } }];
  const { limitations } = buildReport(stored([startedAt, started('p-001', 'deuteranopia'), started('p-002', 'blurredVision'), started('p-003', 'screen_reader'), started('p-004')])).methods;
  assert.ok(limitations?.includes('2 personas browsed with simulated colour-blind or blurred vision, so the screenshots stored for them, here and in the inspector, show that rather than the page as designed.'));
  assert.ok(limitations?.includes('1 screen-reader persona got the page as text without screenshots, so a screenshot stored for them is what the page looked like, not what they perceived.'));
});

test('a log from before the scan builds without any of it', () => {
  const report = buildReport(stored(finishedRun()));
  assert.ok(!('accessibility_audit' in report.methods));
  assert.ok(!report.themes?.some((t) => 'scan_only' in t));
  assert.ok(!report.methods.limitations?.some((l) => /accessibility|screen-reader|simulated/.test(l)));
});

test('allowed hosts start with the start page host and drop duplicates', () => {
  const withHosts: RunConfig = {
    ...config,
    project: { ...project, pois: [{ ...(project.pois[0] as WebPoi), allowed_hosts: ['cdn.example.com', 'localhost'] }] },
  };
  const report = buildReport(stored([[1000, { ...runEnv, type: 'run.started', payload: { config: withHosts } }]]));
  assert.deepEqual(report.methods.allowed_hosts, ['localhost', 'cdn.example.com']);
});

test('tripwires and the reset hook are listed in the appendix', () => {
  const report = buildReport(
    stored([
      startedAt,
      [1050, { ...runEnv, type: 'run.reset_called', payload: { url: 'https://staging.example/reset', status: 200, error: null } }],
      stepAt(1100),
      [1500, { ...env, type: 'containment.tripwire', payload: { kind: 'live_payment_key', detail: 'pk_live_ on /checkout' } }],
      [1600, { ...runEnv, type: 'run.stopped', payload: { reason: 'tripwire', detail: null } }],
    ]),
  );
  assert.equal(report.status, 'stopped');
  assert.equal(report.stop_reason, 'tripwire');
  assert.deepEqual(report.methods.tripwires, [{ kind: 'live_payment_key', detail: 'pk_live_ on /checkout' }]);
  assert.deepEqual(report.methods.reset, { url: 'https://staging.example/reset', status: 200, error: null });
});

test('without an audience the roles are the project role; with one, the roles of the segments in use', () => {
  const soloRole = (role: string | null) =>
    buildReport(stored([[1000, { ...runEnv, type: 'run.started', payload: { config: { ...config, project: { ...project, role } } } }]])).methods.roles;
  assert.deepEqual(soloRole('admin'), ['admin']);
  assert.deepEqual(soloRole(null), []);
});

test('buildReport refuses a log without run.started', () => {
  assert.throws(() => buildReport(stored([stepAt(1100)])), /run\.started/);
});

// --- A population: 2 segments, 6 personas ---

const segment = (id: string, name: string, share: number, role: string | null): Segment => ({
  id,
  name,
  description: `${name} at companies that sell to HR`,
  share,
  role,
  usage_frequency: 'weekly',
  typical_goals: ['post a job'],
  mobile_share: 0,
  patience: [2, 4],
  tech_skill: [2, 4],
  account_state: 'empty',
  entry: 'direct',
  goal_override: null,
});

const audienceOf = (segments: Segment[]): Audience => ({
  seed: 99,
  persona_count: 6,
  segments,
  company_size: [50, 500],
  languages: { en: 1 },
  accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 },
});

const person = (id: string, segment_id: string | null, name: string): Persona => ({ ...BUILTIN_PERSONA, id, segment_id, name });

const POPULATION: Persona[] = [
  person('p-1-01', 'seg-a', 'Ana Ruiz'),
  person('p-1-02', 'seg-a', 'Ben Okoro'),
  person('p-1-03', 'seg-a', 'Cleo Park'),
  person('p-1-04', 'seg-a', 'Dev Shah'),
  person('p-2-01', 'seg-b', 'Eli Marsh'),
  person('p-2-02', 'seg-b', 'Fay Lindqvist'),
];

const populationConfig = (segments: Segment[], settings: RunSettings = DEFAULT_SETTINGS): RunConfig => ({
  ...config,
  personas: POPULATION,
  project: { ...project, audience: audienceOf(segments), settings },
});

// Outcomes, per persona: a done, b abandoned, c repeated failure, d budget, e done, f blocked and never resumed.
function populationScript(cfg: RunConfig): Script {
  return [
    [1000, { ...runEnv, type: 'run.started', payload: { config: cfg } }],
    ...POPULATION.map((p, i): [number, NewEvent] => [1010 + i, { ...who(p.id), type: 'persona.created', payload: { persona: p } }]),
    [1100, { ...who('p-1-01'), type: 'persona.step', payload: stepPayload(1, 'Ana looks for the job form.', 'runs/r-0001/shots/p-1-01-0001.jpg') }],
    [1105, { ...who('p-1-01'), type: 'llm.call', payload: llmCall(0.25, 1000, 200) }],
    [1110, { ...who('p-1-01'), type: 'persona.friction_reported', payload: friction(1, 'Save is ambiguous.') }],
    [1120, { ...who('p-1-01'), type: 'persona.step', payload: stepPayload(2, 'Ana fills the form.', 'runs/r-0001/shots/p-1-01-0002.jpg') }],
    [1130, { ...who('p-1-01'), type: 'persona.friction_reported', payload: friction(2, 'No error text.') }],
    [1140, { ...who('p-1-01'), type: 'persona.goal_done', payload: { step_no: 2, summary: 'Posted the job.' } }],

    [1200, { ...who('p-1-02'), type: 'persona.step', payload: stepPayload(1, 'Ben cannot find the form.', null) }],
    [1210, { ...who('p-1-02'), type: 'persona.friction_reported', payload: friction(1, 'The form is hidden.') }],
    [1220, { ...who('p-1-02'), type: 'persona.abandoned', payload: { step_no: 1, reason: 'Could not find the job form.' } }],

    [1300, { ...who('p-1-03'), type: 'persona.step', payload: stepPayload(1, 'Cleo clicks the same button again.', null) }],
    [1310, { ...who('p-1-03'), type: 'persona.friction_reported', payload: friction(1, 'The button does nothing.') }],
    [1320, { ...who('p-1-03'), type: 'signal.repeated_failure', payload: { step_no: 1, action: 'click', error: 'ref_not_found' } }],

    [1400, { ...who('p-1-04'), type: 'persona.step', payload: stepPayload(1, 'Dev waits for the page.', null) }],
    [1410, { ...who('p-1-04'), type: 'signal.budget_exceeded', payload: { step_no: 1, budget: 1 } }],

    [1500, { ...who('p-2-01'), type: 'persona.step', payload: stepPayload(1, 'Eli opens the posting page.', null) }],
    [1510, { ...who('p-2-01'), type: 'persona.goal_done', payload: { step_no: 1, summary: 'Reviewed the posting.' } }],

    [1600, { ...who('p-2-02'), type: 'persona.step', payload: stepPayload(1, 'Fay is asked to sign in.', 'runs/r-0001/shots/p-2-02-0001.jpg') }],
    [1605, { ...who('p-2-02'), type: 'llm.call', payload: llmCall(0.5, 500, 100) }],
    [1610, { ...who('p-2-02'), type: 'persona.friction_reported', payload: friction(1, 'The sign-in page is confusing.') }],
    [1620, { ...who('p-2-02'), type: 'persona.blocked', payload: { step_no: 1, reason: 'captcha', detail: 'reCAPTCHA on the sign-in page' } }],

    [9000, { ...runEnv, type: 'run.finished', payload: {} }],
  ];
}

const recruiters = segment('seg-a', 'Recruiters', 60, 'recruiter');
const managers = segment('seg-b', 'Hiring managers', 40, null);

test('a population folds into per-persona outcomes and per-segment rates', () => {
  const report = buildReport(stored(populationScript(populationConfig([recruiters, managers]))));
  assert.deepEqual(
    report.personas.map(({ id, outcome, outcome_text, steps, frictions }) => ({ id, outcome, outcome_text, steps, frictions })),
    [
      { id: 'p-1-01', outcome: 'done', outcome_text: 'Posted the job.', steps: 2, frictions: 2 },
      { id: 'p-1-02', outcome: 'abandoned', outcome_text: 'Could not find the job form.', steps: 1, frictions: 1 },
      { id: 'p-1-03', outcome: 'repeated_failure', outcome_text: 'The same click failed three times in a row (ref_not_found)', steps: 1, frictions: 1 },
      { id: 'p-1-04', outcome: 'budget_exceeded', outcome_text: null, steps: 1, frictions: 0 },
      { id: 'p-2-01', outcome: 'done', outcome_text: 'Reviewed the posting.', steps: 1, frictions: 0 },
      { id: 'p-2-02', outcome: 'blocked', outcome_text: 'reCAPTCHA on the sign-in page', steps: 1, frictions: 1 },
    ],
  );
  assert.deepEqual(report.segments, [
    {
      id: 'seg-a',
      name: 'Recruiters',
      share: 60,
      personas: 4,
      outcomes: { done: 1, abandoned: 1, budget_exceeded: 1, repeated_failure: 1, model_failed: 0, blocked: 0, incomplete: 0, not_started: 0 },
      completion: 0.25,
      with_friction: 0.75,
      frictions: 4,
    },
    {
      id: 'seg-b',
      name: 'Hiring managers',
      share: 40,
      personas: 2,
      outcomes: { done: 1, abandoned: 0, budget_exceeded: 0, repeated_failure: 0, model_failed: 0, blocked: 1, incomplete: 0, not_started: 0 },
      completion: 0.5,
      with_friction: 0.5,
      frictions: 1,
    },
  ]);
  assert.deepEqual(report.weighted, { completion: 0.35, with_friction: 0.65 });
  assert.equal(report.steps, 7);
  assert.equal(report.frictions.length, 5);
  assert.equal(report.cost_usd, 0.75);
});

test('changing the shares changes the weighted rates and leaves the segment rates alone', () => {
  const admins = segment('seg-c', 'Admins', 20, 'admin'); // no personas in this run, so it is left out
  const before = buildReport(
    stored(populationScript(populationConfig([{ ...recruiters, share: 60 }, { ...managers, share: 20 }, admins]))),
  );
  const after = buildReport(
    stored(populationScript(populationConfig([{ ...recruiters, share: 20 }, { ...managers, share: 60 }, admins]))),
  );
  assert.deepEqual(before.weighted, { completion: 0.3125, with_friction: 0.6875 });
  assert.deepEqual(after.weighted, { completion: 0.4375, with_friction: 0.5625 });
  const rates = (report: typeof before) => report.segments.map((s) => [s.id, s.completion, s.with_friction]);
  assert.deepEqual(rates(after), rates(before));
  assert.deepEqual(
    before.segments.map((s) => s.id),
    ['seg-a', 'seg-b'],
  );
});

test('a segment nobody in it started has no rates, not 0%; with nobody started at all, neither has the weighted row', () => {
  const script = populationScript(populationConfig([recruiters, managers]));
  const unstarted = (prefix: string) => script.filter(([, e]) => e.type === 'persona.created' || !e.persona_id?.startsWith(prefix));
  const report = buildReport(stored(unstarted('p-2-')));
  assert.deepEqual(report.segments.map((s) => [s.id, s.outcomes.not_started, s.completion, s.with_friction]), [['seg-a', 0, 0.25, 0.75], ['seg-b', 2, null, null]]);
  assert.deepEqual(report.weighted, { completion: 0.25, with_friction: 0.75 }, 'only the segment that started counts');
  assert.ok(reportToMarkdown(report).includes('| Hiring managers | 40% | 2 | - | - |'));
  const nobody = buildReport(stored(unstarted('p-')));
  assert.deepEqual(nobody.weighted, { completion: null, with_friction: null });
  assert.ok(reportToMarkdown(nobody).includes('**Weighted by share:** completion -, with friction -. **Unweighted:** completion -.'));
});

test('frictions carry the right persona and screenshot when two personas both have a step 1', () => {
  const report = buildReport(stored(populationScript(populationConfig([recruiters, managers]))));
  assert.deepEqual(
    report.frictions.filter((f) => f.step_no === 1).map((f) => [f.persona_id, f.persona_name, f.segment_id, f.quote, f.screenshot]),
    [
      ['p-1-01', 'Ana Ruiz', 'seg-a', 'Ana looks for the job form.', 'runs/r-0001/shots/p-1-01-0001.jpg'],
      ['p-1-02', 'Ben Okoro', 'seg-a', 'Ben cannot find the form.', null],
      ['p-1-03', 'Cleo Park', 'seg-a', 'Cleo clicks the same button again.', null],
      ['p-2-02', 'Fay Lindqvist', 'seg-b', 'Fay is asked to sign in.', 'runs/r-0001/shots/p-2-02-0001.jpg'],
    ],
  );
});

test('the methods list the roles in use, the models called, the budgets and the concurrency changes', () => {
  const settings: RunSettings = {
    ...DEFAULT_SETTINGS,
    concurrency: 8,
    cost_budget_usd: 2.5,
    wall_clock_budget_min: 30,
    routing: { ...DEFAULT_SETTINGS.routing, navigator: { provider: 'openai', model: 'gpt-6-luna' } },
  };
  const script = populationScript(populationConfig([recruiters, managers], settings));
  script.splice(script.length - 1, 0, [8000, { ...runEnv, type: 'run.concurrency_changed', payload: { concurrency: 4, reason: 'rate limited by anthropic' } }]);
  const { methods } = buildReport(stored(script));
  assert.equal(methods.seed, 99); // the audience seed, not the run seed
  assert.deepEqual(methods.roles, ['recruiter']); // the hiring managers segment has no role
  assert.deepEqual(methods.models, { navigator: { provider: 'openai', model: 'gpt-6-luna' } }); // only navigator calls
  assert.deepEqual(methods.budgets, { cost_usd: 2.5, wall_clock_min: 30, concurrency: 8 });
  assert.deepEqual(methods.concurrency_changes, [{ concurrency: 4, reason: 'rate limited by anthropic' }]);
});

test('a population run reopened from the store folds to the same report', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gnomi-report-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openProject(dir);
  const { run_id: _run_id, ...snapshot } = populationConfig([recruiters, managers]);
  const run = store.createRun(snapshot);
  const live = populationScript(populationConfig([recruiters, managers])).map(([, event]) => store.append(event));
  // The judge's and author's answers are events too, so the reopened log rebuilds them.
  const poi = { ...runEnv, persona_id: null, poi_id: 'poi-gym' } as const;
  live.push(store.append({ ...poi, type: 'report.themes', payload: { poi_id: 'poi-gym', themes: [{ title: 'The job form', description: 'Every friction on it.', group_ids: ['g1', 'g2'] }] } }));
  live.push(store.append({ ...poi, type: 'report.suggestions', payload: { poi_id: 'poi-gym', suggestions: [{ theme_id: 'g1+g2', change: 'Simplify the form.', solution: 'Fewer fields.' }] } }));
  const original = buildReport(live);
  assert.equal(original.frictions.length, 5);
  assert.deepEqual(original.themes?.[0].suggestion, { change: 'Simplify the form.', solution: 'Fewer fields.' });
  store.close();

  const reopened = openProject(dir);
  assert.deepEqual(reopened.events(run.run_id), live);
  assert.deepEqual(buildReport(reopened.events(run.run_id)), original);
  reopened.close();
});

// --- A run logged before M2: one `persona`, a top-level budget, no audience or settings ---

// A persona as M1 logged it: no segment, pronouns or background.
const { segment_id: _segment, pronouns: _pronouns, background: _background, ...oldFields } = BUILTIN_PERSONA;
const oldPersona = oldFields as unknown as Persona;

const oldConfig = {
  run_id: 'r-0001',
  seed: 1234,
  project: {
    name: 'Gym',
    description: 'A demo ATS.',
    pois: [{ id: 'poi-gym', type: 'web', name: 'Gym', start_url: startUrl, allowed_hosts: [], production_domains: [], reset_hook_url: null, mode: 'full', segments: null }],
    goal: 'Post a job for a backend engineer',
    role: 'recruiter',
  },
  persona: oldPersona,
  model: { provider: 'anthropic', navigator: 'claude-haiku-5-5' },
  step_budget: 40,
  cost_budget_usd: 1,
  screenshots: true,
  session: { role: 'recruiter', start_url: url, hosts: ['localhost'], recorded_at: 1, verified_at: null, expires_at: null },
  reset: false,
  pause_timeout_ms: 300000,
  app_version: '0.0.0',
} as unknown as RunConfig;

function oldRun(withPersonaCreated: boolean): Script {
  return [
    [1000, { ...runEnv, type: 'run.started', payload: { config: oldConfig } }],
    ...(withPersonaCreated ? [[1010, { ...env, type: 'persona.created', payload: { persona: oldPersona } }] as [number, NewEvent]] : []),
    [1100, { ...env, type: 'persona.step', payload: stepPayload(1, 'Priya opens the form.', null) }],
    [1150, { ...env, type: 'llm.call', payload: llmCall(0.25, 1200, 300) }],
    [1200, { ...env, type: 'persona.goal_done', payload: { step_no: 1, summary: 'Posted the job.' } }],
    [1300, { ...runEnv, type: 'run.finished', payload: {} }],
  ];
}

const expectedOldReport = {
  personas: [
    {
      id: 'p-001',
      name: 'Priya Natarajan',
      job_title: 'Recruiter',
      segment_id: null,
      device: 'desktop',
      outcome: 'done',
      outcome_text: 'Posted the job.',
      steps: 1,
      frictions: 0,
    },
  ],
  segments: [
    {
      id: null,
      name: 'Built-in persona',
      share: 100,
      personas: 1,
      outcomes: { done: 1, abandoned: 0, budget_exceeded: 0, repeated_failure: 0, model_failed: 0, blocked: 0, incomplete: 0, not_started: 0 },
      completion: 1,
      with_friction: 0,
      frictions: 0,
    },
  ],
  weighted: { completion: 1, with_friction: 0 },
};

test('a run logged before M2 still folds: one persona, the built-in segment and the old budget', () => {
  const report = buildReport(stored(oldRun(false)));
  assert.deepEqual(report.personas, expectedOldReport.personas);
  assert.deepEqual(report.segments, expectedOldReport.segments);
  assert.deepEqual(report.weighted, expectedOldReport.weighted);
  assert.equal(report.methods.seed, 1234);
  assert.deepEqual(report.methods.roles, ['recruiter']);
  assert.deepEqual(report.methods.models, { navigator: { provider: 'anthropic', model: 'claude-haiku-5-5' } });
  assert.deepEqual(report.methods.budgets, { cost_usd: 1, wall_clock_min: 60, concurrency: 1 });
});

test('a pre-M2 run whose persona was logged as persona.created folds the same way', () => {
  const report = buildReport(stored(oldRun(true)));
  assert.deepEqual(report.personas, expectedOldReport.personas);
  assert.deepEqual(report.segments, expectedOldReport.segments);
});

test('a persona is done only when every POI it was given ended done, else its worst; never-started personas stay out of the rates', () => {
  const pricing = { id: 'pricing', type: 'text' as const, name: 'Pricing', asset: 'a1', segments: null };
  const twoPois: RunConfig = { ...config, personas: [person('p-a', null, 'Ana'), person('p-b', null, 'Ben'), person('p-c', null, 'Cleo')], project: { ...project, pois: [...project.pois, pricing] } };
  const on = (persona_id: string, poi_id: string) => ({ run_id: 'r-0001', round: 1, persona_id, poi_id }) as const;
  const report = buildReport(stored([
    [1000, { ...runEnv, type: 'run.started', payload: { config: twoPois } }],
    ...twoPois.personas.map((p, i): [number, NewEvent] => [1001 + i, { ...on(p.id, 'poi-gym'), type: 'persona.created', payload: { persona: p } }]),
    // Ana is done on the pricing text but gives up on the web app; Ben is done on both; Cleo never starts.
    [1100, { ...on('p-a', 'pricing'), type: 'persona.step', payload: stepPayload(1, 'Reading.', null) }],
    [1110, { ...on('p-a', 'pricing'), type: 'persona.goal_done', payload: { step_no: 1, summary: 'Read it.' } }],
    [1120, { ...on('p-a', 'poi-gym'), type: 'persona.step', payload: stepPayload(1, 'Looking.', null) }],
    [1130, { ...on('p-a', 'poi-gym'), type: 'persona.abandoned', payload: { step_no: 1, reason: 'No form.' } }],
    [1200, { ...on('p-b', 'poi-gym'), type: 'persona.step', payload: stepPayload(1, 'Posting.', null) }],
    [1210, { ...on('p-b', 'poi-gym'), type: 'persona.goal_done', payload: { step_no: 1, summary: 'Posted.' } }],
    [1220, { ...on('p-b', 'pricing'), type: 'persona.step', payload: stepPayload(1, 'Reading.', null) }],
    [1230, { ...on('p-b', 'pricing'), type: 'persona.goal_done', payload: { step_no: 1, summary: 'Read it.' } }],
    [9000, { ...runEnv, type: 'run.stopped', payload: { reason: 'wall_clock', detail: null } }],
  ]));
  assert.deepEqual(report.personas.map((p) => [p.id, p.outcome, p.outcome_text, p.pois]), [
    ['p-a', 'abandoned', 'No form.', { 'poi-gym': 'abandoned', pricing: 'done' }],
    ['p-b', 'done', 'Posted.', { 'poi-gym': 'done', pricing: 'done' }],
    ['p-c', 'not_started', null, { 'poi-gym': 'not_started', pricing: 'not_started' }],
  ]);
  const [segment] = report.segments;
  assert.deepEqual([segment.personas, segment.outcomes.not_started, segment.completion, segment.with_friction], [3, 1, 0.5, 0.5], 'Cleo is out of both rates; Ana gave up, a friction');
  assert.deepEqual(segment.pois, [{ poi_id: 'poi-gym', personas: 2, completion: 0.5 }, { poi_id: 'pricing', personas: 2, completion: 1 }]);
  const md = reportToMarkdown(report);
  assert.ok(md.includes('| Built-in persona | 100% | 3 | 50% | 50% | 50% of 2 | 100% of 2 |'), 'completion per POI');
  assert.ok(md.includes('1 persona did not start before the run ended and is left out of these rates.'));
  assert.ok(md.includes('**Unweighted:** completion 50%.'));
  assert.ok(report.methods.limitations?.includes('Gym: The author model wrote no suggested changes (no key, a model failure, or the run stopped first).'), 'with several POIs each note names its POI');
});

test('personas the model never answered are counted apart and left out of the completion and friction rates', () => {
  const three: RunConfig = { ...config, personas: [person('p-a', null, 'Ana'), person('p-b', null, 'Ben'), person('p-c', null, 'Cleo')] };
  const on = (persona_id: string) => ({ run_id: 'r-0001', round: 1, persona_id, poi_id: 'poi-gym' }) as const;
  const report = buildReport(stored([
    [1000, { ...runEnv, type: 'run.started', payload: { config: three } }],
    ...three.personas.map((p, i): [number, NewEvent] => [1001 + i, { ...on(p.id), type: 'persona.created', payload: { persona: p } }]),
    [1100, { ...on('p-a'), type: 'persona.step', payload: stepPayload(1, 'Posting.', null) }],
    [1110, { ...on('p-a'), type: 'persona.goal_done', payload: { step_no: 1, summary: 'Posted.' } }],
    [1200, { ...on('p-b'), type: 'persona.step', payload: stepPayload(1, '', null) }],
    [1210, { ...on('p-b'), type: 'signal.repeated_failure', payload: { step_no: 3, action: 'click', error: 'invalid_output' } }],
    [1300, { ...on('p-c'), type: 'persona.step', payload: stepPayload(1, 'Looking.', null) }],
    [1310, { ...on('p-c'), type: 'persona.abandoned', payload: { step_no: 1, reason: 'No form.' } }],
    [9000, { ...runEnv, type: 'run.finished', payload: {} }],
  ]));
  assert.deepEqual(report.personas.map((p) => p.outcome), ['done', 'model_failed', 'abandoned']);
  const [segment] = report.segments;
  assert.deepEqual([segment.personas, segment.outcomes.model_failed, segment.completion], [3, 1, 0.5], 'Ben is out of the denominator, not a failure');
  assert.equal(report.weighted.completion, 0.5);
});

test('a theme\'s evidence carries the box of what it is about and Markdown names the element, while a log from before viewports has neither', () => {
  const about: ActionTarget = { role: 'button', name: 'Save', box: [128, 80, 128, 80] };
  const shot = stepPayload(1, 'Trying.', 'runs/r-0001/shots/p-001-0001.jpg');
  const log = (step: EventPayloads['persona.step']) => stored([startedAt, [1100, { ...env, type: 'persona.step', payload: step }], [1200, { ...env, type: 'persona.friction_reported', payload: { ...friction(1, 'Save is hidden'), about } }]]);
  const report = buildReport(log({ ...shot, viewport: [0, 0, 1280, 800] }));
  assert.deepEqual(report.themes?.[0].evidence[0].box, { left: 10, top: 10, width: 10, height: 10, element: 'button "Save"' });
  const md = reportToMarkdown(report);
  assert.ok(md.includes('   - About: button "Save"'));
  assert.ok(!md.includes('Marked'), 'the file named in the Markdown has no mark on it; only the HTML overlay draws one');
  const old = buildReport(log(shot));
  assert.ok(!('box' in old.themes![0].evidence[0]));
  assert.equal(old.themes?.[0].evidence[0].screenshot, shot.screenshot, 'the plain screenshot stays');
  assert.ok(!reportToMarkdown(old).includes('   - About: '));
});
