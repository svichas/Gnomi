import { DirectedGraph } from 'graphology';
import { clusters, erdosRenyi } from 'graphology-generators/random/index.js';
import { graph as graphLib } from 'graphology-metrics';
import { fnv1a, mulberry32 } from '../audience/sample.ts';
import type { NetworkPolicy, Persona } from '../types.ts';

const OWN_SHARE = 0.7;
const HUB_SHARE = 0.1;
const HUB_WEIGHT = 3;
const MIN_FOLLOWS = 6;
const MAX_FOLLOWS = 12;

/**
 * The follow graph (tech.md §6.6): each persona follows 6–12 others (fewer when the population is smaller), 70% from its own
 * segment and 30% from others, and 10% of personas are hubs drawn three times as often, so they gather about three times the
 * followers. Nobody follows itself. Deterministic from the run seed and the population order; pure.
 */
export function followGraph(personas: Persona[], seed: number): Map<string, string[]> {
  const next = mulberry32(fnv1a(`follows/${seed}`));
  const ids = personas.map((p) => p.id);
  const hubs = new Set(ids.map((id) => ({ id, key: next() })).sort((a, b) => a.key - b.key).slice(0, Math.round(ids.length * HUB_SHARE)).map((h) => h.id));
  // Weighted sampling without replacement (Efraimidis–Spirakis): the k largest u^(1/w).
  const pick = (pool: string[], k: number) =>
    pool.map((id) => ({ id, key: next() ** (1 / (hubs.has(id) ? HUB_WEIGHT : 1)) })).sort((a, b) => b.key - a.key).slice(0, k).map((c) => c.id);
  return new Map(personas.map((p) => {
    const count = Math.min(MIN_FOLLOWS + Math.floor(next() * (MAX_FOLLOWS - MIN_FOLLOWS + 1)), ids.length - 1);
    const own = personas.filter((o) => o.id !== p.id && o.segment_id === p.segment_id).map((o) => o.id);
    const others = personas.filter((o) => o.segment_id !== p.segment_id).map((o) => o.id);
    // A pool too small for its share hands the rest to the other one.
    const fromOwn = Math.min(own.length, Math.max(Math.round(count * OWN_SHARE), count - others.length));
    return [p.id, [...pick(own, fromOwn), ...pick(others, count - fromOwn)]];
  }));
}

/** Degree-preserving null (new_simulation.md §4): swaps the targets of random follow pairs, whatever their segments, keeping every out-degree. */
export function rewireAcrossSegments(follows: Map<string, string[]>, seed: number): Map<string, string[]> {
  const next = mulberry32(fnv1a(`rewire/${seed}`));
  const out = new Map([...follows].map(([id, f]) => [id, [...f]]));
  const edges = [...out].flatMap(([id, f]) => f.map((_, i) => [id, i] as const));
  for (let n = 0; n < edges.length * 10; n++) {
    const [a, i] = edges[Math.floor(next() * edges.length)]!;
    const [c, j] = edges[Math.floor(next() * edges.length)]!;
    const b = out.get(a)![i]!;
    const d = out.get(c)![j]!;
    if (a === d || c === b || out.get(a)!.includes(d) || out.get(c)!.includes(b)) continue;
    out.get(a)![i] = d;
    out.get(c)![j] = b;
  }
  return out;
}

/** The follow graph under a network policy: the legacy one, its rewiring, or a graphology random or clustered graph held to 6–12 follows each. */
export function networkGraph(policy: NetworkPolicy, personas: Persona[], seed: number): Map<string, string[]> {
  const legacy = followGraph(personas, seed);
  if (policy === 'legacy' || personas.length < 2) return legacy;
  if (policy === 'rewired') return rewireAcrossSegments(legacy, seed);
  const n = personas.length;
  const next = mulberry32(fnv1a(`${policy}/${seed}`));
  const g = policy === 'random'
    ? erdosRenyi(DirectedGraph, { order: n, probability: Math.min(1, 9 / (n - 1)), rng: next })
    : clusters(DirectedGraph, { order: n, size: n * 9, clusters: new Set(personas.map((p) => p.segment_id)).size, clusterDensity: 0.7, rng: next });
  const hi = Math.min(MAX_FOLLOWS, n - 1);
  const lo = Math.min(MIN_FOLLOWS, hi);
  const shuffled = (xs: number[]) => xs.map((x) => ({ x, key: next() })).sort((a, b) => a.key - b.key).map((e) => e.x);
  return new Map(personas.map((p, i) => {
    const kept = shuffled(g.outNeighbors(String(i)).map(Number)).slice(0, hi);
    const rest = shuffled(personas.map((_, k) => k).filter((k) => k !== i && !kept.includes(k)));
    return [p.id, [...kept, ...rest.slice(0, Math.max(0, lo - kept.length))].map((k) => personas[k]!.id)];
  }));
}

/** Evaluation-harness measures of a follow graph; segment assortativity is directed modularity of the segment partition, since graphology-metrics has no assortativity function. */
export function graphMetrics(follows: Map<string, string[]>, personas: Persona[]) {
  const g = new DirectedGraph();
  for (const p of personas) g.addNode(p.id, { segment: String(p.segment_id) });
  for (const [id, f] of follows) for (const t of f) g.addEdge(id, t);
  const n = personas.length;
  const inDegrees = personas.map((p) => g.inDegree(p.id)).sort((a, b) => b - a);
  return {
    segment_assortativity: g.size ? graphLib.modularity(g, { getNodeCommunity: 'segment' }) : 0,
    mean_in_degree: g.size / n,
    mean_out_degree: g.size / n,
    // The share of all follows that the top tenth of personas by in-degree receive.
    top_decile_in_share: g.size ? inDegrees.slice(0, Math.ceil(n / 10)).reduce((a, b) => a + b, 0) / g.size : 0,
  };
}
