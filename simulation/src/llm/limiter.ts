import { setTimeout as sleep } from 'node:timers/promises';
import type { ProviderId } from '../types.ts';

/** The clock the limiter and the retry delays read, injected so tests never wait. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  random(): number;
}

export const realClock: Clock = { now: Date.now, sleep: (ms, signal) => sleep(ms, undefined, { signal }), random: Math.random };

export interface Limit {
  rpm: number; // requests per minute
  tpm: number; // input tokens per minute
}

// shortcut: fixed limits per provider, not corrected from the rate-limit response headers or the account's real tier;
// add that when a 429 shows these are too high for a real account (tech.md §10.1).
// Entry-tier figures of tech.md §10.4, the lowest one among the models in the default routing: Anthropic 1,000 requests and
// 2M input tokens a minute, OpenAI 1M tokens (2M on Luna). OpenAI's request cap and all of Google's are guesses, because
// Gemini publishes spend caps per rolling ten minutes instead of a table. A local model has no quota; concurrency bounds it.
export const DEFAULT_LIMITS: Record<ProviderId, Limit | null> = {
  anthropic: { rpm: 1000, tpm: 2_000_000 },
  openai: { rpm: 500, tpm: 1_000_000 },
  google: { rpm: 300, tpm: 1_000_000 },
  deepseek: null, // tech.md §10.4 gives no DeepSeek limit to seed a bucket with; concurrency and the 429 back-off bound it
  openai_compatible: null,
};

/**
 * A token bucket for requests and one for input tokens, both refilled continuously and starting full. A caller takes its
 * share at once, even when that leaves a bucket negative, and sleeps until the debt is repaid: callers queue in order and
 * none has to poll. A caller that aborts while waiting does not hand its share back.
 */
export function createLimiter({ rpm, tpm }: Limit, clock: Clock) {
  let requests = rpm;
  let tokens = tpm;
  let last = clock.now();
  return {
    async acquire(inputTokens: number, signal?: AbortSignal): Promise<void> {
      const now = clock.now();
      const elapsed = now - last;
      last = now;
      requests = Math.min(rpm, requests + (elapsed * rpm) / 60_000) - 1;
      tokens = Math.min(tpm, tokens + (elapsed * tpm) / 60_000) - inputTokens;
      const wait = Math.max((-requests * 60_000) / rpm, (-tokens * 60_000) / tpm);
      if (wait > 0) await clock.sleep(Math.ceil(wait), signal);
    },
  };
}
