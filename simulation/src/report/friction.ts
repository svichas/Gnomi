import { assetPlaces, placeName, runPois } from '../poi/pois.ts';
import type { ActionTarget, EventOf, EventPayloads, GnomiEvent, SignalKind, StepEvidence, Trust } from '../types.ts';

// Steps 1–3 of the report pipeline (tech.md §8.2): candidates, trust and deterministic grouping. Pure folds over the log.

export const TRUST_WEIGHT: Record<Trust, number> = { confirmed: 1, observed: 0.7, reported: 0.5 };
/** A self-report and a signal this many steps apart or fewer, on the same page, are one friction (tech.md §8.1). */
export const MERGE_STEPS = 3;
export const SIGNAL_KINDS: SignalKind[] = ['failed_action', 'loop', 'backtrack', 'error', 'validation_error', 'small_target'];
/** Severity (1–4) of a signal nobody reported; a backtrack is often just a persona reading again. */
export const SIGNAL_SEVERITY: Record<SignalKind, number> = { failed_action: 2, loop: 2, backtrack: 1, error: 2, validation_error: 2, small_target: 2 };
// Only a product failure corroborates a self-report: a loop, backtrack or small target is often the persona, a console line the page's noise.
const CORROBORATES = new Set<SignalKind>(['failed_action', 'validation_error', 'error']);
const ABANDON_SEVERITY = 3; // the persona gave up
const SURVEY_SEVERITY = 2; // surveys before structured items asked for frictions, not their severity

/** survey: a friction named in the end-of-episode survey; objection: a reason not to adopt, from the survey. */
export type CandidateKind = 'friction' | 'abandoned' | 'survey' | 'objection' | SignalKind;

/** Objections are reasons not to adopt; everything else got in the way of the task. They are ranked and shown apart. */
export const categoryOf = (kind: CandidateKind): 'friction' | 'objection' => (kind === 'objection' ? 'objection' : 'friction');

/** The frame or passage of the first of these that has one: a friction's own before its step's. Empty for web POIs. */
export function stepEvidence(...from: (StepEvidence | undefined)[]): StepEvidence {
  const frame = from.find((e) => e?.frame !== undefined)?.frame;
  const passage = from.find((e) => e?.passage)?.passage;
  return { ...(frame !== undefined && { frame }), ...(passage && { passage }) };
}

/** One normalised friction: a self-report, a signal, or both merged. */
export type Candidate = StepEvidence & {
  poi_id: string;
  persona_id: string;
  step_no: number | null; // null for survey answers
  step_seq: number | null;
  url: string | null;
  page: string | null; // the URL with ids normalised out
  element: string | null; // role "name" of the step's target
  kind: CandidateKind; // the self-report's kind when merged
  severity: number;
  trust: Trust;
  text: string;
  quote: string;
  screenshot: string | null;
  seqs: number[]; // the self-report first, then its signals
  signals: SignalKind[];
};

export interface Group {
  id: string; // g1, g2, … in order of the first member's event
  poi_id: string;
  page: string | null;
  element: string | null;
  kind: CandidateKind;
  members: Candidate[];
}

// Path segments that name a record rather than a page: numbers, UUIDs, long hex, long tokens with a digit.
const ID_SEGMENT = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{12,}|(?=[^/]*\d)[\w-]{16,})$/i;

/** The readable names of the run's text and design files (poi/pois.ts), from its frozen project. */
export const placesOf = (events: GnomiEvent[]): Map<string, string> => assetPlaces(runPois(events));

/** Each POI's name by its id, from the run's frozen project. */
export const poiNamesOf = (events: GnomiEvent[]): Map<string, string> => new Map(runPois(events).map((poi) => [poi.id, poi.name]));

/**
 * host + path with ids replaced by :id; query and fragment dropped. A URL that does not parse is its own pattern. A text's
 * or design's stored file is its readable name when `places` knows it, so titles and pages never show a file id.
 */
export function pagePattern(url: string, places?: Map<string, string>): string {
  const place = places?.get(url);
  if (place) return place;
  try {
    const { host, pathname } = new URL(url);
    const path = pathname.split('/').map((part) => (ID_SEGMENT.test(part) ? ':id' : part)).join('/').replace(/\/+$/, '');
    return `${host}${path || '/'}`;
  } catch {
    return url;
  }
}

/** Lowercase words only, so "Clear pricing!" and "clear  pricing" are one answer. */
export const normaliseText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const elementOf = (target: ActionTarget | null | undefined) => (target?.name.trim() ? `${target.role} "${target.name.trim()}"` : null);
const clampSeverity = (n: number) => Math.min(4, Math.max(1, Math.round(n) || 1));
const stepKey = (persona_id: string, step_no: number) => `${persona_id}\u0000${step_no}`;

type SignalEvent = EventOf<`signal.${SignalKind}`>;
const isSignal = (e: GnomiEvent): e is SignalEvent => e.type.startsWith('signal.') && SIGNAL_KINDS.includes(e.type.slice(7) as SignalKind);

/** Step 1 and 2: every self-report, survey friction and signal as a candidate, merged into confirmed frictions where they meet. */
export function buildCandidates(events: GnomiEvent[], defaultPoi: string): Candidate[] {
  const places = placesOf(events);
  const steps = new Map<string, { seq: number; payload: EventPayloads['persona.step'] }>();
  for (const e of events) if (e.type === 'persona.step') steps.set(stepKey(e.persona_id ?? '', e.payload.step_no), { seq: e.seq, payload: e.payload });

  const atStep = (e: GnomiEvent, step_no: number, url: string | null): Candidate => {
    const persona_id = e.persona_id ?? '';
    const step = steps.get(stepKey(persona_id, step_no));
    const page = url ?? step?.payload.result.url_before ?? null;
    return {
      poi_id: e.poi_id ?? defaultPoi,
      persona_id,
      step_no,
      step_seq: step?.seq ?? null,
      url: page === null ? null : placeName(page, places), // shown to people: a text or design by its name, not its file
      page: page === null ? null : pagePattern(page, places),
      element: elementOf(step?.payload.target),
      kind: 'friction',
      severity: 2,
      trust: 'reported',
      text: '',
      quote: step?.payload.thought ?? '',
      screenshot: step?.payload.screenshot ?? null,
      seqs: [e.seq],
      signals: [],
      ...stepEvidence(step?.payload),
    };
  };

  const reports: Candidate[] = [];
  const signals: Candidate[] = []; // those that may confirm a self-report
  const unmatched: Candidate[] = [];
  const surveys: Candidate[] = [];
  for (const e of events) {
    if (e.type === 'persona.friction_reported') {
      const at = atStep(e, e.payload.step_no, e.payload.where.url);
      // A text's confusions group by the passage they quote, a page's by the element they are about, not always the step's (loop.ts).
      const element = e.payload.passage?.text ? `passage "${e.payload.passage.text.replace(/\s+/g, ' ').slice(0, 120)}"` : e.payload.about ? elementOf(e.payload.about) : at.element;
      reports.push({ ...at, ...stepEvidence(e.payload, at), element, severity: clampSeverity(e.payload.severity), text: e.payload.what });
    } else if (e.type === 'persona.abandoned') {
      reports.push({ ...atStep(e, e.payload.step_no, null), kind: 'abandoned', severity: ABANDON_SEVERITY, text: e.payload.reason });
    } else if (e.type === 'persona.survey') {
      const survey = (kind: 'survey' | 'objection', text: string, where: string, severity: number): Candidate => ({
        poi_id: e.payload.poi_id, persona_id: e.persona_id ?? '', step_no: null, step_seq: null, url: null, page: null, element: where.trim() || null,
        kind, severity: clampSeverity(severity), trust: 'reported', text, quote: e.payload.reason, screenshot: null, seqs: [e.seq], signals: [],
      });
      if (e.payload.items) {
        for (const item of e.payload.items) {
          if (item.kind !== 'like') surveys.push(survey(item.kind === 'objection' ? 'objection' : 'survey', item.what, item.where, item.severity ?? SURVEY_SEVERITY));
        }
      } else {
        // Older surveys and buyers' answers are plain lists; a buyer's are what would stop the purchase, so objections.
        for (const text of e.payload.frictions) surveys.push(survey(e.payload.buyer ? 'objection' : 'survey', text, '', SURVEY_SEVERITY));
      }
    } else if (isSignal(e)) {
      const kind = e.type.slice(7) as SignalKind;
      // A console line or exception never corroborates. It may come from a script containment refused, but a blocked request
      // does not log its resource type, so such a step's page errors stay as candidates rather than all being dropped.
      const pageNoise = e.type === 'signal.error' && e.payload.kind !== 'http';
      const signal: Candidate = { ...atStep(e, e.payload.step_no, e.payload.url), kind, severity: SIGNAL_SEVERITY[kind], trust: 'observed', text: signalText(e), signals: [kind] };
      // A console line or exception is about the page, not the element clicked, so it groups by its text (groupKey).
      if (pageNoise) signal.element = null;
      (CORROBORATES.has(kind) && !pageNoise ? signals : unmatched).push(signal);
    }
  }

  // Each corroborating signal joins the nearest self-report of the same persona on the same page within MERGE_STEPS; ties go to the earlier one.
  for (const signal of signals) {
    const distance = (r: Candidate) => Math.abs((r.step_no ?? Infinity) - (signal.step_no ?? Infinity));
    const near = reports.filter((r) => r.persona_id === signal.persona_id && r.poi_id === signal.poi_id && r.page === signal.page && distance(r) <= MERGE_STEPS);
    const best = near.sort((a, b) => distance(a) - distance(b) || a.seqs[0] - b.seqs[0])[0];
    if (!best) {
      unmatched.push(signal);
      continue;
    }
    best.trust = 'confirmed';
    best.seqs.push(...signal.seqs);
    if (!best.signals.includes(signal.kind as SignalKind)) best.signals.push(signal.kind as SignalKind);
    best.element ??= signal.element;
  }
  return [...reports, ...unmatched, ...surveys].sort((a, b) => a.seqs[0] - b.seqs[0]);
}

function signalText(e: SignalEvent): string {
  switch (e.type) {
    case 'signal.failed_action':
      return `A ${e.payload.action} failed (${e.payload.error})`;
    case 'signal.loop':
      return `The same page state came back ${e.payload.visits} times`;
    case 'signal.backtrack':
      return e.payload.kind === 'repeated_back' ? 'Went back repeatedly' : 'Returned to a page visited moments before';
    case 'signal.error': {
      const { kind, status, message } = e.payload;
      return `${kind === 'http' ? `HTTP ${status ?? 'error'}` : kind === 'console' ? 'Console error' : 'Uncaught exception'}: ${message}`;
    }
    case 'signal.validation_error':
      return `Validation message: ${e.payload.message}`;
    case 'signal.small_target':
      return `Tapped a ${Math.round(e.payload.box[2])}×${Math.round(e.payload.box[3])} px target`;
  }
}

/**
 * Survey answers have no page, so they group by the part of the product they name (their words, in surveys before that);
 * the rest by (poi, page, element), else a console error or exception by (poi, page, its text), else (poi, page, kind).
 */
export function groupKey(c: Candidate): string {
  if (c.kind === 'survey' || c.kind === 'objection') {
    return JSON.stringify([c.poi_id, null, c.kind, c.element ? `where ${normaliseText(c.element)}` : normaliseText(c.text)]);
  }
  if (c.element) return JSON.stringify([c.poi_id, c.page, 'element', c.element.toLowerCase()]);
  // An HTTP error's path carries record ids, so it keeps grouping by kind; a console line or exception by its words.
  return c.kind === 'error' && !c.text.startsWith('HTTP ') ? JSON.stringify([c.poi_id, c.page, 'error', normaliseText(c.text)]) : JSON.stringify([c.poi_id, c.page, 'kind', c.kind]);
}

/** Step 3: deterministic groups, in the order of their first member. */
export function groupCandidates(candidates: Candidate[]): Group[] {
  const groups = new Map<string, Group>();
  for (const c of candidates) {
    const key = groupKey(c);
    const group = groups.get(key);
    if (group) group.members.push(c);
    else groups.set(key, { id: `g${groups.size + 1}`, poi_id: c.poi_id, page: c.page, element: c.element, kind: c.kind, members: [c] });
  }
  return [...groups.values()];
}

/** One survey like: who said it, where and what. */
export interface Like {
  poi_id: string;
  persona_id: string;
  seq: number;
  where: string | null;
  text: string;
}

export interface LikeGroup {
  id: string; // l1, l2, … in order of the first member's survey
  poi_id: string;
  where: string | null;
  members: Like[];
}

/** The latest survey `keep` accepts of each persona on each POI, in the order the pairs first answered. */
export function latestSurveys(events: GnomiEvent[], keep: (e: EventOf<'persona.survey'>) => boolean): EventOf<'persona.survey'>[] {
  const latest = new Map<string, EventOf<'persona.survey'>>();
  for (const e of events) if (e.type === 'persona.survey' && e.persona_id && keep(e)) latest.set(`${e.persona_id}\u0000${e.payload.poi_id}`, e);
  return [...latest.values()];
}

/** Every survey like, grouped like survey frictions: by the part of the product it names, else by its words. */
export function likeGroups(events: GnomiEvent[]): LikeGroup[] {
  const groups = new Map<string, LikeGroup>();
  for (const e of events) {
    if (e.type !== 'persona.survey') continue;
    const likes = e.payload.items ? e.payload.items.filter((i) => i.kind === 'like').map((i) => ({ where: i.where.trim() || null, text: i.what })) : e.payload.likes.map((text) => ({ where: null, text }));
    for (const { where, text } of likes) {
      if (!normaliseText(text)) continue;
      const key = JSON.stringify([e.payload.poi_id, where ? `where ${normaliseText(where)}` : normaliseText(text)]);
      const like: Like = { poi_id: e.payload.poi_id, persona_id: e.persona_id ?? '', seq: e.seq, where, text };
      const group = groups.get(key);
      if (group) group.members.push(like);
      else groups.set(key, { id: `l${groups.size + 1}`, poi_id: e.payload.poi_id, where, members: [like] });
    }
  }
  return [...groups.values()];
}
