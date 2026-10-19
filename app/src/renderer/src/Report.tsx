import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import type { EvidenceLevel, Outcome, Prevalence, Report as ReportData, ReportComparison, ReportDimension, ReportEvidence, ReportFriction, ReportHomogeneity, ReportLike, ReportMethods, ReportPersona, ReportSpread, ReportTheme, SpreadStats, Trust } from '@gnomi/simulation/types.ts';
import { attributeKey, formatAttributeValue } from '@gnomi/simulation/report/dimensions.ts';
import { BLOCK_REASON_TEXT, poiName, TRUST_TEXT, trustMix } from '@gnomi/simulation/report/markdown.ts';
import { matchesProfileValues, resetOutcome, stopText } from './activity.ts';
import { BuyerSurvey } from './BuyerSurvey.tsx';
import { ComparisonReport } from './ComparisonReport.tsx';
import { missingUsageText } from './cost.ts';
import type { ProfileFilter } from './activity.ts';
import { PersonaAvatar } from './Icon.tsx';
import { Note, usd } from './ui.tsx';

function duration(ms: number | null) {
  if (ms === null) return 'not finished';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}`;
const heading = 'text-base font-semibold text-stone-900';

// Tones are styled in styles.css; a tone always sits beside its label, never stands in for it (brand.md §5).
type Tone = 'good' | 'warn' | 'high' | 'bad' | 'neutral';

const OUTCOMES: Record<Outcome, { text: string; tone: Tone }> = {
  done: { text: 'Reached the goal', tone: 'good' },
  abandoned: { text: 'Gave up', tone: 'warn' },
  budget_exceeded: { text: 'Ran out of steps', tone: 'warn' },
  repeated_failure: { text: 'Got stuck', tone: 'warn' },
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

function SeverityChip({ severity }: { severity: number }) {
  const { text, plain, tone } = SEVERITY[level(severity)];
  return <span data-tone={tone} title={`Severity ${severity} of 4: ${plain}`} className="tone-chip">{text}</span>;
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
  strong: { text: 'Strong evidence', plain: 'three or more personas, and at least a quarter of those who used it', order: 3 },
  some: { text: 'Some evidence', plain: 'two or more personas', order: 2 },
  single: { text: 'One persona', plain: 'only one persona met it: worth a look, not yet a pattern', order: 1 },
  none: { text: 'None first-hand', plain: 'every persona who reported it had read about it in the feed first', order: 0 },
} as const satisfies Record<EvidenceLevel, { text: string; plain: string; order: number }>;
const evidenceOf = (finding: { prevalence?: Prevalence; personas: number }): EvidenceLevel => finding.prevalence?.level ?? (finding.personas <= 1 ? 'single' : 'some');
const isSingle = (theme: ReportTheme) => evidenceOf(theme) === 'single';

/** Better evidence first; within it the engine's rank (severity, then the low end of the share × trust). */
const byPriority = (a: ReportTheme, b: ReportTheme) =>
  EVIDENCE_LEVEL[evidenceOf(b)].order - EVIDENCE_LEVEL[evidenceOf(a)].order || a.rank - b.rank;

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

type Inspect = (personaId: string, seq?: number) => void;

// Screenshots come through `renderScreenshot`: the app loads them over IPC, an export inlines them.
type RenderScreenshot = (path: string, alt: string) => ReactNode;

/** True while the report is drawn into an exported file, which has no inspector to open and prints every fold open. */
export const InFile = createContext(false);

function PersonaLink({ id, name, seq, onInspect }: { id: string; name: string; seq?: number; onInspect: Inspect }) {
  if (useContext(InFile)) return <span className="font-medium normal-case tracking-normal text-stone-900">{name}</span>;
  return (
    <button type="button" onClick={() => onInspect(id, seq)} className="text-left font-medium normal-case tracking-normal text-indigo-700 underline decoration-indigo-300 hover:text-indigo-900">
      {name}
    </button>
  );
}

/** A section that starts closed in the app: secondary detail stays one click away. */
function Fold({ id, title, hint, children }: { id: string; title: string; hint: string; children: ReactNode }) {
  const inFile = useContext(InFile);
  return (
    <section aria-labelledby={id}>
      <details className="disclosure" open={inFile}>
        <summary>
          <h3 id={id} className="text-sm font-semibold text-stone-900">{title}</h3>
          <span>{hint}</span>
        </summary>
        <div className="disclosure-body">{children}</div>
      </details>
    </section>
  );
}

function Tile({ label, value, detail, children }: { label: string; value: string; detail?: string; children?: ReactNode }) {
  return (
    <div className="space-y-2 rounded-lg bg-stone-50 p-4">
      <p className="text-xs font-medium text-stone-500">{label}</p>
      <p className="text-2xl font-medium tracking-tight tabular-nums text-stone-900">{value}</p>
      {detail && <p className="text-xs text-stone-600">{detail}</p>}
      {children}
    </div>
  );
}

/** The run in one sentence and three numbers: who got there, what is in the way and how it felt. Always the full run. */
function Glance({ report, themes: all }: { report: ReportData; themes: ReportTheme[] }) {
  // A competitor's problems are not the team's to fix.
  const themes = all.filter((t) => !report.pois.find((poi) => poi.id === t.poi_id)?.competitor);
  const total = report.personas.length;
  const outcomes = (Object.keys(OUTCOMES) as Outcome[]).map((outcome) => [outcome, report.personas.filter((p) => p.outcome === outcome).length] as const).filter(([, n]) => n > 0);
  const done = outcomes.find(([outcome]) => outcome === 'done')?.[1] ?? 0;
  const started = total - (outcomes.find(([outcome]) => outcome === 'not_started')?.[1] ?? 0);
  const singles = themes.filter(isSingle).length;
  const problems: { severity: number }[] = report.themes ? themes.filter((t) => !isSingle(t)) : report.frictions;
  const levels = LEVELS.map((n) => [n, problems.filter((p) => level(p.severity) === n).length] as const).filter(([, n]) => n > 0);
  const answers = report.sentiment?.filter((row) => row.sentiment !== null && row.surveyed > 0) ?? [];
  const surveyed = answers.reduce((sum, row) => sum + row.surveyed, 0);
  const feeling = surveyed ? answers.reduce((sum, row) => sum + row.sentiment! * row.surveyed, 0) / surveyed : null;
  const carryOn = surveyed ? answers.reduce((sum, row) => sum + row.would_continue * row.surveyed, 0) / surveyed : 0;
  // The verdict names a problem more than one persona met first-hand; objections only lead when nothing got in the way.
  const leads = (t: ReportTheme) => !isSingle(t) && evidenceOf(t) !== 'none';
  const top = themes.find((t) => leads(t) && t.category !== 'objection');
  const doubt = top ? undefined : themes.find(leads);
  return (
    <section aria-labelledby="glance-title" className="space-y-3">
      <h3 id="glance-title" className={heading}>At a glance</h3>
      <p className="text-base text-stone-900">
        {done} of {count(started, 'persona')} reached the goal.{started < total && ` ${total - started} did not start.`}
        {top ? <> Fix first: <span className="font-medium">{top.title}</span> (<Share finding={top} />).</>
          : doubt ? <> Biggest objection: <span className="font-medium">{doubt.title}</span> (<Share finding={doubt} />).</>
          : themes.length > 0 ? ' No problem came up for more than one persona.' : report.frictions.length === 0 && ' Nobody reported any friction.'}
      </p>
      <div className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(14rem,1fr))]">
        <Tile label="Reached the goal" value={`${done} of ${started}`} detail={started ? `${pct(done / started)} of personas who started${report.segments.length > 1 ? `, ${pct(report.weighted.completion)} weighted by segment share` : ''}` : undefined}>
          <span aria-hidden="true" className="flex h-2 overflow-hidden rounded-full bg-stone-200">
            {outcomes.map(([outcome, n]) => <span key={outcome} data-tone={OUTCOMES[outcome].tone} className="tone-fill" style={{ width: pct(n / total) }} />)}
          </span>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-700">
            {outcomes.map(([outcome, n]) => (
              <li key={outcome} className="flex items-center gap-1.5"><span data-tone={OUTCOMES[outcome].tone} className="tone-dot" />{n} {OUTCOMES[outcome].text.toLowerCase()}</li>
            ))}
          </ul>
        </Tile>
        <Tile label={report.themes ? 'Problems to fix' : 'Frictions reported'} value={String(problems.length)} detail={singles ? `Plus ${count(singles, 'single report')}, each from one persona.` : undefined}>
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-stone-700">
            {levels.map(([n, c]) => (
              <li key={n} className="flex items-center gap-1.5"><span data-tone={SEVERITY[n].tone} className="tone-dot" />{c} {SEVERITY[n].text.toLowerCase()}</li>
            ))}
          </ul>
        </Tile>
        {feeling !== null && <Tile label="How they felt" value={mood(feeling)} detail={`${signed(feeling)} on a −2 to +2 scale. ${pct(carryOn)} would carry on using it.`} />}
      </div>
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

const Th = ({ children }: { children: ReactNode }) => (
  <th scope="col" className="px-3 py-2 text-left text-xs font-medium text-stone-500">
    {children}
  </th>
);

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

/** One problem: how bad and how widespread, the suggested fix in plain words, and the evidence a click away. */
function Priority({ theme, nested, onInspect, renderScreenshot }: { theme: ReportTheme; nested?: boolean; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const Title = nested ? 'h5' : 'h4';
  const inFile = useContext(InFile);
  return (
    <li data-tone={SEVERITY[level(theme.severity)].tone} className="tone-edge space-y-3 rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <SeverityChip severity={theme.severity} />
        <EvidenceChip finding={theme} />
        <TrustBadge trust={theme.trust} counts={theme.trust_counts} />
        <span className="text-xs tabular-nums text-stone-500">
          <Share finding={theme} noun="affected" />{theme.heard_first ? `, +${theme.heard_first} more after reading the feed` : ''}, {count(theme.frictions, 'report')}
        </span>
      </div>
      <div className="space-y-1">
        <Title className="text-base font-medium text-stone-900">{theme.title}</Title>
        <p className="text-sm text-stone-700">{theme.description}</p>
      </div>
      {theme.suggestion && (
        <div className="space-y-1 rounded-lg bg-indigo-50 p-3 text-sm">
          <p className="text-xs font-semibold text-indigo-700">Try this</p>
          <p className="font-medium text-stone-900">{theme.suggestion.change}</p>
          <p className="text-xs text-stone-500">Generated suggestion: try it with real people before you ship it.</p>
        </div>
      )}
      <details className="report-more" open={inFile}>
        <summary>{theme.suggestion ? 'How to do it, and the evidence' : 'Who it affected and why'}</summary>
        <div className="mt-3 space-y-3">
          {theme.suggestion && (
            <p className="text-sm text-stone-700">
              <span className="font-medium text-stone-900">How:</span> {theme.suggestion.solution}
            </p>
          )}
          <Affected theme={theme} />
          <ul className="space-y-3" aria-label={`Evidence for ${theme.title}`}>
            {theme.evidence.map((evidence, i) => (
              <Evidence key={i} evidence={evidence} onInspect={onInspect} renderScreenshot={renderScreenshot} />
            ))}
          </ul>
          {theme.named_by === 'rules' && <p className="text-xs text-stone-500">Title generated from the page and element.</p>}
        </div>
      </details>
    </li>
  );
}

const TOP = 5; // problems shown before the fold

/** One list of findings, per POI when there are several; the first few open, the rest a click away. */
function Findings({ themes, pois, empty, onInspect, renderScreenshot }: { themes: ReportTheme[]; pois: ReportData['pois']; empty: string; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const inFile = useContext(InFile);
  const items = (shown: ReportTheme[], nested?: boolean) =>
    shown.map((theme) => <Priority key={`${theme.poi_id}/${theme.id}`} theme={theme} nested={nested} onInspect={onInspect} renderScreenshot={renderScreenshot} />);
  const list = (shown: ReportTheme[], nested?: boolean) => (
    <>
      <ol className="space-y-3">{items(shown.slice(0, TOP), nested)}</ol>
      {shown.length > TOP && (
        <details className="report-more" open={inFile}>
          <summary>Show {count(shown.length - TOP, 'more')}</summary>
          <ol className="mt-3 space-y-3">{items(shown.slice(TOP), nested)}</ol>
        </details>
      )}
    </>
  );
  if (themes.length === 0) return <p className="text-sm text-stone-600">{empty}</p>;
  if (pois.length <= 1) return list(themes);
  return pois.map((poi) => {
    const own = themes.filter((theme) => theme.poi_id === poi.id);
    return own.length === 0 ? null : (
      <section key={poi.id} aria-label={poiName(poi)} className="space-y-3">
        <h4 className="text-sm font-medium text-stone-900">{poiName(poi)}</h4>
        {list(own, true)}
      </section>
    );
  });
}

/**
 * Problems and objections that more than one persona met, best evidence first, and the single reports apart: one persona is
 * worth a look, not a reason to fix something first.
 */
function Priorities({ themes, pois, onInspect, renderScreenshot }: { themes: ReportTheme[]; pois: ReportData['pois']; onInspect: Inspect; renderScreenshot: RenderScreenshot }) {
  const shared = themes.filter((t) => !isSingle(t));
  const problems = shared.filter((t) => t.category !== 'objection');
  const objections = shared.filter((t) => t.category === 'objection');
  const singles = themes.filter(isSingle);
  const props = { pois, onInspect, renderScreenshot };
  return (
    <>
      <section aria-labelledby="themes-title" className="space-y-3">
        <div className="space-y-1">
          <h3 id="themes-title" className={heading}>What to fix first ({problems.length})</h3>
          <p className="text-sm text-stone-600">What got in the personas' way, grouped into problems. Problems with stronger evidence come first; within the same evidence, the more severe first, then the larger share with better trust. The range says how sure that share is among this run's personas.</p>
        </div>
        <SeverityLegend />
        <Findings themes={problems} empty={singles.length ? 'No problem came up for more than one persona. The single reports are below.' : 'No problems to fix in this run.'} {...props} />
        <p className="text-xs text-stone-500">
          {EVIDENCE_LEVEL.strong.text}: {EVIDENCE_LEVEL.strong.plain}. {EVIDENCE_LEVEL.some.text}: {EVIDENCE_LEVEL.some.plain}.
          {' '}Confirmed: {TRUST_TEXT.confirmed}. Observed: {TRUST_TEXT.observed}. Reported: {TRUST_TEXT.reported}.
        </p>
      </section>
      {objections.length > 0 && (
        <section aria-labelledby="objections-title" className="space-y-3">
          <div className="space-y-1">
            <h3 id="objections-title" className={heading}>Objections ({objections.length})</h3>
            <p className="text-sm text-stone-600">Why personas would doubt or not adopt it, even where it worked.</p>
          </div>
          <Findings themes={objections} empty="" {...props} />
        </section>
      )}
      {singles.length > 0 && (
        <Fold id="singles-title" title={`Met first-hand by one persona (${singles.length})`} hint="Worth a look, not yet a pattern">
          <Findings themes={singles} empty="" {...props} />
        </Fold>
      )}
    </>
  );
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
function Rate({ rate, of, tone }: { rate: number; of: number; tone: Tone }) {
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
  const started = (segment: ReportData['segments'][number]) => segment.personas - (segment.outcomes.not_started ?? 0);
  const notStarted = report.segments.reduce((sum, segment) => sum + segment.personas - started(segment), 0);
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
    ...(stats.posters ? [['Posted', stats.posters.length], ['Reached', stats.readers?.length ?? 0]] as const : []),
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
      {stats.heard && stats.heard.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-700">Heard before a change of mind, not counted as influence</p>
          <ul className="text-stone-700">
            {stats.heard.slice(0, 5).map((edge) => (
              <li key={`${edge.seq}/${edge.from}`}>
                {name(edge.from)} → {name(edge.to)}, round {edge.round}, sentiment {signed(edge.delta)}
              </li>
            ))}
          </ul>
          {stats.heard.length > 5 && <p className="text-xs text-stone-500">And {count(stats.heard.length - 5, 'more')}.</p>}
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
    <div className="space-y-3">
      <p className="text-xs text-stone-500">
        First-hand: personas who met it before reading about it, as the problem counts them. Second-hand: personas who posted about it without meeting it first-hand. Reached: personas shown a post about it in a feed or at a step. Influence: a cited post moved a persona's sentiment by 0.5 or more, once per author and change.
      </p>
      {spread.length === 0 && <p className="text-sm text-stone-600">No post was about a particular text, design or site.</p>}
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
                  <h4 className="font-medium text-stone-900">{theme.title}</h4>
                  <SpreadBody stats={theme} personas={personas} onInspect={onInspect} />
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
    </div>
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
    ...(methods.homogeneity ? [['Homogeneity', <Homogeneity value={methods.homogeneity} />] as [string, ReactNode]] : []),
    ...(methods.limitations === undefined ? [] : [['Limitations', methods.limitations.length === 0 ? none : <ul className="list-disc pl-4">{methods.limitations.map((text) => <li key={text}>{text}</li>)}</ul>] as [string, ReactNode]]),
  ];
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
      <p className="text-xs text-stone-500">Full-run groups, without segment weighting. Rates use the personas in each row. Feeling is the mean of each persona's latest valid step feeling, from −2 to 2; personas without one are excluded. Lists match the entire ordered list.</p>
    </section>
  );
}

const noScreenshot: RenderScreenshot = () => null;

export function Report({ report, filter = {}, onInspect, renderScreenshot = noScreenshot }: { report: ReportData; filter?: ProfileFilter; onInspect: Inspect; renderScreenshot?: RenderScreenshot }) {
  const inFile = useContext(InFile);
  const selectedPersonas = report.personas.filter((persona) => matchesProfileValues(persona.attributes, filter));
  const ids = new Set(selectedPersonas.map((persona) => persona.id));
  const filtered = !!filter.dimension && !!filter.value;
  const details = filtered ? { ...report, personas: selectedPersonas, frictions: report.frictions.filter((friction) => ids.has(friction.persona_id)) } : report;
  const dimension = report.dimensions?.find((candidate) => candidate.id === filter.dimension) ?? report.dimensions?.[0];
  const themes = [...(report.themes ?? [])].sort(byPriority);
  const facts = [
    ['Personas', String(report.personas.length)],
    ['Steps', String(report.steps)],
    ['Recorded cost', usd(report.cost_usd)],
    ['Duration', duration(report.duration_ms)],
    ['Model calls', `${report.llm_calls} (${(report.input_tokens + report.output_tokens).toLocaleString()} tokens)`],
  ];
  return (
    <section aria-labelledby="report-title" className="min-w-0 space-y-8 rounded-xl border border-stone-200 bg-white p-5 shadow-sm sm:p-6">
      <header className="space-y-3">
        <div className="space-y-1">
          <h2 id="report-title" className="text-xl font-medium tracking-tight text-stone-900">
            Report
          </h2>
          <p className="text-sm text-stone-700">
            <span className="font-medium text-stone-900">Goal:</span> {report.goal}
          </p>
          {!report.comparison && (report.pois.length > 1 || report.pois.some((poi) => poi.competitor)) && <p className="text-sm text-stone-600">What the personas tried, in this order: {report.pois.map(poiName).join(', ')}</p>}
          {report.status === 'stopped' && report.stop_reason && <p className="text-sm text-stone-500">{stopText(report.stop_reason)}</p>}
        </div>
        <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="flex gap-1.5">
              <dt className="text-stone-500">{label}</dt>
              <dd className="font-medium tabular-nums text-stone-900">{value}</dd>
            </div>
          ))}
        </dl>
        <Note tone="info">{report.banner}</Note>
        {missingUsageText(report.unreported_usage_calls) && <Note tone="info">{missingUsageText(report.unreported_usage_calls)}</Note>}
        {!report.comparison && (report.comparisons?.length || report.pois.some((poi) => poi.competitor)) ? <Note tone="info">Legacy comparison: this report predates shared task and criterion attribution. Its pairwise preferences do not establish an overall winner or validated comparison coverage.</Note> : null}
        {filtered && <p role="status" className="text-sm text-stone-700">{report.comparison ? 'Comparison results use the frozen scenario and segment groups shown below. Profile filters do not recalculate comparison evidence.' : `Showing ${details.personas.length} of ${report.personas.length} personas under How each persona did. Everything else describes the full run.`}</p>}
      </header>
      {report.comparison ? <ComparisonReport comparison={report.comparison} report={report} inFile={inFile} onInspect={onInspect} renderScreenshot={renderScreenshot} /> : <>
      <Glance report={report} themes={themes} />
      {report.themes && <Priorities themes={themes} pois={report.pois} onInspect={onInspect} renderScreenshot={renderScreenshot} />}
      {report.went_well && report.went_well.length > 0 && <WentWell likes={report.went_well} />}
      <SegmentTable report={report} />
      {dimension && <DimensionTable dimension={dimension} selected={filter.value} />}
      {report.buyers && report.buyers.length > 0 && <BuyerSurvey rows={report.buyers} pois={report.pois} />}
      {report.comparisons?.map((comparison) => <Comparison key={comparison.poi_id} comparison={comparison} pois={report.pois} />)}
      <Personas report={details} onInspect={onInspect} renderScreenshot={renderScreenshot} />
      </>}
      {!report.comparison && report.spread && (
        <Fold id="spread-title" title="Opinion spread" hint="How talk travelled on the simulated feed">
          <Spread spread={report.spread} personas={report.personas} onInspect={onInspect} />
        </Fold>
      )}
      <Fold id="methods-title" title="Methods" hint="What the run was set up with and what got in its way">
        <Methods methods={report.methods} personas={report.personas} />
      </Fold>
    </section>
  );
}
