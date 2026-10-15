import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, germanProbe } from './fixture.ts';
import { assess, createAllowance, executionCriterion, observeAttempt, parseOptions, validateOptions } from './checks.ts';
import type { LlmAttempt } from '../seams.ts';

test('the frozen acceptance fixture is deterministic, has fifty people and a guaranteed German probe', () => {
  const first = fixture('http://localhost:4317');
  assert.deepEqual(fixture('http://localhost:4317'), first);
  assert.equal(first.personas.length, 50);
  assert.equal(new Set(first.personas.map((p) => p.name)).size, 50);
  assert.equal(first.project.settings.concurrency, 12);
  assert.equal(first.project.settings.screenshots, true);
  const probe = germanProbe(first);
  assert.equal(probe.personas.length, 1);
  assert.equal(probe.personas[0].languages?.[0], 'de-DE');
  assert.equal(probe.personas[0].timezone, 'Europe/Berlin');
  assert.match(probe.project.poi.start_url, /\/locale$/);
});

test('live execution requires a finite positive allowance and a credential before any browser starts', () => {
  assert.equal(parseOptions([]).mode, 'scripted');
  const options = parseOptions(['--live', '--out', '/tmp/example', '--allowance-usd', '6']);
  assert.equal(options.allowance_usd, 6);
  assert.doesNotThrow(() => validateOptions(options, { ANTHROPIC_API_KEY: 'fixture-key' }));
  assert.throws(() => validateOptions({ ...options, allowance_usd: undefined }, {}), /allowance/);
  assert.throws(() => validateOptions(options, {}), /ANTHROPIC_API_KEY/);
  assert.throws(() => parseOptions(['--live', '--allowance-usd', 'Infinity']), /allowance/);
  assert.throws(() => parseOptions(['--allowance-usd', '0']), /allowance/);
});

test('scripted measurements cannot pass live acceptance and missing usage prevents a cost pass', () => {
  const facts = { population: 50, terminal: 50, goal_completed: 20, blocked: 0, run_status: 'finished', duration_ms: 1000, cost_usd: 1, unknown_usage: 0, peak_contexts: 12, replay_equal: true };
  const scripted = assess('scripted', facts);
  assert.ok(scripted.filter((c) => c.live_required).every((c) => c.status === 'NOT_RUN'));
  const live = assess('live', facts);
  assert.equal(live.find((c) => c.id === 'recorded_cost')?.status, 'PASS');
  assert.equal(assess('live', { ...facts, unknown_usage: 1 }).find((c) => c.id === 'recorded_cost')?.status, 'REVIEW_NEEDED');
  assert.equal(assess('live', { ...facts, duration_ms: 30 * 60_000 }).find((c) => c.id === 'duration')?.status, 'FAIL');
  assert.equal(assess('live', { ...facts, terminal: 49 }).find((c) => c.id === 'population')?.status, 'FAIL');
  assert.equal(assess('live', { ...facts, peak_contexts: 1 }).find((c) => c.id === 'concurrency')?.status, 'FAIL');
  assert.equal(assess('live', { ...facts, cost_usd: 5, unknown_usage: 1 }).find((c) => c.id === 'recorded_cost')?.status, 'FAIL');
  const stopped = assess('scripted', { ...facts, terminal: 0, run_status: 'stopped' });
  assert.equal(stopped.find((c) => c.id === 'execution')?.status, 'FAIL');
  assert.equal(stopped.find((c) => c.id === 'population')?.status, 'NOT_RUN');
  assert.equal(executionCriterion({ ...facts, population: 1, terminal: 1, run_status: 'stopped' }, 1).status, 'FAIL', 'a locale echo before a later run failure is insufficient');
  assert.equal(executionCriterion({ ...facts, population: 1, terminal: 1 }, 1).status, 'PASS');
});

const attempt = (cost_usd: number, usage_reported = true) => ({ payload: { cost_usd, usage_reported }, transcript: { request: {}, response: {} } }) as LlmAttempt;
test('the shared allowance cancels at recorded spend and stops on missing usage without claiming a bill cap', () => {
  const allowance = createAllowance(1);
  allowance.observe(attempt(0.6));
  assert.equal(allowance.signal.aborted, false);
  allowance.observe(attempt(0.4));
  assert.equal(allowance.signal.aborted, true);
  allowance.observe(attempt(0.3)); // an already-dispatched response still contributes
  assert.equal(allowance.spent(), 1.3);
  assert.throws(() => allowance.check(), /recorded-spend allowance/);
  const unknown = createAllowance(1);
  unknown.observe(attempt(0, false));
  assert.equal(unknown.unknown(), 1);
  assert.equal(unknown.signal.aborted, true);
});

test('run attempt callbacks precede shared allowance cancellation, and callback failure retains cost and evidence', () => {
  const allowance = createAllowance(1);
  const order: string[] = [];
  allowance.signal.addEventListener('abort', () => order.push('allowance cancelled'));
  observeAttempt(attempt(1), () => order.push('engine budget observer'), allowance, () => order.push('evidence'));
  assert.deepEqual(order, ['engine budget observer', 'allowance cancelled', 'evidence']);

  const failed = createAllowance(1);
  const evidence: LlmAttempt[] = [];
  assert.throws(() => observeAttempt(attempt(0.5), () => { throw new Error('observer failed'); }, failed, (value) => evidence.push(value)), /observer failed/);
  assert.equal(failed.spent(), 0.5);
  assert.equal(evidence.length, 1);
});
