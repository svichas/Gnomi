import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GnomiEvent, Opinion } from '../types.ts';
import { parseOptions } from './checks.ts';
import { complaint, fixture, M4_SEEDS } from './fixture.ts';
import { auditCriterion, auditItems, FRAME_RATE, replayCriterion, replayProblems, sampleInfluenceEdges, spreadCriterion, spreadOf } from './social.ts';

// Hand-built logs: `a` posts the complaint; s1–s5 share its segment, x1–x5 do not.
const SEGMENTS = { a: 'seg-1', s1: 'seg-1', s2: 'seg-1', s3: 'seg-1', s4: 'seg-1', s5: 'seg-1', x1: 'seg-2', x2: 'seg-2', x3: 'seg-3', x4: 'seg-3', x5: 'seg-3' };
let seq = 0;
const ev = (type: string, payload: object, persona_id: string | null = null, round = 1) => ({ run_id: 'r-1', seq: ++seq, ts: 0, round, persona_id, poi_id: null, type, payload }) as GnomiEvent;
const start = () => { seq = 0; return ev('run.started', { config: { personas: Object.entries(SEGMENTS).map(([id, segment_id]) => ({ id, segment_id })) } }); };
const post = (persona: string, post_id: string, parent_id: string | null = null, round = 1, injected = false) =>
  ev('social.post', { post_id, parent_id, text: `${persona} says ${post_id}`, about_poi_id: 'poi-gym', ...(injected ? { injected } : {}) }, persona, round);
const view = (sentiment: number): Opinion => ({ sentiment, confidence: 0.5, likes: [], frictions: [] });
const changed = (persona: string, before: number | null, after: number, post_ids: string[], round = 1) =>
  ev('persona.opinion_changed', { poi_id: 'poi-gym', before: before === null ? null : view(before), after: view(after), cause: { step_ids: [], post_ids } }, persona, round);
const saw = (persona: string, post_ids: string[], round = 1) => ev('social.feed_viewed', { post_ids }, persona, round);

/** A finished one-round run in which `same` same-segment and `cross` other-segment personas saw the complaint. */
function seeded(same: number, cross: number): GnomiEvent[] {
  return [
    start(), ev('run.round_started', {}), post('a', 'c1', null, 1, true),
    ...['s1', 's2', 's3', 's4', 's5'].slice(0, same).map((p) => saw(p, ['c1'])),
    ...['x1', 'x2', 'x3', 'x4', 'x5'].slice(0, cross).map((p) => saw(p, ['c1'])),
    ev('run.round_ended', {}), ev('run.finished', {}),
  ];
}

test('spread counts personas who saw the complaint thread, replied in it or were influenced by it, by segment', () => {
  const events = [
    start(), ev('run.round_started', {}),
    post('a', 'c1', null, 1, true),
    saw('a', ['c1']), // the author is never counted
    saw('s1', ['c1']),
    post('x1', 'r1', 'c1'), // a reply in the thread
    post('s2', 'r2', 'r1'), // a reply to a reply is still in the thread
    post('x2', 'other'), saw('x3', ['other']), // another thread reaches no one
    changed('s3', 1, -1, ['r1']), // influenced by a reply in the thread
    changed('s4', 1, 1, ['c1']), // cited, but the opinion did not move
    ev('run.round_ended', {}), ev('run.finished', {}),
  ];
  const spread = spreadOf(events)!;
  assert.deepEqual(
    { post_id: spread.post_id, author: spread.author, segment_id: spread.segment_id, same: spread.same, cross: spread.cross, same_population: spread.same_population, cross_population: spread.cross_population },
    { post_id: 'c1', author: 'a', segment_id: 'seg-1', same: 3, cross: 1, same_population: 5, cross_population: 5 },
  );
  assert.deepEqual(spread.reached.map((r) => [r.persona_id, r.saw, r.repeated, r.influenced]), [['s1', true, false, false], ['s2', false, true, false], ['s3', false, false, true], ['x1', false, true, false]]);
  assert.equal(spreadOf(events.filter((e) => e.type !== 'run.finished')), null, 'an unfinished run cannot answer');
  assert.equal(spreadOf(events.filter((e) => !(e.type === 'social.post' && e.payload.injected))), null, 'no injected complaint, nothing to measure');
});

test('spread passes only live, with more same-segment reach in four of five seeds; ties are losses and missing seeds undecided', () => {
  const status = (runs: (GnomiEvent[] | null)[], mode: 'live' | 'scripted' = 'live') => spreadCriterion(mode, runs.map((events) => events && spreadOf(events))).status;
  assert.equal(status([seeded(3, 1), seeded(2, 0), seeded(4, 1), seeded(1, 0), seeded(0, 2)]), 'PASS');
  assert.equal(status([seeded(2, 2), seeded(0, 0), seeded(3, 1), seeded(3, 1), seeded(3, 1)]), 'FAIL', 'two ties leave at most three wins');
  assert.equal(status([seeded(3, 1), seeded(3, 1), seeded(3, 1), seeded(3, 1), null]), 'PASS', 'four wins decide it whatever the fifth seed shows');
  assert.equal(status([seeded(3, 1), seeded(3, 1), seeded(3, 1), null, null]), 'NOT_RUN');
  assert.equal(status([seeded(1, 3), null, null, null, null]), 'NOT_RUN');
  assert.equal(status([seeded(1, 3), seeded(1, 3), null, null, null]), 'FAIL');
  assert.equal(status([seeded(3, 1), seeded(3, 1), seeded(3, 1), seeded(3, 1), seeded(3, 1)], 'scripted'), 'NOT_RUN', 'a rehearsal never passes');
  assert.match(spreadCriterion('live', [spreadOf(seeded(2, 2)), null]).detail, /2\/2, missing/);
});

function edgeLog(count: number): GnomiEvent[] {
  const events = [start(), ev('run.round_started', {}), post('a', 'c1', null, 1, true)];
  for (let i = 0; i < count; i++) {
    events.push(ev('llm.call', { role: 'socialiser', status: 'ok' }, 's1'));
    events.push(changed('s1', i % 2 ? -1 : 1, i % 2 ? 1 : -1, ['c1']));
  }
  return [...events, ev('run.round_ended', {}), ev('run.finished', {})];
}

test('the influence audit samples the same 50 edges whatever the run order, with the post, opinions and reasoning', () => {
  const runs = [{ seed: 1, events: edgeLog(40) }, { seed: 2, events: edgeLog(40) }];
  const sample = sampleInfluenceEdges(runs);
  assert.equal(sample.length, 50);
  assert.deepEqual(sampleInfluenceEdges([...runs].reverse()), sample);
  assert.deepEqual(new Set(sample.map((s) => s.seed)), new Set([1, 2]));
  assert.equal(new Set(sample.map((s) => `${s.seed}:${s.edge.seq}`)).size, 50);
  assert.equal(sampleInfluenceEdges([{ seed: 1, events: edgeLog(3) }]).length, 3, 'fewer edges than the audit size are all kept');

  const events = edgeLog(1);
  const call = events.find((e) => e.type === 'llm.call')!;
  const [item] = auditItems([{ seed: 1, events, responses: new Map([[call.seq, { output: { reason: 'the post matched what I saw' } }]]) }]);
  assert.deepEqual(
    { post_text: item.post_text, before: item.before?.sentiment, after: item.after.sentiment, delta: item.delta, reasoning: item.reasoning, verdict: item.verdict },
    { post_text: 'a says c1', before: 1, after: -1, delta: -2, reasoning: { llm_call_seq: call.seq, response: { output: { reason: 'the post matched what I saw' } } }, verdict: null },
  );
  assert.equal(auditItems([{ seed: 1, events: events.filter((e) => e.type !== 'llm.call'), responses: new Map() }])[0].reasoning, null);
  assert.equal(auditCriterion(50).status, 'NOT_RUN', 'plausibility stays unmeasured until a reviewer records verdicts');
  assert.match(auditCriterion(12).detail, /12 of 50.*too few/);
});

function twoRounds(): GnomiEvent[] {
  return [
    start(),
    ev('run.round_started', {}, null, 1), ev('persona.step', {}, 'a', 1), post('a', 'c1', null, 1, true), saw('s1', ['c1'], 1), ev('run.round_ended', {}, null, 1),
    ev('run.round_started', {}, null, 2), ev('persona.step', {}, 's1', 2), changed('s1', 1, -1, ['c1'], 2), ev('social.reaction', { post_id: 'c1', kind: 'agree' }, 's1', 2), ev('run.round_ended', {}, null, 2),
    ev('persona.survey', {}, 's1', 2), ev('run.finished', {}),
  ];
}

test('scrubber replay needs paired round markers, social events inside their round, and round prefixes that project alike', () => {
  assert.deepEqual(replayProblems(twoRounds()), []);
  const unended = twoRounds().filter((e) => !(e.type === 'run.round_ended' && e.round === 2));
  assert.match(replayProblems(unended)!.join(), /round 2 has no run.round_ended/);
  const reordered = twoRounds().map((e) => (e.type === 'run.round_ended' && e.round === 1 ? { ...e, type: 'run.round_started', round: 2 } as GnomiEvent : e));
  assert.match(replayProblems(reordered)!.join(), /expected run.round_ended for round 1/);
  const mistagged = twoRounds().map((e) => (e.type === 'social.reaction' ? { ...e, round: 1 } : e));
  assert.match(replayProblems(mistagged)!.join(), /social.reaction\) carries round 1 but lies outside it/);
  const lateStep = twoRounds().map((e) => (e.type === 'persona.step' && e.round === 2 ? { ...e, round: 1 } : e));
  assert.match(replayProblems(lateStep)!.join(), /round 1: the log up to event \d+ projects differently/);
  assert.equal(replayProblems(twoRounds().filter((e) => !e.type.startsWith('run.round'))), null, 'no rounds to replay');
  assert.equal(replayProblems(twoRounds().filter((e) => e.type !== 'run.finished')), null, 'an unfinished run is not judged');

  assert.equal(replayCriterion(M4_SEEDS.map((seed) => ({ seed, events: twoRounds() }))).status, 'PASS');
  assert.equal(replayCriterion([{ seed: 1, events: twoRounds() }, { seed: 2, events: mistagged }]).status, 'FAIL');
  assert.equal(replayCriterion([{ seed: 1, events: twoRounds() }, { seed: 2, events: [] }]).status, 'NOT_RUN');
});

test('M4 mode is opt-in and a rehearsal leaves every live criterion unpassed', () => {
  assert.equal('m4' in parseOptions([]), false, 'M2 options are unchanged without --m4');
  assert.equal(parseOptions(['--m4']).m4, true);
  assert.equal(parseOptions(['--m4']).mode, 'scripted');
  const winning = M4_SEEDS.map(() => ({ events: seeded(3, 1), seed: 0 }));
  const criteria = [spreadCriterion('scripted', winning.map((run) => spreadOf(run.events))), auditCriterion(50), replayCriterion(winning), FRAME_RATE];
  assert.ok(criteria.filter((c) => c.live_required).every((c) => c.status === 'NOT_RUN'));
  assert.equal(FRAME_RATE.status, 'NOT_RUN');

  const base = fixture('http://localhost:4317');
  const injected = complaint(base);
  assert.equal(new Set(M4_SEEDS).size, 5);
  assert.equal(base.personas.find((p) => p.id === injected.persona_id)?.segment_id, 'seg-1', 'a recruiter complains');
  assert.deepEqual([injected.round, injected.poi_id], [1, base.project.poi.id]);
});
