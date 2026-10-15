import { fnv1a, mulberry32 } from '../audience/sample.ts';
import type { AttributeSamplingRule, AttributeValue, PersonaSchema } from '../types.ts';
import { getPersonaSchema, validatePersonaSchema } from './schema.ts';

function draw(rule: AttributeSamplingRule, u: number): AttributeValue {
  if (rule.kind === 'fixed') return Array.isArray(rule.value) ? [...rule.value] : rule.value;
  if (rule.kind === 'range') return rule.integer ? rule.min + Math.floor(u * (rule.max - rule.min + 1)) : rule.min + u * (rule.max - rule.min);
  const largest = Math.max(...rule.choices.map((c) => c.weight));
  const positive = rule.choices.filter((c) => c.weight > 0).sort((a, b) => String(a.value) < String(b.value) ? -1 : String(a.value) > String(b.value) ? 1 : 0);
  let remaining = u * positive.reduce((sum, c) => sum + c.weight / largest, 0);
  for (const choice of positive) if ((remaining -= choice.weight / largest) < 0) return choice.value;
  return positive.at(-1)!.value;
}

/** Each attribute has its own deterministic stream; schema order and unrelated rules cannot move its draw. */
export function sampleProfile(schema: PersonaSchema | undefined, segmentId: string, seed: number): Record<string, AttributeValue> {
  const effective = getPersonaSchema(schema);
  validatePersonaSchema(effective);
  return Object.fromEntries(effective.attributes.filter((a) => a.enabled && a.sampling !== null).map((attribute) => {
    const rule = attribute.sampling!.by_segment[segmentId] ?? attribute.sampling!.default;
    return [attribute.id, draw(rule, mulberry32(fnv1a(`profile/${seed}/${segmentId}/${attribute.id}`))())];
  }));
}
