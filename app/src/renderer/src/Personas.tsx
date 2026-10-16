import { useEffect, useState } from 'react';
import type { DiversityReport, Persona, PersonaSchema, Segment } from '@gnomi/engine/types.ts';
import { attributeValue, getPersonaSchema, isAttributeEnabled } from '@gnomi/engine/profile/schema.ts';
import { countryName } from '@gnomi/engine/audience/locations.ts';
import { addedByHand, distribution } from './audience.ts';
import { PersonaHeader, ProfileFields, personaLabel } from './ProfileFields.tsx';
import { formatAttribute, NARRATIVE_FIELDS } from './profile.ts';
import { Bars, Button, Card, Field, inputClass, Note } from './ui.tsx';

const ACCESSIBILITY: Record<Persona['accessibility_needs'], string> = {
  none: 'None',
  low_vision: 'Low vision',
  colour_blind: 'Colour-blind',
  screen_reader: 'Screen reader',
  motor: 'Motor',
};
const languageName = (code: string) => new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code;
const percent = (x: number) => `${Math.round(x * 100)}%`;
const SCALE = ['1', '2', '3', '4', '5'];

/** How the generated population is spread, so a skew is visible before anyone is paid to browse (idea.md §11). */
export function Distribution({ personas, schema }: { personas: Persona[]; schema?: PersonaSchema }) {
  const custom = getPersonaSchema(schema).attributes.filter((attribute) => !DEFAULT_IDS.has(attribute.id) && attribute.enabled && attribute.show_on_card && (attribute.type === 'choice' || attribute.type === 'boolean'));
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {isAttributeEnabled(schema, 'device', 'card') && <Bars title="Devices" entries={distribution(personas, (p) => p.device, ['desktop', 'mobile'])} />}
      {isAttributeEnabled(schema, 'languages', 'card') && <Bars title="First languages" entries={distribution(personas, (p) => languageName(p.language))} />}
      {isAttributeEnabled(schema, 'country', 'card') && personas.some((p) => p.country) && <Bars title="Countries" entries={distribution(personas, (p) => p.country ? countryName(p.country) : 'Not set')} />}
      {isAttributeEnabled(schema, 'accessibility_needs', 'card') && <Bars title="Accessibility needs" entries={distribution(personas, (p) => ACCESSIBILITY[p.accessibility_needs], Object.values(ACCESSIBILITY))} />}
      {isAttributeEnabled(schema, 'patience', 'card') && <Bars title="Patience (1-5)" entries={distribution(personas, (p) => String(p.patience), SCALE)} />}
      {isAttributeEnabled(schema, 'tech_skill', 'card') && <Bars title="Tech skill (1-5)" entries={distribution(personas, (p) => String(p.tech_skill), SCALE)} />}
      {custom.map((attribute) => <Bars key={attribute.id} title={attribute.name} entries={distribution(personas, (persona) => {
        const value = attributeValue(persona, attribute);
        return value === undefined ? 'Not generated yet' : formatAttribute(attribute, value);
      })} />)}
    </div>
  );
}

export function Diversity({ report, personas, schema }: { report: DiversityReport; personas: Persona[]; schema?: PersonaSchema }) {
  const name = (id: string) => { const persona = personas.find((p) => p.id === id); return persona ? personaLabel(persona, schema) : id; };
  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-700">
        How alike the personas read: {percent(report.mean_similarity)} on average, {percent(report.max_similarity)} at most
        {report.most_similar && ` (${name(report.most_similar[0])} and ${name(report.most_similar[1])})`}.
        {isAttributeEnabled(schema, 'name', 'card') && report.duplicate_names.length > 0 && ` Names used twice: ${report.duplicate_names.join(', ')}.`}
      </p>
      {report.warning && <Note tone="info">{report.warning}</Note>}
    </div>
  );
}

const WRITTEN = [
  ['name', 'Name'],
  ['job_title', 'Job title'],
  ['context_of_use', 'Where and when they use it'],
  ['background', 'Background'],
  ['goal_interpretation', 'How they read the goal'],
  ['voice', 'Voice'],
] as const;
const DEFAULT_IDS = new Set(getPersonaSchema().attributes.map((attribute) => attribute.id));
const CARD_SUMMARY = ['job_title', 'employer', 'country', 'city', 'timezone', 'languages', 'device', 'tech_skill', 'patience'];

/** One persona: the sampled traits are shown, only the written fields can be edited by hand. */
function PersonaCard(props: { persona: Persona; schema?: PersonaSchema; stale: boolean; allotted: boolean; busy: boolean; onEdit(persona: Persona): Promise<boolean>; onRegenerate(): void; onRemove(): void }) {
  const { persona, schema, stale, allotted, busy, onEdit, onRegenerate, onRemove } = props;
  const [draft, setDraft] = useState<Persona | null>(null);
  useEffect(() => { if (stale) setDraft(null); }, [stale]);
  const name = personaLabel(persona, schema);
  const summary = [...CARD_SUMMARY, ...getPersonaSchema(schema).attributes.filter((attribute) => !DEFAULT_IDS.has(attribute.id)).map((attribute) => attribute.id)];
  const written = WRITTEN.filter(([key]) => isAttributeEnabled(schema, key, 'card'));
  return (
    <li aria-label={`${name} persona`} className="persona-card">
      <PersonaHeader persona={persona} schema={schema} stale={stale} />
      {draft && !stale ? (
        <div className="space-y-3">
          {written.map(([key, label]) => (
            <Field key={key} label={`${label} (${name})`}>
              {key === 'name' || key === 'job_title' ? (
                <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className={inputClass} />
              ) : (
                <textarea value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} rows={key === 'background' ? 5 : 2} className={inputClass} />
              )}
            </Field>
          ))}
          <div className="flex gap-3">
            <Button
              disabled={busy || stale}
              onClick={() => { if (!stale) void onEdit(draft).then((saved) => saved && setDraft(null)); }}
              aria-label={`Save edits to ${name}`}
              variant="primary"
            >
              Save edits
            </Button>
            <Button onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="persona-facts"><ProfileFields persona={persona} schema={schema} only={summary} except={['job_title']} stale={stale} /></div>
          {stale ? <p className="text-sm text-amber-800">Regenerate this persona to update their biography and voice.</p> : <div className="persona-story"><ProfileFields persona={persona} schema={schema} only={[...NARRATIVE_FIELDS]} /></div>}
          <details className="persona-more">
            <summary>Full profile</summary>
            <div className="pt-3"><ProfileFields persona={persona} schema={schema} except={[...summary, ...NARRATIVE_FIELDS, 'name', 'pronouns']} stale={stale} /></div>
          </details>
          <div className="persona-actions">
            <Button onClick={() => setDraft(persona)} disabled={busy || stale || !written.length} aria-label={`Edit ${name}`} small>
              Edit
            </Button>
            <Button onClick={onRegenerate} disabled={busy} aria-label={`Regenerate ${name}`} small>
              Regenerate
            </Button>
            <Button onClick={onRemove} disabled={busy} aria-label={`Remove ${name}`} aria-describedby={allotted ? `comes-back-${persona.id}` : undefined} small>
              Remove
            </Button>
          </div>
          {allotted && (
            <p id={`comes-back-${persona.id}`} className="text-xs text-stone-500">
              It comes back when you generate again; lower the persona count or the segment&rsquo;s share instead.
            </p>
          )}
        </>
      )}
    </li>
  );
}

/** The generated population, grouped by segment, with the editing the engine offers (idea.md §6.3). */
export function PersonaList(props: {
  personas: Persona[];
  schema?: PersonaSchema;
  stale?: Set<string>;
  segments: Segment[];
  diversity: DiversityReport | null;
  audienceSeed: number | null; // the saved audience's, to tell hand-added personas from the ones its shares allot
  busy: boolean;
  onEdit(persona: Persona): Promise<boolean>; // whether it was saved; the card keeps the edits open when not
  onRegenerate(id: string): void;
  onRemove(id: string): void;
  onAdd(segmentId: string): void;
}) {
  const { personas, schema, stale, segments, diversity, audienceSeed, busy, onEdit, onRegenerate, onRemove, onAdd } = props;
  const known = new Set(segments.map((segment) => segment.id));
  const groups = [
    ...segments.map((segment) => ({ id: segment.id, name: segment.name, people: personas.filter((p) => p.segment_id === segment.id) })),
    { id: null, name: 'Other', people: personas.filter((p) => p.segment_id === null || !known.has(p.segment_id)) },
  ].filter((group) => group.people.length > 0 || group.id !== null);
  return (
    <Card title={`Personas (${personas.length})`}>
      <div className="space-y-5">
        {!!stale?.size && <p className="text-sm text-amber-800">Distributions show the last generated population. Generate personas to apply the current rules.</p>}
        <Distribution personas={personas} schema={schema} />
        {diversity && <Diversity report={diversity} personas={personas} schema={schema} />}
        {groups.map((group) => (
          <details key={group.id ?? 'other'} open={groups.length === 1 || group === groups[0]} className="rounded-lg border border-stone-200">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-stone-900">
              {group.name} ({group.people.length})
            </summary>
            <div className="space-y-3 border-t border-stone-200 p-4">
              <ul className="grid gap-3 lg:grid-cols-2">
                {group.people.map((persona) => (
                  <PersonaCard
                    key={persona.id}
                    persona={persona}
                    schema={schema}
                    stale={stale?.has(persona.id) ?? false}
                    allotted={!addedByHand(persona, audienceSeed)}
                    busy={busy}
                    onEdit={onEdit}
                    onRegenerate={() => onRegenerate(persona.id)}
                    onRemove={() => onRemove(persona.id)}
                  />
                ))}
              </ul>
              {group.id !== null && (
                <Button onClick={() => onAdd(group.id)} disabled={busy}>
                  Add a persona to {group.name}
                </Button>
              )}
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}
