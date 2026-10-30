import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { EventPayloads, GnomiEvent } from '@gnomi/simulation/types.ts';
import { recordedCost, unpricedText } from './cost.ts';

const call = (seq: number, cost_usd: number, extra: Partial<EventPayloads['llm.call']> = {}): GnomiEvent => ({
  seq, ts: seq, run_id: 'r-1', round: 1, persona_id: 'p-1', poi_id: null, type: 'llm.call',
  payload: { role: 'navigator', provider: 'anthropic', model: 'test', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd, latency_ms: 1, status: 'ok', error: null, ...extra },
});

test('a model with no price is named, and blocks a start, while every priced estimate gives no reason', () => {
  const estimate = { calls: 1, cost_usd: [0, 0] as [number, number], minutes: [1, 1] as [number, number] };
  assert.equal(unpricedText({ ...estimate, unpriced: [] }), null);
  assert.equal(unpricedText({ ...estimate, unpriced: ['old-judge', 'old-author'] }), 'No price is known for old-judge, old-author.');
});

test('live recorded cost includes retries and partial usage but does not infer missing usage in legacy logs', () => {
  assert.deepEqual(recordedCost([]), { cost_usd: 0, unreported_usage_calls: 0 });
  assert.deepEqual(recordedCost([
    call(1, 0.25, { usage_reported: true }),
    call(2, 0.05, { usage_reported: false, status: 'error', error: 'Canceled' }),
    call(3, 0, { usage_reported: false, status: 'invalid_output' }),
    call(4, 0, { status: 'error', error: 'Old log without usage flag' }),
    { seq: 5, ts: 5, run_id: 'r-1', round: 1, persona_id: null, poi_id: null, type: 'run.finished', payload: {} },
  ]), { cost_usd: 0.3, unreported_usage_calls: 2 });
});
