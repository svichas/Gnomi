import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS } from '../settings.ts';
import { comparisonBlockCost, comparisonCallCost, createComparisonBudget, comparisonBudgetGateway, COMPARISON_CALL_BOUNDS } from './budget.ts';
import { z } from 'zod';

test('matched reservations include every permitted task step and both bounded review passes with retry headroom', () => {
  const cost = comparisonBlockCost(DEFAULT_SETTINGS, 4, 12);
  const navigation = comparisonCallCost(DEFAULT_SETTINGS, 'navigation')!;
  const assessment = comparisonCallCost(DEFAULT_SETTINGS, 'assessment')!;
  const verification = comparisonCallCost(DEFAULT_SETTINGS, 'verification')!;
  assert.equal(cost.navigation, 4 * 12 * navigation);
  assert.equal(cost.total, cost.navigation + 4 * (assessment + verification));
  assert.ok(assessment > verification);
});

test('one block cannot spend another block’s evidence reservation, and completed calls release unused allowance', () => {
  const cost = comparisonBlockCost(DEFAULT_SETTINGS, 1, 1);
  let spent = 0;
  const ledger = createComparisonBudget({ settings: { ...DEFAULT_SETTINGS, cost_budget_usd: cost.total * 2 + 0.001 }, analysisReserve: 0.2, spent: () => spent, navigationSpent: () => 0 });
  assert.equal(ledger.admit('a', 1, 1), true);
  assert.equal(ledger.admit('b', 1, 1), true);
  assert.equal(ledger.admit('c', 1, 1), false);
  const call = ledger.startCall('a', 'navigation', 1000)!;
  spent = 0.0001;
  call.attempt(0.0001, true);
  call.finish();
  assert.ok(ledger.reserved() < cost.total * 2);
  assert.equal(ledger.startCall('missing', 'assessment', 1000), null);
  ledger.finishBlock('a');
  assert.equal(ledger.admit('c', 1, 1), true);
});

test('unknown billed usage stays reserved after the block ends', () => {
  const cost = comparisonBlockCost(DEFAULT_SETTINGS, 1, 1);
  const ledger = createComparisonBudget({ settings: { ...DEFAULT_SETTINGS, cost_budget_usd: cost.total }, analysisReserve: 0.2, spent: () => 0, navigationSpent: () => 0 });
  assert.equal(ledger.admit('a', 1, 1), true);
  const call = ledger.startCall('a', 'assessment', 1000)!;
  call.attempt(0, false);
  call.finish();
  ledger.finishBlock('a');
  assert.equal(ledger.reserved(), comparisonCallCost(DEFAULT_SETTINGS, 'assessment'));
});

test('comparison requests enforce the funded retry count and explicit output cap at the provider boundary', async () => {
  const ledger = createComparisonBudget({ settings: DEFAULT_SETTINGS, analysisReserve: 0.2, spent: () => 0, navigationSpent: () => 0 });
  assert.equal(ledger.admit('a', 1, 1), true);
  let attempts = 0;
  const gateway = comparisonBudgetGateway(ledger, 'a', { async call(req) {
    assert.equal(req.max_output_tokens, COMPARISON_CALL_BOUNDS.navigation.output);
    for (;;) {
      req.signal!.throwIfAborted();
      attempts++;
      req.onAttempt!({ payload: { role: 'navigator', provider: 'scripted', model: 'scripted', status: 'invalid_output', error: 'invalid', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0, latency_ms: 0, usage_reported: true }, transcript: { request: {}, response: {} } });
    }
  } }, () => assert.fail('zero-cost retries cannot overrun the ledger'));
  await assert.rejects(gateway.call({ role: 'navigator', model: DEFAULT_SETTINGS.routing.navigator, run_id: 'test', persona_id: 'a', round: 1, system: 'Collect evidence', user: [], schema: z.object({}) }), /reserved attempts/);
  assert.equal(attempts, 2);
});
