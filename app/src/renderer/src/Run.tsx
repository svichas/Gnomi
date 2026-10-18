import { RunStatus } from './RunStatus.tsx';
import './run.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GnomiEvent, Persona, PersonaSchema, Report as ReportData, RunRow } from '@gnomi/simulation/types.ts';
import { isAttributeEnabled } from '@gnomi/simulation/profile/schema.ts';
import { groupProfiles } from '@gnomi/simulation/report/dimensions.ts';
import { socialMemory } from '@gnomi/engine/graph/feed.ts';
import { Activity, ProfileFilters } from './Activity.tsx';
import { filterEvents, filterPersonas, isEnd, merge, personaProgress, personaStates, runSetup, stateWord, toRows, waitingBlocks } from './activity.ts';
import type { Filters, PersonaState } from './activity.ts';
import { BlockedBanner } from './Blocked.tsx';
import { call, errorText, onEvent } from './engine.ts';
import { Inspector } from './Inspector.tsx';
import { personaLabel } from './ProfileFields.tsx';
import { Feed } from './Feed.tsx';
import { ExportReport } from './ReportExport.tsx';
import { Report } from './Report.tsx';
import { Swarm } from './Swarm.tsx';
import { ResearchProgress } from './ResearchProgress.tsx';
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
                <span className="persona-preview"><PersonaAvatar name={name} id={persona.id} /><span className="block truncate text-sm font-medium text-stone-900">{name}</span></span>
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

function RunDetail({ runId, row, active }: { runId: string; row: RunRow | undefined; active: boolean }) {
  const [events, setEvents] = useState<GnomiEvent[]>([]);
  const frozenConfig = events.find((event) => event.type === 'run.started')?.payload.config ?? row?.config;
  const research = frozenConfig?.project.comparison?.execution.collection === 'shared_research';
  const setup = useMemo(() => runSetup(frozenConfig), [frozenConfig]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [reportAttempt, setReportAttempt] = useState(0);
  const [filters, setFilters] = useState<Filters>({ persona: '', segment: '', category: '' });
  const [inspecting, setInspecting] = useState<{ persona: string; seq: number | null } | null>(null);
  const closeInspector = useCallback(() => setInspecting(null), []);
  const openPersona = useCallback((id: string, seq?: number) => setInspecting({ persona: id, seq: seq ?? null }), []);
  const [view, setView] = useState<'activity' | 'report'>('activity');
  const openedReport = useRef(false);
  useEffect(() => { window.scrollTo(0, 0); }, [view]);

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

  const ended = events.some(isEnd) || (!!row && row.status !== 'running');
  const generatedSeq = events.findLast((event) => event.type === 'report.generated')?.seq;
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
  }, [ended, generatedSeq, runId, reportAttempt]);

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
  const states = useMemo(() => personaStates(events, personas), [events, personas]);
  const progress = useMemo(() => personaProgress(events), [events]);
  const groups = useMemo(() => setup.schema ? groupProfiles(personas, setup.schema) : [], [personas, setup.schema]);
  const profileFilter = useMemo(() => ({ dimension: filters.dimension, value: filters.value }), [filters.dimension, filters.value]);
  const shownPersonas = useMemo(() => filterPersonas(personas, profileFilter, setup.schema), [personas, profileFilter, setup.schema]);
  const filtered = useMemo(() => filterEvents(events, filters, personaById, setup.schema), [events, filters, personaById, setup.schema]);
  const rows = useMemo(() => toRows(filtered), [filtered]);
  const waiting = ended || events.some((event) => event.type === 'report.started') ? [] : waitingBlocks(events);
  const inspected = inspecting ? personaById.get(inspecting.persona) : undefined;
  const names = useMemo(() => new Map(personas.map((persona) => [persona.id, personaLabel(persona, setup.schema)])), [personas, setup.schema]);
  const social = useMemo(() => {
    if (!inspected || !events.some((event) => event.type === 'run.round_started' || event.type.startsWith('social.'))) return null; // a run without social rounds
    return socialMemory(events, inspected.id);
  }, [events, inspected]);
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
      {view === 'activity' && <div role={ended ? 'tabpanel' : undefined} id="run-panel-activity" aria-labelledby={ended ? 'run-tab-activity' : undefined} className="simulation-overview">
        <div className="simulation-workspace">
          {research && frozenConfig ? <ResearchProgress config={frozenConfig} events={events} /> : active && <Swarm events={events} segments={segments} expectedPersonas={personas.length} onOpen={openPersona} />}
          {statusPanel}
        </div>
        <Activity
          rows={rows}
          total={events.length}
          personas={research ? [] : shownPersonas}
          segments={research ? [] : segments}
          filters={filters}
          live={!ended}
          research={research}
          onFilters={setFilters}
          onOpen={(id, seq) => setInspecting({ persona: id, seq })}
        />
        <div className="simulation-explore-tools">
          {events.some((event) => event.type === 'social.post') && <details className="disclosure"><summary><Icon name="message" />Audience conversations<span>Explore full discussion threads</span></summary><div className="disclosure-body"><Feed events={events} names={names} pois={frozenConfig?.project.pois} onOpen={openPersona} /></div></details>}
          {!research && <PersonaGrid personas={shownPersonas} schema={setup.schema} segments={segments} states={states} steps={progress} ended={ended} onOpen={openPersona} />}
          {!research && groups.length > 0 && <details className="disclosure profile-filter-disclosure"><summary><Icon name="filter" />Audience filters<span>{profileFilter.dimension && profileFilter.value ? 'Filter applied to activity and people' : 'Explore a particular group'}</span></summary><div className="disclosure-body"><ProfileFilters groups={groups} filter={profileFilter} onChange={(next) => { setFilters((current) => ({ ...current, ...next, persona: '' })); setInspecting(null); }} /></div></details>}
        </div>
      </div>}
      {ended && view === 'report' && <div role="tabpanel" id="run-panel-report" aria-labelledby="run-tab-report" className="space-y-5">
        {report ? <>{!research && groups.length > 0 && <details className="disclosure"><summary><Icon name="filter" />Filter report by audience<span>{profileFilter.dimension && profileFilter.value ? 'Filter applied' : 'All profiles'}</span></summary><div className="disclosure-body"><ProfileFilters groups={groups} filter={profileFilter} onChange={(next) => setFilters((current) => ({ ...current, ...next, persona: '' }))} /></div></details>}<ExportReport report={report} /><Report report={report} filter={profileFilter} onInspect={(id, seq) => setInspecting({ persona: id, seq: seq ?? null })} renderScreenshot={(path, alt) => <Screenshot path={path} alt={alt} />} /></> : <p className="text-sm text-stone-500">{error ? 'The report could not be loaded.' : 'Preparing your report…'}</p>}
      </div>}
      <p className="simulation-note">{research ? 'Public sources support a buying shortlist. Confirm decisive claims and test the workflow before choosing.' : 'These are simulated experiences. Validate important findings with real people.'}</p>
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
          social={social}
          names={names}
          onClose={closeInspector}
        />
      )}
    </div>
  );
}

export function Run({ runId, runs, onSetup, active }: { runId: string | null; runs: RunRow[]; onSetup(): void; active: boolean }) {
  return (
    <div className="run-page">
      {runs.length > 0 && <div className="run-history-bar"><span>{runId}</span><Button variant="link" onClick={onSetup}><Icon name="plus" size={16} />New run</Button></div>}
      {runId ? <RunDetail key={runId} active={active} runId={runId} row={runs.find((run) => run.run_id === runId)} /> : <div className="empty-state run-empty"><span className="empty-illustration"><Icon name="message" size={36} /></span><h2>Every perspective starts with a first step.</h2><p>Set a goal, invite your simulated audience, and see their experience unfold here.</p><Button variant="primary" onClick={onSetup}>Set up your first run<Icon name="arrow" size={18} /></Button></div>}
    </div>
  );
}
