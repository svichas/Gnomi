import type { EventOf, GnomiEvent, Poi, ReportComparison } from '../types.ts';
import type { Context } from './themes.ts';

/** Competitor POIs: observe-only web POIs, counted apart from the team's product when the run has one (tech.md §7). */
export function competitorIds(pois: Poi[]): Set<string> {
  const observed = pois.filter((poi) => poi.type === 'web' && poi.mode === 'observe_only').map((poi) => poi.id);
  return new Set(observed.length < pois.length ? observed : []);
}

/** Each competitor's survey comparisons with the team's product (poi/compare.ts), counted by segment; the latest answer per persona. */
export function buildComparisons(events: GnomiEvent[], competitors: Set<string>, ctx: Context): ReportComparison[] {
  const latest = new Map<string, EventOf<'persona.survey'>>();
  for (const e of events) {
    if (e.type === 'persona.survey' && e.persona_id && e.payload.comparison && competitors.has(e.payload.poi_id)) latest.set(`${e.payload.poi_id}\u0000${e.persona_id}`, e);
  }
  return [...competitors].flatMap((poi_id): ReportComparison[] => {
    const surveys = [...latest.values()].filter((e) => e.payload.poi_id === poi_id);
    if (surveys.length === 0) return [];
    const answers = surveys.map((e) => {
      const persona = ctx.personas.get(e.persona_id!);
      const { prefers, reason } = e.payload.comparison!;
      return { seq: e.seq, persona_id: e.persona_id!, persona_name: persona?.name ?? e.persona_id!, segment_id: persona?.segment_id ?? null, prefers, reason };
    });
    const segments = ctx.segments.map((s) => {
      const own = answers.filter((a) => a.segment_id === s.id);
      const count = (prefers: string) => own.filter((a) => a.prefers === prefers).length;
      return { segment_id: s.id, name: s.name, compared: own.length, product: count('product'), competitor: count('competitor'), no_preference: count('no_preference') };
    });
    return [{ poi_id, with_poi_id: surveys[0].payload.comparison!.with_poi_id, segments, answers }];
  });
}
