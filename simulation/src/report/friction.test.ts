import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ActionTarget, EventPayloads, EventType, GnomiEvent } from '../types.ts';
import { buildCandidates, groupCandidates, pagePattern } from './friction.ts';

const JOBS = 'http://gym.test/jobs/new';
const OTHER = 'http://gym.test/settings';

/** A log written in the given order; seq counts from 1. */
function log(...entries: [type: EventType, persona_id: string | null, payload: object][]): GnomiEvent[] {
  return entries.map(([type, persona_id, payload], i) => ({ run_id: 'r-1', round: 1, persona_id, poi_id: 'poi', type, payload, seq: i + 1, ts: i }) as GnomiEvent);
}

function step(step_no: number, url = JOBS, target: { role: string; name: string } | null = null): EventPayloads['persona.step'] {
  return {
    step_no,
    action: { type: 'click', ref: 'e1', text: null },
    target: target && { ...target, box: null },
    result: { ok: true, url_before: url, url_after: url, dom_changed: true, error: null },
    thought: `Thinking at step ${step_no}.`,
    feeling: 0,
    snapshot_hash: 'h',
    screenshot: `shots/${step_no}.jpg`,
    duration_ms: 1,
    heard_post_ids: [],
  };
}

const friction = (step_no: number, what: string, severity = 2, url = JOBS): EventPayloads['persona.friction_reported'] => ({
  step_no, severity, what, expected: 'Clearer.', where: { url, ref: 'e1' }, heard_post_ids: [],
});
const failed = (step_no: number, url = JOBS): EventPayloads['signal.failed_action'] => ({ step_no, url, ref: 'e1', action: 'click', error: 'no_effect' });

// A self-report at step 5 and a signal `at` steps later, on `url`, by `persona`.
function pair(at: number, opts: { url?: string; persona?: string } = {}) {
  return buildCandidates(log(
    ['persona.step', 'p1', step(5)],
    ['persona.friction_reported', 'p1', friction(5, 'Save does nothing', 3)],
    ['persona.step', opts.persona ?? 'p1', step(5 + at, opts.url)],
    ['signal.failed_action', opts.persona ?? 'p1', failed(5 + at, opts.url)],
  ), 'poi');
}

test('a signal three steps from a self-report on the same page confirms it; four steps apart they stay apart', () => {
  const three = pair(3);
  assert.deepEqual(three.map((c) => [c.trust, c.seqs, c.signals]), [['confirmed', [2, 4], ['failed_action']]]);
  assert.equal(three[0].severity, 3, 'the persona’s own severity wins');
  assert.deepEqual(pair(-3).map((c) => c.trust), ['confirmed'], 'three steps before counts too');
  assert.deepEqual(pair(4).map((c) => [c.trust, c.kind]), [['reported', 'friction'], ['observed', 'failed_action']]);
});

test('a signal on another page or by another persona never confirms a self-report', () => {
  assert.deepEqual(pair(1, { url: OTHER }).map((c) => c.trust), ['reported', 'observed']);
  assert.deepEqual(pair(1, { persona: 'p2' }).map((c) => [c.persona_id, c.trust]), [['p1', 'reported'], ['p2', 'observed']]);
});

test('a signal joins the nearest self-report, and a query string or record id is the same page', () => {
  const candidates = buildCandidates(log(
    ['persona.friction_reported', 'p1', friction(2, 'First', 2, 'http://gym.test/jobs/41?tab=1')],
    ['persona.friction_reported', 'p1', friction(5, 'Second', 2, 'http://gym.test/jobs/42')],
    ['signal.failed_action', 'p1', failed(4, 'http://gym.test/jobs/43#top')],
  ), 'poi');
  assert.deepEqual(candidates.map((c) => [c.text, c.trust]), [['First', 'reported'], ['Second', 'confirmed']]);
});

test('a failed action another persona may have caused keeps its tag, also merged into a self-report, and a rebuild agrees', () => {
  const save = { role: 'button', name: 'Save' };
  const dead = { ...step(6, JOBS, save), result: { ok: true, url_before: JOBS, url_after: JOBS, dom_changed: false, error: null } };
  const events = (signals?: object) => [
    ...log(['run.started', null, { config: { signals } }], ['persona.step', 'p1', step(1, JOBS, save)], ['persona.step', 'p2', step(5, JOBS)], ['persona.friction_reported', 'p2', friction(5, 'Save does nothing')], ['persona.step', 'p2', dead], ['signal.failed_action', 'p2', failed(6)], ['persona.step', 'p3', dead], ['signal.failed_action', 'p3', failed(6)]),
  ];
  const tags = (list: GnomiEvent[]) => buildCandidates(list, 'poi').map((c) => [c.persona_id, c.trust, c.interference]);
  const window = { interference_s: 60 };
  assert.deepEqual(tags(events(window)), [['p2', 'confirmed', true], ['p3', 'observed', true]]);
  assert.deepEqual(tags(events(window)), tags(events(window)));
  assert.deepEqual(tags(events()), [['p2', 'confirmed', undefined], ['p3', 'observed', undefined]], 'an old log');
});

test('page patterns drop query, fragment and record ids', () => {
  assert.equal(pagePattern('https://gym.test/jobs/123/edit?x=1#y'), 'gym.test/jobs/:id/edit');
  assert.equal(pagePattern('https://gym.test/c/3f2b8c1e-1d2a-4b5c-8d9e-0f1a2b3c4d5e/'), 'gym.test/c/:id');
  assert.equal(pagePattern('https://gym.test/'), 'gym.test/');
  assert.equal(pagePattern('https://gym.test/jobs/new'), 'gym.test/jobs/new');
  assert.equal(pagePattern('not a url'), 'not a url');
});

test('candidates carry the step’s element, quote and screenshot; abandons, surveys and signals have their own defaults', () => {
  const candidates = buildCandidates(log(
    ['persona.step', 'p1', step(1, JOBS, { role: 'button', name: 'Save' })],
    ['persona.abandoned', 'p1', { step_no: 1, reason: 'Gave up on the form' }],
    ['signal.loop', 'p2', { step_no: 3, url: JOBS, ref: null, snapshot_hash: 'h', visits: 3 }],
    ['persona.survey', 'p1', { poi_id: 'poi', sentiment: -1, confidence: 0.5, likes: [], frictions: ['Too many fields'], would_continue: false, reason: 'It was long.' }],
  ), 'poi');
  assert.deepEqual(
    candidates.map((c) => [c.kind, c.trust, c.severity, c.element, c.page, c.step_seq, c.quote, c.screenshot]),
    [
      ['abandoned', 'reported', 3, 'button "Save"', 'gym.test/jobs/new', 1, 'Thinking at step 1.', 'shots/1.jpg'],
      ['loop', 'observed', 2, null, 'gym.test/jobs/new', null, '', null],
      ['survey', 'reported', 2, null, null, null, 'It was long.', null],
    ],
  );
});

test('groups by (poi, page, element), else (poi, page, kind); survey answers by their words', () => {
  const groups = groupCandidates(buildCandidates(log(
    ['persona.step', 'p1', step(1, JOBS, { role: 'button', name: 'Save' })],
    ['persona.friction_reported', 'p1', friction(1, 'Save is unclear')],
    ['persona.step', 'p2', step(1, 'http://gym.test/jobs/new?draft=1', { role: 'button', name: 'save' })],
    ['persona.friction_reported', 'p2', friction(1, 'What does Save do?')],
    ['persona.friction_reported', 'p3', friction(2, 'No element here')],
    ['signal.failed_action', 'p3', failed(9)],
    ['persona.survey', 'p1', { poi_id: 'poi', sentiment: 0, confidence: 1, likes: [], frictions: ['Too many fields!'], would_continue: true, reason: '' }],
    ['persona.survey', 'p2', { poi_id: 'poi', sentiment: 0, confidence: 1, likes: [], frictions: ['too many  fields'], would_continue: true, reason: '' }],
  ), 'poi'));
  assert.deepEqual(
    groups.map((g) => [g.id, g.element, g.kind, g.members.map((m) => m.persona_id)]),
    [
      ['g1', 'button "Save"', 'friction', ['p1', 'p2']],
      ['g2', null, 'friction', ['p3']],
      ['g3', null, 'failed_action', ['p3']],
      ['g4', null, 'survey', ['p1', 'p2']],
    ],
  );
});

test('a console error never confirms a self-report: it is its own candidate, grouped by its words, not the clicked element', () => {
  const consoleError = (step_no: number, message: string): EventPayloads['signal.error'] => ({ step_no, url: JOBS, ref: 'e1', kind: 'console', status: null, message });
  const candidates = buildCandidates(log(
    ['persona.step', 'p1', step(5, JOBS, { role: 'button', name: 'Save' })],
    ['persona.friction_reported', 'p1', friction(5, 'Save does nothing')],
    ['signal.error', 'p1', consoleError(5, 'Analytics blocked')],
    ['persona.step', 'p2', step(2, JOBS, { role: 'link', name: 'Help' })],
    ['signal.error', 'p2', consoleError(2, 'analytics  blocked!')],
  ), 'poi');
  assert.deepEqual(candidates.map((c) => [c.persona_id, c.kind, c.trust, c.element]), [['p1', 'friction', 'reported', 'button "Save"'], ['p1', 'error', 'observed', null], ['p2', 'error', 'observed', null]]);
  assert.deepEqual(groupCandidates(candidates).map((g) => [g.kind, g.members.map((m) => m.persona_id)]), [['friction', ['p1']], ['error', ['p1', 'p2']]]);
});

test('only failed actions, validation errors and HTTP errors confirm; loops, backtracks and small targets do not', () => {
  const near = (type: EventType, payload: object) => buildCandidates(log(['persona.friction_reported', 'p1', friction(5, 'Stuck')], [type, 'p1', { step_no: 6, url: JOBS, ref: null, ...payload }]), 'poi')[0].trust;
  assert.equal(near('signal.error', { kind: 'http', status: 500, message: 'POST http://gym.test/api/jobs' }), 'confirmed');
  assert.equal(near('signal.validation_error', { message: 'Title is required' }), 'confirmed');
  assert.equal(near('signal.loop', { snapshot_hash: 'h', visits: 3 }), 'reported');
  assert.equal(near('signal.backtrack', { kind: 'revisit' }), 'reported');
  assert.equal(near('signal.small_target', { box: [0, 0, 10, 10] }), 'reported');
});

test('an exception in a step where containment refused a request stays a candidate that confirms nothing', () => {
  const candidates = buildCandidates(log(
    ['containment.blocked_request', 'p1', { host: 'cdn.test', url: 'http://cdn.test/app.js', method: 'GET' }],
    ['persona.step', 'p1', step(1)],
    ['persona.friction_reported', 'p1', friction(1, 'The page broke')],
    ['signal.error', 'p1', { step_no: 1, url: JOBS, ref: 'e1', kind: 'exception', status: null, message: 'x is not defined' }],
  ), 'poi');
  assert.deepEqual(candidates.map((c) => [c.step_no, c.trust, c.text]), [[1, 'reported', 'The page broke'], [1, 'observed', 'Uncaught exception: x is not defined']]);
});

test('a signal seen after its step’s action cites the next step’s screenshot, the one taken after it; none when there is no next step', () => {
  const CHECKOUT = 'http://gym.test/checkout';
  const CONFIRM = 'http://gym.test/checkout/confirm';
  const click = (step_no: number, from: string, to: string) => ({ ...step(step_no), result: { ...step(step_no).result, url_before: from, url_after: to } });
  const events = log(
    ['persona.step', 'p1', click(4, CHECKOUT, CONFIRM)],
    ['signal.error', 'p1', { step_no: 4, url: CONFIRM, ref: 'e1', kind: 'http', status: 500, message: 'POST http://gym.test/api/confirm' }],
    ['persona.step', 'p1', step(5, CONFIRM)],
    ['signal.small_target', 'p1', { step_no: 5, url: CONFIRM, ref: 'e1', box: [0, 0, 10, 10] }],
    ['signal.validation_error', 'p1', { step_no: 5, url: CONFIRM, ref: 'e1', message: 'Card number is required' }],
  );
  assert.deepEqual(buildCandidates(events, 'poi').map((c) => [c.kind, c.url, c.screenshot]), [
    ['error', CONFIRM, 'shots/5.jpg'], // step 4's shows /checkout, before the click
    ['small_target', CONFIRM, 'shots/5.jpg'], // about the tap itself: the page before it
    ['validation_error', CONFIRM, null], // the message appeared after step 5, the last
  ]);
  // The persona's next step is on its next POI: that screenshot shows another product.
  const next = { ...log(['persona.step', 'p1', step(6, 'http://other.test/')])[0], poi_id: 'poi-2', seq: 6 } as GnomiEvent;
  assert.equal(buildCandidates([...events, next], 'poi').at(-1)?.screenshot, null);
});

const save: ActionTarget = { role: 'button', name: 'Save', box: [640, 400, 128, 80] };
// The step's own action, on `target`, seen on a 1280×800 screen.
const shown = (over: Partial<EventPayloads['persona.step']> = {}, target: ActionTarget | null = save, ok = true): EventPayloads['persona.step'] => {
  const base = step(5);
  return { ...base, target, viewport: [0, 0, 1280, 800], result: { ...base.result, ok, error: ok ? null : 'timeout' }, ...over };
};
const onSave = { left: 50, top: 50, width: 10, height: 10, element: 'button "Save"' };
const boxOf = (...entries: Parameters<typeof log>) => buildCandidates(log(...entries), 'poi').map((c) => c.box);

test('a friction that names an element marks it on its step\'s screenshot, in percent of the image', () => {
  assert.deepEqual(boxOf(['persona.step', 'p1', shown({}, null)], ['persona.friction_reported', 'p1', { ...friction(5, 'Save is hidden'), about: save }]), [onSave]);
});

test('an action that failed marks its target, on the failed-action signal and on a friction the step raised without naming anything', () => {
  assert.deepEqual(boxOf(['persona.step', 'p1', shown()], ['signal.failed_action', 'p1', failed(5)]), [onSave]);
  assert.deepEqual(boxOf(['persona.step', 'p1', shown({}, save, false)], ['persona.friction_reported', 'p1', friction(5, 'It timed out')]), [onSave]);
});

test('a friction on a step that went fine says nothing about the step\'s target, so nothing is marked', () => {
  assert.deepEqual(boxOf(['persona.step', 'p1', shown()], ['persona.friction_reported', 'p1', friction(5, 'The page is confusing')]), [undefined]);
});

test('a friction about a different element never marks the target of a failed step', () => {
  const other: ActionTarget = { role: 'link', name: 'Help', box: null };
  assert.deepEqual(boxOf(['persona.step', 'p1', shown({}, save, false)], ['persona.friction_reported', 'p1', { ...friction(5, 'Help is unclear'), about: other }]), [undefined], 'it named one with no box');
  assert.deepEqual(boxOf(['persona.step', 'p1', shown({}, save, false)], ['persona.friction_reported', 'p1', { ...friction(5, 'Help is unclear'), where: { url: JOBS, ref: 'e9' } }]), [undefined], 'it named one the snapshot could not place');
});

test('an element with no box is not marked, nor is any other evidence at the step', () => {
  assert.deepEqual(boxOf(['persona.step', 'p1', shown({}, { ...save, box: null })], ['signal.failed_action', 'p1', failed(5)]), [undefined]);
  assert.deepEqual(boxOf(['persona.step', 'p1', shown()], ['signal.loop', 'p1', { step_no: 5, url: JOBS, ref: 'e1', visits: 3 }]), [undefined]);
  assert.deepEqual(boxOf(['persona.step', 'p1', shown()], ['persona.abandoned', 'p1', { step_no: 5, reason: 'Enough' }]), [undefined]);
});

test('a box outside the screenshot is left out, and one part way off is cut to what shows', () => {
  const at = (box: ActionTarget['box']) => boxOf(['persona.step', 'p1', shown({}, { ...save, box })], ['signal.failed_action', 'p1', failed(5)])[0];
  assert.equal(at([100, 800, 50, 50]), undefined, 'below the fold');
  assert.equal(at([100, -80, 50, 50]), undefined, 'scrolled away above');
  assert.equal(at([1280, 100, 50, 50]), undefined, 'beside the screen');
  assert.equal(at([0, 0, 0, 0]), undefined, 'a closed option, which is nowhere');
  assert.deepEqual(at([1216, 700, 128, 200]), { left: 95, top: 87.5, width: 5, height: 12.5, element: 'button "Save"' });
});

test('a box is measured from where the screenshot starts and over what it spans, not the image\'s own size', () => {
  const panned = shown({ viewport: [600, 0, 400, 600] }, { ...save, box: [800, 300, 40, 60] });
  assert.deepEqual(boxOf(['persona.step', 'p1', panned], ['signal.failed_action', 'p1', failed(5)])[0], { left: 50, top: 50, width: 10, height: 10, element: 'button "Save"' });
});

test('an element in a frame is not marked: its box starts at the frame\'s corner', () => {
  const inFrame = shown({ action: { type: 'click', ref: 'f1e2', text: null } });
  assert.deepEqual(boxOf(['persona.step', 'p1', inFrame], ['signal.failed_action', 'p1', failed(5)]), [undefined]);
  assert.deepEqual(boxOf(['persona.step', 'p1', shown({}, null)], ['persona.friction_reported', 'p1', { ...friction(5, 'Save is hidden'), about: save, where: { url: JOBS, ref: 'f1e2' } }]), [undefined]);
});

test('a signal shown on the next step\'s screenshot is not marked with this step\'s box', () => {
  const [c] = buildCandidates(log(
    ['persona.step', 'p1', shown()],
    ['persona.step', 'p1', { ...shown(), step_no: 6, screenshot: 'shots/6.jpg' }],
    ['signal.validation_error', 'p1', { step_no: 5, url: JOBS, ref: 'e1', message: 'Required' }],
  ), 'poi');
  assert.equal(c.screenshot, 'shots/6.jpg');
  assert.equal(c.box, undefined);
});

test('an old log has no viewport, so it shows the plain screenshot, though its targets and about carry boxes', () => {
  const { viewport: _, ...old } = shown();
  assert.deepEqual(boxOf(['persona.step', 'p1', old], ['signal.failed_action', 'p1', failed(5)]), [undefined]);
  assert.deepEqual(boxOf(['persona.step', 'p1', old], ['persona.friction_reported', 'p1', { ...friction(5, 'Save is hidden'), about: save }]), [undefined]);
});
