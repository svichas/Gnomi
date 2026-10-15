import type { Action, ActionTarget, EventOf, GnomiEvent } from '@gnomi/engine/types.ts';

// The activity list: how a run's events read to a designer. Pure, so it can be tested without a window.

export type Tone = 'plain' | 'friction' | 'good' | 'bad' | 'alarm' | 'notice' | 'muted';

export interface Row {
  seq: number;
  label: string;
  tone: Tone;
  title: string;
  badge?: { ok: boolean; text: string };
  detail?: string;
  quote?: string;
}

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
  cost_budget: 'The run reached its cost limit',
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
function describe(event: GnomiEvent): Row | null {
  const { seq } = event;
  switch (event.type) {
    case 'run.reset_called': {
      const reset = resetOutcome(event.payload);
      return { seq, label: 'Reset', tone: reset.ok ? 'muted' : 'bad', title: `Reset hook ${reset.text}`, detail: event.payload.url };
    }
    case 'persona.episode_started':
      return { seq, label: 'Start', tone: 'muted', title: `Opened ${event.payload.start_url} in a ${event.payload.device} browser` };
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
      };
    }
    case 'persona.friction_reported': {
      const { step_no, severity, what, expected } = event.payload;
      return { seq, label: `Step ${step_no}`, tone: 'friction', title: `Friction, severity ${severity} of 4: ${what}`, detail: `Expected: ${expected}` };
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

/** The activity list, newest first so the latest step is always in view. Blocked requests are one updating row per host. */
export function toRows(events: GnomiEvent[]): Row[] {
  const blocked = new Map<string, number>();
  for (const event of events) if (event.type === 'containment.blocked_request') blocked.set(event.payload.host, (blocked.get(event.payload.host) ?? 0) + 1);
  const shown = new Set<string>();
  return events
    .flatMap((event): Row[] => {
      if (event.type !== 'containment.blocked_request') {
        const row = describe(event);
        return row ? [row] : [];
      }
      const { host } = event.payload;
      if (shown.has(host)) return [];
      shown.add(host);
      // Anchored at the first request, so the row keeps its place while its count grows.
      return [{ seq: event.seq, label: 'Blocked', tone: 'notice', title: `Blocked requests to ${host} (${blocked.get(host)})` }];
    })
    .reverse();
}

export const isEnd = (event: GnomiEvent) => event.type === 'run.finished' || event.type === 'run.stopped';

/** The persona.blocked event the user still has to act on: no persona.resumed after it, and the run has not ended. */
export function waitingBlock(events: GnomiEvent[]): EventOf<'persona.blocked'> | null {
  if (events.some(isEnd)) return null;
  const blocked = events.findLast((event): event is EventOf<'persona.blocked'> => event.type === 'persona.blocked');
  // shortcut: one persona per run, so any later resume ends the wait; key it by persona_id when M2 adds more personas
  return blocked && !events.some((event) => event.type === 'persona.resumed' && event.seq > blocked.seq) ? blocked : null;
}

/** Events arrive both live and from get_events, so adding the same one twice must change nothing. */
export function merge(have: GnomiEvent[], incoming: GnomiEvent[]): GnomiEvent[] {
  const seen = new Set(have.map((event) => event.seq));
  const fresh = incoming.filter((event) => !seen.has(event.seq));
  return fresh.length ? [...have, ...fresh].sort((a, b) => a.seq - b.seq) : have;
}
