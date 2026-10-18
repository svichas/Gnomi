import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROVIDER_DEFAULTS } from '../settings.ts';
import type { ModelChoice } from '../types.ts';
import { costUsd, isPriced } from './prices.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
const usage = (input_tokens: number, output_tokens: number, cache_read_tokens = 0, cache_write_tokens = 0) => ({
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
});
const anthropic = (model: string): ModelChoice => ({ provider: 'anthropic', model });
const google = (model: string): ModelChoice => ({ provider: 'google', model });
const haiku = anthropic('claude-haiku-5-5');

test('Haiku 5.5 step costs match hand-computed numbers', () => {
  // 5,000 × $0.10 + 200 × $0.50, per million
  close(costUsd(haiku, usage(5_000, 200)), 0.0006);
  // 1,200 × $0.10 + 180 × $0.50 + 3,800 cache reads × $0.01
  close(costUsd(haiku, usage(1_200, 180, 3_800)), 0.000248);
  // the first step writes the prefix at 1.25 × input: 3,800 × $0.125
  close(costUsd(haiku, usage(1_200, 180, 0, 3_800)), 0.000685);
});

test('Haiku 5.5 bills the whole call at the long-context card once the prompt passes 100k tokens', () => {
  close(costUsd(haiku, usage(80_000, 1_000, 20_000)), 0.0087); // exactly 100k: 8,000 + 500 + 200
  close(costUsd(haiku, usage(90_000, 1_000, 20_000)), 0.0485); // 110k: 45,000 + 2,500 + 1,000
});

test('other models price at their own cards', () => {
  close(costUsd(anthropic('claude-opus-5-5'), usage(1_000_000, 100_000, 1_000_000, 1_000_000)), 4 + 2 + 0.2 + 5);
  close(costUsd(anthropic('claude-sonnet-5-5'), usage(10_000, 1_000)), 0.03);
  close(costUsd(anthropic('claude-sonnet-5-5'), usage(0, 0, 1_000_000)), 0.2); // 0.1 × the input price, per the claude-api skill
  close(costUsd({ provider: 'openai', model: 'gpt-6-luna' }, usage(600, 200, 400)), 0.000164); // 60 + 100 + 4, per million
  close(costUsd({ provider: 'openai', model: 'gpt-5.4-mini' }, usage(1_000_000, 1_000_000)), 0.75 + 4.5);
  // DeepSeek at its peak card: a cache miss is plain input, a hit far cheaper.
  close(costUsd({ provider: 'deepseek', model: 'deepseek-flash' }, usage(600, 200, 400)), 0.0004224); // 180 + 240 + 2.4, per million
  close(costUsd({ provider: 'deepseek', model: 'deepseek-v4-pro' }, usage(1_000_000, 1_000_000, 1_000_000)), 1.32 + 3.96 + 0.044);
});

test('Gemini prices rise on the announced dates', () => {
  const argon = google('gemini-4-argon');
  const flash = google('gemini-3.8-flash');
  const million = usage(1_000_000, 1_000_000, 1_000_000);
  close(costUsd(argon, million, new Date('2026-10-15T00:00:00Z')), 2 + 10 + 0.2);
  close(costUsd(argon, million, new Date('2026-11-30T23:59:59Z')), 2 + 10 + 0.2);
  close(costUsd(argon, million, new Date('2026-12-01T00:00:00Z')), 4 + 20 + 0.4);
  close(costUsd(flash, million, new Date('2026-12-31T23:59:59Z')), 0.75 + 3.75 + 0.075);
  close(costUsd(flash, million, new Date('2027-01-01T00:00:00Z')), 1.5 + 7.5 + 0.15);
  close(costUsd(google('gemini-3.5-flash-lite'), million, new Date('2027-06-01')), 0.3 + 2.5 + 0.03); // no rise announced
  close(costUsd(argon, million, new Date('2026-01-01')), 2 + 10 + 0.2); // before the first card: the first card
});

test('a local model costs nothing, and an unknown cloud model is refused', () => {
  assert.equal(costUsd({ provider: 'openai_compatible', model: 'gemma4:e4b' }, usage(1_000_000, 1_000_000)), 0);
  assert.equal(isPriced({ provider: 'openai_compatible', model: 'anything' }), true);
  assert.equal(isPriced(haiku), true);
  assert.equal(isPriced({ provider: 'openai', model: 'claude-haiku-5-5' }), false, 'a card belongs to its provider');
  assert.throws(() => costUsd(anthropic('claude-unknown-9'), usage(1, 1)), /No price for model claude-unknown-9 \(anthropic\)/);
});

test('every model in every default routing has a price, or a run on it would be refused', () => {
  for (const routing of Object.values(PROVIDER_DEFAULTS))
    for (const choice of Object.values(routing)) assert.ok(isPriced(choice), `${choice.provider}/${choice.model} has no price`);
});

test('the reference run of tech.md §10.4 prices to the totals printed there, with no cache', () => {
  // 50 personas: 2,000 steps (5k in, 0.2k out) and 300 social calls (3k in, 0.2k out) on the cheap model, 50 surveys
  // (2k in, 0.5k out) on the judge, 10 report calls (30k in, 3k out) on the author. Priced a call at a time, as billed.
  const at = new Date('2026-10-15');
  const run = (cheap: ModelChoice, judge: ModelChoice, author: ModelChoice) =>
    2000 * costUsd(cheap, usage(5_000, 200), at) + 300 * costUsd(cheap, usage(3_000, 200), at) + 50 * costUsd(judge, usage(2_000, 500), at) + 10 * costUsd(author, usage(30_000, 3_000), at);
  const openai = (model: string): ModelChoice => ({ provider: 'openai', model });
  assert.ok(Math.abs(run(haiku, anthropic('claude-sonnet-5-5'), anthropic('claude-opus-5-5')) - 3.57) < 0.005);
  assert.ok(Math.abs(run(openai('gpt-6-luna'), openai('gpt-5.4-mini'), openai('gpt-6-astra')) - 6.01) < 0.005);
  assert.ok(Math.abs(run(google('gemini-3.5-flash-lite'), google('gemini-3.8-flash'), google('gemini-4-argon')) - 5.49) < 0.005);
  // The DeepSeek rows at peak prices: tech.md prints $4.56 and $2.06 for what comes to $4.568 and $2.066.
  const deepseek = (model: string): ModelChoice => ({ provider: 'deepseek', model });
  assert.ok(Math.abs(run(deepseek('deepseek-flash'), deepseek('deepseek-v4-pro'), deepseek('deepseek-v4-pro')) - 4.56) < 0.01);
  assert.ok(Math.abs(run(haiku, deepseek('deepseek-v4-pro'), deepseek('deepseek-v4-pro')) - 2.06) < 0.01);
});
