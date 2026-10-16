import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GnomiEvent, Persona, PersonaSchema, Report as ReportData, RunRow } from '@gnomi/engine/types.ts';
import { isAttributeEnabled } from '@gnomi/engine/profile/schema.ts';
import { groupProfiles } from '@gnomi/engine/report/dimensions.ts';
import { socialMemory } from '@gnomi/engine/graph/feed.ts';
import { Activity, ProfileFilters } from './Activity.tsx';
import { countStates, filterEvents, filterPersonas, isEnd, isPreparingReport, merge, personaProgress, personaStates, runSetup, stateWord, toRows, waitingBlocks } from './activity.ts';
import type { Filters, PersonaState } from './activity.ts';
import { BlockedBanner } from './Blocked.tsx';
import { call, errorText, onEvent } from './engine.ts';
import { missingUsageText, recordedCost } from './cost.ts';
import { Inspector } from './Inspector.tsx';
import { personaLabel } from './ProfileFields.tsx';
import { ExportReport } from './ReportExport.tsx';
import { Report } from './Report.tsx';
import { Swarm } from './Swarm.tsx';
import { ActionBar, Button, Note, ProgressBar, Screenshot, usd, when } from './ui.tsx';
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

function RunDetail({ runId, row, onRunEnded, active }: { runId: string; row: RunRow | undefined; onRunEnded(): void; active: boolean }) {
  const [events, setEvents] = useState<GnomiEvent[]>([]);
  const frozenConfig = events.find((event) => event.type === 'run.started')?.payload.config ?? row?.config;
  const setup = useMemo(() => runSetup(frozenConfig), [frozenConfig]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [filters, setFilters] = useState<Filters>({ persona: '', segment: '', category: '' });
  const [inspecting, setInspecting] = useState<{ persona: string; seq: number | null } | null>(null);
  const closeInspector = useCallback(() => setInspecting(null), []);
  const openPersona = useCallback((id: string) => setInspecting({ persona: id, seq: null }), []);
  const [view, setView] = useState<'activity' | 'swarm' | 'report'>('activity');
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
      if (batch.some(isEnd)) onRunEnded();
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
  }, [ended, generatedSeq, runId]);

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
  const counts = countStates(states);
  const progress = useMemo(() => personaProgress(events), [events]);
  const usage = useMemo(() => recordedCost(events), [events]);
  const cost = usage.cost_usd;
  const pace = events.findLast((event) => event.type === 'run.concurrency_changed');
  const concurrency = pace?.type === 'run.concurrency_changed' ? pace.payload.concurrency : setup.concurrency;
  const groups = useMemo(() => setup.schema ? groupProfiles(personas, setup.schema) : [], [personas, setup.schema]);
  const profileFilter = useMemo(() => ({ dimension: filters.dimension, value: filters.value }), [filters.dimension, filters.value]);
  const shownPersonas = useMemo(() => filterPersonas(personas, profileFilter, setup.schema), [personas, profileFilter, setup.schema]);
  const filtered = useMemo(() => filterEvents(events, filters, personaById, setup.schema), [events, filters, personaById, setup.schema]);
  const rows = useMemo(() => toRows(filtered), [filtered]);
  const waiting = waitingBlocks(events);
  const finished = counts.done + counts.abandoned + counts.unfinished + (ended ? counts.blocked : 0);
  const preparing = !ended && isPreparingReport(events, states);
  const status = ended ? (row?.status === 'interrupted' ? 'Interrupted' : events.some((event) => event.type === 'run.stopped') || row?.status === 'stopped' ? 'Stopped' : 'Finished') : preparing ? 'Preparing report' : waiting.length > 0 ? 'Waiting for you' : events.length ? 'Running' : 'Starting';
  const inspected = inspecting ? personaById.get(inspecting.persona) : undefined;
  const names = useMemo(() => new Map(personas.map((persona) => [persona.id, personaLabel(persona, setup.schema)])), [personas, setup.schema]);
  const social = useMemo(() => {
    if (!inspected || !events.some((event) => event.type === 'run.round_started' || event.type.startsWith('social.'))) return null; // a run without social rounds
    return socialMemory(events, inspected.id);
  }, [events, inspected]);

  const stats: [string, string][] = [
    ['Status', status],
    ['Personas finished', `${finished} of ${personas.length}`],
    ['Recorded cost', setup.costBudget ? `${usd(cost)} of ${usd(setup.costBudget)}` : usd(cost)],
    ['Exploring at once', concurrency === null ? '1' : String(concurrency)],
  ];
  const chips: [string, number][] = [
    ['Working', counts.active],
    ['Done', counts.done],
    ['Gave up', counts.abandoned],
    [stateWord('blocked', ended), counts.blocked],
    ['Waiting to start', counts.waiting],
    ['Stopped early', counts.unfinished],
  ];

  return (
    <div className="space-y-5">
      <section aria-label="Run status" className="run-status">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="run-title">{status === 'Finished' ? 'A new perspective, ready to explore.' : preparing ? 'Your audience has finished exploring.' : status === 'Running' ? 'Your audience is exploring.' : status === 'Stopped' || status === 'Interrupted' ? 'Your run has stopped.' : status === 'Waiting for you' ? 'A little help is needed.' : 'Getting ready to explore.'}</h2>
            {row && <p className="mt-1 text-sm text-stone-600">The goal: {row.config.project.goal}</p>}
          </div>
          {!ended && (
            <ActionBar>
              <Button onClick={stop} disabled={stopping}>
                {stopping ? 'Stopping...' : 'Stop run'}
              </Button>
            </ActionBar>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <div key={label} className="run-stat">
              <dt className="text-xs text-stone-500">{label}</dt>
              <dd className="text-sm font-medium text-stone-900">{value}</dd>
            </div>
          ))}
        </dl>
        {setup.costBudget !== null && (
          <div className="mt-3">
            <ProgressBar value={Math.min(cost, setup.costBudget)} max={setup.costBudget} label="Recorded cost against the budget" />
          </div>
        )}
        <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-stone-600">
          {chips.filter(([, n]) => n > 0).map(([label, n]) => (
            <span key={label}>
              {label} <span className="font-semibold text-stone-900">{n}</span>
            </span>
          ))}
        </p>
        {stopping && !ended && <p className="mt-3 text-sm text-stone-500">Canceling outstanding model requests. Browser actions already started may finish.</p>}
        {preparing && !stopping && <p className="mt-3 text-sm text-stone-500" role="status">Preparing the report from their experiences. It will open automatically when ready.</p>}
        {missingUsageText(usage.unreported_usage_calls) && <p className="mt-3 text-sm text-amber-800" role="status">{missingUsageText(usage.unreported_usage_calls)}</p>}
      </section>

      {waiting.length > 0 && (
        <BlockedBanner blocks={waiting} personas={personaById} roleOf={setup.roleOf} runId={runId} pauseMs={setup.pauseMs} ending={stopping} onEnd={stop} />
      )}
      {error && <Note tone="error">{error}</Note>}
      {ended && !report && !error && <p className="text-sm text-stone-500">Building the report...</p>}
      <div role="tablist" aria-label="Run views" className="flex gap-1 border-b border-stone-200" onKeyDown={(event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(event.target as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        event.preventDefault();
        buttons[next]?.focus();
        buttons[next]?.click();
      }}>
        {([['activity', 'Timeline'], ['report', 'Report'], ['swarm', 'Connections']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`run-tab-${id}`}
            aria-selected={view === id}
            tabIndex={view === id ? 0 : -1}
            aria-controls={`run-panel-${id}`}
            onClick={() => { if (ended) openedReport.current = true; setView(id); }}
            disabled={id === 'report' && !ended}
            className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 ${view === id ? 'border-indigo-600 text-indigo-700' : 'border-transparent text-stone-600 hover:text-stone-900'}`}
          >
            {label}
          </button>
        ))}
      </div>
        <details className="disclosure profile-filter-disclosure"><summary><Icon name="filter" />Audience filters<span>{profileFilter.dimension && profileFilter.value ? 'Filter applied' : 'Explore a particular group'}</span></summary><div className="disclosure-body"><ProfileFilters groups={groups} filter={profileFilter} onChange={(next) => { setFilters((current) => ({ ...current, ...next, persona: '' })); setInspecting(null); }} />{!groups.length && <p className="text-sm text-stone-500">Profile filters are available for runs with audience attributes.</p>}</div></details>
      {/* The swarm mounts only while shown: its canvas needs a size, and it rebuilds from the log in milliseconds. */}
      {active && view === 'swarm' && (
        <div role="tabpanel" id="run-panel-swarm" aria-labelledby="run-tab-swarm">
          <Swarm events={events} segments={segments} names={names} poi={frozenConfig?.project.poi} onOpen={openPersona} />
        </div>
      )}
      <div role="tabpanel" id="run-panel-activity" aria-labelledby="run-tab-activity" hidden={view !== 'activity'} className="space-y-5">

        <PersonaGrid personas={shownPersonas} schema={setup.schema} segments={segments} states={states} steps={progress} ended={ended} onOpen={(id) => setInspecting({ persona: id, seq: null })} />
        <Activity
          rows={rows}
          total={events.length}
          personas={shownPersonas}
          segments={segments}
          filters={filters}
          onFilters={setFilters}
          onOpen={(id, seq) => setInspecting({ persona: id, seq })}
        />
      </div>
      {view === 'report' && <div role="tabpanel" id="run-panel-report" aria-labelledby="run-tab-report" className="space-y-5">
        {report ? <><ExportReport report={report} /><Report report={report} filter={profileFilter} onInspect={(id, seq) => setInspecting({ persona: id, seq: seq ?? null })} renderScreenshot={(path, alt) => <Screenshot path={path} alt={alt} />} /></> : <p className="text-sm text-stone-500">{error ? 'The report could not be loaded.' : 'Preparing your report…'}</p>}
      </div>}
      <p className="simulation-note">These are simulated experiences. Validate important findings with real people.</p>
      {inspected && inspecting && (
        <Inspector
          key={inspected.id}
          runId={runId}
          persona={inspected}
          schema={setup.schema}
          poi={frozenConfig?.project.poi}
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

const STATUS_WORDS = { running: 'Running', finished: 'Complete', stopped: 'Stopped', interrupted: 'Interrupted' };

export function Run({ runId, runs, onSelect, onRunEnded, onSetup, active }: { runId: string | null; runs: RunRow[]; onSelect(runId: string): void; onRunEnded(): void; onSetup(): void; active: boolean }) {
  return (
    <div className="run-page">
      {runs.length > 0 && <div className="run-history-bar"><label htmlFor="run-history"><Icon name="clock" size={18} />Run history</label><select id="run-history" value={runId ?? ''} onChange={(event) => onSelect(event.target.value)} className="run-history-select">
        {!runId && <option value="">Choose a run</option>}
        {runs.map((run) => <option key={run.run_id} value={run.run_id}>{when(run.started_at)} · {STATUS_WORDS[run.status]} · {runSetup(run.config).personas.length} people</option>)}
      </select><Button variant="link" onClick={onSetup}><Icon name="plus" size={16} />New run</Button></div>}
      {runId ? <RunDetail key={runId} active={active} runId={runId} row={runs.find((run) => run.run_id === runId)} onRunEnded={onRunEnded} /> : <div className="empty-state run-empty"><span className="empty-illustration"><Icon name="message" size={36} /></span><h2>Every perspective starts with a first step.</h2><p>Set a goal, invite your simulated audience, and see their experience unfold here.</p><Button variant="primary" onClick={onSetup}>Set up your first run<Icon name="arrow" size={18} /></Button></div>}
    </div>
  );
}
