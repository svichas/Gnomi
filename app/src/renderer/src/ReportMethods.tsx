import type { ReactNode } from 'react';
import type { ReportHomogeneity, ReportMethods, ReportPersona } from '@gnomi/simulation/types.ts';
import { BLOCK_REASON_TEXT } from '@gnomi/simulation/report/markdown.ts';
import { resetOutcome } from './activity.ts';
import { usd } from './ui.tsx';
import { count } from './reportParts.tsx';

function Homogeneity({ value }: { value: ReportHomogeneity }) {
  const mean = (x: number | null) => (x === null ? 'too few to compare' : x.toFixed(2));
  return (
    <div className="space-y-1">
      <p>
        Posts {mean(value.posts)} ({count(value.post_count, 'post')}), persona backgrounds {mean(value.narratives)}. Mean pairwise TF-IDF cosine, 0 to 1; a warning at {value.threshold.toFixed(2)}.
      </p>
      {value.warning && <p className="font-medium text-amber-800">{value.warning}</p>}
    </div>
  );
}

const BLOCK_REASONS: Record<string, string> = { captcha: 'a CAPTCHA', session_expired: 'an expired login' };
const TRIPWIRES: Record<string, string> = { live_payment_key: 'Live payment key found', production_host: 'Production host reached' };

/** What the run was set up with, allowed to do and what got in its way (idea.md §6.5), so a team can change a setting and run again. */
export function Methods({ methods, personas }: { methods: ReportMethods; personas: ReportPersona[] }) {
  const none = 'None';
  const name = (id: string) => personas.find((persona) => persona.id === id)?.name ?? id;
  const models = Object.entries(methods.models);
  // biome-ignore-start lint/correctness/useJsxKeyInIterable: each row is a [label, value] pair whose value renders alone in its <dd>, not as a list
  const rows: [string, ReactNode][] = [
    ['Seed', String(methods.seed)],
    ['Logged in as', methods.roles.length > 0 ? methods.roles.join(', ') : 'Nobody: the personas browsed logged out'],
    ['Models', models.length === 0 ? none : <ul>{models.map(([role, choice]) => <li key={role}>{role.replace('_', ' ')}: {choice.provider} {choice.model}</li>)}{methods.check_model && <li>evidence check: {methods.check_model.provider} {methods.check_model.model}</li>}</ul>],
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
          {methods.blocked_requests.map(({ host, count: n, reason }) => (
            <li key={`${host}/${reason ?? ''}`}>
              {host}: {count(n, 'request')}
              {reason && ` (${BLOCK_REASON_TEXT[reason]})`}
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
    ...(methods.signal_thresholds === undefined ? [] : [['Signal thresholds', methods.signal_thresholds === null ? 'Not frozen in this run' : (
      <ul>{Object.entries(methods.signal_thresholds).map(([key, value]) => <li key={key}>{key.replaceAll('_', ' ')}: {JSON.stringify(value)}</li>)}</ul>
    )] as [string, ReactNode]]),
    ...(methods.undersized_targets ? [['Undersized tap targets', (
      <div className="space-y-1">
        <p>An audit, not findings: mobile tap targets below the signal threshold.</p>
        <ul>{methods.undersized_targets.map((target) => <li key={`${target.page}${target.element}${target.width}${target.height}`}>{target.page}: {target.element ?? 'unnamed element'}, {target.width}×{target.height} px, {count(target.personas, 'persona')}</li>)}</ul>
      </div>
    )] as [string, ReactNode]] : []),
    ...(methods.homogeneity ? [['Homogeneity', <Homogeneity value={methods.homogeneity} />] as [string, ReactNode]] : []),
    ...(methods.limitations === undefined ? [] : [['Limitations', methods.limitations.length === 0 ? none : <ul className="list-disc pl-4">{methods.limitations.map((text) => <li key={text}>{text}</li>)}</ul>] as [string, ReactNode]]),
  ];
  // biome-ignore-end lint/correctness/useJsxKeyInIterable: rows above
  return (
    <dl className="divide-y divide-stone-100 rounded-lg border border-stone-200 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="grid gap-1 px-3 py-2 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="text-stone-500">{label}</dt>
          <dd className="break-words text-stone-900">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
