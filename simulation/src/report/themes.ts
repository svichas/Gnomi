import type { AuthorSuggestion, CheckVerdict, EventOf, GnomiEvent, JudgeLike, JudgePostTag, JudgeTheme, EvidenceLevel, Prevalence, ReportEvidence, ReportLike, ReportReach, ReportSegment, ReportSentiment, ReportTheme, ThemeCheck, Trust } from '../types.ts';
import { postPois } from '../social/feed.ts';
import { pagePattern } from '../signals/index.ts';
import { buildCandidates, categoryOf, groupCandidates, groupKey, isWeak, latestSurveys, likeGroups, placesOf, poiNamesOf, stepEvidence, TRUST_WEIGHT, type Candidate, type CandidateKind, type Group, type LikeGroup } from './friction.ts';

// Steps 4–6, 8 and 9 of the report pipeline (tech.md §8.2) as pure folds. The judge's, check's and author's answers come in as
// report.themes, report.checks and report.suggestions events and are checked against the deterministic ids here, every time.

/** About 30k tokens of group summaries per judge call (tech.md §8.2); the author gets a little less. */
export const JUDGE_TOKEN_CAP = 30_000;
export const AUTHOR_TOKEN_CAP = 20_000;
/** Of the judge's cap, at most this much goes to post summaries in social runs (step 7); the groups get the rest. */
export const JUDGE_POST_CAP = 10_000;
/** Of what is left, at most this much goes to survey likes; the friction and objection groups get the rest. */
export const JUDGE_LIKE_CAP = 5_000;
/** Of the author's cap, at most this much goes to page text. Excerpts get only what the themes leave, so they push no theme out. */
export const AUTHOR_PAGE_CAP = 10_000;
/** Characters of page text per piece of evidence: about a median page (M3 seed runs: 1,193) once PAGE_MARKS are gone. */
export const PAGE_TEXT_MAX = 1_200;
/** Friction themes the evidence check reviews per POI, top first. */
export const CHECK_MAX = 15;
const NEXT_STEPS = 2; // what the check sees of a persona after each piece of evidence
export const CHECK_VERDICTS = ['product', 'agent_mistake', 'environment', 'unclear'] as const satisfies readonly CheckVerdict[];
/** Fewer personas than this on a POI and every share has a wide range, which the report says. */
export const FEW_PERSONAS = 5;
const POST_MAX = 280;
const EVIDENCE = 3;
const TITLE_MAX = 120;
export const TEXT_MAX = 600; // also the judge schema's cap (models.ts), so a description the report keeps whole is never invalid
// The navigator's handles on a page: half its characters, and nothing a suggestion should quote.
const PAGE_MARKS = / \[(?:ref|box|cursor)=[^\]]*\]/g;

const tokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4);
const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const groupNo = (id: string) => Number.parseInt(id.slice(1), 10); // a merged theme "g1+g3" by its first group
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

/** The members a persona met. A scan's sits on the step of whoever reached the page first, which says nothing about who met the problem. */
const felt = (members: Candidate[]) => members.filter((m) => m.kind !== 'accessibility');

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
    personas: new Set(felt(group.members).map((m) => m.persona_id)).size,
    frictions: group.members.length,
    trust,
    severity: median(group.members.map((m) => m.severity)),
    texts: [...new Set(group.members.map((m) => clip(m.text, 200)))].slice(0, 3),
  };
}

/** The groups one judge call sees, most personas first, while they fit the cap; the others stay as their own themes. Weak groups never become one, so they are not sent. */
export function judgeGroups(groups: Group[], cap = JUDGE_TOKEN_CAP): GroupSummary[] {
  const order = groups.filter((g) => !isWeak(g)).map(summarise).sort((a, b) => b.personas - a.personas || b.frictions - a.frictions || groupNo(a.id) - groupNo(b.id));
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

/** Posts about one POI, replies included, in seq order; a post's POI as social/feed.ts postPois resolves it. */
export function postsAbout(events: GnomiEvent[], poi_id: string, about = postPois(events)): Post[] {
  return events.filter((e): e is Post => e.type === 'social.post' && e.persona_id !== null && about.get(e.payload.post_id) === poi_id);
}

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
export function tagPosts(themes: Pick<ReportTheme, 'id'>[], tags: JudgePostTag[] | undefined, shown: Set<string>): { tagged: Map<string, string[]>; unknown: string[] } {
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
  accessibility: 'Accessibility problems',
};

export const pathOf = (page: string) => (page.includes('/') ? page.slice(page.indexOf('/')) : page);

/** A persona's words as a title: the first sentence, cut at a word when it is still too long. */
function headline(text: string): string {
  const first = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/\.$/, '');
  if (first.length <= TITLE_MAX) return first;
  const cut = first.lastIndexOf(' ', TITLE_MAX - 1);
  return `${first.slice(0, cut > 0 ? cut : TITLE_MAX - 1).replace(/[\s,;:]+$/, '')}…`;
}

/** A title for a group the judge did not name: what kind of trouble, at which element, on which page. */
export function rulesTitle(group: Group): string {
  if (group.kind === 'survey' || group.kind === 'objection') return headline(group.members[0].text);
  const where = group.page ? ` on ${pathOf(group.page)}` : '';
  const scan = group.kind === 'accessibility' ? group.members[0].scan?.help : null;
  return scan ? `${scan}${where}` : group.element ? `Trouble with ${group.element}${where}` : `${KIND_TITLE[group.kind]}${where}`;
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
    // An objection and a friction are different findings: a theme that mixes them is split in two, the category of its first
    // group first. Both keep the judge's name, so neither falls back to a quote; the second says which it is, so the two do not
    // read as one theme listed twice.
    const parts = new Map<'friction' | 'objection', Group[]>();
    for (const id of ids) {
      const group = byId.get(id);
      if (!group) unknown.add(String(id));
      else if (!placed.has(id)) {
        placed.add(id);
        const category = categoryOf(group.kind);
        parts.set(category, [...(parts.get(category) ?? []), group]);
      }
    }
    const title = typeof theme?.title === 'string' ? clip(theme.title, TITLE_MAX) : '';
    const description = typeof theme?.description === 'string' ? clip(theme.description, TEXT_MAX) : '';
    for (const [i, [category, members]] of [...parts].entries()) {
      members.sort((a, b) => groupNo(a.id) - groupNo(b.id));
      const named = title && i > 0 ? clip(`${category === 'objection' ? 'Objection' : 'Friction'}: ${title}`, TITLE_MAX) : title;
      drafts.push({ groups: members, title: named || rulesTitle(members[0]), description: description || topText(members), named_by: title ? 'judge' : 'rules' });
    }
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
  poiPages: Map<string, Map<string, Set<string>>>; // poi → page pattern → personas who reached it
  surveyed: Map<string, Set<string>>; // poi → personas who answered a survey on it
  poi: Map<string, Set<string>>; // poi → personas that reached it at all
  buyers: Map<string, Set<string>>; // poi → personas who answered a buyer survey on it
  buyerSeqs: Set<number>; // the buyer surveys' events
}

export function reachOf(events: GnomiEvent[], candidates: Candidate[], defaultPoi: string): Reach {
  const places = placesOf(events);
  const pages = new Map<string, Set<string>>();
  const poiPages = new Map<string, Map<string, Set<string>>>();
  const poi = exposureOf(events, defaultPoi);
  const surveyed = new Map<string, Set<string>>();
  const buyers = new Map<string, Set<string>>();
  const buyerSeqs = new Set<number>();
  const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V) => (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
  const reached = (poi_id: string, page: string, persona_id: string) => {
    add(pages, persona_id, page);
    add(poiPages.get(poi_id) ?? poiPages.set(poi_id, new Map()).get(poi_id)!, page, persona_id);
  };
  for (const e of events) {
    if (!e.persona_id) continue;
    if (e.type === 'persona.survey') add(surveyed, e.payload.poi_id, e.persona_id);
    if (e.type === 'persona.survey' && e.payload.buyer) {
      add(buyers, e.payload.poi_id, e.persona_id);
      buyerSeqs.add(e.seq);
    }
    if (e.type === 'persona.step') {
      reached(e.poi_id ?? defaultPoi, pagePattern(e.payload.result.url_before, places), e.persona_id);
      reached(e.poi_id ?? defaultPoi, pagePattern(e.payload.result.url_after, places), e.persona_id);
    }
  }
  for (const c of candidates) {
    if (c.page) reached(c.poi_id, c.page, c.persona_id);
    add(poi, c.poi_id, c.persona_id);
  }
  return { pages, poiPages, surveyed, poi, buyers, buyerSeqs };
}

/**
 * Step 5: affected_s = first-hand personas in segment s ÷ personas in s who reached one of the theme's pages (any page of the POI
 * for a theme of survey answers only; the buyers surveyed on it for buyer objections, its other personas for user answers only).
 * Prevalence is the first-hand personas of those who reached it. Severity is the median over personas of each one's worst; score = the share's low end × the mean
 * trust weight over personas, each at its best trust. Themes rank by evidence level, then severity tier, then score.
 */
export function scoreTheme(members: Candidate[], poi_id: string, ctx: Context, reach: Reach, firstHand = new Set(members.map((m) => m.persona_id))) {
  const pages = [...new Set(members.flatMap((m) => (m.page ? [m.page] : [])))];
  // A scan's persona counts only in a theme of nothing else, which still needs a severity and a trust.
  const met = felt(members);
  const counted = met.length > 0 ? met : members;
  const affectedIds = new Set(counted.map((m) => m.persona_id));
  // Buyers and users answer different surveys, so a theme from one survey only is a share of those who were asked it.
  const buyers = members.every((m) => m.kind === 'objection' && reach.buyerSeqs.has(m.seqs[0]));
  const users = members.every((m) => m.step_no === null && !reach.buyerSeqs.has(m.seqs[0]));
  const buyer = (id: string) => !!reach.buyers.get(poi_id)?.has(id);
  const onPoi = (id: string) => !!reach.poi.get(poi_id)?.has(id) && !(users && buyer(id));
  const reached = (id: string) =>
    affectedIds.has(id) || (buyers ? buyer(id) : pages.length === 0 ? onPoi(id) : pages.some((p) => reach.pages.get(id)?.has(p)));
  const ids = [...ctx.personas.keys()];
  const affected = ctx.segments.map((s) => {
    const inSegment = ids.filter((id) => ctx.personas.get(id)?.segment_id === s.id);
    const hit = inSegment.filter((id) => firstHand.has(id)).length;
    const seen = inSegment.filter(reached).length;
    return { segment_id: s.id, name: s.name, affected: hit, reached: seen, rate: seen === 0 ? 0 : hit / seen };
  });
  // Each persona counts once, so one persona repeating a problem cannot outvote the others.
  const worst = new Map<string, number>();
  const best = new Map<string, number>();
  const trust_counts: Record<Trust, number> = { confirmed: 0, observed: 0, reported: 0 };
  for (const m of counted) {
    worst.set(m.persona_id, Math.max(worst.get(m.persona_id) ?? 0, m.severity));
    best.set(m.persona_id, Math.max(best.get(m.persona_id) ?? 0, TRUST_WEIGHT[m.trust]));
  }
  for (const m of members) trust_counts[m.trust] += 1;
  const weight = [...best.values()].reduce((sum, w) => sum + w, 0) / best.size;
  const exposed = new Set([...ids.filter(reached), ...affectedIds]).size;
  const share = prevalence(firstHand.size, exposed);
  return { affected, severity: median([...worst.values()]), trust: maxTrust(members), trust_counts, prevalence: share, score: share.low * weight };
}

interface Echoes {
  feeds: EventOf<'social.feed_viewed'>[]; // in seq order
  heard: Map<number, string[]>; // step seq → the posts handed to that step; empty in logs from before heard ids
  authors: Map<string, string>; // post id → the persona who wrote it
  rounds: Map<number, number>; // event seq → its round
}

/**
 * The personas who met a theme first-hand (new_simulation.md §4): one report backed by a browser signal on their own step, or made before any feed
 * showed them a post the judge tagged with the theme (when it tagged any), and not at a step that was handed a post by a persona
 * who met the theme at an earlier round and step.
 */
function firstHand(members: Candidate[], theme: string, tagged: Map<string, string[]> | null, echoes: Echoes): Set<string> {
  // Seqs order completion, not time, across personas running at once; round then step number is the persona's own clock.
  const at = (c: Candidate) => [echoes.rounds.get(c.seqs[0]) ?? 0, c.step_no ?? Infinity];
  const earlier = (a: Candidate, b: Candidate) => at(a)[0] < at(b)[0] || (at(a)[0] === at(b)[0] && at(a)[1] < at(b)[1]);
  const echo = (c: Candidate) => {
    if (c.signals.some((s) => s !== 'accessibility')) return false; // a browser signal cannot repeat a post; a scan's may be on anyone's step, so it says nothing here
    const shown = tagged && echoes.feeds.find((e) => e.persona_id === c.persona_id && [...e.payload.post_ids, ...(e.payload.parent_ids ?? [])].some((id) => tagged.get(id)?.includes(theme)));
    if (shown && shown.seq < c.seqs[0]) return true;
    return (echoes.heard.get(c.step_seq ?? -1) ?? []).some((id) => {
      const author = echoes.authors.get(id);
      return author !== undefined && author !== c.persona_id && members.some((m) => m.persona_id === author && earlier(m, c));
    });
  };
  return new Set(members.filter((c) => !echo(c)).map((c) => c.persona_id));
}

const Z = 1.96; // 95%

/**
 * k of n personas with its 95% Wilson score interval, which stays honest for small n and for 0 or n of n (tech.md §8.2 step 5).
 * Strong: three or more personas and at least a quarter of n; some: two or more; single: one; none: nobody first-hand.
 */
// The first key of a theme's rank; the app and the markdown export show themes in rank order.
const EVIDENCE_ORDER: Record<EvidenceLevel, number> = { strong: 3, some: 2, single: 1, none: 0 };

export function prevalence(k: number, n: number): Prevalence {
  const exposed = Math.max(n, k);
  const level = k === 0 ? 'none' : k === 1 ? 'single' : k >= 3 && k / exposed >= 0.25 ? 'strong' : 'some';
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
    ...(c.box && { box: c.box }),
    signals: c.signals,
    ...(c.scan && { scan: c.scan }),
    ...(c.interference && { interference: true as const }),
    ...stepEvidence(c),
  };
}

const lastFor = <T extends 'report.themes' | 'report.checks' | 'report.suggestions'>(events: GnomiEvent[], type: T, poi_id: string) =>
  events.findLast((e) => e.type === type && (e.payload as { poi_id: string }).poi_id === poi_id) as Extract<GnomiEvent, { type: T }> | undefined;

/** What the evidence check reviews, from a POI's themes in rank order. An objection is an attitude, which evidence cannot settle. */
export const checkable = (ranked: ReportTheme[]) => ranked.filter((t) => t.category !== 'objection').slice(0, CHECK_MAX);

/** The check's validation: one verdict per theme it reviews, the first one given; any other id is reported. */
export function applyChecks(ranked: ReportTheme[], checks: ThemeCheck[]): { unknown: string[] } {
  const byId = new Map(checkable(ranked).map((t) => [t.id, t]));
  const unknown = new Set<string>();
  for (const c of checks) {
    const theme = byId.get(c?.theme_id);
    const reason = typeof c?.reason === 'string' ? clip(c.reason, TEXT_MAX) : '';
    if (!theme) unknown.add(String(c?.theme_id));
    else if (!theme.check && reason && CHECK_VERDICTS.includes(c.verdict)) theme.check = { verdict: c.verdict, reason };
  }
  return { unknown: [...unknown] };
}

// Moved out of the ranking and the friction rate, not deleted. An unclear theme stays: a model that cannot decide removes nothing.
const isSetAside = (t: ReportTheme) => t.check?.verdict === 'agent_mistake' || t.check?.verdict === 'environment';

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

/**
 * What the author sees for one POI: its ranked themes with evidence, while they fit the cap, then the page at each evidence step
 * (`pages`, by the step's seq) while that fits both AUTHOR_PAGE_CAP and what the themes left of the cap.
 * shortcut: an excerpt is the top of the page, so an element further down is cut; centre it on the element if suggestions still miss it.
 */
export function authorThemes(themes: ReportTheme[], pages: Map<number, string> = new Map(), cap = AUTHOR_TOKEN_CAP) {
  const brief = (t: ReportTheme, excerpt: (step_seq: number | null) => { page_text?: string }) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    trust: t.trust,
    personas: t.personas,
    pages: t.pages,
    elements: t.elements,
    evidence: t.evidence.map((e) => ({ what: clip(e.what, 300), quote: clip(e.quote, 300), url: e.url, signals: e.signals, ...excerpt(e.step_seq) })),
  });
  const sent: ReportTheme[] = [];
  let used = 0;
  for (const t of themes) {
    const cost = tokens(brief(t, () => ({})));
    if (used + cost > cap) break; // ranked, so the rest matter less
    used += cost;
    sent.push(t);
  }
  let room = Math.min(AUTHOR_PAGE_CAP, cap - used);
  return sent.map((t) =>
    brief(t, (step_seq) => {
      const page_text = clip((pages.get(step_seq ?? -1) ?? '').replace(PAGE_MARKS, ''), PAGE_TEXT_MAX);
      if (!page_text || tokens({ page_text }) > room) return {};
      room -= tokens({ page_text });
      return { page_text };
    }),
  );
}

/** What the check sees for one batch: the author's view of each theme, plus the persona's next steps and the number of the attached screenshot (`shots`, in order). */
export function checkInput(themes: ReportTheme[], pages: Map<number, string>, events: GnomiEvent[], shots: string[] = []) {
  const steps = events.filter((e): e is EventOf<'persona.step'> => e.type === 'persona.step');
  const nextSteps = (step_seq: number | null) => {
    const at = steps.find((s) => s.seq === step_seq);
    return at ? steps.filter((s) => s.seq > at.seq && s.persona_id === at.persona_id && s.poi_id === at.poi_id).slice(0, NEXT_STEPS) : [];
  };
  return authorThemes(themes, pages).map((brief, i) => ({
    ...brief,
    evidence: brief.evidence.map((item, j) => {
      const { step_seq, screenshot } = themes[i].evidence[j];
      const next_steps = nextSteps(step_seq).map(({ payload: { action, target, result, thought } }) => ({
        action: action.type,
        ...(target ? { target: `${target.role} "${target.name}"` } : {}),
        ...(action.text ? { text: clip(action.text, 200) } : {}),
        ok: result.ok,
        ...(result.error ? { error: result.error } : {}),
        url: result.url_after,
        thought: clip(thought, 300),
      }));
      const shot = shots.indexOf(screenshot ?? '') + 1;
      return { ...item, ...(next_steps.length ? { next_steps } : {}), ...(shot ? { screenshot: shot } : {}) };
    }),
  }));
}

/** Step 8: the mean survey sentiment and the share who would continue, per segment, over users' answers; buyers have their own section. */
export function sentimentBySegment(events: GnomiEvent[], ctx: Context): ReportSentiment[] {
  const surveys = latestSurveys(events, (e) => !e.payload.buyer);
  if (surveys.length === 0) return [];
  return ctx.segments.map((s) => {
    const answers = surveys.filter((e) => ctx.personas.get(e.persona_id!)?.segment_id === s.id).map((e) => e.payload);
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
export function wentWell(events: GnomiEvent[], ctx?: Context, groups = likeGroups(events)): ReportLike[] {
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

/** Evidence first, so one self-report cannot top a problem many met; then severity tier, then the share's low end × trust. */
export const rankOrder = (a: ReportTheme, b: ReportTheme) =>
  EVIDENCE_ORDER[b.prevalence?.level ?? 'none'] - EVIDENCE_ORDER[a.prevalence?.level ?? 'none'] || Math.round(b.severity) - Math.round(a.severity) || b.score - a.score || (b.prevalence?.personas ?? 0) - (a.prevalence?.personas ?? 0) || b.frictions - a.frictions || groupNo(a.id) - groupNo(b.id);

/**
 * Where to look first within this run; the rank stays as it is, so a next can sit below a later. An objection is an attitude, not
 * a fix, so it has none. One persona's recorded failure can still be a real defect (docs/interpreting-simulations.md).
 */
export function priorityOf({ category, severity, trust, prevalence: share }: ReportTheme): 'fix_now' | 'next' | 'later' | null {
  if (category === 'objection') return null;
  const severe = Math.round(severity) >= 3;
  const level = share?.level;
  if (severe && level === 'strong') return 'fix_now';
  if (level === 'strong' || (severe && level === 'some') || (severe && level === 'single' && trust !== 'reported')) return 'next';
  return 'later';
}

export interface Analysis {
  themes: ReportTheme[];
  set_aside?: ReportTheme[]; // left out of themes by the evidence check; absent when it set none aside
  reach: ReportReach[];
  tagged?: Map<string, string[]>; // post id → the ids of the themes the judge tagged it with; absent when it tagged none
  sentiment: ReportSentiment[];
  went_well: ReportLike[];
  limitations: string[];
}

/** Steps 1–6, 8 and 9 over one run's events, folding in whatever the judge and author answered. */
export function analyseFrictions(events: GnomiEvent[], ctx: Context): Analysis {
  const candidates = buildCandidates(events, ctx.poi_id);
  const groups = groupCandidates(candidates);
  // Group ids are positions and saved answers name them, so weak groups stay grouped and drop out as drafts below.
  const pois = [...new Set(groups.filter((g) => !isWeak(g)).map((g) => g.poi_id))];
  const likes = likeGroups(events);
  const reach = reachOf(events, candidates, ctx.poi_id);
  const names = poiNamesOf(events);
  const about = postPois(events);
  const limitations: string[] = [];
  const themes: ReportTheme[] = [];
  const set_aside: ReportTheme[] = [];
  const tagged = new Map<string, string[]>();
  const checkOn = events.find((e) => e.type === 'run.started')?.payload.config.project.settings?.finding_check;
  const echoes: Echoes = {
    feeds: events.filter((e): e is EventOf<'social.feed_viewed'> => e.type === 'social.feed_viewed'),
    heard: new Map(events.flatMap((e) => (e.type === 'persona.step' && Array.isArray(e.payload.heard_post_ids) ? [[e.seq, e.payload.heard_post_ids] as const] : []))),
    authors: new Map(events.flatMap((e) => (e.type === 'social.post' && e.persona_id ? [[e.payload.post_id, e.persona_id] as const] : []))),
    rounds: new Map(events.map((e) => [e.seq, e.round])),
  };

  for (const poi_id of pois) {
    // Each POI says the same things, so with several each note names its POI.
    const note = (text: string) => limitations.push(names.size > 1 ? `${names.get(poi_id) ?? poi_id}: ${text}` : text);
    const own = groups.filter((g) => g.poi_id === poi_id);
    const judged = lastFor(events, 'report.themes', poi_id);
    // Group ids are positions: after a change to the grouping rules an old answer's id names another group, so it is dropped.
    const keys = judged?.payload.keys;
    const keyOf = new Map(own.map((g) => [g.id, groupKey(g.members[0])]));
    const staleIn = (saved: Record<string, string> | undefined) => (id: unknown) => saved !== undefined && saved[String(id)] !== keyOf.get(String(id));
    const stale = staleIn(keys);
    const fresh = <T extends { group_ids?: unknown }>(items: T[] | undefined) =>
      Array.isArray(items) ? items.filter((item) => !(Array.isArray(item?.group_ids) && item.group_ids.some(stale))) : items;
    const judgedThemes = fresh(judged?.payload.themes);
    const judgedPosts = fresh(judged?.payload.posts);
    const { drafts, unknown } = applyJudge(own, judgedThemes ?? null);
    const talk = postsAbout(events, poi_id, about);
    const input = judgeInput(own, talk, undefined, undefined, likes.filter((g) => g.poi_id === poi_id));
    if (!judged) {
      note('The judge model did not name the themes (no key, a model failure, or the run stopped first), so each theme is one deterministic group with a generated title.');
      if (talk.length > 0) note('Without the judge, posts are not tagged to themes, so the opinion spread covers the product as a whole only.');
    } else {
      const missed = own.filter((g) => !isWeak(g)).length - input.groups.length;
      if (missed > 0) note(`${plural(missed, 'friction group')} did not fit the judge's input and stayed as their own themes.`);
      if (input.posts.length < talk.length) note(`${plural(talk.length - input.posts.length, 'post')} did not fit the judge's input and are not tagged to themes.`);
      if (unknown.length > 0) note(`The judge named unknown group ids (${unknown.join(', ')}); they were ignored.`);
      if (keys === undefined) note('This log predates group keys, so the judge\'s titles could not be checked against the current grouping and may name other groups.');
    }

    // Tagged before ranking: first-hand counts, and so the ranking, depend on which posts discuss which theme.
    const idOf = (draft: Draft) => draft.groups.map((g) => g.id).join('+');
    const tags = judged && talk.length > 0 ? tagPosts(drafts.map((d) => ({ id: idOf(d) })), judgedPosts, new Set(input.posts.map((p) => p.id))) : null;
    if (tags) {
      for (const [post_id, ids] of tags.tagged) tagged.set(post_id, ids);
      if (tags.unknown.length > 0) note(`The judge tagged unknown post or group ids (${tags.unknown.join(', ')}); they were ignored.`);
    }
    const themeTags = judged && tags?.tagged.size ? tags.tagged : null;
    const unseparated = 'Posts were not tagged to themes and the steps did not record which posts they were handed, so reports that repeat the feed could not be separated from first-hand ones.';
    if (!themeTags && echoes.heard.size === 0 && echoes.feeds.length > 0 && !limitations.includes(unseparated)) limitations.push(unseparated);

    // Left out here, not before: a saved tag or suggestion that names a weak group is known, not an unknown id.
    const weak = new Set(drafts.filter((d) => d.groups.every(isWeak)).map(idOf));
    const ranked = drafts
      .filter((draft) => !weak.has(idOf(draft)))
      .map((draft): ReportTheme => {
        const members = draft.groups.flatMap((g) => g.members);
        const id = idOf(draft);
        const met = felt(members);
        const personas = new Set(met.map((m) => m.persona_id)).size;
        const hand = firstHand(met, id, themeTags, echoes);
        const interference = members.filter((m) => m.interference).length;
        const { affected, severity, trust, trust_counts, prevalence: share, score } = scoreTheme(members, poi_id, ctx, reach, hand);
        return {
          id,
          keys: draft.groups.map((g) => groupKey(g.members[0])),
          poi_id,
          rank: 0,
          title: draft.title,
          description: draft.description,
          named_by: draft.named_by,
          category: categoryOf(draft.groups[0].kind),
          prevalence: share,
          heard_first: personas - hand.size,
          first_hand: [...hand],
          ...(met.length === 0 && { scan_only: true as const }),
          trust,
          trust_counts,
          severity,
          score,
          personas,
          frictions: members.length,
          pages: [...new Set(members.flatMap((m) => (m.page ? [m.page] : [])))],
          elements: [...new Set(members.flatMap((m) => (m.element ? [m.element] : [])))],
          affected,
          evidence: pickEvidence(members).map((m) => evidenceOf(m, ctx)),
          seqs: [...new Set(members.flatMap((m) => m.seqs))].sort((a, b) => a - b),
          ...(interference > 0 && { interference }),
          suggestion: null,
        };
      })
      .sort(rankOrder);

    // After a rejudge, a check older than the newest answer reviewed the earlier themes, whose positional ids may now name others.
    const newest = lastFor(events, 'report.checks', poi_id);
    const checked = judged && newest && newest.seq < judged.seq ? undefined : newest;
    const verdicts = Array.isArray(checked?.payload.checks) ? checked.payload.checks : [];
    const staleCheck = staleIn(checked?.payload.keys);
    const current = verdicts.filter((c) => !(typeof c?.theme_id === 'string' && c.theme_id.split('+').some(staleCheck)));
    const notChecked = applyChecks(ranked, current).unknown;
    if (current.length < verdicts.length) note(`The grouping rules changed after this run, so the report dropped ${plural(verdicts.length - current.length, 'evidence check')} naming groups that no longer match.`);
    if (notChecked.length > 0) note(`The evidence check named unknown theme ids (${notChecked.join(', ')}); they were ignored.`);
    const frictionThemes = ranked.filter((t) => t.category !== 'objection').length;
    const reviewed = ranked.filter((t) => t.check).length;
    if ((checkOn || newest) && reviewed < frictionThemes) note(`The evidence check covers ${reviewed} of ${plural(frictionThemes, 'friction theme')}.`);
    const shown = ranked.filter((t) => !isSetAside(t));
    set_aside.push(...ranked.filter(isSetAside));
    shown.forEach((t, i) => (t.rank = i + 1));

    // After a rejudge, suggestions older than the newest answer were written for the earlier themes.
    const latest = lastFor(events, 'report.suggestions', poi_id);
    const suggested = judged && latest && latest.seq < judged.seq ? undefined : latest;
    const given = suggested?.payload.suggestions;
    const suggestions = Array.isArray(given) ? given.filter((s) => !(typeof s?.theme_id === 'string' && s.theme_id.split('+').some(stale))) : given;
    const dropped = (judged?.payload.themes?.length ?? 0) - (judgedThemes?.length ?? 0) + (judged?.payload.posts?.length ?? 0) - (judgedPosts?.length ?? 0);
    const unsuggested = (given?.length ?? 0) - (suggestions?.length ?? 0);
    if (dropped + unsuggested > 0) note(`The grouping rules changed after this run, so ${plural(dropped, 'judge answer')} and ${plural(unsuggested, 'suggested change')} naming groups that no longer match were dropped.`);
    // With every theme set aside the author had nothing to do, which is no failure.
    if (!suggested && shown.length > 0) note('The author model wrote no suggested changes (no key, a model failure, or the run stopped first).');
    else if (suggested) {
      const strays = applySuggestions(ranked, suggestions ?? null).unknown.filter((id) => !weak.has(id));
      const covered = shown.filter((t) => t.suggestion).length;
      if (covered < shown.length) note(`Suggested changes cover ${covered} of ${plural(shown.length, 'theme')}.`);
      if (strays.length > 0) note(`The author named unknown theme ids (${strays.join(', ')}); they were ignored.`);
    }
    themes.push(...shown);
  }

  // Said once, after the judge's and author's notes: a small run is the likeliest reason a share looks off.
  const small = pois.map((id) => ({ id, n: reach.poi.get(id)?.size ?? 0 })).filter(({ n }) => n > 0 && n < FEW_PERSONAS);
  if (small.length > 0) {
    const few = Math.min(...small.map(({ n }) => n));
    const which = small.length === 1 ? (names.get(small[0].id) ?? 'it') : 'some of what was tested';
    limitations.push(`Only ${plural(few, 'persona')} tried ${which}, so every share has a wide range and the order of the problems is rough.`);
  }
  const sentiment = sentimentBySegment(events, ctx);
  if (sentiment.length === 0 && events.some((e) => e.type === 'persona.step')) {
    limitations.push('No persona answered the end-of-episode survey, so there is no sentiment by segment and no "what went well".');
  }
  return {
    themes,
    ...(set_aside.length > 0 ? { set_aside } : {}),
    reach: [...reach.poi].map(([poi_id, started]) => ({ poi_id, started: [...started], surveyed: [...(reach.surveyed.get(poi_id) ?? [])], pages: Object.fromEntries([...(reach.poiPages.get(poi_id) ?? [])].map(([page, ids]) => [page, [...ids]])) })),
    ...(tagged.size > 0 ? { tagged } : {}),
    sentiment,
    went_well: wentWell(events, ctx, likes),
    limitations,
  };
}
