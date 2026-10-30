import { similarity } from './similarity.ts';
import { pathOf } from './themes.ts';
import type { ReportTheme } from './types.ts';

// Which themes of two runs are the same problem (tech.md §8.2). Theme ids are positions, so they mean nothing outside one run.

/**
 * Themes sharing more than this part of their group keys are one problem whatever their titles. A smaller part can be chance, as
 * personas meet unrelated problems at one button, so it only counts after titles: in the M3 seed reports a false pair shares 0.11
 * and two true pairs 0.09 to 0.11.
 * shortcut: one shared key still pairs themes with no better partner (D12 with a theme of the control build, on a link both used),
 * weigh keys by their frictions if themes ever keep them. Such a pair says `by: 'shared_key'`, so a reader of the match can hold it apart.
 */
export const KEY_MATCH = 0.3;

/**
 * Other themes are one problem when their titles' similarity is above this. In the M3 seed reports differently worded true pairs
 * score 0.06 to 0.37 and the best false pair 0.15, so this misses some rather than call a new problem an old one.
 */
export const TITLE_MATCH = 0.2;

export interface ThemeMatch {
  a: ReportTheme;
  b: ReportTheme;
  by: 'keys' | 'title' | 'shared_key';
}

export interface ThemeMatches {
  pairs: ThemeMatch[];
  only_a: ReportTheme[];
  only_b: ReportTheme[];
}

/**
 * A group key without its page's host: a Gym's port changes with every start, and a PR preview has its own host.
 * shortcut: two hosts of one POI with the same path count as one page, keep the host if a POI ever spans sites.
 */
function hostless(key: string): string {
  const [poi_id, page, ...rest] = JSON.parse(key) as [string, string | null, ...string[]];
  return JSON.stringify([poi_id, page && pathOf(page), ...rest]);
}

/** Shared keys over all keys: the judge may merge groups differently in each run, so the share counts, not the number. */
function keyOverlap(a: ReportTheme, b: ReportTheme): number {
  const [ours, theirs] = [a, b].map((theme) => new Set(theme.keys?.map(hostless)));
  const shared = [...ours].filter((key) => theirs.has(key)).length;
  return shared === 0 ? 0 : shared / (ours.size + theirs.size - shared);
}

function titleOverlap(a: ReportTheme, b: ReportTheme): number {
  // A rules title on a page is a template, which looks alike on any two pages. Without a page it is the persona's own words.
  if (a.named_by === 'rules' && b.named_by === 'rules' && a.keys && b.keys && a.pages.length && b.pages.length) return 0;
  return similarity([a.title, b.title]).max;
}

const categoryOf = (theme: ReportTheme) => theme.category ?? 'friction'; // absent before structured surveys

/**
 * One-to-one pairs within each POI and category, closest first, a tie going to the higher-ranked themes: by a strong key overlap,
 * then by title, then by any shared key. Pure. `byTitle: false` leaves titles out: TITLE_MATCH only holds for one-to-one matching.
 */
export function matchThemes(a: ReportTheme[], b: ReportTheme[], byTitle = true): ThemeMatches {
  const only_a = new Set(a);
  const only_b = new Set(b);
  const pairs: ThemeMatch[] = [];
  const claim = (by: ThemeMatch['by'], overlap: typeof keyOverlap, above: number) => {
    const close = [...only_a]
      .flatMap((x) => [...only_b].filter((y) => y.poi_id === x.poi_id && categoryOf(y) === categoryOf(x)).map((y) => ({ x, y, score: overlap(x, y) })))
      .filter(({ score }) => score > above)
      .sort((p, q) => q.score - p.score || p.x.rank - q.x.rank || p.y.rank - q.y.rank);
    for (const { x, y } of close) {
      if (!only_a.has(x) || !only_b.has(y)) continue;
      only_a.delete(x);
      only_b.delete(y);
      pairs.push({ a: x, b: y, by });
    }
  };
  claim('keys', keyOverlap, KEY_MATCH);
  if (byTitle) claim('title', titleOverlap, TITLE_MATCH);
  claim('shared_key', keyOverlap, 0);
  return { pairs, only_a: [...only_a], only_b: [...only_b] };
}
