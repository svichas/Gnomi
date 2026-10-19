import { profileEntries } from '../profile/schema.ts';
import type { AttributeValue, Persona, PersonaSchema, ProfileAttribute, ReportDimension, ReportPersona } from '../types.ts';

/** A typed key: false, 0 and lists must never collapse into a missing value or a text value. */
export const attributeKey = (value: AttributeValue): string => JSON.stringify(value);
export const formatAttributeValue = (value: AttributeValue): string => Array.isArray(value) ? value.join(', ') || '(empty list)' : String(value);

export interface ProfileGroups {
  attribute: ProfileAttribute;
  values: { value: AttributeValue; personaIds: string[] }[];
}

/** Only the run's enabled report dimensions; lists group by the entire ordered list. */
export function groupProfiles(personas: Persona[], schema?: PersonaSchema): ProfileGroups[] {
  const dimensions = new Map<string, { attribute: ProfileAttribute; values: Map<string, { value: AttributeValue; personaIds: string[] }> }>();
  for (const persona of personas) {
    for (const { attribute, value } of profileEntries(persona, schema, 'report')) {
      let dimension = dimensions.get(attribute.id);
      if (!dimension) {
        dimension = { attribute, values: new Map() };
        dimensions.set(attribute.id, dimension);
      }
      const key = attributeKey(value);
      const group = dimension.values.get(key);
      if (group) group.personaIds.push(persona.id);
      else dimension.values.set(key, { value: structuredClone(value), personaIds: [persona.id] });
    }
  }
  return [...dimensions.values()].map(({ attribute, values }) => ({
    attribute,
    values: [...values.values()].sort((a, b) => {
      if (typeof a.value === 'number' && typeof b.value === 'number') return a.value - b.value;
      const left = attributeKey(a.value);
      const right = attributeKey(b.value);
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  }));
}

export function reportAttributes(persona: Persona, schema: PersonaSchema): Record<string, AttributeValue> {
  return Object.fromEntries(profileEntries(persona, schema, 'report').map(({ attribute, value }) => [attribute.id, structuredClone(value)]));
}

/** Rates use the started personas with this exact value and the report's friction rule; sentiment excludes personas without a step. */
export function buildDimensions(population: Persona[], personas: ReportPersona[], latestFeeling: Map<string, number>, schema: PersonaSchema, withFriction: Set<string>): ReportDimension[] {
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  return groupProfiles(population, schema).map(({ attribute, values }) => ({
    id: attribute.id,
    name: attribute.name,
    type: attribute.type,
    values: values.map(({ value, personaIds }) => {
      const members = personaIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
      const feelings = personaIds.flatMap((id) => latestFeeling.has(id) ? [latestFeeling.get(id)!] : []);
      const started = members.filter((member) => member.outcome !== 'not_started');
      return {
        value,
        personas: members.length,
        completion: started.length ? started.filter((member) => member.outcome === 'done').length / started.length : 0,
        with_friction: started.length ? started.filter((member) => withFriction.has(member.id)).length / started.length : 0,
        sentiment: feelings.length ? feelings.reduce((sum, feeling) => sum + feeling, 0) / feelings.length : null,
      };
    }),
  }));
}
