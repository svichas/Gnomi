import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GnomiEvent, Opinion } from '../types.ts';
import { influenceEdges } from './influence.ts';

const base = { run_id: 'r-1', poi_id: 'poi-1', ts: 0 };
const post = (seq: number, persona_id: string, post_id: string, about_poi_id: string | null = 'poi-1'): GnomiEvent => ({
  ...base, seq, round: 1, persona_id, type: 'social.post', payload: { post_id, parent_id: null, text: 'The review screen hides the feedback button', about_poi_id },
});
const view = (sentiment: number): Opinion => ({ sentiment, confidence: 0.5, likes: [], frictions: [] });
const changed = (seq: number, persona_id: string, before: number | null, after: number, post_ids: string[], poi_id = 'poi-1'): GnomiEvent => ({
  ...base, seq, round: 2, persona_id, type: 'persona.opinion_changed',
  payload: { poi_id, before: before === null ? null : view(before), after: view(after), cause: { step_ids: [], post_ids } },
});

test('a cited post about the same POI that moved the sentiment draws one edge from its author', () => {
  const edges = influenceEdges([post(1, 'a', 's1'), changed(2, 'b', 1, -1, ['s1', 's1'])]);
  assert.deepEqual(edges, [{ from: 'a', to: 'b', poi_id: 'poi-1', post_id: 's1', seq: 2, round: 2, delta: -2, kind: 'influence' }]);
});

test('no edge without movement, citation, a known post, the same POI or another author', () => {
  const events = [
    post(1, 'a', 's1'),
    post(2, 'a', 'other', 'poi-2'),
    post(3, 'c', 'own'),
    changed(4, 'b', -1, -1, ['s1']), // sentiment unchanged
    changed(5, 'b', -1, 1, []), // changed but uncited
    changed(6, 'b', -1, 1, ['missing']), // cites a post the log does not have
    changed(7, 'b', 1, -1, ['other']), // the post is about another POI
    changed(8, 'c', 1, -1, ['own']), // its own post
  ];
  assert.deepEqual(influenceEdges(events), []);
});

test('a first opinion after reading a post is formed, not influenced, and moves from neutral', () => {
  assert.deepEqual(influenceEdges([post(1, 'a', 's1'), changed(2, 'b', null, -1, ['s1'])]).map((e) => e.kind), ['formed']);
  assert.equal(influenceEdges([post(1, 'a', 's1'), changed(2, 'b', null, 0, ['s1'])]).length, 0);
});

test('a reply about no POI is about its parent’s, and a change at a step handed a post it does not cite is heard, not influence', () => {
  const reply = post(2, 'a', 'r1', null);
  if (reply.type === 'social.post') reply.payload.parent_id = 's1';
  const step: GnomiEvent = {
    ...base, seq: 3, round: 2, persona_id: 'b', type: 'persona.step',
    payload: { step_no: 1, action: { type: 'click', ref: 'e1', text: null }, target: null, result: { ok: true, url_before: 'u', url_after: 'u', dom_changed: true, error: null }, thought: '', feeling: 0, snapshot_hash: 'h', screenshot: null, duration_ms: 1, heard_post_ids: ['r1'] },
  };
  const change = changed(4, 'b', 1, -1, []);
  if (change.type === 'persona.opinion_changed') change.payload.cause.step_ids = [3];
  assert.deepEqual(influenceEdges([post(1, 'c', 's1'), reply, step, change, changed(5, 'd', 1, -1, ['r1'])]).map((e) => [e.from, e.to, e.post_id, e.kind]), [
    ['a', 'b', 'r1', 'heard'],
    ['a', 'd', 'r1', 'influence'],
  ]);
});
