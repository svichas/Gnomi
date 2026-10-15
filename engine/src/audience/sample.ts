// Traits come from code, never the model (tech.md §2.4), with integer and exactly rounded arithmetic so a seed means the same everywhere.
import type { Audience, Persona, Segment, UsageFrequency } from '../types.ts';

/** FNV-1a, 32-bit, over UTF-16 code units: a stable string hash for deriving seeds. */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small 32-bit PRNG, floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Largest remainder, ties to the earlier weight. A positive weight whose quota falls short of min is pinned at min and the rest split again. */
export function apportion(weights: readonly number[], total: number, min: number): number[] {
  const pinned = new Set<number>();
  for (;;) {
    const free = weights.flatMap((w, i) => (w > 0 && !pinned.has(i) ? [i] : []));
    const left = Math.max(0, total - min * pinned.size);
    const sum = free.reduce((s, i) => s + weights[i], 0);
    const under = free.filter((i) => left * weights[i] < min * sum);
    if (under.length) {
      for (const i of under) pinned.add(i);
      continue;
    }
    const out = weights.map((_, i) => (pinned.has(i) ? min : 0));
    for (const i of free) out[i] = Math.floor((left * weights[i]) / sum);
    const remainder = (i: number) => left * weights[i] - out[i] * sum;
    let rest = left - free.reduce((s, i) => s + out[i], 0);
    for (const i of [...free].sort((a, b) => remainder(b) - remainder(a) || a - b)) if (rest-- > 0) out[i]++;
    return out;
  }
}

/** A persona's seed is its base seed plus GENERATION × the times it was regenerated, so a sync tells a regenerated persona of a slot from a stale one. */
export const GENERATION = 2 ** 32;

export const slotSeed = (audienceSeed: number, segmentId: string, index: number) => fnv1a(`${audienceSeed}/${segmentId}/${index}`);

// Personas added by hand get their own base, so a sync keeps them instead of dropping them as slots that no longer exist.
export const addedSeed = (audienceSeed: number, segmentId: string, index: number) => fnv1a(`${audienceSeed}/${segmentId}/${index}/added`);

/** 'p-seg2-07' for segment 'seg-2', slot index 6: stable per slot, short and URL-safe. */
// shortcut: segment ids must stay distinct without punctuation ('seg-1' and 'seg1' would share ids); fine while ids are 'seg-N'.
export const personaId = (segmentId: string, index: number) =>
  `p-${segmentId.toLowerCase().replace(/[^a-z0-9]/g, '')}-${String(index + 1).padStart(2, '0')}`;

export const slotIndex = (personaId: string) => Number(personaId.slice(personaId.lastIndexOf('-') + 1)) - 1;

export type Traits = Pick<
  Persona,
  | 'segment_id'
  | 'device'
  | 'patience'
  | 'tech_skill'
  | 'familiarity_with_category'
  | 'language'
  | 'accessibility_needs'
  | 'pronouns'
  | 'company_size'
  | 'seniority'
  | 'motivation'
>;

export const TRAIT_KEYS = [
  'segment_id',
  'device',
  'patience',
  'tech_skill',
  'familiarity_with_category',
  'language',
  'accessibility_needs',
  'pronouns',
  'company_size',
  'seniority',
  'motivation',
] as const satisfies readonly (keyof Traits)[];

export const sameTraits = (persona: Persona, traits: Traits) => TRAIT_KEYS.every((k) => persona[k] === traits[k]);

const FAMILIARITY: Record<UsageFrequency, Persona['familiarity_with_category']> = {
  daily: 'high',
  weekly: 'medium',
  monthly: 'low',
  rarely: 'low',
  never: 'low',
};

// About equal she and he, and a few percent they, so no prompt assumes a binary.
const PRONOUNS = [['she', 0.48], ['he', 0.48], ['they', 0.04]] as const;

// A typical organisation pyramid: most people who use a work tool are individual contributors; leads are the thin top.
const SENIORITY = [['junior', 0.25], ['mid', 0.4], ['senior', 0.25], ['lead', 0.1]] as const;

// Most people meet a work tool as a chore, not with enthusiasm, which also leans against the over-eager simulated user (tech.md §2.4).
const MOTIVATION = [[1, 0.1], [2, 0.25], [3, 0.35], [4, 0.2], [5, 0.1]] as const;

function pick<T>(entries: readonly (readonly [T, number])[], u: number, fallback: T): T {
  const usable = entries.filter(([, w]) => w > 0);
  let x = u * usable.reduce((s, [, w]) => s + w, 0);
  for (const [value, w] of usable) if ((x -= w) < 0) return value;
  return usable.at(-1)?.[0] ?? fallback;
}

// Sorted by key, so the same distribution samples the same way however an editor ordered its keys.
const sorted = <K extends string>(dist: Record<K, number>) =>
  (Object.entries(dist) as [K, number][]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

const level = (n: number) => Math.min(5, Math.max(1, Math.round(n)));

function between(u: number, [a, b]: readonly [number, number]): number {
  const lo = level(Math.min(a, b));
  return lo + Math.floor(u * (level(Math.max(a, b)) - lo + 1));
}

function companySize(u: number, [a, b]: readonly [number, number]): number {
  const lo = Math.max(1, Math.min(a, b));
  const hi = Math.max(lo, a, b);
  const raw = Math.exp(Math.log(lo) + u * (Math.log(hi) - Math.log(lo)));
  // Two significant figures: how people quote headcount, and it absorbs any last-bit difference in Math.exp between engines.
  const unit = 10 ** Math.max(0, Math.floor(Math.log10(raw)) - 1);
  return Math.min(hi, Math.max(lo, Math.round(raw / unit) * unit));
}

/** The traits a seed gives in this segment and audience. Pure. */
export function sampleTraits(segment: Segment, audience: Audience, seed: number): Traits {
  const next = mulberry32(fnv1a(`traits/${seed}`));
  // One draw per trait in a fixed order, so editing one distribution re-samples only that trait.
  return {
    segment_id: segment.id,
    device: next() < segment.mobile_share ? 'mobile' : 'desktop',
    patience: between(next(), segment.patience),
    tech_skill: between(next(), segment.tech_skill),
    familiarity_with_category: FAMILIARITY[segment.usage_frequency] ?? 'low',
    language: pick(sorted(audience.languages), next(), 'en'),
    accessibility_needs: pick(sorted(audience.accessibility), next(), 'none'),
    pronouns: pick(PRONOUNS, next(), 'they'),
    company_size: companySize(next(), audience.company_size),
    seniority: pick(SENIORITY, next(), 'mid'),
    motivation: pick(MOTIVATION, next(), 3),
  };
}
