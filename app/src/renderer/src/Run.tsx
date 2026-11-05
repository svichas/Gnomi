import { RunStatus } from './RunStatus.tsx';
import './run.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EventOf, GnomiEvent, Persona, PersonaSchema, Report as ReportData, RunRow } from '@gnomi/simulation/types.ts';
import { isAttributeEnabled, usedPronouns } from '@gnomi/simulation/profile/schema.ts';
import { groupProfiles } from '@gnomi/simulation/report/dimensions.ts';
import type { RepeatSet } from '@gnomi/simulation/report/repeats.ts';
import { socialMemory } from '@gnomi/engine/graph/feed.ts';
import { Activity, ProfileFilters } from './Activity.tsx';
import { appended, emptyLog, emptyRows, filterEvents, filterPersonas, foldLog, foldRows, merge, rereadsSet, runSetup, stateWord, statesOf, waitingOf } from './activity.ts';
import type { Filters, PersonaState } from './activity.ts';
import { emptyMoments, foldMoments } from './activityFeed.ts';
import { BlockedBanner } from './Blocked.tsx';
import { call, errorText, onEvent, onRepeatFailed } from './engine.ts';
import { Inspector } from './Inspector.tsx';
import { Interviews, useInterview } from './Interview.tsx';
import { personaLabel } from './ProfileFields.tsx';
import { Feed } from './Feed.tsx';
import { ExportReport } from './ReportExport.tsx';
import { Report } from './Report.tsx';
import { RunAgain } from './RunAgain.tsx';
import { Swarm } from './Swarm.tsx';
import { Button, Note, Screenshot } from './ui.tsx';
import { Icon, PersonaAvatar } from './Icon.tsx';

const DOT: Record<PersonaState, string> = {
  waiting: 'bg-stone-300',
  active: 'bg-indigo-500',
  blocked: 'bg-red-500',
  done: 'bg-green-500',
  abandoned: 'bg-amber-500',
  unfinished: 'bg-stone-400',
};

/** Everyone in the run at a glance; a click opens her inspector. */
function PersonaGrid(props: { personas: Persona[]; schema?: PersonaSchema; segments: { id: string; name: string }[]; states: Map<string, PersonaState>; steps: Map<string, { steps: number }>; ended: boolean; onOpen(id: string): void }) {
  const { personas, schema, segments, states, steps, ended, onOpen } = props;
  return (
    // Open for a handful of personas; with dozens it starts closed so the feed is in view.
    <details className="persona-roster disclosure">
      <summary><Icon name="people" />People in this run<span>{personas.length} simulated users</span></summary>
      <ul className="grid max-h-72 gap-2 overflow-y-auto border-t border-stone-200 p-4 sm:grid-cols-2 lg:grid-cols-3">
        {personas.map((persona) => {
          const name = personaLabel(persona, schema);
          const state = states.get(persona.id) ?? 'waiting';
          const taken = steps.get(persona.id)?.steps ?? 0;
          return (
            <li key={persona.id}>
              <button
                type="button"
                onClick={() => onOpen(persona.id)}
                aria-label={`Inspect ${name}`}
                className="w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-left hover:border-indigo-300"
              >
                <span className="persona-preview"><PersonaAvatar name={persona.name} id={persona.id} pronouns={usedPronouns(persona, schema)} /><span className="block truncate text-sm font-medium text-stone-900">{name}</span></span>
                <span className="block truncate text-xs text-stone-500">{segments.find((segment) => segment.id === persona.segment_id)?.name ?? (isAttributeEnabled(schema, 'job_title', 'card') ? persona.job_title : '')}</span>
                <span className="mt-1 flex items-center gap-2 text-xs text-stone-700">
                  <span aria-hidden className={`h-2 w-2 rounded-full ${DOT[state]}`} />
                  {stateWord(state, ended)}
                  {taken > 0 && ` - step ${taken}`}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

/** Folds only the events the log gained since the last render; starts over when a late event was sorted in or `reset` changed. */
function useFold<T>(events: GnomiEvent[], reset: unknown[], start: () => T, step: (state: T, added: GnomiEvent[]) => T): T {
  const last = useRef<{ events: GnomiEvent[]; reset: unknown[]; state: T } | null>(null);
  const prev = last.current;
  const same = !!prev && reset.every((value, i) => value === prev.reset[i]);
  if (prev && same && prev.events === events) return prev.state;
  const added = prev && same ? appended(prev.events, events) : null;
  const state = prev && added ? step(prev.state, added) : step(start(), events);
  last.current = { events, reset, state };
  return state;
}

function RunDetail({ runId, row, runs, active }: { runId: string; row: RunRow | undefined; runs: RunRow[]; active: boolean }) {
  const [received, setEvents] = useState<GnomiEvent[]>([]);
  // A hidden tab keeps showing the log it last showed, and catches up in one fold when it is shown again.
  const shown = useRef(received);
  if (active) shown.current = received;
  const events = shown.current;
  // What the log says, folded once per batch of new events rather than read whole on every render (the app re-renders all its tabs).
  const log = useFold(events, [], emptyLog, foldLog);
  const frozenConfig = log.config ?? row?.config;
  const setup = useMemo(() => runSetup(frozenConfig), [frozenConfig]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [repeats, setRepeats] = useState<RepeatSet>();
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [filters, setFilters] = useState<Filters>({ persona: '', segment: '', category: '' });
  const [inspecting, setInspecting] = useState<{ persona: string; seq: number | null } | null>(null);
  const closeInspector = useCallback(() => setInspecting(null), []);
  const openPersona = useCallback((id: string, seq?: number) => setInspecting({ persona: id, seq: seq ?? null }), []);
  const [view, setView] = useState<'activity' | 'report'>('activity');
  const [feedOpen, setFeedOpen] = useState(false);
  const interview = useInterview(runId);
  const openedReport = useRef(false);

  useEffect(() => {
    let current = true;
    let queue: GnomiEvent[] = [];
    let timer: number | undefined;
    // One render per 100 ms however many events arrive: fifty personas can produce hundreds a second (tech.md §11).
    const flush = () => {
      timer = undefined;
      const batch = queue;
      queue = [];
      setEvents((have) => merge(have, batch));
    };
    const off = onEvent((event) => {
      if (event.run_id !== runId) return;
      queue.push(event);
      timer ??= window.setTimeout(flush, 100);
    });
    call('get_events', { run_id: runId, after_seq: null, persona_id: null }).then(
      (all) => current && setEvents((have) => merge(have, all)),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
      off();
      window.clearTimeout(timer);
    };
  }, [runId]);

  const ended = log.ended || (!!row && row.status !== 'running');
  // biome-ignore lint/correctness/useExhaustiveDependencies: fetches the report again when a newer one is generated or the user retries
  useEffect(() => {
    if (!ended) return;
    let current = true;
    call('get_report', { run_id: runId }).then(
      (built) => {
        if (!current) return;
        setReport(built);
        setError(null);
        // Open once per run. A later saved-report refresh must preserve the user's chosen view.
        if (!openedReport.current) {
          openedReport.current = true;
          setView('report');
        }
      },
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
    };
  }, [ended, log.generatedSeq, runId, reportAttempt]);

  const group = frozenConfig?.repeat?.group;
  const setEnded = runs.filter((run) => run.config.repeat?.group === group && run.status !== 'running').length; // a later repeat ending changes the comparison
  const [repeatFailures, setRepeatFailures] = useState(0);
  useEffect(() => onRepeatFailed(() => setRepeatFailures((failures) => failures + 1)), []); // a repeat that cannot start ends the set with no run ending
  const [setReports, setSetReports] = useState(0);
  useEffect(() => onEvent((event) => { if (rereadsSet(event, group, runs)) setSetReports((reports) => reports + 1); }), [group, runs]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: compares again when this report is rebuilt, a report of the set is written, another run of the set ends or the set fails
  useEffect(() => {
    if (!group || !report) return;
    let current = true;
    call('get_repeats', { group }).then(
      (set) => current && setRepeats(set),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
    };
  }, [group, report, setEnded, setReports, repeatFailures]);

  async function stop() {
    setStopping(true);
    try {
      await call('stop_run', { run_id: runId });
    } catch (err) {
      setError(errorText(err));
      setStopping(false);
    }
  }

  const { personas, segments } = setup;
  const personaById = useMemo(() => new Map(personas.map((persona) => [persona.id, persona])), [personas]);
  const states = useMemo(() => statesOf(log.statuses, personas, ended), [log, personas, ended]);
  const groups = useMemo(() => setup.schema ? groupProfiles(personas, setup.schema) : [], [personas, setup.schema]);
  const profileFilter = useMemo(() => ({ dimension: filters.dimension, value: filters.value }), [filters.dimension, filters.value]);
  const shownPersonas = useMemo(() => filterPersonas(personas, profileFilter, setup.schema), [personas, profileFilter, setup.schema]);
  // The feed's rows and moments, folded as events arrive; a new filter starts them over.
  const feed = useFold(events, [filters, personaById, setup.schema], () => ({ rows: emptyRows(), highlights: emptyMoments(), all: emptyMoments() }), (fold, added) => {
    const rows = foldRows(fold.rows, filterEvents(added, filters, personaById, setup.schema));
    return { rows: fold.rows, highlights: foldMoments(fold.highlights, rows.added, rows.replaced), all: foldMoments(fold.all, rows.added, rows.replaced, true) };
  });
  const moments = useMemo(() => ({ highlights: feed.highlights.list, all: feed.all.list }), [feed]);
  const waiting = ended ? [] : waitingOf(log);
  const inspected = inspecting ? personaById.get(inspecting.persona) : undefined;
  const names = useMemo(() => new Map(personas.map((persona) => [persona.id, personaLabel(persona, setup.schema)])), [personas, setup.schema]);
  const inspectedEvents = useMemo(() => inspected ? events.filter((event) => event.persona_id === inspected.id) : [], [events, inspected]);
  const social = useMemo(() => {
    if (!inspected || !log.social) return null; // a run without social rounds
    return socialMemory(events, inspected.id);
  }, [events, inspected, log.social]);
  const askable = ended;
  const interviewed = useMemo(() => (askable ? events.filter((event): event is EventOf<'persona.interviewed'> => event.type === 'persona.interviewed') : []), [events, askable]); // a live run has none, and its log grows every batch
  const statusPanel = <RunStatus events={events} config={frozenConfig} row={row} compact={view === 'report'} reportAvailable={report !== null} waiting={waiting.length} stopping={stopping} onStop={stop} />;

  return (
    <div className="space-y-5">
      {view === 'report' && statusPanel}
      {waiting.length > 0 && (
        <BlockedBanner blocks={waiting} personas={personaById} roleOf={setup.roleOf} runId={runId} pauseMs={setup.pauseMs} ending={stopping} onEnd={stop} />
      )}
      {error && <Note tone="error">{error}</Note>}
      {ended && !report && <div className="simulation-report-notice" role="status"><Icon name="report" size={18} /><span>{error ? 'The report could not be loaded.' : 'Loading your report…'}</span>{error && <Button variant="link" onClick={() => { setError(null); setReportAttempt((attempt) => attempt + 1); }}>Try again</Button>}</div>}
      {ended && <div role="tablist" aria-label="Run views" className="simulation-view-tabs" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
        buttons[next]?.click();
      }}>
        {([['activity', 'Simulation'], ['report', 'Report']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`run-tab-${id}`}
            aria-selected={view === id}
            tabIndex={view === id ? 0 : -1}
            aria-controls={`run-panel-${id}`}
            onClick={() => { if (ended) openedReport.current = true; setView(id); }}
            disabled={id === 'report' && !report}
            className="simulation-view-tab"
          >
            {label}
          </button>
        ))}
      </div>}
      {/* Hidden rather than unmounted behind the report and other tabs: rebuilding the map (WebGL context, shaders, graph, layout) froze every visit. */}
      {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: aria-labelledby is set only while the role is tabpanel */}
      <div hidden={view !== 'activity'} role={ended ? 'tabpanel' : undefined} id="run-panel-activity" aria-labelledby={ended ? 'run-tab-activity' : undefined} className="simulation-overview">
        <div className="simulation-workspace">
          <Swarm active={active && view === 'activity'} events={events} segments={segments} expectedPersonas={personas.length} onOpen={openPersona} />
          {view === 'activity' && statusPanel}
        </div>
        <Activity
          rows={feed.rows.rows}
          moments={moments}
          total={events.length}
          personas={shownPersonas}
          segments={segments}
          filters={filters}
          live={!ended}
          profileGroups={groups}
          schema={setup.schema}
          onFilters={setFilters}
          onOpen={(id, seq) => setInspecting({ persona: id, seq })}
        />
        <div className="simulation-explore-tools">
          {/* Every thread is in the page while the feed shows, so it is built only while open. */}
          {log.posts && <details className="disclosure" onToggle={(event) => setFeedOpen(event.currentTarget.open)}><summary><Icon name="message" />Audience conversations<span>Explore full discussion threads</span></summary><div className="disclosure-body">{feedOpen && <Feed events={events} names={names} pois={frozenConfig?.project.pois} onOpen={openPersona} />}</div></details>}
          <PersonaGrid personas={shownPersonas} schema={setup.schema} segments={segments} states={states} steps={log.progress} ended={ended} onOpen={openPersona} />
          {groups.length > 0 && <details className="disclosure profile-filter-disclosure"><summary><Icon name="filter" />Audience filters<span>{profileFilter.dimension && profileFilter.value ? 'Filter applied to activity and people' : 'Explore a particular group'}</span></summary><div className="disclosure-body"><ProfileFilters groups={groups} filter={profileFilter} onChange={(next) => { setFilters((current) => ({ ...current, ...next, persona: '' })); setInspecting(null); }} /></div></details>}
        </div>
      </div>
      {ended && view === 'report' && <div role="tabpanel" id="run-panel-report" aria-labelledby="run-tab-report" className="space-y-5">
        {report ? <Report
          report={report}
          filter={profileFilter}
          repeats={repeats}
          actions={<ExportReport report={report} repeats={repeats} />}
          audienceFilters={groups.length > 0 ? <ProfileFilters groups={groups} filter={profileFilter} onChange={(next) => setFilters((current) => ({ ...current, ...next, persona: '' }))} /> : undefined}
          onInspect={(id, seq) => setInspecting({ persona: id, seq: seq ?? null })}
          interviews={askable ? <Interviews runId={runId} report={report} answers={interviewed} interview={interview} personas={personas} schema={setup.schema} events={events} pois={frozenConfig?.project.pois} onInspect={openPersona} /> : undefined}
          renderScreenshot={(path, alt) => <Screenshot path={path} alt={alt} />}
        /> : <p className="text-sm text-stone-500">{error ? 'The report could not be loaded.' : 'Preparing your report…'}</p>}
      </div>}
      <p className="simulation-note">These are simulated experiences. Validate important findings with real people.</p>
      {inspected && inspecting && (
        <Inspector
          key={inspected.id}
          runId={runId}
          persona={inspected}
          schema={setup.schema}
          pois={frozenConfig?.project.pois}
          segment={segments.find((segment) => segment.id === inspected.segment_id)}
          focusSeq={inspecting.seq}
          ended={ended}
          askable={askable}
          interview={interview}
          state={states.get(inspected.id) ?? 'waiting'}
          events={inspectedEvents}
          social={social}
          names={names}
          onClose={closeInspector}
        />
      )}
    </div>
  );
}

export function Run({ runId, runs, onSetup, onStarted, active }: { runId: string | null; runs: RunRow[]; onSetup(): void; onStarted(runId: string): void; active: boolean }) {
  const [again, setAgain] = useState(false);
  const row = runs.find((run) => run.run_id === runId);
  return (
    <div className="run-page">
      {runs.length > 0 && <div className="run-history-bar"><div className="run-history-context"><Icon name="activity" size={16} /><span>Simulation record</span><code title={runId ?? undefined}>{runId}</code></div>{row?.status === 'finished' && <Button variant="link" onClick={() => setAgain(true)}><Icon name="play" size={16} />Run again</Button>}<Button variant="link" onClick={onSetup}><Icon name="plus" size={16} />New run</Button></div>}
      {again && row && <RunAgain run={row} running={runs.some((run) => run.status === 'running')} onClose={() => setAgain(false)} onStarted={(id) => { setAgain(false); onStarted(id); }} />}
      {runId ? <RunDetail key={runId} active={active} runId={runId} row={runs.find((run) => run.run_id === runId)} runs={runs} /> : <div className="empty-state run-empty"><span className="empty-illustration"><Icon name="message" size={36} /></span><h2>Every perspective starts with a first step.</h2><p>Set a goal, invite your simulated audience, and see their experience unfold here.</p><Button variant="primary" onClick={onSetup}>Set up your first run<Icon name="arrow" size={18} /></Button></div>}
    </div>
  );
}
