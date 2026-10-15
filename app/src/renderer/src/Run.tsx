import { useEffect, useState } from 'react';
import type { EventOf, GnomiEvent, Report as ReportData, RunRow } from '@gnomi/engine/types.ts';
import { isEnd, merge, toRows, waitingBlock } from './activity.ts';
import type { Row, Tone } from './activity.ts';
import { call, errorText, onEvent } from './engine.ts';
import { RecordingPanel, useRecorder } from './Recorder.tsx';
import { Report, usd } from './Report.tsx';
import { Note, primaryButton, secondaryButton, useAction, when } from './ui.tsx';

const TONES: Record<Tone, string> = {
  plain: 'border-stone-200 bg-white',
  friction: 'border-amber-300 bg-amber-50',
  good: 'border-green-200 bg-green-50',
  bad: 'border-red-200 bg-red-50',
  alarm: 'border-2 border-red-500 bg-red-100',
  notice: 'border-sky-200 bg-sky-50',
  muted: 'border-transparent bg-transparent text-stone-500',
};

function ActivityItem({ row }: { row: Row }) {
  return (
    <li className={`rounded-lg border px-3 py-2 ${TONES[row.tone]}`}>
      <div className="flex items-baseline justify-between gap-3">
        <p className="min-w-0 break-words text-sm">
          <span className={`mr-2 text-xs font-semibold uppercase tracking-wide ${row.tone === 'alarm' ? 'text-red-800' : 'text-stone-500'}`}>{row.label}</span>
          <span className={`${row.tone === 'alarm' ? 'font-semibold text-red-950' : 'font-medium text-stone-900'}`}>{row.title}</span>
        </p>
        {row.badge && <span className={`shrink-0 text-xs font-medium ${row.badge.ok ? 'text-green-700' : 'text-red-700'}`}>{row.badge.text}</span>}
      </div>
      {row.detail && <p className="mt-1 text-sm text-stone-700">{row.detail}</p>}
      {row.quote && <p className="mt-1 text-sm italic text-stone-600">&ldquo;{row.quote}&rdquo;</p>}
    </li>
  );
}

/** The engine words a CAPTCHA block as "A recaptcha challenge is showing. ..."; the banner only needs the name of the challenge. */
function challengeKind(detail: string): string | null {
  const named = /^An? (.+?) challenge is showing/.exec(detail);
  return named ? named[1] : detail.length <= 40 ? detail : null;
}

const waitText = (ms: number) => (ms >= 90_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/** A paused persona needs the user: a login to record again, or a CAPTCHA to turn off on staging. */
function BlockedBanner(props: { blocked: EventOf<'persona.blocked'>; row: RunRow | undefined; runId: string; ending: boolean; onEnd(): void }) {
  const { blocked, row, runId, ending, onEnd } = props;
  const { reason } = blocked.payload;
  const kind = challengeKind(blocked.payload.detail);
  const name = row?.config.persona.name ?? 'The persona';
  const resume = { run_id: runId, persona_id: blocked.persona_id ?? row?.config.persona.id ?? '' };
  const role = row?.config.session?.role ?? row?.config.project.role ?? null;
  const retry = useAction();
  const recorder = useRecorder(async () => {
    await call('resume_persona', resume);
  });
  const busy = retry.busy || recorder.busy || ending;

  return (
    <section role="alert" aria-label="The persona is waiting for you" className="space-y-3 rounded-xl border-2 border-red-300 bg-red-50 p-5">
      {reason === 'session_expired' ? (
        <>
          <h2 className="text-base font-semibold text-red-950">{name}&rsquo;s login expired</h2>
          <p className="text-sm text-red-900">Record the login again and the run carries on from where it stopped.</p>
        </>
      ) : (
        <p className="text-sm text-red-950">
          {name} hit a CAPTCHA{kind && ` (${kind})`}. Gnomi never solves these: turn the challenge off on staging or use the provider&rsquo;s test keys, then
          retry.
        </p>
      )}
      {row && <p className="text-xs text-red-900">Gnomi waits {waitText(row.config.pause_timeout_ms)} for you, then ends the run.</p>}
      <RecordingPanel recorder={recorder} />
      <div className="flex flex-wrap gap-3">
        {reason === 'session_expired' ? (
          <button type="button" onClick={() => role !== null && recorder.start(role)} disabled={busy || role === null || recorder.recording !== null} className={primaryButton}>
            Re-record login
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              retry.run(async () => {
                await call('resume_persona', resume);
                return null;
              })
            }
            disabled={busy}
            className={primaryButton}
          >
            Retry
          </button>
        )}
        <button type="button" onClick={onEnd} disabled={busy} className={secondaryButton}>
          End run
        </button>
      </div>
      {retry.outcome && <Note tone={retry.outcome.ok ? 'ok' : 'error'}>{retry.outcome.text}</Note>}
      {recorder.outcome && <Note tone={recorder.outcome.ok ? 'ok' : 'error'}>{recorder.outcome.text}</Note>}
    </section>
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
  const rows = toRows(events);
  const waiting = waitingBlock(events);
  const status = ended ? (events.some((event) => event.type === 'run.stopped') ? 'Stopped' : 'Finished') : waiting ? 'Waiting for you' : events.length ? 'Running' : 'Starting';

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

      {waiting && <BlockedBanner blocked={waiting} row={row} runId={runId} ending={stopping} onEnd={stop} />}
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
                  <span className="block text-xs text-stone-500">{when(run.started_at)}</span>
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
