import type { Action, ActionTarget, AttributeValue, EventOf, GnomiEvent, Persona, PersonaSchema, RunConfig, Segment, SessionInfo } from '@gnomi/engine/types.ts';
import { profileEntries } from '@gnomi/engine/profile/schema.ts';
import { attributeKey } from '@gnomi/engine/report/dimensions.ts';
import { placesOf } from '@gnomi/engine/report/friction.ts';
import { placeName } from '@gnomi/engine/poi/pois.ts';

// The activity list: how a run's events read to a designer. Pure, so it can be tested without a window.

export type Tone = 'plain' | 'friction' | 'good' | 'bad' | 'alarm' | 'notice' | 'muted';

export const TONE_CLASSES: Record<Tone, string> = {
  plain: 'border-stone-200 bg-white',
  friction: 'border-amber-300 bg-amber-50',
  good: 'border-green-200 bg-green-50',
  bad: 'border-red-200 bg-red-50',
  alarm: 'border-2 border-red-500 bg-red-100',
  notice: 'border-sky-200 bg-sky-50',
  muted: 'border-transparent bg-transparent text-stone-500',
};

export interface Row {
  seq: number;
  ts?: number;
  persona_id: string | null; // whose row it is; null for the run as a whole and for requests blocked across personas
  label: string;
  tone: Tone;
  title: string;
  headline?: string; // plain-language summary; the full recorded values stay in title
  badge?: { ok: boolean; text: string };
  detail?: string;
  quote?: string;
  screenshot?: string | null; // a step's evidence, a blob path
  source?: { type: GnomiEvent['type']; round: number | null; poi_id: string | null; step?: number };
}

/** Quotes lead ordinary activity; a failed action or safety event always keeps its outcome visible. */
export function timelineSummary(row: Row): string {
  const quote = row.quote?.replace(/\s+/g, ' ').trim();
  return quote && (row.tone === 'plain' || row.tone === 'notice') && row.badge?.ok !== false ? `“${quote}”` : row.title;
}

/** Keep thoughts, actions and problems prominent; routine feed reads and reactions remain in All events. */
export const isTimelineHighlight = (row: Row): boolean => row.tone !== 'muted' || !!row.quote || row.badge?.ok === false;

const STEP_ERRORS: Record<string, string> = {
  ref_not_found: 'element not found',
  not_editable: 'field cannot be typed into',
  password_field: 'password fields are off limits',
  host_not_allowed: 'outside the allowed site',
  timeout: 'timed out',
  invalid_output: 'the model gave an unusable answer',
};

function describeAction(action: Action, target: ActionTarget | null): string {
  const element = target ? `${target.role} "${target.name}"` : action.ref ? `element ${action.ref}` : 'the page';
  switch (action.type) {
    case 'click':
      return `Clicked ${element}`;
    case 'type':
      return `Typed "${action.text}" into ${element}`;
    case 'select':
      return `Chose "${action.text}" in ${element}`;
    case 'scroll':
      return `Scrolled ${action.text ?? 'down'}`;
    case 'back':
      return 'Went back';
    case 'navigate':
      return `Opened ${action.text}`;
    case 'read':
      return `Read ${element}`;
    case 'wait':
      return 'Waited';
    case 'done':
      return 'Decided the goal is done';
    case 'abandon':
      return 'Decided to give up';
  }
}

const STOP_REASONS = {
  user: 'You stopped the run',
  cost_budget: 'The run stopped for its cost budget',
  wall_clock: 'The run reached its time limit',
  tripwire: 'The run was halted by a safety check',
  error: 'The run stopped because of an error',
};

/** The report's stop reason ("user", "tripwire: ...") as a sentence. */
export function stopText(reason: string): string {
  const [kind, ...detail] = reason.split(': ');
  const known = STOP_REASONS[kind as keyof typeof STOP_REASONS];
  return known ? [known, ...detail].join(': ') : reason;
}

/** How the reset hook call went, for the activity list and the report's methods. */
export function resetOutcome({ status, error }: { status: number | null; error: string | null }): { ok: boolean; text: string } {
  if (error !== null) return { ok: false, text: `failed: ${error}` };
  if (status !== null && (status < 200 || status >= 300)) return { ok: false, text: `answered HTTP ${status}` };
  return { ok: true, text: status === null ? 'called' : `called, HTTP ${status}` };
}

/** One line of the activity list, or null for events that are bookkeeping. */
function describe(event: GnomiEvent, places: Map<string, string> = new Map()): Omit<Row, 'persona_id'> | null {
  const { seq } = event;
  const place = (url: string) => placeName(url, places); // a text or design by its name, never its stored file
  switch (event.type) {
    case 'run.concurrency_changed':
      return { seq, label: 'Pace', tone: 'notice', title: `Now running ${event.payload.concurrency} personas at a time`, detail: event.payload.reason };
    case 'run.reset_called': {
      const reset = resetOutcome(event.payload);
      return { seq, label: 'Reset', tone: reset.ok ? 'muted' : 'bad', title: `Reset hook ${reset.text}`, detail: event.payload.url };
    }
    case 'persona.episode_started': {
      const { start_url, device } = event.payload;
      if (!start_url.startsWith('asset:')) return { seq, label: 'Start', tone: 'muted', title: `Opened ${start_url} in a ${device} browser` };
      return { seq, label: 'Start', tone: 'muted', title: `${/\.(md|txt)$/i.test(start_url) ? 'Started reading' : 'Started looking through'} ${place(start_url)}` };
    }
    case 'persona.step': {
      const { step_no, action, target, result, thought } = event.payload;
      const error = result.error && (STEP_ERRORS[result.error] ?? result.error);
      return {
        seq,
        label: `Step ${step_no}`,
        tone: 'plain',
        title: describeAction(action, target),
        badge: action.type === 'done' || action.type === 'abandon' ? undefined : result.ok ? { ok: true, text: 'ok' } : { ok: false, text: `error: ${error || 'failed'}` },
        quote: thought,
        screenshot: event.payload.screenshot,
      };
    }
    case 'persona.friction_reported': {
      const { step_no, severity, what, expected } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'friction', title: `Friction, severity ${severity} of 4: ${what}`, headline: what, detail: `Expected: ${expected}` };
    }
    case 'persona.opinion_changed': {
      const { sentiment, confidence, likes, frictions } = event.payload.after;
      const posts = event.payload.cause.post_ids;
      return {
        seq, label: 'Opinion', tone: 'notice',
        headline: sentiment > 0 ? 'Has a positive impression' : sentiment < 0 ? 'Has a negative impression' : 'Has a neutral impression',
        title: `Sentiment ${sentiment > 0 ? '+' : ''}${sentiment}; self-reported confidence ${Math.round(confidence * 100)}%${posts.length ? `, after reading ${posts.length === 1 ? 'a post' : `${posts.length} posts`}` : ''}`,
        detail: `Likes: ${likes.join('; ') || 'none reported'}. Frictions: ${frictions.join('; ') || 'none reported'}.${posts.length ? ` Cited posts: ${posts.join(', ')}.` : ''}`,
      };
    }
    case 'run.round_started':
      return { seq, label: `Round ${event.round}`, tone: 'muted', title: `Round ${event.round} started` };
    case 'run.round_ended':
      return { seq, label: `Round ${event.round}`, tone: 'muted', title: `Round ${event.round} ended` };
    case 'social.feed_viewed': {
      const n = event.payload.post_ids.length;
      return { seq, label: 'Feed', tone: 'muted', title: n ? `Read ${n === 1 ? 'one new post' : `${n} new posts`} in the feed` : 'Found nothing new in the feed' };
    }
    case 'social.post': {
      const { post_id, parent_id, text, injected } = event.payload;
      const title = `${parent_id ? `Replied to post ${parent_id}` : 'Posted in the feed'}${injected ? ' (put there by the test harness)' : ''}`;
      return { seq, label: parent_id ? 'Reply' : 'Post', tone: 'plain', title, detail: `Post ${post_id}`, quote: text };
    }
    case 'social.reaction':
      return { seq, label: 'Reaction', tone: 'muted', title: `${event.payload.kind === 'agree' ? 'Agreed' : 'Disagreed'} with post ${event.payload.post_id}` };
    case 'persona.survey': {
      const { sentiment, confidence, likes, frictions, would_continue, reason } = event.payload;
      return {
        seq, label: 'Survey', tone: 'notice',
        headline: would_continue ? 'Would keep using it' : 'Would not keep using it',
        title: `${would_continue ? 'Would' : 'Would not'} keep using it; sentiment ${sentiment > 0 ? '+' : ''}${sentiment}, self-reported confidence ${Math.round(confidence * 100)}%`,
        detail: `Frictions: ${frictions.join('; ') || 'none reported'}. Likes: ${likes.join('; ') || 'none reported'}.`,
        quote: reason,
      };
    }
    case 'persona.blocked': {
      const { step_no, reason, detail } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'bad', title: reason === 'captcha' ? 'Blocked by a CAPTCHA, waiting for you' : 'Login expired, waiting for you', detail };
    }
    case 'persona.resumed':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'good', title: 'Resumed' };
    case 'persona.goal_done':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'good', title: 'Goal reached', detail: event.payload.summary };
    case 'persona.abandoned':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'bad', title: 'Gave up', detail: event.payload.reason };
    case 'containment.tripwire': {
      const { kind, detail } = event.payload;
      const title = kind === 'live_payment_key' ? 'A live payment key is on the page, so the run was halted' : 'The run reached a production host, so it was halted';
      return { seq, label: 'Safety stop', tone: 'alarm', title, detail };
    }
    case 'signal.budget_exceeded':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'bad', title: `Used all ${event.payload.budget} steps` };
    case 'signal.repeated_failure': {
      const { step_no, action, error } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'bad', title: 'Got stuck', detail: `The same ${action} failed three times in a row (${error})` };
    }
    // Objective signals (tech.md §8.1): what the engine detected, as opposed to what the persona said.
    case 'signal.failed_action': {
      const { step_no, action, error } = event.payload;
      const title = error === 'no_effect' ? `Detected: the ${action} changed nothing` : `Detected: the ${action} failed (${STEP_ERRORS[error] ?? error})`;
      return { seq, label: `Step ${step_no}`, tone: 'notice', title, detail: place(event.payload.url) };
    }
    case 'signal.loop':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'notice', title: `Detected: the same page ${event.payload.visits} times in a few steps`, detail: place(event.payload.url) };
    case 'signal.backtrack': {
      const { step_no, kind, url } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'notice', title: kind === 'repeated_back' ? 'Detected: went back again and again' : 'Detected: returned to a page from moments ago', detail: place(url) };
    }
    case 'signal.error': {
      const { step_no, kind, status, message } = event.payload;
      const title = kind === 'http' ? `Detected: the site answered HTTP ${status}` : kind === 'exception' ? 'Detected: the page threw an error' : 'Detected: the page logged an error';
      return { seq, label: `Step ${step_no}`, tone: 'notice', title, detail: message };
    }
    case 'signal.validation_error':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'notice', title: 'Detected: an error message appeared after submitting', detail: event.payload.message };
    case 'signal.small_target': {
      const [, , width, height] = event.payload.box;
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'notice', title: `Detected: tapped a small target, ${Math.round(width)}×${Math.round(height)} px`, detail: place(event.payload.url) };
    }
    case 'llm.call':
      return event.payload.status === 'ok'
        ? null
        : { seq, label: 'Model', tone: 'bad', title: 'A model call failed', detail: event.payload.error ?? event.payload.status };
    case 'run.stopped':
      return { seq, label: 'Stopped', tone: event.payload.reason === 'tripwire' ? 'alarm' : 'muted', title: STOP_REASONS[event.payload.reason], detail: event.payload.detail ?? undefined };
    case 'run.finished':
      return { seq, label: 'Done', tone: 'muted', title: 'Run finished' };
    default:
      return null;
  }
}

/** The activity list in time order, blocked requests as one updating row per host that keeps the place of the first. */
export function chronologicalRows(events: GnomiEvent[]): Row[] {
  const blocked = new Map<string, number>();
  for (const event of events) if (event.type === 'containment.blocked_request') blocked.set(event.payload.host, (blocked.get(event.payload.host) ?? 0) + 1);
  const shown = new Set<string>();
  const places = placesOf(events);
  return events.flatMap((event): Row[] => {
    if (event.type !== 'containment.blocked_request') {
      const row = describe(event, places);
      return row ? [{ ...row, ts: event.ts, persona_id: event.persona_id, source: {
        type: event.type, round: event.round, poi_id: event.poi_id,
        ...('step_no' in event.payload ? { step: event.payload.step_no } : {}),
      } }] : [];
    }
    const { host } = event.payload;
    if (shown.has(host)) return [];
    shown.add(host);
    return [{ seq: event.seq, ts: event.ts, persona_id: null, label: 'Blocked', tone: 'notice', title: `Blocked requests to ${host} (${blocked.get(host)})` }];
  });
}

/** The activity feed: the same rows, newest first so the latest step is always in view. */
export const toRows = (events: GnomiEvent[]): Row[] => chronologicalRows(events).reverse();

export const isEnd = (event: GnomiEvent) => event.type === 'run.finished' || event.type === 'run.stopped';

// The events that end a persona's episode: after one of these she is no longer waiting for anyone.
const ENDS_EPISODE = new Set(['persona.goal_done', 'persona.abandoned', 'signal.budget_exceeded', 'signal.repeated_failure']);

/** The persona.blocked events the user still has to act on: per persona, no resume or ending after it, and the run has not ended. */
export function waitingBlocks(events: GnomiEvent[]): EventOf<'persona.blocked'>[] {
  if (events.some(isEnd)) return [];
  const waiting = new Map<string, EventOf<'persona.blocked'>>();
  for (const event of events) {
    if (event.persona_id === null) continue;
    if (event.type === 'persona.blocked') waiting.set(event.persona_id, event);
    else if (event.type === 'persona.resumed' || ENDS_EPISODE.has(event.type)) waiting.delete(event.persona_id);
  }
  return [...waiting.values()];
}

export type PersonaState = 'waiting' | 'active' | 'blocked' | 'done' | 'abandoned' | 'unfinished';

export const STATE_WORDS: Record<PersonaState, string> = {
  waiting: 'Waiting to start',
  active: 'Working',
  blocked: 'Waiting for you',
  done: 'Done',
  abandoned: 'Gave up',
  unfinished: 'Stopped early',
};

/** A persona's state in words; once the run is over, one still waiting for the user is simply blocked. */
export const stateWord = (state: PersonaState, ended: boolean) => (ended && state === 'blocked' ? 'Blocked' : STATE_WORDS[state]);

/** Where each persona stands, from the log alone. Once the run has ended, those still working or queued were cut short. */
export function personaStates(events: GnomiEvent[], personas: Persona[]): Map<string, PersonaState> {
  const states = new Map<string, PersonaState>(personas.map((persona) => [persona.id, 'waiting']));
  for (const event of events) {
    if (event.persona_id === null || !states.has(event.persona_id)) continue;
    if (event.type === 'persona.episode_started' || event.type === 'persona.step' || event.type === 'persona.resumed') states.set(event.persona_id, 'active');
    else if (event.type === 'persona.blocked') states.set(event.persona_id, 'blocked');
    else if (event.type === 'persona.goal_done') states.set(event.persona_id, 'done');
    else if (ENDS_EPISODE.has(event.type)) states.set(event.persona_id, 'abandoned');
  }
  if (events.some(isEnd)) for (const [id, state] of states) if (state === 'waiting' || state === 'active') states.set(id, 'unfinished');
  return states;
}

export function countStates(states: Map<string, PersonaState>): Record<PersonaState, number> {
  const counts: Record<PersonaState, number> = { waiting: 0, active: 0, blocked: 0, done: 0, abandoned: 0, unfinished: 0 };
  for (const state of states.values()) counts[state] += 1;
  return counts;
}

/** Once everyone ends, the scheduler skips remaining social phases and collects final feedback. */
export function isPreparingReport(events: GnomiEvent[], states: Map<string, PersonaState>): boolean {
  return !events.some(isEnd) && states.size > 0 && [...states.values()].every((state) => state === 'done' || state === 'abandoned');
}

export interface ReportStatus {
  stage: 'surveys' | 'themes' | 'suggestions';
  surveys: { done: number; total: number }; // one per persona and POI it started
  pois: { total: number; themed: number; suggested: number }; // the POIs the judge and author run for
  fraction: number; // 0–1, weighted by how long each stage takes: surveys .2, themes .5, suggestions .3
}

/** Where the report stands after the last episode, from the log alone, so a reopened run shows it too. */
export function reportProgress(events: GnomiEvent[]): ReportStatus {
  const episodes = new Set<string>();
  const surveyed = new Set<string>();
  const themed = new Set<string>();
  const suggested = new Set<string>();
  let started: string[] | null = null;
  for (const event of events) {
    if (event.type === 'persona.episode_started') episodes.add(`${event.persona_id} ${event.payload.poi_id}`);
    else if (event.type === 'persona.survey') surveyed.add(`${event.persona_id} ${event.payload.poi_id}`);
    else if (event.type === 'report.started') started = event.payload.pois;
    else if (event.type === 'report.themes') themed.add(event.payload.poi_id);
    // The author runs after the judge, so its answer also closes a judge that failed and logged no themes.
    else if (event.type === 'report.suggestions') { themed.add(event.payload.poi_id); suggested.add(event.payload.poi_id); }
  }
  const total = episodes.size;
  if (!started) {
    const done = Math.min(surveyed.size, total);
    return { stage: 'surveys', surveys: { done, total }, pois: { total: 0, themed: 0, suggested: 0 }, fraction: total ? 0.2 * done / total : 0 };
  }
  const pois = { total: started.length, themed: started.filter((id) => themed.has(id)).length, suggested: started.filter((id) => suggested.has(id)).length };
  return {
    stage: pois.themed < pois.total ? 'themes' : 'suggestions',
    surveys: { done: total, total },
    pois,
    fraction: pois.total ? 0.2 + 0.5 * pois.themed / pois.total + 0.3 * pois.suggested / pois.total : 0.95, // no frictions: only saving is left
  };
}

export type Category = 'steps' | 'frictions' | 'signals' | 'opinions' | 'social' | 'outcomes' | 'blocks' | 'containment' | 'run';

export const CATEGORIES: Record<Category, string> = {
  steps: 'Steps',
  frictions: 'Frictions',
  signals: 'Detected signals',
  opinions: 'Opinions',
  social: 'Feed, posts and reactions',
  outcomes: 'Finishes and give-ups',
  blocks: 'Blocked and resumed',
  containment: 'Blocked requests and safety stops',
  run: 'The run itself',
};

const CATEGORY_OF: Partial<Record<GnomiEvent['type'], Category>> = {
  'persona.step': 'steps',
  'persona.episode_started': 'steps',
  'persona.friction_reported': 'frictions',
  'signal.failed_action': 'signals',
  'signal.loop': 'signals',
  'signal.backtrack': 'signals',
  'signal.error': 'signals',
  'signal.validation_error': 'signals',
  'signal.small_target': 'signals',
  'persona.opinion_changed': 'opinions',
  'persona.survey': 'opinions',
  'social.feed_viewed': 'social',
  'social.post': 'social',
  'social.reaction': 'social',
  'persona.goal_done': 'outcomes',
  'persona.abandoned': 'outcomes',
  'signal.budget_exceeded': 'outcomes',
  'signal.repeated_failure': 'outcomes',
  'persona.blocked': 'blocks',
  'persona.resumed': 'blocks',
  'containment.blocked_request': 'containment',
  'containment.tripwire': 'containment',
  'run.reset_called': 'run',
  'run.concurrency_changed': 'run',
  'run.round_started': 'run',
  'run.round_ended': 'run',
  'run.stopped': 'run',
  'run.finished': 'run',
  'llm.call': 'run',
};

export interface ProfileFilter {
  dimension?: string;
  value?: string; // typed JSON key, or '' for every value
}

export interface Filters extends ProfileFilter {
  persona: string; // a persona id, or '' for everyone
  segment: string; // a segment id, or ''
  category: Category | ''; // '' for every kind of event
}

export function matchesProfileValues(attributes: Record<string, AttributeValue> | undefined, filter: ProfileFilter): boolean {
  if (!filter.dimension || !filter.value) return true;
  const value = attributes?.[filter.dimension];
  return value !== undefined && attributeKey(value) === filter.value;
}

/** Shared by the activity feed and the inspector roster; only enabled report dimensions are filterable. */
export function filterPersonas(personas: Persona[], filters: ProfileFilter & { persona?: string; segment?: string }, schema?: PersonaSchema): Persona[] {
  return personas.filter((persona) => {
    if (filters.persona && filters.persona !== persona.id) return false;
    if (filters.segment && filters.segment !== persona.segment_id) return false;
    if (!filters.dimension || !filters.value) return true;
    const attributes = Object.fromEntries(profileEntries(persona, schema, 'report').map(({ attribute, value }) => [attribute.id, value]));
    return matchesProfileValues(attributes, filters);
  });
}

/** The events a filter lets through; run-level events have no persona, so a persona or segment filter hides them. */
export function filterEvents(events: GnomiEvent[], filters: Filters, personas: Map<string, Persona>, schema?: PersonaSchema): GnomiEvent[] {
  const byProfile = !!filters.dimension && !!filters.value;
  if (!filters.persona && !filters.segment && !filters.category && !byProfile) return events;
  const allowed = new Set(filterPersonas([...personas.values()], filters, schema).map((persona) => persona.id));
  return events.filter((event) => {
    if (filters.category && CATEGORY_OF[event.type] !== filters.category) return false;
    if (!filters.persona && !filters.segment && !byProfile) return true;
    if (event.persona_id === null) return false;
    return allowed.has(event.persona_id);
  });
}

/** Events arrive both live and from get_events, so adding the same one twice must change nothing. */
export function merge(have: GnomiEvent[], incoming: GnomiEvent[]): GnomiEvent[] {
  const last = have.at(-1)?.seq ?? 0;
  if (incoming.every((event, i) => event.seq > last && (i === 0 || event.seq > incoming[i - 1].seq))) return incoming.length ? [...have, ...incoming] : have; // the usual case: the next events, in order
  const seen = new Set(have.map((event) => event.seq));
  const fresh = incoming.filter((event) => !seen.has(event.seq));
  return fresh.length ? [...have, ...fresh].sort((a, b) => a.seq - b.seq) : have;
}

export interface RunSetup {
  personas: Persona[];
  segments: Segment[];
  costBudget: number | null;
  concurrency: number | null;
  pauseMs: number | null;
  schema?: PersonaSchema;
  /** The login a persona uses: her segment's, or the project's for the built-in persona. */
  roleOf(persona: Persona | undefined): string | null;
}

/** What a run was set up with. Runs logged before M2 hold `persona`, `session` and `cost_budget_usd` where newer ones hold the population. */
export function runSetup(config: RunConfig | undefined): RunSetup {
  const old = (config ?? {}) as unknown as { persona?: Persona; session?: SessionInfo | null; cost_budget_usd?: number };
  const segments = config?.project.audience?.segments ?? [];
  return {
    personas: config?.personas ?? (old.persona ? [old.persona] : []),
    segments,
    costBudget: config?.project.settings?.cost_budget_usd ?? old.cost_budget_usd ?? null,
    concurrency: config?.project.settings?.concurrency ?? null,
    pauseMs: config?.pause_timeout_ms ?? null,
    schema: config?.project.persona_schema,
    roleOf(persona) {
      const segment = segments.find((candidate) => candidate.id === persona?.segment_id);
      return segment ? segment.role : (old.session?.role ?? config?.project.role ?? null);
    },
  };
}

export const FEELINGS: Record<number, string> = { [-2]: 'very frustrated', [-1]: 'annoyed', 0: 'neutral', 1: 'pleased', 2: 'delighted' };

/** Steps taken and the latest feeling per persona, from the log. */
export function personaProgress(events: GnomiEvent[]): Map<string, { steps: number; feeling: number | null }> {
  const progress = new Map<string, { steps: number; feeling: number | null }>();
  for (const event of events) {
    if (event.type !== 'persona.step' || event.persona_id === null) continue;
    progress.set(event.persona_id, { steps: Math.max(event.payload.step_no, progress.get(event.persona_id)?.steps ?? 0), feeling: event.payload.feeling });
  }
  return progress;
}
