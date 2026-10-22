import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Action, ActionResult, ActionTarget } from '../types.ts';
import { backtrack, DEFAULT_SIGNALS, detectSignals, failedAction, loop, smallTarget, validationError, type Step } from './index.ts';

const T = DEFAULT_SIGNALS;
const A = 'https://app.test/a';
const B = 'https://app.test/b';
const C = 'https://app.test/c';

/** A step that acted on `from` and ended on `to`; ok, the DOM changed, unless overridden. */
function step(step_no: number, type: Action['type'], from: string, to = from, over: { result?: Partial<ActionResult>; target?: ActionTarget | null; hash?: string; ref?: string | null } = {}): Step {
  return {
    step_no,
    action: { type, ref: over.ref === undefined ? 'e1' : over.ref, text: null },
    target: over.target === undefined ? { role: 'link', name: 'Next', box: [0, 0, 80, 44] } : over.target,
    result: { ok: true, url_before: from, url_after: to, dom_changed: true, error: null, ...over.result },
    snapshot_hash: over.hash ?? `h-${from}`,
  };
}
/** Runs `rule` over each step with the steps before it as history, collecting what it found. */
const replay = (steps: Step[], rule: (history: Step[], s: Step) => unknown) => steps.map((s, i) => rule(steps.slice(0, i), s)).filter(Boolean);

test('failed_action: not editable and timeout are failures; a model or containment error is not', () => {
  for (const error of ['not_editable', 'timeout']) {
    assert.deepEqual(failedAction(step(4, 'type', A, A, { result: { ok: false, error } })), {
      type: 'signal.failed_action',
      payload: { step_no: 4, url: A, ref: 'e1', action: 'type', error },
    });
  }
  // A tap that would land on a cookie bar, or on content no longer shown, is a step the persona retakes, not a product failure.
  for (const error of ['ref_not_found', 'invalid_output', 'password_field', 'host_not_allowed', 'option_not_found', 'covered by region "Cookies"', 'not_visible']) assert.equal(failedAction(step(1, 'click', A, A, { result: { ok: false, error } })), null, error);
  // Typing where a person clicks or picks (a readonly picker, a button, a colour name) is the model's step to retake.
  for (const error of ['readonly', 'not_a_field', 'invalid_value']) assert.equal(failedAction(step(1, 'type', A, A, { result: { ok: false, error } })), null, error);
});

test('failed_action: a click with no URL or DOM change had no effect; one that changed the DOM or the URL did', () => {
  assert.equal(failedAction(step(2, 'click', A, A, { result: { dom_changed: false } }))?.payload.error, 'no_effect');
  assert.equal(failedAction(step(2, 'click', A, A)), null, 'the DOM changed');
  assert.equal(failedAction(step(2, 'click', A, B, { result: { dom_changed: false } })), null, 'the URL changed');
  assert.equal(failedAction(step(2, 'click', A, `${A}#top`, { result: { dom_changed: false } })), null, 'an anchor jump is a change');
  assert.equal(failedAction(step(2, 'read', A, A, { result: { dom_changed: false } })), null, 'reading changes nothing by design');
  assert.equal(failedAction(step(2, 'click', A, A, { result: { dom_changed: false, pending: true } })), null, 'a slow save or a new tab is not a dead click');
});

test('loop: the same URL and snapshot seen three times within ten steps, reported once', () => {
  const steps = [step(1, 'click', A), step(2, 'click', B), step(3, 'click', A), step(4, 'click', B), step(5, 'click', A), step(6, 'click', B), step(7, 'click', A)];
  const found = replay(steps, (history, s) => loop(history, s, T));
  assert.deepEqual(found, [
    { type: 'signal.loop', payload: { step_no: 5, url: A, ref: 'e1', snapshot_hash: `h-${A}`, visits: 3 } },
    { type: 'signal.loop', payload: { step_no: 6, url: B, ref: 'e1', snapshot_hash: `h-${B}`, visits: 3 } },
  ]);
});

test('loop: reading a page twice is not a loop, nor are three visits spread over more than ten steps or with different snapshots', () => {
  assert.deepEqual(replay([step(1, 'read', A), step(2, 'read', A)], (h, s) => loop(h, s, T)), []);
  const unusable = step(3, 'wait', A, A, { result: { ok: false, error: 'invalid_output' } });
  assert.deepEqual(replay([step(1, 'read', A), step(2, 'wait', A), unusable], (h, s) => loop(h, s, T)), [], 'reads, waits and unusable answers stay put by design');
  assert.deepEqual(replay([step(1, 'click', A), step(2, 'read', A), step(3, 'click', A)], (h, s) => loop(h, s, T)), [], 'nor do they count towards a loop');
  const spread = [1, 6, 11].map((n) => step(n, 'click', A));
  assert.deepEqual(replay(spread, (h, s) => loop(h, s, T)), []);
  const changing = [1, 2, 3].map((n) => step(n, 'type', A, A, { hash: `h${n}` }));
  assert.deepEqual(replay(changing, (h, s) => loop(h, s, T)), []);
  assert.equal(replay([step(1, 'click', `${A}#x`, undefined, { hash: 'h' }), step(2, 'click', A, A, { hash: 'h' }), step(3, 'click', `${A}#y`, undefined, { hash: 'h' })], (h, s) => loop(h, s, T)).length, 1, 'the fragment is not part of the page');
});

test('loop: failed steps that never touched the page, such as guessed options, are not the persona going round', () => {
  const guesses = [1, 2, 3].map((n) => step(n, 'select', A, A, { hash: 'h', result: { ok: false, error: 'option_not_found', dom_changed: false } }));
  assert.deepEqual(replay(guesses, (h, s) => loop(h, s, T)), []);
});

test('loop: a loop that goes on is not reported again, one that comes back after a break is', () => {
  const visits = [1, 5, 9, 13, 17, 30, 31, 32].map((n) => step(n, 'click', A));
  assert.deepEqual(
    replay(visits, (h, s) => loop(h, s, T)).map((f) => (f as { payload: { step_no: number } }).payload.step_no),
    [9, 32],
  );
});

test('backtrack: the second back within five steps, and a return to a page acted on in the last four steps', () => {
  const steps = [step(1, 'click', A, B), step(2, 'click', B, C), step(3, 'back', C, B, { ref: null }), step(4, 'back', B, A, { ref: null })];
  assert.deepEqual(replay(steps, (h, s) => backtrack(h, s, T)), [
    { type: 'signal.backtrack', payload: { step_no: 3, url: C, ref: null, kind: 'revisit' } },
    { type: 'signal.backtrack', payload: { step_no: 4, url: B, ref: null, kind: 'repeated_back' } },
  ]);
  const linkHome = [step(1, 'click', A, B), step(2, 'click', B, A)];
  assert.equal((replay(linkHome, (h, s) => backtrack(h, s, T))[0] as { payload: { kind: string } }).payload.kind, 'revisit', 'a link back counts too');
});

test('backtrack: moving forward, staying put, backs far apart and old pages are not backtracks', () => {
  const forward = [step(1, 'click', A, B), step(2, 'click', B, C)];
  assert.deepEqual(replay(forward, (h, s) => backtrack(h, s, T)), []);
  const staying = [step(1, 'type', A), step(2, 'click', A)];
  assert.deepEqual(replay(staying, (h, s) => backtrack(h, s, T)), []);
  const old = [step(1, 'click', A, B), ...[2, 3, 4, 5].map((n) => step(n, 'type', B)), step(6, 'click', B, A)];
  assert.deepEqual(replay(old, (h, s) => backtrack(h, s, T)), [], 'A was last acted on five steps ago');
  const apart = [step(1, 'back', A, A), ...[2, 3, 4, 5].map((n) => step(n, 'type', A)), step(6, 'back', A, A)];
  assert.deepEqual(replay(apart, (h, s) => backtrack(h, s, T)), []);
  const posted = [step(1, 'click', A, B), step(2, 'click', B, C), step(3, 'click', C, B, { target: { role: 'button', name: 'Publish job', box: null } })];
  assert.deepEqual(replay(posted, (h, s) => backtrack(h, s, T)), [], 'where a form posts to is the app\'s choice, not the persona backtracking');
});

const FORM = `- heading "Create job" [level=1] [ref=e10] [box=176,88,928,36]
- textbox "Job title *" [ref=e14] [box=197,188,420,41]
- paragraph [ref=e31] [box=197,784,886,20]: Must match an existing user's name
- button "Publish job" [ref=e33] [cursor=pointer] [box=197,819,109,41]`;
const button: ActionTarget = { role: 'button', name: 'Publish job', box: [197, 819, 109, 41] };
const submit = (to = A) => step(3, 'click', A, to, { target: button, ref: 'e33' });

test('validation_error: an invalid field and its message after a submit, even when the form posts to another URL', () => {
  const after = `- heading "Create job" [level=1] [ref=f1e10] [box=176,88,928,36]
- textbox "Job title *" [invalid] [ref=f1e14] [box=197,188,420,41]
- paragraph [ref=f1e15] [box=197,232,886,21]: Enter a job title
- paragraph [ref=f1e31] [box=197,834,886,20]: Must match an existing user's name
- button "Publish job" [active] [ref=f1e35] [cursor=pointer] [box=197,869,109,41]`;
  assert.deepEqual(validationError(submit(B), FORM, after), { type: 'signal.validation_error', payload: { step_no: 3, url: A, ref: 'e33', message: 'Enter a job title' } });
  const bare = after.replace(/\n- paragraph \[ref=f1e15\].*/, '');
  assert.equal(validationError(submit(B), FORM, bare)?.payload.message, 'textbox "Job title *" is marked invalid');
});

test('validation_error: an alert, or error wording on the same page, counts', () => {
  assert.equal(validationError(submit(B), FORM, `${FORM}\n- alert [ref=e40]: Payment failed`)?.payload.message, 'Payment failed');
  assert.equal(validationError(submit(), FORM, `${FORM}\n- generic [ref=e40]: Please enter a valid email`)?.payload.message, 'Please enter a valid email');
});

test('validation_error: no new message, hints on a new page, a message already showing, or a non-submit action are not', () => {
  assert.equal(validationError(submit(), FORM, FORM.replaceAll('[ref=e', '[ref=f1e')), null, 'only refs changed');
  assert.equal(validationError(submit(), FORM, `${FORM}\n- paragraph [ref=e50]: Job published`), null, 'success wording');
  assert.equal(validationError(submit(B), FORM, `${FORM}\n- paragraph [ref=e50]: Fields marked * are required`), null, 'a new page with a required hint');
  const shown = `${FORM}\n- paragraph [ref=e15]: Enter a job title`;
  assert.equal(validationError(submit(), shown, shown), null, 'the same error as before');
  const link = step(3, 'click', A, A, { target: { role: 'link', name: 'Help', box: null } });
  assert.equal(validationError(link, FORM, `${FORM}\n- alert: Something went wrong`), null, 'a link is not a submit');
  assert.equal(validationError(submit(), FORM, null), null, 'no snapshot after');
  assert.equal(validationError(submit(), FORM, `${FORM}\n- textbox "Enter a job title" [ref=e50]`), null, 'a new field whose placeholder reads like an error');
  assert.equal(validationError(submit(), FORM, `${FORM}\n- textbox "Enter a job title" [invalid] [ref=e50]`)?.payload.message, 'Enter a job title');
  const hint = (where: string) => `${FORM}\n- paragraph [ref=e50] ${where}: Fields marked * are required`;
  assert.equal(validationError(submit(), hint('[box=0,900,100,20] (off screen, below)'), hint('[box=0,300,100,20]')), null, 'a hint that scrolled into view');
});

// A wizard's first step, its second step after "Next", and that step after "Add another ticket", as the driver showed them.
const WIZARD = `- heading "Create an event" [level=1] [ref=e2] [box=8,21,1264,37]
- text: Title
- textbox "Title" [ref=e4] [box=38,80,153,21]: Sunset hike
- button "Next" [ref=e5] [box=191,80,43,21]
- button "Add another ticket" [ref=e6] [box=8,101,123,21]`;
const STEP_2 = `- heading "Create an event" [level=1] [ref=e2] [box=8,21,1264,37]
- heading "Step 2 of 3: Tickets" [level=2] [ref=e8] [box=8,80,1264,28]
- paragraph [ref=e9] [box=8,128,1264,18]: Choose a ticket type for your guests.
- combobox [ref=e10] [box=8,162,1264,18]: Select a category
- text: Price (required)
- spinbutton "Price (required)" [ref=e11] [box=109,180,153,21]
- button "Continue" [ref=e12] [box=266,180,69,21]
- button "Add another ticket" [ref=e6] [box=8,201,123,21]`;
const ADDED = `${STEP_2.replace('ticket" [ref=e6]', 'ticket" [active] [ref=e6]')}
- heading "Ticket 2" [level=3] [ref=e14] [box=8,241,1264,22]
- paragraph [ref=e15] [box=8,281,1264,18]: Ticket name is required. Enter a name your guests will recognise.
- textbox "Ticket name" [ref=e16] [box=8,315,153,21]`;

test('validation_error: copy a click revealed along with new fields is not an error; an alert or an invalid field among them is', () => {
  const next = step(3, 'click', A, A, { target: { role: 'button', name: 'Next', box: null }, ref: 'e5' });
  const add = step(4, 'click', A, A, { target: { role: 'button', name: 'Add another ticket', box: null }, ref: 'e6' });
  assert.equal(validationError(next, WIZARD, STEP_2), null, 'a wizard\'s next step');
  assert.equal(validationError(add, STEP_2, ADDED), null, 'an added block\'s help text');
  assert.equal(validationError(next, WIZARD, `${STEP_2}\n- alert [ref=e20]: Please choose a ticket type`)?.payload.message, 'Please choose a ticket type');
  assert.equal(validationError(add, STEP_2, ADDED.replace('"Ticket name" [ref', '"Ticket name" [invalid] [ref'))?.payload.message, 'textbox "Ticket name" is marked invalid');
  assert.equal(validationError(next, WIZARD, `${WIZARD}\n- generic [ref=e20]: Title is required`)?.payload.message, 'Title is required', 'no new field: wording still counts');
});

test('small_target: a mobile tap on an element under 40×40 CSS px; desktop taps and large targets never', () => {
  const tap = (box: [number, number, number, number] | null) => step(1, 'click', A, B, { target: { role: 'link', name: 'Jobs', box } });
  assert.deepEqual(smallTarget(tap([10, 20, 35, 23]), 'mobile', T), { type: 'signal.small_target', payload: { step_no: 1, url: A, ref: 'e1', box: [10, 20, 35, 23] } });
  assert.equal(smallTarget(tap([10, 20, 120, 39]), 'mobile', T)?.type, 'signal.small_target', 'too short');
  assert.equal(smallTarget(tap([10, 20, 35, 23]), 'desktop', T), null);
  assert.equal(smallTarget(tap([10, 20, 40, 40]), 'mobile', T), null);
  assert.equal(smallTarget(tap(null), 'mobile', T), null);
  assert.equal(smallTarget(tap([0, 0, 0, 0]), 'mobile', T), null, 'not laid out');
  assert.equal(smallTarget(step(1, 'type', A, A, { target: { role: 'textbox', name: 'Title', box: [0, 0, 30, 20] } }), 'mobile', T), null, 'typing is not a tap');
  assert.equal(smallTarget(tap([10, 20, 45, 45]), 'mobile', { ...T, small_target_px: 48 })?.type, 'signal.small_target', 'the frozen threshold applies');
});

test('detectSignals: page errors become signal.error on the step; a done step reports only errors', () => {
  const errors = [{ kind: 'http' as const, status: 404, message: 'GET https://app.test/job' }, { kind: 'console' as const, status: null, message: 'boom' }];
  const clicked = step(1, 'click', A, A, { result: { dom_changed: false } });
  assert.deepEqual(
    detectSignals({ history: [], step: clicked, device: 'desktop', errors, before: null, after: null, thresholds: T }).map((s) => [s.type, s.payload]),
    [
      ['signal.failed_action', { step_no: 1, url: A, ref: 'e1', action: 'click', error: 'no_effect' }],
      ['signal.error', { step_no: 1, url: A, ref: 'e1', kind: 'http', status: 404, message: 'GET https://app.test/job' }],
      ['signal.error', { step_no: 1, url: A, ref: 'e1', kind: 'console', status: null, message: 'boom' }],
    ],
  );
  const moved = step(2, 'click', A, B);
  assert.deepEqual(detectSignals({ history: [], step: moved, device: 'desktop', errors: errors.slice(1), before: null, after: null, thresholds: T }).map((s) => s.payload.url), [B], 'an error belongs to the page the step landed on');
  const looped = [1, 2].map((n) => step(n, 'read', A));
  const done = step(3, 'done', A, A, { ref: null, target: null, result: { dom_changed: false } });
  assert.deepEqual(detectSignals({ history: looped, step: done, device: 'mobile', errors: [], before: null, after: null, thresholds: T }), []);
  assert.deepEqual(detectSignals({ history: looped, step: done, device: 'mobile', errors: errors.slice(1), before: null, after: null, thresholds: T }).map((s) => s.type), ['signal.error']);
});
