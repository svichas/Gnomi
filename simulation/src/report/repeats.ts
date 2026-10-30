import { matchThemes, type ThemeMatch } from './match.ts';
import type { Report, ReportTheme, RunConfig } from '../types.ts';

// What the runs of a repeat set have in common (features_roadmap.md item 3). Repeats test robustness inside the simulation; they
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
}

/** The set's run of personas with no traits: a control, so it is one more run that no count of the set includes. */
export const isTraitFree = ({ repeat }: { repeat?: RunConfig['repeat'] | null }) => !!repeat && repeat.trait_free === repeat.index;

/** The runs a set counts. */
export const plannedRuns = ({ of, trait_free }: NonNullable<RunConfig['repeat']>) => of - (trait_free ? 1 : 0);

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
  const runs = reports.filter((report) => !isTraitFree(report));
  const compared = runs.filter((report) => report.status === 'finished');
  const repeat = reports[0]?.repeat;
  const of = repeat ? plannedRuns(repeat) : reports.length;
  // `live` only bridges the gap between two runs: the host holds a set until its last report is written, long after its runs say it is over.
  const running = runs.some((report) => report.status === 'running') || (live && compared.length === runs.length && runs.length < of);
  const clusters = clusterThemes(compared).sort((a, b) => b.members.length - a.members.length || a.first.rank - b.first.rank);
  const control = reports.find((report) => isTraitFree(report) && report.status === 'finished');
  // One shared key is often chance, and this note must not lean on chance. Against each cluster's first theme, as clusterThemes matches runs: a miss only leaves the note out.
  const alike = new Set(control && matchThemes(clusters.map(({ first }) => first), control.themes ?? []).pairs.filter(({ by }) => by !== 'shared_key').map(({ a }) => a));
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
  };
}
