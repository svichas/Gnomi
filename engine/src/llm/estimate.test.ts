import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { ModelChoice, Persona, RunSettings } from '../types.ts';
import { estimateReport, estimateRun } from './estimate.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const persona = (patience: number): Persona => ({ ...BUILTIN_PERSONA, patience });
// The report's judge (Sonnet 5.5, $2/$10) and author (Opus 5.5, $4/$20) calls on the default routing, uncached:
//   low:  judge 2,000 in + 1,000 out = $0.014; author 2,000 in + 2,000 out = $0.048
//   high: judge 30,000 in + 4,000 out = $0.10; author 20,000 in + 8,000 out = $0.24
const REPORT = { calls: 2, cost: [0.014 + 0.048, 0.1 + 0.24], minutes: [0.2, 1] } as const;
const withNavigator = (navigator: ModelChoice, rest: Partial<RunSettings> = {}): RunSettings => ({ ...DEFAULT_SETTINGS, ...rest, routing: { ...DEFAULT_SETTINGS.routing, navigator } });

test('three personas on Haiku with screenshots match the hand-computed range', () => {
  // Step budgets 12 + 30 + 60 = 102: between 40% (40.8 steps) and all of it, so 71.4 expected calls.
  // A step is 5,000 + 1,200 tokens in and 200 out. Priced per call:
  //   no cache:       6,200 × $0.10 + 200 × $0.50 = $0.00072
  //   half cached:    3,100 written × $0.125 + 3,100 read × $0.01 + 200 × $0.50 = $0.0005185
  // Only three personas can run at once: 40.8 steps × 2 s ÷ 3 and 102 steps × 6 s ÷ 3, plus half a minute.
  const estimate = estimateRun({ personas: [persona(1), persona(3), persona(5)], settings: DEFAULT_SETTINGS });
  assert.equal(estimate.calls, 71 + REPORT.calls);
  close(estimate.cost_usd[0], 40.8 * 0.0005185 + REPORT.cost[0]);
  close(estimate.cost_usd[1], 102 * 0.00072 + REPORT.cost[1]);
  close(estimate.minutes[0], (40.8 * 2) / 3 / 60 + 0.5 + REPORT.minutes[0]);
  close(estimate.minutes[1], (102 * 6) / 3 / 60 + 0.5 + REPORT.minutes[1]);
  assert.deepEqual(estimate.unpriced, []);
});

test('fifty personas of ordinary patience, without screenshots, at the default concurrency', () => {
  // 50 × 30 = 1,500 steps, 600 to 1,500 of them; 5,000 tokens in: $0.0006 uncached, $0.0004375 half cached.
  const estimate = estimateRun({ personas: Array.from({ length: 50 }, () => persona(3)), settings: withNavigator(DEFAULT_SETTINGS.routing.navigator, { screenshots: false }) });
  assert.equal(estimate.calls, 1050 + REPORT.calls);
  close(estimate.cost_usd[0], 600 * 0.0004375 + REPORT.cost[0]);
  close(estimate.cost_usd[1], 1500 * 0.0006 + REPORT.cost[1]);
  close(estimate.minutes[0], (600 * 2) / 12 / 60 + 0.5 + REPORT.minutes[0]);
  close(estimate.minutes[1], (1500 * 6) / 12 / 60 + 0.5 + REPORT.minutes[1]);
});

test('the price in effect on the given date is used', () => {
  const argon = withNavigator({ provider: 'google', model: 'gemini-4-argon' }, { screenshots: false });
  const high = (at: string) => estimateRun({ personas: [persona(3)], settings: argon, at: new Date(at) }).cost_usd[1];
  close(high('2026-11-30T12:00:00Z'), 30 * ((5_000 * 2 + 200 * 10) / 1e6) + REPORT.cost[1]);
  close(high('2026-12-01T12:00:00Z'), 30 * ((5_000 * 4 + 200 * 20) / 1e6) + REPORT.cost[1]);
});

test('an unpriced navigator is listed and leaves the cost at its floor, and a local one is free', () => {
  const unpriced = estimateRun({ personas: [persona(3)], settings: withNavigator({ provider: 'openai', model: 'gpt-9-mystery' }) });
  assert.deepEqual(unpriced.unpriced, ['gpt-9-mystery']);
  assert.deepEqual(unpriced.cost_usd, REPORT.cost);
  assert.equal(unpriced.calls, 21 + REPORT.calls);
  const local = estimateRun({ personas: [persona(3)], settings: withNavigator({ provider: 'openai_compatible', model: 'gemma4:e4b' }) });
  assert.deepEqual([local.unpriced, local.cost_usd], [[], REPORT.cost]);
});

test('the report adds one judge and one author call, priced on their own routing', () => {
  const report = estimateReport({ personas: [persona(3)], settings: DEFAULT_SETTINGS });
  assert.equal(report.calls, REPORT.calls);
  close(report.cost_usd[0], REPORT.cost[0]);
  close(report.cost_usd[1], REPORT.cost[1]);
  assert.deepEqual([report.minutes, report.unpriced], [REPORT.minutes, []]);
  const routing = { ...DEFAULT_SETTINGS.routing, judge: { provider: 'openai', model: 'gpt-9-mystery' }, author: { provider: 'openai_compatible', model: 'qwen3:30b' } } as const;
  const odd = estimateReport({ personas: [persona(3)], settings: { ...DEFAULT_SETTINGS, routing } });
  assert.deepEqual([odd.cost_usd, odd.unpriced], [[0, 0], ['gpt-9-mystery']]);
});

test('no personas, no estimate', () => {
  assert.deepEqual(estimateRun({ personas: [], settings: DEFAULT_SETTINGS }), { calls: 0, cost_usd: [0, 0], minutes: [0, 0], unpriced: [] });
});
