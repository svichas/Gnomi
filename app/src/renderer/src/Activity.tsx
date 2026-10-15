import { forwardRef } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { Persona, Segment } from '@gnomi/engine/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/engine/report/dimensions.ts';
import type { ProfileGroups } from '@gnomi/engine/report/dimensions.ts';
import { CATEGORIES, TONE_CLASSES } from './activity.ts';
import type { Category, Filters, ProfileFilter, Row } from './activity.ts';
import { Field, inputClass } from './ui.tsx';

function Body({ row, who }: { row: Row; who: string | null }) {
  const alarm = row.tone === 'alarm';
  return (
    <>
      <span className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 break-words text-sm">
          {who && <span className="mr-2 font-semibold text-stone-900">{who}</span>}
          <span className={`mr-2 text-xs font-semibold uppercase tracking-wide ${alarm ? 'text-red-800' : 'text-stone-500'}`}>{row.label}</span>
          <span className={alarm ? 'font-semibold text-red-950' : 'font-medium text-stone-900'}>{row.title}</span>
        </span>
        {row.badge && <span className={`shrink-0 text-xs font-medium ${row.badge.ok ? 'text-green-700' : 'text-red-700'}`}>{row.badge.text}</span>}
      </span>
      {row.detail && <span className="mt-1 block text-sm text-stone-700">{row.detail}</span>}
      {row.quote && <span className="mt-1 block text-sm italic text-stone-600">&ldquo;{row.quote}&rdquo;</span>}
    </>
  );
}

/** One line of the feed. With a persona behind it, it is a button that opens her inspector at that step. */
export function ActivityItem({ row, who, onOpen }: { row: Row; who: string | null; onOpen?(personaId: string, seq: number): void }) {
  const className = `block w-full rounded-lg border px-3 py-2 text-left ${TONE_CLASSES[row.tone]}`;
  if (row.persona_id !== null && onOpen) {
    const personaId = row.persona_id;
    return (
      <button type="button" onClick={() => onOpen(personaId, row.seq)} className={`${className} hover:border-indigo-300`}>
        <Body row={row} who={who} />
      </button>
    );
  }
  return (
    <div className={className}>
      <Body row={row} who={who} />
    </div>
  );
}

const List = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function List(props, ref) {
  return <div role="list" ref={ref} {...props} />;
});

/** One selection applies to report details, the persona roster and the activity feed. */
export function ProfileFilters({ groups, filter, onChange }: { groups: ProfileGroups[]; filter: ProfileFilter; onChange(filter: ProfileFilter): void }) {
  const selected = groups.find((group) => group.attribute.id === filter.dimension);
  if (!groups.length) return null;
  return (
    <section aria-label="Profile filters" className="space-y-3 rounded-xl border border-stone-200 bg-white p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Profile dimension">
          <select value={filter.dimension ?? ''} onChange={(event) => onChange({ dimension: event.target.value, value: '' })} className={inputClass}>
            <option value="">All profiles</option>
            {groups.map(({ attribute }) => <option key={attribute.id} value={attribute.id}>{attribute.name}</option>)}
          </select>
        </Field>
        <Field label="Profile value">
          <select value={filter.value ?? ''} disabled={!selected} onChange={(event) => onChange({ ...filter, value: event.target.value })} className={inputClass}>
            <option value="">All values</option>
            {selected?.values.map(({ value }) => <option key={attributeKey(value)} value={attributeKey(value)}>{formatAttributeValue(value)}</option>)}
          </select>
        </Field>
      </div>
      <p className="text-xs text-stone-500">Filters apply to report details, personas and activity. Run totals and grouped results always describe the full run.</p>
    </section>
  );
}

/** The live feed of a run, virtualised: only the rows on screen are in the page, however many personas there are. */
export function Activity(props: {
  rows: Row[];
  total: number;
  personas: Persona[];
  segments: Segment[];
  filters: Filters;
  onFilters(filters: Filters): void;
  onOpen(personaId: string, seq: number): void;
}) {
  const { rows, total, personas, segments, filters, onFilters, onOpen } = props;
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  const set = (change: Partial<Filters>) => onFilters({ ...filters, ...change });
  return (
    <section aria-labelledby="activity-title" className="space-y-3">
      <h2 id="activity-title" className="text-base font-semibold text-stone-900">
        Activity
      </h2>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Persona">
          <select value={filters.persona} onChange={(e) => set({ persona: e.target.value })} className={inputClass}>
            <option value="">Everyone</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Segment">
          <select value={filters.segment} onChange={(e) => set({ segment: e.target.value })} className={inputClass}>
            <option value="">All segments</option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind of event">
          <select value={filters.category} onChange={(e) => set({ category: e.target.value as Category | '' })} className={inputClass}>
            <option value="">Everything</option>
            {(Object.keys(CATEGORIES) as Category[]).map((category) => (
              <option key={category} value={category}>
                {CATEGORIES[category]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-stone-500">{total === 0 ? 'Waiting for the personas to start...' : 'Nothing matches these filters.'}</p>
      ) : (
        <Virtuoso
          useWindowScroll
          data={rows}
          components={{ List }}
          computeItemKey={(_, row) => row.seq}
          itemContent={(_, row) => {
            const persona = row.persona_id === null ? undefined : byId.get(row.persona_id);
            const segment = segments.find((candidate) => candidate.id === persona?.segment_id);
            return (
              <div role="listitem" className="pb-2">
                <ActivityItem row={row} who={persona ? (segment ? `${persona.name} (${segment.name})` : persona.name) : null} onOpen={onOpen} />
              </div>
            );
          }}
        />
      )}
    </section>
  );
}
