import { stepBudget } from '../agent/loop.ts';
import { socialRounds } from '../settings.ts';
import type { Audience, ModelChoice, Persona, RunEstimate, RunSettings } from '../types.ts';
import { costUsd, isPriced } from './prices.ts';

// The reference figures of tech.md §10.4. A persona usually stops before her budget (done, abandon): between 40% and all of it.
const STEP_SHARE = [0.4, 1] as const;
const STEP_SECONDS = [2, 6] as const; // a model call plus the browser action
const OVERHEAD_MIN = 0.5; // browser start-up, login check, report
const PROMPT_TOKENS = 5_000;
const SCREENSHOT_TOKENS = 1_200;
const OUTPUT_TOKENS = 200;
const CACHE_HIT = 0.5; // the top of the 0 to 0.5 range; the bottom is no caching at all
const SOCIAL_PROMPT_TOKENS = 3_000; // one socialiser call per persona and social round: profile, own state and a feed of at most ~2,500 tokens
const SURVEY = { input_tokens: 2_000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 }; // one per persona, uncached
// The report's model steps (tech.md §8.2), one call each per POI: input from a small run up to the judge's ~30k-token cap
// and the author's 20k; output includes thinking at medium (judge) and high (author) effort.
const REPORT_CALLS: { role: 'judge' | 'author'; input: [number, number]; output: [number, number] }[] = [
  { role: 'judge', input: [2_000, 30_000], output: [1_000, 4_000] },
  { role: 'author', input: [2_000, 20_000], output: [2_000, 8_000] },
];
const REPORT_MINUTES = [0.2, 1] as const;

/**
 * The pre-run estimate (tech.md §10.4–10.5): calls, a cost range and a time range for this population and routing. Pure.
 * The navigator's steps and one end-of-episode survey per persona, one socialiser call per persona and social round, plus the
 * report's judge and author calls.
 */
export function estimateRun({ personas, settings, audience = null, at = new Date() }: { personas: Persona[]; settings: RunSettings; audience?: Audience | null; at?: Date }): RunEstimate {
  const budget = personas.reduce((n, p) => n + stepBudget(p), 0);
  const [fewest, most] = STEP_SHARE.map((share) => budget * share);
  const model = settings.routing.navigator;
  const prompt = PROMPT_TOKENS + (settings.screenshots ? SCREENSHOT_TOKENS : 0);

  // Priced one call at a time: a model's long-prompt band depends on a single prompt's size, not on the run's total.
  // With no cache the prompt is plain input. With a hit rate h, the part that misses is written to the cache at the
  // cache-write rate and the rest is read at the cache-read rate, as in the cost formula of §10.4.
  const priced = isPriced(model);
  const uncached = priced ? costUsd(model, { input_tokens: prompt, output_tokens: OUTPUT_TOKENS, cache_read_tokens: 0, cache_write_tokens: 0 }, at) : 0;
  const cached = priced
    ? costUsd(model, { input_tokens: 0, output_tokens: OUTPUT_TOKENS, cache_read_tokens: prompt * CACHE_HIT, cache_write_tokens: prompt * (1 - CACHE_HIT) }, at)
    : 0;
  const surveys = personas.length;
  const survey = priced ? surveys * costUsd(model, SURVEY, at) : 0;
  // Social calls repeat a persona's stable prefix every round, so they are priced like the steps: cached at best, uncached at worst.
  const social = socialRounds(settings, audience) * personas.length;
  const socialiser = settings.routing.socialiser;
  const socialPriced = social === 0 || isPriced(socialiser);
  const socialCall = (hit: number) =>
    social && socialPriced
      ? social * costUsd(socialiser, { input_tokens: hit ? 0 : SOCIAL_PROMPT_TOKENS, output_tokens: OUTPUT_TOKENS, cache_read_tokens: SOCIAL_PROMPT_TOKENS * hit, cache_write_tokens: hit ? SOCIAL_PROMPT_TOKENS * (1 - hit) : 0 }, at)
      : 0;

  // Personas run side by side, but never more of them than there are.
  const parallel = Math.max(1, Math.min(settings.concurrency, personas.length));
  const minutes = (steps: number, seconds: number) => (steps ? (steps * seconds) / parallel / 60 + OVERHEAD_MIN : 0);

  const report = estimateReport({ personas, settings, at });
  return {
    calls: Math.round((fewest + most) / 2) + surveys + social + report.calls,
    cost_usd: [fewest * cached + survey + socialCall(CACHE_HIT) + report.cost_usd[0], most * uncached + survey + socialCall(0) + report.cost_usd[1]],
    minutes: [minutes(fewest + surveys + social, STEP_SECONDS[0]) + report.minutes[0], minutes(most + surveys + social, STEP_SECONDS[1]) + report.minutes[1]],
    unpriced: [...new Set([...(priced ? [] : [model.model]), ...(socialPriced ? [] : [socialiser.model]), ...report.unpriced])],
  };
}

/** The judge and author calls after the episodes, uncached: one each for the run's POI, none without personas. */
export function estimateReport({ personas, settings, at = new Date() }: { personas: Persona[]; settings: RunSettings; at?: Date }): RunEstimate {
  if (personas.length === 0) return { calls: 0, cost_usd: [0, 0], minutes: [0, 0], unpriced: [] };
  const price = (model: ModelChoice, input: number, output: number) =>
    isPriced(model) ? costUsd(model, { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 }, at) : 0;
  const cost: [number, number] = [0, 0];
  for (const { role, input, output } of REPORT_CALLS) {
    cost[0] += price(settings.routing[role], input[0], output[0]);
    cost[1] += price(settings.routing[role], input[1], output[1]);
  }
  const unpriced = REPORT_CALLS.map(({ role }) => settings.routing[role]).filter((m) => !isPriced(m)).map((m) => m.model);
  return { calls: REPORT_CALLS.length, cost_usd: cost, minutes: [...REPORT_MINUTES], unpriced: [...new Set(unpriced)] };
}
