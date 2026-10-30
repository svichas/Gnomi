import type { PageError } from '../seams.ts';
import type { Device, EventOf, EventPayloads, GnomiEvent, SignalBase, SignalThresholds } from '../types.ts';

// Objective friction signals (tech.md §8.1): pure rules over one persona's steps. The agent loop runs them right after each
// step and writes what they find to the log, so a report cites what was detected under the run's frozen thresholds.

export const DEFAULT_SIGNALS: SignalThresholds = { loop_visits: 3, loop_window: 10, back_count: 2, back_window: 5, revisit_window: 4, small_target_px: 24, interference_s: 60 };

export type Step = Pick<EventPayloads['persona.step'], 'step_no' | 'action' | 'target' | 'result' | 'snapshot_hash'>;
type Detected = 'signal.failed_action' | 'signal.loop' | 'signal.backtrack' | 'signal.error' | 'signal.validation_error' | 'signal.small_target';
export type Signal = { [K in Detected]: { type: K; payload: EventPayloads[K] } }[Detected];
type SignalOf<K extends Detected> = Extract<Signal, { type: K }>;

// The §8.1 failures. Model mistakes (a ref it made up, typing where a person clicks) and Gnomi's own refusals (other hosts, password fields in older logs) are not the product's.
const FAILURES = new Set(['not_editable', 'timeout']);
// Validation wording, matched only on lines a button click made appear.
const ERRORISH = /\b(?:error|invalid|required|incorrect|failed|went wrong|already (?:exists|taken|in use|registered|a user)|must (?:be|contain|match|include|have)|please (?:enter|choose|select|fill|provide|correct)|(?:enter|choose|select|provide) (?:a|an|your|the|at least)|not (?:valid|allowed|found|match))\b/i;

const base = (step: Step): SignalBase => ({ step_no: step.step_no, url: step.result.url_before, ref: step.action.ref });
/** A page's identity for loops and revisits: its URL without the fragment. */
const pageKey = (url: string) => url.split('#')[0];
/** The steps among `steps` in the `window` steps ending at `end`, end included. */
const within = (steps: Step[], end: Step, window: number) => steps.filter((s) => s.step_no > end.step_no - window && s.step_no <= end.step_no);
/** A click on a button: the only action here that can submit a form, so the only one that takes a snapshot after it. */
export const isSubmit = (step: Step) => step.action.type === 'click' && step.result.ok && step.target?.role === 'button';

/** `previous` is the step before: a click on what its type clicked open (a picker, a custom list) finds it open already. */
export function failedAction(step: Step, previous?: Step): SignalOf<'signal.failed_action'> | null {
  const { action, result } = step;
  const opened = previous?.action.type === 'type' && previous.action.ref === action.ref && previous.result.dom_changed && /^(?:readonly|not_a_field)$/.test(previous.result.error ?? '');
  // A request still in flight or a tab opened: the click did something the page has not shown yet, or shows elsewhere.
  const error = result.error !== null && FAILURES.has(result.error) ? result.error : action.type === 'click' && result.ok && !result.dom_changed && !result.pending && result.url_after === result.url_before && !opened ? 'no_effect' : null;
  return error ? { type: 'signal.failed_action', payload: { ...base(step), action: action.type, error } } : null;
}

/** The same page state (URL and snapshot hash) seen loop_visits times within loop_window steps; once per loop, not on every further visit. */
export function loop(history: Step[], step: Step, t: SignalThresholds): SignalOf<'signal.loop'> | null {
  // Reading and waiting stay on the page by design, and a failed step (a model's unusable answer, an option it guessed) never
  // touched it: none of them is the persona going round. A product's failures show as failed_action instead.
  const moved = (s: Step) => s.result.ok && s.action.type !== 'read' && s.action.type !== 'wait';
  if (!moved(step)) return null;
  history = history.filter(moved);
  const steps = [...history, step];
  const key = (s: Step) => `${pageKey(s.result.url_before)} ${s.snapshot_hash}`;
  const visits = (end: Step) => within(steps, end, t.loop_window).filter((s) => key(s) === key(end)).length;
  const count = visits(step);
  if (count < t.loop_visits) return null;
  // A visit earlier in the window already reached the threshold: the same loop, already reported.
  if (within(history, step, t.loop_window).some((s) => key(s) === key(step) && visits(s) >= t.loop_visits)) return null;
  return { type: 'signal.loop', payload: { ...base(step), snapshot_hash: step.snapshot_hash, visits: count } };
}

/**
 * The back_count-th `back` within back_window steps, or the persona's own move to a page acted on in the previous revisit_window
 * steps. Where a submit lands is the app's choice (a form re-rendered at /jobs, a save that returns to the list), not a backtrack.
 */
export function backtrack(history: Step[], step: Step, t: SignalThresholds): SignalOf<'signal.backtrack'> | null {
  const backs = within([...history, step], step, t.back_window).filter((s) => s.action.type === 'back').length;
  if (step.action.type === 'back' && backs === t.back_count) return { type: 'signal.backtrack', payload: { ...base(step), kind: 'repeated_back' } };
  const to = pageKey(step.result.url_after);
  const revisit = !isSubmit(step) && to !== pageKey(step.result.url_before) && within(history, step, t.revisit_window + 1).some((s) => pageKey(s.result.url_before) === to);
  return revisit ? { type: 'signal.backtrack', payload: { ...base(step), kind: 'revisit' } } : null;
}

// Snapshot lines without what changes on every render (refs, boxes, focus), so the same message reads the same before and after.
const lines = (snapshot: string) => new Set(snapshot.split('\n').map((line) => line.replace(/ \[(?:ref|box|cursor)=[^\]]*\]| \[active\]| \(off screen, (?:above|below|left|right)\)/g, '').trim()));
const textOf = (line: string) => /: (.+)$/.exec(line)?.[1] ?? /"(.+)"/.exec(line)?.[1] ?? line.replace(/^- /, '');
const FIELD = /^- (?:textbox|searchbox|combobox|checkbox|radio|switch|spinbutton|slider)\b/;
/** A field line's role and name, without its value or state. */
const fieldOf = (line: string) => /^- \S+(?: "(?:[^"\\]|\\.)*")?/.exec(line)?.[0] ?? line;

/** After a button click, a control newly marked aria-invalid, or a new line in error wording. */
export function validationError(step: Step, before: string | null, after: string | null): SignalOf<'signal.validation_error'> | null {
  if (before === null || after === null || !isSubmit(step)) return null;
  const seen = lines(before);
  const fields = new Set([...seen].filter((line) => FIELD.test(line)).map(fieldOf));
  let fresh = [...lines(after)].filter((line) => !seen.has(line));
  // A new field means the click revealed content (a wizard's next step, an added block), whose ordinary copy reads like errors.
  if (fresh.some((line) => FIELD.test(line) && !fields.has(fieldOf(line)))) fresh = fresh.filter((line) => line.includes(' [invalid]') || line.startsWith('- alert'));
  const samePage = pageKey(step.result.url_after) === pageKey(step.result.url_before);
  const invalid = fresh.find((line) => line.includes(' [invalid]'));
  // A new page's "required" hints are not errors: after a navigation, wording counts only beside an invalid control or in an alert.
  // A field's name is often a placeholder ("Enter a job title"): it counts only when the field is marked invalid. The
  // browser's own refusal ("Please include an '@'") is an error whatever its wording.
  const worded = fresh.find((line) => (ERRORISH.test(textOf(line)) || line.startsWith('- alert [invalid]')) && (samePage || invalid !== undefined || line.startsWith('- alert')) && (!/^- (?:text|search)box\b/.test(line) || line.includes(' [invalid]')));
  const message = worded ? textOf(worded) : invalid ? `${invalid.replace(/^- | \[invalid\]/g, '')} is marked invalid` : null;
  return message ? { type: 'signal.validation_error', payload: { ...base(step), message: message.slice(0, 200) } } : null;
}

export function smallTarget(step: Step, device: Device, t: SignalThresholds): SignalOf<'signal.small_target'> | null {
  const box = step.target?.box;
  if (device !== 'mobile' || step.action.type !== 'click' || !box) return null;
  const [, , width, height] = box;
  return width > 0 && height > 0 && Math.min(width, height) < t.small_target_px ? { type: 'signal.small_target', payload: { ...base(step), box } } : null;
}

/**
 * Whether a step changed the element it acted on (assumed, odd.md): a value typed or chosen, or a click on anything but a link that
 * did something. Reading, hovering and following a link write nothing. A draft counts too: the log cannot tell it from a shared record.
 */
const changedTarget = (step: Step) => step.result.ok && !failedAction(step) && (step.action.type === 'type' || step.action.type === 'select' || (step.action.type === 'click' && step.target?.role !== 'link'));

/**
 * The failed-action signals (by seq) another persona may have caused (tech.md §9.2): the step's target has the name of something a
 * different persona changed on the same POI at most interference_s earlier. A fold over the log and its times, so a rebuild agrees;
 * a run from before this froze no window, so it keeps no tag.
 * shortcut: names match whole, so a "Save" on another page matches and a renamed record does not; the tag only says possibly, match on the record if readers stop trusting it.
 */
export function possibleInterference(events: GnomiEvent[]): Set<number> {
  const found = new Set<number>();
  const seconds = events.find((e): e is EventOf<'run.started'> => e.type === 'run.started')?.payload.config.signals?.interference_s;
  if (!seconds) return found;
  const nameOf = (e: GnomiEvent, step?: Step) => (step?.target?.name.trim() ? `${e.poi_id}\u0000${step.target.name.trim().toLowerCase()}` : null);
  const latest = new Map<string, Step>(); // each persona's last step: a signal follows its own step in the log
  const changes = new Map<string, Map<string, number>>(); // POI and name → persona → when that persona last changed it
  for (const e of events) {
    if (e.persona_id === null) continue;
    if (e.type === 'persona.step') {
      latest.set(e.persona_id, e.payload);
      const name = nameOf(e, e.payload);
      if (name && changedTarget(e.payload)) changes.set(name, (changes.get(name) ?? new Map<string, number>()).set(e.persona_id, e.ts));
    } else if (e.type === 'signal.failed_action') {
      const by = changes.get(nameOf(e, latest.get(e.persona_id)) ?? '');
      for (const [persona, at] of by ?? []) if (persona !== e.persona_id && e.ts - at <= seconds * 1000) found.add(e.seq);
    }
  }
  return found;
}

/**
 * Every signal one step raises. `history` is the episode's earlier steps; `errors` what the page captured since the last step;
 * `before`/`after` the snapshot texts around a submit (after is null for other actions). A done or abandon step did nothing
 * on the page, so only errors captured meanwhile count.
 */
export function detectSignals(input: { history: Step[]; step: Step; device: Device; errors: PageError[]; before: string | null; after: string | null; thresholds: SignalThresholds }): Signal[] {
  const { history, step, device, errors, before, after, thresholds: t } = input;
  const ended = step.action.type === 'done' || step.action.type === 'abandon';
  const found: (Signal | null)[] = ended ? [] : [failedAction(step, history.at(-1)), loop(history, step, t), backtrack(history, step, t)];
  // An error belongs to the page it happened on: after a navigation, the one the step landed on.
  for (const error of errors) found.push({ type: 'signal.error', payload: { ...base(step), url: step.result.url_after, ...error } });
  if (!ended) found.push(validationError(step, before, after), smallTarget(step, device, t));
  return found.filter((signal): signal is Signal => signal !== null);
}
