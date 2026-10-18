import { InvalidOutputError } from '../llm/gateway.ts';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { balancedTargetOrder, terminalOutcome } from './runtime.ts';

test('target positions are balanced within each segment and stable under population reordering', () => {
  const people = Array.from({ length: 12 }, (_, i) => ({ id: `person-${i}`, segment_id: i < 6 ? 'buyer' : 'reviewer' }));
  const targets = ['owned', 'peer-a', 'peer-b'];
  const orders = balancedTargetOrder(people, targets, 17);
  assert.deepEqual(orders, balancedTargetOrder([...people].reverse(), targets, 17));
  for (const segment of ['buyer', 'reviewer']) for (let position = 0; position < 3; position++) {
    const counts = targets.map((target) => people.filter((p) => p.segment_id === segment && orders.get(p.id)?.[position] === target).length);
    assert.deepEqual(counts, [2, 2, 2]);
  }
});

test('effort exhaustion stays a valid failure while global interruption and unsupported done do not become successes', () => {
  assert.equal(terminalOutcome('budget_exceeded'), 'task_failed');
  assert.equal(terminalOutcome('repeated_failure'), 'task_failed');
  assert.equal(terminalOutcome('abandoned'), 'abandoned');
  assert.equal(terminalOutcome('stopped'), 'incomplete');
  assert.equal(terminalOutcome('blocked'), 'blocked_environment');
  assert.equal(terminalOutcome('done'), 'incomplete');
});

import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { draftComparison } from './config.ts';
import { citationRejection, comparisonSession, createComparisonRuntime } from './runtime.ts';
import type { GnomiEvent, NewEvent, PageSnapshot, ProjectConfig, RunConfig } from '../types.ts';
import type { ComparisonStudy } from './types.ts';
import type { LlmGateway, LlmRequest, PageDriver } from '../seams.ts';

function fixture(options: { sourceText?: string; reject?: boolean; invalid?: boolean; exhausted?: boolean; blocked?: boolean; interrupted?: boolean; fixtureMissing?: boolean; judgeFailure?: boolean; invalidNavigator?: boolean } = {}) {
  const project: ProjectConfig = { name: 'Compare ATS tools', description: '', goal: 'Choose an ATS', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: ['Alpha', 'Beta'].map((name) => ({ id: name, name, type: 'web', start_url: `https://${name.toLowerCase()}.example/`, mode: 'observe_only', segments: null, allowed_hosts: [], production_domains: [], not_production: false, reset_hook_url: null })) };
  const study = draftComparison(project);
  study.tasks[0].prerequisites = [];
  study.tasks[0].max_steps = 2;
  study.criteria = [study.criteria[1]];
  study.tasks[0].criterion_ids = ['cost'];
  project.comparison = study;
  const person = { ...BUILTIN_PERSONA, id: 'buyer', goal_interpretation: 'Review the candidate in the incoming invitation.', context_of_use: 'Inbox invitation' };
  const config: RunConfig = { run_id: 'r-comparison', seed: 20, project, personas: [person], sessions: [], reset: false, pause_timeout_ms: 1, app_version: 'test' };
  const events: GnomiEvent[] = [];
  const requests: LlmRequest<unknown>[] = [];
  const record = (event: NewEvent) => { const saved = { ...event, seq: events.length + 1, ts: events.length + 1 } as GnomiEvent; events.push(saved); return saved; };
  const llm: LlmGateway = { async call(req) {
    requests.push(req);
    if (req.role === 'navigator' && options.invalidNavigator) throw new InvalidOutputError('Invalid output after retry');
    let output;
    if (req.purpose === 'comparison_assessment') {
      if (options.judgeFailure) throw new Error('Assessor is unavailable');
      const input = JSON.parse(req.user.find((p) => p.type === 'text')!.text);
      const source = input.sources.find((s: { kind: string }) => s.kind === 'page');
      const cite = { event_seq: source.event_seq, source: source.source, quote: source.text };
      output = { outcome: options.invalid ? 'invalid_task' : options.blocked ? 'blocked_environment' : options.exhausted ? 'task_failed' : 'completed', reason: options.invalid ? 'The persona invented a candidate-review assignment.' : options.blocked ? 'The required pricing API was denied by containment.' : 'Found the pricing basis for the shared scenario.', outcome_evidence: [cite],
        criteria: [{ criterion_id: 'cost', assessment: 'meets', basis: 'vendor_claim', summary: 'The team plan is USD 100 monthly for 20 seats.', evidence: [cite] }] };
    } else if (req.purpose === 'comparison_verification') {
      output = { outcome_supported: !options.reject, outcome_reason: options.reject ? 'The source is unrelated to pricing.' : 'The frozen success rule is supported.', criteria: [{ criterion_id: 'cost', supported: !options.reject, reason: options.reject ? 'Candidate profile is not pricing evidence.' : 'The quoted plan terms support the criterion.' }] };
    } else output = { thought: options.invalid ? 'I need the candidate invitation instead.' : 'The pricing terms are visible.', feeling: 1, action: { type: options.exhausted || options.interrupted || options.blocked ? 'read' : 'done', ref: null, text: options.invalid ? 'The invitation is missing.' : 'Found the applicable plan terms.' }, friction: null };
    return { object: req.schema.parse(output), cost_usd: 0 };
  } };
  const navigations: string[] = [];
  const modes: string[] = [];
  const pages: PageDriver[] = [];
  let admitted = 0;
  let ended = 0;
  const runtime = createComparisonRuntime({ config, llm, record, events: () => events,
    blobs: { put: async () => {}, get: async () => new Uint8Array() }, signal: new AbortController().signal,
    beginUsageStep: () => { admitted++; return !options.interrupted || admitted === 1; }, beginAnalysisStep: () => true, endStep: () => { ended++; },
    stopped: () => false, stopReason: () => 'Global budget interruption.', tripwire: () => () => {},
    openPage: async (_persona, _target, poi) => {
      modes.push(poi.mode);
      let current = poi.start_url;
      const snapshot = (): PageSnapshot => ({ url: current, title: poi.name, text: options.sourceText ?? 'Team plan: USD 100 monthly for up to 20 seats.', hash: 'pricing' });
      const page: PageDriver = { goto: async (url) => { current = url; navigations.push(url); }, snapshot: async () => snapshot(), screenshot: async () => new Uint8Array(),
        act: async () => ({ ok: !options.blocked, error: options.blocked ? 'host_not_allowed' : null, url_before: current, url_after: current, dom_changed: false, target: null, text: null }),
        inspect: async () => ({ login: false, challenge: null, live_key: null }), errors: () => [], close: async () => {} };
      pages.push(page); return page;
    },
  });
  return { runtime, config, study, person, events, requests, navigations, pages, modes, ended: () => ended };
}

test('independent episodes collect positive pricing sources and verified task results for every public target', async () => {
  const f = fixture();
  await f.runtime.runPersona(f.person);
  const finished = f.events.filter((e) => e.type === 'comparison.episode_finished');
  assert.deepEqual(finished.map((e) => e.payload.outcome), ['completed', 'completed']);
  assert.equal(f.pages.length, 2, 'each target gets a fresh browser context');
  assert.equal(f.events.filter((e) => e.type === 'comparison.source').length, 2, 'positive page evidence does not require friction');
  assert.equal(f.events.filter((e) => e.type === 'persona.survey' || e.type.startsWith('social.')).length, 0);
  for (const req of f.requests.filter((r) => r.role === 'navigator')) {
    assert.doesNotMatch(req.system, /incoming invitation|Inbox invitation|a competitor of/);
    assert.match(req.system, /only assignment/);
    assert.doesNotMatch(JSON.stringify(req.user), /prior observations|previous target/i);
  }
});

test('semantic review rejects a real candidate-profile quotation offered as pricing evidence', async () => {
  const f = fixture({ sourceText: 'Candidate: Alice; interviewed Monday.', reject: true });
  await f.runtime.runPersona(f.person);
  const assessments = f.events.filter((e) => e.type === 'comparison.assessment');
  assert.equal(assessments.length, 2);
  assert.ok(assessments.every((e) => /Candidate profile/.test(e.payload.rejection ?? '')));
  assert.ok(f.events.filter((e) => e.type === 'comparison.episode_finished').every((e) => e.payload.outcome === 'incomplete'));
});

test('planned task exhaustion without evidence of success remains a valid task failure', async () => {
  const f = fixture({ exhausted: true });
  await f.runtime.runPersona(f.person);
  assert.deepEqual(f.events.filter((e) => e.type === 'comparison.episode_finished').map((e) => e.payload.outcome), ['task_failed', 'task_failed']);
});

test('global interruption remains incomplete even when partial page evidence exists', async () => {
  const f = fixture({ interrupted: true });
  await f.runtime.runPersona(f.person);
  assert.ok(f.events.some((e) => e.type === 'comparison.source'));
  assert.ok(f.events.filter((e) => e.type === 'comparison.episode_finished').every((e) => e.payload.outcome === 'incomplete'));
});

test('invalid assignments and blocked task dependencies are separate from product failure', async () => {
  for (const [option, expected] of [['invalid', 'invalid_task'], ['blocked', 'blocked_environment']] as const) {
    const f = fixture({ [option]: true });
    await f.runtime.runPersona(f.person);
    assert.ok(f.events.filter((e) => e.type === 'comparison.episode_finished').every((e) => e.payload.outcome === expected));
  }
});

test('failed assessment calls retain source evidence and explicit unknown judgments', async () => {
  const f = fixture({ judgeFailure: true });
  await f.runtime.runPersona(f.person);
  assert.equal(f.events.filter((e) => e.type === 'comparison.source').length, 2);
  assert.equal(f.events.filter((e) => e.type === 'comparison.assessment' && e.payload.assessment === 'unknown').length, 2);
  assert.ok(f.events.filter((e) => e.type === 'comparison.episode_finished').every((e) => e.payload.outcome === 'incomplete'));
});

test('authenticated sessions require exact target binding even when roles and domains look valid', () => {
  const f = fixture();
  const target = { ...f.study.targets[0], access_scope: 'authenticated_workflow' as const, session_role: 'recruiter-alpha' };
  const session = { role: 'recruiter-alpha', target_id: 'another-vendor', start_url: 'https://alpha.example/dashboard', hosts: ['alpha.example'], recorded_at: 1, verified_at: 1, expires_at: null };
  f.config.sessions = [session];
  assert.match(comparisonSession(f.config, target).reason ?? '', /bound/);
  session.target_id = target.id;
  assert.equal(comparisonSession(f.config, target).reason, null);
});

test('missing credentials block only the affected target and preserve the matched peer episode', async () => {
  const f = fixture();
  f.study.targets[0].access_scope = 'authenticated_workflow';
  f.study.targets[0].session_role = 'target-alpha-recruiter';
  await f.runtime.runPersona(f.person);
  const finished = f.events.filter((e) => e.type === 'comparison.episode_finished');
  assert.equal(finished.find((e) => e.payload.target_id === f.study.targets[0].id)?.payload.outcome, 'blocked_environment');
  assert.equal(finished.find((e) => e.payload.target_id === f.study.targets[1].id)?.payload.outcome, 'completed');
  assert.equal(f.pages.length, 1);
});

test('citation validation rejects cross-episode ids and opinions posing as observed behavior', async () => {
  const f = fixture();
  await f.runtime.runPersona(f.person);
  const source = f.events.find((e) => e.type === 'comparison.source')!;
  assert.ok(source.type === 'comparison.source');
  const cite = { event_seq: source.seq, source: source.payload.source, quote: source.payload.text };
  assert.match(citationRejection([cite], [], 'vendor_claim') ?? '', /captured source/);
  assert.match(citationRejection([cite], [source], 'observed_behavior') ?? '', /action/);
  assert.equal(citationRejection([cite], [source], 'vendor_claim'), null);
});

test('each target receives only its own fixture and no inherited candidate assignment', async () => {
  const f = fixture();
  f.study.tasks[0].requires_fixture = true;
  f.study.tasks[0].entries[0].fixture = 'Use candidate ALPHA-123 in the alpha test workspace.';
  f.study.tasks[0].entries[1].fixture = 'Use candidate BETA-456 in the beta test workspace.';
  await f.runtime.runPersona(f.person);
  for (const request of f.requests.filter((r) => r.role === 'navigator')) {
    const current = request.system.includes('evaluating Alpha') ? 'ALPHA-123' : 'BETA-456';
    const other = current === 'ALPHA-123' ? 'BETA-456' : 'ALPHA-123';
    assert.ok(request.system.includes(current));
    assert.ok(!request.system.includes(other));
  }
  for (const request of f.requests.filter((r) => r.purpose === 'comparison_assessment')) {
    const packet = JSON.parse(request.user.find((p) => p.type === 'text')!.text);
    assert.equal(packet.task.entries.length, 1);
    assert.equal(packet.task.entries[0].target_id, packet.target.id);
  }
});

test('a declared fixture prerequisite blocks only its missing assignment', async () => {
  const f = fixture();
  f.study.tasks[0].requires_fixture = true;
  f.study.tasks[0].prerequisites = ['A provisioned test candidate'];
  f.study.tasks[0].entries[0].fixture = 'Candidate ALPHA-123';
  await f.runtime.runPersona(f.person);
  const outcomes = f.events.filter((e) => e.type === 'comparison.episode_finished');
  assert.equal(outcomes.find((e) => e.payload.target_id === f.study.targets[0].id)?.payload.outcome, 'completed');
  assert.equal(outcomes.find((e) => e.payload.target_id === f.study.targets[1].id)?.payload.outcome, 'blocked_environment');
});

test('buyer journey carries only explicitly accepted prior observations; independent tasks do not', async () => {
  const f = fixture();
  f.study.execution.mode = 'buyer_journey';
  f.study.execution.carryover = 'prior_observations';
  await f.runtime.runPersona(f.person);
  const navigation = f.requests.filter((r) => r.role === 'navigator');
  assert.doesNotMatch(navigation[0].system, /prior observations explicitly carried/);
  assert.match(navigation[1].system, /prior observations explicitly carried/);
  assert.match(navigation[1].system, /USD 100 monthly/);
});

import { comparisonPacket } from './runtime.ts';

test('semantic packets bound long captures and disclose omitted coverage while retaining the trace endpoints', async () => {
  const f = fixture();
  await f.runtime.runPersona(f.person);
  const original = f.events.find((e) => e.type === 'comparison.source')!;
  assert.ok(original.type === 'comparison.source');
  const sources = Array.from({ length: 100 }, (_, i) => ({ ...original, seq: i + 1, payload: { ...original.payload, source_id: `source-${i}`, text: `Observation ${i}: ${'x'.repeat(32_000)}` } }));
  const packet = comparisonPacket(sources, f.events);
  assert.ok(JSON.stringify(packet).length < 100_000);
  assert.equal(packet.sources[0].seq, 1);
  assert.equal(packet.sources.at(-1)?.seq, 100);
  assert.match(packet.limit ?? '', /76 distinct sources omitted/);
  assert.match(packet.limit ?? '', /24 source captures shortened/);
});


test('public comparison scope narrows a full-mode source to observe-only browsing', async () => {
  const f = fixture();
  for (const poi of f.config.project.pois) if (poi.type === 'web') poi.mode = 'full';
  await f.runtime.runPersona(f.person);
  assert.deepEqual(f.modes, ['observe_only', 'observe_only']);
  assert.ok(f.requests.filter((req) => req.role === 'navigator').every((req) => req.system.includes('never submits a form')));
});

test('a missing prototype frame blocks its target without suppressing a peer result', async () => {
  const f = fixture();
  f.config.project.pois[0] = { id: 'Alpha', name: 'Prototype', type: 'design', segments: null, frames: [{ asset: '1111111111111111.png', name: 'Pricing screen' }] };
  f.study.targets[0].access_scope = 'prototype';
  await f.runtime.runPersona(f.person);
  const results = f.events.filter((e) => e.type === 'comparison.episode_finished');
  assert.equal(results.find((e) => e.payload.target_id === f.study.targets[0].id)?.payload.outcome, 'blocked_environment');
  assert.equal(results.find((e) => e.payload.target_id === f.study.targets[1].id)?.payload.outcome, 'completed');
});

test('observed workflow evidence can combine an actual action and its captured confirmation', async () => {
  const f = fixture({ exhausted: true });
  await f.runtime.runPersona(f.person);
  const sources = f.events.filter((e) => e.type === 'comparison.source');
  const page = sources.find((e) => e.payload.kind === 'page')!;
  const action = sources.find((e) => e.payload.kind === 'action' && e.payload.episode_id === page.payload.episode_id)!;
  const cites = [page, action].map((source) => ({ event_seq: source.seq, source: source.payload.source, quote: source.payload.text }));
  assert.equal(citationRejection(cites, [page, action], 'observed_behavior'), null);
  assert.match(citationRejection(cites.slice(0, 1), [page, action], 'observed_behavior') ?? '', /action/);
});


test('an invalid navigator response is missing model work rather than task-effort failure', async () => {
  const f = fixture({ invalidNavigator: true });
  await f.runtime.runPersona(f.person);
  assert.ok(f.events.filter((event) => event.type === 'comparison.episode_finished').every((event) => event.payload.outcome === 'incomplete' && /valid response/.test(event.payload.reason)));
  assert.equal(f.events.filter((event) => event.type === 'signal.budget_exceeded' || event.type === 'signal.repeated_failure').length, 0);
});


test('a matched block collects every target before paying for either semantic assessment', async () => {
  const f = fixture();
  await f.runtime.runPersona(f.person);
  assert.deepEqual(f.requests.map((request) => request.purpose ?? request.role), ['navigator', 'navigator', 'comparison_assessment', 'comparison_verification', 'comparison_assessment', 'comparison_verification']);
  for (const request of f.requests.filter((item) => item.purpose === 'comparison_assessment')) {
    const packet = JSON.parse(request.user.find((part) => part.type === 'text')!.text);
    assert.ok(packet.sources.every((source: { target_id: string }) => source.target_id === packet.target.id));
    const expectedPoi = packet.target.poi_ids[0];
    assert.ok(packet.trace.every((trace: { detail: string }) => !trace.detail.includes(expectedPoi === 'Alpha' ? 'beta.example' : 'alpha.example')));
  }
});
