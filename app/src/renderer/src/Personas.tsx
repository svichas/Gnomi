import { useState } from 'react';
import type { DiversityReport, Persona, Segment } from '@gnomi/engine/types.ts';
import { countryName } from '@gnomi/engine/audience/locations.ts';
import { addedByHand, distribution } from './audience.ts';
import { Bars, Card, Field, inputClass, Note, primaryButton, secondaryButton } from './ui.tsx';

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
export function Distribution({ personas }: { personas: Persona[] }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      <Bars title="Devices" entries={distribution(personas, (p) => p.device, ['desktop', 'mobile'])} />
      <Bars title="First languages" entries={distribution(personas, (p) => languageName(p.language))} />
      {personas.some((p) => p.country) && <Bars title="Countries" entries={distribution(personas, (p) => p.country ? countryName(p.country) : 'Not set')} />}
      <Bars title="Accessibility needs" entries={distribution(personas, (p) => ACCESSIBILITY[p.accessibility_needs], Object.values(ACCESSIBILITY))} />
      <Bars title="Patience (1-5)" entries={distribution(personas, (p) => String(p.patience), SCALE)} />
      <Bars title="Tech skill (1-5)" entries={distribution(personas, (p) => String(p.tech_skill), SCALE)} />
    </div>
  );
}

export function Diversity({ report, personas }: { report: DiversityReport; personas: Persona[] }) {
  const name = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
  return (
    <div className="space-y-2">
      <p className="text-sm text-stone-700">
        How alike the personas read: {percent(report.mean_similarity)} on average, {percent(report.max_similarity)} at most
        {report.most_similar && ` (${name(report.most_similar[0])} and ${name(report.most_similar[1])})`}.
        {report.duplicate_names.length > 0 && ` Names used twice: ${report.duplicate_names.join(', ')}.`}
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

/** One persona: the sampled traits are shown, only the written fields can be edited by hand. */
function PersonaCard(props: { persona: Persona; allotted: boolean; busy: boolean; onEdit(persona: Persona): Promise<boolean>; onRegenerate(): void; onRemove(): void }) {
  const { persona, allotted, busy, onEdit, onRegenerate, onRemove } = props;
  const [draft, setDraft] = useState<Persona | null>(null);
  return (
    <li className="space-y-2 rounded-lg border border-stone-200 p-4 text-sm">
      {draft ? (
        <div className="space-y-3">
          {WRITTEN.map(([key, label]) => (
            <Field key={key} label={`${label} (${persona.name})`}>
              {key === 'name' || key === 'job_title' ? (
                <input value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} className={inputClass} />
              ) : (
                <textarea value={draft[key]} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} rows={key === 'background' ? 5 : 2} className={inputClass} />
              )}
            </Field>
          ))}
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={() => void onEdit(draft).then((saved) => saved && setDraft(null))}
              aria-label={`Save edits to ${persona.name}`}
              className={primaryButton}
            >
              Save edits
            </button>
            <button type="button" onClick={() => setDraft(null)} className={secondaryButton}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold text-stone-900">
              {persona.name} <span className="font-normal text-stone-500">({persona.pronouns})</span>
            </p>
            <p className="text-xs text-stone-500">
              {persona.device}, {languageName(persona.language)}
            </p>
          </div>
          <p className="text-stone-700">
            {persona.job_title}, {persona.seniority} level, {persona.industry}, {persona.company_size} employees
          </p>
          {persona.employer && <p className="text-sm text-stone-700">Employer: {persona.employer}</p>}
          {persona.country && <p className="text-xs text-stone-500">{persona.city}, {countryName(persona.country)} · {persona.timezone} · {(persona.languages ?? [persona.language]).join(', ')}</p>}
          <p className="text-xs text-stone-500">
            Tech skill {persona.tech_skill}/5, patience {persona.patience}/5, motivation {persona.motivation}/5, {persona.familiarity_with_category} familiarity with the
            category, accessibility: {ACCESSIBILITY[persona.accessibility_needs].toLowerCase()}, seed {persona.seed}
          </p>
          <p className="text-stone-700">{persona.background}</p>
          <p className="text-stone-600">
            <span className="font-medium">Reads the goal as:</span> {persona.goal_interpretation}
          </p>
          <p className="text-stone-600">
            <span className="font-medium">Voice:</span> {persona.voice}
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button type="button" onClick={() => setDraft(persona)} disabled={busy} aria-label={`Edit ${persona.name}`} className={secondaryButton}>
              Edit
            </button>
            <button type="button" onClick={onRegenerate} disabled={busy} aria-label={`Regenerate ${persona.name}`} className={secondaryButton}>
              Regenerate
            </button>
            <button type="button" onClick={onRemove} disabled={busy} aria-label={`Remove ${persona.name}`} aria-describedby={allotted ? `comes-back-${persona.id}` : undefined} className={secondaryButton}>
              Remove
            </button>
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
  segments: Segment[];
  diversity: DiversityReport | null;
  audienceSeed: number | null; // the saved audience's, to tell hand-added personas from the ones its shares allot
  busy: boolean;
  onEdit(persona: Persona): Promise<boolean>; // whether it was saved; the card keeps the edits open when not
  onRegenerate(id: string): void;
  onRemove(id: string): void;
  onAdd(segmentId: string): void;
}) {
  const { personas, segments, diversity, audienceSeed, busy, onEdit, onRegenerate, onRemove, onAdd } = props;
  const known = new Set(segments.map((segment) => segment.id));
  const groups = [
    ...segments.map((segment) => ({ id: segment.id, name: segment.name, people: personas.filter((p) => p.segment_id === segment.id) })),
    { id: null, name: 'Other', people: personas.filter((p) => p.segment_id === null || !known.has(p.segment_id)) },
  ].filter((group) => group.people.length > 0 || group.id !== null);
  return (
    <Card title={`Personas (${personas.length})`}>
      <div className="space-y-5">
        <Distribution personas={personas} />
        {diversity && <Diversity report={diversity} personas={personas} />}
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
                    allotted={!addedByHand(persona, audienceSeed)}
                    busy={busy}
                    onEdit={onEdit}
                    onRegenerate={() => onRegenerate(persona.id)}
                    onRemove={() => onRemove(persona.id)}
                  />
                ))}
              </ul>
              {group.id !== null && (
                <button type="button" onClick={() => onAdd(group.id)} disabled={busy} className={secondaryButton}>
                  Add a persona to {group.name}
                </button>
              )}
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}
