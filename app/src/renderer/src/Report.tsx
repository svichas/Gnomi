import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { Outcome, Report as ReportData, ReportDimension, ReportEvidence, ReportFriction, ReportHomogeneity, ReportLike, ReportMethods, ReportPersona, ReportSegment, ReportSentiment, ReportSpread, ReportTheme, SpreadStats, Trust } from '@gnomi/engine/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/engine/report/dimensions.ts';
import { TRUST_TEXT } from '@gnomi/engine/report/markdown.ts';
import { matchesProfileValues, resetOutcome, stopText } from './activity.ts';
import { BuyerSurvey } from './BuyerSurvey.tsx';
import { missingUsageText } from './cost.ts';
import type { ProfileFilter } from './activity.ts';
import { Note, usd } from './ui.tsx';

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

// Screenshots come through `renderScreenshot`: the app loads them over IPC, an export inlines them.
type RenderScreenshot = (path: string, alt: string) => ReactNode;

/** True while the report is drawn into an exported file, which has no inspector to open. */
export const InFile = createContext(false);

function PersonaLink({ id, name, seq, onInspect }: { id: string; name: string; seq?: number; onInspect: Inspect }) {
  if (useContext(InFile)) return <span className="font-medium normal-case tracking-normal text-stone-900">{name}</span>;
  return (
    <button type="button" onClick={() => onInspect(id, seq)} className="text-left font-medium normal-case tracking-normal text-indigo-700 underline decoration-indigo-300 hover:text-indigo-900">
      {name}
    </button>
  );
}

function Friction({ friction, onInspect, renderScreenshot }: { friction: ReportFriction; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  return (
    <li className="rounded-lg border border-amber-300 bg-amber-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-800">
        <PersonaLink id={friction.persona_id} name={friction.persona_name} seq={friction.seq} onInspect={onInspect} /> - step {friction.step_no} - severity {friction.severity} of 4
      </p>
      <p className="mt-1 font-medium text-stone-900">{friction.what}</p>
      <p className="mt-1 text-sm text-stone-700">
        <span className="font-medium">Expected:</span> {friction.expected}
      </p>
      <Passage passage={friction.passage} />
      {friction.quote && (
        <blockquote className="mt-3 border-l-4 border-amber-300 pl-3 text-sm italic text-stone-700">&ldquo;{friction.quote}&rdquo;</blockquote>
      )}
      {friction.screenshot && <div className="mt-3">{renderScreenshot(friction.screenshot, `The page at step ${friction.step_no}, as ${friction.persona_name} saw it`)}</div>}
      <p className="mt-2 break-all text-xs text-stone-500">{friction.url}</p>
    </li>
  );
}

/** The passage of a text a confusion quotes (engine/src/poi/text.ts). */
function Passage({ passage }: { passage: ReportFriction['passage'] }) {
  if (!passage?.text) return null;
  return (
    <p className="mt-2 text-sm text-stone-700">
      <span className="font-medium">In the text:</span> &ldquo;{passage.text}&rdquo;
    </p>
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

function FrictionsBySegment({ report, filtered, onInspect, renderScreenshot }: { report: ReportData; filtered: boolean; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
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
                  <Friction key={friction.seq} friction={friction} onInspect={onInspect} renderScreenshot={renderScreenshot} />
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

const TRUST: Record<Trust, { text: string; style: string }> = {
  confirmed: { text: 'Confirmed', style: 'border-indigo-300 bg-indigo-50 text-indigo-900' },
  observed: { text: 'Observed', style: 'border-sky-300 bg-sky-50 text-sky-900' },
  reported: { text: 'Reported', style: 'border-stone-300 bg-stone-50 text-stone-800' },
};

/** Trust is always spelled out: within the simulation, never a claim that real people confirmed it (brand.md §5). */
function TrustBadge({ trust }: { trust: Trust }) {
  return (
    <span title={`${TRUST[trust].text}: ${TRUST_TEXT[trust]}`} className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TRUST[trust].style}`}>
      {TRUST[trust].text}
    </span>
  );
}

/** Share of each segment's personas who reached the theme's pages and hit it. */
function Affected({ theme }: { theme: ReportTheme }) {
  const rows = theme.affected.filter((a) => a.reached > 0);
  return (
    <figure>
      <figcaption className="mb-1 text-xs font-medium text-stone-700">Affected, of the personas who reached the page</figcaption>
      <ul className="space-y-1">
        {rows.map((a) => (
          <li key={a.segment_id ?? a.name} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-2 text-xs">
            <span className="truncate text-stone-700">{a.name}</span>
            <span className="h-2 rounded bg-stone-100">
              <span className="block h-full rounded bg-indigo-500" style={{ width: pct(a.rate) }} />
            </span>
            <span className="whitespace-nowrap tabular-nums text-stone-600">
              {a.affected} of {a.reached} ({pct(a.rate)})
            </span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

function Evidence({ evidence, onInspect, renderScreenshot }: { evidence: ReportEvidence; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const at = [
    evidence.step_no === null ? 'end-of-episode survey' : `step ${evidence.step_no}`,
    ...(evidence.frame !== undefined ? [`frame ${evidence.frame + 1}`] : []),
    ...(evidence.passage ? [`characters ${evidence.passage.start}–${evidence.passage.end}`] : []),
  ].join(', ');
  const shot = evidence.screenshot && renderScreenshot(evidence.screenshot, `The page at ${at}, as ${evidence.persona_name} saw it`);
  return (
    <li className={`grid gap-3 border-t border-stone-100 pt-3 ${shot ? 'sm:grid-cols-[12rem_minmax(0,1fr)]' : ''}`}>
      {shot && <div>{shot}</div>}
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-stone-500">
          <PersonaLink id={evidence.persona_id} name={evidence.persona_name} seq={evidence.step_seq ?? evidence.seq} onInspect={onInspect} />
          <span>{at}, severity {evidence.severity} of 4</span>
          <TrustBadge trust={evidence.trust} />
          {evidence.signals.length > 0 && <span>Signals: {evidence.signals.map((s) => s.replace('_', ' ')).join(', ')}</span>}
        </p>
        <p className="text-sm text-stone-900">{evidence.what}</p>
        <Passage passage={evidence.passage} />
        {evidence.quote && <blockquote className="border-l-4 border-stone-300 pl-3 text-sm italic text-stone-700">&ldquo;{evidence.quote}&rdquo;</blockquote>}
        {evidence.url && <p className="break-all text-xs text-stone-500">{evidence.url}</p>}
      </div>
    </li>
  );
}

function Theme({ theme, nested, onInspect, renderScreenshot }: { theme: ReportTheme; nested?: boolean; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const Title = nested ? 'h5' : 'h4';
  return (
    <li className="space-y-3 rounded-lg border border-stone-200 p-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <span className="text-sm font-semibold tabular-nums text-stone-500">{theme.rank}.</span>
        <Title className="min-w-0 flex-1 font-medium text-stone-900">{theme.title}</Title>
        <TrustBadge trust={theme.trust} />
      </div>
      <p className="text-sm text-stone-700">{theme.description}</p>
      <p className="text-xs tabular-nums text-stone-500">
        {count(theme.personas, 'persona')}, {count(theme.frictions, 'friction')}, median severity {theme.severity} of 4
        {theme.named_by === 'rules' && '. Title generated from the page and element'}
      </p>
      <Affected theme={theme} />
      <ul className="space-y-3" aria-label={`Evidence for ${theme.title}`}>
        {theme.evidence.map((evidence, i) => (
          <Evidence key={i} evidence={evidence} onInspect={onInspect} renderScreenshot={renderScreenshot} />
        ))}
      </ul>
      {theme.suggestion && (
        <div className="space-y-1 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-3 text-sm">
          <p className="text-xs font-medium text-stone-500">Generated suggestion: consider it, then validate with real people</p>
          <p className="text-stone-900">
            <span className="font-medium">Suggested change:</span> {theme.suggestion.change}
          </p>
          <p className="text-stone-700">
            <span className="font-medium">Possible solution:</span> {theme.suggestion.solution}
          </p>
        </div>
      )}
    </li>
  );
}

function Themes({ themes, pois, onInspect, renderScreenshot }: { themes: ReportTheme[]; pois: ReportData['pois']; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const list = (shown: ReportTheme[], nested?: boolean) => (
    <ol className="space-y-4">
      {shown.map((theme) => (
        <Theme key={`${theme.poi_id}/${theme.id}`} theme={theme} nested={nested} onInspect={onInspect} renderScreenshot={renderScreenshot} />
      ))}
    </ol>
  );
  return (
    <section aria-labelledby="themes-title" className="space-y-3">
      <h3 id="themes-title" className="text-sm font-semibold text-stone-900">
        Potential frictions, ranked ({themes.length})
      </h3>
      <p className="text-xs text-stone-500">
        Ranked by the segment-weighted share of personas affected × median severity × trust. Confirmed: {TRUST_TEXT.confirmed}. Observed: {TRUST_TEXT.observed}. Reported: {TRUST_TEXT.reported}.
      </p>
      {themes.length === 0 ? (
        <p className="text-sm text-stone-600">No frictions to group into themes in this run.</p>
      ) : pois.length > 1 ? (
        // Themes are ranked within each point of interest, so each gets its own list.
        pois.map((poi) => {
          const own = themes.filter((theme) => theme.poi_id === poi.id);
          return (
            <section key={poi.id} aria-label={`Potential frictions in ${poi.name}`} className="space-y-3">
              <h4 className="text-sm font-medium text-stone-900">{poi.name}</h4>
              {own.length ? list(own, true) : <p className="text-sm text-stone-600">No frictions to group into themes.</p>}
            </section>
          );
        })
      ) : (
        list(themes)
      )}
    </section>
  );
}

const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;

/** A −2…+2 track with the neutral midpoint marked; the number is always shown beside it. */
function SentimentScale({ value }: { value: number }) {
  return (
    <span className="flex items-center gap-2">
      <span aria-hidden="true" className="relative h-2 w-24 rounded bg-stone-100">
        <span className="absolute inset-y-[-2px] left-1/2 w-px bg-stone-400" />
        <span className="absolute top-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600" style={{ left: `${((value + 2) / 4) * 100}%` }} />
      </span>
      <span className="tabular-nums">{signed(value)}</span>
    </span>
  );
}

function Sentiment({ rows }: { rows: ReportSentiment[] }) {
  return (
    <section aria-labelledby="sentiment-title" className="space-y-2">
      <h3 id="sentiment-title" className="text-sm font-semibold text-stone-900">
        Sentiment by segment
      </h3>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50">
            <tr>
              <Th>Segment</Th>
              <Th>Surveyed</Th>
              <Th>Mean sentiment, −2 to +2</Th>
              <Th>Would continue</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {rows.map((row) => (
              <tr key={row.segment_id ?? row.name}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">
                  {row.name}
                </th>
                <td className="px-3 py-2 tabular-nums">{row.surveyed}</td>
                <td className="px-3 py-2">{row.sentiment === null ? 'No answers' : <SentimentScale value={row.sentiment} />}</td>
                <td className="px-3 py-2 tabular-nums">{row.surveyed === 0 ? '-' : pct(row.would_continue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-stone-500">From each persona's end-of-episode survey, 0 is neutral. Means are per segment, without weighting.</p>
    </section>
  );
}

function WentWell({ likes }: { likes: ReportLike[] }) {
  return (
    <section aria-labelledby="went-well-title" className="space-y-2">
      <h3 id="went-well-title" className="text-sm font-semibold text-stone-900">
        What went well
      </h3>
      <ol className="space-y-1 text-sm">
        {likes.slice(0, 10).map((like, i) => (
          <li key={i} className="flex flex-wrap items-baseline justify-between gap-x-3 border-b border-stone-100 pb-1">
            <span className="text-stone-900">{like.text}</span>
            <span className="text-xs tabular-nums text-stone-500">
              {count(like.count, 'mention')} by {count(like.personas, 'persona')}
            </span>
          </li>
        ))}
      </ol>
      {likes.length > 10 && <p className="text-xs text-stone-500">And {count(likes.length - 10, 'more like')} named once or twice.</p>}
    </section>
  );
}

/** Mean sentiment at each round's end on a −2…+2 scale, 0 dashed; each value is also written out beside it. */
function SentimentLine({ rows }: { rows: SpreadStats['sentiment'] }) {
  const points = rows.flatMap((r) => (r.mean === null ? [] : [{ ...r, mean: r.mean }]));
  if (points.length === 0) return <p className="text-xs text-stone-500">No opinions recorded.</p>;
  const width = 168;
  const x = (round: number) => (rows.length === 1 ? (width + 16) / 2 : 24 + ((round - 1) / (rows.length - 1)) * (width - 32));
  const y = (mean: number) => 8 + ((2 - mean) / 4) * 48;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <svg viewBox={`0 0 ${width} 64`} width={width} height={64} aria-hidden="true" className="shrink-0 overflow-visible">
        {([[2, '+2'], [0, '0'], [-2, '−2']] as const).map(([v, label]) => (
          <g key={v}>
            <text x={0} y={y(v) + 3} className="fill-stone-400 text-[9px] tabular-nums">{label}</text>
            <line x1={16} x2={width} y1={y(v)} y2={y(v)} strokeDasharray={v === 0 ? '3 3' : undefined} className={v === 0 ? 'stroke-stone-400' : 'stroke-stone-200'} />
          </g>
        ))}
        <polyline points={points.map((p) => `${x(p.round)},${y(p.mean)}`).join(' ')} fill="none" strokeWidth={2} strokeLinejoin="round" className="stroke-indigo-600" />
        {points.map((p) => (
          <circle key={p.round} cx={x(p.round)} cy={y(p.mean)} r={4} strokeWidth={2} className="fill-indigo-600 stroke-white">
            <title>{`Round ${p.round}: ${signed(p.mean)} (${count(p.personas, 'persona')})`}</title>
          </circle>
        ))}
      </svg>
      <ol className="flex flex-wrap gap-x-3 text-xs tabular-nums text-stone-600" aria-label="Mean sentiment by round, −2 to +2">
        {rows.map((r) => (
          <li key={r.round}>
            Round {r.round}: {r.mean === null ? 'no opinions' : signed(r.mean)}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** One POI's or theme's spread: counts, seed posts, repeats, segments reached, influence and the sentiment line. */
function SpreadBody({ stats, personas, onInspect }: { stats: SpreadStats; personas: ReportPersona[]; onInspect: Inspect }) {
  const name = (id: string) => personas.find((persona) => persona.id === id)?.name ?? id;
  const crossed = stats.segments.filter((segment) => !segment.seed).length;
  const figures = [
    ['Posts', stats.posts],
    ['First-hand', stats.first_hand.length],
    ['Second-hand', stats.second_hand.length],
    ['Influence edges', stats.influence.length],
  ] as const;
  return (
    <div className="space-y-3 text-sm">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {figures.map(([label, value]) => (
          <div key={label} className="rounded-lg bg-stone-50 px-3 py-1.5">
            <dt className="text-xs text-stone-500">{label}</dt>
            <dd className="font-medium tabular-nums text-stone-900">{value}</dd>
          </div>
        ))}
      </dl>
      <div>
        <p className="text-xs font-medium text-stone-700">Seed posts</p>
        <ul className="mt-1 space-y-2">
          {stats.seeds.map((post) => (
            <li key={post.post_id} className="border-l-4 border-stone-200 pl-3">
              <p className="flex flex-wrap gap-x-2 text-xs text-stone-500">
                <PersonaLink id={post.persona_id} name={post.persona_name} seq={post.seq} onInspect={onInspect} />
                <span>round {post.round}</span>
                {post.injected && <span className="font-medium text-amber-800">injected by the test harness</span>}
              </p>
              <p className="text-stone-900">&ldquo;{post.text}&rdquo;</p>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-stone-700">
        <span className="font-medium">Repeated without their own friction:</span>{' '}
        {stats.second_hand.length === 0 ? 'nobody' : stats.second_hand.map(name).join(', ')}
      </p>
      <p className="text-stone-700">
        <span className="font-medium">Segments reached:</span>{' '}
        {stats.segments.map((segment) => `${segment.name} ${segment.personas}${segment.seed ? ' (seed)' : ''}`).join(', ') || 'none'}. Crossed into {count(crossed, 'other segment')}.
      </p>
      {stats.influence.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-700">Influence</p>
          <ul className="text-stone-700">
            {stats.influence.slice(0, 5).map((edge) => (
              <li key={`${edge.seq}/${edge.post_id}`}>
                {name(edge.from)} → {name(edge.to)}, round {edge.round}, sentiment {signed(edge.delta)}
              </li>
            ))}
          </ul>
          {stats.influence.length > 5 && <p className="text-xs text-stone-500">And {count(stats.influence.length - 5, 'more edge')}.</p>}
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-stone-700">Mean sentiment by round, −2 to +2</p>
        <SentimentLine rows={stats.sentiment} />
      </div>
    </div>
  );
}

/** How talk about the product and each theme travelled on the simulated feed (tech.md §8.2 step 7). */
function Spread({ spread, personas, onInspect }: { spread: ReportSpread[]; personas: ReportPersona[]; onInspect: Inspect }) {
  return (
    <section aria-labelledby="spread-title" className="space-y-3">
      <h3 id="spread-title" className="text-sm font-semibold text-stone-900">
        Opinion spread
      </h3>
      <p className="text-xs text-stone-500">
        How talk travelled on the simulated feed. First-hand: personas with their own friction in it. Second-hand: personas who posted about it without one. Influence: a cited post moved a persona's sentiment by 0.5 or more.
      </p>
      {spread.length === 0 && <p className="text-sm text-stone-600">No post was about a point of interest.</p>}
      {spread.map((poi) => (
        <div key={poi.poi_id} className="space-y-4">
          <div className="space-y-2 rounded-lg border border-stone-200 p-4">
            <h4 className="font-medium text-stone-900">About {poi.name}</h4>
            <SpreadBody stats={poi} personas={personas} onInspect={onInspect} />
          </div>
          {poi.themes.length > 0 && (
            <ol className="space-y-4" aria-label={`Themes talked about on the feed, about ${poi.name}`}>
              {poi.themes.map((theme) => (
                <li key={theme.theme_id} className="space-y-2 rounded-lg border border-stone-200 p-4">
                  <h4 className="font-medium text-stone-900">
                    <span className="mr-2 tabular-nums text-stone-500">{theme.rank}.</span>
                    {theme.title}
                  </h4>
                  <SpreadBody stats={theme} personas={personas} onInspect={onInspect} />
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </section>
  );
}

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
    ...(methods.signal_thresholds === undefined ? [] : [['Signal thresholds', methods.signal_thresholds === null ? 'Not frozen in this run' : (
      <ul>{Object.entries(methods.signal_thresholds).map(([key, value]) => <li key={key}>{key.replaceAll('_', ' ')}: {JSON.stringify(value)}</li>)}</ul>
    )] as [string, ReactNode]]),
    ...(methods.homogeneity ? [['Homogeneity', <Homogeneity value={methods.homogeneity} />] as [string, ReactNode]] : []),
    ...(methods.limitations === undefined ? [] : [['Limitations', methods.limitations.length === 0 ? none : <ul className="list-disc pl-4">{methods.limitations.map((text) => <li key={text}>{text}</li>)}</ul>] as [string, ReactNode]]),
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

const noScreenshot: RenderScreenshot = () => null;

export function Report({ report, filter = {}, onInspect, renderScreenshot = noScreenshot }: { report: ReportData; filter?: ProfileFilter; onInspect: Inspect; renderScreenshot?: RenderScreenshot }) {
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
      <h2 id="report-title" className="text-base font-semibold text-stone-900">
        Report
      </h2>
      <Note tone="info">{report.banner}</Note>
      {filtered && <p role="status" className="text-sm text-stone-700">Showing {details.personas.length} of {report.personas.length} personas in the findings below. Summary totals and grouped results describe the full run.</p>}
      <div>
        <p className="text-sm text-stone-600">The goal: {report.goal}</p>
        {report.pois.length > 1 && <p className="text-sm text-stone-600">Points of interest, in the order personas used them: {report.pois.map((poi) => poi.name).join(', ')}</p>}
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
      {report.themes && <Themes themes={report.themes} pois={report.pois} onInspect={onInspect} renderScreenshot={renderScreenshot} />}
      {report.sentiment && report.sentiment.length > 0 && <Sentiment rows={report.sentiment} />}
      {report.buyers && report.buyers.length > 0 && <BuyerSurvey rows={report.buyers} pois={report.pois} />}
      {report.went_well && report.went_well.length > 0 && <WentWell likes={report.went_well} />}
      {report.spread && <Spread spread={report.spread} personas={report.personas} onInspect={onInspect} />}
      <FrictionsBySegment report={details} filtered={filtered} onInspect={onInspect} renderScreenshot={renderScreenshot} />
      <PersonaOutcomes report={details} onInspect={onInspect} />
      <Methods methods={report.methods} personas={report.personas} />
    </section>
  );
}
