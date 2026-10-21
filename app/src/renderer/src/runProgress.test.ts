import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '@gnomi/simulation/persona.ts';
import { DEFAULT_SETTINGS } from '@gnomi/simulation/settings.ts';
import type { EventPayloads, EventType, GnomiEvent, RunConfig, Segment } from '@gnomi/simulation/types.ts';
import { runProgress } from './runProgress.ts';
import { draftComparison } from '@gnomi/simulation/comparison/config.ts';
import { personaStates, waitingBlocks, toRows } from './activity.ts';

function config({ people = 2, places = 1, social = false, rounds = 3 } = {}): RunConfig {
  return {
    run_id: 'r-1', seed: 1, reset: false, sessions: [], pause_timeout_ms: 1000, app_version: 'test',
    personas: Array.from({ length: people }, (_, i) => ({ ...BUILTIN_PERSONA, id: `p-${i + 1}` })),
    project: {
      name: 'Test', description: '', goal: 'Read the product', role: null,
      pois: Array.from({ length: places }, (_, i) => ({ id: `poi-${i + 1}`, name: `Product ${i + 1}`, type: 'text' as const, asset: 'text.md', segments: null })),
      settings: { ...DEFAULT_SETTINGS, social, rounds },
      audience: social ? { seed: 1, persona_count: people, segments: [], company_size: [1, 10], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 } } : null,
    },
  };
}

function event<K extends EventType>(seq: number, type: K, payload: EventPayloads[K], persona_id: string | null = null, poi_id: string | null = null, round = 1): GnomiEvent {
  return { seq, ts: seq, run_id: 'r-1', round, persona_id, poi_id, type, payload } as GnomiEvent;
}

const done = (seq: number, who = 'p-1', where = 'poi-1') => event(seq, 'persona.goal_done', { step_no: 3, summary: 'Understood the product' }, who, where);

test('comparison progress waits for assessed tool/tasks, ignores legacy social settings and never requests a resume', () => {
  const planned = config({ people: 1, places: 2, social: true });
  const study = draftComparison(planned.project);
  study.tasks.push({ ...structuredClone(study.tasks[0]), id: 'task-two' });
  planned.project.comparison = study;
  const scope = { episode_id: 'episode-one', target_id: study.targets[0].id, scenario_id: study.scenarios[0].id, task_id: study.tasks[0].id, segment_id: null, access_scope: study.targets[0].access_scope, replicate_id: study.execution.replicate_id };
  const events = [event(1, 'run.started', { config: planned }), event(2, 'comparison.episode_started', { ...scope, poi_id: 'poi-1', order: 0, target_order: study.targets.map((target) => target.id) }, 'p-1', 'poi-1'), done(3)];
  assert.deepEqual(runProgress(events).sessions, { done: 0, total: 4 });
  assert.equal(runProgress(events).rounds.total, 0);
  assert.equal(personaStates(events, planned.personas).get('p-1'), 'active');
  events.push(event(4, 'persona.blocked', { step_no: 3, reason: 'session_expired', detail: 'Login missing' }, 'p-1'));
  assert.deepEqual(waitingBlocks(events), []);
  events.push(event(5, 'comparison.episode_finished', { ...scope, outcome: 'blocked_environment', reason: 'Login missing', evidence_seqs: [] }, 'p-1', 'poi-1'));
  assert.deepEqual(runProgress(events).sessions, { done: 1, total: 4 });
  assert.equal(personaStates(events, planned.personas).get('p-1'), 'active');
  assert.equal(toRows(events)[0].title, 'blocked environment');
  for (const [index, pair] of study.tasks.flatMap((task) => study.targets.map((target) => ({ task, target }))).entries()) {
    events.push(event(6 + index, 'comparison.episode_finished', { ...scope, episode_id: index ? `episode-${index}` : scope.episode_id, task_id: pair.task.id, target_id: pair.target.id, outcome: 'completed', reason: 'Assessed', evidence_seqs: [] }, 'p-1'));
  }
  assert.deepEqual(runProgress(events).sessions, { done: 4, total: 4 });
  assert.equal(personaStates(events, planned.personas).get('p-1'), 'done');
  assert.ok(runProgress(events).percent < 100);
  events.push(event(10, 'run.finished', {}), event(11, 'report.generated', { path: 'report.json', friction_count: 0 }));
  assert.equal(runProgress(events).percent, 100);
});

test('a known run starts at zero with its real exploration and discussion plan', () => {
  const progress = runProgress([], config({ people: 3, places: 2, social: true }));
  assert.equal(progress.percent, 0);
  assert.equal(progress.phase, 'starting');
  assert.deepEqual(progress.sessions, { done: 0, total: 6 });
  assert.deepEqual(progress.rounds, { done: 0, total: 3, current: 0 });
  assert.deepEqual(progress.stages.map((stage) => [stage.id, stage.state]), [['exploration', 'pending'], ['discussion', 'pending'], ['report', 'pending']]);
  assert.equal(progress.reportReady, false);
});

test('completing one point of interest counts one session, without completing the persona or counting it twice', () => {
  const events = [done(1), done(1), event(2, 'persona.survey', { poi_id: 'poi-1', sentiment: 1, confidence: 0.8, likes: [], frictions: [], would_continue: true, reason: 'Clear' }, 'p-1', 'poi-1')];
  const progress = runProgress(events, config({ people: 2, places: 2 }));
  assert.deepEqual(progress.sessions, { done: 1, total: 4 });
  assert.equal(progress.phase, 'exploring');
  assert.equal(progress.stages.find((stage) => stage.id === 'exploration')?.state, 'active');
  assert.ok(progress.percent > 0 && progress.percent < 100);
});

test('planned sessions respect segment eligibility', () => {
  const planned = config({ people: 2, places: 2, social: true });
  planned.personas[0].segment_id = 'buyer';
  planned.personas[1].segment_id = 'user';
  planned.project.audience!.segments = [{ id: 'buyer', kind: 'buyer' }, { id: 'user', kind: 'user' }] as Segment[];
  planned.project.pois[0].segments = ['user'];
  assert.deepEqual(runProgress([done(1, 'p-2')], planned).sessions, { done: 1, total: 3 });
});

test('finished experiences can keep discussing and do not prematurely start the report', () => {
  const planned = config({ social: true });
  const events = [event(1, 'run.round_started', {}), done(2), done(3, 'p-2'), event(4, 'social.feed_viewed', { post_ids: [] }, 'p-1')];
  const progress = runProgress(events, planned);
  assert.equal(progress.phase, 'discussing');
  assert.equal(progress.stages.find((stage) => stage.id === 'report')?.state, 'pending');
  assert.equal(progress.reportReady, false);
  assert.ok(progress.percent < 100);
});

test('report progress advances on recorded results and reaches 100 only after the report is available', () => {
  const planned = config({ people: 1 });
  const events: GnomiEvent[] = [done(1), event(2, 'report.started', { pois: ['poi-1'] })];
  const percentages = [runProgress(events, planned).percent];
  events.push(event(3, 'report.themes', { poi_id: 'poi-1', themes: [] }));
  percentages.push(runProgress(events, planned).percent);
  events.push(event(4, 'report.suggestions', { poi_id: 'poi-1', suggestions: [] }));
  percentages.push(runProgress(events, planned).percent);
  events.push(event(5, 'run.finished', {}));
  const saving = runProgress(events, planned);
  assert.equal(saving.phase, 'saving');
  assert.equal(saving.complete, false);
  assert.equal(saving.reportReady, false);
  assert.ok(saving.percent < 100);
  percentages.push(saving.percent);
  assert.ok(percentages.every((value, index) => index === 0 || value >= percentages[index - 1]));
  assert.ok(percentages[1] > percentages[0]);
  assert.ok(percentages[2] > percentages[1]);
  events.push(event(6, 'report.generated', { path: 'report.json', friction_count: 0 }));
  assert.equal(runProgress(events, planned).percent, 100);
  assert.equal(runProgress(events, planned).complete, true);
});

test('early discussion completion uses the rounds that ran and does not invent extra completed rounds', () => {
  const planned = config({ social: true, rounds: 5 });
  const events = [done(1), done(2, 'p-2'), event(3, 'run.round_started', {}, null, null, 1), event(4, 'run.round_ended', {}, null, null, 1), event(5, 'report.started', { pois: [] })];
  const progress = runProgress(events, planned);
  assert.deepEqual(progress.rounds, { done: 1, total: 5, current: 1 });
  assert.equal(progress.stages.find((stage) => stage.id === 'discussion')?.state, 'complete');
  assert.match(progress.stages.find((stage) => stage.id === 'discussion')!.detail, /1 round/);
  assert.equal(progress.phase, 'reporting');
  assert.ok(progress.percent < 100);
});

test('stopped runs retain completed work and a partial report never makes the simulation complete', () => {
  const planned = config({ people: 3, social: true });
  const events = [done(1), event(2, 'run.stopped', { reason: 'user', detail: null }), event(3, 'report.generated', { path: 'report.json', friction_count: 0 })];
  const progress = runProgress(events, planned, 'stopped', true);
  assert.equal(progress.phase, 'stopped');
  assert.equal(progress.ended, true);
  assert.equal(progress.complete, false);
  assert.equal(progress.reportReady, true);
  assert.deepEqual(progress.sessions, { done: 1, total: 3 });
  assert.ok(progress.percent < 100);
  assert.equal(progress.stages.find((stage) => stage.id === 'exploration')?.state, 'stopped');
});

test('interrupted rows end stale active events without pretending that unfinished work completed', () => {
  const planned = config();
  const events = [event(1, 'persona.episode_started', { poi_id: 'poi-1', device: 'desktop', start_url: 'asset:text.md' }, 'p-1', 'poi-1')];
  const progress = runProgress(events, planned, 'interrupted', true);
  assert.equal(progress.phase, 'interrupted');
  assert.equal(progress.ended, true);
  assert.equal(progress.complete, false);
  assert.deepEqual(progress.sessions, { done: 0, total: 2 });
  assert.ok(progress.percent < 100);
});

test('a successfully finished historical run with a loaded report is complete before report.generated is replayed', () => {
  const progress = runProgress([], config(), 'finished', true);
  assert.equal(progress.percent, 100);
  assert.equal(progress.phase, 'complete');
  assert.equal(progress.reportReady, true);
});

test('a generated report without a terminal run never unlocks the report', () => {
  const progress = runProgress([event(1, 'report.generated', { path: 'report.json', friction_count: 0 })], config(), 'running', true);
  assert.equal(progress.reportReady, false);
  assert.equal(progress.complete, false);
  assert.ok(progress.percent < 100);
});

test('empty and older runs stay finite and social is absent without an audience', () => {
  assert.equal(runProgress([]).percent, 0);
  const planned = config();
  planned.project.settings.social = true;
  assert.equal(runProgress([], planned).rounds.total, 0);
  assert.deepEqual(runProgress([], planned).stages.map((stage) => stage.id), ['exploration', 'report']);
});
