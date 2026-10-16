import type { ActionTarget, EventOf, EventPayloads, GnomiEvent, SignalKind, StepEvidence, Trust } from '../types.ts';

// Steps 1–3 of the report pipeline (tech.md §8.2): candidates, trust and deterministic grouping. Pure folds over the log.

export const TRUST_WEIGHT: Record<Trust, number> = { confirmed: 1, observed: 0.7, reported: 0.5 };
/** A self-report and a signal this many steps apart or fewer, on the same page, are one friction (tech.md §8.1). */
export const MERGE_STEPS = 3;
export const SIGNAL_KINDS: SignalKind[] = ['failed_action', 'loop', 'backtrack', 'error', 'validation_error', 'small_target'];
/** Severity (1–4) of a signal nobody reported; a backtrack is often just a persona reading again. */
export const SIGNAL_SEVERITY: Record<SignalKind, number> = { failed_action: 2, loop: 2, backtrack: 1, error: 2, validation_error: 2, small_target: 2 };
const ABANDON_SEVERITY = 3; // the persona gave up
const SURVEY_SEVERITY = 2; // the survey asks for frictions, not their severity

export type CandidateKind = 'friction' | 'abandoned' | 'survey' | SignalKind;

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

/** host + path with ids replaced by :id; query and fragment dropped. A URL that does not parse is its own pattern. */
export function pagePattern(url: string): string {
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
      url: page,
      page: page === null ? null : pagePattern(page),
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
  const signals: Candidate[] = [];
  const surveys: Candidate[] = [];
  for (const e of events) {
    if (e.type === 'persona.friction_reported') {
      const at = atStep(e, e.payload.step_no, e.payload.where.url);
      // A text's confusions group by the passage they quote, as a page's frictions do by their element.
      const element = e.payload.passage?.text ? `passage "${e.payload.passage.text.replace(/\s+/g, ' ').slice(0, 120)}"` : at.element;
      reports.push({ ...at, ...stepEvidence(e.payload, at), element, severity: clampSeverity(e.payload.severity), text: e.payload.what });
    } else if (e.type === 'persona.abandoned') {
      reports.push({ ...atStep(e, e.payload.step_no, null), kind: 'abandoned', severity: ABANDON_SEVERITY, text: e.payload.reason });
    } else if (e.type === 'persona.survey') {
      for (const text of e.payload.frictions) {
        surveys.push({
          poi_id: e.payload.poi_id, persona_id: e.persona_id ?? '', step_no: null, step_seq: null, url: null, page: null, element: null,
          kind: 'survey', severity: SURVEY_SEVERITY, trust: 'reported', text, quote: e.payload.reason, screenshot: null, seqs: [e.seq], signals: [],
        });
      }
    } else if (isSignal(e)) {
      const kind = e.type.slice(7) as SignalKind;
      signals.push({ ...atStep(e, e.payload.step_no, e.payload.url), kind, severity: SIGNAL_SEVERITY[kind], trust: 'observed', text: signalText(e), signals: [kind] });
    }
  }

  // Each signal joins the nearest self-report of the same persona on the same page within MERGE_STEPS; ties go to the earlier one.
  const unmatched: Candidate[] = [];
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

/** Survey answers have no page, so they group by their words; the rest by (poi, page, element), else (poi, page, kind). */
export function groupKey(c: Candidate): string {
  if (c.kind === 'survey') return JSON.stringify([c.poi_id, null, 'survey', normaliseText(c.text)]);
  return c.element ? JSON.stringify([c.poi_id, c.page, 'element', c.element.toLowerCase()]) : JSON.stringify([c.poi_id, c.page, 'kind', c.kind]);
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
