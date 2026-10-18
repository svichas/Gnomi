import type { GnomiEvent } from '../types.ts';

export interface InfluenceEdge {
  from: string; // the author of the cited post
  to: string; // the persona whose opinion changed
  poi_id: string;
  post_id: string;
  seq: number; // the persona.opinion_changed event
  round: number;
  delta: number; // sentiment after − before
  kind: 'influence' | 'formed'; // formed: a first opinion after reading the post, not a change of one; counts use 'influence' only
}

/**
 * Influence edges (tech.md §5.5, §6.6): B's opinion change cites A's post about the same POI and B's sentiment moved by at
 * least 0.5. Only a change of a prior opinion is 'influence'; a first opinion citing the post is 'formed' (new_simulation.md §4).
 * Uncited changes, self-citations and posts about other POIs draw no edge. Pure; shared by graph, report and acceptance.
 */
export function influenceEdges(events: GnomiEvent[]): InfluenceEdge[] {
  const posts = new Map<string, { author: string; poi: string | null }>();
  const edges: InfluenceEdge[] = [];
  for (const e of events) {
    if (e.type === 'social.post' && e.persona_id) posts.set(e.payload.post_id, { author: e.persona_id, poi: e.payload.about_poi_id });
    if (e.type !== 'persona.opinion_changed' || !e.persona_id) continue;
    const { before, after, poi_id, cause } = e.payload;
    const delta = after.sentiment - (before?.sentiment ?? 0); // a first opinion moves from neutral
    if (Math.abs(delta) < 0.5) continue; // a no-op while sentiment is an integer: any change is at least 1
    const kind = before === null ? 'formed' : 'influence';
    for (const post_id of new Set(cause.post_ids)) {
      const post = posts.get(post_id);
      if (post && post.author !== e.persona_id && post.poi === poi_id) edges.push({ from: post.author, to: e.persona_id, poi_id, post_id, seq: e.seq, round: e.round, delta, kind });
    }
  }
  return edges;
}
