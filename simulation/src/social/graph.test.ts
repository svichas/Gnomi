import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import type { Persona } from '../types.ts';
import { followGraph, graphMetrics, networkGraph, rewireAcrossSegments } from './graph.ts';

const population = (sizes: number[]): Persona[] =>
  sizes.flatMap((n, s) => Array.from({ length: n }, (_, i) => ({ ...BUILTIN_PERSONA, id: `p-${s}-${i}`, segment_id: `seg-${s}` })));
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

test('the follow graph is fixed by the run seed and the population', () => {
  const people = population([25, 25]);
  assert.deepEqual(followGraph(people, 7), followGraph(structuredClone(people), 7));
  assert.notDeepEqual(followGraph(people, 7), followGraph(people, 8));
});

test('each persona follows 6 to 12 others, never itself, about 70% of them from its own segment', () => {
  const people = population([30, 30, 20, 20]);
  const segment = new Map(people.map((p) => [p.id, p.segment_id]));
  let own = 0;
  let all = 0;
  for (const [id, follows] of followGraph(people, 2026)) {
    assert.ok(follows.length >= 6 && follows.length <= 12, `${id} follows ${follows.length}`);
    assert.ok(!follows.includes(id), `${id} follows itself`);
    assert.equal(new Set(follows).size, follows.length);
    own += follows.filter((f) => segment.get(f) === segment.get(id)).length;
    all += follows.length;
  }
  assert.ok(Math.abs(own / all - 0.7) < 0.03, `own-segment share ${own / all}`);
});

test('a tenth of the personas are hubs with about three times the followers', () => {
  const people = population([50, 50, 50, 50]);
  const followers = new Map(people.map((p) => [p.id, 0]));
  for (const follows of followGraph(people, 11).values()) for (const f of follows) followers.set(f, followers.get(f)! + 1);
  const counts = [...followers.values()].sort((a, b) => b - a);
  const ratio = mean(counts.slice(0, 20)) / mean(counts.slice(20));
  assert.ok(ratio > 2.3 && ratio < 4, `hubs have ${ratio.toFixed(2)}× the followers`);
});

test('small populations and segments: everyone else is followed, and a short segment hands its share to the others', () => {
  for (const follows of followGraph(population([2, 1]), 1).values()) assert.equal(follows.length, 2);
  const people = population([3, 30]);
  for (const p of people.slice(0, 3)) {
    const follows = followGraph(people, 5).get(p.id)!;
    assert.ok(follows.length >= 6);
    assert.equal(follows.filter((f) => f.startsWith('p-0-')).length, 2, 'both others in its segment');
  }
  assert.deepEqual([...followGraph(population([1]), 1).values()], [[]]);
});

test('rewiring keeps every out-degree and makes no self-follow or duplicate', () => {
  const people = population([20, 20]);
  const before = followGraph(people, 3);
  const after = rewireAcrossSegments(before, 3);
  assert.notDeepEqual(after, before);
  for (const [id, follows] of after) {
    assert.equal(follows.length, before.get(id)!.length);
    assert.ok(!follows.includes(id));
    assert.equal(new Set(follows).size, follows.length);
  }
});

test('each network policy is deterministic and keeps 6 to 12 follows, never itself', () => {
  const people = population([15, 15, 10]);
  for (const policy of ['legacy', 'rewired', 'random', 'clustered'] as const) {
    const g = networkGraph(policy, people, 5);
    assert.deepEqual(g, networkGraph(policy, structuredClone(people), 5), policy);
    for (const [id, follows] of g) {
      assert.ok(follows.length >= 6 && follows.length <= 12, `${policy} ${id} follows ${follows.length}`);
      assert.ok(!follows.includes(id) && new Set(follows).size === follows.length);
    }
  }
  assert.equal(networkGraph('random', population([1]), 5).get('p-0-0')!.length, 0);
});

test('graph metrics on a hand-built graph', () => {
  const people = population([2, 2]);
  const follows = new Map([['p-0-0', ['p-0-1']], ['p-0-1', ['p-0-0']], ['p-1-0', ['p-1-1']], ['p-1-1', ['p-0-0']]]);
  const m = graphMetrics(follows, people);
  assert.equal(m.mean_in_degree, 1);
  assert.equal(m.mean_out_degree, 1);
  assert.equal(m.segment_assortativity, 0.25); // 3 of 4 follows stay in a segment (0.75) less the 0.5 expected by chance
  assert.equal(m.top_decile_in_share, 0.5); // one persona of four, p-0-0, receives two of the four follows
  assert.equal(graphMetrics(new Map(), people).segment_assortativity, 0);
});
