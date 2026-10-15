import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costUsd } from './prices.ts';

const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);
const usage = (input_tokens: number, output_tokens: number, cache_read_tokens = 0, cache_write_tokens = 0) => ({
  input_tokens,
  output_tokens,
  cache_read_tokens,
  cache_write_tokens,
});

test('Haiku 5.5 step costs match hand-computed numbers', () => {
  // 5,000 × $0.10 + 200 × $0.50, per million
  close(costUsd('claude-haiku-5-5', usage(5_000, 200)), 0.0006);
  // 1,200 × $0.10 + 180 × $0.50 + 3,800 cache reads × $0.01
  close(costUsd('claude-haiku-5-5', usage(1_200, 180, 3_800)), 0.000248);
  // the first step writes the prefix at 1.25 × input: 3,800 × $0.125
  close(costUsd('claude-haiku-5-5', usage(1_200, 180, 0, 3_800)), 0.000685);
});

test('Haiku 5.5 bills the whole call at the long-context card once the prompt passes 100k tokens', () => {
  close(costUsd('claude-haiku-5-5', usage(80_000, 1_000, 20_000)), 0.0087); // exactly 100k: 8,000 + 500 + 200
  close(costUsd('claude-haiku-5-5', usage(90_000, 1_000, 20_000)), 0.0485); // 110k: 45,000 + 2,500 + 1,000
});

test('other Claude models price at their own cards, and unknown models are refused', () => {
  close(costUsd('claude-opus-5-5', usage(1_000_000, 100_000, 1_000_000, 1_000_000)), 4 + 2 + 0.2 + 5);
  close(costUsd('claude-sonnet-5-5', usage(10_000, 1_000)), 0.03);
  assert.throws(() => costUsd('claude-unknown-9', usage(1, 1)), /No price for model claude-unknown-9/);
});
