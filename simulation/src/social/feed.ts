import { runPois } from '../poi/pois.ts';
import type { FeedPolicy, GnomiEvent } from '../types.ts';

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
  const saw = (persona_id: string, ids: string[]) => {
    const set = seen.get(persona_id) ?? seen.set(persona_id, new Set()).get(persona_id)!;
    for (const id of ids) set.add(id);
  };
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

/**
 * The POI each post is about, as the report reads it: a reply without one inherits its parent's, and in a one-POI project a
 * post about nothing in particular is about that POI. Shared by the report's themes, spread and influence. Pure.
 */
export function postPois(events: GnomiEvent[]): Map<string, string | null> {
  const pois = runPois(events);
  const only = pois.length === 1 ? pois[0].id : null;
  const about = new Map<string, string | null>();
  for (const e of events) {
    if (e.type !== 'social.post') continue;
    const { post_id, parent_id, about_poi_id } = e.payload;
    about.set(post_id, about_poi_id ?? (parent_id === null ? undefined : about.get(parent_id)) ?? only);
  }
  return about;
}

// shortcut: about four characters a token plus the line's id, author and thread label; a tokenizer is not worth it at this cap.
const tokens = (post: FeedPost) => Math.ceil((post.text.length + 100) / 4);

/**
 * What one persona reads in a social phase (tech.md §6.6): unseen posts by the personas it follows, most reactions first, then two
 * trending posts from anyone, at most 12 posts and about 2,500 tokens. Never its own posts. Given `pois`, the persona's own points of
 * interest, posts about them (or about nothing in particular) rank before posts about the others, so a buyer reading the pricing copy
 * hears about the pricing before the app it will never open. Ties go by `random`, a stream seeded per persona and round, never by
 * event sequence, so response timing cannot pick the winner (new_simulation.md §5). The 'chronological' control shows the followed
 * posts in seq order under the same caps, with no ranking and no trending slots. Pure.
 */
export function selectFeed(board: Board, persona_id: string, follows: string[], random: () => number, pois?: ReadonlySet<string>, policy: FeedPolicy = 'ranked'): FeedPost[] {
  const seen = board.seen.get(persona_id) ?? new Set();
  const followed = new Set(follows);
  const unseen = board.posts.filter((p) => p.author !== persona_id && !seen.has(p.post_id));
  const shuffle = new Map(unseen.map((p) => [p, random()]));
  const relevant = (p: FeedPost) => (!pois || p.about_poi_id === null || pois.has(p.about_poi_id) ? 1 : 0);
  const rank = (posts: FeedPost[]) => [...posts].sort((a, b) => relevant(b) - relevant(a) || b.agree + b.disagree - (a.agree + a.disagree) || shuffle.get(a)! - shuffle.get(b)!);
  const theirs = unseen.filter((p) => followed.has(p.author));
  const mine = policy === 'chronological' ? theirs.slice(0, FEED_POSTS) : rank(theirs).slice(0, FEED_POSTS - TRENDING);
  const picked = new Set(mine);
  const trending = policy === 'chronological' ? [] : rank(unseen.filter((p) => !picked.has(p))).slice(0, TRENDING);
  const feed: FeedPost[] = [];
  let used = 0;
  for (const post of [...mine, ...trending]) {
    if (used + tokens(post) > FEED_TOKENS) continue;
    used += tokens(post);
    feed.push(post);
  }
  return feed;
}
