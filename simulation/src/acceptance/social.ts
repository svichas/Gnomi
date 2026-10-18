import { isDeepStrictEqual } from 'node:util';
import { fnv1a } from '../audience/sample.ts';
import { influenceEdges, type InfluenceEdge } from '../social/influence.ts';
import type { EventOf, GnomiEvent, Opinion } from '../types.ts';
import type { Criterion, Mode } from './checks.ts';

export const AUDIT_SIZE = 50;
export interface SeedLog { seed: number; events: GnomiEvent[] } // empty when the seed never ran
export interface Reach { persona_id: string; segment_id: string | null; saw: boolean; repeated: boolean; influenced: boolean }
export interface Spread { post_id: string; author: string; segment_id: string | null; same: number; cross: number; same_population: number; cross_population: number; reached: Reach[] }

/**
 * Who the harness's complaint reached in a finished run: personas other than its author who saw a post of its thread in a
 * feed, replied in the thread, or drew an influence edge from it (the shared rule). Null when the log cannot answer.
 */
export function spreadOf(events: GnomiEvent[]): Spread | null {
  const started = events.find((e) => e.type === 'run.started');
  const seed = events.find((e) => e.type === 'social.post' && e.payload.injected);
  if (started?.type !== 'run.started' || seed?.type !== 'social.post' || !seed.persona_id || !events.some((e) => e.type === 'run.finished')) return null;
  const author = seed.persona_id;
  const segments = new Map(started.payload.config.personas.map((p) => [p.id, p.segment_id]));
  const thread = new Set([seed.payload.post_id]);
  const reach = new Map<string, Reach>();
  const mark = (persona_id: string | null, how: 'saw' | 'repeated' | 'influenced') => {
    if (!persona_id || persona_id === author) return;
    const entry = reach.get(persona_id) ?? { persona_id, segment_id: segments.get(persona_id) ?? null, saw: false, repeated: false, influenced: false };
    entry[how] = true;
    reach.set(persona_id, entry);
  };
  for (const e of events) {
    if (e.type === 'social.post' && e.payload.parent_id !== null && thread.has(e.payload.parent_id)) {
      thread.add(e.payload.post_id);
      mark(e.persona_id, 'repeated');
    }
    if (e.type === 'social.feed_viewed' && e.payload.post_ids.some((id) => thread.has(id))) mark(e.persona_id, 'saw');
  }
  for (const edge of influenceEdges(events)) if (edge.kind === 'influence' && thread.has(edge.post_id)) mark(edge.to, 'influenced');
  const segment_id = segments.get(author) ?? null;
  const reached = [...reach.values()].sort((a, b) => a.persona_id.localeCompare(b.persona_id));
  const same = reached.filter((r) => r.segment_id === segment_id).length;
  const same_population = [...segments].filter(([id, s]) => id !== author && s === segment_id).length;
  return { post_id: seed.payload.post_id, author, segment_id, same, cross: reached.length - same, same_population, cross_population: segments.size - 1 - same_population, reached };
}

/** Roadmap M4: more same-segment than cross-segment reach in at least four of five seeds. A tie is not more. */
export function spreadCriterion(mode: Mode, spreads: (Spread | null)[]): Criterion {
  const measured = spreads.filter((s) => s !== null);
  const wins = measured.filter((s) => s.same > s.cross).length;
  const losses = measured.length - wins;
  const per = spreads.map((s) => (s ? `${s.same}/${s.cross}` : 'missing')).join(', ');
  return {
    id: 'spread', live_required: true,
    status: mode !== 'live' ? 'NOT_RUN' : wins >= 4 ? 'PASS' : losses >= 2 ? 'FAIL' : 'NOT_RUN',
    detail: `Same-segment reach exceeded cross-segment reach in ${wins} of ${measured.length} measured seeds (${spreads.length - measured.length} missing); needs 4 of 5. Same/cross per seed: ${per}.`,
  };
}

/** A fixed pseudo-random sample: edges ordered by a hash of their identity, so input order and run order do not matter. */
export function sampleInfluenceEdges(runs: SeedLog[], size = AUDIT_SIZE): { seed: number; edge: InfluenceEdge }[] {
  const key = (seed: number, edge: InfluenceEdge) => fnv1a(`${seed}:${edge.seq}:${edge.post_id}`);
  return runs.flatMap(({ seed, events }) => influenceEdges(events).filter((edge) => edge.kind === 'influence').map((edge) => ({ seed, edge, key: key(seed, edge) })))
    .sort((a, b) => a.key - b.key || a.seed - b.seed || a.edge.seq - b.edge.seq || a.edge.post_id.localeCompare(b.edge.post_id))
    .slice(0, size)
    .map(({ seed, edge }) => ({ seed, edge }));
}

export interface AuditItem {
  seed: number; seq: number; round: number; from: string; to: string; poi_id: string; post_id: string; post_text: string;
  before: Opinion | null; after: Opinion; delta: number;
  reasoning: { llm_call_seq: number; response: unknown } | null; // the influenced persona's last socialiser answer before the change
  verdict: null; notes: string;
}

/** Evidence for each sampled edge; `responses` maps a seed's llm.call seq to its recorded transcript response. */
export function auditItems(runs: (SeedLog & { responses: Map<number, unknown> })[], size = AUDIT_SIZE): AuditItem[] {
  const bySeed = new Map(runs.map((run) => [run.seed, run]));
  return sampleInfluenceEdges(runs, size).map(({ seed, edge }) => {
    const { events, responses } = bySeed.get(seed)!;
    // The shared rule draws an edge only from a logged post and opinion change, so both exist.
    const post = events.find((e): e is EventOf<'social.post'> => e.type === 'social.post' && e.payload.post_id === edge.post_id)!;
    const change = events.find((e): e is EventOf<'persona.opinion_changed'> => e.seq === edge.seq && e.type === 'persona.opinion_changed')!;
    const call = events.findLast((e) => e.type === 'llm.call' && e.seq < edge.seq && e.persona_id === edge.to && e.payload.role === 'socialiser' && e.payload.status === 'ok');
    return {
      seed, seq: edge.seq, round: edge.round, from: edge.from, to: edge.to, poi_id: edge.poi_id, post_id: edge.post_id,
      post_text: post.payload.text, before: change.payload.before, after: change.payload.after, delta: edge.delta, reasoning: call ? { llm_call_seq: call.seq, response: responses.get(call.seq) ?? null } : null, verdict: null, notes: '',
    };
  });
}

/** The 80% plausibility audit needs a human or judge verdict on each sampled edge; nothing here infers one. */
export function auditCriterion(sampled: number): Criterion {
  return {
    id: 'influence_audit', status: 'NOT_RUN', live_required: true,
    detail: `${sampled} of ${AUDIT_SIZE} influence edges sampled into influence-audit.md${sampled < AUDIT_SIZE ? ' (the runs drew too few edges for the audit)' : ''}; at least 80% must be judged plausibly attributed to the cited post.`,
  };
}

// What the graph draws from (tech.md §5.5): steps, social events and opinion changes, and the influence edges between them.
const replayProjection = (events: GnomiEvent[]) => ({
  events: events.flatMap((e) => (e.type === 'persona.step' || e.type === 'persona.opinion_changed' || e.type.startsWith('social.') ? [e.seq] : [])),
  edges: influenceEdges(events),
});

/**
 * What stops the scrubber replaying a round from the log alone: unpaired or out-of-order round markers, social events or opinion
 * changes outside the round they carry, or a log prefix that projects differently from the events tagged with rounds up to it.
 * Null when there is nothing to replay (the run did not finish, or the log has no rounds).
 */
export function replayProblems(events: GnomiEvent[]): string[] | null {
  const marks = events.filter((e) => e.type === 'run.round_started' || e.type === 'run.round_ended');
  if (!marks.length || !events.some((e) => e.type === 'run.finished')) return null;
  const problems = marks.flatMap((e, i) => {
    const round = Math.floor(i / 2) + 1;
    const want = i % 2 ? 'run.round_ended' : 'run.round_started';
    return e.type === want && e.round === round ? [] : [`event ${e.seq}: expected ${want} for round ${round}, found ${e.type} for round ${e.round}`];
  });
  if (marks.length % 2) problems.push(`round ${Math.ceil(marks.length / 2)} has no run.round_ended`);
  if (problems.length) return problems;
  const windows = new Map<number, [start: number, end: number]>();
  for (let i = 0; i < marks.length; i += 2) windows.set(marks[i].round, [marks[i].seq, marks[i + 1].seq]);
  for (const e of events) {
    if (!e.type.startsWith('social.') && e.type !== 'persona.opinion_changed') continue;
    const window = windows.get(e.round);
    if (!window || e.seq < window[0] || e.seq > window[1]) problems.push(`event ${e.seq} (${e.type}) carries round ${e.round} but lies outside it`);
  }
  for (const [round, [, end]] of windows) {
    if (!isDeepStrictEqual(replayProjection(events.filter((e) => e.seq <= end)), replayProjection(events.filter((e) => e.round <= round)))) {
      problems.push(`round ${round}: the log up to event ${end} projects differently from the events tagged with rounds 1–${round}`);
    }
  }
  return problems;
}

/** Structural, so it can pass on a scripted rehearsal; a seed without a finished, round-based log leaves it NOT_RUN. */
export function replayCriterion(runs: SeedLog[]): Criterion {
  const results = runs.map(({ seed, events }) => ({ seed, problems: replayProblems(events) }));
  const problems = results.flatMap(({ seed, problems }) => (problems ?? []).map((p) => `seed ${seed}: ${p}`));
  const missing = results.filter((r) => r.problems === null).map((r) => r.seed);
  return {
    id: 'scrubber_replay', live_required: false,
    status: problems.length ? 'FAIL' : missing.length ? 'NOT_RUN' : 'PASS',
    detail: problems.length ? problems.slice(0, 10).join('; ') : missing.length ? `No finished round-based log for seeds ${missing.join(', ')}.` : 'Every round is bracketed by its markers, its social events carry it, and each round prefix of the reopened log projects the same posts and influence edges.',
  };
}

export const FRAME_RATE: Criterion = {
  id: 'graph_frame_rate', status: 'NOT_RUN', live_required: false,
  detail: 'Pan and zoom above 30 fps with 200 personas, 10 POIs and 5,000 edges during a live run is measured by the swarm graph performance check (app swarm tab), not by this runner.',
};
