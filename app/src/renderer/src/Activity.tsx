import { forwardRef, useId, useMemo, useState } from 'react';
import type { ComponentPropsWithoutRef } from 'react';
import { Virtuoso } from 'react-virtuoso';
import type { Persona, Segment } from '@gnomi/simulation/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/simulation/report/dimensions.ts';
import type { ProfileGroups } from '@gnomi/simulation/report/dimensions.ts';
import { CATEGORIES, isTimelineHighlight } from './activity.ts';
import type { Category, Filters, ProfileFilter, Row } from './activity.ts';
import { activityMoments, momentKind, pendingActivityCount } from './activityFeed.ts';
import { Button, Field, inputClass } from './ui.tsx';
import { Icon, PersonaAvatar } from './Icon.tsx';
import './activity.css';

/** Persona controls open the full profile; the rest of the row toggles inline activity details. */
export function ActivityItem({ row, related = [row], who, onOpen, onRead }: { row: Row; related?: Row[]; who: string | null; onOpen?(personaId: string, seq: number | null): void; onRead?(): void }) {
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const personaId = row.persona_id;
  const action = related.find((item) => item.source?.type === 'persona.step');
  const quote = action?.quote || row.quote;
  const failed = related.find((item) => item.badge?.ok === false);
  const tone = failed ? 'bad' : row.tone;
  const context = [row.source?.step !== undefined ? `Step ${row.source.step}` : '', row.source?.round ? `Round ${row.source.round}` : ''].filter(Boolean).join(' · ');
  const openProfile = personaId !== null && onOpen ? () => onOpen(personaId, null) : undefined;
  const icon = tone === 'alarm' || tone === 'bad' || tone === 'friction' ? 'alert' : tone === 'good' ? 'check' : quote ? 'message' : 'activity';
  const marker = <>{who ? <PersonaAvatar name={who} id={personaId ?? who} /> : <span className="system-avatar"><Icon name={icon} size={16} /></span>}{who && <span className={`event-icon event-${icon}`}><Icon name={icon} size={10} /></span>}</>;
  return (
    <div className={`timeline-item tone-${tone}`} data-expanded={expanded || undefined} onFocusCapture={onRead}
      onKeyDown={(event) => { if (event.key === 'Escape' && expanded) { setExpanded(false); event.stopPropagation(); } }}>
      <div className="timeline-header">
        {who && openProfile ? <button type="button" className="timeline-marker timeline-persona" aria-label={`View ${who}'s profile`} aria-haspopup="dialog" onClick={openProfile}>{marker}</button> : <span className="timeline-marker">{marker}</span>}
        <div className="timeline-copy">
          <div className="timeline-byline" id={`${detailId}-byline`}>{who && openProfile ? <button type="button" className="timeline-persona timeline-persona-name" aria-haspopup="dialog" onClick={openProfile}>{who}</button> : <strong>{who ?? 'Gnomi'}</strong>}<span className="event-label">{momentKind(row)}</span><span className="moment-context">{context}</span></div>
          <p className="timeline-one-line" id={`${detailId}-summary`}>{row.headline ?? row.title}</p>
          {action && action.seq !== row.seq && <p className="moment-action-context">{action.title}</p>}
          {failed?.badge && <p className="moment-failure"><Icon name="alert" size={13} />{failed.badge.text.replace(/^error:\s*/i, '')}</p>}
          {quote && <blockquote className="moment-quote"><span className="moment-quote-label">{row.label === 'Post' || row.label === 'Reply' ? 'Shared with the audience' : row.label === 'Survey' ? 'Their feedback' : 'What they were thinking'}</span><span>“{quote}”</span></blockquote>}
          <span className="moment-detail-hint">{expanded ? 'Hide details' : related.length > 1 ? `${related.length} connected events · View details` : 'View details'}<Icon name="chevron" size={12} /></span>
        </div>
        {row.ts !== undefined && <time dateTime={new Date(row.ts).toISOString()} className="timeline-time">{new Date(row.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>}
        <button type="button" className="timeline-trigger" aria-labelledby={`${detailId}-byline ${detailId}-summary`} aria-expanded={expanded} aria-controls={detailId} onClick={() => setExpanded((current) => !current)} />
      </div>
      <div id={detailId} hidden={!expanded} className="timeline-detail">
        <ol className="moment-evidence" aria-label="Recorded evidence">{related.map((item) => <li key={item.seq}>
          <p className="timeline-action"><span>{item.label}</span>{item.title}</p>
          {item.quote && <blockquote>“{item.quote}”</blockquote>}
          {item.detail && <p>{item.detail}</p>}
          {item.badge && <p className={item.badge.ok ? 'timeline-success' : 'timeline-error'}><Icon name={item.badge.ok ? 'check' : 'alert'} size={14} />{item.badge.ok ? 'Action completed' : item.badge.text}</p>}
        </li>)}</ol>
        {personaId !== null && onOpen && <Button variant="link" onClick={() => onOpen(personaId, action?.seq ?? row.seq)}>View persona & evidence<Icon name="arrow" size={14} /></Button>}
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
  live?: boolean;
  research?: boolean;
  onFilters(filters: Filters): void;
  onOpen(personaId: string, seq: number | null): void;
}) {
  const { rows, total, personas, segments, filters, live = false, research = false, onFilters, onOpen } = props;
  const byId = useMemo(() => new Map(personas.map((persona) => [persona.id, persona])), [personas]);
  const [showFilters, setShowFilters] = useState(false);
  const [allEvents, setAllEvents] = useState(false);
  const [snapshot, setSnapshot] = useState<{ filterKey: string; rows: Row[] } | null>(null);
  const filterKey = JSON.stringify(filters);
  const pausedRows = snapshot?.filterKey === filterKey ? snapshot.rows : null;
  const feedRows = pausedRows ?? rows;
  const pause = () => { if (live && !pausedRows) setSnapshot({ filterKey, rows }); };
  // An explicit event category shows every matching event, including routine ones.
  const routineVisible = allEvents || !!filters.category;
  const moments = useMemo(() => activityMoments(feedRows, routineVisible), [feedRows, routineVisible]);
  const pending = useMemo(() => pausedRows ? pendingActivityCount(routineVisible ? rows : rows.filter(isTimelineHighlight), pausedRows) : 0, [rows, pausedRows, routineVisible]);
  const activeFilters = !!(filters.persona || filters.segment || filters.category);
  const set = (change: Partial<Filters>) => { setSnapshot(null); onFilters({ ...filters, ...change }); };
  return (
    <section aria-labelledby="activity-title" className="activity-feed">
      <div className="section-toolbar timeline-toolbar"><div><h2 id="activity-title">Activity <span aria-hidden="true" className="count-label">{moments.length}</span></h2><p>Follow each action, the thinking behind it, and what happened next.</p></div><div className="activity-toolbar-actions">{activeFilters && <Button variant="link" onClick={() => set({ persona: '', segment: '', category: '' })}>Clear filters</Button>}<Button variant="quiet" aria-expanded={showFilters} aria-controls="activity-filters" onClick={() => setShowFilters(!showFilters)}><Icon name="filter" size={18} />Filter{activeFilters ? ' · on' : ''}</Button></div></div>
      <div id="activity-filters" hidden={!showFilters}>
      <div className="filter-bar grid gap-3 sm:grid-cols-3">
        {!research && <Field label="Persona">
          <select value={filters.persona} onChange={(e) => set({ persona: e.target.value })} className={inputClass}>
            <option value="">Everyone</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
              </option>
            ))}
          </select>
        </Field>}
        {!research && <Field label="Segment">
          <select value={filters.segment} onChange={(e) => set({ segment: e.target.value })} className={inputClass}>
            <option value="">All segments</option>
            {segments.map((segment) => (
              <option key={segment.id} value={segment.id}>
                {segment.name}
              </option>
            ))}
          </select>
        </Field>}
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
      <div className="timeline-options"><div role="group" aria-label="Timeline detail" className="segmented-control"><button type="button" aria-pressed={!routineVisible} onClick={() => { setAllEvents(false); set({ category: '' }); }}>Highlights</button><button type="button" aria-pressed={routineVisible} onClick={() => { setAllEvents(true); set({ category: '' }); }}>All events</button></div><div className="activity-live-controls"><span className={`activity-live-state${live && !pausedRows ? ' is-live' : ''}`}><i aria-hidden="true" />{pausedRows ? 'Updates paused' : live ? 'Live updates' : 'Run history'}</span>{live && !pausedRows && <button type="button" className="activity-pause" onClick={pause}>Pause updates</button>}{pausedRows && <button type="button" className="activity-pause" onClick={() => setSnapshot(null)}>{pending ? `Show ${pending} new update${pending === 1 ? '' : 's'}` : live ? 'Resume updates' : 'Show latest'}</button>}</div></div>
      <div className="activity-reading-guide"><p>{routineVisible ? 'Every recorded event, newest first.' : 'Related steps and observations are grouped into moments, newest first.'}</p>{pausedRows ? <span>{live ? 'The simulation keeps running while you read.' : 'Show the latest updates to see the full history.'}</span> : <span>Select a name to explore their full journey.</span>}</div>
      {moments.length === 0 ? (
        <div className="empty-state compact"><Icon name="message" size={28} /><h3>{activeFilters ? 'No moments match these filters.' : live || total === 0 ? 'Waiting for the first observation.' : 'No highlights were recorded.'}</h3><p>{activeFilters ? 'Try another filter to see more of the experience.' : live ? 'People’s actions and feedback will appear as they explore.' : 'Choose All events to explore the complete activity history.'}</p></div>
      ) : (
        <Virtuoso
          useWindowScroll
          data={moments}
          components={{ List }}
          computeItemKey={(_, moment) => moment.key}
          itemContent={(_, { row, related }) => {
            const persona = row.persona_id === null ? undefined : byId.get(row.persona_id);
            return (
              <div role="listitem" className="timeline-row">
                <ActivityItem row={row} related={related} who={research && row.persona_id ? 'Research collector' : persona?.name ?? (row.persona_id ? 'Simulated user' : null)} onOpen={onOpen} onRead={pause} />
              </div>
            );
          }}
        />
      )}
    </section>
  );
}
