import { similarity } from './similarity.ts';
import type { ReportTheme } from './types.ts';

// Which themes of two runs are the same problem (tech.md §8.2). Theme ids are positions, so they mean nothing outside one run.

/**
 * Themes sharing no group key are one problem when their titles' similarity is above this. In the M3 seed reports differently
 * worded true pairs score 0.06 to 0.37 and the best false pair 0.15, so this misses some rather than call a new problem an old one.
 */
export const TITLE_MATCH = 0.2;

export interface ThemeMatch {
  a: ReportTheme;
  b: ReportTheme;
  by: 'keys' | 'title';
}

export interface ThemeMatches {
  pairs: ThemeMatch[];
  only_a: ReportTheme[];
  only_b: ReportTheme[];
}

/** Shared keys over all keys: the judge may merge groups differently in each run, so any shared group counts. */
function keyOverlap(a: ReportTheme, b: ReportTheme): number {
  const [ours, theirs] = [new Set(a.keys), new Set(b.keys)];
  const shared = [...ours].filter((key) => theirs.has(key)).length;
  return shared === 0 ? 0 : shared / (ours.size + theirs.size - shared);
}

function titleOverlap(a: ReportTheme, b: ReportTheme): number {
  // A rules title spells out the page and element its keys hold, so two with keys and none shared differ by construction.
  if (a.named_by === 'rules' && b.named_by === 'rules' && a.keys && b.keys) return 0;
  return similarity([a.title, b.title]).max;
}

/** One-to-one pairs within each POI, by shared keys and then by title, closest first; a tie goes to the higher-ranked themes. Pure. */
export function matchThemes(a: ReportTheme[], b: ReportTheme[]): ThemeMatches {
  const only_a = new Set(a);
  const only_b = new Set(b);
  const pairs: ThemeMatch[] = [];
  const claim = (by: ThemeMatch['by'], overlap: typeof keyOverlap, above: number) => {
    const close = [...only_a]
      .flatMap((x) => [...only_b].filter((y) => y.poi_id === x.poi_id).map((y) => ({ x, y, score: overlap(x, y) })))
      .filter(({ score }) => score > above)
      .sort((p, q) => q.score - p.score || p.x.rank - q.x.rank || p.y.rank - q.y.rank);
    for (const { x, y } of close) {
      if (!only_a.has(x) || !only_b.has(y)) continue;
      only_a.delete(x);
      only_b.delete(y);
      pairs.push({ a: x, b: y, by });
    }
  };
  claim('keys', keyOverlap, 0);
  claim('title', titleOverlap, TITLE_MATCH);
  return { pairs, only_a: [...only_a], only_b: [...only_b] };
}
