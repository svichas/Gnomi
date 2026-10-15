import type { Audience, Persona, Segment } from '@gnomi/engine/types.ts';

// The audience builder's rules, kept free of React so they can be tested on their own (idea.md §8.1).

/** Apportions `total` whole units in proportion to `weights` (largest remainder, earlier index first on ties); equal when all weights are 0. */
function apportion(weights: number[], total: number): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((weight) => (sum > 0 ? (weight * total) / sum : total / weights.length));
  const units = exact.map(Math.floor);
  const byRemainder = exact.map((value, i) => ({ i, rest: value - Math.floor(value) })).sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (let left = total - units.reduce((a, b) => a + b, 0), k = 0; left > 0; left--, k++) units[byRemainder[k].i] += 1;
  return units;
}

/** Shares as whole percents that add up to 100 again after the one at `index` is set to `value`: the others share what is left in proportion. */
export function rebalance(shares: number[], index: number, value: number): number[] {
  if (shares.length === 1) return [100];
  const chosen = Math.max(0, Math.min(100, Math.round(value)));
  const others = apportion(
    shares.filter((_, i) => i !== index),
    100 - chosen,
  );
  return shares.map((_, i) => (i === index ? chosen : others[i < index ? i : i - 1]));
}

export const newSeed = () => Math.floor(Math.random() * 2 ** 31);

export function blankSegment(id: string, name: string, share: number): Segment {
  return {
    id,
    name,
    description: '',
    share,
    role: null,
    usage_frequency: 'weekly',
    typical_goals: [],
    mobile_share: 0.2,
    patience: [2, 4],
    tech_skill: [2, 4],
    account_state: 'empty',
    entry: 'direct',
    goal_override: null,
  };
}

/** The "start from one segment" audience: everyone in one segment, with the shape of the product's own description. */
export function blankAudience(description: string): Audience {
  // shortcut: population-wide distributions and company size are fixed defaults; offer editing when someone needs another mix
  return {
    seed: newSeed(),
    persona_count: 50,
    segments: [{ ...blankSegment('seg-1', 'Everyone', 100), description }],
    company_size: [20, 1000],
    languages: { en: 1 },
    accessibility: { none: 0.92, low_vision: 0.03, colour_blind: 0.03, screen_reader: 0.01, motor: 0.01 },
  };
}

const withShares = (segments: Segment[], shares: number[]) => segments.map((segment, i) => ({ ...segment, share: shares[i] }));

export function setShare(audience: Audience, id: string, value: number): Audience {
  const index = audience.segments.findIndex((segment) => segment.id === id);
  const shares = rebalance(audience.segments.map((segment) => segment.share), index, value);
  return { ...audience, segments: withShares(audience.segments, shares) };
}

/** A new segment takes an even slice, and the others give up theirs in proportion. */
export function addSegment(audience: Audience): Audience {
  const n = audience.segments.length;
  const number = Math.max(0, ...audience.segments.map((segment) => Number(/\d+$/.exec(segment.id)?.[0] ?? 0))) + 1;
  const segments = [...audience.segments, blankSegment(`seg-${number}`, `Segment ${n + 1}`, 0)];
  return { ...audience, segments: withShares(segments, rebalance([...audience.segments.map((s) => s.share), 0], n, Math.round(100 / (n + 1)))) };
}

/** The last segment cannot go; the others take over the removed share in proportion. */
export function removeSegment(audience: Audience, id: string): Audience {
  if (audience.segments.length === 1) return audience;
  const rest = audience.segments.filter((segment) => segment.id !== id);
  return { ...audience, segments: withShares(rest, apportion(rest.map((segment) => segment.share), 100)) };
}

/** Each segment with a share gets at least three personas (roadmap M2). */
export const personaMinimum = (audience: Audience) => 3 * audience.segments.filter((segment) => segment.share > 0).length;
export const PERSONA_MAXIMUM = 200;

/** The audience as it is saved: names trimmed and blank goal lines dropped. */
export function cleanAudience(audience: Audience): Audience {
  return {
    ...audience,
    segments: audience.segments.map((segment) => ({
      ...segment,
      name: segment.name.trim(),
      description: segment.description.trim(),
      typical_goals: segment.typical_goals.map((goal) => goal.trim()).filter(Boolean),
      goal_override: segment.goal_override?.trim() || null,
    })),
  };
}

const whole = (n: number) => Number.isInteger(n);

/** What is wrong with the audience, as a sentence, or null. */
export function audienceProblem(audience: Audience): string | null {
  if (audience.segments.length === 0) return 'Audience: add at least one segment.';
  if (audience.segments.some((segment) => !segment.name.trim())) return 'Audience: give every segment a name.';
  if (audience.segments.reduce((sum, segment) => sum + segment.share, 0) !== 100) return 'Audience: the segment shares must add up to 100%.';
  const minimum = personaMinimum(audience);
  if (!whole(audience.persona_count) || audience.persona_count < minimum || audience.persona_count > PERSONA_MAXIMUM)
    return `Audience: the persona count must be a whole number from ${minimum} to ${PERSONA_MAXIMUM}.`;
  if (!whole(audience.seed) || audience.seed < 0) return 'Audience: the seed must be a whole number, zero or more.';
  for (const { name, patience, tech_skill } of audience.segments) {
    for (const [what, [low, high]] of [['patience', patience], ['tech skill', tech_skill]] as const)
      if (!whole(low) || !whole(high) || low < 1 || high > 5 || low > high) return `Audience: ${name}: ${what} must run from a whole number 1 to 5 up to one that is no lower.`;
  }
  return null;
}

/** How many personas have each value, most common first, or in the order given. */
export function distribution(personas: Persona[], pick: (persona: Persona) => string, order?: string[]): [label: string, count: number][] {
  const counts = new Map<string, number>(order?.map((label) => [label, 0]));
  for (const persona of personas) counts.set(pick(persona), (counts.get(pick(persona)) ?? 0) + 1);
  const entries = [...counts];
  return order ? entries : entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// FNV-1a over UTF-16 code units, as the engine derives each persona's seed (engine/src/audience/sample.ts; a test keeps the two together).
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/**
 * Whether the persona was added by hand rather than allotted by its segment's share: the engine seeds those from a base of their own,
 * and a regenerated persona keeps its base. Only hand-added personas stay removed; the others come back when personas are generated again.
 * shortcut: this reads the engine's seed scheme; ask the engine to flag hand-added personas if that scheme changes.
 */
export function addedByHand(persona: Persona, audienceSeed: number | null): boolean {
  if (persona.segment_id === null || audienceSeed === null) return false;
  const slot = Number(persona.id.slice(persona.id.lastIndexOf('-') + 1)) - 1;
  return persona.seed % 2 ** 32 === fnv1a(`${audienceSeed}/${persona.segment_id}/${slot}/added`);
}
