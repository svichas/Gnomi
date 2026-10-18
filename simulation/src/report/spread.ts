import { MEAN_SIMILARITY, similarity } from './similarity.ts';
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

/** Seeds, first- and second-hand personas, segments reached, influence and sentiment for one set of posts. */
function statsOf(talk: Post[], firstHand: Set<string>, edges: InfluenceEdge[], sentiment: SpreadStats['sentiment'], ctx: Context): SpreadStats {
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
  const seedSegments = new Set(seeds.map((s) => s.segment_id));
  // In order of reach: the seeds' posters come first.
  const reached = [...new Set([...posters, ...edges.map((e) => e.to)])].map((id) => segmentOf(id, ctx));
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
    segments,
    influence: edges,
    sentiment,
  };
}

/** The opinion spread per POI with posts about it, and per theme the judge tagged posts with. */
export function buildSpread(events: GnomiEvent[], ctx: Context, themes: ReportTheme[], tagged: Map<string, string[]>, names: Map<string, string>): ReportSpread[] {
  const personaAt = new Map(events.map((e) => [e.seq, e.persona_id]));
  const personasOf = (t: ReportTheme) => new Set(t.seqs.flatMap((seq) => personaAt.get(seq) ?? []));
  const edges = influenceEdges(events).filter((e) => e.kind === 'influence'); // a formed first opinion is not a shift
  const opinions = events.filter((e): e is Opinion => e.type === 'persona.opinion_changed' && e.persona_id !== null);
  const rounds = Math.max(1, ...events.map((e) => e.round));
  const pois = [...new Set(events.flatMap((e) => (e.type === 'social.post' && e.payload.about_poi_id !== null ? [e.payload.about_poi_id] : [])))];

  return pois.map((poi_id) => {
    const talk = postsAbout(events, poi_id);
    const own = themes.filter((t) => t.poi_id === poi_id);
    const about = opinions.filter((e) => e.payload.poi_id === poi_id);
    const poiEdges = edges.filter((e) => e.poi_id === poi_id);
    const spread = statsOf(talk, new Set(own.flatMap((t) => [...personasOf(t)])), poiEdges, sentimentByRound(about, rounds, null), ctx);
    return {
      poi_id,
      name: names.get(poi_id) ?? poi_id,
      ...spread,
      themes: own.flatMap((t) => {
        const posts = talk.filter((p) => tagged.get(p.payload.post_id)?.includes(t.id));
        if (posts.length === 0) return [];
        const ids = new Set(posts.map((p) => p.payload.post_id));
        const themeEdges = poiEdges.filter((e) => ids.has(e.post_id));
        const firstHand = personasOf(t);
        const who = new Set([...firstHand, ...posts.map((p) => p.persona_id), ...themeEdges.map((e) => e.to)]);
        return [{ theme_id: t.id, rank: t.rank, title: t.title, ...statsOf(posts, firstHand, themeEdges, sentimentByRound(about, rounds, who), ctx) }];
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
