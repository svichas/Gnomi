import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { stepSchema } from '../agent/prompt.ts';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { EventOf, GnomiEvent, Opinion } from '../types.ts';
import { foldOpinions, sameOpinion } from './index.ts';

const opinion: Opinion = { sentiment: -1, confidence: 0.6, likes: ['Clear navigation'], frictions: ['No save confirmation'] };
const step = { thought: 'I am unsure.', feeling: -1, action: { type: 'read', ref: null, text: null }, friction: null };

test('opinions are bounded explicit snapshots, while older step outputs remain valid', () => {
  const schema = stepSchema(BUILTIN_PERSONA);
  assert.deepEqual(schema.parse(step), step);
  assert.equal(schema.safeParse({ ...step, opinion: null }).success, true);
  assert.deepEqual(schema.parse({ ...step, opinion }).opinion, opinion);
  for (const change of [{ sentiment: 3 }, { sentiment: 0.5 }, { confidence: -0.1 }, { confidence: 1.1 }, { confidence: Infinity }, { likes: Array(6).fill('One') }, { frictions: [' '] }, { likes: ['x'.repeat(501)] }, { surprise: true }]) {
    assert.equal(schema.safeParse({ ...step, opinion: { ...opinion, ...change } }).success, false, JSON.stringify(change));
  }
  assert.equal(schema.safeParse({ ...step, opinion: { sentiment: 0, confidence: 0, likes: [], frictions: [] } }).success, true);
  const provider = z.toJSONSchema(schema, { io: 'input', target: 'draft-7' });
  assert.deepEqual(provider.required, ['thought', 'feeling', 'action', 'friction', 'opinion']);
  assert.equal(provider.additionalProperties, false);
});

const changed = (seq: number, overrides: Partial<EventOf<'persona.opinion_changed'>> = {}): EventOf<'persona.opinion_changed'> => ({
  run_id: 'r-1', persona_id: 'p-1', poi_id: 'poi-1', seq, ts: seq, round: 1, type: 'persona.opinion_changed',
  payload: { poi_id: 'poi-1', before: null, after: opinion, cause: { step_ids: [seq - 1], post_ids: [] } }, ...overrides,
});

test('opinion equality compares only explicit values and ordered evidence summaries', () => {
  assert.equal(sameOpinion(null, opinion), false);
  assert.equal(sameOpinion(opinion, structuredClone(opinion)), true);
  assert.equal(sameOpinion(opinion, { ...opinion, confidence: 0.7 }), false);
  assert.equal(sameOpinion({ ...opinion, likes: ['a', 'b'] }, { ...opinion, likes: ['b', 'a'] }), false);
});

test('current opinions fold by run, persona and POI, using event sequence across rounds', () => {
  const first = changed(2);
  const latest = changed(8, { round: 2, payload: { ...first.payload, before: opinion, after: { ...opinion, sentiment: 1 }, cause: { step_ids: [7], post_ids: [] } } });
  const anotherPoi = changed(4, { poi_id: 'poi-2', payload: { ...first.payload, poi_id: 'poi-2' } });
  const anotherPersona = changed(6, { persona_id: 'p-2' });
  const anotherRun = changed(2, { run_id: 'r-2' });
  const events: GnomiEvent[] = [latest, anotherRun, anotherPoi, first, anotherPersona, latest];
  const result = foldOpinions(events);
  assert.equal(result.length, 4);
  assert.deepEqual(result[0], { run_id: 'r-1', persona_id: 'p-1', poi_id: 'poi-1', opinion: latest.payload.after, seq: 8, round: 2, cause: latest.payload.cause });
  assert.deepEqual(foldOpinions([...events].reverse()), result);
  assert.deepEqual(foldOpinions([]), []);
  result[0].opinion.likes.push('Changed outside the log');
  assert.deepEqual(latest.payload.after.likes, opinion.likes, 'projection must not expose mutable log references');
  assert.deepEqual(foldOpinions([changed(2, { persona_id: null })]), []);
});
