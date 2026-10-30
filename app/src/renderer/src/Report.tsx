import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { isUnrated } from '@gnomi/simulation/types.ts';
import type { EvidenceLevel, Outcome, Prevalence, Report as ReportData, ReportComparison, ReportDimension, ReportEvidence, ReportFriction, ReportLike, ReportPersona, ReportTheme, Trust } from '@gnomi/simulation/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/simulation/report/dimensions.ts';
import { COST_SCOPE_TEXT, missingUsageText, poiName, PRIORITY_NOTE, PRIORITY_TEXT, repeatNote, SET_ASIDE_TEXT, setAsideCause, setNote, themePoi, themePriority, TRUST_TEXT, trustMix } from '@gnomi/simulation/report/markdown.ts';
import type { RepeatSet } from '@gnomi/simulation/report/repeats.ts';
import { writtenSummary } from '@gnomi/simulation/report/summary.ts';
import { matchesProfileValues, stopText } from './activity.ts';
import { BuyerSurvey } from './BuyerSurvey.tsx';
import { ComparisonDetails, ComparisonReport } from './ComparisonReport.tsx';
import type { ProfileFilter } from './activity.ts';
import { Icon, PersonaAvatar } from './Icon.tsx';
import { Note, usd } from './ui.tsx';
import { count, Fold, heading, InFile, PersonaLink, pct, SectionHeading, signed, Th, Tile } from './reportParts.tsx';
import type { Inspect, Tone } from './reportParts.tsx';
import { Methods } from './ReportMethods.tsx';
import { Spread } from './ReportSpread.tsx';

function duration(ms: number | null) {
  if (ms === null) return 'not finished';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const OUTCOMES: Record<Outcome, { text: string; tone: Tone }> = {
  done: { text: 'Reached the goal', tone: 'good' },
  abandoned: { text: 'Gave up', tone: 'warn' },
  budget_exceeded: { text: 'Ran out of steps', tone: 'warn' },
  repeated_failure: { text: 'Got stuck', tone: 'warn' },
  model_failed: { text: 'Model failed to answer', tone: 'neutral' },
  blocked: { text: 'Blocked', tone: 'bad' },
  incomplete: { text: 'Did not finish', tone: 'neutral' },
  not_started: { text: 'Did not start', tone: 'neutral' },
};

function OutcomeChip({ outcome }: { outcome: Outcome }) {
  return <span data-tone={OUTCOMES[outcome].tone} className="tone-chip">{OUTCOMES[outcome].text}</span>;
}

// The persona prompt's scale (simulation/src/agent/prompt.ts): 1 is a small irritation, 4 means the persona cannot go on.
const SEVERITY = {
  4: { text: 'Blocker', plain: 'they could not go on', tone: 'bad' },
  3: { text: 'Major', plain: 'hard to get past', tone: 'high' },
  2: { text: 'Moderate', plain: 'slowed them down', tone: 'warn' },
  1: { text: 'Minor', plain: 'a small irritation', tone: 'neutral' },
} as const satisfies Record<number, { text: string; plain: string; tone: Tone }>;
const LEVELS = [4, 3, 2, 1] as const;

/** A theme's severity is a median, so it can fall between two levels: it rounds to the worse one. */
const level = (severity: number) => Math.min(4, Math.max(1, Math.round(severity))) as keyof typeof SEVERITY;

export function SeverityChip({ severity }: { severity: number }) {
  const { text, plain, tone } = SEVERITY[level(severity)];
  return <span data-tone={tone} title={`Severity ${severity} of 4: ${plain}`} className="tone-chip">{text}</span>;
}

const PRIORITY_TONE = { fix_now: 'bad', next: 'warn', later: 'neutral' } as const satisfies Record<keyof typeof PRIORITY_TEXT, Tone>;

function PriorityChip({ priority }: { priority: keyof typeof PRIORITY_TEXT }) {
  return <span data-tone={PRIORITY_TONE[priority]} title={PRIORITY_NOTE} className="tone-chip">{PRIORITY_TEXT[priority]}</span>;
}

function SeverityLegend() {
  return (
    <ul aria-label="Severity" className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-600">
      {LEVELS.map((n) => (
        <li key={n} className="flex items-center gap-1.5">
          <span data-tone={SEVERITY[n].tone} className="tone-dot" />
          <span><span className="font-medium text-stone-900">{SEVERITY[n].text}</span>: {SEVERITY[n].plain}</span>
        </li>
      ))}
    </ul>
  );
}

const bySeverity = (a: ReportFriction, b: ReportFriction) => b.severity - a.severity || a.seq - b.seq;

// How much a finding rests on (simulation/src/report/themes.ts prevalence). Reports before it only have the persona count.
const EVIDENCE_LEVEL = {
  strong: { text: 'Strong evidence', plain: 'three or more personas, and at least a quarter of those who used it' },
  some: { text: 'Some evidence', plain: 'two or more personas' },
  single: { text: 'One persona', plain: 'only one persona met it: worth a look, not yet a pattern' },
  none: { text: 'None first-hand', plain: 'every persona who reported it had read about it in the feed first' },
} as const satisfies Record<EvidenceLevel, { text: string; plain: string }>;
const evidenceOf = (finding: { prevalence?: Prevalence; personas: number }): EvidenceLevel => finding.prevalence?.level ?? (finding.personas <= 1 ? 'single' : 'some');
// One persona or none met it first-hand: worth a look, not a reason to fix something first.
const isSingle = (theme: ReportTheme) => evidenceOf(theme) === 'single' || evidenceOf(theme) === 'none';

function EvidenceChip({ finding }: { finding: { prevalence?: Prevalence; personas: number } }) {
  const { text, plain } = EVIDENCE_LEVEL[evidenceOf(finding)];
  return <span title={`${text}: ${plain}`} className="whitespace-nowrap rounded-full border border-stone-300 px-2.5 py-0.5 text-xs font-medium text-stone-800">{text}</span>;
}

/** "4 of 20 personas (20%)", with the plausible range for this few personas a hover away. */
function Share({ finding, noun }: { finding: { prevalence?: Prevalence; personas: number }; noun?: string }) {
  const p = finding.prevalence;
  if (!p) return <>{count(finding.personas, 'persona')}{noun && ` ${noun}`}</>;
  return (
    <span title={`95% range ${pct(p.low)} to ${pct(p.high)} among this run's ${count(p.exposed, 'simulated persona')}, assuming independent personas; not an estimate of real users.`}>
      {p.personas} of {count(p.exposed, 'persona')}{noun && ` ${noun}`} ({pct(p.share)}, likely {pct(p.low)}–{pct(p.high)})
    </span>
  );
}

const mood = (x: number) => (x <= -1 ? 'Negative' : x < -0.25 ? 'Leaning negative' : x <= 0.25 ? 'Neutral' : x < 1 ? 'Leaning positive' : 'Positive');

// Screenshots come through `renderScreenshot`: the app loads them over IPC, an export inlines them.
type RenderScreenshot = (path: string, alt: string) => ReactNode;

/** Three quick signals: completion, shared issues, and sentiment or audience size. Always the full run. */
function Glance({ report, themes: all }: { report: ReportData; themes: ReportTheme[] }) {
  // A competitor's problems are not the team's to fix.
  const themes = all.filter((t) => !report.pois.find((poi) => poi.id === t.poi_id)?.competitor);
  const total = report.personas.length;
  const outcomes = (Object.keys(OUTCOMES) as Outcome[]).map((outcome) => [outcome, report.personas.filter((p) => p.outcome === outcome).length] as const).filter(([, n]) => n > 0);
  const done = outcomes.find(([outcome]) => outcome === 'done')?.[1] ?? 0;
  const started = total - outcomes.reduce((sum, [outcome, n]) => sum + (isUnrated(outcome) ? n : 0), 0);
  const problems = report.themes ? themes.filter((t) => !isSingle(t) && t.category !== 'objection') : report.frictions;
  const answers = report.sentiment?.filter((row) => row.sentiment !== null && row.surveyed > 0) ?? [];
  const surveyed = answers.reduce((sum, row) => sum + row.surveyed, 0);
  const feeling = surveyed ? answers.reduce((sum, row) => sum + row.sentiment! * row.surveyed, 0) / surveyed : null;
  const carryOn = surveyed ? answers.reduce((sum, row) => sum + row.would_continue * row.surveyed, 0) / surveyed : 0;
  return (
    <section aria-label="At a glance" className="report-stats">
      <Tile icon="check" tone="good" label="Reached the goal" value={`${done} of ${started}`} detail={started ? `${pct(done / started)} of those who started` : 'No rated attempts'} />
      <Tile icon="alert" tone={problems.length ? 'warn' : 'good'} label={report.themes ? 'Issues to explore' : 'Frictions reported'} value={String(problems.length)} detail={report.themes ? 'Shared by simulated users' : 'Individual reports'} />
      {feeling !== null
        ? <Tile icon="message" tone={feeling < -0.25 ? 'warn' : feeling > 0.25 ? 'good' : 'neutral'} label="Overall feeling" value={mood(feeling)} detail={`${pct(carryOn)} would keep using it`} />
        : <Tile icon="people" tone="neutral" label="Simulated users" value={String(total)} detail={started < total ? `${total - started} without a rated attempt` : 'Different perspectives'} />}
    </section>
  );
}

/** The passage of a text a confusion quotes (simulation/src/poi/text.ts). */
function Passage({ passage }: { passage: ReportFriction['passage'] }) {
  if (!passage?.text) return null;
  return (
    <p className="text-sm text-stone-700">
      <span className="font-medium">In the text:</span> &ldquo;{passage.text}&rdquo;
    </p>
  );
}

const TRUST: Record<Trust, { text: string; style: string }> = {
  confirmed: { text: 'Confirmed', style: 'border-indigo-300 bg-indigo-50 text-indigo-900' },
  observed: { text: 'Observed', style: 'border-sky-300 bg-sky-50 text-sky-900' },
  reported: { text: 'Reported', style: 'border-stone-300 bg-stone-50 text-stone-800' },
};

/** Trust is always spelled out: within the simulation, never a claim that real people confirmed it (brand.md §5). A theme shows its mix. */
function TrustBadge({ trust, counts }: { trust: Trust; counts?: Record<Trust, number> }) {
  return (
    <span title={`${TRUST[trust].text}: ${TRUST_TEXT[trust]}`} className={`whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TRUST[trust].style}`}>
      {counts ? trustMix(counts) : TRUST[trust].text}
    </span>
  );
}

/** Share of each segment's personas who reached the theme's pages and hit it. */
function Affected({ theme }: { theme: ReportTheme }) {
  const rows = theme.affected.filter((a) => a.reached > 0);
  return (
    <figure>
      <figcaption className="mb-1 text-xs font-medium text-stone-700">Met it first-hand, of the personas who reached the page</figcaption>
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
          <span>{at}</span>
          <SeverityChip severity={evidence.severity} />
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

/** The repeat set of the report's run, so each finding can say how it did across the set. */
const Repeats = createContext<{ set?: RepeatSet; run_id: string }>({ run_id: '' });

/** Keep the finding readable in one line; the recommendation and evidence open together. */
function Priority({ theme, number, poi, priority, onInspect, renderScreenshot }: { theme: ReportTheme; number: number; poi?: string; priority: ReturnType<typeof themePriority>; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const inFile = useContext(InFile);
  const { set, run_id } = useContext(Repeats);
  const repeats = repeatNote(set, run_id, theme);
  const affected = theme.prevalence?.personas ?? theme.personas;
  return (
    <li className="report-finding" data-tone={SEVERITY[level(theme.severity)].tone}>
      <details open={inFile}>
        <summary className="report-finding-summary">
          <span className="report-finding-number" aria-hidden="true">{number.toString().padStart(2, '0')}</span>
          <div className="report-finding-copy">
            <h4>{theme.title}</h4>
            <p><Icon name="people" size={13} /><span>{count(affected, 'simulated user')}{affected ? ' experienced this' : ' experienced this first-hand'}{poi && ` · ${poi}`}{repeats && ` · ${repeats.appeared}`}{repeats?.one_family && ` · ${repeats.one_family}`}</span></p>
          </div>
          {priority && <PriorityChip priority={priority} />}
          <SeverityChip severity={theme.severity} />
          <Icon name="chevron" size={16} />
        </summary>
        <div className="report-finding-body">
          <p className="text-sm text-stone-700">{theme.description}</p>
          {theme.suggestion && <div className="report-suggestion">
            <Icon name="spark" size={18} />
            <div><h5>Suggested change</h5><p>{theme.suggestion.change}</p><p className="report-suggestion-how">{theme.suggestion.solution}</p><small>Generated suggestion. Validate with real people.</small></div>
          </div>}
          <div className="report-evidence-heading"><Icon name="activity" size={16} /><h5>Behind this finding</h5></div>
          <div className="flex flex-wrap items-center gap-2"><EvidenceChip finding={theme} /><TrustBadge trust={theme.trust} counts={theme.trust_counts} /></div>
          <p className="text-xs text-stone-500"><Share finding={theme} noun="affected" />{theme.heard_first ? `, +${theme.heard_first} more after reading the feed` : ''}, {count(theme.frictions, 'report')}</p>
          <Affected theme={theme} />
          <ul className="space-y-3" aria-label={`Evidence for ${theme.title}`}>
            {theme.evidence.map((evidence, i) => <Evidence key={i} evidence={evidence} onInspect={onInspect} renderScreenshot={renderScreenshot} />)}
          </ul>
          {theme.named_by === 'rules' && <p className="text-xs text-stone-500">Title generated from the page and element.</p>}
          {repeats && repeats.other_titles.length > 0 && <p className="text-xs text-stone-500">Named in other runs: {repeats.other_titles.join('; ')}</p>}
        </div>
      </details>
    </li>
  );
}

const TOP = 5;

function Findings({ themes, pois, empty, onInspect, renderScreenshot }: { themes: ReportTheme[]; pois: ReportData['pois']; empty: string; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const inFile = useContext(InFile);
  const items = (shown: ReportTheme[], offset = 0) => shown.map((theme, i) => <Priority key={`${theme.poi_id}/${theme.id}`} theme={theme} number={offset + i + 1} poi={themePoi(theme, pois)} priority={themePriority(theme, pois)} onInspect={onInspect} renderScreenshot={renderScreenshot} />);
  if (themes.length === 0) return <div className="report-empty"><Icon name="check" size={20} /><p>{empty}</p></div>;
  return <div className="report-findings">
    <ol className="report-finding-list">{items(themes.slice(0, TOP))}</ol>
    {themes.length > TOP && <details className="report-more report-overflow" open={inFile}>
      <summary>Show {count(themes.length - TOP, 'more finding')}</summary>
      <ol className="report-finding-list" start={TOP + 1}>{items(themes.slice(TOP), TOP)}</ol>
    </details>}
  </div>;
}

/** Themes the evidence check took out of the ranking, each with the model's reason; nothing here is lost, only moved. */
function SetAside({ themes, pois }: { themes: ReportTheme[]; pois: ReportData['pois'] }) {
  return <div className="space-y-3">
    <p className="text-sm text-stone-600">{SET_ASIDE_TEXT}</p>
    <ul className="space-y-3">
      {themes.map((theme) => {
        const poi = themePoi(theme, pois);
        return <li key={`${theme.poi_id}/${theme.id}`}>
          <p className="text-sm font-medium text-stone-900">{theme.title}</p>
          <p className="text-sm text-stone-700">The model&rsquo;s review points to {setAsideCause(theme)}: {theme.check?.reason}</p>
          <p className="text-xs text-stone-500">{count(theme.personas, 'persona')}, {count(theme.frictions, 'report')}{poi && ` · ${poi}`}</p>
        </li>;
      })}
    </ul>
  </div>;
}

function Priorities({ themes, setAside, pois, onInspect, renderScreenshot }: { themes: ReportTheme[]; setAside: ReportTheme[]; pois: ReportData['pois']; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const own = themes.filter((theme) => !pois.find((poi) => poi.id === theme.poi_id)?.competitor);
  const shared = own.filter((t) => !isSingle(t));
  const problems = shared.filter((t) => t.category !== 'objection');
  const objections = shared.filter((t) => t.category === 'objection');
  const singles = own.filter(isSingle);
  const competitors = themes.filter((theme) => pois.find((poi) => poi.id === theme.poi_id)?.competitor);
  const ownSetAside = setAside.some((theme) => !pois.find((poi) => poi.id === theme.poi_id)?.competitor);
  const props = { pois, onInspect, renderScreenshot };
  return (
    <div className="report-priorities">
      <section aria-labelledby="themes-title">
        <SectionHeading id="themes-title" title={<>What to improve <span>{problems.length}</span></>} hint="Where simulated users found friction. Fix now, Next and Later suggest where to look first in this run. Open an issue for the suggested change and evidence." />
        <Findings themes={problems} empty={singles.length ? 'No shared issues yet. Individual observations are below.' : ownSetAside ? 'No shared issues are left. What the evidence check set aside is below.' : 'No shared issues were reported in this run.'} {...props} />
      </section>
      {objections.length > 0 && <Fold id="objections-title" title={`Reasons for hesitation (${objections.length})`} hint="What made users doubt or reconsider" icon="message"><Findings themes={objections} empty="" {...props} /></Fold>}
      {singles.length > 0 && <Fold id="singles-title" title={`Individual observations (${singles.length})`} hint="Reported by one user, or heard from others; not yet a pattern" icon="people"><Findings themes={singles} empty="" {...props} /></Fold>}
      {setAside.length > 0 && <Fold id="set-aside-title" title={`Set aside by the evidence check (${setAside.length})`} hint="A model's review points away from the product; each reason is here" icon="report"><SetAside themes={setAside} pois={pois} /></Fold>}
      {competitors.length > 0 && <Fold id="competitor-findings-title" title={`Competitor findings (${competitors.length})`} hint="Friction on the other products in this run" icon="globe"><Findings themes={competitors} empty="" {...props} /></Fold>}
    </div>
  );
}

/** Older reports have individual frictions instead of grouped themes. */
function LegacyFindings({ report, onInspect }: { report: ReportData; onInspect: Inspect }) {
  const inFile = useContext(InFile);
  return <section aria-labelledby="themes-title">
    <SectionHeading id="themes-title" title={<>Reported friction <span>{report.frictions.length}</span></>} hint="Individual observations from simulated users." />
    {report.frictions.length === 0 ? <div className="report-empty"><Icon name="check" size={20} /><p>No friction was reported in this run.</p></div> : <ol className="report-finding-list">
      {[...report.frictions].sort(bySeverity).map((friction, i) => <li key={friction.seq} className="report-finding" data-tone={SEVERITY[level(friction.severity)].tone}>
        <details open={inFile}>
          <summary className="report-finding-summary"><span className="report-finding-number" aria-hidden="true">{(i + 1).toString().padStart(2, '0')}</span><div className="report-finding-copy"><h4>{friction.what}</h4><p>{friction.persona_name} · Step {friction.step_no}</p></div><SeverityChip severity={friction.severity} /><Icon name="chevron" size={16} /></summary>
          <div className="report-finding-body"><p className="text-sm text-stone-700"><strong>They expected:</strong> {friction.expected}</p>{friction.quote && <blockquote className="text-sm text-stone-700">“{friction.quote}”</blockquote>}<p className="text-xs text-stone-500">Reported by <PersonaLink id={friction.persona_id} name={friction.persona_name} seq={friction.seq} onInspect={onInspect} />. Screenshots and the full account are in User journeys below.</p></div>
        </details>
      </li>)}
    </ol>}
  </section>;
}

function WentWell({ likes }: { likes: ReportLike[] }) {
  const shown = likes.filter((like) => evidenceOf(like) !== 'single');
  const once = likes.length - shown.length;
  return (
    <section aria-labelledby="went-well-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="went-well-title" className={heading}>What went well</h3>
        <p className="text-sm text-stone-600">What the personas said worked, the most often named first.</p>
      </div>
      {shown.length === 0 && <p className="text-sm text-stone-600">Nothing was named by more than one persona.</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {shown.slice(0, 10).map((like, i) => (
          <li key={i} data-tone="good" className="tone-edge space-y-1 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm">
            <span className="block font-medium text-stone-900">{like.text}</span>
            {like.description && <span className="block text-stone-700">{like.description}</span>}
            <span className="block text-xs tabular-nums text-stone-500">
              <Share finding={like} noun="named it" />
              {like.where?.length ? `, about ${like.where.slice(0, 3).join(', ')}` : ''}
            </span>
          </li>
        ))}
      </ul>
      {(shown.length > 10 || once > 0) && (
        <p className="text-xs text-stone-500">
          {shown.length > 10 && `And ${count(shown.length - 10, 'more')} named by a few. `}
          {once > 0 && `${count(once, 'more like')} named by one persona each.`}
        </p>
      )}
    </section>
  );
}

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

/** A rate as a short bar and its count, so a column reads at a glance. */
function Rate({ rate, of, tone }: { rate: number | null; of: number; tone: Tone }) {
  if (rate === null) return '-'; // nobody started
  return (
    <span className="flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden="true" className="h-1.5 w-14 overflow-hidden rounded-full bg-stone-100">
        <span data-tone={tone} className="tone-fill block h-full" style={{ width: pct(rate) }} />
      </span>
      <span className="tabular-nums">
        {pct(rate)} <span className="text-stone-500">({Math.round(rate * of)} of {of})</span>
      </span>
    </span>
  );
}

/** Each segment's completion, friction and survey answers, then the two rates weighted by share (roadmap M2). */
function SegmentTable({ report }: { report: ReportData }) {
  const surveys = report.sentiment && report.sentiment.length > 0 ? report.sentiment : null;
  const pois = report.segments[0]?.pois ?? []; // only with several POIs of the team's own
  const name = (id: string) => report.pois.find((poi) => poi.id === id)?.name ?? id;
  const started = (segment: ReportData['segments'][number]) => segment.personas - (segment.outcomes.not_started ?? 0) - (segment.outcomes.model_failed ?? 0);
  const notStarted = report.segments.reduce((sum, segment) => sum + (segment.outcomes.not_started ?? 0), 0);
  const noAnswer = report.segments.reduce((sum, segment) => sum + (segment.outcomes.model_failed ?? 0), 0);
  return (
    <section aria-labelledby="segments-title" className="space-y-3">
      <h3 id="segments-title" className={heading}>Results by segment</h3>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50">
            <tr>
              <Th>Segment</Th>
              <Th>Share</Th>
              <Th>Reached the goal</Th>
              {pois.map((poi) => <Th key={poi.poi_id}>Reached it on {name(poi.poi_id)}</Th>)}
              <Th>Ran into friction</Th>
              {surveys && <Th>Mood, −2 to +2</Th>}
              {surveys && <Th>Would carry on</Th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {report.segments.map((segment) => {
              const survey = surveys?.find((row) => row.segment_id === segment.id);
              return (
                <tr key={segment.id ?? segment.name}>
                  <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">{segment.name}</th>
                  <td className="px-3 py-2 tabular-nums">{segment.share}%</td>
                  <td className="px-3 py-2"><Rate rate={segment.completion} of={started(segment)} tone="good" /></td>
                  {pois.map((poi) => {
                    const row = segment.pois?.find((p) => p.poi_id === poi.poi_id);
                    return <td key={poi.poi_id} className="px-3 py-2">{row?.personas ? <Rate rate={row.completion} of={row.personas} tone="good" /> : '-'}</td>;
                  })}
                  <td className="px-3 py-2"><Rate rate={segment.with_friction} of={started(segment)} tone="warn" /></td>
                  {surveys && <td className="px-3 py-2">{survey?.sentiment == null ? 'No answers' : <SentimentScale value={survey.sentiment} />}</td>}
                  {surveys && <td className="px-3 py-2 tabular-nums">{survey?.surveyed ? pct(survey.would_continue) : '-'}</td>}
                </tr>
              );
            })}
          </tbody>
          <tfoot className="border-t border-stone-200 bg-stone-50">
            <tr>
              <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">Weighted by share</th>
              <td className="px-3 py-2">100%</td>
              <td className="px-3 py-2 font-medium tabular-nums">{pct(report.weighted.completion)}</td>
              {pois.length > 0 && <td colSpan={pois.length} />}
              <td className="px-3 py-2 font-medium tabular-nums">{pct(report.weighted.with_friction)}</td>
              {surveys && <td colSpan={2} />}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-stone-500">
        The weighted row counts each segment by its share of the audience, not by how many personas it has. Ran into friction: a self-report, survey friction or browser signal in one of the problems; objections are not counted.
        {pois.length > 0 && ' A persona reached the goal only when it did so on every text, design or site it was given.'}
        {notStarted > 0 && ` ${count(notStarted, 'persona')} did not start before the run ended and ${notStarted === 1 ? 'is' : 'are'} left out of the rates.`}
        {noAnswer > 0 && ` ${count(noAnswer, 'persona')} got no valid model answer and ${noAnswer === 1 ? 'is' : 'are'} left out of the rates; that says nothing about the product.`}
        {surveys && ' Mood and carrying on come from users’ surveys at the end, one answer per persona and point of interest, 0 is neutral, without weighting.'}
      </p>
    </section>
  );
}

const PREFERS: Record<ReportComparison['answers'][number]['prefers'], string> = { product: 'Prefers the product', competitor: 'Prefers the competitor', no_preference: 'No preference' };

/** A competitor's site against the team's product, by segment, from the survey after the competitor (engine poi/compare.ts). */
function Comparison({ comparison, pois }: { comparison: ReportComparison; pois: ReportData['pois'] }) {
  const name = (id: string) => pois.find((poi) => poi.id === id)?.name ?? id;
  const [competitor, product] = [name(comparison.poi_id), name(comparison.with_poi_id)];
  const id = `comparison-${comparison.poi_id}`;
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h3 id={id} className={heading}>
        {competitor} compared with {product}
      </h3>
      <div className="overflow-x-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="bg-stone-50">
            <tr>
              <Th>Segment</Th>
              <Th>Compared</Th>
              <Th>Prefer {product}</Th>
              <Th>Prefer {competitor}</Th>
              <Th>No preference</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100">
            {comparison.segments.map((row) => (
              <tr key={row.segment_id ?? row.name}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-stone-900">
                  {row.name}
                </th>
                {[row.compared, row.product, row.competitor, row.no_preference].map((n, i) => <td key={i} className="px-3 py-2 tabular-nums">{n}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="space-y-1 text-sm">
        {comparison.answers.map((answer) => (
          <li key={answer.seq} className="border-b border-stone-100 pb-1">
            <span className="font-medium text-stone-900">{answer.persona_name}</span> <span className="text-xs text-stone-500">{PREFERS[answer.prefers]}</span>
            <p className="text-stone-700">“{answer.reason}”</p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-stone-500">Asked in the survey after {competitor}, of personas who had used {product} earlier in the run. {competitor} was observed only: nothing was sent to it.</p>
    </section>
  );
}

function Friction({ friction, onInspect, renderScreenshot }: { friction: ReportFriction; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const inFile = useContext(InFile);
  const shot = friction.screenshot && renderScreenshot(friction.screenshot, friction.frame !== undefined ? `Frame ${friction.frame + 1}, as ${friction.persona_name} saw it` : `The page at step ${friction.step_no}, as ${friction.persona_name} saw it`);
  return (
    <li data-tone={SEVERITY[level(friction.severity)].tone} className={`tone-edge grid gap-3 rounded-lg border border-stone-200 bg-white p-3 ${shot ? 'sm:grid-cols-[minmax(0,1fr)_16rem]' : ''}`}>
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
          <SeverityChip severity={friction.severity} />
          <span>
            Step {friction.step_no}
            {friction.frame !== undefined && `, frame ${friction.frame + 1}`}
          </span>
          {!inFile && (
            <button type="button" onClick={() => onInspect(friction.persona_id, friction.seq)} className="text-link ml-auto">
              Open this step
            </button>
          )}
        </div>
        <p className="font-medium text-stone-900">{friction.what}</p>
        <p className="text-sm text-stone-700">
          <span className="font-medium">They expected:</span> {friction.expected}
        </p>
        <Passage passage={friction.passage} />
        {friction.quote && <blockquote className="border-l-4 border-stone-200 pl-3 text-sm italic text-stone-700">&ldquo;{friction.quote}&rdquo;</blockquote>}
        <p className="break-all text-xs text-stone-500">{friction.url}</p>
      </div>
      {shot && <div>{shot}</div>}
    </li>
  );
}

/** One persona folded to who they are and how it ended; opening it lists what got in their way, the worst first. */
function PersonaReport({ persona, segment, pois, frictions, onInspect, renderScreenshot }: { persona: ReportPersona; segment?: string; pois: ReportData['pois']; frictions: ReportFriction[]; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const inFile = useContext(InFile);
  return (
    <li>
      <details className="disclosure" open={inFile}>
        <summary>
          <div className="flex min-w-0 flex-[1_1_14rem] items-center gap-3">
            <PersonaAvatar name={persona.name} id={persona.id} />
            <div className="min-w-0">
              <p className="text-sm font-medium text-stone-900">{persona.name}</p>
              <p className="text-xs font-normal text-stone-500">{[persona.job_title, segment, persona.device].filter(Boolean).join(' · ')}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs font-normal text-stone-600">
            <OutcomeChip outcome={persona.outcome} />
            {frictions.length === 0 ? 'No friction' : <span className="flex items-center gap-1.5 whitespace-nowrap">{count(frictions.length, 'friction')}, worst <SeverityChip severity={frictions[0].severity} /></span>}
          </div>
        </summary>
        <div className="disclosure-body space-y-3">
          <p className="text-sm text-stone-700">
            <span className="font-medium text-stone-900">{OUTCOMES[persona.outcome].text}</span> after {count(persona.steps, 'step')}.{persona.outcome_text && ` ${persona.outcome_text}`}
          </p>
          {persona.pois && (
            <ul className="flex flex-wrap gap-2 text-xs text-stone-600" aria-label={`How ${persona.name} did on each`}>
              {Object.entries(persona.pois).map(([id, outcome]) => <li key={id} className="flex items-center gap-1.5">{pois.find((poi) => poi.id === id)?.name ?? id}: <OutcomeChip outcome={outcome} /></li>)}
            </ul>
          )}
          {frictions.length === 0 ? (
            <p className="text-sm text-stone-600">{persona.name} reported no friction.</p>
          ) : (
            <ol className="space-y-3" aria-label={`What got in ${persona.name}'s way`}>
              {frictions.map((friction) => (
                <Friction key={friction.seq} friction={friction} onInspect={onInspect} renderScreenshot={renderScreenshot} />
              ))}
            </ol>
          )}
          {!inFile && (
            <button type="button" onClick={() => onInspect(persona.id)} className="text-link">
              Open {persona.name}&rsquo;s timeline
            </button>
          )}
        </div>
      </details>
    </li>
  );
}

function Personas({ report, onInspect, renderScreenshot }: { report: ReportData; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const segmentName = (persona: ReportPersona) => report.segments.find((segment) => segment.id === persona.segment_id)?.name;
  return (
    <section aria-labelledby="personas-title" className="space-y-3">
      <div className="space-y-1">
        <h3 id="personas-title" className={heading}>How each persona did ({report.personas.length})</h3>
        <p className="text-sm text-stone-600">Open a persona to see what got in their way, the most severe first.</p>
      </div>
      <ul className="space-y-2">
        {report.personas.map((persona) => (
          <PersonaReport
            key={persona.id}
            persona={persona}
            segment={segmentName(persona)}
            pois={report.pois}
            frictions={report.frictions.filter((friction) => friction.persona_id === persona.id).sort(bySeverity)}
            onInspect={onInspect}
            renderScreenshot={renderScreenshot}
          />
        ))}
      </ul>
    </section>
  );
}

function DimensionTable({ dimension, selected }: { dimension: ReportDimension; selected?: string }) {
  return (
    <section aria-labelledby="profile-results-title" className="space-y-3">
      <h3 id="profile-results-title" className={heading}>Results by profile: {dimension.name}</h3>
      <div className="max-h-80 overflow-auto rounded-lg border border-stone-200">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-stone-50"><tr><Th>{dimension.name}</Th><Th>Personas</Th><Th>Reached the goal</Th><Th>Ran into friction</Th><Th>Mean latest feeling</Th></tr></thead>
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
      <p className="text-xs text-stone-500">Full-run groups, without segment weighting. Personas counts everyone in the row; rates leave out those who did not start or got no valid model answer. Feeling is the mean of each persona's latest valid step feeling, from −2 to 2; personas without one are excluded. Lists match the entire ordered list.</p>
    </section>
  );
}

const noScreenshot: RenderScreenshot = () => null;

export function Report({ report, repeats, filter = {}, onInspect, renderScreenshot = noScreenshot, actions, audienceFilters }: { report: ReportData; repeats?: RepeatSet; filter?: ProfileFilter; onInspect: Inspect; renderScreenshot?: RenderScreenshot; actions?: ReactNode; audienceFilters?: ReactNode }) {
  const inFile = useContext(InFile);
  const selectedPersonas = report.personas.filter((persona) => matchesProfileValues(persona.attributes, filter));
  const ids = new Set(selectedPersonas.map((persona) => persona.id));
  const filtered = !!filter.dimension && !!filter.value;
  const details = filtered ? { ...report, personas: selectedPersonas, frictions: report.frictions.filter((friction) => ids.has(friction.persona_id)) } : report;
  const dimension = report.dimensions?.find((candidate) => candidate.id === filter.dimension) ?? report.dimensions?.[0];
  // The engine's rank: evidence, then severity, then the low end of the share × trust (simulation/src/report/themes.ts).
  const themes = [...(report.themes ?? [])].sort((a, b) => a.rank - b.rank);
  const summary = writtenSummary(report);
  const facts = [
    ['Personas', String(report.personas.length)],
    ['Steps', String(report.steps)],
    ['Recorded cost', usd(report.cost_usd)],
    ['Duration', duration(report.duration_ms)],
    ['Model calls', `${report.llm_calls} (${(report.input_tokens + report.output_tokens).toLocaleString()} tokens)`],
  ];
  return (
    <Repeats value={{ set: repeats, run_id: report.run_id }}>
    <section aria-labelledby="report-title" className="report-page">
      <header className="report-header">
        <div className="report-header-top">
          <div><p className="report-eyebrow"><Icon name="report" size={14} /> Simulation insights</p><h2 id="report-title">Report</h2></div>
          {actions}
        </div>
        <p className="report-goal">{report.goal}</p>
        <p className="report-context"><Icon name="people" size={14} />{count(report.personas.length, 'simulated user')}<span aria-hidden="true">·</span>Findings to validate with real people</p>
        {report.repeat && <p className="text-sm text-stone-600">Run {report.repeat.index} of {report.repeat.of} in a repeat set.{repeats && ` ${setNote(repeats)}`}</p>}
        {report.status === 'stopped' && report.stop_reason && (report.stop_reason.startsWith('error: ') ? <Note tone="error">{stopText(report.stop_reason)}</Note> : <p className="text-sm text-stone-500">{stopText(report.stop_reason)}</p>)}
        {!report.comparison && (report.comparisons?.length || report.pois.some((poi) => poi.competitor)) ? <Note tone="info">Legacy comparison: this report predates shared task and criterion attribution. Its pairwise preferences do not establish an overall winner or validated comparison coverage.</Note> : null}
        {filtered && <p role="status" className="text-sm text-stone-700">{report.comparison ? 'Comparison results use the frozen scenario and segment groups shown below. Profile filters do not recalculate comparison evidence.' : `Showing ${details.personas.length} of ${report.personas.length} personas under User journeys. Everything else describes the full run.`}</p>}
      </header>
      {report.comparison ? <ComparisonReport comparison={report.comparison} report={report} inFile={inFile} onInspect={onInspect} renderScreenshot={renderScreenshot} /> : <>
        {summary && <section aria-label="Summary" className="report-goal">{summary}</section>}
        <Glance report={report} themes={themes} />
        {report.themes ? <Priorities themes={themes} setAside={report.set_aside ?? []} pois={report.pois} onInspect={onInspect} renderScreenshot={renderScreenshot} /> : <LegacyFindings report={report} onInspect={onInspect} />}
      </>}
      <div className="report-details">
        <SectionHeading title="Explore the details" hint="A closer look, whenever you need it." />
        {!report.comparison && <>
          {report.went_well && report.went_well.length > 0 && <Fold id="positive-title" title="What went well" hint="What users liked about the experience" icon="check"><WentWell likes={report.went_well} /></Fold>}
          <Fold id="audience-results-title" title="Audience breakdown" hint="Results by segment and profile" icon="people"><div className="space-y-6"><SegmentTable report={report} />{dimension && <DimensionTable dimension={dimension} selected={filter.value} />}</div></Fold>
          {report.buyers && report.buyers.length > 0 && <Fold id="buying-details-title" title="Buying intent" hint="Pricing, objections, and willingness to buy" icon="message"><BuyerSurvey rows={report.buyers} pois={report.pois} /></Fold>}
          {report.comparisons && report.comparisons.length > 0 && <Fold id="comparisons-title" title="Product comparisons" hint="Preferences across the products tested" icon="globe"><div className="space-y-6">{report.comparisons.map((comparison) => <Comparison key={comparison.poi_id} comparison={comparison} pois={report.pois} />)}</div></Fold>}
          <Fold id="journeys-title" title={`User journeys (${details.personas.length})`} hint="Individual experiences, screenshots, and timelines" icon="activity"><div className="space-y-5">{audienceFilters}<Personas report={details} onInspect={onInspect} renderScreenshot={renderScreenshot} /></div></Fold>
          {report.spread && <Fold id="spread-title" title="Opinion spread" hint="How conversations shaped the simulated experience" icon="message"><Spread spread={report.spread} personas={report.personas} onInspect={onInspect} /></Fold>}
        </>}
        {report.comparison && <ComparisonDetails comparison={report.comparison} report={report} inFile={inFile} onInspect={onInspect} renderScreenshot={renderScreenshot} />}
        <Fold id="methods-title" title="Run details & methodology" hint="Usage, settings, and how to read these findings" icon="settings">
          <div className="space-y-5">
            <dl className="report-run-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
            <Note tone="info">{report.banner}</Note>
            <p className="text-xs text-stone-500">{COST_SCOPE_TEXT}</p>
            {missingUsageText(report.unreported_usage_calls) && <Note tone="info">{missingUsageText(report.unreported_usage_calls)}</Note>}
            {!report.comparison && <>
              <p className="text-sm text-stone-600">Tested: {report.pois.map(poiName).join(', ')}</p>
              <ul className="flex flex-wrap gap-3 text-xs text-stone-700">{(Object.keys(OUTCOMES) as Outcome[]).map((outcome) => {
                const n = report.personas.filter((persona) => persona.outcome === outcome).length;
                return n > 0 ? <li key={outcome} className="flex items-center gap-1.5"><span data-tone={OUTCOMES[outcome].tone} className="tone-dot" />{n} {OUTCOMES[outcome].text.toLowerCase()}</li> : null;
              })}</ul>
              <SeverityLegend />
              <p className="text-xs text-stone-500">The judge model is asked to group what one concrete product change would fix. Findings are ordered by evidence strength, then severity and affected share. {EVIDENCE_LEVEL.strong.text}: {EVIDENCE_LEVEL.strong.plain}. {EVIDENCE_LEVEL.some.text}: {EVIDENCE_LEVEL.some.plain}. Ranges describe uncertainty within this simulation. {PRIORITY_NOTE}</p>
              <p className="text-xs text-stone-500">Confirmed: {TRUST_TEXT.confirmed}. Observed: {TRUST_TEXT.observed}. Reported: {TRUST_TEXT.reported}.</p>
            </>}
            <Methods methods={report.methods} personas={report.personas} />
          </div>
        </Fold>
      </div>
    </section>
    </Repeats>
  );
}
