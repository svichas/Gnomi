import type { EventOf, GnomiEvent, ReportBuyers, ReportLike } from '../types.ts';
import { latestSurveys, normaliseText } from './friction.ts';
import type { Context } from './themes.ts';

// The buying survey in the report (tech.md §7, agent/buyer.ts): per POI and segment, the latest answer of each buyer. A pure fold.

type Survey = EventOf<'persona.survey'>;

/** Answers grouped by their words, most mentioned first. */
function tally(answers: Survey[], pick: (s: Survey) => string[]): ReportLike[] {
  const groups = new Map<string, ReportLike & { ids: Set<string> }>();
  for (const s of answers) {
    for (const text of pick(s)) {
      const key = normaliseText(text);
      if (!key) continue;
      const group = groups.get(key) ?? groups.set(key, { text, count: 0, personas: 0, seqs: [], ids: new Set() }).get(key)!;
      group.count += 1;
      group.ids.add(s.persona_id ?? '');
      if (!group.seqs.includes(s.seq)) group.seqs.push(s.seq);
    }
  }
  return [...groups.values()].map(({ ids, ...g }) => ({ ...g, personas: ids.size })).sort((a, b) => b.count - a.count || a.seqs[0] - b.seqs[0]);
}

/** One row per POI and segment with a buyer's answer, in the project's and the audience's order. */
export function buyerResults(events: GnomiEvent[], pois: { id: string }[], ctx: Pick<Context, 'personas' | 'segments'>): ReportBuyers[] {
  const answers = latestSurveys(events, (e) => !!e.payload.buyer);
  return pois.flatMap((poi) => ctx.segments.flatMap((segment): ReportBuyers[] => {
    const own = answers.filter((s) => s.payload.poi_id === poi.id && ctx.personas.get(s.persona_id ?? '')?.segment_id === segment.id);
    if (own.length === 0) return [];
    const price = { low: 0, fair: 0, high: 0, unclear: 0 };
    for (const s of own) price[s.payload.buyer!.price] += 1;
    return [{
      poi_id: poi.id,
      segment_id: segment.id,
      name: segment.name,
      surveyed: own.length,
      sentiment: own.reduce((sum, s) => sum + s.payload.sentiment, 0) / own.length,
      would_buy: own.filter((s) => s.payload.buyer!.would_buy).length / own.length,
      price,
      objections: tally(own, (s) => s.payload.buyer!.objections),
      unclear: tally(own, (s) => s.payload.buyer!.unclear),
    }];
  }));
}
