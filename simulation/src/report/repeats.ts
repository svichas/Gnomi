import { mean, sampleVariance } from 'simple-statistics';
import { matchThemes, type ThemeMatch } from './match.ts';
import type { Report, ReportMethods, ReportSpread, ReportTheme, RunConfig, WhatIf } from '../types.ts';

// What the runs of a repeat set have in common. Repeats test robustness inside the simulation; they
// are not evidence about real users. Each run keeps its own report, and this is computed when read, so a rejudge needs no rewrite.

/** One problem across the runs of a set. */
export interface RepeatFinding {
  poi_id: string;
  seen_in: number; // compared runs with this theme
  of: number; // compared runs
  families: string[]; // the model families it appeared under
  titles: string[]; // what the runs called it, the first run's first, without repeats
  themes: Record<string, string>; // run id → that run's theme id
  trait_free?: true; // the set's run of personas with no traits matched it, on more than one shared key; it changes no count or rank
}

export interface RepeatSet {
  group: string | null; // null: runs from before repeat sets
  of: number; // runs planned, without a trait-free run
  compared: number; // runs that finished: a stopped run missing a theme says nothing about that theme
  running: boolean; // the set is still going, so `compared` can grow
  incomplete: boolean; // the set is over, with fewer finished than were planned
  families: string[]; // the model families of the compared runs
  findings: RepeatFinding[]; // seen in the most runs first, then by rank
  trait_free?: string; // the run of personas with no traits, once it has finished; in no count above
  prior?: ReportMethods['prior']; // a returning set: the run its personas remember; every run of a set shares it
  what_if?: WhatIfResult; // the set's runs with an added post against those without; in no count above
}

/** One number of a what-if: the mean of its pair differences, with the post minus without, as pairedDifference gives it. */
export interface WhatIfNumber {
  id: 'posted' | 'second_hand' | 'opinion' | 'abandoned';
  label: string;
  n: number; // pairs where both runs have this number
  mean: number | null;
  lower: number | null;
  upper: number | null;
  note: string | null; // why there is no interval
}

export interface WhatIfResult {
  post: string; // the team's text
  round: number;
  pairs: number; // pairs where both runs finished
  of: number; // pairs planned
  numbers: WhatIfNumber[];
  note: string; // WHAT_IF_NOTE, on the result so no reader of the JSON misses it
}

/** How long a what-if's post may be: as long as a persona's own (agent/social.ts). */
export const WHAT_IF_POST_MAX = 500;
/** Said on every what-if result. */
export const WHAT_IF_NOTE = 'Inside the simulator, adding this post moved these numbers. That does not establish a real-world effect. Spread is relative and uncalibrated.';
export const MIN_PAIRS = 3; // fewer give no interval (pairedDifference)

/** Why a run is in no count of its set: a control of personas with no traits, or a run with a post the team added. Null for a run that counts. */
export const uncounted = ({ repeat }: { repeat?: RunConfig['repeat'] | null }) => (repeat?.what_if?.post ? 'what_if' as const : repeat && repeat.trait_free === repeat.index ? 'trait_free' as const : null);

/** The runs a set counts. */
export const plannedRuns = ({ of, trait_free, what_if }: NonNullable<RunConfig['repeat']>) => (what_if ? of / 2 : of - (trait_free ? 1 : 0));

/** Two-sided 95% Student t quantiles for 1 to 30 degrees of freedom. */
export const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
// Above 30 degrees of freedom the normal 1.96 stands in for t: at most 4% narrower, and the gap shrinks as replicates grow.
export const t95 = (df: number) => T95[df - 1] ?? 1.96;

/** The paired mean difference (arm − baseline) over replicates where both measured, with a 95% t interval; whole replicates are the unit. */
export function pairedDifference(arm: (number | null)[], baseline: (number | null)[]) {
  const d = arm.flatMap((value, i) => value === null || baseline[i] === null || baseline[i] === undefined ? [] : [value - baseline[i]]);
  if (!d.length) return { n: 0, mean: null, lower: null, upper: null, note: 'no pairs' };
  const m = mean(d);
  if (d.length < MIN_PAIRS) return { n: d.length, mean: m, lower: null, upper: null, note: 'fewer than three pairs' };
  // Identical differences are not certainty: a zero-width interval would claim it.
  if (d.every((x) => x === d[0])) return { n: d.length, mean: m, lower: null, upper: null, note: 'no variation' };
  const half = t95(d.length - 1) * Math.sqrt(sampleVariance(d) / d.length);
  return { n: d.length, mean: m, lower: m - half, upper: m + half, note: null };
}

/** What a what-if compares, from what each report already has on the post's POI. Never themes: the two runs of a pair name them apart. */
const WHAT_IF_NUMBERS: { id: WhatIfNumber['id']; label: string; read(run: Report, about: ReportSpread | undefined, poi_id: string): number | null }[] = [
  { id: 'posted', label: 'People who posted', read: (_, about) => about?.posters?.length ?? 0 }, // a run nobody posted in has no spread
  { id: 'second_hand', label: 'Second-hand reach: posted without meeting a problem first-hand', read: (_, about) => about?.second_hand.length ?? 0 },
  // Not from the spread: the post gives its own run one, so a pair would drop exactly when the run without the post was quiet.
  { id: 'opinion', label: 'Mean opinion at the end, -2 to +2', read: (run, _, poi_id) => run.end_opinions?.[poi_id] ?? null },
  { id: 'abandoned', label: 'People who abandoned', read: (run) => run.personas.filter((persona) => persona.outcome === 'abandoned').length },
];

/** Each number pair by pair, over pairs where both runs finished: a stopped run covers less, so its pair says nothing. Whole pairs are the unit. Pure. */
function whatIfResult(reports: Report[], { text, round, poi_id }: WhatIf, of: number): WhatIfResult {
  const finished = (pair: number, post: boolean) => reports.find(({ repeat, status }) => repeat?.what_if?.pair === pair && repeat.what_if.post === post && status === 'finished');
  const pairs = Array.from({ length: of }, (_, i) => [finished(i + 1, true), finished(i + 1, false)] as const).flatMap(([added, without]) => (added && without ? [{ added, without }] : []));
  const about = (run: Report) => run.spread?.find((spread) => spread.poi_id === poi_id);
  return {
    post: text,
    round,
    pairs: pairs.length,
    of,
    numbers: WHAT_IF_NUMBERS.map(({ id, label, read }) => ({ id, label, ...pairedDifference(pairs.map(({ added }) => read(added, about(added), poi_id)), pairs.map(({ without }) => read(without, about(without), poi_id))) })),
    note: WHAT_IF_NOTE,
  };
}

/** The navigator's provider, or its model behind a local endpoint, which can serve any family. */
function familyOf({ methods }: Report): string {
  const navigator = methods.models.navigator;
  if (!navigator) return 'unknown';
  return navigator.provider === 'openai_compatible' ? navigator.model : navigator.provider;
}

/** One problem across runs: the theme that started the cluster, and each run's theme for it. */
export interface ThemeCluster {
  first: ReportTheme;
  members: { run: Report; theme: ReportTheme; by?: ThemeMatch['by'] }[]; // one per run; `by`: how it joined `first`
}

/**
 * Clusters runs' themes, each run's against every cluster's first theme, one to one per run, so a theme a run split in two counts
 * once and its other part starts a cluster of its own. Runs go in the order they ran. Pure.
 * shortcut: matchThemes can pair two themes on one shared key (report/match.ts), which overstates seen_in; the titles stay visible
 * so a reader can spot it, skip pairs `by: 'shared_key'` here if that misleads.
 */
export function clusterThemes(runs: Report[], themesOf = (run: Report) => run.themes ?? []): ThemeCluster[] {
  const clusters: ThemeCluster[] = [];
  for (const run of runs) {
    const { pairs, only_b } = matchThemes(clusters.map((cluster) => cluster.first), themesOf(run));
    for (const { a, b, by } of pairs) clusters.find((cluster) => cluster.first === a)!.members.push({ run, theme: b, by });
    for (const theme of only_b) clusters.push({ first: theme, members: [{ run, theme }] });
  }
  return clusters;
}

/**
 * The finished runs' themes as one set. Reports go in the order the runs ran. Pure.
 * `live` says the process running the set still holds it: between two runs no run is running, and only that process knows more follow.
 * shortcut: a reader in another process (`gnomi report --repeat`) sees that gap as incomplete, for the moment it lasts; record a set's end in the log if that ever matters.
 */
export function combineReports(reports: Report[], live = false): RepeatSet {
  const runs = reports.filter((report) => !uncounted(report));
  const compared = runs.filter((report) => report.status === 'finished');
  const repeat = reports[0]?.repeat;
  const of = repeat ? plannedRuns(repeat) : reports.length;
  // A what-if set's runs with the post are in no count, but the set goes on through them.
  const [going, planned] = repeat?.what_if ? [reports, repeat.of] : [runs, of];
  // `live` only bridges the gap between two runs: the host holds a set until its last report is written, long after its runs say it is over.
  const running = going.some((report) => report.status === 'running') || (live && going.every((report) => report.status === 'finished') && going.length < planned);
  const clusters = clusterThemes(compared).sort((a, b) => b.members.length - a.members.length || a.first.rank - b.first.rank);
  const control = reports.find((report) => uncounted(report) === 'trait_free' && report.status === 'finished');
  // One shared key is often chance, and this note must not lean on chance. Against each cluster's first theme, as clusterThemes matches runs: a miss only leaves the note out.
  // The scan finds a rule on a page whoever browses, so a scan-only theme on either side says nothing about the personas or the model.
  const noted = (themes: ReportTheme[]) => themes.filter(({ scan_only }) => !scan_only);
  const alike = new Set(control && matchThemes(noted(clusters.map(({ first }) => first)), noted(control.themes ?? [])).pairs.filter(({ by }) => by !== 'shared_key').map(({ a }) => a));
  const prior = reports[0]?.methods.prior;
  return {
    group: repeat?.group ?? null,
    of,
    compared: compared.length,
    running,
    incomplete: !running && compared.length < of,
    families: [...new Set(compared.map(familyOf))],
    findings: clusters.map(({ first, members }) => ({
      poi_id: first.poi_id,
      seen_in: members.length,
      of: compared.length,
      families: [...new Set(members.map(({ run }) => familyOf(run)))],
      titles: [...new Set(members.map(({ theme }) => theme.title))],
      themes: Object.fromEntries(members.map(({ run, theme }) => [run.run_id, theme.id])),
      ...(alike.has(first) ? { trait_free: true as const } : {}),
    })),
    ...(control ? { trait_free: control.run_id } : {}),
    ...(prior ? { prior } : {}),
    ...(repeat?.what_if ? { what_if: whatIfResult(reports, repeat.what_if, of) } : {}),
  };
}
