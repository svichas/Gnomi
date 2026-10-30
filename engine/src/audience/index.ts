import type { LlmAttempt, LlmGateway, LlmRequest } from '@gnomi/simulation/seams.ts';
import type { Audience, ModelChoice, Persona, ProjectConfig, Segment } from '@gnomi/simulation/types.ts';
import { defaultAudience } from './defaults.ts';
import { PROPOSE_SYSTEM, proposalSchema, proposeUser, toSegments, type Proposal } from './propose.ts';
import { addedSeed, apportion, GENERATION, personaId, sameTraits, sampleTraits, slotIndex, slotSeed } from '@gnomi/simulation/audience/sample.ts';
import { nameKey, writePersonas } from './write.ts';
import { validateAudienceCountries } from '@gnomi/simulation/audience/locations.ts';
import { sampleProfile } from '@gnomi/simulation/profile/sample.ts';
import { profileSignature } from '@gnomi/simulation/profile/signature.ts';

export { defaultAudience };
export { diversityReport } from './diversity.ts';
export { DEMO_PERSONA_WRITER } from './demo.ts';

// The audience builder (idea.md §8, tech.md §2.4): traits are sampled in code from seeded distributions first,
// and only then written up by the persona_writer model, so diversity comes from sampling, not from asking.

export interface AudienceDeps {
  llm: LlmGateway;
  model: ModelChoice; // the persona_writer route
  project: ProjectConfig;
  roles?: string[]; // recorded login names a proposed segment may use; defaults to project.role
  onProgress?(done: number, total: number, persona?: Persona): void; // persona: the one just written
  onSketched?(sketched: number): void;
  onStage?(stage: 'sketching' | 'repairing_names' | 'writing'): void;
  onAttempt?(request: LlmRequest<unknown>, attempt: LlmAttempt): void;
  cache?: { get(key: string): unknown; set(key: string, value: unknown): void };
  signal?: AbortSignal;
}

const PREFERRED_MIN_PER_SEGMENT = 3;
export const MAX_PERSONAS = 200;

/** Proposes segments from the product sentence, the POI and the goal (idea.md §5.1 step 3). */
export async function proposeAudience(deps: AudienceDeps): Promise<{ audience: Audience; cost_usd: number }> {
  const roles = deps.roles ?? (deps.project.role ? [deps.project.role] : []);
  try {
    const request: LlmRequest<Proposal> = {
      role: 'persona_writer',
      model: deps.model,
      run_id: null,
      persona_id: null,
      round: 0,
      purpose: 'propose_audience',
      system: PROPOSE_SYSTEM,
      user: [{ type: 'text', text: proposeUser(deps.project, roles) }],
      schema: proposalSchema(roles),
      max_output_tokens: 4096,
      timeout_ms: 120_000,
      onAttempt: (attempt) => deps.onAttempt?.(request, attempt),
      signal: deps.signal,
    };
    const { object, cost_usd } = await deps.llm.call(request);
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

/** Split persona_count by share, lowering the per-segment minimum for small runs; hand-added personas remain extra. */
function layout(audience: Audience, population: Persona[]): { segment: Segment; slots: Slot[] }[] {
  validateAudienceCountries(audience);
  const count = audience.persona_count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_PERSONAS) throw new Error(`persona_count must be a whole number from 1 to ${MAX_PERSONAS}`);
  const shares = audience.segments.map((s) => s.share);
  const activeSegments = shares.filter((share) => share > 0).length;
  const minimum = Math.min(PREFERRED_MIN_PER_SEGMENT, Math.floor(count / Math.max(1, activeSegments)));
  const counts = apportion(shares, count, minimum);
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

const traitsAt = (project: ProjectConfig, audience: Audience, segment: Segment, seed: number) =>
  ({ ...sampleTraits(segment, audience, seed), attributes: sampleProfile(project.persona_schema, segment.id, seed) });

function segmentOf(audience: Audience, segmentId: string | null): Segment {
  const segment = audience.segments.find((s) => s.id === segmentId);
  if (!segment) throw new Error(`The audience has no segment ${JSON.stringify(segmentId)}`);
  return segment;
}

/** Every slot the audience has, with what it holds now and what it should hold. */
const plannedSlots = (project: ProjectConfig & { audience: Audience }, existing: Persona[]) =>
  layout(project.audience, existing).flatMap(({ segment, slots }) =>
    slots.map((slot) => ({ ...slot, segment, traits: traitsAt(project, project.audience, segment, slot.seed), signature: profileSignature(project, segment, slot.seed) })),
  );

// Presentation/report flags and private values do not change prose, so a matching signature keeps the persona.
const keeps = (slot: ReturnType<typeof plannedSlots>[number]) => slot.old?.profile_signature === slot.signature;

/** How many personas syncPersonas would write now, with no model call. A changed share counts, through the slots it adds. */
export const personasToWrite = (project: ProjectConfig & { audience: Audience }, existing: Persona[]) => plannedSlots(project, existing).filter((slot) => !keeps(slot)).length;

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
  const project = { ...deps.project, audience };
  const slots = plannedSlots(project, existing);
  // Kept prose gets the sampled stored values refreshed.
  const kept = slots.filter(keeps).map((s) => sameTraits(s.old!, s.traits) ? s.old! : { ...s.old!, ...s.traits });
  const written = await writePersonas(slots.filter((s) => !keeps(s)), takenNames(kept), { ...deps, project });
  const byId = new Map([...kept, ...written.personas].map((p) => [p.id, p]));
  return { personas: slots.map((s) => byId.get(s.id)!), cost_usd: written.cost_usd };
}

/** Samples and writes one persona; others hold the names it must not take. */
async function writeOne(id: string, segment: Segment, seed: number, audience: Audience, others: Persona[], deps: AudienceDeps): Promise<{ persona: Persona; cost_usd: number }> {
  const project = { ...deps.project, audience };
  const { personas, cost_usd } = await writePersonas([{ id, segment, seed, traits: traitsAt(project, audience, segment, seed) }], takenNames(others), { ...deps, project });
  return { persona: personas[0], cost_usd };
}

/** A new seed for one persona: traits re-sampled and re-written, its id kept. */
export async function regeneratePersona(
  persona: Persona,
  audience: Audience,
  population: Persona[],
  deps: AudienceDeps,
): Promise<{ persona: Persona; cost_usd: number }> {
  const segment = segmentOf(audience, persona.segment_id);
  return writeOne(persona.id, segment, persona.seed + GENERATION, audience, population.filter((p) => p.id !== persona.id), deps);
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
  return writeOne(personaId(segment.id, index), segment, addedSeed(audience.seed, segment.id, index), audience, population, deps);
}
