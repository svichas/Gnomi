import { isAttributeEnabled, profileEntries } from '@gnomi/engine/profile/schema.ts';
import type { Persona, PersonaSchema } from '@gnomi/engine/types.ts';
import { formatAttribute, NARRATIVE_FIELDS, STALE_PROFILE_FIELDS } from './profile.ts';

export const personaLabel = (persona: Persona, schema?: PersonaSchema) => isAttributeEnabled(schema, 'name', 'card') ? persona.name : `Persona ${persona.id}`;

/** The schema decides visibility consistently in cards and the run inspector. */
export function ProfileFields({ persona, schema, only, except = [], stale = false, purpose = 'card' }: { persona: Persona; schema?: PersonaSchema; only?: string[]; except?: string[]; stale?: boolean; purpose?: 'card' | 'all' }) {
  const entries = profileEntries(persona, schema, purpose).filter(({ attribute }) => (!only || only.includes(attribute.id)) && !except.includes(attribute.id) && !(stale && STALE_PROFILE_FIELDS.has(attribute.id)));
  if (!entries.length) return null;
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3">{entries.map(({ attribute, value }) => <div key={attribute.id} className={attribute.type === 'text' && (String(value).length > 60 || NARRATIVE_FIELDS.has(attribute.id)) || attribute.type === 'list' ? 'col-span-2 min-w-0' : 'min-w-0'}>
    <dt className="text-xs text-stone-500">{attribute.name}</dt>
    <dd className="break-words text-sm text-stone-800">{formatAttribute(attribute, value)}</dd>
  </div>)}</dl>;
}
