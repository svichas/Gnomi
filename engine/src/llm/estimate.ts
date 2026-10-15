import { stepBudget } from '../agent/loop.ts';
import type { ModelChoice, Persona, RunEstimate, RunSettings } from '../types.ts';
import { costUsd, isPriced } from './prices.ts';

// The reference figures of tech.md §10.4. A persona usually stops before her budget (done, abandon): between 40% and all of it.
const STEP_SHARE = [0.4, 1] as const;
const STEP_SECONDS = [2, 6] as const; // a model call plus the browser action
const OVERHEAD_MIN = 0.5; // browser start-up, login check, report
const PROMPT_TOKENS = 5_000;
const SCREENSHOT_TOKENS = 1_200;
const OUTPUT_TOKENS = 200;
const CACHE_HIT = 0.5; // the top of the 0 to 0.5 range; the bottom is no caching at all
// The report's model steps (tech.md §8.2), one call each per POI: input from a small run up to the judge's ~30k-token cap
// and the author's 20k; output includes thinking at medium (judge) and high (author) effort.
const REPORT_CALLS: { role: 'judge' | 'author'; input: [number, number]; output: [number, number] }[] = [
  { role: 'judge', input: [2_000, 30_000], output: [1_000, 4_000] },
  { role: 'author', input: [2_000, 20_000], output: [2_000, 8_000] },
];
const REPORT_MINUTES = [0.2, 1] as const;

/**
 * The pre-run estimate (tech.md §10.4–10.5): calls, a cost range and a time range for this population and routing. Pure.
 * The navigator's steps plus the report's judge and author calls; add the socialiser when runs have social rounds.
 */
export function estimateRun({ personas, settings, at = new Date() }: { personas: Persona[]; settings: RunSettings; at?: Date }): RunEstimate {
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

  // Personas run side by side, but never more of them than there are.
  const parallel = Math.max(1, Math.min(settings.concurrency, personas.length));
  const minutes = (steps: number, seconds: number) => (steps ? (steps * seconds) / parallel / 60 + OVERHEAD_MIN : 0);

  const report = estimateReport({ personas, settings, at });
  return {
    calls: Math.round((fewest + most) / 2) + report.calls,
    cost_usd: [fewest * cached + report.cost_usd[0], most * uncached + report.cost_usd[1]],
    minutes: [minutes(fewest, STEP_SECONDS[0]) + report.minutes[0], minutes(most, STEP_SECONDS[1]) + report.minutes[1]],
    unpriced: [...new Set([...(priced ? [] : [model.model]), ...report.unpriced])],
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
