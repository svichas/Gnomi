import type { GnomiEvent } from '../types.ts';

export const FEED_POSTS = 12;
export const FEED_TOKENS = 2_500;
const TRENDING = 2;

export interface FeedPost {
  post_id: string;
  author: string; // persona id
  parent_id: string | null;
  text: string;
  about_poi_id: string | null;
  seq: number;
  agree: number;
  disagree: number;
}

export interface Board {
  posts: FeedPost[]; // in seq order
  seen: Map<string, Set<string>>; // persona id → post ids already shown to it or written by it
}

/** The swarm feed so far, folded from the log: every post with its reactions, and each persona's social memory of what it saw. Pure. */
export function readBoard(events: GnomiEvent[]): Board {
  const posts = new Map<string, FeedPost>();
  const seen = new Map<string, Set<string>>();
  const saw = (persona_id: string, ids: string[]) => seen.set(persona_id, new Set([...(seen.get(persona_id) ?? []), ...ids]));
  for (const e of events) {
    if (!e.persona_id) continue;
    if (e.type === 'social.post') {
      const { post_id, parent_id, text, about_poi_id } = e.payload;
      posts.set(post_id, { post_id, author: e.persona_id, parent_id, text, about_poi_id, seq: e.seq, agree: 0, disagree: 0 });
      saw(e.persona_id, [post_id]);
    } else if (e.type === 'social.reaction') {
      const post = posts.get(e.payload.post_id);
      if (post) post[e.payload.kind]++;
    } else if (e.type === 'social.feed_viewed') saw(e.persona_id, e.payload.post_ids);
  }
  return { posts: [...posts.values()], seen };
}

// shortcut: about four characters a token plus the line's id, author and thread label; a tokenizer is not worth it at this cap.
const tokens = (post: FeedPost) => Math.ceil((post.text.length + 100) / 4);

/**
 * What one persona reads in a social phase (tech.md §6.6): unseen posts by the personas it follows, most reactions first (newest
 * first on ties), then two trending posts from anyone, at most 12 posts and about 2,500 tokens. Never its own posts. Pure.
 */
export function selectFeed(board: Board, persona_id: string, follows: string[]): FeedPost[] {
  const seen = board.seen.get(persona_id) ?? new Set();
  const followed = new Set(follows);
  const rank = (posts: FeedPost[]) => [...posts].sort((a, b) => b.agree + b.disagree - (a.agree + a.disagree) || b.seq - a.seq);
  const unseen = board.posts.filter((p) => p.author !== persona_id && !seen.has(p.post_id));
  const mine = rank(unseen.filter((p) => followed.has(p.author))).slice(0, FEED_POSTS - TRENDING);
  const trending = rank(unseen.filter((p) => !mine.includes(p))).slice(0, TRENDING);
  const feed: FeedPost[] = [];
  let used = 0;
  for (const post of [...mine, ...trending]) {
    if (used + tokens(post) > FEED_TOKENS) continue;
    used += tokens(post);
    feed.push(post);
  }
  return feed;
}
