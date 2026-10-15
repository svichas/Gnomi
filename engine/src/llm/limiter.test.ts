import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLimiter, DEFAULT_LIMITS, realClock, type Clock } from './limiter.ts';

/** A clock that moves only when the test says so; sleeping records the wait and returns, as callers sleep side by side. */
function fakeClock() {
  const slept: number[] = [];
  let t = 1_000_000;
  const clock: Clock = { now: () => t, sleep: async (ms) => void slept.push(ms), random: () => 0 };
  return { clock, slept, advance: (ms: number) => void (t += ms) };
}

test('a full bucket lets the first requests through without waiting, and the next one waits for its refill', async () => {
  const { clock, slept } = fakeClock();
  const limiter = createLimiter({ rpm: 60, tpm: 1_000_000 }, clock);
  for (let i = 0; i < 60; i++) await limiter.acquire(10);
  assert.deepEqual(slept, []);
  await limiter.acquire(10); // 60 requests a minute is one a second
  assert.deepEqual(slept, [1000]);
});

test('input tokens are limited on their own, and waiting callers queue in order', async () => {
  const { clock, slept } = fakeClock();
  const limiter = createLimiter({ rpm: 1_000, tpm: 6_000 }, clock); // 100 tokens a second
  await limiter.acquire(3_000);
  await limiter.acquire(3_000);
  assert.deepEqual(slept, []);
  // Three callers arrive together at an empty bucket: each books its own 30 s, so they leave 30, 60 and 90 s from now.
  await Promise.all([limiter.acquire(3_000), limiter.acquire(3_000), limiter.acquire(3_000)]);
  assert.deepEqual(slept, [30_000, 60_000, 90_000]);
});

test('time that passes refills the bucket, up to its capacity', async () => {
  const { clock, slept, advance } = fakeClock();
  const limiter = createLimiter({ rpm: 60, tpm: 1_000_000 }, clock);
  for (let i = 0; i < 60; i++) await limiter.acquire(0);
  advance(10_000); // ten requests refilled
  for (let i = 0; i < 10; i++) await limiter.acquire(0);
  assert.deepEqual(slept, []);
  advance(10 * 60_000); // an idle spell does not save up more than one minute's worth
  for (let i = 0; i < 60; i++) await limiter.acquire(0);
  assert.deepEqual(slept, []);
  await limiter.acquire(0);
  assert.deepEqual(slept, [1000]);
});

test('a request larger than the whole bucket still goes through, after waiting for the debt', async () => {
  const { clock, slept } = fakeClock();
  await createLimiter({ rpm: 100, tpm: 6_000 }, clock).acquire(9_000); // 3,000 short at 100 tokens a second
  assert.deepEqual(slept, [30_000]);
});

test('every cloud provider has a limit and a local endpoint has none', () => {
  assert.equal(DEFAULT_LIMITS.openai_compatible, null);
  for (const provider of ['anthropic', 'openai', 'google'] as const) assert.ok((DEFAULT_LIMITS[provider]?.rpm ?? 0) > 0);
});

test('the real clock sleeps, and stops sleeping when the run is stopped', async () => {
  const before = realClock.now();
  await realClock.sleep(5);
  assert.ok(realClock.now() >= before + 4);
  const controller = new AbortController();
  const waiting = realClock.sleep(60_000, controller.signal);
  controller.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
});
