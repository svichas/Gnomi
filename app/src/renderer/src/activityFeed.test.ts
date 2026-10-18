import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent } from '@gnomi/simulation/types.ts';
import { toRows } from './activity.ts';
import { activityMoments, momentKind, pendingActivityCount } from './activityFeed.ts';

function event<K extends EventType>(seq: number, type: K, payload: EventPayloads[K], persona_id = 'p-1', round = 1, poi_id = 'poi-1'): GnomiEvent {
  return { seq, ts: seq, run_id: 'run-1', persona_id, round, poi_id, type, payload } as GnomiEvent;
}

const step = (seq: number, persona = 'p-1', round = 1, poi = 'poi-1') => event(seq, 'persona.step', {
  step_no: 2, action: { type: 'click', ref: 'next' }, target: { role: 'button', name: 'Next' },
  result: { ok: true }, thought: 'I expect to see a confirmation.', screenshot: null, feeling: 0,
} as EventPayloads['persona.step'], persona, round, poi);

test('highlights group a thought, action and its detected friction despite concurrent participants', () => {
  const rows = toRows([
    step(1), step(2, 'p-2'),
    event(3, 'persona.friction_reported', { step_no: 2, severity: 3, what: 'Nothing happened.', expected: 'A confirmation.', where: { url: 'https://example.test/', ref: 'next' } }),
    event(4, 'signal.failed_action', { step_no: 2, action: 'click', error: 'no_effect', url: 'https://example.test/', ref: 'next' }),
  ]);
  const moments = activityMoments(rows);
  assert.equal(moments.length, 2);
  assert.equal(moments[0].row.tone, 'friction', 'the issue remains prominent');
  assert.deepEqual(moments[0].related.map((row) => row.seq), [1, 3, 4]);
  assert.equal(moments[0].related[0].quote, 'I expect to see a confirmation.');
  assert.equal(momentKind(moments[0].row), 'Friction');
});

test('a step number never combines different personas, rounds or points of interest', () => {
  const moments = activityMoments(toRows([step(1), step(2, 'p-2'), step(3, 'p-1', 2), step(4, 'p-1', 1, 'poi-2')]));
  assert.equal(moments.length, 4);
  assert.equal(new Set(moments.map((moment) => moment.key)).size, 4);
});

test('all events preserves individual entries and highlights retain failed routine events', () => {
  const rows = toRows([step(1), event(2, 'social.feed_viewed', { post_ids: [] }), event(3, 'run.finished', {}, undefined)]);
  assert.equal(activityMoments(rows, true).length, 3);
  assert.equal(activityMoments(rows).length, 1);
  const failed = { ...rows[1], badge: { ok: false, text: 'Could not read the feed' } };
  assert.equal(activityMoments([failed]).length, 1);
  assert.equal(momentKind(failed), 'Action failed');
});

test('later signals update the same moment identity and keep failed action outcomes visible', () => {
  const original = toRows([step(1)]);
  const failed = { ...original[0], badge: { ok: false, text: 'Timed out' } };
  const signal = toRows([event(3, 'signal.failed_action', { step_no: 2, action: 'click', error: 'timeout', url: 'https://example.test/', ref: 'next' })])[0];
  const moments = activityMoments([signal, failed]);
  assert.equal(moments[0].key, activityMoments(original)[0].key);
  assert.equal(moments[0].row.badge?.ok, false);
});

test('legacy rows without source scope remain separate rather than accidentally merging', () => {
  const rows = [1, 2].map((seq) => ({ seq, persona_id: 'p-1', tone: 'plain' as const, label: 'Step 2', title: 'Clicked Next' }));
  assert.equal(activityMoments(rows).length, 2);
});

test('feedback has a plain-language headline while retaining exact values in its evidence', () => {
  const [survey] = toRows([event(1, 'persona.survey', { poi_id: 'poi-1', sentiment: -1, confidence: 0.6, likes: [], frictions: ['No confirmation'], would_continue: false, reason: 'I cannot tell if it worked.' })]);
  assert.equal(survey.headline, 'Would not keep using it');
  assert.match(survey.title, /sentiment -1, self-reported confidence 60%/);
  const [opinion] = toRows([event(2, 'persona.opinion_changed', { poi_id: 'poi-1', before: null, after: { sentiment: 1, confidence: 0.8, likes: ['Clear labels'], frictions: [] }, cause: { step_ids: [1], post_ids: [] } })]);
  assert.equal(opinion.headline, 'Has a positive impression');
  assert.match(opinion.title, /Sentiment \+1; self-reported confidence 80%/);
});

test('resuming after a block remains a distinct moment with the latest outcome first', () => {
  const rows = toRows([
    event(1, 'persona.blocked', { step_no: 2, reason: 'captcha', detail: 'Complete the check.' }),
    event(2, 'persona.resumed', { step_no: 2 }),
  ]);
  const moments = activityMoments(rows);
  assert.equal(moments.length, 2);
  assert.equal(moments[0].row.tone, 'good');
});

test('paused updates count new events and changes to an existing aggregated event', () => {
  const frozen = toRows([step(1)]);
  assert.equal(pendingActivityCount(frozen, frozen), 0);
  assert.equal(pendingActivityCount(toRows([step(2), step(1)]), frozen), 1);
  assert.equal(pendingActivityCount([{ ...frozen[0], title: 'Changed action' }], frozen), 1);
});
