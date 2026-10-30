import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BUILTIN_PERSONA } from '../persona.ts';
import { DEFAULT_SETTINGS } from '../settings.ts';
import type { Audience, ModelChoice, Persona, RunSettings } from '../types.ts';
import { DIGEST_OUTPUT_TOKENS, estimateDigest, estimateReport, estimateRun } from './estimate.ts';
import { draftComparison } from '../comparison/config.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const persona = (patience: number): Persona => ({ ...BUILTIN_PERSONA, patience });
// The report's judge (Sonnet 5.5, $2/$10) and author (Opus 5.5, $4/$20) calls on the default routing, uncached:
//   low:  judge 2,000 in + 1,000 out = $0.014; author 2,000 in + 2,000 out = $0.048
//   high: judge 30,000 in + 4,000 out = $0.10; author 20,000 in + 8,000 out = $0.24
const REPORT = { calls: 2, cost: [0.014 + 0.048, 0.1 + 0.24], minutes: [0.2, 1] } as const;
const withNavigator = (navigator: ModelChoice, rest: Partial<RunSettings> = {}): RunSettings => ({ ...DEFAULT_SETTINGS, ...rest, routing: { ...DEFAULT_SETTINGS.routing, navigator } });

test('a digest is one call, priced at two attempts at the output limit for its ceiling', () => {
  // Sonnet 5.5 at $2/$10. Low: 2,000 in + 200 out. High: 2 × (3,000 in + 2,048 out).
  const estimate = estimateDigest({ bytes: 4_000, model: { provider: 'anthropic', model: 'claude-sonnet-5-5' } });
  assert.equal(DIGEST_OUTPUT_TOKENS, 2_048);
  assert.equal(estimate.calls, 1);
  close(estimate.cost_usd[0], 0.006);
  close(estimate.cost_usd[1], 0.05296);
  assert.deepEqual(estimateDigest({ bytes: 4_000, model: { provider: 'openai', model: 'gpt-9-mystery' } }).unpriced, ['gpt-9-mystery']);
  assert.deepEqual(estimateDigest({ bytes: 4_000, model: { provider: 'openai_compatible', model: 'local' } }).cost_usd, [0, 0]);
});

test('comparison verifier estimate prices the selected route without changing navigation or assessment calls', () => {
  const comparison = draftComparison({ name: 'Tools', description: '', goal: 'Evaluate plans', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: ['a', 'b'].map((id) => ({ id, name: id, type: 'text', asset: `${id}.md`, segments: null })) });
  const estimate = () => estimateRun({ personas: [persona(1)], settings: DEFAULT_SETTINGS, comparison });
  const original = estimate();
  comparison.execution.verifier = 'judge';
  assert.deepEqual(estimate(), original);
  comparison.execution.verifier = 'navigator';
  const cheaper = estimate();
  assert.equal(cheaper.calls, original.calls);
  assert.deepEqual(cheaper.minutes, original.minutes);
  close(original.cost_usd[0] - cheaper.cost_usd[0], 2 * (0.018 - 0.0009));
  close(original.cost_usd[1] - cheaper.cost_usd[1], 2 * (0.18 - 0.009));
});

test('comparison estimate follows shared tasks, includes both judges, and excludes legacy social and author calls', () => {
  const comparison = draftComparison({ name: 'Tools', description: '', goal: 'Evaluate plans', role: null, audience: null, settings: DEFAULT_SETTINGS,
    pois: ['a', 'b'].map((id) => ({ id, name: id, type: 'text', asset: `${id}.md`, segments: null })) });
  comparison.tasks[0]!.max_steps = 10;
  const settings = { ...DEFAULT_SETTINGS, social: true, routing: { ...DEFAULT_SETTINGS.routing, author: { provider: 'openai' as const, model: 'unpriced-unused-author' }, socialiser: { provider: 'openai' as const, model: 'unpriced-unused-social' } } };
  const estimate = estimateRun({ personas: [persona(1)], settings, comparison });
  assert.equal(estimate.calls, 14 + 4, 'two ten-step episodes at midpoint plus four judge calls');
  assert.deepEqual(estimate.unpriced, []);
  const pois = ['a', 'b'].map((id) => ({ id, name: id, type: 'text' as const, asset: `${id}.md`, segments: id === 'a' ? [] : null }));
  assert.equal(estimateRun({ personas: [persona(1)], settings, comparison, pois }).calls, 7 + 2, 'an explicitly excluded source does not add navigation or judging calls');
  comparison.scenarios[0]!.segment_ids = ['other-segment'];
  assert.equal(estimateRun({ personas: [persona(1)], settings, comparison }).calls, 0, 'ineligible tasks do not inflate the estimate');
});

test('three personas on Haiku with screenshots match the hand-computed range', () => {
  // Step budgets 12 + 30 + 60 = 102: between 40% (40.8 steps) and all of it, so 71.4 expected calls.
  // A step is 5,000 + 1,200 tokens in and 200 out. Priced per call:
  //   no cache:       6,200 × $0.10 + 200 × $0.50 = $0.00072
  //   half cached:    3,100 written × $0.125 + 3,100 read × $0.01 + 200 × $0.50 = $0.0005185
  // Each persona also answers one uncached survey: 2,300 × $0.10 + 700 × $0.50 = $0.00058, timed like a step.
  // Only three personas can run at once: 43.8 calls × 2 s ÷ 3 and 105 calls × 6 s ÷ 3, plus half a minute.
  const estimate = estimateRun({ personas: [persona(1), persona(3), persona(5)], settings: DEFAULT_SETTINGS });
  assert.equal(estimate.calls, 71 + 3 + REPORT.calls);
  close(estimate.cost_usd[0], 40.8 * 0.0005185 + 3 * 0.00058 + REPORT.cost[0]);
  close(estimate.cost_usd[1], 102 * 0.00072 + 3 * 0.00058 + REPORT.cost[1]);
  close(estimate.minutes[0], (43.8 * 2) / 3 / 60 + 0.5 + REPORT.minutes[0]);
  close(estimate.minutes[1], (105 * 6) / 3 / 60 + 0.5 + REPORT.minutes[1]);
  assert.deepEqual(estimate.unpriced, []);
});

test('fifty personas of ordinary patience, without screenshots, at the default concurrency', () => {
  // 50 × 30 = 1,500 steps, 600 to 1,500 of them; 5,000 tokens in: $0.0006 uncached, $0.0004375 half cached.
  const estimate = estimateRun({ personas: Array.from({ length: 50 }, () => persona(3)), settings: withNavigator(DEFAULT_SETTINGS.routing.navigator, { screenshots: false }) });
  assert.equal(estimate.calls, 1050 + 50 + REPORT.calls);
  close(estimate.cost_usd[0], 600 * 0.0004375 + 50 * 0.00058 + REPORT.cost[0]);
  close(estimate.cost_usd[1], 1500 * 0.0006 + 50 * 0.00058 + REPORT.cost[1]);
  close(estimate.minutes[0], (650 * 2) / 12 / 60 + 0.5 + REPORT.minutes[0]);
  close(estimate.minutes[1], (1550 * 6) / 12 / 60 + 0.5 + REPORT.minutes[1]);
});

test('the price in effect on the given date is used', () => {
  const argon = withNavigator({ provider: 'google', model: 'gemini-4-argon' }, { screenshots: false });
  const high = (at: string) => estimateRun({ personas: [persona(3)], settings: argon, at: new Date(at) }).cost_usd[1];
  close(high('2026-11-30T12:00:00Z'), 30 * ((5_000 * 2 + 200 * 10) / 1e6) + (2_300 * 2 + 700 * 10) / 1e6 + REPORT.cost[1]);
  close(high('2026-12-01T12:00:00Z'), 30 * ((5_000 * 4 + 200 * 20) / 1e6) + (2_300 * 4 + 700 * 20) / 1e6 + REPORT.cost[1]);
});

test('an unpriced navigator is listed and leaves the cost at its floor, and a local one is free', () => {
  const unpriced = estimateRun({ personas: [persona(3)], settings: withNavigator({ provider: 'openai', model: 'gpt-9-mystery' }) });
  assert.deepEqual(unpriced.unpriced, ['gpt-9-mystery']);
  assert.deepEqual(unpriced.cost_usd, REPORT.cost);
  assert.equal(unpriced.calls, 21 + 1 + REPORT.calls, 'the survey is a call even when unpriced');
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

test('the finding check adds its calls when on, priced on check_model when one is set', () => {
  const on = { ...DEFAULT_SETTINGS, finding_check: true };
  const report = estimateReport({ personas: [persona(3)], settings: on, pois: 2 });
  assert.equal(report.calls, 2 * (REPORT.calls + 3));
  assert.ok(report.cost_usd[0] > 2 * REPORT.cost[0] && report.cost_usd[1] > 2 * REPORT.cost[1]);
  assert.deepEqual(estimateReport({ personas: [persona(3)], settings: { ...DEFAULT_SETTINGS, finding_check: false } }).calls, REPORT.calls);
  const odd = estimateReport({ personas: [persona(3)], settings: { ...on, check_model: { provider: 'openai', model: 'gpt-9-mystery' } } });
  assert.deepEqual(odd.unpriced, ['gpt-9-mystery']);
  close(odd.cost_usd[1], REPORT.cost[1]);
});

test('no personas, no estimate', () => {
  assert.deepEqual(estimateRun({ personas: [], settings: DEFAULT_SETTINGS }), { calls: 0, cost_usd: [0, 0], minutes: [0, 0], unpriced: [] });
});

test('social rounds add one socialiser call per persona and round, only for a run with an audience', () => {
  const audience: Audience = { seed: 1, persona_count: 2, segments: [], company_size: [50, 2000], languages: { en: 1 }, accessibility: { none: 1, low_vision: 0, colour_blind: 0, screen_reader: 0, motor: 0 } };
  const people = [persona(3), persona(3)];
  const social = { ...DEFAULT_SETTINGS, social: true, rounds: 5 };
  const base = estimateRun({ personas: people, settings: { ...social, social: false }, audience });
  // 2 personas × 5 rounds on Haiku at 3,000 in / 200 out: $0.0004 uncached; half cached 1,500 × $0.125 + 1,500 × $0.01 + 200 × $0.50 = $0.0003025.
  // They are timed like steps, two personas at a time: 10 × 2 s ÷ 2 and 10 × 6 s ÷ 2.
  const estimate = estimateRun({ personas: people, settings: social, audience });
  assert.equal(estimate.calls, base.calls + 10);
  close(estimate.cost_usd[0], base.cost_usd[0] + 10 * 0.0003025);
  close(estimate.cost_usd[1], base.cost_usd[1] + 10 * 0.0004);
  close(estimate.minutes[0], base.minutes[0] + (10 * 2) / 2 / 60);
  close(estimate.minutes[1], base.minutes[1] + (10 * 6) / 2 / 60);
  assert.deepEqual(estimateRun({ personas: people, settings: social }), base, 'the built-in persona has nobody to talk to');
  assert.deepEqual(estimateRun({ personas: people, settings: { ...social, social: false }, audience }), base);
  const mystery = estimateRun({ personas: people, settings: { ...social, routing: { ...social.routing, socialiser: { provider: 'openai', model: 'gpt-9-mystery' } } }, audience });
  assert.deepEqual([mystery.calls, mystery.cost_usd, mystery.unpriced], [base.calls + 10, base.cost_usd, ['gpt-9-mystery']]);
});
