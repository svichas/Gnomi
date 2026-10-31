import { clip } from '../agent/prompt.ts';
import { isUnrated } from '../types.ts';
import type { EventOf, GnomiEvent, Opinion, PriorPoi, PriorVisit, Report, RunConfig, SignalKind } from '../types.ts';
import { buildReport } from './build.ts';
import { buildCandidates, groupKey, SIGNAL_KINDS, type Candidate } from './friction.ts';
import { echoesOf, hostless, othersPosts, pathOf, type Echoes } from './themes.ts';

// What a returning persona remembers (features_roadmap.md item 12): a pure fold over the earlier run's log, frozen into the next run's
// config, so that run never reads this log. docs/odd.md has the policy.

// The memory sits in every step's prompt, so a long run still leaves a short one. All assumed (docs/odd.md).
export const PRIOR_PAGES = 8;
export const PRIOR_FRICTIONS = 5; // the worst; one left out is not remembered, so saying it again is a first report
export const PRIOR_LIKES = 3;
export const PRIOR_OPINION_ITEMS = 3;
export const PRIOR_TEXT = 200; // characters of any one text

const short = (texts: string[], most: number) => texts.slice(0, most).map((text) => clip(text, PRIOR_TEXT));

/** The last opinion before another persona's words could reach one: a change citing such a post or at a step handed one, as an opinion is a full snapshot that every later one inherits. */
function ownOpinion(events: GnomiEvent[], echoes: Echoes, persona_id: string, poi_id: string): Opinion | null {
  const changes = events.filter((e): e is EventOf<'persona.opinion_changed'> => e.type === 'persona.opinion_changed' && e.persona_id === persona_id && e.payload.poi_id === poi_id);
  const reached = changes.findIndex(({ payload: { cause } }) => othersPosts([...cause.post_ids, ...cause.step_ids.flatMap((seq) => echoes.heard.get(seq) ?? [])], persona_id, echoes).length > 0);
  const last = changes.slice(0, reached < 0 ? undefined : reached).at(-1)?.payload.after;
  return last ? { ...last, likes: short(last.likes, PRIOR_OPINION_ITEMS), frictions: short(last.frictions, PRIOR_OPINION_ITEMS) } : null;
}

/** Its complaints in a run, repeats of its own earlier ones too: one per group key, worst first, of the reports that hold no one else's words. Signals are not complaints. */
function ownFrictions(candidates: Candidate[], persona_id: string, poi_id: string, report: Report): PriorPoi['frictions'] {
  const themes = [...(report.themes ?? []), ...(report.set_aside ?? [])];
  // A theme's key names the report: every item of one survey shares a seq, and may sit in another theme.
  const echoed = (c: Candidate) => themes.find((theme) => theme.keys?.includes(groupKey(c)))?.echoed?.includes(c.seqs[0]);
  const said = candidates
    .filter((c) => c.persona_id === persona_id && c.poi_id === poi_id && !SIGNAL_KINDS.includes(c.kind as SignalKind) && !echoed(c))
    .toSorted((a, b) => b.severity - a.severity || a.seqs[0] - b.seqs[0]);
  return [...Map.groupBy(said, (c) => hostless(groupKey(c)))].slice(0, PRIOR_FRICTIONS).map(([key, [worst]]) => ({ key, what: clip(worst.text, PRIOR_TEXT) }));
}

/**
 * What one persona keeps of a run, or null when it used none of the team's POIs: a run that never got to it, or a model that never
 * answered, left it nothing to remember. Nothing here comes from another persona. Pure; the last three arguments save the work per persona.
 */
export function priorVisit(events: GnomiEvent[], persona_id: string, report = buildReport(events), candidates = buildCandidates(events, report.pois[0]?.id ?? ''), echoes = echoesOf(events)): PriorVisit | null {
  const persona = report.personas.find((p) => p.id === persona_id);
  if (!persona) return null;
  const pois = report.pois.filter((poi) => !poi.competitor).flatMap(({ id }): [string, PriorPoi][] => {
    const outcome = persona.pois?.[id] ?? persona.outcome;
    if (isUnrated(outcome)) return [];
    const reached = Object.entries(report.reach?.find((reach) => reach.poi_id === id)?.pages ?? {}).filter(([, personas]) => personas.includes(persona_id));
    const survey = events.findLast((e): e is EventOf<'persona.survey'> => e.type === 'persona.survey' && e.persona_id === persona_id && e.payload.poi_id === id)?.payload;
    return [[id, {
      outcome,
      pages: short([...new Set(reached.map(([page]) => pathOf(page)))], PRIOR_PAGES),
      frictions: ownFrictions(candidates, persona_id, id, report),
      survey: survey ? { sentiment: survey.sentiment, would_continue: survey.would_continue, reason: clip(survey.reason, PRIOR_TEXT), likes: short(survey.likes, PRIOR_LIKES) } : null,
      opinion: ownOpinion(events, echoes, persona_id, id),
    }]];
  });
  return pois.length ? { pois: Object.fromEntries(pois) } : null;
}

/** Every persona's memory of a run, for a returning run to freeze. Only this run's log is read, so memory goes one visit deep. Pure. */
export function priorOf(events: GnomiEvent[]): NonNullable<RunConfig['prior']> {
  const report = buildReport(events);
  const candidates = buildCandidates(events, report.pois[0]?.id ?? '');
  const echoes = echoesOf(events);
  const visits = report.personas.flatMap(({ id }) => {
    const visit = priorVisit(events, id, report, candidates, echoes);
    return visit ? [[id, visit] as const] : [];
  });
  return { run_id: report.run_id, memories: Object.fromEntries(visits) };
}
