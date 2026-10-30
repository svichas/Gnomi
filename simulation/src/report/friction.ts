import { assetPlaces, placeName, runPois } from '../poi/pois.ts';
import { possibleInterference } from '../signals/index.ts';
import type { AccessibilityViolation, ActionTarget, EventOf, EventPayloads, GnomiEvent, ReportBox, SignalKind, StepEvidence, Trust, Viewport } from '../types.ts';

// Steps 1–3 of the report pipeline (tech.md §8.2): candidates, trust and deterministic grouping. Pure folds over the log.

export const TRUST_WEIGHT: Record<Trust, number> = { confirmed: 1, observed: 0.7, reported: 0.5 };
/** A self-report and a signal this many steps apart or fewer, on the same page, are one friction (tech.md §8.1). */
export const MERGE_STEPS = 3;
export const SIGNAL_KINDS: SignalKind[] = ['failed_action', 'loop', 'backtrack', 'error', 'validation_error', 'small_target', 'accessibility'];
/** Severity (1–4) of a signal nobody reported; a backtrack is often just a persona reading again. */
export const SIGNAL_SEVERITY: Record<SignalKind, number> = { failed_action: 2, loop: 2, backtrack: 1, error: 2, validation_error: 2, small_target: 2, accessibility: 2 };
// Only a product failure corroborates a self-report: a loop, backtrack or small target is often the persona, a console line the page's noise.
const CORROBORATES = new Set<SignalKind>(['failed_action', 'validation_error', 'error', 'accessibility']);
// What a complaint must say to back a scan's finding, by axe's category: a scan's step is only where a persona happened to be, so
// near in steps means nothing, and on any page with a violation an unrelated complaint would read as confirmed. Any other category backs nothing.
const UNNAMED = /unlabel|\b(?:no|without)(?: \w+)? (?:label|name|text)\b|accessible name|alt text|\bicons?\b|screen reader/i;
const SCAN_WORDS: Record<string, RegExp> = {
  color: /contrast|faint|pale|washed|light gr[ae]y|hard to (?:read|see)|barely (?:read|see|visible)|legib/i,
  aria: UNNAMED,
  forms: UNNAMED,
  'name-role-value': UNNAMED,
  'text-alternatives': UNNAMED,
  keyboard: /keyboard|\btab(?:bing)?\b|focus/i,
};
// Often the persona rather than the product, so alone they start no theme (tech.md §8.1); the log keeps them.
const WEAK = new Set<CandidateKind>(['small_target', 'backtrack']);
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
  box?: ReportBox; // what it is about on that screenshot
  seqs: number[]; // the self-report first, then its signals
  signals: SignalKind[];
  scan?: AccessibilityViolation; // what the page scan found, alone or backing a complaint
  interference?: true; // one of its signals is possibly another persona's doing
};

export interface Group {
  id: string; // g1, g2, … in order of the first member's event
  poi_id: string;
  page: string | null;
  element: string | null;
  kind: CandidateKind;
  members: Candidate[];
}

/** Only weak signals: no self-report, survey answer or other signal. Judged by every member, since a group's kind is its first member's. */
export const isWeak = (group: Group) => group.members.every((m) => WEAK.has(m.kind));

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

/** The part of `target` a screenshot spanning `viewport` shows, if any. A frame's boxes start at its own corner, not the page's, so an element in one gets none. */
function boxOn(target: ActionTarget | null | undefined, ref: string | null, viewport: Viewport | undefined): ReportBox | undefined {
  if (!target?.box || !viewport || ref?.startsWith('f')) return undefined;
  const [x, y, width, height] = target.box;
  const [left, top, wide, tall] = viewport;
  const [from, to] = [Math.max(x, left), Math.min(x + width, left + wide)];
  const [above, below] = [Math.max(y, top), Math.min(y + height, top + tall)];
  if (to <= from || below <= above) return undefined;
  return { left: ((from - left) / wide) * 100, top: ((above - top) / tall) * 100, width: ((to - from) / wide) * 100, height: ((below - above) / tall) * 100, element: elementOf(target) ?? target.role };
}

/** The box for event `e` on its step's own screenshot: the element a friction names, else the target of an action that failed. On any other evidence it could mark the wrong element. */
function markOf(e: GnomiEvent, step: EventPayloads['persona.step']): ReportBox | undefined {
  const failed = e.type === 'signal.failed_action' || (e.type === 'persona.friction_reported' && !e.payload.about && e.payload.where.ref === step.action.ref && !step.result.ok);
  if (failed) return boxOn(step.target, step.action.ref, step.viewport);
  return e.type === 'persona.friction_reported' ? boxOn(e.payload.about, e.payload.where.ref, step.viewport) : undefined;
}

/** A candidate for event `e` at its persona's step `step_no`: the step's page, element, thought and screenshot, with defaults. */
export function stepReader(events: GnomiEvent[], defaultPoi: string): (e: GnomiEvent, step_no: number, url: string | null) => Candidate {
  const places = placesOf(events);
  const steps = new Map<string, { seq: number; poi_id: string | null; payload: EventPayloads['persona.step'] }>();
  for (const e of events) if (e.type === 'persona.step') steps.set(stepKey(e.persona_id ?? '', e.payload.step_no), { seq: e.seq, poi_id: e.poi_id, payload: e.payload });

  return (e, step_no, url) => {
    const persona_id = e.persona_id ?? '';
    const step = steps.get(stepKey(persona_id, step_no));
    const page = url ?? step?.payload.result.url_before ?? null;
    // A step's screenshot is taken before its action: a signal seen after it (on the page it led to, or a message it made
    // appear) is in the next step's screenshot, when that step is on the same POI.
    const after = isSignal(e) && (e.type === 'signal.validation_error' || url !== step?.payload.result.url_before);
    const next = after ? steps.get(stepKey(persona_id, step_no + 1)) : undefined;
    const shot = after ? (next?.poi_id === e.poi_id ? next?.payload.screenshot : null) : step?.payload.screenshot;
    const box = step && !after ? markOf(e, step.payload) : undefined;
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
      screenshot: shot ?? null,
      ...(box && { box }),
      seqs: [e.seq],
      signals: [],
      ...stepEvidence(step?.payload),
    };
  };
}

/** Step 1 and 2: every self-report, survey friction and signal as a candidate, merged into confirmed frictions where they meet. */
export function buildCandidates(events: GnomiEvent[], defaultPoi: string): Candidate[] {
  const atStep = stepReader(events, defaultPoi);
  const interfered = possibleInterference(events);
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
      const signal: Candidate = { ...atStep(e, e.payload.step_no, e.payload.url), kind, severity: SIGNAL_SEVERITY[kind], trust: 'observed', text: signalText(e), signals: [kind], ...(interfered.has(e.seq) && { interference: true as const }) };
      // A console line or exception is about the page, not the element clicked, so it groups by its text (groupKey).
      if (pageNoise) signal.element = null;
      // A scan is about the page: the element and thought of the step it sits on are that persona's own business.
      if (e.type === 'signal.accessibility') {
        const { step_no: _, url: __, ref: ___, ...scan } = e.payload;
        Object.assign(signal, { element: null, quote: '', scan });
      }
      (CORROBORATES.has(kind) && !pageNoise ? signals : unmatched).push(signal);
    }
  }

  // Each corroborating signal joins the nearest self-report of the same persona on the same page within MERGE_STEPS; ties go to the
  // earlier one. A scan joins a complaint on its page that says the same thing, whoever made it.
  for (const signal of signals) {
    const distance = (r: Candidate) => Math.abs((r.step_no ?? Infinity) - (signal.step_no ?? Infinity));
    const fits = (r: Candidate) => (signal.scan ? SCAN_WORDS[signal.scan.category]?.test(r.text) : r.persona_id === signal.persona_id && distance(r) <= MERGE_STEPS);
    const near = reports.filter((r) => r.poi_id === signal.poi_id && r.page === signal.page && fits(r));
    const best = near.sort((a, b) => distance(a) - distance(b) || a.seqs[0] - b.seqs[0])[0];
    if (!best) {
      unmatched.push(signal);
      continue;
    }
    best.trust = 'confirmed';
    best.seqs.push(...signal.seqs);
    if (!best.signals.includes(signal.kind as SignalKind)) best.signals.push(signal.kind as SignalKind);
    best.element ??= signal.element;
    best.scan ??= signal.scan;
    if (signal.interference) best.interference = true;
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
    case 'signal.accessibility': // axe's own wording, so nothing here is page text for a model to read
      return `Accessibility scan: ${e.payload.help} (${e.payload.rule}, ${e.payload.impact}, ${e.payload.elements} element${e.payload.elements === 1 ? '' : 's'})`;
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
  if (c.kind === 'accessibility') return JSON.stringify([c.poi_id, c.page, 'accessibility', c.scan?.rule]);
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
