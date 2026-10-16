import type { AuthorSuggestion, EventOf, GnomiEvent, JudgeLike, JudgePostTag, JudgeTheme, Prevalence, ReportEvidence, ReportLike, ReportSegment, ReportSentiment, ReportTheme, Trust } from '../types.ts';
import { buildCandidates, categoryOf, groupCandidates, likeGroups, pagePattern, placesOf, poiNamesOf, stepEvidence, TRUST_WEIGHT, type Candidate, type CandidateKind, type Group, type LikeGroup } from './friction.ts';

// Steps 4–6, 8 and 9 of the report pipeline (tech.md §8.2) as pure folds. The judge's and author's answers come in as
// report.themes and report.suggestions events and are checked against the deterministic ids here, every time.

/** About 30k tokens of group summaries per judge call (tech.md §8.2); the author gets a little less. */
export const JUDGE_TOKEN_CAP = 30_000;
export const AUTHOR_TOKEN_CAP = 20_000;
/** Of the judge's cap, at most this much goes to post summaries in social runs (step 7); the groups get the rest. */
export const JUDGE_POST_CAP = 10_000;
/** Of what is left, at most this much goes to survey likes; the friction and objection groups get the rest. */
export const JUDGE_LIKE_CAP = 5_000;
/** Fewer personas than this on a POI and every share has a wide range, which the report says. */
export const FEW_PERSONAS = 5;
const POST_MAX = 280;
const EVIDENCE = 3;
const TITLE_MAX = 120;
const TEXT_MAX = 600;

const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const groupNo = (id: string) => Number(id.slice(1));
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export interface Context {
  poi_id: string; // events without a poi_id belong to the run's POI
  personas: Map<string, { name: string; segment_id: string | null }>;
  segments: Pick<ReportSegment, 'id' | 'name' | 'share'>[];
}

export interface GroupSummary {
  id: string;
  category: 'friction' | 'objection';
  page: string | null;
  element: string | null;
  kind: CandidateKind;
  personas: number;
  frictions: number;
  trust: Record<Trust, number>;
  severity: number;
  texts: string[];
}

export function frictionGroups(events: GnomiEvent[], poi_id: string): Group[] {
  return groupCandidates(buildCandidates(events, poi_id));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function maxTrust(members: Candidate[]): Trust {
  return members.reduce<Trust>((best, m) => (TRUST_WEIGHT[m.trust] > TRUST_WEIGHT[best] ? m.trust : best), 'reported');
}

export function summarise(group: Group): GroupSummary {
  const trust: Record<Trust, number> = { confirmed: 0, observed: 0, reported: 0 };
  for (const m of group.members) trust[m.trust] += 1;
  return {
    id: group.id,
    category: categoryOf(group.kind),
    page: group.page,
    element: group.element,
    kind: group.kind,
    personas: new Set(group.members.map((m) => m.persona_id)).size,
    frictions: group.members.length,
    trust,
    severity: median(group.members.map((m) => m.severity)),
    texts: [...new Set(group.members.map((m) => clip(m.text, 200)))].slice(0, 3),
  };
}

/** The groups one judge call sees, most personas first, while they fit the cap; the others stay as their own themes. */
export function judgeGroups(groups: Group[], cap = JUDGE_TOKEN_CAP): GroupSummary[] {
  const order = groups.map(summarise).sort((a, b) => b.personas - a.personas || b.frictions - a.frictions || groupNo(a.id) - groupNo(b.id));
  const sent: GroupSummary[] = [];
  let used = 0;
  for (const summary of order) {
    const cost = tokens(summary);
    if (used + cost > cap) continue;
    used += cost;
    sent.push(summary);
  }
  return sent;
}

export type Post = EventOf<'social.post'> & { persona_id: string };

/** Posts about one POI, replies included, in seq order. */
export const postsAbout = (events: GnomiEvent[], poi_id: string) =>
  events.filter((e): e is Post => e.type === 'social.post' && e.persona_id !== null && e.payload.about_poi_id === poi_id);

export interface PostSummary {
  id: string;
  round: number;
  text: string;
}

export interface LikeSummary {
  id: string;
  where: string | null;
  personas: number;
  texts: string[];
}

export function summariseLike(group: LikeGroup): LikeSummary {
  return {
    id: group.id,
    where: group.where,
    personas: new Set(group.members.map((m) => m.persona_id)).size,
    texts: [...new Set(group.members.map((m) => clip(m.text, 200)))].slice(0, 3),
  };
}

/**
 * What one judge call sees: post summaries up to their cap, then like summaries up to theirs, then the groups in what is
 * left. All posts when they fit, else an even stride over seq order so every round keeps some. Likes go most named first.
 * Without posts or likes the groups get the whole cap, as in M3.
 */
export function judgeInput(groups: Group[], posts: Post[], cap = JUDGE_TOKEN_CAP, postCap = JUDGE_POST_CAP, likes: LikeGroup[] = []) {
  const all: PostSummary[] = posts.map((p) => ({ id: p.payload.post_id, round: p.round, text: clip(p.payload.text, POST_MAX) }));
  const every = Math.max(1, Math.ceil(all.reduce((sum, p) => sum + tokens(p), 0) / postCap));
  const sent: PostSummary[] = [];
  let used = 0;
  for (let i = 0; i < all.length; i += every) {
    if (used + tokens(all[i]) > postCap) break;
    used += tokens(all[i]);
    sent.push(all[i]);
  }
  const liked: LikeSummary[] = [];
  let likeUsed = 0;
  for (const like of likes.map(summariseLike).sort((a, b) => b.personas - a.personas || groupNo(a.id) - groupNo(b.id))) {
    if (likeUsed + tokens(like) > JUDGE_LIKE_CAP) continue;
    likeUsed += tokens(like);
    liked.push(like);
  }
  return { groups: judgeGroups(groups, cap - used - likeUsed), posts: sent, ...(likes.length ? { likes: liked } : {}) };
}

/** Step 7's validation: a tag keeps a post the judge was shown and the themes holding its known group ids; the rest is reported. */
export function tagPosts(themes: ReportTheme[], tags: JudgePostTag[] | undefined, shown: Set<string>): { tagged: Map<string, string[]>; unknown: string[] } {
  const themeOf = new Map(themes.flatMap((t) => t.id.split('+').map((g) => [g, t.id] as const)));
  const tagged = new Map<string, string[]>();
  const unknown = new Set<string>();
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (!shown.has(tag?.post_id)) {
      unknown.add(String(tag?.post_id));
      continue;
    }
    for (const id of Array.isArray(tag.group_ids) ? tag.group_ids : []) {
      const theme = themeOf.get(id);
      const list = tagged.get(tag.post_id) ?? [];
      if (!theme) unknown.add(String(id));
      else if (!list.includes(theme)) tagged.set(tag.post_id, [...list, theme]);
    }
  }
  return { tagged, unknown: [...unknown] };
}

const KIND_TITLE: Record<CandidateKind, string> = {
  friction: 'Reported friction',
  abandoned: 'Personas gave up',
  survey: 'Survey friction',
  objection: 'Objection',
  failed_action: 'Actions that failed',
  loop: 'Going in circles',
  backtrack: 'Going back and forth',
  error: 'Errors',
  validation_error: 'Validation errors',
  small_target: 'Small tap targets',
};

const pathOf = (page: string) => (page.includes('/') ? page.slice(page.indexOf('/')) : page);

/** A title for a group the judge did not name: what kind of trouble, at which element, on which page. */
export function rulesTitle(group: Group): string {
  if (group.kind === 'survey' || group.kind === 'objection') return clip(group.members[0].text, TITLE_MAX);
  const where = group.page ? ` on ${pathOf(group.page)}` : '';
  return group.element ? `Trouble with ${group.element}${where}` : `${KIND_TITLE[group.kind]}${where}`;
}

const byEvidence = (a: Candidate, b: Candidate) => b.severity - a.severity || TRUST_WEIGHT[b.trust] - TRUST_WEIGHT[a.trust] || a.seqs[0] - b.seqs[0];

export interface Draft {
  groups: Group[];
  title: string;
  description: string;
  named_by: ReportTheme['named_by'];
}

/**
 * Step 4's validation: the judge's themes keep only known, unclaimed group ids; a theme left with none is dropped, and
 * every group it did not place becomes its own theme with a generated title. Malformed or missing output is all rules.
 */
export function applyJudge(groups: Group[], judged: JudgeTheme[] | null): { drafts: Draft[]; unknown: string[] } {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const placed = new Set<string>();
  const unknown = new Set<string>();
  const drafts: Draft[] = [];
  for (const theme of Array.isArray(judged) ? judged : []) {
    const ids = Array.isArray(theme?.group_ids) ? theme.group_ids : [];
    const members: Group[] = [];
    let category: 'friction' | 'objection' | null = null;
    for (const id of ids) {
      const group = byId.get(id);
      if (!group) unknown.add(String(id));
      // An objection and a friction are different findings: a theme keeps the category of its first group, and a group of the
      // other category stays unplaced, so it becomes its own theme.
      else if (!placed.has(id) && (category ??= categoryOf(group.kind)) === categoryOf(group.kind)) {
        placed.add(id);
        members.push(group);
      }
    }
    if (members.length === 0) continue;
    members.sort((a, b) => groupNo(a.id) - groupNo(b.id));
    const title = typeof theme.title === 'string' ? clip(theme.title, TITLE_MAX) : '';
    const description = typeof theme.description === 'string' ? clip(theme.description, TEXT_MAX) : '';
    drafts.push({ groups: members, title: title || rulesTitle(members[0]), description: description || topText(members), named_by: title ? 'judge' : 'rules' });
  }
  for (const group of groups) {
    if (!placed.has(group.id)) drafts.push({ groups: [group], title: rulesTitle(group), description: topText([group]), named_by: 'rules' });
  }
  return { drafts, unknown: [...unknown] };
}

const topText = (groups: Group[]) => clip(groups.flatMap((g) => g.members).sort(byEvidence)[0].text, TEXT_MAX);

/** Up to three member frictions, highest severity first, one per persona before any persona gets a second. */
export function pickEvidence(members: Candidate[], n = EVIDENCE): Candidate[] {
  const order = [...members].sort(byEvidence);
  const picked = new Set<Candidate>();
  const personas = new Set<string>();
  for (const m of order) {
    if (picked.size < n && !personas.has(m.persona_id)) {
      picked.add(m);
      personas.add(m.persona_id);
    }
  }
  for (const m of order) if (picked.size < n) picked.add(m);
  return order.filter((m) => picked.has(m));
}

interface Reach {
  pages: Map<string, Set<string>>; // persona → page patterns it reached
  poi: Map<string, Set<string>>; // poi → personas that reached it at all
}

function reachOf(events: GnomiEvent[], candidates: Candidate[], defaultPoi: string): Reach {
  const places = placesOf(events);
  const pages = new Map<string, Set<string>>();
  const poi = new Map<string, Set<string>>();
  const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
  for (const e of events) {
    if (!e.persona_id) continue;
    if (e.type === 'persona.step') {
      add(pages, e.persona_id, pagePattern(e.payload.result.url_before, places));
      add(pages, e.persona_id, pagePattern(e.payload.result.url_after, places));
      add(poi, e.poi_id ?? defaultPoi, e.persona_id);
    } else if (e.type === 'persona.episode_started' || e.type === 'persona.survey') {
      add(poi, e.payload.poi_id, e.persona_id);
    }
  }
  for (const c of candidates) {
    if (c.page) add(pages, c.persona_id, c.page);
    add(poi, c.poi_id, c.persona_id);
  }
  return { pages, poi };
}

/**
 * Step 5: affected_s = personas in segment s with a friction in the theme ÷ personas in s who reached one of its pages
 * (any page of the POI for a theme of survey answers only); impact = Σ share_s × affected_s, with shares renormalised over the segments
 * in the run; score = impact × median severity × the highest trust weight.
 */
export function scoreTheme(members: Candidate[], poi_id: string, ctx: Context, reach: Reach) {
  const pages = [...new Set(members.flatMap((m) => (m.page ? [m.page] : [])))];
  const affectedIds = new Set(members.map((m) => m.persona_id));
  const reached = (id: string) =>
    affectedIds.has(id) || (pages.length === 0 ? !!reach.poi.get(poi_id)?.has(id) : pages.some((p) => reach.pages.get(id)?.has(p)));
  const total = ctx.segments.reduce((sum, s) => sum + s.share, 0);
  const ids = [...ctx.personas.keys()];
  const affected = ctx.segments.map((s) => {
    const inSegment = ids.filter((id) => ctx.personas.get(id)?.segment_id === s.id);
    const hit = inSegment.filter((id) => affectedIds.has(id)).length;
    const seen = inSegment.filter(reached).length;
    return { segment_id: s.id, name: s.name, affected: hit, reached: seen, rate: seen === 0 ? 0 : hit / seen };
  });
  const impact = total === 0 ? 0 : affected.reduce((sum, a, i) => sum + (ctx.segments[i].share / total) * a.rate, 0);
  const severity = median(members.map((m) => m.severity));
  const trust = maxTrust(members);
  const exposed = new Set([...(reach.poi.get(poi_id) ?? []), ...affectedIds]).size;
  const share = prevalence(affectedIds.size, exposed);
  // The lower end of the share's range, so a problem one persona of many met cannot outrank one that many met.
  return { affected, impact, severity, trust, prevalence: share, score: share.low * severity * TRUST_WEIGHT[trust] };
}

const Z = 1.96; // 95%

/**
 * k of n personas with its 95% Wilson score interval, which stays honest for small n and for 0 or n of n (tech.md §8.2 step 5).
 * Strong: three or more personas and at least a quarter of those who used the POI; some: two or more; single: one.
 */
export function prevalence(k: number, n: number): Prevalence {
  const exposed = Math.max(n, k);
  const level = k <= 1 ? 'single' : k >= 3 && k / exposed >= 0.25 ? 'strong' : 'some';
  if (exposed === 0) return { personas: 0, exposed: 0, share: 0, low: 0, high: 0, level };
  const p = k / exposed;
  const z2 = Z * Z;
  const centre = (p + z2 / (2 * exposed)) / (1 + z2 / exposed);
  const half = (Z * Math.sqrt((p * (1 - p)) / exposed + z2 / (4 * exposed * exposed))) / (1 + z2 / exposed);
  const round = (x: number) => Math.round(x * 1e4) / 1e4;
  return { personas: k, exposed, share: round(p), low: round(Math.max(0, centre - half)), high: round(Math.min(1, centre + half)), level };
}

function evidenceOf(c: Candidate, ctx: Context): ReportEvidence {
  const persona = ctx.personas.get(c.persona_id);
  return {
    seq: c.seqs[0],
    step_seq: c.step_seq,
    persona_id: c.persona_id,
    persona_name: persona?.name ?? c.persona_id,
    segment_id: persona?.segment_id ?? null,
    step_no: c.step_no,
    url: c.url,
    severity: c.severity,
    trust: c.trust,
    what: c.text,
    quote: c.quote,
    screenshot: c.screenshot,
    signals: c.signals,
    ...stepEvidence(c),
  };
}

const lastFor = <T extends 'report.themes' | 'report.suggestions'>(events: GnomiEvent[], type: T, poi_id: string) =>
  events.findLast((e) => e.type === type && (e.payload as { poi_id: string }).poi_id === poi_id) as Extract<GnomiEvent, { type: T }> | undefined;

/** Step 7's validation: one suggestion per known theme id, the first one given; blank text is no suggestion. */
export function applySuggestions(themes: ReportTheme[], suggestions: AuthorSuggestion[] | null): { unknown: string[] } {
  const byId = new Map(themes.map((t) => [t.id, t]));
  const unknown = new Set<string>();
  for (const s of Array.isArray(suggestions) ? suggestions : []) {
    const theme = byId.get(s?.theme_id);
    const change = typeof s?.change === 'string' ? clip(s.change, TEXT_MAX) : '';
    const solution = typeof s?.solution === 'string' ? clip(s.solution, TEXT_MAX * 2) : '';
    if (!theme) unknown.add(String(s?.theme_id));
    else if (!theme.suggestion && change) theme.suggestion = { change, solution };
  }
  return { unknown: [...unknown] };
}

/** What the author sees for one POI: its ranked themes with evidence, while they fit the cap. */
export function authorThemes(themes: ReportTheme[], cap = AUTHOR_TOKEN_CAP) {
  const sent = [];
  let used = 0;
  for (const t of themes) {
    const item = {
      id: t.id,
      title: t.title,
      description: t.description,
      trust: t.trust,
      personas: t.personas,
      pages: t.pages,
      elements: t.elements,
      evidence: t.evidence.map((e) => ({ what: clip(e.what, 300), quote: clip(e.quote, 300), url: e.url, signals: e.signals })),
    };
    const cost = tokens(item);
    if (used + cost > cap) break; // ranked, so the rest matter less
    used += cost;
    sent.push(item);
  }
  return sent;
}

/** Step 8: the mean survey sentiment and the share who would continue, per segment. */
export function sentimentBySegment(events: GnomiEvent[], ctx: Context): ReportSentiment[] {
  const surveys = new Map<string, { sentiment: number; would_continue: boolean }>(); // the latest per persona and POI
  for (const e of events) if (e.type === 'persona.survey' && e.persona_id) surveys.set(`${e.persona_id}\u0000${e.payload.poi_id}`, e.payload);
  if (surveys.size === 0) return [];
  return ctx.segments.map((s) => {
    const answers = [...surveys].filter(([key]) => ctx.personas.get(key.split('\u0000')[0])?.segment_id === s.id).map(([, a]) => a);
    return {
      segment_id: s.id,
      name: s.name,
      surveyed: answers.length,
      sentiment: answers.length === 0 ? null : answers.reduce((sum, a) => sum + a.sentiment, 0) / answers.length,
      would_continue: answers.length === 0 ? 0 : answers.filter((a) => a.would_continue).length / answers.length,
    };
  });
}

/** The personas who used each POI at all: an episode, a step or a survey on it. */
function exposureOf(events: GnomiEvent[], defaultPoi: string): Map<string, Set<string>> {
  const poi = new Map<string, Set<string>>();
  const add = (id: string, persona: string) => (poi.get(id) ?? poi.set(id, new Set()).get(id)!).add(persona);
  for (const e of events) {
    if (!e.persona_id) continue;
    if (e.type === 'persona.step') add(e.poi_id ?? defaultPoi, e.persona_id);
    else if (e.type === 'persona.episode_started' || e.type === 'persona.survey') add(e.payload.poi_id, e.persona_id);
  }
  return poi;
}

/** The judge's like themes keep only known, unclaimed like ids; every like group it did not place stays as its own. */
function applyJudgeLikes(groups: LikeGroup[], judged: JudgeLike[] | null | undefined): { groups: LikeGroup[]; title: string | null; description: string | null }[] {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const placed = new Set<string>();
  const merged: { groups: LikeGroup[]; title: string | null; description: string | null }[] = [];
  for (const theme of Array.isArray(judged) ? judged : []) {
    const members = (Array.isArray(theme?.group_ids) ? theme.group_ids : []).flatMap((id) => {
      const group = byId.get(id);
      if (!group || placed.has(id)) return [];
      placed.add(id);
      return [group];
    });
    if (members.length === 0) continue;
    const title = typeof theme.title === 'string' ? clip(theme.title, TITLE_MAX) : '';
    const description = typeof theme.description === 'string' ? clip(theme.description, TEXT_MAX) : '';
    merged.push({ groups: members.sort((a, b) => groupNo(a.id) - groupNo(b.id)), title: title || null, description: description || null });
  }
  for (const group of groups) if (!placed.has(group.id)) merged.push({ groups: [group], title: null, description: null });
  return merged;
}

/**
 * Step 9: survey likes grouped by the part of the product they name (their words, in older surveys), merged and named by the
 * judge when it ran, most personas first. With the run's context each like also says what share of personas named it.
 */
export function wentWell(events: GnomiEvent[], ctx?: Context): ReportLike[] {
  const groups = likeGroups(events);
  const exposure = ctx ? exposureOf(events, ctx.poi_id) : null;
  const likes: ReportLike[] = [];
  for (const poi_id of [...new Set(groups.map((g) => g.poi_id))]) {
    const judged = lastFor(events, 'report.themes', poi_id)?.payload.likes;
    for (const draft of applyJudgeLikes(groups.filter((g) => g.poi_id === poi_id), judged)) {
      const members = draft.groups.flatMap((g) => g.members).sort((a, b) => a.seq - b.seq);
      const ids = new Set(members.map((m) => m.persona_id));
      const where = [...new Set(members.flatMap((m) => (m.where ? [m.where] : [])))];
      const quotes = [...new Map(members.map((m) => [m.persona_id, m])).values()].slice(0, EVIDENCE);
      likes.push({
        text: draft.title ?? clip(members[0].text, TEXT_MAX),
        count: members.length,
        personas: ids.size,
        seqs: [...new Set(members.map((m) => m.seq))],
        ...(draft.description ? { description: draft.description } : {}),
        ...(where.length ? { where } : {}),
        ...(ctx && exposure
          ? {
              quotes: quotes.map((m) => ({ persona_id: m.persona_id, persona_name: ctx.personas.get(m.persona_id)?.name ?? m.persona_id, what: clip(m.text, TEXT_MAX) })),
              prevalence: prevalence(ids.size, new Set([...(exposure.get(poi_id) ?? []), ...ids]).size),
            }
          : {}),
      });
    }
  }
  return likes.sort((a, b) => b.personas - a.personas || b.count - a.count || a.seqs[0] - b.seqs[0]);
}

export interface Analysis {
  themes: ReportTheme[];
  tagged?: Map<string, string[]>; // post id → the ids of the themes the judge tagged it with; absent when it tagged none
  sentiment: ReportSentiment[];
  went_well: ReportLike[];
  limitations: string[];
}

/** Steps 1–6, 8 and 9 over one run's events, folding in whatever the judge and author answered. */
export function analyseFrictions(events: GnomiEvent[], ctx: Context): Analysis {
  const candidates = buildCandidates(events, ctx.poi_id);
  const groups = groupCandidates(candidates);
  const reach = reachOf(events, candidates, ctx.poi_id);
  const limitations: string[] = [];
  const themes: ReportTheme[] = [];
  const tagged = new Map<string, string[]>();

  for (const poi_id of [...new Set(groups.map((g) => g.poi_id))]) {
    const own = groups.filter((g) => g.poi_id === poi_id);
    const judged = lastFor(events, 'report.themes', poi_id);
    const { drafts, unknown } = applyJudge(own, judged?.payload.themes ?? null);
    const talk = postsAbout(events, poi_id);
    const input = judgeInput(own, talk);
    if (!judged) {
      limitations.push('The judge model did not name the themes (no key, a model failure, or the run stopped first), so each theme is one deterministic group with a generated title.');
      if (talk.length > 0) limitations.push('Without the judge, posts are not tagged to themes, so the opinion spread covers the product as a whole only.');
    } else {
      const sent = input.groups.length;
      if (sent < own.length) limitations.push(`${plural(own.length - sent, 'friction group')} did not fit the judge's input and stayed as their own themes.`);
      if (input.posts.length < talk.length) limitations.push(`${plural(talk.length - input.posts.length, 'post')} did not fit the judge's input and are not tagged to themes.`);
      if (unknown.length > 0) limitations.push(`The judge named unknown group ids (${unknown.join(', ')}); they were ignored.`);
    }

    const ranked = drafts
      .map((draft): ReportTheme => {
        const members = draft.groups.flatMap((g) => g.members);
        const { affected, impact, severity, trust, prevalence: share, score } = scoreTheme(members, poi_id, ctx, reach);
        return {
          id: draft.groups.map((g) => g.id).join('+'),
          poi_id,
          rank: 0,
          title: draft.title,
          description: draft.description,
          named_by: draft.named_by,
          category: categoryOf(draft.groups[0].kind),
          prevalence: share,
          trust,
          severity,
          impact,
          score,
          personas: new Set(members.map((m) => m.persona_id)).size,
          frictions: members.length,
          pages: [...new Set(members.flatMap((m) => (m.page ? [m.page] : [])))],
          elements: [...new Set(members.flatMap((m) => (m.element ? [m.element] : [])))],
          affected,
          evidence: pickEvidence(members).map((m) => evidenceOf(m, ctx)),
          seqs: [...new Set(members.flatMap((m) => m.seqs))].sort((a, b) => a - b),
          suggestion: null,
        };
      })
      .sort((a, b) => b.score - a.score || b.personas - a.personas || b.frictions - a.frictions || groupNo(a.id) - groupNo(b.id));
    ranked.forEach((t, i) => (t.rank = i + 1));

    if (judged && talk.length > 0) {
      const tags = tagPosts(ranked, judged.payload.posts, new Set(input.posts.map((p) => p.id)));
      for (const [post_id, ids] of tags.tagged) tagged.set(post_id, ids);
      if (tags.unknown.length > 0) limitations.push(`The judge tagged unknown post or group ids (${tags.unknown.join(', ')}); they were ignored.`);
    }

    const suggested = lastFor(events, 'report.suggestions', poi_id);
    if (!suggested) limitations.push('The author model wrote no suggested changes (no key, a model failure, or the run stopped first).');
    else {
      const { unknown: strays } = applySuggestions(ranked, suggested.payload.suggestions);
      const covered = ranked.filter((t) => t.suggestion).length;
      if (covered < ranked.length) limitations.push(`Suggested changes cover ${covered} of ${plural(ranked.length, 'theme')}.`);
      if (strays.length > 0) limitations.push(`The author named unknown theme ids (${strays.join(', ')}); they were ignored.`);
    }
    themes.push(...ranked);
  }

  // Said once, after the judge's and author's notes: a small run is the likeliest reason a share looks off.
  const names = poiNamesOf(events);
  const small = [...new Set(groups.map((g) => g.poi_id))].map((id) => ({ id, n: reach.poi.get(id)?.size ?? 0 })).filter(({ n }) => n > 0 && n < FEW_PERSONAS);
  if (small.length > 0) {
    const few = Math.min(...small.map(({ n }) => n));
    const which = small.length === 1 ? (names.get(small[0].id) ?? 'it') : 'some of what was tested';
    limitations.push(`Only ${plural(few, 'persona')} tried ${which}, so every share has a wide range and the order of the problems is rough.`);
  }
  const sentiment = sentimentBySegment(events, ctx);
  if (sentiment.length === 0 && events.some((e) => e.type === 'persona.step')) {
    limitations.push('No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".');
  }
  return { themes, ...(tagged.size > 0 ? { tagged } : {}), sentiment, went_well: wentWell(events, ctx), limitations };
}
