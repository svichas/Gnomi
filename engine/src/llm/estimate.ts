import { stepBudget } from '../agent/loop.ts';
import type { Persona, RunEstimate, RunSettings } from '../types.ts';
import { costUsd, isPriced } from './prices.ts';

// The reference figures of tech.md §10.4. A persona usually stops before her budget (done, abandon): between 40% and all of it.
const STEP_SHARE = [0.4, 1] as const;
const STEP_SECONDS = [2, 6] as const; // a model call plus the browser action
const OVERHEAD_MIN = 0.5; // browser start-up, login check, report
const PROMPT_TOKENS = 5_000;
const SCREENSHOT_TOKENS = 1_200;
const OUTPUT_TOKENS = 200;
const CACHE_HIT = 0.5; // the top of the 0 to 0.5 range; the bottom is no caching at all
const SURVEY = { input_tokens: 2_000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 }; // one per persona, uncached

/**
 * The pre-run estimate (tech.md §10.4–10.5): calls, a cost range and a time range for this population and routing. Pure.
 * Runs have no social rounds and no judge yet, so only the navigator is estimated: its steps and one end-of-episode survey per
 * persona. Add the other roles when a run calls them.
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
  const surveys = personas.length;
  const survey = priced ? surveys * costUsd(model, SURVEY, at) : 0;

  // Personas run side by side, but never more of them than there are.
  const parallel = Math.max(1, Math.min(settings.concurrency, personas.length));
  const minutes = (steps: number, seconds: number) => (steps ? (steps * seconds) / parallel / 60 + OVERHEAD_MIN : 0);

  return {
    calls: Math.round((fewest + most) / 2) + surveys,
    cost_usd: [fewest * cached + survey, most * uncached + survey],
    minutes: [minutes(fewest + surveys, STEP_SECONDS[0]), minutes(most + surveys, STEP_SECONDS[1])],
    unpriced: priced ? [] : [model.model],
  };
}
