import type { Action, ActionTarget, AttributeValue, EventOf, GnomiEvent, Perception, Persona, PersonaSchema, RunConfig, RunRow, Segment, SessionInfo } from '@gnomi/simulation/types.ts';
import { profileEntries } from '@gnomi/simulation/profile/schema.ts';
import { attributeKey } from '@gnomi/simulation/report/dimensions.ts';
import { placesOf } from '@gnomi/simulation/report/friction.ts';
import { placeName } from '@gnomi/simulation/poi/pois.ts';
import { emptyStatuses, foldStatus, statusOf } from '@gnomi/engine/graph/index.ts';
import type { PersonaStatus, PersonaStatuses } from '@gnomi/engine/graph/index.ts';

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
  page?: string; // the page a step's screenshot shows, as a reader names it
  source?: { type: GnomiEvent['type']; round: number | null; poi_id: string | null; step?: number };
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
  readonly: 'the field takes no typing, so it was clicked',
  not_a_field: 'not a field to type into',
  invalid_value: 'a value the field cannot hold',
  unreadable_date: 'a date the field could not read',
  not_a_select: 'not a list to choose from',
  option_not_found: 'no such option',
  not_visible: 'no longer shown',
  unsupported_file: 'no sample file of that kind',
};
/** A step error as a designer reads it; "covered by …" quotes the page, which the title keeps. */
const stepError = (error: string) => STEP_ERRORS[error] ?? (error.startsWith('covered by ') ? 'something is in the way' : error);

function describeAction(action: Action, target: ActionTarget | null): string {
  const element = target ? `${target.role} "${target.name}"` : action.ref ? `element ${action.ref}` : 'the page';
  switch (action.type) {
    case 'click':
      return `Clicked ${element}`;
    case 'hover':
      return `Hovered over ${element}`;
    case 'type':
      return `Typed "${action.text}" into ${element}`;
    case 'select':
      return `Chose "${action.text}" in ${element}`;
    case 'scroll':
      return `Scrolled ${action.text ?? 'down'}`;
    case 'press':
      return `Pressed ${action.text}${action.ref ? ` in ${element}` : ''}`;
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
    case 'comparison.episode_started':
      return { seq, label: 'Comparison', tone: 'notice', title: 'Started a shared comparison task', detail: `Tool position ${event.payload.order + 1} · ${event.payload.access_scope.replaceAll('_', ' ')}` };
    case 'comparison.episode_finished':
      return { seq, label: 'Task outcome', tone: event.payload.outcome === 'completed' ? 'good' : 'notice', title: event.payload.outcome.replaceAll('_', ' '), detail: event.payload.reason };
    case 'comparison.assessment':
      return { seq, label: 'Evidence assessment', tone: 'notice', title: event.payload.rejection ? 'Evidence could not support this assessment' : event.payload.assessment.replaceAll('_', ' '), detail: event.payload.rejection ?? event.payload.summary };
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
      const error = result.error && stepError(result.error);
      return {
        seq,
        label: `Step ${step_no}`,
        tone: 'plain',
        title: describeAction(action, target),
        badge: action.type === 'done' || action.type === 'abandon' ? undefined : result.ok ? { ok: true, text: 'ok' } : { ok: false, text: `error: ${error || 'failed'}` },
        quote: thought,
        screenshot: event.payload.screenshot,
        page: place(result.url_before),
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
      const title = `${parent_id ? `Replied to post ${parent_id}` : 'Posted in the feed'}${injected ? ' (added by your team)' : ''}`;
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
      if (error === 'invalid_output') return { seq, label: `Step ${step_no}`, tone: 'bad', title: 'The model gave no valid answer' };
      return { seq, label: `Step ${step_no}`, tone: 'bad', title: 'Got stuck', detail: `The same ${action} failed three times in a row (${error})` };
    }
    // Objective signals (tech.md §8.1): what the engine detected, as opposed to what the persona said.
    case 'signal.failed_action': {
      const { step_no, action, error } = event.payload;
      const title = error === 'no_effect' ? `Detected: the ${action} changed nothing` : `Detected: the ${action} failed (${stepError(error)})`;
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
    case 'signal.accessibility':
      return { seq, label: `Step ${event.payload.step_no}`, tone: 'notice', title: `Page scan: ${event.payload.help}`, detail: place(event.payload.url) };
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

/** The activity feed folded batch by batch, so a live run costs its new events rather than the whole log. */
export interface RowFold {
  rows: Row[]; // newest first, so the latest step is always in view
  hosts: Map<string, { at: number; count: number }>; // each blocked host's one row, by its place in time order, and its request count
  places: Map<string, string>;
}

export const emptyRows = (): RowFold => ({ rows: [], hosts: new Map(), places: new Map() });

/**
 * Adds the rows for a batch of later events, blocked requests as one updating row per host that keeps the place of the first.
 * Returns the batch's rows in time order and the earlier rows it replaced, whose host count grew.
 */
export function foldRows(fold: RowFold, events: GnomiEvent[]): { added: Row[]; replaced: Row[] } {
  const before = fold.rows.length;
  const added: Row[] = [];
  const recounted = new Set<string>();
  for (const event of events) {
    if (event.type === 'run.started') fold.places = placesOf([event]);
    if (event.type !== 'containment.blocked_request') {
      const row = describe(event, fold.places);
      if (row) added.push({ ...row, ts: event.ts, persona_id: event.persona_id, source: {
        type: event.type, round: event.round, poi_id: event.poi_id,
        ...('step_no' in event.payload ? { step: event.payload.step_no } : {}),
      } });
      continue;
    }
    const { host } = event.payload;
    const seen = fold.hosts.get(host);
    if (seen) seen.count += 1;
    else {
      fold.hosts.set(host, { at: before + added.length, count: 1 });
      added.push({ seq: event.seq, ts: event.ts, persona_id: null, label: 'Blocked', tone: 'notice', title: '' });
    }
    recounted.add(host);
  }
  if (!added.length && !recounted.size) return { added, replaced: [] };
  // A fresh array, so a paused feed's snapshot of the old one never changes underneath it.
  const rows = added.toReversed().concat(fold.rows); // concat copies a long array far faster than spreading it
  const replaced: Row[] = [];
  for (const host of recounted) {
    const { at, count } = fold.hosts.get(host)!;
    const row = { ...rows[rows.length - 1 - at], title: `Blocked requests to ${host} (${count})` };
    rows[rows.length - 1 - at] = row;
    if (at < before) replaced.push(row);
    else added[at - before] = row;
  }
  fold.rows = rows;
  return { added, replaced };
}

// A stored screenshot is what a vision persona saw, not the page as designed, and a screen-reader persona was never shown it.
const SHOT_LABEL: Record<Perception, string> = {
  deuteranopia: 'Simulated red–green colour blindness: the colours here are not the page’s own.',
  blurredVision: 'Simulated low vision: the blur here is not on the page.',
  screen_reader: 'Not shown to this persona, who got the page as text.',
};

/** The note under a step's screenshot, from one persona's events. Perception is per POI: a design's frame is as designed, whoever looks. */
export function shotLabels(events: GnomiEvent[]): (row: Row) => string | undefined {
  const perceptions = new Map<string | null | undefined, Perception>();
  for (const event of events) if (event.type === 'persona.episode_started' && event.payload.perception) perceptions.set(event.payload.poi_id, event.payload.perception);
  return (row) => {
    const perception = perceptions.get(row.source?.poi_id);
    return perception && SHOT_LABEL[perception];
  };
}

/** The activity feed, newest first. `places` names texts and designs when `events` has no run.started, as one persona's events do not. */
export function toRows(events: GnomiEvent[], places = new Map<string, string>()): Row[] {
  const fold = { ...emptyRows(), places };
  foldRows(fold, events);
  return fold.rows;
}

export const isEnd = (event: GnomiEvent) => event.type === 'run.finished' || event.type === 'run.stopped';

// The events that end a persona's episode: after one of these she is no longer waiting for anyone.
const ENDS_EPISODE = new Set(['persona.goal_done', 'persona.abandoned', 'signal.budget_exceeded', 'signal.repeated_failure']);

/**
 * Whether a run's page reads its repeat set again for an event of any run: a report of the set may have changed, such as a judge's
 * answers, with no run ending to say so. A run missing from the list has only just started, and the list catches up later.
 */
export function rereadsSet(event: GnomiEvent, group: string | undefined, runs: RunRow[]): boolean {
  if (!group || event.type !== 'report.generated') return false;
  const run = runs.find(({ run_id }) => run_id === event.run_id);
  return !run || run.config.repeat?.group === group;
}

/** What the run page reads from the whole log, folded batch by batch like the feed. */
export interface LogFold {
  config: RunConfig | undefined;
  comparison: boolean;
  ended: boolean;
  reporting: boolean;
  generatedSeq: number | undefined;
  social: boolean; // the run has social rounds
  posts: boolean;
  statuses: PersonaStatuses;
  progress: Map<string, { steps: number; feeling: number | null }>;
  blocks: Map<string, EventOf<'persona.blocked'>>; // each persona's latest block with no resume or ending after it
}

export const emptyLog = (): LogFold => ({
  config: undefined, comparison: false, ended: false, reporting: false, generatedSeq: undefined, social: false, posts: false,
  statuses: emptyStatuses(), progress: new Map(), blocks: new Map(),
});

/** Folds later events in place; the returned copy is new, so a memo on it sees the change. */
export function foldLog(log: LogFold, events: GnomiEvent[]): LogFold {
  for (const event of events) {
    foldStatus(log.statuses, event);
    if (event.type === 'run.started') {
      log.config ??= event.payload.config;
      log.comparison ||= !!event.payload.config.project.comparison;
    } else if (isEnd(event)) log.ended = true;
    else if (event.type === 'report.started') log.reporting = true;
    else if (event.type === 'report.generated') log.generatedSeq = event.seq;
    log.social ||= event.type === 'run.round_started' || event.type.startsWith('social.');
    log.posts ||= event.type === 'social.post';
    if (event.persona_id === null) continue;
    if (event.type === 'persona.step') log.progress.set(event.persona_id, { steps: Math.max(event.payload.step_no, log.progress.get(event.persona_id)?.steps ?? 0), feeling: event.payload.feeling });
    if (event.type === 'persona.blocked') log.blocks.set(event.persona_id, event);
    else if (event.type === 'persona.resumed' || ENDS_EPISODE.has(event.type)) log.blocks.delete(event.persona_id);
  }
  return { ...log };
}

/** The blocks the user still has to act on: none once the run has ended or is reporting, and none in a comparison, which never waits. */
export const waitingOf = (log: LogFold): EventOf<'persona.blocked'>[] => (log.ended || log.reporting || log.comparison ? [] : [...log.blocks.values()]);

/** The persona.blocked events the user still has to act on: per persona, no resume or ending after it, and the run has not ended. */
export const waitingBlocks = (events: GnomiEvent[]): EventOf<'persona.blocked'>[] => waitingOf(foldLog(emptyLog(), events));

export type PersonaState = PersonaStatus;

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

/** Each persona's status by the fold the swarm graph uses; `ended` also cuts short a run whose log has no end, such as an interrupted one. */
export const statesOf = (statuses: PersonaStatuses, personas: Persona[], ended = false) => new Map(personas.map((persona): [string, PersonaState] => {
  const state = statusOf(statuses, persona.id);
  return [persona.id, ended && (state === 'waiting' || state === 'active') ? 'unfinished' : state];
}));

/** Where each persona stands, from the log alone. Once the run has ended, those still working or queued were cut short. */
export function personaStates(events: GnomiEvent[], personas: Persona[], ended = false): Map<string, PersonaState> {
  const statuses = emptyStatuses();
  for (const event of events) foldStatus(statuses, event);
  return statesOf(statuses, personas, ended);
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
  'comparison.episode_started': 'steps',
  'comparison.episode_finished': 'outcomes',
  'comparison.assessment': 'opinions',
  'persona.step': 'steps',
  'persona.episode_started': 'steps',
  'persona.friction_reported': 'frictions',
  'signal.failed_action': 'signals',
  'signal.loop': 'signals',
  'signal.backtrack': 'signals',
  'signal.error': 'signals',
  'signal.validation_error': 'signals',
  'signal.small_target': 'signals',
  'signal.accessibility': 'signals',
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
export const personaProgress = (events: GnomiEvent[]): LogFold['progress'] => foldLog(emptyLog(), events).progress;

/** The events `after` adds to `before`, or null when it is not `before` with events appended: a late event was sorted in. */
export function appended(before: GnomiEvent[], after: GnomiEvent[]): GnomiEvent[] | null {
  // merge keeps every event it had, in seq order, so the old last event stays in its place only if nothing came before it.
  if (after.length < before.length || (before.length > 0 && after[before.length - 1] !== before.at(-1))) return null;
  return after.slice(before.length);
}
