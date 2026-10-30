import { isUnrated } from '../types.ts';
import type { Report, ReportSpread, ReportTheme } from '../types.ts';
import { matchThemes, type ThemeMatch } from './match.ts';
import { clusterThemes, plannedRuns, type ThemeCluster } from './repeats.ts';
import { isSevere, pathOf } from './themes.ts';

// What changed between two builds (features_roadmap.md item 10). Each side is one report or the finished runs of a repeat set, so
// there is one path, and it is computed when read, as a rejudge can change either side. Calling a live problem fixed is the worst
// error here, so every doubt below falls on the side of "not fixed". Competitor POIs stay out, as they do of every other figure.

/** Personas who must reach a theme's pages in one later run before its absence means anything. */
export const RETEST_REACH = 3;

/** `fixed` is for M6 and JSON readers; people read "Not seen again" (markdown.ts), as the personas may not have tried the failing path. */
export type DiffStatus = 'fixed' | 'new' | 'unchanged' | 'not_retested';

export interface Seen {
  seen_in: number; // runs of the side with this theme
  of: number; // runs of the side
}

/** A later run's theme on a new row. `weak`: only one shared key ties it to the row's other sightings, so it may be another problem. */
export interface Sighting {
  run_id: string;
  severity: number;
  weak?: true;
}

export interface ThemeDiff {
  status: DiffStatus;
  poi_id: string;
  before_title: string | null; // null: only the later side has it
  after_title: string | null; // null: only the earlier side has it
  before: Seen;
  after: Seen;
  severity: number; // the later side's when it has the theme
  pages: string[]; // without their host, which a new build may change
  reached: number | null; // the most personas who reached all its pages in one later run; null: no later report says
  weak?: true; // only one shared key holds the two sides together, so they may be different problems
  grouped_with?: string[]; // on a weak row, what a side's run was clustered with on one shared key; before_title and after_title are the themes that tied
  set_aside?: 'before' | 'after'; // the side whose evidence check set it aside
  sightings?: Sighting[]; // on a new row, one per later run with the theme: `severity` above is only the first run's
}

/** A number on both sides: the mean over a side's runs that have one. */
export interface Change {
  before: number | null;
  after: number | null;
  delta: number | null;
}

export interface SegmentDiff {
  segment_id: string | null;
  name: string;
  sentiment: Change;
  with_friction: Change;
}

export interface SpreadDiff {
  poi_id: string;
  name: string;
  posts: Change;
  second_hand: Change; // personas who posted about it without meeting it first-hand
  readers: Change; // personas shown a post about it
  sentiment: Change; // the mean opinion at the last round with one
  segments: { segment_id: string | null; name: string; readers: Change }[];
}

/** A note that makes the two sides unlike, for a reader that must act on it rather than print it (report/gate.ts). */
export interface DiffGap {
  kind: 'model' | 'personas' | 'goal' | 'pois' | 'stopped' | 'unrated';
  text: string;
}

export interface ReportDiff {
  before: string[]; // run ids
  after: string[];
  pois: { id: string; name: string }[]; // the team's, of both sides
  themes: ThemeDiff[]; // new first, then unchanged, not retested, fixed; worst first within each
  segments: SegmentDiff[];
  spread: SpreadDiff[]; // POIs with spread on both sides
  notes: string[]; // how the two sides differ, where that weakens the comparison
  gaps: DiffGap[]; // those of the notes that say the sides are not like for like
}

interface Link {
  a: ThemeCluster;
  b: ThemeCluster;
  pair: ThemeMatch; // the strongest pair of themes that ties them
  grouped: string[];
  weak: boolean;
}

const themesIn = (clusters: ThemeCluster[]) => clusters.flatMap(({ members }) => members.map(({ theme }) => theme));
const holding = (theme: ReportTheme) => ({ members }: ThemeCluster) => members.some((member) => member.theme === theme);
/** Who a theme is clustered with on one shared key, which a strong tie on that theme alone does not make the same problem. */
const looselyWith = ({ first, members }: ThemeCluster, theme: ReportTheme) => (members.find((member) => member.theme === theme)?.by === 'shared_key' ? [first.title] : []);

/**
 * The ties between two sides' clusters, by any of their themes, as a side's runs can name a problem differently. Matching is one to
 * one, but a judge can merge two problems in one run and split them in another: a leftover that shares a key with a taken theme is
 * still alive, so each gets its own pair. Its title alone does not keep it, as a fixed problem can sound like a live one. A tie is
 * weak only when nothing better than one shared key holds it, inside a side's cluster as well as between the sides.
 */
function tie(a: ThemeCluster[], b: ThemeCluster[]): Link[] {
  const [xs, ys] = [themesIn(a), themesIn(b)];
  const { pairs, only_a, only_b } = matchThemes(xs, ys);
  const links: Link[] = [];
  for (const pair of [...pairs, ...only_a.flatMap((x) => matchThemes([x], ys, false).pairs), ...only_b.flatMap((y) => matchThemes(xs, [y], false).pairs)]) {
    const [from, to] = [a.find(holding(pair.a))!, b.find(holding(pair.b))!];
    const grouped = [...looselyWith(from, pair.a), ...looselyWith(to, pair.b)];
    const weak = pair.by === 'shared_key' || grouped.length > 0;
    const link = links.find((known) => known.a === from && known.b === to);
    if (!link) links.push({ a: from, b: to, pair, grouped, weak });
    else if (link.weak && !weak) Object.assign(link, { pair, grouped, weak });
  }
  return links;
}

/**
 * Each later run's sighting of a new theme, tied to the row's other sightings rather than its first, as which run came first is chance.
 * A high-severity one is tied to the other high-severity ones alone, as those are what the gate counts (report/gate.ts). Pure.
 * shortcut: a row is still a cluster, so a run with two themes that each share one key with an earlier run's can push a sighting onto a
 * row of its own, where it ties to nothing; split new clusters on `by: 'shared_key'` if that misleads.
 */
function sightingsOf({ members }: ThemeCluster): Sighting[] {
  const severe = members.filter(({ theme }) => isSevere(theme.severity));
  return members.map((member) => {
    const others = (severe.includes(member) ? severe : members).filter((other) => other !== member);
    const tied = others.some(({ theme }) => matchThemes([member.theme], [theme]).pairs.some(({ by }) => by !== 'shared_key'));
    return { run_id: member.run.run_id, severity: member.theme.severity, ...(others.length && !tied ? { weak: true as const } : {}) };
  });
}

const pagesOf = ({ members }: ThemeCluster) => [...new Set(members.flatMap(({ theme }) => theme.pages.map(pathOf)))];

/**
 * The most personas who reached every page in one run. A theme with no pages came from a survey, so it counts who started its POI and
 * answered a survey there: a run can end before its surveys. A POI a run does not have counts nobody. A persona the run never started
 * or the model never answered tried nothing, so it is left out, as in every rate.
 * Null when no run has reach. Two hosts of a POI with one path count as one page, as in report/match.ts.
 * shortcut: a buyer objection has no pages, so it counts everyone surveyed on the POI, not the buyers; use buyer reach if that misleads.
 */
function reachOn(side: Report[], poi_id: string, pages: string[]): number | null {
  const reached = side.flatMap((run) => {
    if (!run.reach) return [];
    const spot = run.reach.find((reach) => reach.poi_id === poi_id);
    if (!spot || run.pois.find((poi) => poi.id === poi_id)?.competitor) return [0];
    const at = new Map<string, Set<string>>();
    for (const [page, ids] of Object.entries(spot.pages)) at.set(pathOf(page), new Set([...(at.get(pathOf(page)) ?? []), ...ids]));
    const needed = pages.length ? pages.map((page) => at.get(page) ?? new Set<string>()) : [new Set(spot.started), new Set(spot.surveyed)];
    return run.personas.filter((persona) => !isUnrated(persona.pois?.[poi_id] ?? persona.outcome) && needed.every((ids) => ids.has(persona.id))).length;
  });
  return reached.length ? Math.max(...reached) : null;
}

const mean = (values: (number | null | undefined)[]) => {
  const known = values.filter((value) => typeof value === 'number');
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
};

function change(before: (number | null | undefined)[], after: (number | null | undefined)[]): Change {
  const [was, now] = [mean(before), mean(after)];
  return { before: was, after: now, delta: was === null || now === null ? null : now - was };
}

function segmentChanges(before: Report[], after: Report[]): SegmentDiff[] {
  const named = new Map([...before, ...after].flatMap((run) => run.segments.map((segment) => [segment.id, segment.name] as const)));
  const across = <T>(pick: (run: Report) => T) => [before.map(pick), after.map(pick)] as const;
  return [...named].map(([id, name]) => ({
    segment_id: id,
    name,
    sentiment: change(...across((run) => run.sentiment?.find((row) => row.segment_id === id)?.sentiment)),
    with_friction: change(...across((run) => run.segments.find((row) => row.id === id)?.with_friction)),
  }));
}

function spreadChanges(before: Report[], after: Report[]): SpreadDiff[] {
  const spreadOf = (side: Report[], poi_id: string): ReportSpread[] => side.flatMap((run) => (run.pois.find((poi) => poi.id === poi_id)?.competitor ? [] : (run.spread ?? []).filter((spread) => spread.poi_id === poi_id)));
  const ids = [...new Set(before.flatMap((run) => (run.spread ?? []).map((spread) => spread.poi_id)))].filter((id) => spreadOf(before, id).length && spreadOf(after, id).length);
  return ids.map((poi_id) => {
    const [was, now] = [spreadOf(before, poi_id), spreadOf(after, poi_id)];
    const across = (pick: (spread: ReportSpread) => number | null | undefined) => change(was.map(pick), now.map(pick));
    const segments = new Map([...was, ...now].flatMap((spread) => spread.segments.map((segment) => [segment.segment_id, segment.name] as const)));
    return {
      poi_id,
      name: was[0].name,
      posts: across((spread) => spread.posts),
      second_hand: across((spread) => spread.second_hand.length),
      readers: across((spread) => spread.readers?.length),
      sentiment: across((spread) => spread.sentiment.findLast((round) => round.mean !== null)?.mean),
      segments: [...segments].map(([id, name]) => ({ segment_id: id, name, readers: across((spread) => spread.segments.find((segment) => segment.segment_id === id)?.personas ?? 0) })),
    };
  });
}

const distinct = (values: string[]) => [...new Set(values)].sort();
const listed = (values: string[]) => values.join(', ');
const sameList = (a: string[], b: string[]) => listed(a) === listed(b);

function modelNotes(before: Report[], after: Report[]): string[] {
  const roles = distinct([...before, ...after].flatMap((run) => Object.keys(run.methods.models))) as (keyof Report['methods']['models'])[];
  return roles.flatMap((role) => {
    const route = (side: Report[]) => distinct(side.flatMap((run) => { const model = run.methods.models[role]; return model ? [`${model.provider}:${model.model}`] : []; }));
    const reported = (side: Report[]) => distinct(side.flatMap((run) => run.methods.response_models?.[role] ?? []));
    const [routes, answers] = [[route(before), route(after)], [reported(before), reported(after)]];
    const differ = ([a, b]: string[][]) => a.length > 0 && b.length > 0 && !sameList(a, b);
    if (differ(routes)) return [`The ${role} ran on ${listed(routes[0])} in the earlier run and ${listed(routes[1])} in the later one, so a change may come from the model rather than the build.`];
    return differ(answers) ? [`The provider's ${role} model answered as ${listed(answers[0])} in the earlier run and ${listed(answers[1])} in the later one, so a change may come from the model rather than the build.`] : [];
  });
}

function gapsBetween(before: Report[], after: Report[]): DiffGap[] {
  const all = [...before, ...after];
  const varied = (values: unknown[]) => new Set(values).size > 1;
  const audience = (run: Report) => JSON.stringify(run.personas.map((persona) => [persona.id, persona.name, persona.segment_id]).sort());
  const pois = (side: Report[]) => new Map(side.flatMap((run) => run.pois.filter((poi) => !poi.competitor).map((poi) => [poi.id, poi.name] as const)));
  const [was, now] = [pois(before), pois(after)];
  const missing = (from: Map<string, string>, other: Map<string, string>) => [...from].filter(([id]) => !other.has(id)).map(([, name]) => name);
  const unfinished = (side: Report[], which: string) => {
    const of = side[0]?.repeat ? plannedRuns(side[0].repeat) : 0;
    return side.length < of ? [`Only ${side.length} of the ${of} runs of the ${which} set are compared: the others did not finish.`] : [];
  };
  const gaps = (kind: DiffGap['kind'], texts: string[]) => texts.map((text) => ({ kind, text }));
  return [
    ...gaps('model', modelNotes(before, after)),
    // An old report has no fingerprint, so only its labels are compared.
    ...gaps('personas', varied(all.map(audience)) || varied(all.flatMap(({ personas_fingerprint }) => personas_fingerprint ?? [])) ? ['The two sides have different personas, so a change may come from who tried it rather than the build.'] : []),
    ...gaps('goal', varied(all.map(({ goal }) => goal)) ? ['The two sides have different goals, so a change may come from what they tried rather than the build.'] : []),
    ...gaps('pois', [
      ...(missing(was, now).length ? [`The later run did not try ${listed(missing(was, now))}, so its themes read as not retested.`] : []),
      ...(missing(now, was).length ? [`The earlier run did not try ${listed(missing(now, was))}, so its themes read as new.`] : []),
    ]),
    ...gaps('stopped', [
      ...all.filter((run) => run.status !== 'finished').map((run) => `${run.run_id} stopped early${run.stop_reason ? ` (${run.stop_reason})` : ''}, so it covers less than a full run.`),
      ...unfinished(before, 'earlier'),
      ...unfinished(after, 'later'),
    ]),
    ...gaps('unrated', all.filter((run) => run.personas.every((persona) => isUnrated(persona.outcome))).map((run) => `No persona in ${run.run_id} got a valid answer from the model, so it says nothing about the build.`)),
  ];
}

const ORDER: DiffStatus[] = ['new', 'unchanged', 'not_retested', 'fixed'];

/** Compares two sides. `after` is the later one. Pure. */
export function diffReports(before: Report[], after: Report[]): ReportDiff {
  const ours = (pick: (run: Report) => ReportTheme[] | undefined) => (run: Report) => (pick(run) ?? []).filter((theme) => !run.pois.find((poi) => poi.id === theme.poi_id)?.competitor);
  const [ranked, aside] = [ours((run) => run.themes), ours((run) => run.set_aside)];
  const [was, now] = [clusterThemes(before, ranked), clusterThemes(after, ranked)];
  const links = tie(was, now);
  const gone = was.filter((cluster) => !links.some((link) => link.a === cluster));
  const added = now.filter((cluster) => !links.some((link) => link.b === cluster));
  // Kept on one side and set aside on the other, it was seen on both: the check changed its mind, which says nothing about the build.
  const asideLater = tie(gone, clusterThemes(after, aside));
  const asideEarlier = tie(clusterThemes(before, aside), added);

  const row = (status: DiffStatus, a: ThemeCluster | null, b: ThemeCluster | null, more: Partial<ThemeDiff> = {}): ThemeDiff => {
    const { first } = (b ?? a)!;
    const pages = pagesOf((b ?? a)!);
    return {
      status,
      poi_id: first.poi_id,
      before_title: a?.first.title ?? null,
      after_title: b?.first.title ?? null,
      before: { seen_in: a?.members.length ?? 0, of: before.length },
      after: { seen_in: b?.members.length ?? 0, of: after.length },
      severity: first.severity,
      pages,
      reached: reachOn(after, first.poi_id, pages),
      ...more,
    };
  };
  const paired = (ties: Link[], set_aside?: 'before' | 'after') => ties.map(({ a, b, pair, grouped, weak }) => row('unchanged', a, b, {
    ...(weak ? { weak: true as const, before_title: pair.a.title, after_title: pair.b.title } : {}),
    ...(grouped.length ? { grouped_with: grouped } : {}),
    ...(set_aside ? { set_aside } : {}),
  }));
  const themes = [
    ...paired(links),
    ...paired(asideLater, 'after'),
    ...paired(asideEarlier, 'before'),
    ...gone.filter((cluster) => !asideLater.some((link) => link.a === cluster)).map((cluster) => row((reachOn(after, cluster.first.poi_id, pagesOf(cluster)) ?? 0) >= RETEST_REACH ? 'fixed' : 'not_retested', cluster, null)),
    ...added.filter((cluster) => !asideEarlier.some((link) => link.b === cluster)).map((cluster) => row('new', null, cluster, { sightings: sightingsOf(cluster) })),
  ];
  const gaps = gapsBetween(before, after);
  return {
    before: before.map((run) => run.run_id),
    after: after.map((run) => run.run_id),
    pois: [...new Map([...before, ...after].flatMap((run) => run.pois.filter((poi) => !poi.competitor).map((poi) => [poi.id, poi.name] as const)))].map(([id, name]) => ({ id, name })),
    themes: themes.sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || b.severity - a.severity),
    segments: segmentChanges(before, after),
    spread: spreadChanges(before, after),
    notes: [
      ...gaps.map(({ text }) => text),
      ...(after.some((run) => !run.reach) ? ['A later report does not say which pages personas reached, so a theme it does not show reads as not retested unless another later run does.'] : []),
    ],
    gaps,
  };
}
