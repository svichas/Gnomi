import type { LlmGateway } from '../seams.ts';
import type { AccessibilityNeed, Audience, ModelChoice, Persona, ProjectConfig, Segment } from '../types.ts';
import { PROPOSE_SYSTEM, proposalSchema, proposeUser, toSegments } from './propose.ts';
import { addedSeed, apportion, GENERATION, personaId, sameTraits, sampleTraits, slotIndex, slotSeed } from './sample.ts';
import { nameKey, writePersonas } from './write.ts';

export { diversityReport } from './diversity.ts';
export { DEMO_PERSONA_WRITER } from './demo.ts';

// The audience builder (idea.md §8, tech.md §2.4): traits are sampled in code from seeded distributions first,
// and only then written up by the persona_writer model, so diversity comes from sampling, not from asking.

export interface AudienceDeps {
  llm: LlmGateway;
  model: ModelChoice; // the persona_writer route
  project: ProjectConfig;
  roles?: string[]; // recorded login names a proposed segment may use; defaults to project.role
  onProgress?(done: number, total: number): void;
  signal?: AbortSignal;
}

const MIN_PER_SEGMENT = 3; // so every segment with a share is represented; the report still weights it by share
const MAX_PERSONAS = 200;

// Starting points the user sees and edits (idea.md §11), not measurements: about 15% think in a first language other than English.
const LANGUAGES: Record<string, number> = { en: 0.85, es: 0.04, de: 0.02, fr: 0.02, pt: 0.02, hi: 0.02, zh: 0.02, ar: 0.01 };
// About 14%: colour-vision deficiency alone affects ~8% of men and ~0.5% of women; the rest are rough, so every run meets these users.
const ACCESSIBILITY: Record<AccessibilityNeed, number> = { none: 0.86, low_vision: 0.05, colour_blind: 0.04, motor: 0.03, screen_reader: 0.02 };

/** A deterministic starting point with no model call: one segment holding the whole population. */
export function defaultAudience(project: ProjectConfig): Audience {
  return {
    seed: 1,
    persona_count: 50,
    segments: [
      {
        id: 'seg-1',
        name: 'Everyone',
        description: `All the people who use ${project.name}, in one group: every role, level of experience and device.`,
        share: 100,
        role: project.role,
        usage_frequency: 'weekly',
        typical_goals: project.goal ? [project.goal] : [],
        mobile_share: 0.25,
        patience: [1, 5], // one segment for everyone spans the full ranges until segments narrow them
        tech_skill: [1, 5],
        account_state: 'populated',
        entry: 'direct',
        goal_override: null,
      },
    ],
    company_size: [50, 2000],
    languages: { ...LANGUAGES },
    accessibility: { ...ACCESSIBILITY },
  };
}

/** Proposes segments from the product sentence, the POI and the goal (idea.md §5.1 step 3). */
export async function proposeAudience(deps: AudienceDeps): Promise<{ audience: Audience; cost_usd: number }> {
  const roles = deps.roles ?? (deps.project.role ? [deps.project.role] : []);
  try {
    const { object, cost_usd } = await deps.llm.call({
      role: 'persona_writer',
      model: deps.model,
      run_id: null,
      persona_id: null,
      round: 0,
      purpose: 'propose_audience',
      system: PROPOSE_SYSTEM,
      user: [{ type: 'text', text: proposeUser(deps.project, roles) }],
      schema: proposalSchema(roles),
      signal: deps.signal,
    });
    return { audience: { ...defaultAudience(deps.project), segments: toSegments(object) }, cost_usd };
  } catch (err) {
    if (deps.signal?.aborted) throw err;
    throw new Error(`The persona writer could not propose an audience: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

interface Slot {
  id: string;
  index: number;
  seed: number;
  old: Persona | null; // the stored persona of this slot when it descends from the slot's seed
}

/** Each segment's slots: its share of persona_count (at least 3) plus the personas added by hand, in index order. */
function layout(audience: Audience, population: Persona[]): { segment: Segment; slots: Slot[] }[] {
  const count = audience.persona_count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_PERSONAS) throw new Error(`persona_count must be a whole number from 1 to ${MAX_PERSONAS}`);
  const counts = apportion(audience.segments.map((s) => s.share), count, MIN_PER_SEGMENT);
  const byId = new Map(population.map((p) => [p.id, p]));
  return audience.segments.map((segment, k) => {
    const slots: Slot[] = population
      .filter((p) => p.segment_id === segment.id && p.seed % GENERATION === addedSeed(audience.seed, segment.id, slotIndex(p.id)))
      .map((p) => ({ id: p.id, index: slotIndex(p.id), seed: p.seed, old: p }));
    const held = new Set(slots.map((s) => s.index));
    for (let index = 0, n = 0; n < counts[k]; index++) {
      if (held.has(index)) continue;
      n++;
      const id = personaId(segment.id, index);
      const base = slotSeed(audience.seed, segment.id, index);
      const old = byId.get(id);
      // A regenerated persona keeps its slot: its seed is the slot's base plus whole generations.
      const ours = old !== undefined && old.segment_id === segment.id && old.seed % GENERATION === base;
      slots.push({ id, index, seed: ours ? old.seed : base, old: ours ? old : null });
    }
    return { segment, slots: slots.sort((a, b) => a.index - b.index) };
  });
}

const takenNames = (personas: Persona[]) => new Map(personas.map((p) => [nameKey(p.name), p.name]));

function segmentOf(audience: Audience, segmentId: string | null): Segment {
  const segment = audience.segments.find((s) => s.id === segmentId);
  if (!segment) throw new Error(`The audience has no segment ${JSON.stringify(segmentId)}`);
  return segment;
}

/**
 * Brings the stored population in line with the audience. A slot whose seed and sampled traits are unchanged keeps its
 * persona with no model call, so the same audience always yields the same personas; new or changed slots are sampled
 * and written; slots that no longer exist are dropped.
 */
export async function syncPersonas(
  audience: Audience,
  existing: Persona[],
  deps: AudienceDeps,
): Promise<{ personas: Persona[]; cost_usd: number }> {
  const slots = layout(audience, existing).flatMap(({ segment, slots }) =>
    slots.map((slot) => ({ ...slot, segment, traits: sampleTraits(segment, audience, slot.seed) })),
  );
  // shortcut: an edited goal or segment description keeps the written fields; hash the writer's inputs into this check when stale goal readings matter.
  const keep = (s: (typeof slots)[number]) => s.old !== null && sameTraits(s.old, s.traits);
  const kept = slots.filter(keep).map((s) => s.old!);
  const written = await writePersonas(slots.filter((s) => !keep(s)), takenNames(kept), deps);
  const byId = new Map([...kept, ...written.personas].map((p) => [p.id, p]));
  return { personas: slots.map((s) => byId.get(s.id)!), cost_usd: written.cost_usd };
}

/** A new seed for one persona: traits re-sampled and re-written, its id kept. */
export async function regeneratePersona(
  persona: Persona,
  audience: Audience,
  population: Persona[],
  deps: AudienceDeps,
): Promise<{ persona: Persona; cost_usd: number }> {
  const segment = segmentOf(audience, persona.segment_id);
  const seed = persona.seed + GENERATION;
  const job = { id: persona.id, segment, seed, traits: sampleTraits(segment, audience, seed) };
  const { personas, cost_usd } = await writePersonas([job], takenNames(population.filter((p) => p.id !== persona.id)), deps);
  return { persona: personas[0], cost_usd };
}

/** One more persona in a segment, beyond what its share allots. */
export async function addPersona(
  segmentId: string,
  audience: Audience,
  population: Persona[],
  deps: AudienceDeps,
): Promise<{ persona: Persona; cost_usd: number }> {
  const segment = segmentOf(audience, segmentId);
  const used = new Set([
    ...(layout(audience, population).find((l) => l.segment.id === segmentId)?.slots.map((s) => s.index) ?? []),
    ...population.filter((p) => p.segment_id === segmentId).map((p) => slotIndex(p.id)),
  ]);
  let index = 0;
  while (used.has(index)) index++;
  const seed = addedSeed(audience.seed, segment.id, index);
  const job = { id: personaId(segment.id, index), segment, seed, traits: sampleTraits(segment, audience, seed) };
  const { personas, cost_usd } = await writePersonas([job], takenNames(population), deps);
  return { persona: personas[0], cost_usd };
}
