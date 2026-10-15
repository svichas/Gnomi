import { countryName } from '@gnomi/engine/audience/locations.ts';
import { getPersonaSchema, validatePersonaSchema } from '@gnomi/engine/profile/schema.ts';
import type { AttributeSamplingRule, AttributeValue, PersonaSchema, ProfileAttribute, ProfileGroup } from '@gnomi/engine/types.ts';

export const PROFILE_GROUPS: Record<ProfileGroup, string> = {
  identity: 'Identity', work: 'Work', capability: 'Capability', context: 'Context', psychology: 'Psychology', intent: 'Intent', voice: 'Voice', biography: 'Biography',
};
export const ATTRIBUTE_TYPES: Record<ProfileAttribute['type'], string> = { text: 'Text', number: 'Number', choice: 'Choice', boolean: 'Yes / no', list: 'List of text' };
export const NARRATIVE_FIELDS = new Set(['background', 'context_of_use', 'goal_interpretation', 'voice']);
export const STALE_PROFILE_FIELDS = new Set([...NARRATIVE_FIELDS, 'job_title', 'industry']);
const RESERVED_IDS = new Set([...getPersonaSchema().attributes.map((attribute) => attribute.id), 'id', 'segment_id', 'attributes', 'profile_signature', 'constructor', 'prototype', '__proto__']);

export function defaultRule(type: ProfileAttribute['type'], choices = ['Option A', 'Option B']): AttributeSamplingRule {
  if (type === 'number') return { kind: 'range', min: 1, max: 5, integer: true };
  if (type === 'choice') return { kind: 'choices', choices: choices.map((value) => ({ value, weight: 1 })) };
  if (type === 'boolean') return { kind: 'choices', choices: [{ value: true, weight: 50 }, { value: false, weight: 50 }] };
  return { kind: 'fixed', value: type === 'list' ? [] : '' };
}

export function customAttribute(schema: PersonaSchema, name: string, type: ProfileAttribute['type']): ProfileAttribute {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const prefix = (/^[a-z]/.test(base) ? base : `custom_${base || 'attribute'}`).slice(0, 58);
  let id = prefix;
  for (let suffix = 2; schema.attributes.some((attribute) => attribute.id === id) || RESERVED_IDS.has(id); suffix++) id = `${prefix}_${suffix}`;
  return {
    id, name: name.trim(), group: 'work', type, description: `How ${name.trim().toLowerCase()} affects this person's use of the product.`,
    core: false, enabled: true, show_on_card: true, use_in_prompt: true, report_dimension: false,
    ...(type === 'choice' ? { choices: ['Option A', 'Option B'] } : {}),
    sampling: { default: defaultRule(type), by_segment: {} },
  };
}

export const choiceValues = (text: string) => [...new Set(text.split('\n').map((value) => value.trim()).filter(Boolean))];

export function setSegmentRule(attribute: ProfileAttribute, segment: string, rule: AttributeSamplingRule | null): ProfileAttribute {
  if (!attribute.sampling) return attribute;
  const by_segment = { ...attribute.sampling.by_segment };
  if (rule === null) delete by_segment[segment];
  else by_segment[segment] = structuredClone(rule);
  return { ...attribute, sampling: { ...attribute.sampling, by_segment } };
}

export function setAttributeChoices(attribute: ProfileAttribute, choices: string[]): ProfileAttribute {
  const update = (rule: AttributeSamplingRule): AttributeSamplingRule => rule.kind === 'choices'
    ? { kind: 'choices', choices: choices.map((value) => ({ value, weight: rule.choices.find((entry) => entry.value === value)?.weight ?? 1 })) }
    : { kind: 'fixed', value: rule.kind === 'fixed' && typeof rule.value === 'string' && choices.includes(rule.value) ? rule.value : choices[0] ?? '' };
  return {
    ...attribute, choices,
    sampling: attribute.sampling && { default: update(attribute.sampling.default), by_segment: Object.fromEntries(Object.entries(attribute.sampling.by_segment).map(([id, rule]) => [id, update(rule)])) },
  };
}

export function formatAttribute(attribute: Pick<ProfileAttribute, 'id'>, value: AttributeValue): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ') || 'None specified';
  if (attribute.id === 'country' && typeof value === 'string') return countryName(value);
  if (attribute.id === 'language' && typeof value === 'string') {
    try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(value) ?? value; } catch { return value; }
  }
  return (attribute.id === 'accessibility_needs' ? String(value).replaceAll('_', ' ') : String(value)) || 'Not specified';
}

export function profileProblem(schema: PersonaSchema | undefined): string | null {
  if (!schema) return null;
  try { validatePersonaSchema(schema); return null; } catch (err) { return err instanceof Error ? err.message : String(err); }
}

export function parseProfileTemplate(text: string): PersonaSchema {
  const loaded: unknown = JSON.parse(text);
  validatePersonaSchema(loaded);
  return loaded;
}

export function serializeProfileTemplate(schema: PersonaSchema): string {
  validatePersonaSchema(schema);
  return JSON.stringify(schema, null, 2);
}
