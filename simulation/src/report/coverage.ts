import { isUnrated } from '../types.ts';
import type { Poi, Report, ReportCoverage, ReportPersona, ReportReach, ReportTheme } from '../types.ts';
import { RETEST_REACH } from './diff.ts';

// Whether later personas still found new problems, and what few of them reached (features_roadmap.md item 6). It reads what the
// report already holds and stays inside this simulated run: a flat curve says the run stopped finding, not that nothing is left.

/** Fewer personas than this and the curve is too short to read, so the hint claims nothing from it. */
export const CURVE_MIN = 10;

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

function hintOf(curve: number[] | undefined, last: { personas: number; themes: number }, left_out: number, status: Report['status']): string {
  if (!curve) return 'No problem here has a first-hand persona on record, so there is no curve.';
  const aside = left_out ? ` ${count(left_out, 'problem')} with no first-hand persona on record ${left_out === 1 ? 'is' : 'are'} left out.` : '';
  const who = `The last ${count(last.personas, 'persona')}`;
  if (curve.length < CURVE_MIN) return `With ${count(curve.length, 'persona')} the curve is too short to read.${aside}`;
  if (last.themes) return `${who} still found ${count(last.themes, 'new problem')} in this simulated run, so a larger run may find more.${aside}`;
  // The last to start are the first cut off, so their silence says nothing.
  if (status !== 'finished') return `${who} found nothing new, but the run stopped early, so they may not have got far.${aside}`;
  return `${who} found nothing new in this simulated run.${aside}`;
}

/**
 * Per POI of the team's: friction themes each persona met first-hand before any earlier persona, in the order they began, which is
 * the order `reach` lists them. Objections are attitudes, not problems found, and what the page scan found alone no persona found.
 * A persona the run never started or the model stopped answering is left out, as in every rate, unless it met a problem first: what
 * it found was found. A text is one place, so only web pages and design screens can be thin.
 */
export function buildCoverage(pois: Pick<Poi, 'id' | 'type'>[], personas: ReportPersona[], themes: ReportTheme[], reach: ReportReach[], status: Report['status']): ReportCoverage[] {
  return pois.flatMap((poi) => {
    const spot = reach.find(({ poi_id }) => poi_id === poi.id);
    if (!spot) return [];
    const problems = themes.filter((theme) => theme.poi_id === poi.id && theme.category !== 'objection' && !theme.scan_only);
    const counted = new Set([
      ...personas.filter((persona) => !isUnrated(persona.pois?.[poi.id] ?? persona.outcome)).map((persona) => persona.id),
      ...problems.flatMap((theme) => theme.first_hand ?? []),
    ]);
    const met = new Set<ReportTheme>();
    const added = spot.started.filter((id) => counted.has(id)).map((id) => {
      const first = problems.filter((theme) => !met.has(theme) && theme.first_hand?.includes(id));
      for (const theme of first) met.add(theme);
      return first.length;
    });
    const curve = met.size ? added : undefined;
    const tail = Math.ceil(added.length / 5);
    const last_fifth = { personas: tail, themes: added.slice(added.length - tail).reduce((sum, n) => sum + n, 0) };
    const left_out = problems.length - met.size;
    const thin_pages = poi.type === 'text' ? [] : Object.entries(spot.pages)
      .map(([page, ids]) => ({ page, personas: ids.filter((id) => counted.has(id)).length }))
      .filter(({ personas: reached }) => reached < RETEST_REACH)
      .sort((a, b) => a.personas - b.personas || (a.page < b.page ? -1 : 1));
    return [{
      poi_id: poi.id,
      ...(curve ? { curve, last_fifth } : {}),
      ...(left_out ? { left_out } : {}),
      thin_pages,
      hint: hintOf(curve, last_fifth, left_out, status),
    }];
  });
}
