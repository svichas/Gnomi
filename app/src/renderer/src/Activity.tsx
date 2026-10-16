import { forwardRef, useId, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { Persona, Segment } from '@gnomi/engine/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/engine/report/dimensions.ts';
import type { ProfileGroups } from '@gnomi/engine/report/dimensions.ts';
import { CATEGORIES, isTimelineHighlight, timelineSummary } from './activity.ts';
import type { Category, Filters, ProfileFilter, Row } from './activity.ts';
import { Button, Field, inputClass } from './ui.tsx';
import { Icon, PersonaAvatar } from './Icon.tsx';

/** Persona controls open the full profile; the rest of the row toggles inline activity details. */
export function ActivityItem({ row, who, onOpen }: { row: Row; who: string | null; onOpen?(personaId: string, seq: number | null): void }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const personaId = row.persona_id;
  const openProfile = personaId !== null && onOpen ? () => onOpen(personaId, null) : undefined;
  const icon = row.tone === 'alarm' || row.tone === 'bad' || row.tone === 'friction' || row.badge?.ok === false ? 'alert' : row.tone === 'good' ? 'check' : row.quote ? 'message' : 'activity';
  const marker = <>{who ? <PersonaAvatar name={who} id={personaId ?? who} /> : <span className="system-avatar"><Icon name={icon} size={16} /></span>}{who && <span className={`event-icon event-${icon}`}><Icon name={icon} size={10} /></span>}</>;
  return (
    <div className={`timeline-item tone-${row.tone}`} data-expanded={expanded || undefined}
      onKeyDown={(event) => { if (event.key === 'Escape' && expanded) { setExpanded(false); event.stopPropagation(); } }}>
      <div className="timeline-header">
        {who && openProfile ? <button type="button" className="timeline-marker timeline-persona" aria-label={`View ${who}'s profile`} aria-haspopup="dialog" onClick={openProfile}>{marker}</button> : <span className="timeline-marker">{marker}</span>}
        <span className="timeline-copy"><span className="timeline-byline" id={`${detailId}-byline`}>{who && openProfile ? <button type="button" className="timeline-persona timeline-persona-name" aria-haspopup="dialog" onClick={openProfile}>{who}</button> : <strong>{who ?? 'Gnomi'}</strong>}<span className="event-label">{row.label}</span></span><span className="timeline-one-line" id={`${detailId}-summary`}>{timelineSummary(row)}</span></span>
        {row.ts !== undefined && <time dateTime={new Date(row.ts).toISOString()} className="timeline-time">{new Date(row.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
        <span className="timeline-chevron"><Icon name="chevron" size={14} /></span>
        <button type="button" className="timeline-trigger" aria-labelledby={`${detailId}-byline ${detailId}-summary`} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((current) => !current)} />
      </div>
      <div id={detailId} hidden={!expanded} className="timeline-detail">
        <p className="timeline-action">{row.title}</p>
        {row.quote && <blockquote>“{row.quote}”</blockquote>}
        {row.detail && <p>{row.detail}</p>}
        {row.badge && <p className={row.badge.ok ? 'timeline-success' : 'timeline-error'}><Icon name={row.badge.ok ? 'check' : 'alert'} size={14} />{row.badge.ok ? 'Action completed' : row.badge.text}</p>}
        {personaId !== null && onOpen && <Button variant="link" onClick={() => onOpen(personaId, row.seq)}>View persona & evidence<Icon name="arrow" size={14} /></Button>}
      </div>
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
    <section aria-label="Profile filters" className="space-y-3">
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
      {filter.dimension && <Button variant="link" onClick={() => onChange({ dimension: '', value: '' })}>Clear audience filter</Button>}
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
  onOpen(personaId: string, seq: number | null): void;
}) {
  const { rows, total, personas, segments, filters, onFilters, onOpen } = props;
  const byId = new Map(personas.map((persona) => [persona.id, persona]));
  const [showFilters, setShowFilters] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  // An explicit event category shows every matching event, including routine ones.
  const routineVisible = allEvents || !!filters.category;
  const visibleRows = routineVisible ? rows : rows.filter(isTimelineHighlight);
  const activeFilters = !!(filters.persona || filters.segment || filters.category);
  const set = (change: Partial<Filters>) => onFilters({ ...filters, ...change });
  return (
    <section aria-labelledby="activity-title" className="space-y-3">
      <div className="section-toolbar timeline-toolbar"><div><h2 id="activity-title">Activity <span aria-hidden="true" className="count-label">{visibleRows.length}</span></h2><p>Little moments. A clearer picture.</p></div><div className="flex items-center gap-3">{activeFilters && <Button variant="link" onClick={() => set({ persona: '', segment: '', category: '' })}>Clear filters</Button>}<Button variant="quiet" aria-expanded={showFilters} aria-controls="activity-filters" onClick={() => setShowFilters(!showFilters)}><Icon name="filter" size={18} />Filter{activeFilters ? ' · on' : ''}</Button></div></div>
      <div id="activity-filters" hidden={!showFilters}>
      <div className="filter-bar grid gap-3 sm:grid-cols-3">
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
      </div>
      <div className="timeline-options"><div role="group" aria-label="Timeline detail" className="segmented-control"><button type="button" aria-pressed={!routineVisible} onClick={() => { setAllEvents(false); set({ category: '' }); }}>Highlights</button><button type="button" aria-pressed={routineVisible} onClick={() => { setAllEvents(true); set({ category: '' }); }}>All events</button></div><p className="timeline-hint">Newest first · Click an activity for details or a persona for their profile.</p></div>
      {visibleRows.length === 0 ? (
        <div className="empty-state compact"><Icon name="message" size={28} /><h3>{total === 0 ? 'The story is about to start.' : 'No moments match these filters.'}</h3><p>{total === 0 ? 'Actions and thoughts will appear here as people explore.' : 'Try another filter to see more of the experience.'}</p></div>
      ) : (
        <Virtuoso
          useWindowScroll
          data={visibleRows}
          components={{ List }}
          computeItemKey={(_, row) => row.seq}
          itemContent={(_, row) => {
            const persona = row.persona_id === null ? undefined : byId.get(row.persona_id);
            return (
              <div role="listitem" className="timeline-row">
                <ActivityItem row={row} who={persona?.name ?? (row.persona_id ? 'Simulated user' : null)} onOpen={onOpen} />
              </div>
            );
          }}
        />
      )}
    </section>
  );
}
