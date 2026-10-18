import { z } from 'zod';
import { personaEnvironment } from '../audience/locations.ts';
import type { AttributeSamplingRule, AttributeValue, Persona, PersonaSchema, ProfileAttribute, ProfileGroup } from '../types.ts';

export type ProfilePurpose = 'card' | 'prompt' | 'report' | 'all';
const CORE = new Set(['name', 'country', 'timezone', 'languages', 'device', 'tech_skill', 'patience', 'goal_interpretation', 'voice', 'background', 'seed']);
const SOURCE_IDS = new Set(['name', 'pronouns', 'country', 'city', 'timezone', 'languages', 'language', 'job_title', 'employer', 'seniority', 'company_size', 'industry', 'tech_skill', 'patience', 'familiarity_with_category', 'device', 'accessibility_needs', 'context_of_use', 'motivation', 'goal_interpretation', 'voice', 'background', 'seed']);
const RESERVED = new Set(['id', 'segment_id', 'attributes', 'profile_signature', '__proto__', 'constructor', 'prototype']);
const DIMENSIONS = new Set(['country', 'device', 'tech_skill', 'patience', 'employer', 'seniority', 'decision_role', 'accessibility_needs']);

const fixed = (value: AttributeValue): AttributeSamplingRule => ({ kind: 'fixed', value });
const range = (min: number, max: number): AttributeSamplingRule => ({ kind: 'range', min, max, integer: true });
const choices = (values: string[], weights: number[] = values.map(() => 1)): AttributeSamplingRule => ({ kind: 'choices', choices: values.map((value, i) => ({ value, weight: weights[i] })) });
function attribute(id: string, name: string, group: ProfileGroup, type: ProfileAttribute['type'], description: string, values?: string[], rule?: AttributeSamplingRule): ProfileAttribute {
  return { id, name, group, type, description, core: CORE.has(id), enabled: true, show_on_card: id !== 'seed' && id !== 'language', use_in_prompt: true, report_dimension: DIMENSIONS.has(id), ...(values ? { choices: values } : {}), sampling: rule ? { default: rule, by_segment: {} } : null };
}

/** The shipped template: defaults are starting assumptions, not population measurements. */
export const DEFAULT_PERSONA_SCHEMA: PersonaSchema = {
  version: 1,
  attributes: [
    attribute('name', 'Name', 'identity', 'text', 'The person’s full name.'),
    attribute('age_range', 'Age range', 'identity', 'choice', 'Life stage; never a reason to assume ability or attitude.', ['18–24', '25–34', '35–44', '45–54', '55–64', '65+'], choices(['18–24', '25–34', '35–44', '45–54', '55–64', '65+'], [1, 3, 3, 2, 1, 0.3])),
    attribute('pronouns', 'Pronouns', 'identity', 'choice', 'The pronouns used for this person.', ['she', 'he', 'they']),
    attribute('country', 'Country', 'identity', 'text', 'The ISO country where the person lives; shapes familiar formats and conventions.'),
    attribute('city', 'City', 'identity', 'text', 'The city where the person lives.'),
    attribute('timezone', 'Timezone', 'identity', 'text', 'The IANA timezone used by their browser.'),
    attribute('languages', 'Languages', 'identity', 'list', 'Ordered language preferences; the first is used for thinking aloud and the browser locale.'),
    attribute('language', 'First language (legacy)', 'identity', 'text', 'The first-language value retained for older saved profiles.'),
    attribute('education', 'Education', 'identity', 'choice', 'Education and training history; not a proxy for competence.', ['vocational training', 'undergraduate degree', 'postgraduate degree', 'workplace learning'], choices(['vocational training', 'undergraduate degree', 'postgraduate degree', 'workplace learning'], [2, 4, 1, 3])),
    attribute('job_title', 'Job title', 'work', 'text', 'The person’s job title.'),
    attribute('employer', 'Employer', 'work', 'text', 'The organisation they work for.'),
    attribute('employment_type', 'Employment type', 'work', 'choice', 'How their work is contracted.', ['in-house', 'agency or contractor', 'freelance'], choices(['in-house', 'agency or contractor', 'freelance'], [7, 2, 1])),
    attribute('seniority', 'Seniority', 'work', 'choice', 'Their level of responsibility.', ['junior', 'mid', 'senior', 'lead']),
    attribute('years_in_role', 'Years in role', 'work', 'number', 'Years working in this role.', undefined, range(1, 8)),
    attribute('team_size', 'Team size', 'work', 'number', 'People they work with directly.', undefined, range(2, 15)),
    attribute('company_size', 'Company size', 'work', 'number', 'Number of employees at their organisation.'),
    attribute('industry', 'Industry', 'work', 'text', 'The employer’s line of work.'),
    attribute('decision_role', 'Decision role', 'work', 'choice', 'Whether they use, influence, approve or fund a software purchase.', ['user', 'influencer', 'approver', 'budget holder'], choices(['user', 'influencer', 'approver', 'budget holder'], [6, 2, 1, 1])),
    attribute('tools_today', 'Tools used today', 'work', 'list', 'Tools used for the job today, separate from category experience.', undefined, fixed(['Email', 'Spreadsheets', 'Team chat'])),
    attribute('tech_skill', 'Tech skill', 'capability', 'number', 'Technical confidence from 1 (low) to 5 (high).'),
    attribute('patience', 'Patience', 'capability', 'number', 'Tolerance for friction from 1 (low) to 5 (high); determines the step budget.'),
    attribute('reading_speed', 'Reading speed', 'capability', 'choice', 'How quickly they tend to read unfamiliar product text.', ['careful', 'average', 'quick'], choices(['careful', 'average', 'quick'], [2, 6, 2])),
    attribute('familiarity_with_category', 'Category familiarity', 'capability', 'choice', 'Experience with this product category.', ['low', 'medium', 'high']),
    attribute('prior_tools', 'Prior tools', 'capability', 'list', 'Previous category tools, with a short note about what worked or frustrated them. Empty means none specified.', undefined, fixed([])),
    attribute('device', 'Device', 'context', 'choice', 'The device used for this session.', ['desktop', 'mobile']),
    attribute('accessibility_needs', 'Accessibility needs', 'context', 'choice', 'The practical access needs affecting this session.', ['none', 'low_vision', 'colour_blind', 'screen_reader', 'motor']),
    attribute('context_of_use', 'Context of use', 'context', 'text', 'When and where the person meets the product this time.'),
    attribute('working_pattern', 'Working pattern', 'context', 'choice', 'Where and when they usually work.', ['office', 'hybrid', 'remote', 'shifts'], choices(['office', 'hybrid', 'remote', 'shifts'], [3, 4, 2, 1])),
    attribute('connectivity', 'Connectivity', 'context', 'choice', 'The quality of their connection in this session.', ['fast', 'flaky', 'mobile data'], choices(['fast', 'flaky', 'mobile data'], [7, 1, 2])),
    attribute('motivation', 'Motivation', 'psychology', 'number', 'Motivation to complete the task, from 1 to 5.'),
    ...['risk_appetite', 'openness_to_new_tools', 'trust_in_vendors', 'price_sensitivity', 'posting_propensity'].map((id) => attribute(id, id.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase()), 'psychology', 'number', 'A mild tendency from 1 (low) to 5 (high); keep behavior grounded.', undefined, range(2, 4))),
    attribute('goal_interpretation', 'Goal interpretation', 'intent', 'text', 'What this person thinks the task asks of them.'),
    attribute('what_good_looks_like', 'What good looks like', 'intent', 'text', 'What would make this person consider the product successful.', undefined, fixed('Finish the task confidently without unnecessary work.')),
    attribute('voice', 'Voice', 'voice', 'text', 'How the person thinks and writes.'),
    attribute('voice_formality', 'Voice formality', 'voice', 'choice', 'How formal their natural language is.', ['casual', 'plain', 'formal'], choices(['casual', 'plain', 'formal'], [2, 6, 2])),
    attribute('voice_length', 'Typical length', 'voice', 'choice', 'How much they usually say.', ['brief', 'balanced', 'detailed'], choices(['brief', 'balanced', 'detailed'], [3, 5, 2])),
    attribute('voice_phrases', 'Typical phrases', 'voice', 'list', 'Optional phrases this person naturally uses; do not force repetition.', undefined, fixed([])),
    attribute('background', 'Biography', 'biography', 'text', 'A first-person biography grounded only in the active prompt attributes.'),
    attribute('seed', 'Seed', 'identity', 'number', 'The seed fixing sampled traits; this is metadata, not a personality trait.'),
  ],
};

const text = z.string().max(4000);
const number = z.number().finite().min(-1e12).max(1e12);
const value = z.union([text, number, z.boolean(), z.array(z.string().max(500)).max(32)]);
const rule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), value }).strict(),
  z.object({ kind: z.literal('range'), min: number, max: number, integer: z.boolean() }).strict(),
  z.object({ kind: z.literal('choices'), choices: z.array(z.object({ value: z.union([z.string().min(1).max(500), z.boolean()]), weight: z.number().finite().nonnegative() }).strict()).min(1).max(64) }).strict(),
]);
const structure = z.object({ version: z.literal(1), attributes: z.array(z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(1000), group: z.enum(['identity', 'work', 'capability', 'context', 'psychology', 'intent', 'voice', 'biography']),
  type: z.enum(['text', 'number', 'choice', 'boolean', 'list']), core: z.boolean(), enabled: z.boolean(), show_on_card: z.boolean(), use_in_prompt: z.boolean(), report_dimension: z.boolean(),
  choices: z.array(z.string().min(1).max(500)).min(1).max(64).optional(),
  sampling: z.object({ default: rule, by_segment: z.record(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/), rule) }).strict().nullable(),
}).strict()).min(CORE.size).max(96) }).strict();

function jsonObject(input: unknown): void {
  const seen = new Set<object>();
  let nodes = 0;
  const visit = (item: unknown, depth: number) => {
    if (++nodes > 12000 || depth > 10) throw new Error('Profile schema exceeds the size limit.');
    if (item === null || typeof item !== 'object') return;
    if (seen.has(item)) throw new Error('Profile schema must not contain cycles or shared objects.');
    seen.add(item);
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw new Error('Profile schema must contain plain JSON objects.');
    for (const key of Object.keys(item)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error(`Reserved profile schema key: ${key}`);
      if (Object.getOwnPropertyDescriptor(item, key)?.get) throw new Error('Profile schema cannot contain accessors.');
      visit((item as Record<string, unknown>)[key], depth + 1);
    }
    seen.delete(item);
  };
  visit(input, 0);
}

function matches(value: AttributeValue, attribute: ProfileAttribute): boolean {
  switch (attribute.type) {
    case 'text': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'list': return Array.isArray(value) && value.every((v) => typeof v === 'string');
    case 'choice': return typeof value === 'string' && (attribute.choices?.includes(value) ?? false);
  }
}

export function validatePersonaSchema(schema: unknown): asserts schema is PersonaSchema {
  jsonObject(schema);
  const parsed = structure.safeParse(schema);
  if (!parsed.success) throw new Error(`Invalid profile schema: ${parsed.error.issues[0]?.message}`);
  const attributes = parsed.data.attributes as ProfileAttribute[];
  const ids = new Set<string>();
  for (const attr of attributes) {
    if (ids.has(attr.id) || RESERVED.has(attr.id)) throw new Error(`Duplicate or reserved profile attribute: ${attr.id}`);
    ids.add(attr.id);
    const builtin = DEFAULT_PERSONA_SCHEMA.attributes.find((a) => a.id === attr.id);
    if (builtin && (attr.type !== builtin.type || attr.group !== builtin.group || attr.core !== builtin.core || JSON.stringify(attr.choices) !== JSON.stringify(builtin.choices))) throw new Error(`The built-in identity of profile attribute ${attr.id} cannot change.`);
    if ((!builtin && attr.core) || (CORE.has(attr.id) && (!attr.enabled || !attr.use_in_prompt))) throw new Error(`Core profile attribute ${attr.id} must remain enabled for prompts.`);
    if (SOURCE_IDS.has(attr.id) && attr.sampling !== null) throw new Error(`Profile attribute ${attr.id} retains its built-in sampling source.`);
    if (!SOURCE_IDS.has(attr.id) && !attr.sampling) throw new Error(`Profile attribute ${attr.id} needs a sampling rule.`);
    if (attr.type === 'choice' ? !attr.choices || new Set(attr.choices).size !== attr.choices.length : attr.choices !== undefined) throw new Error(`Invalid choices for profile attribute ${attr.id}.`);
    if (!attr.sampling) continue;
    if (Object.keys(attr.sampling.by_segment).length > 200) throw new Error(`Too many segment rules for profile attribute ${attr.id}.`);
    for (const sampling of [attr.sampling.default, ...Object.values(attr.sampling.by_segment)]) {
      if (sampling.kind === 'fixed' && !matches(sampling.value, attr)) throw new Error(`Fixed value does not match profile attribute ${attr.id}.`);
      if (sampling.kind === 'range' && (attr.type !== 'number' || sampling.min > sampling.max || (sampling.integer && (!Number.isSafeInteger(sampling.min) || !Number.isSafeInteger(sampling.max))))) throw new Error(`Invalid range for profile attribute ${attr.id}.`);
      if (sampling.kind === 'choices' && (new Set(sampling.choices.map((c) => c.value)).size !== sampling.choices.length || !sampling.choices.some((c) => c.weight > 0) || !sampling.choices.every((c) => matches(c.value, attr)))) throw new Error(`Invalid weighted choices for profile attribute ${attr.id}.`);
    }
  }
  for (const id of CORE) if (!ids.has(id)) throw new Error(`Core profile attribute ${id} is missing.`);
}

export function getPersonaSchema(schema?: PersonaSchema): PersonaSchema {
  return structuredClone(schema ?? DEFAULT_PERSONA_SCHEMA);
}

export function isAttributeEnabled(schema: PersonaSchema | undefined, id: string, purpose: ProfilePurpose = 'all'): boolean {
  const attr = (schema ?? DEFAULT_PERSONA_SCHEMA).attributes.find((a) => a.id === id);
  return !!attr?.enabled && (purpose === 'all' || attr[purpose === 'card' ? 'show_on_card' : purpose === 'prompt' ? 'use_in_prompt' : 'report_dimension']);
}

export function attributeValue(persona: Persona, attribute: ProfileAttribute): AttributeValue | undefined {
  if (attribute.id === 'languages') return personaEnvironment(persona).languages;
  if (attribute.id === 'language') return personaEnvironment(persona).locale;
  if (attribute.id === 'timezone') return personaEnvironment(persona).timezone;
  if (SOURCE_IDS.has(attribute.id)) return (persona as unknown as Record<string, AttributeValue | undefined>)[attribute.id];
  return Object.hasOwn(persona.attributes ?? {}, attribute.id) ? persona.attributes?.[attribute.id] : undefined;
}

export function profileEntries(persona: Persona, schema?: PersonaSchema, purpose: ProfilePurpose = 'card'): { attribute: ProfileAttribute; value: AttributeValue }[] {
  return (schema ?? DEFAULT_PERSONA_SCHEMA).attributes.flatMap((attribute) => {
    const value = attributeValue(persona, attribute);
    return isAttributeEnabled(schema, attribute.id, purpose) && value !== undefined ? [{ attribute, value }] : [];
  });
}
