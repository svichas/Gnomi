import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent } from '@gnomi/simulation/types.ts';
import { roundMoments, selectMoments } from './swarm-moments.ts';

function event<K extends EventType>(seq: number, type: K, payload: EventPayloads[K], who: string | null = 'a', round = 1): GnomiEvent {
  return { seq, ts: seq, run_id: 'r-1', round, persona_id: who, poi_id: 'checkout', type, payload } as GnomiEvent;
}
const post = (seq: number, id: string, who: string | null, parent: string | null = null, round = 1) => event(seq, 'social.post', { post_id: id, parent_id: parent, text: 'The save button is hard to find.', about_poi_id: 'checkout' }, who, round);
const friction = (seq: number, who = 'a') => event(seq, 'persona.friction_reported', { step_no: 1, severity: 3, what: 'No confirmation after saving.', expected: 'A success message.', where: { url: 'https://example.test', ref: null }, heard_post_ids: [] }, who);

test('bubbles retain recorded thoughts, friction severity and outcomes', () => {
  const thought = event(1, 'persona.step', { step_no: 1, action: { type: 'click', ref: 'e1', text: null }, target: null, result: { ok: true, error: null, url_before: '', url_after: '', dom_changed: true }, thought: 'Did that save?', feeling: -1, snapshot_hash: '', screenshot: null, duration_ms: 1, heard_post_ids: [] });
  const moments = roundMoments([thought, friction(2), event(3, 'persona.goal_done', { step_no: 2, summary: 'Saved the draft.' })], 1, 3);
  assert.deepEqual(moments.map((m) => [m.label, m.text]), [['Thought', 'Did that save?'], ['Friction', 'No confirmation after saving.'], ['Goal reached', 'Saved the draft.']]);
  assert.equal(moments[1].detail, 'Severity 3 of 4');
  assert.deepEqual(selectMoments(moments, 'friction', null).map((m) => m.seq), [2]);
});

test('social arrows preserve actor-to-recipient direction and resolve posts from earlier rounds', () => {
  const moments = roundMoments([post(1, 'original', 'a'), post(2, 'reply', 'b', 'original', 2), event(3, 'social.reaction', { post_id: 'reply', kind: 'disagree' }, 'c', 2)], 2, 3);
  assert.deepEqual(moments.map((m) => [m.label, m.persona, m.target]), [['Reply', 'b', 'a'], ['Disagreed', 'c', 'b']]);
  assert.deepEqual(selectMoments(moments, 'social', 'persona:a').map((m) => m.seq), [2]);
  assert.equal(selectMoments(moments, 'social', 'poi:checkout').length, 2);
});

test('round replay never shows future moments or invents partners for unknown, self or external posts', () => {
  const events = [post(1, 'mine', 'a'), post(2, 'seed', null), event(3, 'social.reaction', { post_id: 'missing', kind: 'agree' }), post(4, 'self', 'a', 'mine'), post(5, 'external', 'b', 'seed'), post(6, 'future', 'c', null, 2)];
  const moments = roundMoments(events, 1, 4);
  assert.deepEqual(moments.map((m) => m.seq), [1, 3, 4]);
  assert.ok(moments.every((m) => m.target === null));
  assert.equal(roundMoments(events, 1, 6).at(-1)?.target, null);
  assert.deepEqual(roundMoments(events, 2, 6).map((m) => m.seq), [6]);
});

test('highlights stay bounded and a busy persona does not crowd everyone else out', () => {
  const moments = roundMoments([friction(1, 'a'), friction(2, 'b'), friction(3, 'a'), friction(4, 'c')], 1, 4);
  assert.deepEqual(selectMoments(moments, 'all', null, 2).map((m) => m.seq), [4, 3]);
  assert.deepEqual(selectMoments(moments, 'all', null).map((m) => m.seq), [4, 3, 2]);
  assert.deepEqual(selectMoments(moments, 'all', 'persona:b').map((m) => m.seq), [2]);
});
