import { matchThemes } from './match.ts';
import type { Report, ReportTheme } from '../types.ts';

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
}

export interface RepeatSet {
  group: string | null; // null: runs from before repeat sets
  of: number; // runs planned
  compared: number; // runs that finished: a stopped run missing a theme says nothing about that theme
  incomplete: boolean; // fewer finished than were planned
  families: string[]; // the model families of the compared runs
  findings: RepeatFinding[]; // seen in the most runs first, then by rank
}

/** The navigator's provider, or its model behind a local endpoint, which can serve any family. */
function familyOf({ methods }: Report): string {
  const navigator = methods.models.navigator;
  if (!navigator) return 'unknown';
  return navigator.provider === 'openai_compatible' ? navigator.model : navigator.provider;
}

/**
 * Clusters the finished runs' themes, each run's against every cluster's first theme, one to one per run, so a theme a run split in
 * two counts once and its other part starts a cluster of its own. Reports go in the order the runs ran. Pure.
 * shortcut: matchThemes can pair two themes on one shared key (report/match.ts), which overstates seen_in; the titles stay visible
 * so a reader can spot it, drop such pairs here once the match can tell them apart.
 */
export function combineReports(reports: Report[]): RepeatSet {
  const compared = reports.filter((report) => report.status === 'finished');
  const clusters: { first: ReportTheme; members: { run: Report; theme: ReportTheme }[] }[] = [];
  for (const run of compared) {
    const { pairs, only_b } = matchThemes(clusters.map((cluster) => cluster.first), run.themes ?? []);
    for (const { a, b } of pairs) clusters.find((cluster) => cluster.first === a)!.members.push({ run, theme: b });
    for (const theme of only_b) clusters.push({ first: theme, members: [{ run, theme }] });
  }
  const repeat = reports[0]?.repeat;
  const of = repeat?.of ?? reports.length;
  return {
    group: repeat?.group ?? null,
    of,
    compared: compared.length,
    incomplete: compared.length < of,
    families: [...new Set(compared.map(familyOf))],
    findings: clusters
      .sort((a, b) => b.members.length - a.members.length || a.first.rank - b.first.rank)
      .map(({ first, members }) => ({
        poi_id: first.poi_id,
        seen_in: members.length,
        of: compared.length,
        families: [...new Set(members.map(({ run }) => familyOf(run)))],
        titles: [...new Set(members.map(({ theme }) => theme.title))],
        themes: Object.fromEntries(members.map(({ run, theme }) => [run.run_id, theme.id])),
      })),
  };
}
