import type { EventOf, GnomiEvent } from '../types.ts';

// The swarm feed and each persona's social memory (tech.md §6.5, §6.6), folded from the log.

export interface FeedPost {
  post_id: string;
  author: string | null; // persona id
  text: string;
  about_poi_id: string | null;
  injected: boolean; // put in the persona's name by the test harness, not written by the model
  round: number;
  seq: number;
  reactions: { agree: number; disagree: number };
  replies: FeedPost[];
}

/** The run's posts as threads in seq order, replies under their parents; each persona's latest reaction to a post counts once. */
export function feedThreads(events: GnomiEvent[]): FeedPost[] {
  const posts = new Map<string, FeedPost>();
  const threads: FeedPost[] = [];
  const reactions = new Map<string, Map<string, 'agree' | 'disagree'>>();
  for (const event of events) {
    if (event.type === 'social.post') {
      const { post_id, parent_id, text, about_poi_id, injected } = event.payload;
      const post: FeedPost = { post_id, author: event.persona_id, text, about_poi_id, injected: injected === true, round: event.round, seq: event.seq, reactions: { agree: 0, disagree: 0 }, replies: [] };
      (posts.get(parent_id ?? '')?.replies ?? threads).push(post); // a reply whose parent is not in the log stands alone
      posts.set(post_id, post);
    } else if (event.type === 'social.reaction' && event.persona_id) {
      let by = reactions.get(event.payload.post_id);
      if (!by) reactions.set(event.payload.post_id, (by = new Map()));
      by.set(event.persona_id, event.payload.kind);
    }
  }
  for (const [post_id, by] of reactions) {
    const post = posts.get(post_id);
    if (post) for (const kind of by.values()) post.reactions[kind] += 1;
  }
  return threads;
}

export interface SocialMemory {
  follows: string[]; // persona ids
  seen: EventOf<'social.post'>[]; // in the order first shown in its feed
  own: EventOf<'social.post'>[]; // its posts and replies, injected ones included
}

/** What one persona knows of the swarm: who it follows, the posts it was shown and the ones in its name. */
export function socialMemory(events: GnomiEvent[], persona_id: string): SocialMemory {
  const posts = new Map<string, EventOf<'social.post'>>();
  const seen = new Set<string>();
  let follows: string[] = [];
  for (const event of events) {
    if (event.type === 'social.post') posts.set(event.payload.post_id, event);
    if (event.persona_id !== persona_id) continue;
    if (event.type === 'persona.created') follows = event.payload.follows ?? [];
    if (event.type === 'social.feed_viewed') for (const id of event.payload.post_ids) seen.add(id);
  }
  return {
    follows,
    seen: [...seen].flatMap((id) => posts.get(id) ?? []),
    own: [...posts.values()].filter((post) => post.persona_id === persona_id),
  };
}
