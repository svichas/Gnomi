import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GnomiEvent, Persona, PersonaSchema, Report as ReportData, RunRow } from '@gnomi/engine/types.ts';
import { isAttributeEnabled } from '@gnomi/engine/profile/schema.ts';
import { groupProfiles } from '@gnomi/engine/report/dimensions.ts';
import { Activity, ProfileFilters } from './Activity.tsx';
import { countStates, filterEvents, filterPersonas, isEnd, merge, personaProgress, personaStates, runSetup, stateWord, toRows, waitingBlocks } from './activity.ts';
import type { Filters, PersonaState } from './activity.ts';
import { BlockedBanner } from './Blocked.tsx';
import { call, errorText, onEvent } from './engine.ts';
import { missingUsageText, recordedCost } from './cost.ts';
import { Inspector } from './Inspector.tsx';
import { personaLabel } from './ProfileFields.tsx';
import { ExportReport } from './ReportExport.tsx';
import { Report } from './Report.tsx';
import { Note, ProgressBar, Screenshot, secondaryButton, usd, when } from './ui.tsx';

const DOT: Record<PersonaState, string> = {
  waiting: 'bg-stone-300',
  active: 'bg-indigo-500 animate-pulse',
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
    <details open={personas.length <= 12} className="rounded-xl border border-stone-200 bg-white">
      <summary className="cursor-pointer px-5 py-3 text-base font-semibold text-stone-900">Personas ({personas.length})</summary>
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
                <span className="block truncate text-sm font-medium text-stone-900">{name}</span>
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

function RunDetail({ runId, row, onRunEnded }: { runId: string; row: RunRow | undefined; onRunEnded(): void }) {
  const [events, setEvents] = useState<GnomiEvent[]>([]);
  const frozenConfig = events.find((event) => event.type === 'run.started')?.payload.config ?? row?.config;
  const setup = useMemo(() => runSetup(frozenConfig), [frozenConfig]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [filters, setFilters] = useState<Filters>({ persona: '', segment: '', category: '' });
  const [inspecting, setInspecting] = useState<{ persona: string; seq: number | null } | null>(null);
  const closeInspector = useCallback(() => setInspecting(null), []);

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

  const ended = events.some(isEnd);
  useEffect(() => {
    if (!ended) return;
    let current = true;
    call('get_report', { run_id: runId }).then(
      (built) => current && setReport(built),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
    };
  }, [ended, runId]);

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
  const status = ended ? (events.some((event) => event.type === 'run.stopped') ? 'Stopped' : 'Finished') : waiting.length > 0 ? 'Waiting for you' : events.length ? 'Running' : 'Starting';
  const inspected = inspecting ? personaById.get(inspecting.persona) : undefined;

  const stats: [string, string][] = [
    ['Status', status],
    ['Personas finished', `${finished} of ${personas.length}`],
    ['Recorded cost', setup.costBudget ? `${usd(cost)} of ${usd(setup.costBudget)}` : usd(cost)],
    ['Browsers at once', concurrency === null ? '1' : String(concurrency)],
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
      <section aria-label="Run status" className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-stone-900">Run {runId}</h2>
            {row && <p className="mt-1 text-sm text-stone-600">The goal: {row.config.project.goal}</p>}
          </div>
          {!ended && (
            <button type="button" onClick={stop} disabled={stopping} className={secondaryButton}>
              {stopping ? 'Stopping...' : 'Stop run'}
            </button>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map(([label, value]) => (
            <div key={label} className="rounded-lg bg-stone-50 px-3 py-2">
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
        {missingUsageText(usage.unreported_usage_calls) && <p className="mt-3 text-sm text-amber-800" role="status">{missingUsageText(usage.unreported_usage_calls)}</p>}
      </section>

      {waiting.length > 0 && (
        <BlockedBanner blocks={waiting} personas={personaById} roleOf={setup.roleOf} runId={runId} pauseMs={setup.pauseMs} ending={stopping} onEnd={stop} />
      )}
      {error && <Note tone="error">{error}</Note>}
      {ended && !report && !error && <p className="text-sm text-stone-500">Building the report...</p>}
      {report && <ExportReport report={report} />}
      <ProfileFilters groups={groups} filter={profileFilter} onChange={(next) => { setFilters((current) => ({ ...current, ...next, persona: '' })); setInspecting(null); }} />
      {report && <Report report={report} filter={profileFilter} onInspect={(id, seq) => setInspecting({ persona: id, seq: seq ?? null })} renderScreenshot={(path, alt) => <Screenshot path={path} alt={alt} />} />}

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
          onClose={closeInspector}
        />
      )}
    </div>
  );
}

const STATUS_WORDS = { running: 'Running', finished: 'Finished', stopped: 'Stopped', interrupted: 'Interrupted' };
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function Run({ runId, runs, onSelect, onRunEnded }: { runId: string | null; runs: RunRow[]; onSelect(runId: string): void; onRunEnded(): void }) {
  return (
    <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
      <nav aria-label="Past runs">
        <h2 className="mb-2 text-base font-semibold text-stone-900">Runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-stone-500">No runs yet.</p>
        ) : (
          <ul className="space-y-2">
            {runs.map((run) => (
              <li key={run.run_id}>
                <button
                  type="button"
                  onClick={() => onSelect(run.run_id)}
                  aria-current={run.run_id === runId ? 'true' : undefined}
                  className={`w-full rounded-lg border px-3 py-2 text-left text-sm hover:bg-stone-100 ${run.run_id === runId ? 'border-indigo-400 bg-indigo-50' : 'border-stone-200 bg-white'}`}
                >
                  <span className="block font-medium text-stone-900">{run.run_id}</span>
                  <span className="block text-xs text-stone-500">
                    {run.status === 'running' ? STATUS_WORDS.running : `${STATUS_WORDS[run.status]} - ${usd(run.cost_usd)} recorded`}
                  </span>
                  <span className="block text-xs text-stone-500">{when(run.started_at)}</span>
                  <span className="block text-xs text-stone-500">{count(runSetup(run.config).personas.length, 'persona')}</span>
                  <span className="mt-1 block truncate text-xs text-stone-600">{run.config.project.goal}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      {runId ? (
        <RunDetail key={runId} runId={runId} row={runs.find((run) => run.run_id === runId)} onRunEnded={onRunEnded} />
      ) : (
        <p className="text-sm text-stone-600">Nothing is running. Set up your project and press Start run, or open a past run to read its report.</p>
      )}
    </div>
  );
}
