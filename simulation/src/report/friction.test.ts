import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, EventType, GnomiEvent } from '../types.ts';
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

test('an exception in a step where containment refused a request is dropped; an HTTP error there still counts', () => {
  const candidates = buildCandidates(log(
    ['containment.blocked_request', 'p1', { host: 'cdn.test', url: 'http://cdn.test/app.js', method: 'GET' }],
    ['persona.step', 'p1', step(1)],
    ['signal.error', 'p1', { step_no: 1, url: JOBS, ref: 'e1', kind: 'exception', status: null, message: 'x is not defined' }],
    ['signal.error', 'p1', { step_no: 1, url: JOBS, ref: 'e1', kind: 'http', status: 500, message: 'GET http://gym.test/api' }],
    ['persona.step', 'p1', step(2)],
    ['signal.error', 'p1', { step_no: 2, url: JOBS, ref: 'e1', kind: 'exception', status: null, message: 'y is not defined' }],
  ), 'poi');
  assert.deepEqual(candidates.map((c) => [c.step_no, c.text]), [[1, 'HTTP 500: GET http://gym.test/api'], [2, 'Uncaught exception: y is not defined']]);
});
