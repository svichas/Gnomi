import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { Report as ReportData, ReportFriction, ReportMethods } from '@gnomi/engine/types.ts';
import { resetOutcome, stopText } from './activity.ts';
import { call } from './engine.ts';
import { Note } from './ui.tsx';

export const usd = (amount: number) => `$${amount.toFixed(amount < 1 ? 4 : 2)}`;

function duration(ms: number | null) {
  if (ms === null) return 'not finished';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const OUTCOMES = {
  done: { text: 'Goal reached', style: 'bg-green-100 text-green-900' },
  abandoned: { text: 'Gave up', style: 'bg-amber-100 text-amber-900' },
  budget_exceeded: { text: 'Ran out of steps', style: 'bg-amber-100 text-amber-900' },
  repeated_failure: { text: 'Got stuck', style: 'bg-amber-100 text-amber-900' },
  blocked: { text: 'Blocked', style: 'bg-red-100 text-red-900' },
  incomplete: { text: 'Did not finish', style: 'bg-stone-200 text-stone-800' },
};

function Screenshot({ path, step }: { path: string; step: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    call('get_blob', { path }).then(
      ({ mime, base64 }) => current && setSrc(`data:${mime};base64,${base64}`),
      () => current && setFailed(true),
    );
    return () => {
      current = false;
    };
  }, [path]);
  if (failed) return <p className="text-sm text-stone-500">The screenshot could not be loaded.</p>;
  if (!src) return <p className="text-sm text-stone-500">Loading screenshot...</p>;
  return <img src={src} alt={`The page at step ${step}`} className="w-full rounded-lg border border-stone-200" />;
}

function Friction({ friction }: { friction: ReportFriction }) {
  return (
    <li className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        Step {friction.step_no} - severity {friction.severity} of 4
      </p>
      <p className="mt-1 font-medium text-stone-900">{friction.what}</p>
      <p className="mt-1 text-sm text-stone-700">
        <span className="font-medium">Expected:</span> {friction.expected}
      </p>
      {friction.quote && (
        <blockquote className="mt-3 border-l-4 border-amber-300 pl-3 text-sm italic text-stone-700">&ldquo;{friction.quote}&rdquo;</blockquote>
      )}
      {friction.screenshot && (
        <div className="mt-3">
          <Screenshot path={friction.screenshot} step={friction.step_no} />
        </div>
      )}
      <p className="mt-2 break-all text-xs text-stone-500">{friction.url}</p>
    </li>
  );
}

const BLOCK_REASONS: Record<string, string> = { captcha: 'a CAPTCHA', session_expired: 'an expired login' };
const TRIPWIRES: Record<string, string> = { live_payment_key: 'Live payment key found', production_host: 'Production host reached' };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What the run was allowed to do and what got in its way (idea.md §6.5), so a team can allow a host and run again. */
function Methods({ methods }: { methods: ReportMethods }) {
  const none = 'None';
  const rows: [string, ReactNode][] = [
    ['Logged in as', methods.role ?? 'Nobody: the persona browsed logged out'],
    ['Allowed hosts', `${methods.allowed_hosts.join(', ')}. Every other host was blocked.`],
    [
      'Blocked requests',
      methods.blocked_requests.length === 0 ? (
        none
      ) : (
        <ul>
          {methods.blocked_requests.map(({ host, count: n }) => (
            <li key={host}>
              {host}: {count(n, 'request')}
            </li>
          ))}
        </ul>
      ),
    ],
    [
      'Blocked personas',
      methods.blocked.length === 0 ? (
        none
      ) : (
        <ul>
          {methods.blocked.map((blocked) => (
            <li key={blocked.step_no}>
              Step {blocked.step_no}: {BLOCK_REASONS[blocked.reason] ?? blocked.reason}
              {blocked.detail && ` (${blocked.detail})`}, {blocked.resumed ? 'then resumed' : 'did not resume'}
            </li>
          ))}
        </ul>
      ),
    ],
    [
      'Safety stops',
      methods.tripwires.length === 0 ? (
        none
      ) : (
        <ul>
          {methods.tripwires.map((tripwire) => (
            <li key={`${tripwire.kind}${tripwire.detail}`}>
              {TRIPWIRES[tripwire.kind] ?? tripwire.kind}: {tripwire.detail}
            </li>
          ))}
        </ul>
      ),
    ],
    ['Reset hook', methods.reset === null ? 'Not used' : `${methods.reset.url}: ${resetOutcome(methods.reset).text}`],
  ];
  return (
    <section aria-labelledby="methods-title">
      <h3 id="methods-title" className="mb-2 text-sm font-semibold text-stone-900">
        Methods
      </h3>
      <dl className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 px-3 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="text-stone-500">{label}</dt>
            <dd className="break-words text-stone-900">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function Report({ report }: { report: ReportData }) {
  const outcome = OUTCOMES[report.outcome];
  const stats = [
    ['Steps', String(report.steps)],
    ['Cost', usd(report.cost_usd)],
    ['Duration', duration(report.duration_ms)],
    ['Model calls', `${report.llm_calls} (${(report.input_tokens + report.output_tokens).toLocaleString()} tokens)`],
  ];
  return (
    <section aria-labelledby="report-title" className="space-y-4 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <h2 id="report-title" className="text-base font-semibold text-stone-900">
        Report
      </h2>
      <Note tone="info">{report.banner}</Note>
      <div>
        <p className="text-sm text-stone-600">
          {report.persona.name} ({report.persona.job_title}) tried to: {report.goal}
        </p>
        <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${outcome.style}`}>{outcome.text}</span>
          {report.outcome_text && <span className="text-stone-700">{report.outcome_text}</span>}
        </p>
        {report.status === 'stopped' && report.stop_reason && <p className="mt-2 text-sm text-stone-500">{stopText(report.stop_reason)}</p>}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-stone-50 px-3 py-2">
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="text-sm font-medium text-stone-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="mb-2 text-sm font-semibold text-stone-900">Frictions found ({report.frictions.length})</h3>
        {report.frictions.length === 0 ? (
          <p className="text-sm text-stone-600">The persona did not report any friction in this run.</p>
        ) : (
          <ol className="space-y-3">
            {report.frictions.map((friction) => (
              <Friction key={friction.seq} friction={friction} />
            ))}
          </ol>
        )}
      </div>
      <Methods methods={report.methods} />
    </section>
  );
}
