import type { GnomiEvent } from '../types.ts';

export interface InfluenceEdge {
  from: string; // the author of the cited post
  to: string; // the persona whose opinion changed
  poi_id: string;
  post_id: string;
  seq: number; // the persona.opinion_changed event
  round: number;
  delta: number; // sentiment after − before
}

/**
 * Influence edges (tech.md §5.5, §6.6): B's opinion change cites A's post about the same POI and B's sentiment moved by at
 * least 0.5. Uncited changes, self-citations and posts about other POIs draw no edge. Pure; shared by graph, report and acceptance.
 */
export function influenceEdges(events: GnomiEvent[]): InfluenceEdge[] {
  const posts = new Map<string, { author: string; poi: string | null }>();
  const edges: InfluenceEdge[] = [];
  for (const e of events) {
    if (e.type === 'social.post' && e.persona_id) posts.set(e.payload.post_id, { author: e.persona_id, poi: e.payload.about_poi_id });
    if (e.type !== 'persona.opinion_changed' || !e.persona_id) continue;
    const { before, after, poi_id, cause } = e.payload;
    const delta = after.sentiment - (before?.sentiment ?? 0); // a first opinion moves from neutral
    if (Math.abs(delta) < 0.5) continue;
    for (const post_id of new Set(cause.post_ids)) {
      const post = posts.get(post_id);
      if (post && post.author !== e.persona_id && post.poi === poi_id) edges.push({ from: post.author, to: e.persona_id, poi_id, post_id, seq: e.seq, round: e.round, delta });
    }
  }
  return edges;
}
