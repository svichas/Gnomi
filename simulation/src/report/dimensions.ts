import { profileEntries } from '../profile/schema.ts';
import { isUnrated, type AttributeValue, type Persona, type PersonaSchema, type ProfileAttribute, type ReportDimension, type ReportDriver, type ReportPersona, type ReportReach, type ReportTheme } from '../types.ts';

/** Personas who must hold a value and have reached a theme's pages before it can show as a driver. */
export const DRIVER_HOLDERS = 5;
/** Of those, how many must have met the theme first-hand. */
export const DRIVER_AFFECTED = 2;
/** The least difference between their rate and the others'. */
export const DRIVER_GAP = 0.25;
/** Drivers shown per theme. */
export const DRIVER_MAX = 2;

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

/** Personas counts everyone with this exact value; rates use the rated ones (as the segment table does) and the report's friction rule; sentiment excludes personas without a step. */
export function buildDimensions(population: Persona[], personas: ReportPersona[], latestFeeling: Map<string, number>, schema: PersonaSchema, withFriction: Set<string>): ReportDimension[] {
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  return groupProfiles(population, schema).map(({ attribute, values }) => ({
    id: attribute.id,
    name: attribute.name,
    type: attribute.type,
    values: values.map(({ value, personaIds }) => {
      const members = personaIds.flatMap((id) => byId.has(id) ? [byId.get(id)!] : []);
      const feelings = personaIds.flatMap((id) => latestFeeling.has(id) ? [latestFeeling.get(id)!] : []);
      const started = members.filter((member) => !isUnrated(member.outcome));
      return {
        value,
        personas: members.length,
        completion: started.length ? started.filter((member) => member.outcome === 'done').length / started.length : null,
        with_friction: started.length ? started.filter((member) => withFriction.has(member.id)).length / started.length : null,
        sentiment: feelings.length ? feelings.reduce((sum, feeling) => sum + feeling, 0) / feelings.length : null,
      };
    }),
  }));
}

/**
 * The profile values more common among a theme's first-hand personas, by the groups the report already uses, so a number is its exact
 * value. It compares those who reached the theme as its share counts them: any of its pages, or for a theme with no pages who started
 * the POI and answered a survey there, as in report/diff.ts (`surveyed` are all in `started`). A persona the run never started or the
 * model never answered is left out, as in every rate. Counts only, with no test of significance: connected personas are not independent.
 * Objections are skipped: only buyers are asked them, and reach does not say who the buyers are, so the rates would count personas never asked.
 * shortcut: a buyer also counts as surveyed for a theme of users' survey answers, though it answered another survey; use buyer reach if that misleads.
 */
export function themeDrivers(theme: ReportTheme, dimensions: ReportDimension[], personas: ReportPersona[], reach: ReportReach[]): ReportDriver[] {
  const spot = reach.find(({ poi_id }) => poi_id === theme.poi_id);
  if (!spot || !theme.first_hand || theme.category === 'objection') return [];
  const hit = new Set(theme.first_hand);
  const reached = new Set([...(theme.pages.length ? theme.pages.flatMap((page) => spot.pages[page] ?? []) : spot.surveyed), ...hit]);
  const exposed = personas.filter((persona) => reached.has(persona.id) && !isUnrated(persona.pois?.[theme.poi_id] ?? persona.outcome));
  const counted = (group: ReportPersona[]) => ({ affected: group.filter((persona) => hit.has(persona.id)).length, reached: group.length });
  return dimensions.flatMap(({ id, name, values }) => values.flatMap(({ value }): ReportDriver[] => {
    const key = attributeKey(value);
    const holds = ({ attributes }: ReportPersona) => attributes?.[id] !== undefined && attributeKey(attributes[id]) === key;
    const [holders, others] = [counted(exposed.filter(holds)), counted(exposed.filter((persona) => !holds(persona)))];
    if (holders.reached < DRIVER_HOLDERS || holders.affected < DRIVER_AFFECTED || others.reached === 0) return []; // a value everyone holds has nothing to compare with
    const gap = Math.round((holders.affected / holders.reached - others.affected / others.reached) * 1e4) / 1e4;
    return gap >= DRIVER_GAP ? [{ id, name, value, holders, others, gap }] : [];
  })).sort((a, b) => b.gap - a.gap).slice(0, DRIVER_MAX);
}
