import { stepBudget } from '../agent/loop.ts';
import { poiBudget } from '../poi/index.ts';
import { poisFor } from '../poi/pois.ts';
import { socialRounds } from '../settings.ts';
import type { Audience, ModelChoice, Persona, Poi, RunEstimate, RunSettings } from '../types.ts';
import type { ComparisonStudy } from '../comparison/types.ts';
import { admits, inScenario } from '../comparison/config.ts';
import { STUDY_OUTPUT_TOKENS } from '../report/study.ts';
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
const SURVEY = { input_tokens: 2_300, output_tokens: 700, cache_read_tokens: 0, cache_write_tokens: 0 }; // one per persona and POI, uncached; structured items with where and severity
// The report's model steps (tech.md §8.2), one call each per POI: input from a small run up to the judge's ~30k-token cap
// and the author's 20k; output includes thinking at medium (judge) and high (author) effort.
const REPORT_CALLS: { role: 'judge' | 'author'; input: [number, number]; output: [number, number] }[] = [
  { role: 'judge', input: [2_000, 30_000], output: [1_000, 4_000] },
  { role: 'author', input: [2_000, 20_000], output: [2_000, 8_000] },
];
const REPORT_MINUTES = [0.2, 1] as const;
// The finding check (report/models.ts), when on: one to five calls per POI, each up to three themes with page text and nine screenshots.
const CHECK_CALLS = [1, 5] as const;
const CHECK_INPUT = [1_500, 16_000] as const;
const CHECK_OUTPUT = [500, 2_000] as const;
// The study plan (report/study.ts): one author call on a run that has ended, with room for one retry of an invalid answer.
const STUDY_INPUT = [1_500, 10_000] as const; // findings capped at 8k tokens, plus the product, segments and prompt
const STUDY_OUTPUT = [1_000, STUDY_OUTPUT_TOKENS] as const;
const STUDY_ATTEMPTS = 2;

/** One uncached call at `at`'s prices; nothing for a model with no known price, which the estimate lists as unpriced. */
const price = (model: ModelChoice, input: number, output: number, at: Date) =>
  isPriced(model) ? costUsd(model, { input_tokens: input, output_tokens: output, cache_read_tokens: 0, cache_write_tokens: 0 }, at) : 0;

// Personas run side by side, but never more of them than there are.
const parallelism = (settings: RunSettings, personas: Persona[]) => Math.max(1, Math.min(settings.concurrency, personas.length));

/**
 * The pre-run estimate (tech.md §10.4–10.5): calls, a cost range and a time range for this population and routing. Pure.
 * The navigator's steps and one end-of-episode survey per persona and POI, one socialiser call per persona and social round, plus
 * the report's judge and author calls per POI. Without `pois`, each persona uses one web POI.
 */
export function estimateRun({ personas, settings, audience = null, pois, comparison, at = new Date() }: { personas: Persona[]; settings: RunSettings; audience?: Audience | null; pois?: Poi[]; comparison?: ComparisonStudy | null; at?: Date }): RunEstimate {
  if (comparison) return estimateComparison({ personas, settings, pois, study: comparison, at });
  const budgets = personas.map((p) => (pois ? poisFor(pois, audience?.segments.find((s) => s.id === p.segment_id) ?? null).map((poi) => poiBudget(p, poi)) : [stepBudget(p)]));
  const budget = budgets.flat().reduce((n, steps) => n + steps, 0);
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
  const surveys = budgets.flat().length;
  const survey = priced ? surveys * costUsd(model, SURVEY, at) : 0;
  // Social calls repeat a persona's stable prefix every round, so they are priced like the steps: cached at best, uncached at worst.
  const social = socialRounds(settings, audience) * personas.length;
  const socialiser = settings.routing.socialiser;
  const socialPriced = social === 0 || isPriced(socialiser);
  const socialCall = (hit: number) =>
    social && socialPriced
      ? social * costUsd(socialiser, { input_tokens: hit ? 0 : SOCIAL_PROMPT_TOKENS, output_tokens: OUTPUT_TOKENS, cache_read_tokens: SOCIAL_PROMPT_TOKENS * hit, cache_write_tokens: hit ? SOCIAL_PROMPT_TOKENS * (1 - hit) : 0 }, at)
      : 0;

  const parallel = parallelism(settings, personas);
  const minutes = (steps: number, seconds: number) => (steps ? (steps * seconds) / parallel / 60 + OVERHEAD_MIN : 0);

  const report = estimateReport({ personas, settings, pois: pois?.length, at });
  return {
    calls: Math.round((fewest + most) / 2) + surveys + social + report.calls,
    cost_usd: [fewest * cached + survey + socialCall(CACHE_HIT) + report.cost_usd[0], most * uncached + survey + socialCall(0) + report.cost_usd[1]],
    minutes: [minutes(fewest + surveys + social, STEP_SECONDS[0]) + report.minutes[0], minutes(most + surveys + social, STEP_SECONDS[1]) + report.minutes[1]],
    unpriced: [...new Set([...(priced ? [] : [model.model]), ...(socialPriced ? [] : [socialiser.model]), ...report.unpriced])],
  };
}

/** Comparison episodes collect evidence before assessment and optional verification; budget for both passes. */
function estimateComparison({ personas, settings, pois, study, at }: { personas: Persona[]; settings: RunSettings; pois?: Poi[]; study: ComparisonStudy; at: Date }): RunEstimate {
  const tasks = personas.flatMap((persona) => study.tasks.flatMap((task) => {
    if (!inScenario(study, task.scenario_id, persona.segment_id)) return [];
    return task.entries.filter((entry) => {
      const source = pois?.find((poi) => poi.id === entry.poi_id);
      return !pois || (!!source && admits(source, persona.segment_id));
    }).map(() => task);
  }));
  const episodes = tasks.length;
  if (!episodes) return { calls: 0, cost_usd: [0, 0], minutes: [0, 0], unpriced: [] };
  const steps = tasks.reduce((sum, task) => sum + task.max_steps, 0);
  const navigator = settings.routing.navigator;
  const judge = settings.routing.judge;
  const verifier = settings.routing[study.execution.verifier ?? 'judge'];
  const prompt = PROMPT_TOKENS + (settings.screenshots ? SCREENSHOT_TOKENS : 0);
  const lowSteps = steps * STEP_SHARE[0];
  const analyses = episodes * 2;
  const parallel = parallelism(settings, personas);
  return {
    calls: Math.round((lowSteps + steps) / 2) + analyses,
    cost_usd: [lowSteps * price(navigator, prompt, OUTPUT_TOKENS, at) + episodes * (price(judge, 4_000, 1_000, at) + price(verifier, 4_000, 1_000, at)), steps * price(navigator, prompt, OUTPUT_TOKENS, at) + episodes * (price(judge, 60_000, 6_000, at) + price(verifier, 60_000, 6_000, at))],
    minutes: [(lowSteps * 2 + analyses * 5) / parallel / 60 + OVERHEAD_MIN, (steps * 6 + analyses * 30) / parallel / 60 + OVERHEAD_MIN],
    unpriced: [...new Set([navigator, judge, verifier].filter((model) => !isPriced(model)).map((model) => model.model))],
  };
}

/** The judge and author calls after the episodes, uncached: one each per POI, plus the finding check's when on; none without personas. */
export function estimateReport({ personas, settings, pois = 1, at = new Date() }: { personas: Persona[]; settings: RunSettings; pois?: number; at?: Date }): RunEstimate {
  if (personas.length === 0 || pois === 0) return { calls: 0, cost_usd: [0, 0], minutes: [0, 0], unpriced: [] };
  const cost: [number, number] = [0, 0];
  for (const { role, input, output } of REPORT_CALLS) {
    cost[0] += pois * price(settings.routing[role], input[0], output[0], at);
    cost[1] += pois * price(settings.routing[role], input[1], output[1], at);
  }
  const checker = settings.finding_check ? (settings.check_model ?? settings.routing.judge) : null;
  if (checker) {
    cost[0] += pois * CHECK_CALLS[0] * price(checker, CHECK_INPUT[0], CHECK_OUTPUT[0], at);
    cost[1] += pois * CHECK_CALLS[1] * price(checker, CHECK_INPUT[1], CHECK_OUTPUT[1], at);
  }
  const models = [...REPORT_CALLS.map(({ role }) => settings.routing[role]), ...(checker ? [checker] : [])];
  const unpriced = models.filter((m) => !isPriced(m)).map((m) => m.model);
  const calls = pois * (REPORT_CALLS.length + (checker ? Math.round((CHECK_CALLS[0] + CHECK_CALLS[1]) / 2) : 0));
  return { calls, cost_usd: cost, minutes: [...REPORT_MINUTES], unpriced: [...new Set(unpriced)] }; // POIs run in parallel
}

/** What a study plan costs, on its own and not part of a run. The high end is a ceiling: output has a hard limit, and a call has at most two attempts. */
export function estimateStudy({ settings, at = new Date() }: { settings: RunSettings; at?: Date }): RunEstimate {
  const model = settings.routing.author;
  return {
    calls: 1,
    cost_usd: [price(model, STUDY_INPUT[0], STUDY_OUTPUT[0], at), STUDY_ATTEMPTS * price(model, STUDY_INPUT[1], STUDY_OUTPUT[1], at)],
    minutes: [...REPORT_MINUTES],
    unpriced: isPriced(model) ? [] : [model.model],
  };
}
