import { addedSeed, fnv1a, GENERATION, sameTraits, sampleTraits, slotIndex, slotSeed } from '../audience/sample.ts';
import type { Persona, ProjectConfig, Segment } from '../types.ts';
import { sampleProfile } from './sample.ts';
import { getPersonaSchema, profileEntries } from './schema.ts';

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Identity of model-visible writer inputs, not an authenticity check. Browser-safe so editors can hide stale prose. */
export function profileSignature(project: ProjectConfig, segment: Segment, seed: number): string {
  if (!project.audience) throw new Error('An audience is required to check a generated profile.');
  const schema = getPersonaSchema(project.persona_schema);
  const traits = { ...sampleTraits(segment, project.audience, seed), attributes: sampleProfile(schema, segment.id, seed), seed };
  const visible = profileEntries(traits as Persona, schema, 'prompt');
  // Only what the writer reads: a segment with no digest adds nothing here, so its personas stay current, and an analytics file's name changes no prose.
  const { facts = [], remarks = [] } = segment.grounding ?? {};
  const promptSchema = schema.attributes.filter((a) => a.enabled && a.use_in_prompt).map(({ id, name, type, group, description }) => ({ id, name, type, group, description })).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const input = stable({
    version: 1, seed, schema: promptSchema, traits: Object.fromEntries(visible.map(({ attribute, value }) => [attribute.id, value])),
    product: { name: project.name, description: project.description, goal: segment.goal_override ?? project.goal },
    segment: { id: segment.id, name: segment.name, description: segment.description, usage_frequency: segment.usage_frequency, entry: segment.entry, account_state: segment.account_state, typical_goals: segment.typical_goals, grounding: facts.length || remarks.length ? { facts, remarks } : undefined },
  });
  return `p1-${fnv1a(input).toString(16).padStart(8, '0')}${fnv1a(`profile-input/${input}`).toString(16).padStart(8, '0')}-${input.length}`;
}

export function personaProfileIsCurrent(persona: Persona, project: ProjectConfig): boolean {
  if (!persona.profile_signature) return project.persona_schema === undefined;
  const segment = project.audience?.segments.find((s) => s.id === persona.segment_id);
  if (!segment || !project.audience) return false;
  try {
    const index = slotIndex(persona.id);
    const base = persona.seed % GENERATION;
    if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(persona.seed) || persona.seed < 0 ||
      (base !== slotSeed(project.audience.seed, segment.id, index) && base !== addedSeed(project.audience.seed, segment.id, index))) return false;
    const expected = { ...sampleTraits(segment, project.audience, persona.seed), attributes: sampleProfile(project.persona_schema, segment.id, persona.seed) };
    return sameTraits(persona, expected) && persona.profile_signature === profileSignature(project, segment, persona.seed);
  } catch {
    // A form draft may temporarily have an empty choice or invalid range. It cannot describe current prose.
    return false;
  }
}
