import { fnv1a, mulberry32 } from '../audience/sample.ts';
import type { Persona } from '../types.ts';

const OWN_SHARE = 0.7;
const HUB_SHARE = 0.1;
const HUB_WEIGHT = 3;

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
    const count = Math.min(6 + Math.floor(next() * 7), ids.length - 1);
    const own = personas.filter((o) => o.id !== p.id && o.segment_id === p.segment_id).map((o) => o.id);
    const others = personas.filter((o) => o.segment_id !== p.segment_id).map((o) => o.id);
    // A pool too small for its share hands the rest to the other one.
    const fromOwn = Math.min(own.length, Math.max(Math.round(count * OWN_SHARE), count - others.length));
    return [p.id, [...pick(own, fromOwn), ...pick(others, count - fromOwn)]];
  }));
}
