import { useContext } from 'react';
import type { ReactNode } from 'react';
import type { Outcome, Report as ReportData, ReportDimension, ReportFriction, ReportMethods, ReportPersona, ReportSegment } from '@gnomi/engine/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/engine/report/dimensions.ts';
import { matchesProfileValues, resetOutcome, stopText } from './activity.ts';
import { missingUsageText } from './cost.ts';
import type { ProfileFilter } from './activity.ts';
import { ExportReport } from './ReportExport.tsx';
import { Note, Screenshot, StaticFile, usd } from './ui.tsx';

function duration(ms: number | null) {
  if (ms === null) return 'not finished';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const OUTCOMES: Record<Outcome, { text: string; style: string }> = {
  done: { text: 'Goal reached', style: 'bg-green-100 text-green-900' },
  abandoned: { text: 'Gave up', style: 'bg-amber-100 text-amber-900' },
  budget_exceeded: { text: 'Ran out of steps', style: 'bg-amber-100 text-amber-900' },
  repeated_failure: { text: 'Got stuck', style: 'bg-amber-100 text-amber-900' },
  blocked: { text: 'Blocked', style: 'bg-red-100 text-red-900' },
  incomplete: { text: 'Did not finish', style: 'bg-stone-200 text-stone-800' },
};

function OutcomeChip({ outcome }: { outcome: Outcome }) {
  return <span className={`whitespace-nowrap rounded-full px-3 py-0.5 text-xs font-semibold ${OUTCOMES[outcome].style}`}>{OUTCOMES[outcome].text}</span>;
}

type Inspect = (personaId: string, seq?: number) => void;

function PersonaLink({ id, name, seq, onInspect }: { id: string; name: string; seq?: number; onInspect: Inspect }) {
  if (useContext(StaticFile)) return <span className="font-medium normal-case tracking-normal text-stone-900">{name}</span>; // a file has no inspector
  return (
    <button type="button" onClick={() => onInspect(id, seq)} className="text-left font-medium normal-case tracking-normal text-indigo-700 underline decoration-indigo-300 hover:text-indigo-900">
      {name}
    </button>
  );
}

function Friction({ friction, onInspect }: { friction: ReportFriction; onInspect: Inspect }) {
  return (
    <li className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        <PersonaLink id={friction.persona_id} name={friction.persona_name} seq={friction.seq} onInspect={onInspect} /> - step {friction.step_no} - severity {friction.severity} of 4
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
          <Screenshot path={friction.screenshot} alt={`The page at step ${friction.step_no}, as ${friction.persona_name} saw it`} />
        </div>
      )}
      <p className="mt-2 break-all text-xs text-stone-500">{friction.url}</p>
    </li>
  );
}

const Th = ({ children }: { children: ReactNode }) => (
  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-stone-500">
    {children}
  </th>
);

/** Each segment's completion and friction, then the same two rates weighted by share (roadmap M2). */
function SegmentTable({ report }: { report: ReportData }) {
  const total = report.segments.reduce((sum, segment) => sum + segment.personas, 0);
  const ofPersonas = (segment: ReportSegment, rate: number) => `${pct(rate)} (${Math.round(rate * segment.personas)} of ${segment.personas})`;
  return (
    <section aria-labelledby="segments-title" className="space-y-3">
      <h3 id="segments-title" className="text-sm font-semibold text-stone-900">
        Results by segment
      </h3>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50">
            <tr>
              <Th>Segment</Th>
              <Th>Share</Th>
              <Th>Personas</Th>
              <Th>Reached the goal</Th>
              <Th>Reported friction</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {report.segments.map((segment) => (
              <tr key={segment.id ?? segment.name}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">
                  {segment.name}
                </th>
                <td className="px-3 py-2">{segment.share}%</td>
                <td className="px-3 py-2">{segment.personas}</td>
                <td className="px-3 py-2">{ofPersonas(segment, segment.completion)}</td>
                <td className="px-3 py-2">{ofPersonas(segment, segment.with_friction)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-stone-200 bg-stone-50">
            <tr>
              <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">
                Weighted by share
              </th>
              <td className="px-3 py-2">100%</td>
              <td className="px-3 py-2">{total}</td>
              <td className="px-3 py-2 font-medium">{pct(report.weighted.completion)}</td>
              <td className="px-3 py-2 font-medium">{pct(report.weighted.with_friction)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <ul className="space-y-1 text-sm text-stone-600">
        <li>
          <span className="font-medium text-stone-900">Weighted completion {pct(report.weighted.completion)}.</span> Each segment counts by its share of the audience, not by how many personas it has.
        </li>
        <li>
          <span className="font-medium text-stone-900">Weighted friction {pct(report.weighted.with_friction)}.</span> The share of people who ran into trouble, counted the same way.
        </li>
      </ul>
    </section>
  );
}

function FrictionsBySegment({ report, filtered, onInspect }: { report: ReportData; filtered: boolean; onInspect: Inspect }) {
  const known = new Set(report.segments.map((segment) => segment.id));
  const groups = [
    ...report.segments.map((segment) => ({ key: segment.id ?? segment.name, name: segment.name, items: report.frictions.filter((f) => f.segment_id === segment.id) })),
    { key: 'other', name: 'Other', items: report.frictions.filter((f) => f.segment_id !== null && !known.has(f.segment_id)) },
  ].filter((group) => group.items.length > 0);
  return (
    <section aria-labelledby="frictions-title">
      <h3 id="frictions-title" className="mb-2 text-sm font-semibold text-stone-900">
        Frictions found ({report.frictions.length})
      </h3>
      {groups.length === 0 ? (
        <p className="text-sm text-stone-600">No persona reported any friction in this {filtered ? 'selection' : 'run'}.</p>
      ) : (
        <div className="space-y-5">
          {groups.map((group) => (
            <div key={group.key}>
              <h4 className="mb-2 text-sm font-medium text-stone-800">
                {group.name} ({group.items.length})
              </h4>
              <ol className="space-y-3">
                {group.items.map((friction) => (
                  <Friction key={friction.seq} friction={friction} onInspect={onInspect} />
                ))}
              </ol>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function PersonaOutcomes({ report, onInspect }: { report: ReportData; onInspect: Inspect }) {
  const segmentName = (persona: ReportPersona) => report.segments.find((segment) => segment.id === persona.segment_id)?.name ?? '';
  return (
    <section aria-labelledby="outcomes-title">
      <h3 id="outcomes-title" className="mb-2 text-sm font-semibold text-stone-900">
        What each persona did
      </h3>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50">
            <tr>
              <Th>Persona</Th>
              <Th>Segment</Th>
              <Th>Device</Th>
              <Th>Outcome</Th>
              <Th>Steps</Th>
              <Th>Frictions</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {report.personas.map((persona) => (
              <tr key={persona.id}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <PersonaLink id={persona.id} name={persona.name} onInspect={onInspect} />
                  {persona.job_title && <span className="block text-xs text-stone-500">{persona.job_title}</span>}
                </th>
                <td className="px-3 py-2">{segmentName(persona)}</td>
                <td className="px-3 py-2">{persona.device}</td>
                <td className="px-3 py-2">
                  <OutcomeChip outcome={persona.outcome} />
                  {persona.outcome_text && <span className="mt-1 block max-w-xs break-words text-xs text-stone-500">{persona.outcome_text}</span>}
                </td>
                <td className="px-3 py-2">{persona.steps}</td>
                <td className="px-3 py-2">{persona.frictions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const BLOCK_REASONS: Record<string, string> = { captcha: 'a CAPTCHA', session_expired: 'an expired login' };
const TRIPWIRES: Record<string, string> = { live_payment_key: 'Live payment key found', production_host: 'Production host reached' };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** What the run was set up with, allowed to do and what got in its way (idea.md §6.5), so a team can change a setting and run again. */
function Methods({ methods, personas }: { methods: ReportMethods; personas: ReportPersona[] }) {
  const none = 'None';
  const name = (id: string) => personas.find((persona) => persona.id === id)?.name ?? id;
  const models = Object.entries(methods.models);
  const rows: [string, ReactNode][] = [
    ['Seed', String(methods.seed)],
    ['Logged in as', methods.roles.length > 0 ? methods.roles.join(', ') : 'Nobody: the personas browsed logged out'],
    ['Models', models.length === 0 ? none : <ul>{models.map(([role, choice]) => <li key={role}>{role.replace('_', ' ')}: {choice.provider} {choice.model}</li>)}</ul>],
    ['Budgets', `${usd(methods.budgets.cost_usd)} recorded cost limit, ${methods.budgets.wall_clock_min} minutes, ${methods.budgets.concurrency} browsers at a time`],
    [
      'Concurrency changes',
      methods.concurrency_changes.length === 0 ? (
        none
      ) : (
        <ul>
          {methods.concurrency_changes.map((change, i) => (
            <li key={i}>
              Down to {change.concurrency}: {change.reason}
            </li>
          ))}
        </ul>
      ),
    ],
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
          {methods.blocked.map((blocked, i) => (
            <li key={i}>
              {name(blocked.persona_id)}, step {blocked.step_no}: {BLOCK_REASONS[blocked.reason] ?? blocked.reason}
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

function DimensionTable({ dimension, selected }: { dimension: ReportDimension; selected?: string }) {
  return (
    <section aria-labelledby="profile-results-title" className="space-y-3">
      <h3 id="profile-results-title" className="text-sm font-semibold text-stone-900">Results by profile: {dimension.name}</h3>
      <div className="max-h-80 overflow-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-stone-50"><tr><Th>{dimension.name}</Th><Th>Personas</Th><Th>Reached the goal</Th><Th>Reported friction</Th><Th>Mean latest feeling</Th></tr></thead>
          <tbody className="divide-y divide-stone-100">
            {dimension.values.map((group) => <tr key={attributeKey(group.value)} className={attributeKey(group.value) === selected ? 'bg-indigo-50' : ''}>
              <th scope="row" className="px-3 py-2 text-left font-medium">{formatAttributeValue(group.value)}</th>
              <td className="px-3 py-2">{group.personas}</td>
              <td className="px-3 py-2">{pct(group.completion)}</td>
              <td className="px-3 py-2">{pct(group.with_friction)}</td>
              <td className="px-3 py-2">{group.sentiment === null ? 'No recorded feeling' : group.sentiment.toFixed(2)}</td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500">Full-run groups, without segment weighting. Rates use the personas in each row. Feeling is the mean of each persona's latest valid step feeling, from −2 to 2; personas without one are excluded. Lists match the entire ordered list.</p>
    </section>
  );
}

export function Report({ report, filter = {}, onInspect }: { report: ReportData; filter?: ProfileFilter; onInspect: Inspect }) {
  const selectedPersonas = report.personas.filter((persona) => matchesProfileValues(persona.attributes, filter));
  const ids = new Set(selectedPersonas.map((persona) => persona.id));
  const filtered = !!filter.dimension && !!filter.value;
  const details = filtered ? { ...report, personas: selectedPersonas, frictions: report.frictions.filter((friction) => ids.has(friction.persona_id)) } : report;
  const dimension = report.dimensions?.find((candidate) => candidate.id === filter.dimension) ?? report.dimensions?.[0];
  const stats = [
    ['Personas', String(report.personas.length)],
    ['Steps', String(report.steps)],
    ['Recorded cost', usd(report.cost_usd)],
    ['Duration', duration(report.duration_ms)],
    ['Model calls', `${report.llm_calls} (${(report.input_tokens + report.output_tokens).toLocaleString()} tokens)`],
  ];
  return (
    <section aria-labelledby="report-title" className="space-y-5 rounded-xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 id="report-title" className="text-base font-semibold text-stone-900">
          Report
        </h2>
        <ExportReport report={report} />
      </div>
      <Note tone="info">{report.banner}</Note>
      {filtered && <p role="status" className="text-sm text-stone-700">Showing {details.personas.length} of {report.personas.length} personas in the findings below. Summary totals and grouped results describe the full run.</p>}
      <div>
        <p className="text-sm text-stone-600">The goal: {report.goal}</p>
        {report.status === 'stopped' && report.stop_reason && <p className="mt-2 text-sm text-stone-500">{stopText(report.stop_reason)}</p>}
      </div>
      {filtered && <h3 className="text-sm font-semibold text-stone-900">Full-run totals</h3>}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {stats.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-stone-50 px-3 py-2">
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="text-sm font-medium text-stone-900">{value}</dd>
          </div>
        ))}
      </dl>
      {missingUsageText(report.unreported_usage_calls) && <Note tone="info">{missingUsageText(report.unreported_usage_calls)}</Note>}
      <SegmentTable report={report} />
      {dimension && <DimensionTable dimension={dimension} selected={filter.value} />}
      <FrictionsBySegment report={details} filtered={filtered} onInspect={onInspect} />
      <PersonaOutcomes report={details} onInspect={onInspect} />
      <Methods methods={report.methods} personas={report.personas} />
    </section>
  );
}
