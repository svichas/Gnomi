import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { ModelChoice, Persona, RunSettings } from '../types.ts';
import { estimateRun } from './estimate.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const persona = (patience: number): Persona => ({ ...BUILTIN_PERSONA, patience });
const withNavigator = (navigator: ModelChoice, rest: Partial<RunSettings> = {}): RunSettings => ({ ...DEFAULT_SETTINGS, ...rest, routing: { ...DEFAULT_SETTINGS.routing, navigator } });

test('three personas on Haiku with screenshots match the hand-computed range', () => {
  // Step budgets 12 + 30 + 60 = 102: between 40% (40.8 steps) and all of it, so 71.4 expected calls.
  // A step is 5,000 + 1,200 tokens in and 200 out. Priced per call:
  //   no cache:       6,200 × $0.10 + 200 × $0.50 = $0.00072
  //   half cached:    3,100 written × $0.125 + 3,100 read × $0.01 + 200 × $0.50 = $0.0005185
  // Only three personas can run at once: 40.8 steps × 2 s ÷ 3 and 102 steps × 6 s ÷ 3, plus half a minute.
  const estimate = estimateRun({ personas: [persona(1), persona(3), persona(5)], settings: DEFAULT_SETTINGS });
  assert.equal(estimate.calls, 71);
  close(estimate.cost_usd[0], 40.8 * 0.0005185);
  close(estimate.cost_usd[1], 102 * 0.00072);
  close(estimate.minutes[0], (40.8 * 2) / 3 / 60 + 0.5);
  close(estimate.minutes[1], (102 * 6) / 3 / 60 + 0.5);
  assert.deepEqual(estimate.unpriced, []);
});

test('fifty personas of ordinary patience, without screenshots, at the default concurrency', () => {
  // 50 × 30 = 1,500 steps, 600 to 1,500 of them; 5,000 tokens in: $0.0006 uncached, $0.0004375 half cached.
  const estimate = estimateRun({ personas: Array.from({ length: 50 }, () => persona(3)), settings: withNavigator(DEFAULT_SETTINGS.routing.navigator, { screenshots: false }) });
  assert.equal(estimate.calls, 1050);
  close(estimate.cost_usd[0], 600 * 0.0004375);
  close(estimate.cost_usd[1], 1500 * 0.0006);
  close(estimate.minutes[0], (600 * 2) / 12 / 60 + 0.5);
  close(estimate.minutes[1], (1500 * 6) / 12 / 60 + 0.5);
});

test('the price in effect on the given date is used', () => {
  const argon = withNavigator({ provider: 'google', model: 'gemini-4-argon' }, { screenshots: false });
  const high = (at: string) => estimateRun({ personas: [persona(3)], settings: argon, at: new Date(at) }).cost_usd[1];
  close(high('2026-11-30T12:00:00Z'), 30 * ((5_000 * 2 + 200 * 10) / 1e6));
  close(high('2026-12-01T12:00:00Z'), 30 * ((5_000 * 4 + 200 * 20) / 1e6));
});

test('an unpriced navigator is listed and leaves the cost at its floor, and a local one is free', () => {
  const unpriced = estimateRun({ personas: [persona(3)], settings: withNavigator({ provider: 'openai', model: 'gpt-9-mystery' }) });
  assert.deepEqual(unpriced.unpriced, ['gpt-9-mystery']);
  assert.deepEqual(unpriced.cost_usd, [0, 0]);
  assert.equal(unpriced.calls, 21);
  const local = estimateRun({ personas: [persona(3)], settings: withNavigator({ provider: 'openai_compatible', model: 'gemma4:e4b' }) });
  assert.deepEqual([local.unpriced, local.cost_usd], [[], [0, 0]]);
});

test('no personas, no estimate', () => {
  assert.deepEqual(estimateRun({ personas: [], settings: DEFAULT_SETTINGS }), { calls: 0, cost_usd: [0, 0], minutes: [0, 0], unpriced: [] });
});
