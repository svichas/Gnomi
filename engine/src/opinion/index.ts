import { z } from 'zod';
import type { EventOf, GnomiEvent, Opinion } from '../types.ts';

/** Explicit claims, not sentiment inferred from the think-aloud text. */
export const opinionSchema = z.object({
  sentiment: z.number().int().min(-2).max(2),
  confidence: z.number().min(0).max(1),
  likes: z.array(z.string().trim().min(1).max(500)).max(5),
  frictions: z.array(z.string().trim().min(1).max(500)).max(5),
}).strict();

export function sameOpinion(before: Opinion | null, after: Opinion): boolean {
  return before !== null && before.sentiment === after.sentiment && before.confidence === after.confidence
    && JSON.stringify(before.likes) === JSON.stringify(after.likes) && JSON.stringify(before.frictions) === JSON.stringify(after.frictions);
}

export interface CurrentOpinion {
  run_id: string;
  persona_id: string;
  poi_id: string;
  opinion: Opinion;
  seq: number;
  round: number;
  cause: EventOf<'persona.opinion_changed'>['payload']['cause'];
}

/** Rebuild the latest value independently for every run/persona/POI; sequence is authoritative across rounds. */
export function foldOpinions(events: GnomiEvent[]): CurrentOpinion[] {
  const current = new Map<string, CurrentOpinion>();
  for (const event of events) {
    if (event.type !== 'persona.opinion_changed' || event.persona_id === null) continue;
    const key = JSON.stringify([event.run_id, event.persona_id, event.payload.poi_id]);
    const previous = current.get(key);
    if (previous && previous.seq >= event.seq) continue;
    current.set(key, {
      run_id: event.run_id, persona_id: event.persona_id, poi_id: event.payload.poi_id,
      opinion: structuredClone(event.payload.after), seq: event.seq, round: event.round, cause: structuredClone(event.payload.cause),
    });
  }
  return [...current.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, opinion]) => opinion);
}
