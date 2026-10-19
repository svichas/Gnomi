import type { GnomiEvent } from '../types.ts';
import { postPois } from './feed.ts';

export interface InfluenceEdge {
  from: string; // the author of the cited post
  to: string; // the persona whose opinion changed
  poi_id: string;
  post_id: string;
  seq: number; // the persona.opinion_changed event
  round: number;
  delta: number; // sentiment after − before
  // formed: a first opinion after reading the post, not a change of one; heard: the change cites no post but its step was handed
  // this one. Counts use 'influence' only.
  kind: 'influence' | 'formed' | 'heard';
}

/**
 * Influence edges (tech.md §5.5, §6.6): B's opinion change cites A's post about the same POI and B's sentiment moved by at
 * least 0.5. Only a change of a prior opinion is 'influence'; a first opinion citing the post is 'formed' (new_simulation.md §4).
 * Uncited changes, self-citations and posts about other POIs draw no edge. Pure; shared by graph, report and acceptance.
 */
export function influenceEdges(events: GnomiEvent[]): InfluenceEdge[] {
  const about = postPois(events);
  const posts = new Map<string, { author: string; poi: string | null }>();
  const heard = new Map<number, string[]>(); // step seq → the posts handed to it
  const edges: InfluenceEdge[] = [];
  for (const e of events) {
    if (e.type === 'social.post' && e.persona_id) posts.set(e.payload.post_id, { author: e.persona_id, poi: about.get(e.payload.post_id) ?? null });
    if (e.type === 'persona.step' && Array.isArray(e.payload.heard_post_ids)) heard.set(e.seq, e.payload.heard_post_ids);
    if (e.type !== 'persona.opinion_changed' || !e.persona_id) continue;
    const { before, after, poi_id, cause } = e.payload;
    const delta = after.sentiment - (before?.sentiment ?? 0); // a first opinion moves from neutral
    if (Math.abs(delta) < 0.5) continue; // a no-op while sentiment is an integer: any change is at least 1
    const cited = new Set(cause.post_ids);
    const edge = (post_id: string, kind: InfluenceEdge['kind']) => {
      const post = posts.get(post_id);
      if (post && post.author !== e.persona_id && post.poi === poi_id) edges.push({ from: post.author, to: e.persona_id!, poi_id, post_id, seq: e.seq, round: e.round, delta, kind });
    };
    for (const post_id of cited) edge(post_id, before === null ? 'formed' : 'influence');
    // Product use cites steps, not posts: a post handed to one of those steps was heard before the change, not shown to cause it.
    for (const post_id of new Set(cause.step_ids.flatMap((seq) => heard.get(seq) ?? []))) if (!cited.has(post_id)) edge(post_id, 'heard');
  }
  return edges;
}
