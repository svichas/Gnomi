import { MEAN_SIMILARITY, similarity } from './similarity.ts';
import { postPois } from '../social/feed.ts';
import { influenceEdges, type InfluenceEdge } from '../social/influence.ts';
import type { EventOf, GnomiEvent, Persona, ReportHomogeneity, ReportPost, ReportSpread, ReportTheme, SpreadStats } from '../types.ts';
import { postsAbout, type Context, type Post } from './themes.ts';

// Step 7 of the report pipeline (tech.md §8.2) and the homogeneity guard (§6.6), as pure folds over the log. Which posts
// talk about which theme comes from the judge's tags, already checked against the known ids in themes.ts.

const SEEDS = 3;

type Opinion = EventOf<'persona.opinion_changed'>;

function segmentOf(id: string, ctx: Context) {
  const segment_id = ctx.personas.get(id)?.segment_id ?? null;
  return { segment_id, name: ctx.segments.find((s) => s.id === segment_id)?.name ?? 'Other personas' };
}

/** At each round's end, the mean of each persona's latest sentiment about the POI; `who` limits it to some personas. */
export function sentimentByRound(opinions: Opinion[], rounds: number, who: Set<string> | null): SpreadStats['sentiment'] {
  const own = opinions.filter((e) => !who || who.has(e.persona_id ?? ''));
  return Array.from({ length: rounds }, (_, i) => {
    const latest = new Map<string, number>();
    for (const e of own) if (e.round <= i + 1) latest.set(e.persona_id ?? '', e.payload.after.sentiment);
    const values = [...latest.values()];
    return { round: i + 1, mean: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, personas: values.length };
  });
}

/** Seeds, first- and second-hand personas, posters, readers and the segments they are in, influence and sentiment for one set of posts. */
function statsOf(talk: Post[], firstHand: Set<string>, shown: Map<string, Set<string>>, edges: InfluenceEdge[], sentiment: SpreadStats['sentiment'], ctx: Context): SpreadStats {
  const firstRound = Math.min(...talk.map((p) => p.round));
  const seeds: ReportPost[] = talk
    .filter((p) => p.round === firstRound)
    .slice(0, SEEDS)
    .map((p) => ({
      seq: p.seq,
      post_id: p.payload.post_id,
      persona_id: p.persona_id,
      persona_name: ctx.personas.get(p.persona_id)?.name ?? p.persona_id,
      segment_id: segmentOf(p.persona_id, ctx).segment_id,
      round: p.round,
      text: p.payload.text,
      injected: p.payload.injected === true,
    }));
  const posters = [...new Set(talk.map((p) => p.persona_id))];
  const ids = new Set(talk.map((p) => p.payload.post_id));
  const readers = [...shown].filter(([, posts]) => [...posts].some((id) => ids.has(id))).map(([id]) => id);
  const seedSegments = new Set(seeds.map((s) => s.segment_id));
  // Reach is who was shown a post, in the order they first were; posting is not reaching anyone.
  const reached = readers.map((id) => segmentOf(id, ctx));
  const segments = [...new Map(reached.map((s) => [s.segment_id, s])).values()].map((s) => ({
    ...s,
    personas: reached.filter((r) => r.segment_id === s.segment_id).length,
    seed: seedSegments.has(s.segment_id),
  }));
  return {
    posts: talk.length,
    seeds,
    first_hand: [...firstHand],
    second_hand: posters.filter((id) => !firstHand.has(id)),
    posters,
    readers,
    segments,
    influence: edges.filter((e) => e.kind === 'influence'),
    heard: edges.filter((e) => e.kind === 'heard'),
    sentiment,
  };
}

/** The opinion spread per POI with posts about it, and per theme the judge tagged posts with. */
export function buildSpread(events: GnomiEvent[], ctx: Context, themes: ReportTheme[], tagged: Map<string, string[]>, names: Map<string, string>): ReportSpread[] {
  const firstHandOf = (t: ReportTheme) => new Set(t.first_hand);
  const edges = influenceEdges(events).filter((e) => e.kind !== 'formed'); // a formed first opinion is not a shift
  const opinions = events.filter((e): e is Opinion => e.type === 'persona.opinion_changed' && e.persona_id !== null);
  const rounds = events.reduce((max, e) => Math.max(max, e.round), 1);
  const pois = [...new Set([...postPois(events).values()].filter((id) => id !== null))];
  // Who was shown which posts: in a feed, including the parents its replies quoted, or handed them at a step.
  const shown = new Map<string, Set<string>>();
  for (const e of events) {
    const ids = e.type === 'social.feed_viewed' ? [...e.payload.post_ids, ...(e.payload.parent_ids ?? [])] : e.type === 'persona.step' && Array.isArray(e.payload.heard_post_ids) ? e.payload.heard_post_ids : [];
    if (e.persona_id && ids.length) for (const id of ids) (shown.get(e.persona_id) ?? shown.set(e.persona_id, new Set()).get(e.persona_id)!).add(id);
  }

  return pois.map((poi_id) => {
    const talk = postsAbout(events, poi_id);
    const own = themes.filter((t) => t.poi_id === poi_id);
    const about = opinions.filter((e) => e.payload.poi_id === poi_id);
    const poiEdges = edges.filter((e) => e.poi_id === poi_id);
    const spread = statsOf(talk, new Set(own.flatMap((t) => [...firstHandOf(t)])), shown, poiEdges, sentimentByRound(about, rounds, null), ctx);
    return {
      poi_id,
      name: names.get(poi_id) ?? poi_id,
      ...spread,
      themes: own.flatMap((t) => {
        const posts = talk.filter((p) => tagged.get(p.payload.post_id)?.includes(t.id));
        if (posts.length === 0) return [];
        const ids = new Set(posts.map((p) => p.payload.post_id));
        const themeEdges = poiEdges.filter((e) => ids.has(e.post_id));
        const firstHand = firstHandOf(t);
        const who = new Set([...firstHand, ...posts.map((p) => p.persona_id), ...themeEdges.filter((e) => e.kind === 'influence').map((e) => e.to)]);
        return [{ theme_id: t.id, rank: t.rank, title: t.title, ...statsOf(posts, firstHand, shown, themeEdges, sentimentByRound(about, rounds, who), ctx) }];
      }),
    };
  });
}

/** Mean pairwise TF-IDF cosine of the models' posts and of the persona backgrounds, with a warning at the threshold. */
export function homogeneity(events: GnomiEvent[], population: Persona[]): ReportHomogeneity {
  // shortcut: every pair, O(posts²); sample the posts if runs start writing thousands of them.
  const texts = events.flatMap((e) => (e.type === 'social.post' && !e.payload.injected ? [e.payload.text] : []));
  const posts = texts.length > 1 ? similarity(texts).mean : null;
  const narratives = population.length > 1 ? similarity(population.map((p) => p.background)).mean : null;
  const alike = [
    posts !== null && posts >= MEAN_SIMILARITY ? `posts (mean similarity ${posts.toFixed(2)})` : null,
    narratives !== null && narratives >= MEAN_SIMILARITY ? `persona backgrounds (mean similarity ${narratives.toFixed(2)})` : null,
  ].filter((p) => p !== null);
  return {
    posts,
    post_count: texts.length,
    narratives,
    threshold: MEAN_SIMILARITY,
    warning: alike.length
      ? `The ${alike.join(' and the ')} read alike: the swarm may be writing with one voice rather than simulating a community. Treat the spread with extra caution.`
      : null,
  };
}
