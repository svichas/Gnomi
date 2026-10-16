// Exercise the real provider adapter against HTTP stubs: no network, key, or model cost.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { z } from 'zod';
import type { LlmAttempt, LlmRequest } from '../seams.ts';
import type { LlmRole } from '../types.ts';
import { createGateway } from './gateway.ts';

const schema = z.object({ name: z.string() });
const request = (over: Partial<LlmRequest<z.infer<typeof schema>>> = {}): LlmRequest<z.infer<typeof schema>> => ({
  role: 'persona_writer',
  model: { provider: 'deepseek', model: 'deepseek-v4-pro' },
  run_id: null,
  persona_id: 'p-001',
  round: 0,
  system: 'Write a realistic persona.',
  user: [{ type: 'text', text: 'Give this persona a name.' }],
  schema,
  ...over,
});

function setup(over: Partial<Parameters<typeof createGateway>[0]> = {}) {
  return createGateway({
    secrets: { get: () => 'sk-test-deepseek-persona-key-0123456789' },
    localBaseUrl: null,
    record: () => { throw new Error('Setup calls must use their attempt observer, not the run ledger.'); },
    ...over,
  });
}

function stubCompletion(reasoningTokens?: number) {
  const bodies: Array<Record<string, any>> = [];
  mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return Response.json({
      id: 'persona-completion',
      object: 'chat.completion',
      created: 1,
      model: 'deepseek-v4-pro',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"name":"Priya"}' }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 80,
        total_tokens: 200,
        ...(reasoningTokens === undefined ? {} : { completion_tokens_details: { reasoning_tokens: reasoningTokens } }),
      },
    });
  });
  return bodies;
}

afterEach(() => mock.restoreAll());

test('DeepSeek persona writing explicitly disables thinking instead of inheriting the high provider default', async () => {
  const bodies = stubCompletion();
  const result = await setup().call(request());

  assert.equal(result.object.name, 'Priya');
  assert.equal(bodies.length, 1);
  assert.ok(
    bodies[0].thinking?.type === 'disabled' || bodies[0].reasoning_effort === 'none',
    'The outgoing DeepSeek request must explicitly turn thinking off for persona writing.',
  );
});

test('a persona request can bound generated tokens for its current writing stage', async () => {
  const bodies = stubCompletion();
  await setup().call(request({ max_output_tokens: 1536 }));

  assert.equal(bodies[0].max_tokens, 1536);
});

test('an explicit high-effort override enables thinking for a persona request', async () => {
  const bodies = stubCompletion();
  await setup().call(request({ effort: 'high' }));

  assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
  assert.equal(bodies[0].reasoning_effort, 'high');
});

test('routine DeepSeek roles disable thinking while the report author reserves room for high effort', async () => {
  const bodies = stubCompletion();
  const gateway = setup();
  const cases: Array<[LlmRole, 'disabled' | 'enabled', 'high' | undefined, number]> = [
    ['navigator', 'disabled', undefined, 4096],
    ['socialiser', 'disabled', undefined, 4096],
    ['judge', 'disabled', undefined, 4096],
    ['author', 'enabled', 'high', 16_384],
  ];

  for (const [role] of cases) await gateway.call(request({ role }));

  for (const [index, [role, thinking, effort, tokens]] of cases.entries()) {
    assert.deepEqual(bodies[index].thinking, { type: thinking }, `${role} must explicitly set its thinking mode.`);
    assert.equal(bodies[index].reasoning_effort, effort, `${role} must not inherit DeepSeek's effort default.`);
    assert.equal(bodies[index].max_tokens, tokens, `${role} must reserve room for its answer and reasoning.`);
  }
});

test('setup attempt telemetry separates reasoning tokens from the total output token count', async () => {
  stubCompletion(35);
  const attempts: LlmAttempt[] = [];
  await setup().call(request({ onAttempt: (attempt) => attempts.push(attempt) }));

  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].payload.reasoning_tokens, 35);
  assert.equal(attempts[0].payload.output_tokens, 80, 'Reasoning remains included in billable output tokens.');
  assert.equal(attempts[0].payload.usage_reported, true);
});

test('missing reasoning usage is unknown rather than a reported zero', async () => {
  stubCompletion();
  const attempts: LlmAttempt[] = [];
  await setup().call(request({ onAttempt: (attempt) => attempts.push(attempt) }));
  assert.equal(attempts[0].payload.reasoning_tokens, undefined);
});

test('a persona request deadline aborts a provider that never responds', async () => {
  let aborted = false;
  mock.method(globalThis, 'fetch', (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(init.signal?.reason);
    }, { once: true });
  }));
  const rescue = new AbortController();
  // Bound the regression test even when the production deadline is missing.
  const timer = setTimeout(() => rescue.abort(new Error('Test rescue: request deadline did not fire.')), 500);
  const attempts: LlmAttempt[] = [];
  try {
    await assert.rejects(
      setup().call(request({ timeout_ms: 20, signal: rescue.signal, onAttempt: (attempt) => attempts.push(attempt) })),
      /timeout|timed out/i,
    );
    assert.equal(aborted, true, 'The provider fetch receives the deadline cancellation.');
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].payload.status, 'error');
  } finally {
    clearTimeout(timer);
    rescue.abort();
  }
});

test('the total request deadline includes retry backoff and prevents another attempt', async () => {
  let calls = 0;
  mock.method(globalThis, 'fetch', async () => {
    calls++;
    return Response.json({ error: { message: 'Rate limited', type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': '30' } });
  });
  const rescue = new AbortController();
  const timer = setTimeout(() => rescue.abort(new Error('Test rescue: request deadline did not fire.')), 500);
  try {
    await assert.rejects(setup().call(request({ timeout_ms: 20, signal: rescue.signal })), /timeout|timed out/i);
    assert.equal(calls, 1, 'A deadline during backoff must stop before another paid attempt.');
  } finally {
    clearTimeout(timer);
    rescue.abort();
  }
});

test('setup attempt telemetry distinguishes limiter queue time from provider latency', async () => {
  stubCompletion();
  let now = 1000;
  const gateway = setup({
    limits: { deepseek: { rpm: 1, tpm: 1_000_000 } },
    clock: { now: () => now, random: () => 0, sleep: async (ms) => { now += ms; } },
  });
  const attempts: LlmAttempt[] = [];
  await gateway.call(request());
  await gateway.call(request({ onAttempt: (attempt) => attempts.push(attempt) }));

  assert.equal(attempts[0].payload.queue_ms, 60_000);
  assert.equal(attempts[0].payload.latency_ms, 0);
});
