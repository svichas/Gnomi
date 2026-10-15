import { useEffect, useState } from 'react';
import type { Action, ActionTarget, GnomiEvent, Report as ReportData, RunRow } from '@gnomi/engine/types.ts';
import { call, errorText, onEvent } from './engine.ts';
import { Report, usd } from './Report.tsx';
import { Note, secondaryButton } from './ui.tsx';

type Tone = 'plain' | 'friction' | 'good' | 'bad' | 'muted';

interface Row {
  seq: number;
  label: string;
  tone: Tone;
  title: string;
  badge?: { ok: boolean; text: string };
  detail?: string;
  quote?: string;
}

const TONES: Record<Tone, string> = {
  plain: 'border-stone-200 bg-white',
  friction: 'border-amber-300 bg-amber-50',
  good: 'border-green-200 bg-green-50',
  bad: 'border-red-200 bg-red-50',
  muted: 'border-transparent bg-transparent text-stone-500',
};

const STEP_ERRORS: Record<string, string> = {
  ref_not_found: 'element not found',
  not_editable: 'field cannot be typed into',
  password_field: 'password fields are off limits',
  host_not_allowed: 'outside the allowed site',
  timeout: 'timed out',
  invalid_output: 'the model gave an unusable answer',
};

function describeAction(action: Action, target: ActionTarget | null): string {
  const element = target ? `${target.role} "${target.name}"` : action.ref ? `element ${action.ref}` : 'the page';
  switch (action.type) {
    case 'click':
      return `Clicked ${element}`;
    case 'type':
      return `Typed "${action.text}" into ${element}`;
    case 'select':
      return `Chose "${action.text}" in ${element}`;
    case 'scroll':
      return `Scrolled ${action.text ?? 'down'}`;
    case 'back':
      return 'Went back';
    case 'navigate':
      return `Opened ${action.text}`;
    case 'read':
      return `Read ${element}`;
    case 'wait':
      return 'Waited';
    case 'done':
      return 'Decided the goal is done';
    case 'abandon':
      return 'Decided to give up';
  }
}

const STOP_REASONS = { user: 'You stopped the run', cost_budget: 'The run reached its cost limit', error: 'The run stopped because of an error' };

/** One line of the activity list, or null for events that are bookkeeping. */
function describe(event: GnomiEvent): Row | null {
  const { seq } = event;
  switch (event.type) {
    case 'persona.episode_started':
      return { seq, label: 'Start', tone: 'muted', title: `Opened ${event.payload.start_url} in a ${event.payload.device} browser` };
    case 'persona.step': {
      const { step_no, action, target, result, thought } = event.payload;
      const error = result.error && (STEP_ERRORS[result.error] ?? result.error);
      return {
        seq,
        label: `Step ${step_no}`,
        tone: 'plain',
        title: describeAction(action, target),
        badge: action.type === 'done' || action.type === 'abandon' ? undefined : result.ok ? { ok: true, text: 'ok' } : { ok: false, text: `error: ${error || 'failed'}` },
        quote: thought,
      };
    }
    case 'persona.friction_reported': {
      const { step_no, severity, what, expected } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'friction', title: `Friction, severity ${severity} of 4: ${what}`, detail: `Expected: ${expected}` };
    }
    case 'persona.goal_done':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'good', title: 'Goal reached', detail: event.payload.summary };
    case 'persona.abandoned':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'bad', title: 'Gave up', detail: event.payload.reason };
    case 'signal.budget_exceeded':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'bad', title: `Used all ${event.payload.budget} steps` };
    case 'signal.repeated_failure': {
      const { step_no, action, error } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'bad', title: 'Got stuck', detail: `The same ${action} failed three times in a row (${error})` };
    }
    case 'llm.call':
      return event.payload.status === 'ok'
        ? null
        : { seq, label: 'Model', tone: 'bad', title: 'A model call failed', detail: event.payload.error ?? event.payload.status };
    case 'run.stopped':
      return { seq, label: 'Stopped', tone: 'muted', title: STOP_REASONS[event.payload.reason], detail: event.payload.detail ?? undefined };
    case 'run.finished':
      return { seq, label: 'Done', tone: 'muted', title: 'Run finished' };
    default:
      return null;
  }
}

const isEnd = (event: GnomiEvent) => event.type === 'run.finished' || event.type === 'run.stopped';

/** Events arrive both live and from get_events, so adding the same one twice must change nothing. */
function merge(have: GnomiEvent[], incoming: GnomiEvent[]): GnomiEvent[] {
  const seen = new Set(have.map((event) => event.seq));
  const fresh = incoming.filter((event) => !seen.has(event.seq));
  return fresh.length ? [...have, ...fresh].sort((a, b) => a.seq - b.seq) : have;
}

function ActivityItem({ row }: { row: Row }) {
  return (
    <li className={`rounded-lg border px-3 py-2 ${TONES[row.tone]}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 break-words text-sm">
          <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-stone-500">{row.label}</span>
          <span className="font-medium text-stone-900">{row.title}</span>
        </p>
        {row.badge && <span className={`shrink-0 text-xs font-medium ${row.badge.ok ? 'text-green-700' : 'text-red-700'}`}>{row.badge.text}</span>}
      </div>
      {row.detail && <p className="mt-1 text-sm text-stone-700">{row.detail}</p>}
      {row.quote && <p className="mt-1 text-sm italic text-stone-600">&ldquo;{row.quote}&rdquo;</p>}
    </li>
  );
}

function RunDetail({ runId, row, onRunEnded }: { runId: string; row: RunRow | undefined; onRunEnded(): void }) {
  const [events, setEvents] = useState<GnomiEvent[]>([]);
  const [report, setReport] = useState<ReportData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    let current = true;
    const off = onEvent((event) => {
      if (event.run_id !== runId) return;
      setEvents((have) => merge(have, [event]));
      if (isEnd(event)) onRunEnded();
    });
    call('get_events', { run_id: runId, after_seq: null }).then(
      (all) => current && setEvents((have) => merge(have, all)),
      (err) => current && setError(errorText(err)),
    );
    return () => {
      current = false;
      off();
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

  const cost = events.reduce((sum, event) => (event.type === 'llm.call' ? sum + event.payload.cost_usd : sum), 0);
  const step = events.reduce((last, event) => (event.type === 'persona.step' ? Math.max(last, event.payload.step_no) : last), 0);
  const rows = events.flatMap((event) => describe(event) ?? []).reverse(); // newest first, so the latest step is always in view
  const status = ended ? (events.some((event) => event.type === 'run.stopped') ? 'Stopped' : 'Finished') : events.length ? 'Running' : 'Starting';

  return (
    <div className="space-y-5">
      <section aria-label="Run status" className="rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-stone-900">Run {runId}</h2>
            {row && (
              <p className="mt-1 text-sm text-stone-600">
                {row.config.persona.name} {ended ? 'tried to' : 'is trying to'}: {row.config.project.goal}
              </p>
            )}
          </div>
          {!ended && (
            <button type="button" onClick={stop} disabled={stopping} className={secondaryButton}>
              {stopping ? 'Stopping...' : 'Stop run'}
            </button>
          )}
        </div>
        <dl className="mt-4 grid grid-cols-3 gap-3">
          {[
            ['Status', status],
            ['Step', row ? `${step} of ${row.config.step_budget}` : String(step)],
            ['Cost so far', usd(cost)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg bg-stone-50 px-3 py-2">
              <dt className="text-xs text-stone-500">{label}</dt>
              <dd className="text-sm font-medium text-stone-900">{value}</dd>
            </div>
          ))}
        </dl>
        {stopping && !ended && <p className="mt-3 text-sm text-stone-500">Stopping after the current step...</p>}
      </section>

      {error && <Note tone="error">{error}</Note>}
      {ended && !report && !error && <p className="text-sm text-stone-500">Building the report...</p>}
      {report && <Report report={report} />}

      <section aria-labelledby="activity-title">
        <h2 id="activity-title" className="mb-2 text-base font-semibold text-stone-900">
          Activity
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-stone-500">Waiting for the persona to start...</p>
        ) : (
          <ol className="space-y-2">
            {rows.map((r) => (
              <ActivityItem key={r.seq} row={r} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

const STATUS_WORDS = { running: 'Running', finished: 'Finished', stopped: 'Stopped', interrupted: 'Interrupted' };

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
                    {run.status === 'running' ? STATUS_WORDS.running : `${STATUS_WORDS[run.status]} - ${usd(run.cost_usd)}`}
                  </span>
                  <span className="block text-xs text-stone-500">{new Date(run.started_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
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
